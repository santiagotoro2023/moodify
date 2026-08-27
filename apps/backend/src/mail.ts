import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { mailFontStack } from '@moodify/shared';
import { ASSETS_DIR } from './config.ts';
import { decryptSecret, encryptSecret } from './crypto.ts';
import { sql } from './db.ts';

/**
 * Outgoing mail.
 *
 * The SMTP password is encrypted at rest with the same key as the Moodle token and is
 * decrypted here, in memory, for the length of one send. It is never logged and never
 * leaves the backend — Settings shows a masked hint and a "replace" action, nothing else.
 *
 * Nothing here throws at the caller: a mail server that is down must not take the sync
 * with it. Failures are recorded on smtp_settings.last_error and surfaced in Settings.
 */

export interface SmtpConfig {
  enabled: boolean;
  /** 'smtp' = a mail server. 'graph' = Microsoft 365, as the signed-in mailbox. */
  transport: 'smtp' | 'graph';
  graphTenantId: string;
  graphClientId: string;
  graphAccount: string | null;
  graphRefreshToken: string | null;
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  password: string | null;
  fromName: string;
  fromEmail: string;
  adminEmail: string | null;
  dailyReport: boolean;
  dailyReportHour: number;
  sendHour: number;
  mailFont: string;
  mailFontSize: number;
  mailTextColor: string;
  mailAccentColor: string;
  jumpStart: boolean;
  jumpStartDays: number;
  lastReportOn: Date | null;
}

type SmtpRow = {
  enabled: boolean;
  transport: string;
  graph_tenant_id: string;
  graph_client_id: string;
  graph_account: string | null;
  graph_refresh_token_encrypted: string | null;
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
  jump_start: boolean;
  jump_start_days: number;
  last_report_on: Date | null;
};

/** The stored SMTP settings with the password decrypted. Never log the result. */
export async function loadSmtpConfig(): Promise<SmtpConfig | null> {
  const { rows } = await sql<SmtpRow>(
    `select enabled, transport, graph_tenant_id, graph_client_id, graph_account,
            graph_refresh_token_encrypted, host, port, secure, username, password_encrypted,
            from_name, from_email, admin_email, daily_report, daily_report_hour, send_hour, mail_font, mail_font_size,
            mail_text_color, mail_accent_color, jump_start, jump_start_days, last_report_on
       from smtp_settings order by id limit 1`,
  );
  const row = rows[0];
  if (row === undefined) return null;

  // Almost always a rotated ENCRYPTION_KEY. Treat it as "no secret" so the send fails
  // with the server's own auth error rather than a crypto stack trace.
  const decrypt = (blob: string | null): string | null => {
    if (blob === null) return null;
    try {
      return decryptSecret(blob);
    } catch {
      return null;
    }
  };

  return {
    enabled: row.enabled,
    transport: row.transport === 'graph' ? 'graph' : 'smtp',
    graphTenantId: row.graph_tenant_id,
    graphClientId: row.graph_client_id,
    graphAccount: row.graph_account,
    graphRefreshToken: decrypt(row.graph_refresh_token_encrypted),
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    password: decrypt(row.password_encrypted),
    fromName: row.from_name,
    fromEmail: row.from_email,
    adminEmail: row.admin_email,
    dailyReport: row.daily_report,
    dailyReportHour: row.daily_report_hour,
    sendHour: row.send_hour,
    mailFont: row.mail_font,
    mailFontSize: row.mail_font_size,
    mailTextColor: row.mail_text_color,
    mailAccentColor: row.mail_accent_color,
    jumpStart: row.jump_start,
    jumpStartDays: row.jump_start_days,
    lastReportOn: row.last_report_on,
  };
}

/** Everything that has to be filled in before a send can be attempted. */
export function smtpIsUsable(config: SmtpConfig | null): config is SmtpConfig {
  if (config === null) return false;
  if (config.transport === 'graph') return config.graphRefreshToken !== null;
  return config.host.trim() !== '' && config.fromEmail.trim() !== '';
}

function transportFor(config: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth:
      config.username && config.password
        ? { user: config.username, pass: config.password }
        : undefined,
  });
}

