-- Remembering where a badge image came from lets a failed download be retried
-- (and diagnosed) without re-walking every user's badge list in Moodle.
alter table badges add column source_url text;
