begin;

update public.worker_runs
set worker_name = 'spotify-production-worker-v4'
where worker_name = 'spotify-discovery-worker-v4'
  and coalesce(artist_updates_reserved, 0) >= 1000;

commit;
