begin;

-- Remove a confirmed Spotify shell label that was accidentally preserved as
-- an alias during earlier canonical-name repairs. It is never a valid alias.
delete from public.site_artist_aliases
where lower(btrim(alias)) = 'your library';

alter table public.site_artist_aliases
  drop constraint if exists site_artist_aliases_no_shell_label;
alter table public.site_artist_aliases
  add constraint site_artist_aliases_no_shell_label
  check (lower(btrim(alias)) <> 'your library');

-- The application already rejects this shell label. Keep a database-side
-- fallback as well so a future parser regression cannot reintroduce it.
create or replace function public.guard_artist_display_name()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if lower(btrim(coalesce(new.name, ''))) = 'your library' then
    if tg_op = 'UPDATE' and lower(btrim(coalesce(old.name, ''))) <> 'your library' then
      new.name := old.name;
    else
      new.name := 'Spotify artist ' || coalesce(new.spotify_id, 'unknown');
    end if;
  end if;
  return new;
end;
$$;

-- Put the few remaining corrupted rows at the very front of their collection
-- queues. Their canonical names will be repaired from the artist page on the
-- next successful collection rather than guessed from ambiguous aliases.
update public.artists
set next_collect_at = timestamptz '2000-01-01 00:00:00+00',
    tracking_enabled = true,
    updated_at = now()
where lower(btrim(name)) = 'your library';

-- Add lightweight invariants around counters and latest listener values. The
-- current production data already satisfies these checks.
alter table public.artists
  drop constraint if exists artists_monthly_listeners_latest_nonnegative,
  drop constraint if exists artists_failure_count_nonnegative;
alter table public.artists
  add constraint artists_monthly_listeners_latest_nonnegative
    check (monthly_listeners_latest is null or monthly_listeners_latest >= 0),
  add constraint artists_failure_count_nonnegative
    check (failure_count >= 0);

alter table public.playlists
  drop constraint if exists playlists_failure_count_nonnegative;
alter table public.playlists
  add constraint playlists_failure_count_nonnegative
    check (failure_count >= 0);

alter table public.discovery_queries
  drop constraint if exists discovery_queries_failure_count_nonnegative;
alter table public.discovery_queries
  add constraint discovery_queries_failure_count_nonnegative
    check (failure_count >= 0);

alter table public.daily_usage
  drop constraint if exists daily_usage_nonnegative;
alter table public.daily_usage
  add constraint daily_usage_nonnegative check (
    artist_updates_reserved >= 0 and artist_updates_completed >= 0 and
    playlist_scans_reserved >= 0 and playlist_scans_completed >= 0 and
    discovery_queries_reserved >= 0 and discovery_queries_completed >= 0
  );

alter table public.worker_runs
  drop constraint if exists worker_runs_counters_nonnegative;
alter table public.worker_runs
  add constraint worker_runs_counters_nonnegative check (
    artist_updates_reserved >= 0 and artist_updates_completed >= 0 and
    playlist_scans_reserved >= 0 and playlist_scans_completed >= 0 and
    discovery_queries_reserved >= 0 and discovery_queries_completed >= 0 and
    discovered_playlists >= 0 and discovered_artists >= 0 and failed_jobs >= 0 and
    (duration_seconds is null or duration_seconds >= 0)
  );

-- Runner and database clocks can differ by fractions of a second. Clamp a
-- client-supplied completion timestamp to started_at before enforcing order.
create or replace function public.guard_worker_run_timestamps()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.finished_at is not null and new.finished_at < new.started_at then
    new.finished_at := new.started_at;
  end if;
  return new;
end;
$$;

drop trigger if exists worker_runs_guard_timestamps on public.worker_runs;
create trigger worker_runs_guard_timestamps
before insert or update of started_at, finished_at on public.worker_runs
for each row execute function public.guard_worker_run_timestamps();

-- Repair the one historical sub-second clock-skew artifact before enforcing
-- the invariant for future rows.
update public.worker_runs
set finished_at = started_at + make_interval(secs => greatest(0, coalesce(duration_seconds, 0)))
where finished_at is not null and finished_at < started_at;

alter table public.worker_runs
  drop constraint if exists worker_runs_finished_after_started;
alter table public.worker_runs
  add constraint worker_runs_finished_after_started
    check (finished_at is null or finished_at >= started_at);

-- Current collection order is active -> error -> candidate -> below-threshold.
-- These queue-oriented indexes match the actual ORDER BY clauses.
create index if not exists artists_active_due_idx
  on public.artists(next_collect_at, id)
  where tracking_enabled = true and discovery_status = 'active';
create index if not exists discovery_queries_due_priority_idx
  on public.discovery_queries(priority, next_use_at, id)
  where enabled = true;

-- Keep one canonical artist-history index. PostgreSQL B-tree indexes can scan
-- in either direction, so a second ASC/DESC copy only increases write cost.
create index if not exists monthly_listener_history_artist_collected_idx
  on public.monthly_listener_history(artist_id, collected_at);
drop index if exists public.listener_history_artist_time_idx;

-- Old pre-normalization / superseded indexes are no longer used by current
-- queries. Removing them reduces insert/update overhead as the dataset grows.
drop index if exists public.artists_name_trgm_fallback_idx;
drop index if exists public.artists_name_trgm_idx;
drop index if exists public.site_artist_aliases_alias_trgm_idx;
drop index if exists public.site_artist_aliases_lower_idx;
drop index if exists public.playlists_due_idx;
drop index if exists public.discovery_queries_due_idx;

-- The worker moved to reservation-aware quota RPCs in migration 008. Remove
-- the old functions so a future caller cannot accidentally bypass finalization.
drop function if exists public.reserve_daily_quota(integer, integer, integer, integer, integer, integer);
drop function if exists public.complete_daily_usage(integer, integer, integer);

commit;
