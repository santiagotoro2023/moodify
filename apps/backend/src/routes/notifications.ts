import type { FastifyInstance } from 'fastify';
import type { NotificationRuleDto, SmtpState } from '@moodify/shared';
import { z } from 'zod';
import { requireAdmin } from '../auth.ts';
import { encryptSecret } from '../crypto.ts';
import { sql } from '../db.ts';
import { loadSmtpConfig, sendMails, smtpIsUsable } from '../mail.ts';

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
      last_sent_at: Date | null;
      last_error: string | null;
    }>(
      `select enabled, host, port, secure, username, password_encrypted, from_name, from_email,
              admin_email, daily_report, daily_report_hour, last_sent_at, last_error
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
         daily_report_hour  = coalesce($11, daily_report_hour)`,
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
      ],
    );
    return { ok: true };
  });

  app.post('/api/notifications/test', auth, async (request, reply) => {
    const to = z.object({ to: z.string().trim().min(3).max(255) }).safeParse(request.body);
    if (!to.success) return reply.code(400).send({ error: 'A recipient address is required.' });

    const config = await loadSmtpConfig();
    if (!smtpIsUsable(config)) {
      return reply.code(400).send({ error: 'Set at least a host and a from-address first.' });
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
