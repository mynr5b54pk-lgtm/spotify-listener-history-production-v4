begin;

-- The old index accidentally allowed only one history row per artist per MONTH.
-- Keep one point per UTC day so 7/30/90-day charts and change metrics work.
drop index if exists public.listener_history_artist_minute_unique;

create unique index if not exists listener_history_artist_day_unique
  on public.monthly_listener_history (
    artist_id,
    ((collected_at at time zone 'UTC')::date)
  );

commit;
