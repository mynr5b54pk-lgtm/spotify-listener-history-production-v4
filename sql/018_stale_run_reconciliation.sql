begin;

-- A worker lock expires after ten minutes without a heartbeat. Mark the
-- corresponding abandoned run shortly afterward instead of leaving it in the
-- dashboard as running for more than three hours.
create or replace function public.reconcile_stale_worker_runs(p_stale_minutes integer default 20)
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
      finished_at = greatest(started_at, coalesce(last_heartbeat_at, started_at)),
      duration_seconds = greatest(0, extract(epoch from (coalesce(last_heartbeat_at, started_at) - started_at))::integer),
      notes = concat_ws('; ', nullif(notes, ''), 'auto-reconciled: worker heartbeat expired')
  where status = 'running'
    and coalesce(last_heartbeat_at, started_at) < now() - make_interval(mins => greatest(15, p_stale_minutes));

  get diagnostics repaired = row_count;

  delete from public.worker_locks
  where locked_until < now();

  return repaired;
end;
$$;

revoke all on function public.reconcile_stale_worker_runs(integer)
  from public, anon, authenticated;
grant execute on function public.reconcile_stale_worker_runs(integer)
  to service_role;

commit;
