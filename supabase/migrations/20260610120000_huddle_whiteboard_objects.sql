-- Whiteboard "objects" (Phase 2b): let a whiteboard_note also represent a
-- shape (rect/ellipse/diamond) or a table, so they reuse the note object's
-- drag / resize / select / connector / undo / realtime machinery.
--
-- Additive + backward compatible: existing rows have shape = NULL and render
-- exactly as before (sticky / text). No RLS change — both columns ride the
-- existing whiteboard_notes policies.
--
--   shape : 'rect' | 'ellipse' | 'diamond' | 'table' | NULL
--   meta  : shape fill config and/or table data, e.g.
--           { "rows": 3, "cols": 3, "cells": [["a","b"],[...]] }

ALTER TABLE public.whiteboard_notes
  ADD COLUMN IF NOT EXISTS shape text,
  ADD COLUMN IF NOT EXISTS meta jsonb;
