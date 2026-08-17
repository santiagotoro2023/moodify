-- Two things the deadline model was missing.
--
-- 1. A one-off date. The yearly rule covers "every year by the first Monday in
--    September", but most tasks are just "done by 15 March 2027" and expressing that as
--    a recurrence is a lie that comes back next year.
-- 2. A task that applies to everyone. Cohorts answer "which year group", but plenty of
--    tasks have one date for the whole course, and forcing a cohort onto those means
--    inventing one.

alter table deadlines alter column month drop not null;
alter table deadlines alter column weekday drop not null;
alter table deadlines alter column nth drop not null;
alter table deadlines alter column moodle_cohort_id drop not null;

alter table deadlines add column due_date date;

-- Exactly one of the two forms, never both and never neither: a row with no date at all
-- would be a deadline that can never come due, which reads as a bug for the rest of time.
alter table deadlines add constraint deadlines_schedule_check check (
  (due_date is not null and month is null and weekday is null and nth is null)
  or
  (due_date is null and month is not null and weekday is not null and nth is not null)
);

-- The old constraint cannot dedupe the "everyone" rows: in SQL two NULLs are never
-- equal, so it would happily store the same course-wide task ten times. coalesce(...,0)
-- gives those rows a real value to collide on. Postgres 15's NULLS NOT DISTINCT would
-- be tidier but pins the minimum server version for no practical gain.
alter table deadlines drop constraint if exists deadlines_moodle_course_id_cmid_moodle_cohort_id_key;
create unique index deadlines_unique_idx
  on deadlines (moodle_course_id, cmid, coalesce(moodle_cohort_id, 0));
