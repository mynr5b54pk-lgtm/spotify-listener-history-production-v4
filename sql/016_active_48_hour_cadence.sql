begin;

-- Public artists (10,000+ monthly listeners) are collected about once every
-- two days. Preserve longer retry backoff timestamps after failures, while
-- moving successful artists that were still on the old 24-hour cadence to 48h.
update public.artists
set next_collect_at = greatest(
      next_collect_at,
      last_collected_at + interval '48 hours'
    ),
    updated_at = now()
where tracking_enabled = true
  and discovery_status = 'active'
  and last_collected_at is not null
  and next_collect_at < last_collected_at + interval '48 hours';

commit;
