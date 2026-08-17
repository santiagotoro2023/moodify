-- Drops the cached profile pictures so the next full sync fetches them again.
--
-- They were downloaded at Moodle's f1 size (100px), which is what the enrolled-users
-- call reports. Rings now scale to their column, and a 100px image inside one filling a
-- quarter of a Full HD screen is visibly soft — the avatar fetch asks for the 250px f3
-- variant first now. Cached files are only re-fetched when avatar_image_path is NULL,
-- so without this the existing low-resolution copies would stay forever.
--
-- Only the database pointer is cleared. The old files stay on disk and are overwritten
-- in place, since the filename is derived from the user id.

update moodle_users set avatar_image_path = null where avatar_image_path is not null;
