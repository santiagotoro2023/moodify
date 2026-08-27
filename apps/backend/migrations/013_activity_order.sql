-- Where an activity sits on the Moodle course page.
--
-- The task picker grouped by section — right — and then sorted the rows inside a section
-- alphabetically, which is a different order from the one the same person is looking at in
-- Moodle. Managing two systems side by side means the lists have to agree.
--
-- Counted across the whole course, in the order core_course_get_contents walks it. Existing
-- rows get 0 and fall back to name order until the next full discovery fills them in.
alter table course_activities add column activity_order int not null default 0;
