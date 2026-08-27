import type { FastifyInstance } from 'fastify';
import type { NotificationRuleDto, SmtpState } from '@moodify/shared';
import { z } from 'zod';
import { requireAdmin } from '../auth.ts';
import { encryptSecret } from '../crypto.ts';
import { sql } from '../db.ts';
import {
  GRAPH_SCOPE,
  GraphError,
  graphAccountOf,
  graphAuthority,
  graphToken,
  loadSmtpConfig,
  sendMails,
  smtpIsUsable,
  storeGraphRefreshToken,
} from '../mail.ts';

/**
 * SMTP configuration and the global reminder rules.
 *
 * The password is write-only from the UI's point of view (§9.5, same rule as the Moodle
 * token): it goes in encrypted, comes back only as "set or not set", and is replaced
 * rather than edited.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() });

const smtpBodySchema = z.object({
  enabled: z.boolean().optional(),
  transport: z.enum(['smtp', 'graph']).optional(),
  graphTenantId: z.string().trim().max(100).optional(),
  graphClientId: z.string().trim().max(100).optional(),
  host: z.string().trim().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  username: z.string().trim().max(255).optional(),
  /** Omit to keep the stored one; empty string clears it. */
  password: z.string().max(255).optional(),
  fromName: z.string().trim().max(120).optional(),
  fromEmail: z.string().trim().max(255).optional(),
  adminEmail: z.string().trim().max(255).optional(),
  dailyReport: z.boolean().optional(),
  dailyReportHour: z.number().int().min(0).max(23).optional(),
  sendHour: z.number().int().min(0).max(23).optional(),
  mailFont: z.enum(['system', 'sans', 'serif', 'mono', 'grotesk']).optional(),
  mailFontSize: z.number().int().min(10).max(28).optional(),
  mailTextColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  mailAccentColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  mailShowLogo: z.boolean().optional(),
});

const ruleBodySchema = z
  .object({
    kind: z.enum(['before', 'overdue']),
    daysBefore: z.number().int().min(1).max(365).nullable().default(null),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(4000),
    enabled: z.boolean().default(true),
  })
  .refine(
    (rule) => (rule.kind === 'before' ? rule.daysBefore !== null : rule.daysBefore === null),
    'A "before" rule needs a number of days; an "overdue" rule must not have one.',
  );

type RuleRow = {
  id: number;
  kind: string;
  days_before: number | null;
  subject: string;
  body: string;
  enabled: boolean;
};

