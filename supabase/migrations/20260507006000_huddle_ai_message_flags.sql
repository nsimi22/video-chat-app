-- AI-generated message flags. The author_id / author_name / author_color
-- still belong to the human who triggered the AI (so RLS, deletion, and
-- accountability all work normally) — these columns just let the renderer
-- render the message distinctly with a robot avatar, model badge, and a
-- "via @user" footer.
alter table public.messages
  add column ai_generated boolean not null default false,
  add column ai_model text;