// ---------------------------------------------------------------------------
// Microsoft 365 (Graph), delegated to one mailbox.
//
// Why not SMTP with a username and password: Microsoft is retiring basic authentication
// for SMTP client submission, and the switches that keep it working (tenant-wide basic
// auth, per-mailbox SmtpClientAuthenticationDisabled) are administrator settings. A
// delegated OAuth token is the opposite — the mailbox owner grants it to themselves, it
// can only send as them, and it survives the retirement.
//
// Public client, so there is no client secret anywhere in this file. The only secret is
// the refresh token, which is encrypted at rest like every other one (§9.5).
// ---------------------------------------------------------------------------

/** offline_access for the refresh token, User.Read only to learn which mailbox signed in. */
export const GRAPH_SCOPE = 'offline_access User.Read Mail.Send';

/** Carries Microsoft's own error code, which the device-code poll has to branch on. */
export class GraphError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function microsoftJson(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new GraphError(
      typeof data.error === 'string' ? data.error : String(response.status),
      typeof data.error_description === 'string' ? data.error_description : 'Microsoft rejected the request.',
    );
  }
  return data;
}

export function graphAuthority(tenantId: string, path: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/${path}`;
}

export interface GraphTokens {
  accessToken: string;
  /** Null when Microsoft did not rotate it; keep the one already stored in that case. */
  refreshToken: string | null;
}

/** One token request. Never log the result — both fields are credentials. */
export async function graphToken(tenantId: string, form: Record<string, string>): Promise<GraphTokens> {
  const data = await microsoftJson(graphAuthority(tenantId, 'token'), form);
  return {
    accessToken: String(data.access_token ?? ''),
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
  };
}

export async function storeGraphRefreshToken(token: string | null, account: string | null): Promise<void> {
  await sql(
    `update smtp_settings set
       graph_refresh_token_encrypted = $1,
       graph_account = coalesce($2, graph_account)`,
    [token === null ? null : encryptSecret(token), account],
  );
}

/** The signed-in mailbox address, so Settings can show whose account is connected. */
export async function graphAccountOf(accessToken: string): Promise<string | null> {
  const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { mail?: unknown; userPrincipalName?: unknown };
  const address = typeof data.mail === 'string' && data.mail !== '' ? data.mail : data.userPrincipalName;
  return typeof address === 'string' ? address : null;
}

async function graphAccessToken(config: SmtpConfig): Promise<string> {
  if (config.graphRefreshToken === null) {
    throw new GraphError('not_connected', 'No Microsoft 365 mailbox is connected.');
  }
  const tokens = await graphToken(config.graphTenantId, {
    client_id: config.graphClientId,
    grant_type: 'refresh_token',
    refresh_token: config.graphRefreshToken,
    scope: GRAPH_SCOPE,
  });
  // Microsoft hands back a fresh refresh token on nearly every refresh and retires the
  // old one. Dropping it means mail keeps working right up until the original expires,
  // which is the kind of failure that turns up months later with no obvious cause.
  if (tokens.refreshToken !== null) await storeGraphRefreshToken(tokens.refreshToken, null);
  return tokens.accessToken;
}

/** A Mail with its images resolved — internal, so no caller has to think about them. */
type Dressed = Mail & { images: InlineImage[] };

export interface Mail {
  to: string;
  subject: string;
  /** Always present: some clients, and every archive, only ever show this one. */
  text: string;
  /** The body as HTML, without the styling shell — wrapHtmlMail adds that at send time. */
  html?: string;
}

// ---------------------------------------------------------------------------
// HTML mail
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The plain-text fallback, made from the same rendered HTML rather than from a second
 * template — two templates would drift, and the one nobody previews is the one that rots.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** An uploaded image that travels with the message instead of being fetched from a URL. */
export interface InlineImage {
  cid: string;
  /** Path relative to ASSETS_DIR. Only ever produced by the pattern below. */
  path: string;
}

/**
 * Turns every uploaded image in the body into an attachment the message carries itself.
 *
 * A remote <img src> needs a publicly reachable Moodify, which a self-hosted install
 * behind a LAN or a VPN simply does not have — and even with one, most clients block
 * remote images until the reader clicks "show pictures". An embedded attachment has
 * neither problem, so this is the only way images are supported.
 *
 * The pattern is deliberately narrow: the uploads directory, and a generated filename of
 * exactly the characters saveImageUpload produces. Anything else in a src is left alone,
 * which is what keeps a hand-written path from reaching the filesystem.
 */
export function inlineImages(html: string): { html: string; images: InlineImage[] } {
  const images = new Map<string, InlineImage>();
  const out = html.replace(
    /src="[^"]*\/assets-store\/(uploads\/[A-Za-z0-9]+\.[a-z]{3,4})"/g,
    (_match, relative: string) => {
      const cid = relative.replace(/[^A-Za-z0-9]/g, '');
      images.set(cid, { cid, path: relative });
      return `src="cid:${cid}"`;
    },
  );
  return { html: out, images: [...images.values()] };
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export const mimeForPath = (path: string): string =>
  MIME_BY_EXT[path.split('.').pop() ?? ''] ?? 'application/octet-stream';

/**
 * Wraps a body fragment in the configured look: font, size and colours, and nothing else.
 *
 * It used to paint a white card on a grey page, the way a marketing mail does. In an
 * actual inbox that reads as a grey box drawn around the message — the client already
 * supplies the page, so a second one inside it is just a panel. Worse in a dark-mode
 * client, which inverts the surrounding chrome and leaves the light panel sitting in it,
 * and worse again where the tenant appends a signature *inside* the body: the panel stops
 * where Moodify's content stops and the signature hangs outside it.
 *
 * So: no background, no padding, no border, no max-width. Inline styles rather than a
 * <style> block, which mail clients discard.
 */
export function wrapHtmlMail(config: SmtpConfig, body: string): string {
  const font = mailFontStack(config.mailFont);
  return (
    `<div style="font-family:${font};font-size:${config.mailFontSize}px;` +
    `line-height:1.55;color:${config.mailTextColor}">` +
    // A mail client applies its own blue to any <a> that does not say otherwise, and it
    // will not read a <style> block to find out. Only links that carry no style of their
    // own are touched, so an admin who styled one in the body keeps it.
    body.replace(/<a\s+(?![^>]*\bstyle=)/gi, `<a style="color:${config.mailAccentColor}" `) +
    `</div>`
  );
}

