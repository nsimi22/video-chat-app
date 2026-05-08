-- Infinite canvas migration: convert existing whiteboard data from
-- fractional [0..1] tile-relative coords to absolute world coords.
-- The renderer's old fractional model couldn't represent strokes
-- past the visible tile; the new InfiniteCanvas works in world
-- units (1 unit ≈ 1 pixel at scale 1) so strokes can extend in any
-- direction and pan/zoom navigate the surface.
--
-- Choice of multiplier: 1000. An old fractional stroke (e.g.
-- (0.5, 0.5)) lands at world (500, 500); a 0.18 × 0.18 sticky
-- note becomes 180 × 180 world units. The world unit is roughly
-- equivalent to a CSS pixel at the original 1000-pixel-ish tile
-- size, so legacy whiteboards open with their content in the
-- expected place under the default viewport (0, 0, scale=1).

-- Strokes: data is JSONB { tool, color, size, points: [[x, y], ...] }.
-- Rewrite each point's x and y in place, multiplying by 1000.
-- One UPDATE per row using a correlated subquery — Postgres handles
-- the JSONB array transformation cleanly.
update public.whiteboard_strokes
set data = jsonb_set(
  data,
  '{points}',
  coalesce(
    (select jsonb_agg(jsonb_build_array(
       (p->>0)::double precision * 1000,
       (p->>1)::double precision * 1000
     ))
     from jsonb_array_elements(data->'points') p),
    '[]'::jsonb
  )
)
where data ? 'points'
  and jsonb_typeof(data->'points') = 'array';

-- Sticky notes: x, y, w, h were [0..1] of the tile. Drop the CHECK
-- constraints first (they're tied to the [0..1] range), multiply
-- the values by 1000, and leave the columns unbounded — world
-- coords have no upper limit by design.
alter table public.whiteboard_notes drop constraint if exists whiteboard_notes_x_check;
alter table public.whiteboard_notes drop constraint if exists whiteboard_notes_y_check;
alter table public.whiteboard_notes drop constraint if exists whiteboard_notes_w_check;
alter table public.whiteboard_notes drop constraint if exists whiteboard_notes_h_check;

update public.whiteboard_notes
set x = x * 1000, y = y * 1000,
    w = w * 1000, h = h * 1000;
