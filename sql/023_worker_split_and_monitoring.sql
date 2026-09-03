begin;

alter table public.worker_runs
  add column if not exists worker_name text;

update public.worker_runs
set worker_name = case
  when coalesce(artist_updates_reserved, 0) >= 1000
    then 'spotify-production-worker-v4'
  when coalesce(playlist_scans_reserved, 0) > 0
    or coalesce(discovery_queries_reserved, 0) > 0
    then 'spotify-discovery-worker-v4'
  else 'spotify-production-worker-v4'
end
where worker_name is null;

alter table public.worker_runs
  alter column worker_name set default 'spotify-production-worker-v4',
  alter column worker_name set not null;

create index if not exists worker_runs_worker_started_idx
  on public.worker_runs (worker_name, started_at desc);

commit;
