-- Deadline tracking: "this activity must be done by the first Monday in September,
-- and which September depends on which cohort you are in".
--
-- Three new things have to be synced from Moodle for this to be expressible at all:
-- cohorts (the groups a deadline applies to), cohort membership, and activity names
-- (core_completion_get_activities_completion_status only ever hands back a cmid, so
-- without core_course_get_contents there is nothing human-readable to point a deadline
-- at). All three are optional: an install whose External Service does not expose them
-- keeps working, it just has no deadlines to set.

create table cohorts (
  moodle_cohort_id int primary key,
  name             text not null,
  idnumber         text,
  last_seen_at     timestamptz not null default now()
);

create table cohort_members (
  moodle_cohort_id int not null references cohorts(moodle_cohort_id) on delete cascade,
  moodle_user_id   int not null references moodle_users(moodle_user_id) on delete cascade,
  primary key (moodle_cohort_id, moodle_user_id)
);

create index cohort_members_user_idx on cohort_members (moodle_user_id);

-- Only activities with completion tracking enabled are stored: a deadline on something
-- Moodle never marks complete could never be met.
create table course_activities (
  moodle_course_id int not null references courses(moodle_course_id) on delete cascade,
  cmid             int not null,
  name             text not null,
  modname          text not null,
  last_seen_at     timestamptz not null default now(),
  primary key (moodle_course_id, cmid)
);

-- A deadline is a yearly recurrence rule rather than a date, so it rolls forward on its
-- own against whoever is in the cohort that year. created_at is load-bearing, not
-- bookkeeping: a yearly rule has always already occurred at some point in the past, so
-- without an anchor a rule entered in June would report the cohort overdue since last
-- September the instant it was saved. It comes into force at its first occurrence after
-- it was written down. See deadlineDueAt() in packages/shared.
create table deadlines (
  id               serial primary key,
  moodle_course_id int not null,
  cmid             int not null,
  moodle_cohort_id int not null references cohorts(moodle_cohort_id) on delete cascade,
  month            int not null check (month between 1 and 12),
  -- Sunday = 0, matching Date#getDay so the same numbers work on both sides.
  weekday          int not null check (weekday between 0 and 6),
  -- 1-5, or -1 for "the last one in the month".
  nth              int not null check (nth between -1 and 5 and nth <> 0),
  created_at       timestamptz not null default now(),
  unique (moodle_course_id, cmid, moodle_cohort_id),
  foreign key (moodle_course_id, cmid)
    references course_activities(moodle_course_id, cmid) on delete cascade
);

create index deadlines_course_idx on deadlines (moodle_course_id);

alter table widgets drop constraint widgets_type_check;
alter table widgets add constraint widgets_type_check check (type in (
  'completion_table',
  'badge_cards',
  'badge_list',
  'course_overview',
  'leaderboard',
  'user_list',
  'progress_chart',
  'completion_rings'
));
