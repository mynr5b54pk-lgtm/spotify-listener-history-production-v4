begin;

create extension if not exists pgcrypto;

create table if not exists artists (
  id bigserial primary key,
  spotify_id text,
  name text not null,
  spotify_url text not null,
  image_url text,
  tracking_enabled boolean not null default true,
  discovery_status text not null default 'candidate'
    check (discovery_status in ('candidate','active','below_threshold','paused','error')),
  monthly_listeners_latest bigint,
  first_discovered_at timestamptz not null default now(),
  last_collected_at timestamptz,
  next_collect_at timestamptz not null default now(),
  failure_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table artists
  add column if not exists spotify_id text,
  add column if not exists image_url text,
  add column if not exists tracking_enabled boolean not null default true,
  add column if not exists discovery_status text not null default 'candidate',
  add column if not exists monthly_listeners_latest bigint,
  add column if not exists first_discovered_at timestamptz not null default now(),
  add column if not exists last_collected_at timestamptz,
  add column if not exists next_collect_at timestamptz not null default now(),
  add column if not exists failure_count integer not null default 0,
  add column if not exists last_error text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists artists_spotify_id_unique
  on artists(spotify_id) where spotify_id is not null;
create unique index if not exists artists_spotify_url_unique
  on artists(spotify_url);
create index if not exists artists_due_idx
  on artists(tracking_enabled, next_collect_at);
create index if not exists artists_latest_idx
  on artists(monthly_listeners_latest desc nulls last);
create index if not exists artists_name_trgm_fallback_idx
  on artists(lower(name));

create table if not exists monthly_listener_history (
  id bigserial primary key,
  artist_id bigint not null references artists(id) on delete cascade,
  monthly_listeners bigint not null check (monthly_listeners >= 0),
  collected_at timestamptz not null default now(),
  source text not null default 'spotify_web'
);

create index if not exists listener_history_artist_time_idx
  on monthly_listener_history(artist_id, collected_at desc);
create unique index if not exists listener_history_artist_minute_unique
  on monthly_listener_history(artist_id, date_trunc('month', collected_at AT TIME ZONE 'UTC'));

create table if not exists playlists (
  id bigserial primary key,
  spotify_id text not null unique,
  name text,
  spotify_url text not null unique,
  source_query text,
  scan_status text not null default 'pending'
    check (scan_status in ('pending','active','error','paused')),
  last_scanned_at timestamptz,
  next_scan_at timestamptz not null default now(),
  failure_count integer not null default 0,
  last_error text,
  first_discovered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists playlists_due_idx
  on playlists(scan_status, next_scan_at);

create table if not exists playlist_artists (
  playlist_id bigint not null references playlists(id) on delete cascade,
  artist_id bigint not null references artists(id) on delete cascade,
  discovered_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (playlist_id, artist_id)
);

create table if not exists discovery_queries (
  id bigserial primary key,
  query text not null unique,
  enabled boolean not null default true,
  priority integer not null default 100,
  last_used_at timestamptz,
  next_use_at timestamptz not null default now(),
  failure_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists discovery_queries_due_idx
  on discovery_queries(enabled, next_use_at, priority);

create table if not exists daily_usage (
  usage_date date primary key,
  artist_updates_reserved integer not null default 0,
  artist_updates_completed integer not null default 0,
  playlist_scans_reserved integer not null default 0,
  playlist_scans_completed integer not null default 0,
  discovery_queries_reserved integer not null default 0,
  discovery_queries_completed integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists worker_locks (
  worker_name text primary key,
  lock_token uuid not null,
  locked_until timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists worker_runs (
  id bigserial primary key,
  run_token uuid not null unique,
  status text not null default 'running'
    check (status in ('running','success','partial','failed','skipped')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  artist_updates_reserved integer not null default 0,
  artist_updates_completed integer not null default 0,
  playlist_scans_reserved integer not null default 0,
  playlist_scans_completed integer not null default 0,
  discovery_queries_reserved integer not null default 0,
  discovery_queries_completed integer not null default 0,
  discovered_playlists integer not null default 0,
  discovered_artists integer not null default 0,
  failed_jobs integer not null default 0,
  duration_seconds integer,
  notes text
);

create index if not exists worker_runs_started_idx on worker_runs(started_at desc);

create table if not exists job_errors (
  id bigserial primary key,
  run_token uuid,
  job_type text not null,
  entity_id bigint,
  entity_key text,
  error_message text not null,
  attempt integer,
  created_at timestamptz not null default now()
);

create index if not exists job_errors_created_idx on job_errors(created_at desc);

update artists
set spotify_id = substring(spotify_url from '/artist/([A-Za-z0-9]+)')
where spotify_id is null and spotify_url like '%/artist/%';

create or replace function acquire_worker_lock(
  p_worker_name text,
  p_lock_token uuid,
  p_ttl_minutes integer
)
returns boolean
language plpgsql
security definer
as $$
declare
  acquired boolean := false;
begin
  insert into worker_locks(worker_name, lock_token, locked_until, updated_at)
  values (
    p_worker_name,
    p_lock_token,
    now() + make_interval(mins => p_ttl_minutes),
    now()
  )
  on conflict (worker_name) do update
    set lock_token = excluded.lock_token,
        locked_until = excluded.locked_until,
        updated_at = now()
    where worker_locks.locked_until < now();

  select lock_token = p_lock_token
  into acquired
  from worker_locks
  where worker_name = p_worker_name;

  return coalesce(acquired, false);
end;
$$;

create or replace function release_worker_lock(
  p_worker_name text,
  p_lock_token uuid
)
returns void
language sql
security definer
as $$
  delete from worker_locks
  where worker_name = p_worker_name
    and lock_token = p_lock_token;
$$;

create or replace function reserve_daily_quota(
  p_artist_requested integer,
  p_playlist_requested integer,
  p_discovery_requested integer,
  p_artist_daily_max integer,
  p_playlist_daily_max integer,
  p_discovery_daily_max integer
)
returns table (
  artist_allowed integer,
  playlist_allowed integer,
  discovery_allowed integer
)
language plpgsql
security definer
as $$
declare
  u daily_usage%rowtype;
begin
  insert into daily_usage(usage_date)
  values (current_date)
  on conflict (usage_date) do nothing;

  select * into u
  from daily_usage
  where usage_date = current_date
  for update;

  artist_allowed := greatest(
    0,
    least(p_artist_requested, p_artist_daily_max - u.artist_updates_reserved)
  );
  playlist_allowed := greatest(
    0,
    least(p_playlist_requested, p_playlist_daily_max - u.playlist_scans_reserved)
  );
  discovery_allowed := greatest(
    0,
    least(p_discovery_requested, p_discovery_daily_max - u.discovery_queries_reserved)
  );

  update daily_usage
  set artist_updates_reserved = artist_updates_reserved + artist_allowed,
      playlist_scans_reserved = playlist_scans_reserved + playlist_allowed,
      discovery_queries_reserved = discovery_queries_reserved + discovery_allowed,
      updated_at = now()
  where usage_date = current_date;

  return next;
end;
$$;

create or replace function complete_daily_usage(
  p_artist_completed integer,
  p_playlist_completed integer,
  p_discovery_completed integer
)
returns void
language sql
security definer
as $$
  update daily_usage
  set artist_updates_completed = artist_updates_completed + greatest(0, p_artist_completed),
      playlist_scans_completed = playlist_scans_completed + greatest(0, p_playlist_completed),
      discovery_queries_completed = discovery_queries_completed + greatest(0, p_discovery_completed),
      updated_at = now()
  where usage_date = current_date;
$$;

create or replace function public_artist_search(
  p_query text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  id bigint,
  spotify_id text,
  name text,
  spotify_url text,
  image_url text,
  monthly_listeners_latest bigint,
  last_collected_at timestamptz
)
language sql
stable
security definer
as $$
  select
    a.id,
    a.spotify_id,
    a.name,
    a.spotify_url,
    a.image_url,
    a.monthly_listeners_latest,
    a.last_collected_at
  from artists a
  where a.discovery_status = 'active'
    and (
      p_query is null
      or p_query = ''
      or lower(a.name) like '%' || lower(p_query) || '%'
    )
  order by a.monthly_listeners_latest desc nulls last, a.id
  limit greatest(1, least(p_limit, 100))
  offset greatest(0, p_offset);
$$;

alter table artists enable row level security;
alter table monthly_listener_history enable row level security;
alter table playlists enable row level security;
alter table playlist_artists enable row level security;
alter table discovery_queries enable row level security;
alter table daily_usage enable row level security;
alter table worker_locks enable row level security;
alter table worker_runs enable row level security;
alter table job_errors enable row level security;

commit;