function toRule(row: RuleRow): NotificationRuleDto {
  return {
    id: row.id,
    kind: row.kind === 'overdue' ? 'overdue' : 'before',
    daysBefore: row.days_before,
    subject: row.subject,
    body: row.body,
    enabled: row.enabled,
  };
}

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireAdmin };

  app.get('/api/notifications/smtp', auth, async (): Promise<SmtpState> => {
    const { rows } = await sql<{
      enabled: boolean;
      transport: string;
      graph_tenant_id: string;
      graph_client_id: string;
      graph_account: string | null;
      connected: boolean;
      host: string;
      port: number;
      secure: boolean;
      username: string | null;
      password_encrypted: string | null;
      from_name: string;
      from_email: string;
      admin_email: string | null;
      daily_report: boolean;
      daily_report_hour: number;
      send_hour: number;
      mail_font: string;
      mail_font_size: number;
      mail_text_color: string;
      mail_accent_color: string;
      mail_show_logo: boolean;
      last_sent_at: Date | null;
      last_error: string | null;
    }>(
      `select enabled, transport, graph_tenant_id, graph_client_id, graph_account,
              graph_refresh_token_encrypted is not null as connected,
              host, port, secure, username, password_encrypted, from_name, from_email,
              admin_email, daily_report, daily_report_hour, send_hour,
              mail_font, mail_font_size, mail_text_color, mail_accent_color, mail_show_logo,
              last_sent_at, last_error
         from smtp_settings order by id limit 1`,
    );
    const row = rows[0];

    // Students with a task hanging over them but no address: exactly the people a
    // reminder will silently miss, so they are named rather than counted.
    const { rows: missing } = await sql<{ fullname: string }>(
      `select distinct u.fullname
         from moodle_users u
         join enrollments e on e.moodle_user_id = u.moodle_user_id
        where (u.email is null or u.email = '')
          and 'student' = any(e.roles)
          and exists (select 1 from deadlines d where d.moodle_course_id = e.moodle_course_id)
        order by u.fullname asc`,
    );

    return {
      enabled: row?.enabled ?? false,
      transport: row?.transport === 'graph' ? 'graph' : 'smtp',
      graphTenantId: row?.graph_tenant_id ?? '',
      graphClientId: row?.graph_client_id ?? '',
      // The account only counts as connected while the token behind it still exists;
      // showing an address after a disconnect would claim mail can go out when it cannot.
      graphAccount: row?.connected ? row.graph_account : null,
      host: row?.host ?? '',
      port: row?.port ?? 587,
      secure: row?.secure ?? false,
      username: row?.username ?? '',
      passwordSet: (row?.password_encrypted ?? null) !== null,
      fromName: row?.from_name ?? 'Moodify',
      fromEmail: row?.from_email ?? '',
      adminEmail: row?.admin_email ?? '',
      dailyReport: row?.daily_report ?? false,
      dailyReportHour: row?.daily_report_hour ?? 7,
      sendHour: row?.send_hour ?? 7,
      mailFont: row?.mail_font ?? 'system',
      mailFontSize: row?.mail_font_size ?? 15,
      mailTextColor: row?.mail_text_color ?? '#1f2933',
      mailAccentColor: row?.mail_accent_color ?? '#2563eb',
      mailShowLogo: row?.mail_show_logo ?? false,
      lastSentAt: row?.last_sent_at?.toISOString() ?? null,
      lastError: row?.last_error ?? null,
      usersWithoutEmail: missing.map((entry) => entry.fullname),
    };
  });

  app.patch('/api/notifications/smtp', auth, async (request, reply) => {
    const parsed = smtpBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid settings.' });
    }
    const body = parsed.data;

    // undefined = leave alone, '' = clear, anything else = replace. coalesce on the SQL
    // side would conflate the first two.
    const password =
      body.password === undefined ? null : body.password === '' ? '' : encryptSecret(body.password);

    await sql(
      `update smtp_settings set
         transport          = coalesce($12, transport),
         graph_tenant_id    = coalesce($13, graph_tenant_id),
         graph_client_id    = coalesce($14, graph_client_id),
         enabled            = coalesce($1, enabled),
         host               = coalesce($2, host),
         port               = coalesce($3, port),
         secure             = coalesce($4, secure),
         username           = coalesce($5, username),
         password_encrypted = case
                                when $6::text is null then password_encrypted
                                when $6::text = '' then null
                                else $6::text end,
         from_name          = coalesce($7, from_name),
         from_email         = coalesce($8, from_email),
         admin_email        = coalesce($9, admin_email),
         daily_report       = coalesce($10, daily_report),
         daily_report_hour  = coalesce($11, daily_report_hour),
         send_hour          = coalesce($15, send_hour),
         mail_font          = coalesce($16, mail_font),
         mail_font_size     = coalesce($17, mail_font_size),
         mail_text_color    = coalesce($18, mail_text_color),
         mail_accent_color  = coalesce($19, mail_accent_color),
         mail_show_logo     = coalesce($20, mail_show_logo)`,
      [
        body.enabled ?? null,
        body.host ?? null,
        body.port ?? null,
        body.secure ?? null,
        body.username ?? null,
        password,
        body.fromName ?? null,
        body.fromEmail ?? null,
        body.adminEmail ?? null,
        body.dailyReport ?? null,
        body.dailyReportHour ?? null,
        body.transport ?? null,
        body.graphTenantId ?? null,
        body.graphClientId ?? null,
        body.sendHour ?? null,
        body.mailFont ?? null,
        body.mailFontSize ?? null,
        body.mailTextColor ?? null,
        body.mailAccentColor ?? null,
        body.mailShowLogo ?? null,
      ],
    );
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Microsoft 365 sign-in, device code flow.
  //
  // Device code rather than a redirect: Moodify may be reachable only on a LAN, behind a
  // proxy, or on a host with no name Microsoft would accept as a reply URL, and none of
  // that matters if the browser never has to come back. It also keeps the app
  // registration to two fields the admin can paste, with no redirect URI to agree on.
  //
  // The device code is handed to the browser and passed back on each poll. It is not a
  // credential — it is worthless without the sign-in that only the admin can complete,
  // it dies in fifteen minutes, and these routes need an admin session anyway.
  // -------------------------------------------------------------------------

  app.post('/api/notifications/graph/start', auth, async (request, reply) => {
    const parsed = z
      .object({ tenantId: z.string().trim().min(1).max(100), clientId: z.string().trim().min(1).max(100) })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'A directory (tenant) id and an application (client) id are required.' });
    }
    const { tenantId, clientId } = parsed.data;

    let data: Record<string, unknown>;
    try {
      const response = await fetch(graphAuthority(tenantId, 'devicecode'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, scope: GRAPH_SCOPE }),
      });
      data = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        return reply.code(502).send({
          error: typeof data.error_description === 'string' ? data.error_description : 'Microsoft refused the request.',
        });
      }
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach Microsoft.' });
    }

    // Stored now so the poll can find them, and so the pair survives a page reload.
    await sql(`update smtp_settings set graph_tenant_id = $1, graph_client_id = $2`, [tenantId, clientId]);

    return {
      deviceCode: String(data.device_code ?? ''),
      userCode: String(data.user_code ?? ''),
      verificationUri: String(data.verification_uri ?? 'https://microsoft.com/devicelogin'),
      interval: typeof data.interval === 'number' ? data.interval : 5,
    };
  });

  app.post('/api/notifications/graph/poll', auth, async (request, reply) => {
    const parsed = z.object({ deviceCode: z.string().min(1).max(2000) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Start the sign-in first.' });

    const { rows } = await sql<{ graph_tenant_id: string; graph_client_id: string }>(
      `select graph_tenant_id, graph_client_id from smtp_settings order by id limit 1`,
    );
    const row = rows[0];
    if (row === undefined || row.graph_tenant_id === '' || row.graph_client_id === '') {
      return reply.code(400).send({ error: 'Start the sign-in first.' });
    }

    try {
      const tokens = await graphToken(row.graph_tenant_id, {
        client_id: row.graph_client_id,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: parsed.data.deviceCode,
      });
      // Checked before storing: writing null would clear a working connection.
      if (tokens.refreshToken === null) {
        return reply.code(502).send({
          error: 'Microsoft returned no refresh token. Add the offline_access permission to the app registration.',
        });
      }
      const account = await graphAccountOf(tokens.accessToken);
      await storeGraphRefreshToken(tokens.refreshToken, account);
      await sql(`update smtp_settings set transport = 'graph', last_error = null`);
      return { pending: false, account };
    } catch (err) {
      if (err instanceof GraphError && (err.code === 'authorization_pending' || err.code === 'slow_down')) {
        return { pending: true, account: null };
      }
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Sign-in failed.' });
    }
  });

  app.post('/api/notifications/graph/disconnect', auth, async () => {
    await storeGraphRefreshToken(null, null);
    await sql(`update smtp_settings set graph_account = null`);
    return { ok: true };
  });

  app.post('/api/notifications/test', auth, async (request, reply) => {
    const to = z.object({ to: z.string().trim().min(3).max(255) }).safeParse(request.body);
    if (!to.success) return reply.code(400).send({ error: 'A recipient address is required.' });

    const config = await loadSmtpConfig();
    // Read before the guard: smtpIsUsable narrows the failing branch to null.
    const wantsGraph = config?.transport === 'graph';
    if (!smtpIsUsable(config)) {
      return reply.code(400).send({
        error: wantsGraph
          ? 'Connect a Microsoft 365 mailbox first.'
          : 'Set at least a host and a from-address first.',
      });
    }
    const result = await sendMails(config, [
      {
        to: to.data.to,
        subject: 'Moodify test message',
        text: 'This is a test message from Moodify. If you are reading it, SMTP works.',
      },
    ]);
    if (result.sent === 0) {
      return reply.code(502).send({ error: result.error ?? 'The mail server refused the message.' });
    }
    return { ok: true };
  });

  app.get('/api/notifications/rules', auth, async (): Promise<NotificationRuleDto[]> => {
    const { rows } = await sql<RuleRow>(
      `select id, kind, days_before, subject, body, enabled
         from notification_rules
        order by kind asc, days_before desc nulls last, id asc`,
    );
    return rows.map(toRule);
  });

  app.post('/api/notifications/rules', auth, async (request, reply) => {
    const parsed = ruleBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid rule.' });
    }
    const rule = parsed.data;
    const { rows } = await sql<RuleRow>(
      `insert into notification_rules (kind, days_before, subject, body, enabled)
       values ($1, $2, $3, $4, $5)
       returning id, kind, days_before, subject, body, enabled`,
      [rule.kind, rule.daysBefore, rule.subject, rule.body, rule.enabled],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return reply.code(201).send(toRule(row));
  });

  app.patch('/api/notifications/rules/:id', auth, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid rule id.' });
    const parsed = ruleBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid rule.' });
    }
    const rule = parsed.data;
    const { rows } = await sql<RuleRow>(
      `update notification_rules
          set kind = $2, days_before = $3, subject = $4, body = $5, enabled = $6
        where id = $1
        returning id, kind, days_before, subject, body, enabled`,
      [params.data.id, rule.kind, rule.daysBefore, rule.subject, rule.body, rule.enabled],
    );
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'No such rule.' });
    return toRule(row);
  });

  app.delete('/api/notifications/rules/:id', auth, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid rule id.' });
    const result = await sql('delete from notification_rules where id = $1', [params.data.id]);
    if (result.rowCount === 0) return reply.code(404).send({ error: 'No such rule.' });
    return reply.code(204).send();
  });
}
