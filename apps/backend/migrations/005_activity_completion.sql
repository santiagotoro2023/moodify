-- All-time history, reconstructed rather than accumulated.
--
-- metric_history (004) only knows what Moodify itself has watched happen. But Moodle has
-- been stamping every activity completion with a timestamp since long before Moodify was
-- installed, and core_completion_get_activities_completion_status hands it back on the
-- very call the poller already makes. Storing those stamps means the "all time" chart can
-- reach back to the day the course started, on an install that is an hour old.
--
-- Only *completed* activities get a row: an incomplete one contributes nothing to a
-- cumulative history, and leaving them out keeps this table roughly the size of the work
-- actually done rather than courses × students × activities.
--
-- Badges need no equivalent table — badge_issued.date_issued already carries Moodle's own
-- issue timestamp and has since 001.

create table activity_completion (
  moodle_course_id int not null references courses(moodle_course_id) on delete cascade,
  moodle_user_id   int not null references moodle_users(moodle_user_id) on delete cascade,
  -- Course module id. Unique per activity within Moodle, so it is the natural key here.
  cmid             int not null,
  -- NULL when Moodle reports a completion with no timestamp, which happens for state
  -- restored from a course backup. Those count toward the total but cannot be placed on
  -- the time axis, so the chart folds them into its starting value.
  completed_at     timestamptz,
  primary key (moodle_course_id, moodle_user_id, cmid)
);

create index activity_completion_user_idx
  on activity_completion (moodle_user_id, completed_at);
