begin;

create or replace function public.guard_artist_display_name()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  candidate text := btrim(coalesce(new.name, ''));
begin
  if lower(candidate) in (
    'your library',
    'home',
    'search',
    'spotify',
    'liked songs',
    'create playlist'
  ) then
    if tg_op = 'UPDATE' and lower(btrim(coalesce(old.name, ''))) not in (
      'your library',
      'home',
      'search',
      'spotify',
      'liked songs',
      'create playlist'
    ) then
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

-- Repair rows where the bad shell label overwrote a name and exactly one
-- preserved non-shell alias exists. This is unambiguous.
with recoverable as (
  select a.id, min(s.alias) as restored_name
  from public.artists a
  join public.site_artist_aliases s on s.artist_id = a.id
  where lower(btrim(a.name)) in ('your library','home','search','spotify','liked songs','create playlist')
    and lower(btrim(s.alias)) not in ('your library','home','search','spotify','liked songs','create playlist')
  group by a.id
  having count(*) = 1
)
update public.artists a
set name = r.restored_name,
    updated_at = now()
from recoverable r
where a.id = r.id;

-- Any ambiguous leftovers should be refreshed as soon as possible using the
-- corrected Open Graph metadata extractor.
update public.artists
set next_collect_at = now(),
    tracking_enabled = true,
    updated_at = now()
where lower(btrim(name)) in ('your library','home','search','spotify','liked songs','create playlist');

commit;
