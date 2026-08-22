begin;

-- Remove legacy monthly bookkeeping left behind by an older schema version.
drop trigger if exists listener_history_set_collected_month
  on public.monthly_listener_history;
drop function if exists public.set_listener_history_collected_month();
alter table public.monthly_listener_history
  drop column if exists collected_month;

-- Keep the daily history uniqueness introduced by 005, but ensure the old
-- monthly expression index cannot return in an upgraded database.
drop index if exists public.listener_history_artist_minute_unique;
create unique index if not exists listener_history_artist_day_unique
  on public.monthly_listener_history (
    artist_id,
    ((collected_at at time zone 'UTC')::date)
  );

-- Cover the reverse side of the playlist/artist relationship.
create index if not exists playlist_artists_artist_id_idx
  on public.playlist_artists(artist_id);

-- The production workflow had accidentally pushed active artists seven days
-- into the future. Pull any already-scheduled active artists back to a 24-hour
-- cadence immediately instead of waiting for the stale weekly timestamp.
update public.artists
set next_collect_at = least(
      next_collect_at,
      coalesce(last_collected_at, now()) + interval '24 hours'
    ),
    updated_at = now()
where tracking_enabled = true
  and discovery_status = 'active';

-- Do not silently truncate the site's "all time" graph at 1,000 rows.
create or replace function public.site_artist_history(p_artist_id bigint)
returns table (
  monthly_listeners bigint,
  collected_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select h.monthly_listeners::bigint, h.collected_at
  from public.monthly_listener_history h
  join public.artists a on a.id = h.artist_id
  where h.artist_id = p_artist_id
    and a.discovery_status = 'active'
  order by h.collected_at asc;
$$;

commit;
