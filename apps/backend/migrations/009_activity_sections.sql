-- Which part of the course an activity lives in, so the Tasks page can group by it
-- instead of listing forty activities alphabetically.
--
-- `section` is the display label, already resolved to "Grundlagen › Woche 2" for a Moodle
-- 4.5 subsection (see getCourseContents). Storing the resolved string rather than a
-- parent/child pair keeps this a lookup table: nothing here needs to be queried by
-- section, only shown and sorted by it.
--
-- Existing rows get an empty label and order 0; the next full sync fills them in.

alter table course_activities add column section text not null default '';
alter table course_activities add column section_order int not null default 0;
