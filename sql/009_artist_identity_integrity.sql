begin;

create or replace function public.guard_artist_display_name()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if lower(btrim(coalesce(new.name, ''))) = 'your library' then
    if tg_op = 'UPDATE' and lower(btrim(coalesce(old.name, ''))) <> 'your library' then
      new.name := old.name;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists artists_guard_display_name on public.artists;
create trigger artists_guard_display_name
before insert or update of name on public.artists
for each row execute function public.guard_artist_display_name();

-- Repair rows where the confirmed Spotify shell label overwrote a name and
-- exactly one preserved real alias exists. This case is unambiguous.
with recoverable as (
  select a.id, min(s.alias) as restored_name
  from public.artists a
  join public.site_artist_aliases s on s.artist_id = a.id
  where lower(btrim(a.name)) = 'your library'
    and lower(btrim(s.alias)) <> 'your library'
  group by a.id
  having count(*) = 1
)
update public.artists a
set name = r.restored_name,
    updated_at = now()
from recoverable r
where a.id = r.id;

-- Ambiguous leftovers are queued for immediate recollection using the fixed
-- Open Graph metadata extractor rather than guessing between valid aliases.
update public.artists
set next_collect_at = now(),
    tracking_enabled = true,
    updated_at = now()
where lower(btrim(name)) = 'your library';

commit;
