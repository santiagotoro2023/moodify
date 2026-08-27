-- Per-dashboard control of the heading above the grid: how far the two titles sit from
-- the centred logo, and how big that logo is drawn.
--
-- Both are NULL by default, meaning "use the built-in spacing / the site logo height set
-- in Settings". A dashboard built for a wall display wants a much larger logo than the
-- one in the top bar, and that is a property of the dashboard, not of the installation.
alter table dashboards add column title_gap   int;
alter table dashboards add column logo_height int;
