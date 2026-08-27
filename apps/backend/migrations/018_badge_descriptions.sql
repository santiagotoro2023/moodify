-- Descriptions written in Moodify rather than in Moodle, shown in the badge pop-up.
-- Kept beside Moodle's own description instead of replacing it: the Moodle text is
-- re-synced on every discovery run and would overwrite anything written here.
alter table badges add column custom_description text;

-- Badge icons are now fetched at the largest size Moodle offers (see sizeVariants),
-- because the pop-up shows one full size. Clearing the cached path makes the image
-- proxy re-download each badge on first view rather than needing a full re-sync.
update badges set cached_image_path = null;

-- The two headings either side of the centred logo above a dashboard.
alter table dashboards add column title_left  text;
alter table dashboards add column title_right text;
