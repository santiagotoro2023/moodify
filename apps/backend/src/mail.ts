import nodemailer, { type Transporter } from 'nodemailer';
import { decryptSecret } from './crypto.ts';
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
  lastReportOn: Date | null;
}

type SmtpRow = {
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
  last_report_on: Date | null;
};

/** The stored SMTP settings with the password decrypted. Never log the result. */
export async function loadSmtpConfig(): Promise<SmtpConfig | null> {
  const { rows } = await sql<SmtpRow>(
    `select enabled, host, port, secure, username, password_encrypted, from_name, from_email,
            admin_email, daily_report, daily_report_hour, last_report_on
       from smtp_settings order by id limit 1`,
  );
  const row = rows[0];
  if (row === undefined) return null;

  let password: string | null = null;
  if (row.password_encrypted !== null) {
    try {
      password = decryptSecret(row.password_encrypted);
    } catch {
      // Almost always a rotated ENCRYPTION_KEY. Treat it as "no password" so the send
      // fails with SMTP's own auth error rather than a crypto stack trace.
      password = null;
    }
  }

  return {
    enabled: row.enabled,
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    password,
    fromName: row.from_name,
    fromEmail: row.from_email,
    adminEmail: row.admin_email,
    dailyReport: row.daily_report,
    dailyReportHour: row.daily_report_hour,
    lastReportOn: row.last_report_on,
  };
}

/** Everything that has to be filled in before a send can be attempted. */
export function smtpIsUsable(config: SmtpConfig | null): config is SmtpConfig {
  return config !== null && config.host.trim() !== '' && config.fromEmail.trim() !== '';
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

export interface Mail {
  to: string;
  subject: string;
  text: string;
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

  const transport = transportFor(config);
  const from = `${config.fromName} <${config.fromEmail}>`;
  let sent = 0;
  let failed = 0;
  let error: string | null = null;

  for (const mail of mails) {
    try {
      await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text });
      sent += 1;
    } catch (err) {
      failed += 1;
      if (error === null) error = err instanceof Error ? err.message : String(err);
    }
  }
  transport.close();

  await sql(
    `update smtp_settings
        set last_sent_at = case when $1 > 0 then now() else last_sent_at end,
            last_error = $2`,
    [sent, error],
  );
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