/**
 * Headers that say "a machine sent this, on nobody's behalf".
 *
 * None of them can stop a tenant-side signature or disclaimer rule — that appending
 * happens in Exchange, after the message has left, and no sender can opt out of a
 * transport rule from the outside. What they do is give the rule something to match on:
 * an exception for `X-Moodify` excludes exactly these messages and nothing else. The
 * suppression headers are honoured more widely, and stop a reminder from collecting
 * out-of-office replies from thirty students.
 */
const AUTOMATED_HEADERS: Record<string, string> = {
  'X-Moodify': 'task-reminder',
  'X-Auto-Response-Suppress': 'All',
};

/**
 * A newline in the body becomes a line break, unless it sits straight after a tag.
 *
 * Once the body is HTML, a bare \n renders as a single space and a message written as
 * three paragraphs arrives as one — the first thing anybody notices. The exception is
 * what keeps it from doubling up: a newline following `>` is the source being laid out
 * readably, not a break the writer asked for.
 */
export function newlinesToBreaks(html: string): string {
  return html.replace(/(?<!>)\n/g, '<br>');
}

function describeSendError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function sendViaGraph(
  config: SmtpConfig,
  mails: readonly Dressed[],
): Promise<{ sent: number; failed: number; error: string | null }> {
  let accessToken: string;
  try {
    accessToken = await graphAccessToken(config);
  } catch (err) {
    // One expired consent fails the whole batch, and saying so once beats saying it
    // thirty times with the same text.
    return { sent: 0, failed: mails.length, error: describeSendError(err) };
  }

  let sent = 0;
  let failed = 0;
  let error: string | null = null;

  for (const mail of mails) {
    try {
      // A delegated token cannot send as anyone but its owner, so there is no `from`
      // here — Microsoft fills it in with the connected mailbox.
      const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject: mail.subject,
            // Same mailbox, different display name. A delegated token cannot send *as*
            // anyone else, but the friendly name is the sender's to choose, and a class
            // reminder arriving under a person's own name reads as a personal message.
            ...(config.graphAccount === null
              ? {}
              : { from: { emailAddress: { name: config.fromName, address: config.graphAccount } } }),
            internetMessageHeaders: Object.entries(AUTOMATED_HEADERS).map(([name, value]) => ({
              name,
              value,
            })),
            // Graph carries one body, not two: HTML when there is any, text otherwise.
            body:
              mail.html === undefined
                ? { contentType: 'Text', content: mail.text }
                : { contentType: 'HTML', content: mail.html },
            toRecipients: [{ emailAddress: { address: mail.to } }],
            attachments: await Promise.all(
              mail.images.map(async (image) => ({
                '@odata.type': '#microsoft.graph.fileAttachment',
                name: image.path.split('/').pop(),
                contentType: mimeForPath(image.path),
                contentBytes: (await readFile(join(ASSETS_DIR, image.path))).toString('base64'),
                // isInline plus contentId is what makes cid: resolve rather than the
                // image arriving as a separate download at the bottom.
                isInline: true,
                contentId: image.cid,
              })),
            ),
          },
          saveToSentItems: false,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
        const detail = typeof body?.error?.message === 'string' ? body.error.message : response.statusText;
        throw new Error(`${response.status} ${detail}`);
      }
      sent += 1;
    } catch (err) {
      failed += 1;
      if (error === null) error = describeSendError(err);
    }
  }
  return { sent, failed, error };
}

