import type { FastifyBaseLogger } from 'fastify';
import { deadlineDueAt, deadlineNextDueAt, formatDay, type DeadlineRule } from '@moodify/shared';
import { sql } from './db.ts';
import { loadSmtpConfig, renderTemplate, sendMails, smtpIsUsable, type Mail } from './mail.ts';

/**
 * Task reminders by email.
 *
 * Runs at the end of every full discovery — the same fifteen-minute cadence the activity
 * timestamps refresh on, which is as fine-grained as day-granularity deadlines need.
 * No second scheduler.
 *
 * Two things this must never do: send twice, or send to somebody Moodle never gave us an
 * address for. The first is what notification_log is for; the second is silent by design
 * (§ the admin chose "skip"), with the affected people listed in Settings.
 */

export interface NotificationRule {
  id: number;
  kind: 'before' | 'overdue';
  daysBefore: number | null;
  subject: string;
  body: string;
}

/** One (task × person) pairing, before any rule has looked at it. */
export interface Candidate {
  deadlineId: number;
  courseName: string;
  activityName: string;
  userId: number;
  fullname: string;
  email: string | null;
  rule: DeadlineRule;
  createdAt: Date;
  completed: boolean;
}

export interface PlannedMail {
  ruleId: number;
  userId: number;
  email: string;
  /**
   * Every task the mail covers, each with the occurrence it is about — together the
   * no-duplicates key. Per task rather than per mail because an overdue mail gathers
   * several due dates into one message, and logging them all under the earliest would
   * make the others look unsent and mail them again next pass.
   */
  sent: { deadlineId: number; dueOn: string }[];
  subject: string;
  text: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole calendar days from one date to another, measured midnight to midnight.
 *
 * Not a subtraction of the raw instants: a deadline is stored as the *end* of its day, so
 * 10 March 09:00 to 13 March 23:59 is 3.6 days and rounds up to "in 4 days" — a day later
 * than anybody counting on a calendar would say, in the one sentence that has to match
 * what the reader sees.
 */
function daysBetween(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / DAY_MS);
}

function isoDay(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function sentKey(ruleId: number, deadlineId: number, userId: number, dueOn: string): string {
  return `${ruleId}:${deadlineId}:${userId}:${dueOn}`;
}

/**
 * Decides what to send. Pure, so the interesting part — who gets mail, when, and never
 * twice — is testable without an SMTP server or a database.
 *
 * Grouping is by (rule, person, due date) — three activities due the same day become one
 * mail listing all three, and two due on different days stay two mails, because {due} in
 * the template has to mean something.
 *
 * Overdue is the exception: it groups by (rule, person) alone. Work goes overdue on
 * whatever day it was due, so grouping those by date would mail somebody once per missed
 * deadline — five mails in one pass for the student who most needs one clear list. {due}
 * is then the oldest of them, and every bullet carries its own date so nothing is lost.
 */
export function planNotifications(
  rules: readonly NotificationRule[],
  candidates: readonly Candidate[],
  alreadySent: ReadonlySet<string>,
  now: Date,
  /**
   * Drops the two conditions that make this a *scheduled* pass: the rule's window, and
   * "not already sent". An admin pressing Send on the Tasks page has decided both of
   * those, and a button that quietly does nothing because the date is three weeks out
   * would be worse than no button. What it does not drop is completed work and missing
   * addresses — those are still reasons not to mail somebody.
   */
  force = false,
): PlannedMail[] {
  type Item = { candidate: Candidate; dueAt: Date; dueOn: string };
  type Group = {
    rule: NotificationRule;
    candidate: Candidate;
    items: Item[];
    /** The oldest occurrence in the group, which is what {due} and {days} report. */
    dueAt: Date;
  };
  const groups = new Map<string, Group>();

  for (const rule of rules) {
    for (const item of candidates) {
      if (item.completed || item.email === null) continue;

      let dueAt: Date | null;
      if (rule.kind === 'overdue') {
        // Forced, an overdue rule aimed at something not yet overdue still has to name a
        // date, and the only honest one is the date it will be due.
        dueAt = deadlineDueAt(item.rule, item.createdAt, now);
        if (dueAt === null && force) dueAt = deadlineNextDueAt(item.rule, now);
      } else {
        const next = deadlineNextDueAt(item.rule, now);
        dueAt = next !== null && (force || daysBetween(now, next) <= (rule.daysBefore ?? 0)) ? next : null;
      }
      if (dueAt === null) continue;

      const dueOn = isoDay(dueAt);
      if (!force && alreadySent.has(sentKey(rule.id, item.deadlineId, item.userId, dueOn))) continue;

      const key =
        rule.kind === 'overdue'
          ? `${rule.id}:${item.userId}`
          : `${rule.id}:${item.userId}:${dueOn}`;
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, { rule, candidate: item, items: [{ candidate: item, dueAt, dueOn }], dueAt });
      } else {
        group.items.push({ candidate: item, dueAt, dueOn });
        if (dueAt < group.dueAt) group.dueAt = dueAt;
      }
    }
  }

  const planned: PlannedMail[] = [];
  for (const group of groups.values()) {
    const email = group.candidate.email;
    if (email === null) continue;

    // Oldest first, then by name. For a "before" rule every item shares one date, so
    // this is the alphabetical order it always was.
    const items = [...group.items].sort(
      (a, b) =>
        a.dueAt.getTime() - b.dueAt.getTime() ||
        a.candidate.activityName.localeCompare(b.candidate.activityName),
    );
    const spread = new Set(items.map((item) => item.dueOn)).size > 1;
    const values = {
      name: group.candidate.fullname,
      activity: items
        .map(({ candidate, dueAt }) =>
          // Only when they differ: repeating one date down every line of a "due Friday"
          // mail is noise.
          spread
            ? `• ${candidate.activityName} (${candidate.courseName}) — due ${formatDay(dueAt)}`
            : `• ${candidate.activityName} (${candidate.courseName})`,
        )
        .join('\n'),
      course: [...new Set(items.map((item) => item.candidate.courseName))].join(', '),
      due: formatDay(group.dueAt),
      days: String(Math.max(0, daysBetween(now, group.dueAt))),
    };

    planned.push({
      ruleId: group.rule.id,
      userId: group.candidate.userId,
      email,
      sent: items.map((item) => ({ deadlineId: item.candidate.deadlineId, dueOn: item.dueOn })),
      // A subject holding the bullet list would be unreadable, so a multi-item mail says
      // how many instead of naming one of them and hiding the rest.
      subject: renderTemplate(group.rule.subject, {
        ...values,
        activity:
          items.length === 1
            ? (items[0]?.candidate.activityName ?? '')
            : `${items.length} activities`,
      }),
      text: renderTemplate(group.rule.body, values),
    });
  }
  return planned;
}

