begin;

create extension if not exists pg_trgm;

create index if not exists artists_name_trgm_idx
  on public.artists using gin(lower(name) gin_trgm_ops);

alter function public.acquire_worker_lock(text, uuid, integer)
  set search_path = public, pg_temp;
alter function public.release_worker_lock(text, uuid)
  set search_path = public, pg_temp;
alter function public.reserve_daily_quota(integer, integer, integer, integer, integer, integer)
  set search_path = public, pg_temp;
alter function public.complete_daily_usage(integer, integer, integer)
  set search_path = public, pg_temp;
alter function public.public_artist_search(text, integer, integer)
  set search_path = public, pg_temp;

revoke all on function public.acquire_worker_lock(text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.release_worker_lock(text, uuid)
  from public, anon, authenticated;
revoke all on function public.reserve_daily_quota(integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.complete_daily_usage(integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.public_artist_search(text, integer, integer)
  from public, anon, authenticated;

revoke all on table
  public.artists,
  public.monthly_listener_history,
  public.playlists,
  public.playlist_artists,
  public.discovery_queries,
  public.daily_usage,
  public.worker_locks,
  public.worker_runs,
  public.job_errors
  from anon, authenticated;

grant execute on function public.acquire_worker_lock(text, uuid, integer)
  to service_role;
grant execute on function public.release_worker_lock(text, uuid)
  to service_role;
grant execute on function public.reserve_daily_quota(integer, integer, integer, integer, integer, integer)
  to service_role;
grant execute on function public.complete_daily_usage(integer, integer, integer)
  to service_role;
grant execute on function public.public_artist_search(text, integer, integer)
  to anon, authenticated, service_role;

commit;
