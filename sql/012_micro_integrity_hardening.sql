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

-- Use database time for run completion. Runner and database clocks can differ
-- by fractions of a second; one historical row had finished_at < started_at.
create or replace function public.finish_worker_run(
  p_run_id bigint,
  p_status text,
  p_artist_updates_completed integer,
  p_playlist_scans_completed integer,
  p_discovery_queries_completed integer,
  p_discovered_playlists integer,
  p_discovered_artists integer,
  p_failed_jobs integer,
  p_duration_seconds integer,
  p_notes text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_status not in ('running','success','partial','failed','skipped') then
    raise exception 'invalid worker status';
  end if;

  update public.worker_runs
  set status = p_status,
      finished_at = greatest(now(), started_at),
      artist_updates_completed = greatest(0, coalesce(p_artist_updates_completed, 0)),
      playlist_scans_completed = greatest(0, coalesce(p_playlist_scans_completed, 0)),
      discovery_queries_completed = greatest(0, coalesce(p_discovery_queries_completed, 0)),
      discovered_playlists = greatest(0, coalesce(p_discovered_playlists, 0)),
      discovered_artists = greatest(0, coalesce(p_discovered_artists, 0)),
      failed_jobs = greatest(0, coalesce(p_failed_jobs, 0)),
      duration_seconds = greatest(0, coalesce(p_duration_seconds, 0)),
      notes = p_notes
  where id = p_run_id;
end;
$$;

revoke all on function public.finish_worker_run(bigint,text,integer,integer,integer,integer,integer,integer,integer,text)
  from public, anon, authenticated;
grant execute on function public.finish_worker_run(bigint,text,integer,integer,integer,integer,integer,integer,integer,text)
  to service_role;

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
-- This partial index makes the first, most important queue cheap as the table grows.
create index if not exists artists_active_due_idx
  on public.artists(next_collect_at, id)
  where tracking_enabled = true and discovery_status = 'active';

-- Old pre-normalization search indexes and the superseded playlist due index
-- are no longer used by current queries; removing them reduces write overhead.
drop index if exists public.artists_name_trgm_fallback_idx;
drop index if exists public.artists_name_trgm_idx;
drop index if exists public.site_artist_aliases_alias_trgm_idx;
drop index if exists public.playlists_due_idx;

commit;