// ---------------------------------------------------------------------------
// Database side
// ---------------------------------------------------------------------------

type RuleRow = {
  id: number;
  kind: string;
  days_before: number | null;
  subject: string;
  body: string;
};

type CandidateRow = {
  deadline_id: number;
  course_name: string;
  activity_name: string;
  moodle_user_id: number;
  fullname: string;
  email: string | null;
  due_date: Date | null;
  month: number | null;
  weekday: number | null;
  nth: number | null;
  created_at: Date;
  completed: boolean;
};

export async function loadRules(): Promise<NotificationRule[]> {
  const { rows } = await sql<RuleRow>(
    `select id, kind, days_before, subject, body
       from notification_rules
      where enabled = true
      order by kind asc, days_before desc nulls last, id asc`,
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind === 'overdue' ? 'overdue' : 'before',
    daysBefore: row.days_before,
    subject: row.subject,
    body: row.body,
  }));
}

/** One rule by id, enabled or not: a manual send uses whatever wording the admin picks. */
export async function loadRule(id: number): Promise<NotificationRule | null> {
  const { rows } = await sql<RuleRow>(
    `select id, kind, days_before, subject, body from notification_rules where id = $1`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    kind: row.kind === 'overdue' ? 'overdue' : 'before',
    daysBefore: row.days_before,
    subject: row.subject,
    body: row.body,
  };
}

/**
 * Every (task × enrolled person) pairing, with the person's completion state.
 *
 * Same shape as the widget's deadline query — enrolment is required, and a cohort on the
 * task narrows it further. Students only: a teacher enrolled in the course is not the one
 * who has to hand the work in.
 */
export async function loadCandidates(): Promise<Candidate[]> {
  const { rows } = await sql<CandidateRow>(
    `select d.id as deadline_id, co.fullname as course_name, ca.name as activity_name,
            e.moodle_user_id, u.fullname, u.email,
            d.due_date, d.month, d.weekday, d.nth, d.created_at,
            (ac.cmid is not null) as completed
       from deadlines d
       join courses co on co.moodle_course_id = d.moodle_course_id
       join course_activities ca
         on ca.moodle_course_id = d.moodle_course_id and ca.cmid = d.cmid
       join enrollments e on e.moodle_course_id = d.moodle_course_id
       join moodle_users u on u.moodle_user_id = e.moodle_user_id
       left join activity_completion ac
         on ac.moodle_course_id = d.moodle_course_id
        and ac.moodle_user_id   = e.moodle_user_id
        and ac.cmid             = d.cmid
      where 'student' = any(e.roles)
        and (d.moodle_cohort_id is null
             or exists (select 1 from cohort_members cm
                         where cm.moodle_cohort_id = d.moodle_cohort_id
                           and cm.moodle_user_id = e.moodle_user_id))`,
  );

  return rows.map((row) => ({
    deadlineId: row.deadline_id,
    courseName: row.course_name,
    activityName: row.activity_name,
    userId: row.moodle_user_id,
    fullname: row.fullname,
    email: row.email,
    rule: {
      date: row.due_date === null ? null : isoDay(row.due_date),
      month: row.month,
      weekday: row.weekday,
      nth: row.nth,
    },
    createdAt: row.created_at,
    completed: row.completed,
  }));
}

