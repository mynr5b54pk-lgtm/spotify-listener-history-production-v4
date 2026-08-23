begin;

-- PostgreSQL treats the RETURNS TABLE output variable `usage_date` as a
-- PL/pgSQL variable. `ON CONFLICT (usage_date)` therefore became ambiguous
-- after quota accounting was moved into this table-returning function and
-- caused every worker start to fail before worker_runs could be created.
create or replace function public.reserve_run_quota(
  p_artist_requested integer,
  p_playlist_requested integer,
  p_discovery_requested integer,
  p_artist_daily_max integer,
  p_playlist_daily_max integer,
  p_discovery_daily_max integer
)
returns table(
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
  on conflict on constraint daily_usage_pkey do nothing;

  select du.* into u
  from public.daily_usage as du
  where du.usage_date = d
  for update;

  usage_date := d;
  artist_allowed := greatest(0, least(p_artist_requested, p_artist_daily_max - u.artist_updates_reserved));
  playlist_allowed := greatest(0, least(p_playlist_requested, p_playlist_daily_max - u.playlist_scans_reserved));
  discovery_allowed := greatest(0, least(p_discovery_requested, p_discovery_daily_max - u.discovery_queries_reserved));

  update public.daily_usage as du
  set artist_updates_reserved = du.artist_updates_reserved + artist_allowed,
      playlist_scans_reserved = du.playlist_scans_reserved + playlist_allowed,
      discovery_queries_reserved = du.discovery_queries_reserved + discovery_allowed,
      updated_at = now()
  where du.usage_date = d;

  return next;
end;
$$;

commit;
