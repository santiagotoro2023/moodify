-- "X over time" widget: the first thing in Moodify that keeps history.
--
-- §1 called time-series a non-goal and everything else here is a live snapshot
-- overwritten each sync. This table is the deliberate exception, and it is bounded on
-- both axes so it stays a snapshot-sized problem: samples are written at most every
-- SAMPLE_INTERVAL_MS (15 min, sync.ts) and pruned past HISTORY_RETENTION_DAYS (7).
-- Worst case is ~700k rows at the <50 user / <20 course scale in §13.

create table metric_history (
  moodle_user_id   int not null references moodle_users(moodle_user_id) on delete cascade,
  -- NULL = the across-all-courses row. Per-course rows exist alongside it so a chart
  -- scoped to one course does not have to un-mix a total.
  moodle_course_id int references courses(moodle_course_id) on delete cascade,
  recorded_at      timestamptz not null default now(),
  -- Same meaning as completion_snapshot: NULL is "not tracked", never 0%.
  percent_complete numeric(5,2),
  badge_count      int not null default 0
);

-- The read pattern is always (user, course scope, time range).
create index metric_history_lookup_idx
  on metric_history (moodle_user_id, moodle_course_id, recorded_at desc);
-- The prune pattern is a plain range delete.
create index metric_history_recorded_idx on metric_history (recorded_at);

-- Profile pictures, cached locally for the same reason badge images are (§9.3):
-- pluginfile.php needs the web service token, so it can never be hotlinked.
alter table moodle_users add column avatar_source_url text;
alter table moodle_users add column avatar_image_path text;

alter table widgets drop constraint widgets_type_check;
alter table widgets add constraint widgets_type_check check (type in (
  'completion_table', 'badge_cards', 'badge_list', 'course_overview',
  'leaderboard', 'user_list', 'progress_chart'));
