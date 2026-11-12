-- A badge whose course is deleted must go with it, not become a site-wide badge.
--
-- `on delete set null` read NULL as "site-wide", which is what the column means
-- everywhere else — so the moment discovery started dropping courses Moodle no longer
-- has, every badge of a dead course was laundered into a site-wide one. Site-wide badges
-- show in every course scope, so a badge that had been invisible (its course was not in
-- the widget's list) reappeared next to its replacement in the new course, under the same
-- name. Two badges, one name, on every tile.
alter table badges
  drop constraint if exists badges_moodle_course_id_fkey,
  add constraint badges_moodle_course_id_fkey
    foreign key (moodle_course_id) references courses(moodle_course_id) on delete cascade;