async function loadSentKeys(): Promise<Set<string>> {
  const { rows } = await sql<{
    rule_id: number;
    deadline_id: number;
    moodle_user_id: number;
    due_on: Date;
  }>('select rule_id, deadline_id, moodle_user_id, due_on from notification_log');
  return new Set(
    rows.map((row) => sentKey(row.rule_id, row.deadline_id, row.moodle_user_id, isoDay(row.due_on))),
  );
}

/**
 * The digest to the operator: everything overdue right now, and everything falling due in
 * the next week. Sent at most once a day, at the configured hour.
 */
function buildDailyReport(candidates: readonly Candidate[], now: Date): string | null {
  const overdue: string[] = [];
  const soon: string[] = [];

  for (const item of candidates) {
    if (item.completed) continue;
    const due = deadlineDueAt(item.rule, item.createdAt, now);
    if (due !== null) {
      overdue.push(`• ${item.fullname} — ${item.activityName} (${item.courseName}), due ${formatDay(due)}`);
      continue;
    }
    const next = deadlineNextDueAt(item.rule, now);
    if (next !== null && next.getTime() - now.getTime() <= 7 * DAY_MS) {
      soon.push(`• ${item.fullname} — ${item.activityName} (${item.courseName}), due ${formatDay(next)}`);
    }
  }
  if (overdue.length === 0 && soon.length === 0) return null;

  overdue.sort();
  soon.sort();
  const parts = [`Moodify — ${formatDay(now)}`, ''];
  if (overdue.length > 0) parts.push(`Overdue (${overdue.length}):`, ...overdue, '');
  if (soon.length > 0) parts.push(`Due within 7 days (${soon.length}):`, ...soon, '');
  return parts.join('\n');
}

/** One pass: work out what is owed, send it, record it. */
export async function runNotifications(logger: FastifyBaseLogger): Promise<void> {
  const config = await loadSmtpConfig();
  if (!smtpIsUsable(config) || !config.enabled) return;

  const [rules, candidates, alreadySent] = await Promise.all([
    loadRules(),
    loadCandidates(),
    loadSentKeys(),
  ]);

  const now = new Date();

  // One batch a day, at the configured hour. Eligibility changes at midnight, so the
  // first pass at or after the hour carries the whole day's mail; the passes before it
  // do nothing, which is the point — nobody wants "due tomorrow" at 03:00.
  if (now.getHours() >= config.sendHour) {
    const sent = await deliver(config, planNotifications(rules, candidates, alreadySent, now), logger);
    if (sent > 0) logger.info({ count: sent }, 'task reminders sent');
  }

  await maybeSendDailyReport(config.adminEmail, config, candidates, now, logger);
}

/**
 * Sends planned mail and records what actually left. Returns how many went out.
 *
 * Logging happens per mail that left, not per mail planned — a send that failed has to be
 * retried on the next pass, and a duplicate is a smaller problem than a reminder nobody
 * ever gets. A manual send logs too, so the scheduled pass does not repeat it later.
 */
export async function deliver(
  config: NonNullable<Awaited<ReturnType<typeof loadSmtpConfig>>>,
  planned: readonly PlannedMail[],
  logger: FastifyBaseLogger,
): Promise<number> {
  let sent = 0;
  for (const mail of planned) {
    const result = await sendMails(config, [{ to: mail.email, subject: mail.subject, text: mail.text }]);
    if (result.sent === 0) {
      logger.warn({ userId: mail.userId, err: result.error }, 'task reminder failed');
      continue;
    }
    sent += 1;
    await sql(
      `insert into notification_log (rule_id, deadline_id, moodle_user_id, due_on)
       select $1, item.id, $4, item.due::date
         from unnest($2::int[], $3::text[]) as item(id, due)
       on conflict do nothing`,
      [
        mail.ruleId,
        mail.sent.map((item) => item.deadlineId),
        mail.sent.map((item) => item.dueOn),
        mail.userId,
      ],
    );
  }
  return sent;
}

async function maybeSendDailyReport(
  adminEmail: string | null,
  config: NonNullable<Awaited<ReturnType<typeof loadSmtpConfig>>>,
  candidates: readonly Candidate[],
  now: Date,
  logger: FastifyBaseLogger,
): Promise<void> {
  if (!config.dailyReport || adminEmail === null || adminEmail.trim() === '') return;
  if (now.getHours() < config.dailyReportHour) return;
  if (config.lastReportOn !== null && isoDay(config.lastReportOn) === isoDay(now)) return;

  const text = buildDailyReport(candidates, now);
  // Stamp the day either way: "nothing to report" is still today's report, and without
  // the stamp an empty morning would re-check every fifteen minutes until something
  // finally went overdue and then mail at a random hour.
  await sql('update smtp_settings set last_report_on = $1::date', [isoDay(now)]);
  if (text === null) return;

  const mails: Mail[] = [{ to: adminEmail, subject: `Moodify daily report — ${formatDay(now)}`, text }];
  const result = await sendMails(config, mails);
  if (result.sent === 0) logger.warn({ err: result.error }, 'daily report failed');
}