/**
 * Sends a batch over one connection. Returns how many went out and the first failure,
 * so one bad address does not abandon the other thirty.
 */
export async function sendMails(
  config: SmtpConfig,
  mails: readonly Mail[],
): Promise<{ sent: number; failed: number; error: string | null }> {
  if (mails.length === 0) return { sent: 0, failed: 0, error: null };

  // Styling, line breaks and image embedding are applied here, once, rather than by
  // every caller: they depend on settings the callers have no reason to load.
  const dressed: Dressed[] = mails.map((mail) => {
    if (mail.html === undefined) return { ...mail, images: [] };
    const embedded = inlineImages(wrapHtmlMail(config, newlinesToBreaks(mail.html)));
    return { ...mail, html: embedded.html, images: embedded.images };
  });

  const result = config.transport === 'graph'
    ? await sendViaGraph(config, dressed)
    : await sendViaSmtp(config, dressed);
  const { sent, error } = result;

  await sql(
    `update smtp_settings
        set last_sent_at = case when $1 > 0 then now() else last_sent_at end,
            last_error = $2`,
    [sent, error],
  );
  return result;
}

async function sendViaSmtp(
  config: SmtpConfig,
  mails: readonly Dressed[],
): Promise<{ sent: number; failed: number; error: string | null }> {
  const transport = transportFor(config);
  const from = `${config.fromName} <${config.fromEmail}>`;
  let sent = 0;
  let failed = 0;
  let error: string | null = null;

  for (const mail of mails) {
    try {
      await transport.sendMail({
        from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        headers: {
          ...AUTOMATED_HEADERS,
          // The standard one, and the only transport that can carry it: Graph refuses any
          // custom header not starting with X-.
          'Auto-Submitted': 'auto-generated',
        },
        ...(mail.html === undefined ? {} : { html: mail.html }),
        attachments: mail.images.map((image) => ({
          filename: image.path.split('/').pop(),
          path: join(ASSETS_DIR, image.path),
          cid: image.cid,
        })),
      });
      sent += 1;
    } catch (err) {
      failed += 1;
      if (error === null) error = describeSendError(err);
    }
  }
  transport.close();
  return { sent, failed, error };
}

/**
 * Fills `{name}`, `{activity}`, `{course}`, `{due}` and `{days}` into a subject or body.
 *
 * Deliberately a plain replace and not a template engine: the values are already plain
 * text going into a plain-text mail, so there is nothing to escape and nothing to
 * sandbox. An unknown placeholder is left alone rather than blanked, which makes a typo
 * visible in the delivered mail instead of silently swallowing it.
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
