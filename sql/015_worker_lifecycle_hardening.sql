begin;

alter table public.worker_runs
  add column if not exists last_heartbeat_at timestamptz;

update public.worker_runs
set last_heartbeat_at = coalesce(last_heartbeat_at, finished_at, started_at)
where last_heartbeat_at is null;

alter table public.worker_runs
  alter column last_heartbeat_at set default now();

create index if not exists idx_worker_runs_running_heartbeat
  on public.worker_runs (last_heartbeat_at)
  where status = 'running';

create or replace function public.heartbeat_worker_run(
  p_run_id bigint,
  p_worker_name text,
  p_lock_token uuid,
  p_ttl_minutes integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  touched integer := 0;
begin
  update public.worker_locks
  set locked_until = now() + make_interval(mins => greatest(1, p_ttl_minutes)),
      updated_at = now()
  where worker_name = p_worker_name
    and lock_token = p_lock_token;

  get diagnostics touched = row_count;
  if touched = 0 then
    return false;
  end if;

  update public.worker_runs
  set last_heartbeat_at = now()
  where id = p_run_id
    and status = 'running';

  return true;
end;
$$;

create or replace function public.reconcile_stale_worker_runs(p_stale_minutes integer default 185)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  repaired integer := 0;
begin
  update public.worker_runs
  set status = 'failed',
      finished_at = greatest(started_at, now()),
      duration_seconds = greatest(0, extract(epoch from (now() - started_at))::integer),
      notes = concat_ws('; ', nullif(notes, ''), 'auto-reconciled: worker heartbeat expired')
  where status = 'running'
    and coalesce(last_heartbeat_at, started_at) < now() - make_interval(mins => greatest(1, p_stale_minutes));

  get diagnostics repaired = row_count;

  delete from public.worker_locks
  where locked_until < now();

  return repaired;
end;
$$;

commit;
