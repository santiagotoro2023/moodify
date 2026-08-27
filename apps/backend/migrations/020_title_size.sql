-- Heading text size above a dashboard, in px. NULL keeps the default, which is derived
-- from the logo height so the row scales as one piece — this column is for when the
-- headings should be louder or quieter than the logo they sit beside.
alter table dashboards add column title_size int;
