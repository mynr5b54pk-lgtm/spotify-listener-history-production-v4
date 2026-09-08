begin;

-- Active artists become due seven days after their latest successful collection.
-- Normal queueing delay may extend the observed interval toward 10.5 days.
-- Preserve longer retry backoff timestamps after failures.
update public.artists
set next_collect_at = greatest(
      next_collect_at,
      last_collected_at + interval '7 days'
    ),
    updated_at = now()
where tracking_enabled = true
  and discovery_status = 'active'
  and last_collected_at is not null
  and next_collect_at < last_collected_at + interval '7 days';

commit;
