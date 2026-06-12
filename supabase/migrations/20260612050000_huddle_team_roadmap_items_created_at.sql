-- Harden team_roadmap_items audit stamping (review follow-up): the touch
-- trigger pinned created_at against rewrites on UPDATE, but an
-- authenticated client could still supply an arbitrary created_at on
-- INSERT and the trigger kept it. Stamp it server-side on INSERT in
-- authenticated contexts, matching created_by; service-role / server
-- writes keep supplied values (auth.uid() is null there), e.g. for a
-- future import path.
create or replace function public.touch_team_roadmap_items()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  if tg_op = 'UPDATE' then
    new.created_by = old.created_by;
    new.created_at = old.created_at;
  end if;
  if auth.uid() is not null then
    new.updated_by = auth.uid();
    if tg_op = 'INSERT' then
      new.created_by = auth.uid();
      new.created_at = now();
    end if;
  end if;
  return new;
end;
$$;
