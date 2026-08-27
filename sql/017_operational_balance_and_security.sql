begin;

-- The production worker currently completes a full active-artist pass in
-- roughly five to six days. Match scheduling to that real capacity so the due
-- queue remains meaningful instead of being permanently overdue.
update public.artists
set next_collect_at = greatest(
      coalesce(next_collect_at, last_collected_at + interval '120 hours'),
      last_collected_at + interval '120 hours'
    ),
    updated_at = now()
where discovery_status = 'active'
  and tracking_enabled = true
  and last_collected_at is not null
  and (
    next_collect_at is null
    or next_collect_at < last_collected_at + interval '120 hours'
  );

-- These lifecycle functions mutate worker locks and run state. PostgreSQL
-- grants new functions to PUBLIC by default, so explicitly keep them limited
-- to the service role used by the worker.
revoke all on function public.heartbeat_worker_run(bigint, text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.reconcile_stale_worker_runs(integer)
  from public, anon, authenticated;

grant execute on function public.heartbeat_worker_run(bigint, text, uuid, integer)
  to service_role;
grant execute on function public.reconcile_stale_worker_runs(integer)
  to service_role;

commit;
