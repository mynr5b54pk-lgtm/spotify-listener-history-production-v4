begin;

create or replace function public.reserve_run_quota(
  p_artist_requested integer,
  p_playlist_requested integer,
  p_discovery_requested integer,
  p_artist_daily_max integer,
  p_playlist_daily_max integer,
  p_discovery_daily_max integer
)
returns table (
  usage_date date,
  artist_allowed integer,
  playlist_allowed integer,
  discovery_allowed integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  u public.daily_usage%rowtype;
  d date := current_date;
begin
  insert into public.daily_usage(usage_date)
  values (d)
  on conflict (usage_date) do nothing;

  select * into u
  from public.daily_usage
  where daily_usage.usage_date = d
  for update;

  usage_date := d;
  artist_allowed := greatest(0, least(p_artist_requested, p_artist_daily_max - u.artist_updates_reserved));
  playlist_allowed := greatest(0, least(p_playlist_requested, p_playlist_daily_max - u.playlist_scans_reserved));
  discovery_allowed := greatest(0, least(p_discovery_requested, p_discovery_daily_max - u.discovery_queries_reserved));

  update public.daily_usage
  set artist_updates_reserved = artist_updates_reserved + artist_allowed,
      playlist_scans_reserved = playlist_scans_reserved + playlist_allowed,
      discovery_queries_reserved = discovery_queries_reserved + discovery_allowed,
      updated_at = now()
  where daily_usage.usage_date = d;

  return next;
end;
$$;

create or replace function public.finalize_run_quota(
  p_usage_date date,
  p_artist_reserved integer,
  p_playlist_reserved integer,
  p_discovery_reserved integer,
  p_artist_attempted integer,
  p_playlist_attempted integer,
  p_discovery_attempted integer,
  p_artist_completed integer,
  p_playlist_completed integer,
  p_discovery_completed integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  artist_attempted integer := least(greatest(coalesce(p_artist_attempted, 0), 0), greatest(coalesce(p_artist_reserved, 0), 0));
  playlist_attempted integer := least(greatest(coalesce(p_playlist_attempted, 0), 0), greatest(coalesce(p_playlist_reserved, 0), 0));
  discovery_attempted integer := least(greatest(coalesce(p_discovery_attempted, 0), 0), greatest(coalesce(p_discovery_reserved, 0), 0));
begin
  update public.daily_usage
  set artist_updates_reserved = greatest(0, artist_updates_reserved - greatest(0, p_artist_reserved - artist_attempted)),
      playlist_scans_reserved = greatest(0, playlist_scans_reserved - greatest(0, p_playlist_reserved - playlist_attempted)),
      discovery_queries_reserved = greatest(0, discovery_queries_reserved - greatest(0, p_discovery_reserved - discovery_attempted)),
      artist_updates_completed = artist_updates_completed + least(greatest(coalesce(p_artist_completed, 0), 0), artist_attempted),
      playlist_scans_completed = playlist_scans_completed + least(greatest(coalesce(p_playlist_completed, 0), 0), playlist_attempted),
      discovery_queries_completed = discovery_queries_completed + least(greatest(coalesce(p_discovery_completed, 0), 0), discovery_attempted),
      updated_at = now()
  where usage_date = p_usage_date;
end;
$$;

revoke all on function public.reserve_run_quota(integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.finalize_run_quota(date, integer, integer, integer, integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;

grant execute on function public.reserve_run_quota(integer, integer, integer, integer, integer, integer)
  to service_role;
grant execute on function public.finalize_run_quota(date, integer, integer, integer, integer, integer, integer, integer, integer, integer)
  to service_role;

commit;
