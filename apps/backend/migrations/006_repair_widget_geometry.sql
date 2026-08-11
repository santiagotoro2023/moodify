-- Repairs widgets collapsed to a 1×1 box.
--
-- react-grid-layout falls back to {w:1, h:1, x:0, y:bottom} for any child it cannot match
-- to an entry in the layout it was given, which stacks every widget into a one-column
-- grey line. A `measureBeforeMount` experiment triggered exactly that, and because the
-- grid persists on drag and resize, that 1×1 geometry could reach the database — where
-- reverting the frontend does not undo it.
--
-- Nothing legitimately stores w or h below 2: the grid sets minW/minH to 2, and a
-- collapsed widget keeps its real height (the collapsed placeholder height is
-- substituted at render time, never persisted). Anything smaller is damage.
--
-- Every widget on an affected dashboard is re-stacked, one per row. Their positions are
-- meaningless after the fallback forced them all to x=0, and with vertical compaction
-- switched off nothing would pull overlaps apart on its own — so a clean stack is the
-- honest starting point to re-arrange from. 6×4 rather than each type's own default:
-- these have to be re-placed by hand anyway, and a readable size is all that is needed.

with repaired as (
  select id,
         dashboard_id,
         position_y,
         case when position_w < 2 then 6 else position_w end as w,
         case when position_h < 2 then 4 else position_h end as h
    from widgets
   where dashboard_id in (
     select dashboard_id from widgets where position_w < 2 or position_h < 2
   )
),
stacked as (
  select id, w, h,
         coalesce(
           sum(h) over (
             partition by dashboard_id order by position_y, id
             rows between unbounded preceding and 1 preceding
           ), 0) as y
    from repaired
)
-- Aliased `target` rather than `w`: the CTE already has a column called w, and reading
-- `set position_w = s.w` beside a table aliased `w` is needlessly confusing.
update widgets as target
   set position_x = 0,
       position_y = s.y,
       position_w = s.w,
       position_h = s.h
  from stacked s
 where target.id = s.id;
