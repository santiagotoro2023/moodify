-- Email reminders for tasks.
--
-- Three tables: where to send from, what to send, and what has already gone out.

-- Single row, like moodle_connection. Disabled until an admin fills it in, so a fresh
-- install can never surprise a class with mail nobody configured.
create table smtp_settings (
  id                 serial primary key,
  enabled            boolean not null default false,
  host               text not null default '',
  port               int not null default 587,
  -- true = implicit TLS from the first byte (port 465). false = STARTTLS (587), which is
  -- what almost every relay wants.
  secure             boolean not null default false,
  username           text,
  -- AES-256-GCM, same key as the Moodle token (§9.5). Never returned to the frontend.
  password_encrypted text,
  from_name          text not null default 'Moodify',
  from_email         text not null default '',
  -- Daily digest to the operator, independent of the per-student rules.
  admin_email        text,
  daily_report       boolean not null default false,
  daily_report_hour  int not null default 7 check (daily_report_hour between 0 and 23),
  last_report_on     date,
  last_error         text,
  last_sent_at       timestamptz
);

insert into smtp_settings default values;

-- Global rules: they apply to every task. Several "before" rules can coexist (14 days,
-- 5 days, 1 day); "overdue" fires once, when the date passes.
create table notification_rules (
  id          serial primary key,
  kind        text not null check (kind in ('before', 'overdue')),
  days_before int,
  subject     text not null,
  body        text not null,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  check (
    (kind = 'before' and days_before is not null and days_before between 1 and 365)
    or (kind = 'overdue' and days_before is null)
  )
);

-- One row per mail actually sent. Without it a restart, a manual re-sync or simply the
-- next poll would send the same reminder again.
--
-- due_on is part of the key, not decoration: a yearly task comes round again next
-- September and must be allowed to notify again. The date is what makes this year's
-- reminder a different thing from last year's.
create table notification_log (
  rule_id        int not null references notification_rules(id) on delete cascade,
  deadline_id    int not null references deadlines(id) on delete cascade,
  moodle_user_id int not null references moodle_users(moodle_user_id) on delete cascade,
  due_on         date not null,
  sent_at        timestamptz not null default now(),
  primary key (rule_id, deadline_id, moodle_user_id, due_on)
);

-- Defaults the admin asked for, seeded enabled — harmless while smtp_settings.enabled
-- is false, and immediately useful the moment it is switched on.
insert into notification_rules (kind, days_before, subject, body) values
  ('before', 5,
   'Reminder: {activity} is due on {due}',
   E'Hi {name},\n\nThis is due on {due}, in {days} day(s):\n\n{activity}\n\n— Moodify'),
  ('overdue', null,
   'Overdue: {activity}',
   E'Hi {name},\n\nThis was due on {due} and is not marked complete in Moodle:\n\n{activity}\n\nPlease catch up as soon as you can.\n\n— Moodify');
