begin;

-- Keep queue validation moving without sacrificing the 5–6 day active cycle.
-- Runtime allocation is configured by the worker; this migration hardens the
-- supporting lifecycle and public read API.

alter table public.worker_runs
  add column if not exists usage_date date;

update public.worker_runs
set usage_date = (started_at at time zone 'UTC')::date
where usage_date is null;

alter table public.worker_runs
  alter column usage_date set default current_date,
  alter column usage_date set not null;

alter table public.worker_runs
  add column if not exists quota_finalized boolean not null default false;

-- Every previously finished run used the old code path, which finalized quota
-- before writing its final status.
update public.worker_runs
set quota_finalized = true
where status <> 'running'
  and quota_finalized = false;

-- Repair historical daily counters left by abandoned runs. Completed jobs plus
-- recorded failures are the attempted jobs for closed UTC days.
with failures as (
  select
    (created_at at time zone 'UTC')::date as usage_date,
    count(*) filter (where job_type = 'artist')::integer as artist_failures,
    count(*) filter (where job_type = 'playlist')::integer as playlist_failures,
    count(*) filter (where job_type = 'discovery')::integer as discovery_failures
  from public.job_errors
  group by 1
)
update public.daily_usage du
set artist_updates_reserved = du.artist_updates_completed + coalesce(f.artist_failures, 0),
    playlist_scans_reserved = du.playlist_scans_completed + coalesce(f.playlist_failures, 0),
    discovery_queries_reserved = du.discovery_queries_completed + coalesce(f.discovery_failures, 0),
    updated_at = now()
from failures f
where du.usage_date = f.usage_date
  and du.usage_date < current_date;

update public.daily_usage
set artist_updates_reserved = artist_updates_completed,
    playlist_scans_reserved = playlist_scans_completed,
    discovery_queries_reserved = discovery_queries_completed,
    updated_at = now()
where usage_date < current_date
  and not exists (
    select 1
    from public.job_errors e
    where (e.created_at at time zone 'UTC')::date = daily_usage.usage_date
  );

create or replace function public.reconcile_stale_worker_runs(
  p_stale_minutes integer default 20
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  repaired integer := 0;
  artist_success integer;
  playlist_success integer;
  discovery_success integer;
  artist_failures integer;
  playlist_failures integer;
  discovery_failures integer;
  artist_attempted integer;
  playlist_attempted integer;
  discovery_attempted integer;
  observation_end timestamptz;
begin
  -- A finished legacy run finalized quota immediately before saving its final
  -- status, even though the old schema could not record that fact.
  update public.worker_runs
  set quota_finalized = true
  where status <> 'running'
    and quota_finalized = false;

  for r in
    select *
    from public.worker_runs
    where status = 'running'
      and coalesce(last_heartbeat_at, started_at)
        < now() - make_interval(mins => greatest(15, p_stale_minutes))
    order by id
    for update skip locked
  loop
    observation_end := least(
      now(),
      coalesce(r.last_heartbeat_at, r.started_at) + interval '2 minutes'
    );

    select count(*)::integer
    into artist_success
    from public.monthly_listener_history h
    where h.collected_at >= r.started_at
      and h.collected_at <= observation_end;

    select count(*)::integer
    into playlist_success
    from public.playlists p
    where p.last_scanned_at >= r.started_at
      and p.last_scanned_at <= observation_end;

    select count(*)::integer
    into discovery_success
    from public.discovery_queries q
    where q.last_used_at >= r.started_at
      and q.last_used_at <= observation_end;

    select
      count(*) filter (where e.job_type = 'artist')::integer,
      count(*) filter (where e.job_type = 'playlist')::integer,
      count(*) filter (where e.job_type = 'discovery')::integer
    into artist_failures, playlist_failures, discovery_failures
    from public.job_errors e
    where e.run_token = r.run_token;

    artist_attempted := least(
      r.artist_updates_reserved,
      artist_success + coalesce(artist_failures, 0)
    );
    playlist_attempted := least(
      r.playlist_scans_reserved,
      playlist_success + coalesce(playlist_failures, 0)
    );
    discovery_attempted := least(
      r.discovery_queries_reserved,
      discovery_success + coalesce(discovery_failures, 0)
    );

    if not r.quota_finalized then
      insert into public.daily_usage(usage_date)
      values (r.usage_date)
      on conflict on constraint daily_usage_pkey do nothing;

      update public.daily_usage
      set artist_updates_reserved = greatest(
            0,
            artist_updates_reserved
              - greatest(0, r.artist_updates_reserved - artist_attempted)
          ),
          playlist_scans_reserved = greatest(
            0,
            playlist_scans_reserved
              - greatest(0, r.playlist_scans_reserved - playlist_attempted)
          ),
          discovery_queries_reserved = greatest(
            0,
            discovery_queries_reserved
              - greatest(0, r.discovery_queries_reserved - discovery_attempted)
          ),
          artist_updates_completed = artist_updates_completed + artist_success,
          playlist_scans_completed = playlist_scans_completed + playlist_success,
          discovery_queries_completed = discovery_queries_completed + discovery_success,
          updated_at = now()
      where usage_date = r.usage_date;
    end if;

    update public.worker_runs
    set status = 'failed',
        finished_at = greatest(started_at, coalesce(last_heartbeat_at, started_at)),
        duration_seconds = greatest(
          0,
          extract(epoch from (coalesce(last_heartbeat_at, started_at) - started_at))::integer
        ),
        artist_updates_completed = artist_success,
        playlist_scans_completed = playlist_success,
        discovery_queries_completed = discovery_success,
        failed_jobs = coalesce(artist_failures, 0)
          + coalesce(playlist_failures, 0)
          + coalesce(discovery_failures, 0),
        quota_finalized = true,
        notes = concat_ws(
          '; ',
          nullif(notes, ''),
          'auto-reconciled: worker heartbeat expired; unused quota released'
        )
    where id = r.id;

    repaired := repaired + 1;
  end loop;

  delete from public.worker_locks
  where locked_until < now();

  return repaired;
end;
$$;

revoke all on function public.reconcile_stale_worker_runs(integer)
  from public, anon, authenticated;
grant execute on function public.reconcile_stale_worker_runs(integer)
  to service_role;

-- Direct table access remains denied. Explicit deny policies document and
-- reinforce that model while public data is exposed only through bounded RPCs.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'artists',
    'monthly_listener_history',
    'playlists',
    'playlist_artists',
    'discovery_queries',
    'daily_usage',
    'worker_locks',
    'worker_runs',
    'job_errors',
    'site_artist_aliases'
  ]
  loop
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = 'deny_direct_access'
    ) then
      execute format(
        'create policy deny_direct_access on public.%I for all to anon, authenticated using (false) with check (false)',
        table_name
      );
    end if;
  end loop;
end;
$$;

-- Keep extensions outside the exposed public schema. Existing index OIDs remain
-- valid when a relocatable extension changes schema.
create schema if not exists extensions;

do $$
begin
  if exists (
    select 1
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pg_trgm'
      and n.nspname = 'public'
  ) then
    alter extension pg_trgm set schema extensions;
  end if;
end;
$$;

drop index if exists public.idx_site_artist_aliases_locale_search;

-- Harden explicit-null and very-large pagination calls made directly to RPC.
create or replace function public.public_artist_search(
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
language plpgsql
stable
security definer
set search_path = public, pg_temp
set statement_timeout = '2s'
as $$
declare
  raw_query text := trim(coalesce(p_query, ''));
  q text := public.site_search_key(raw_query);
  q_without_the text := public.site_search_key(
    regexp_replace(raw_query, '^the(?:[[:space:][:punct:]]+|$)', '', 'i')
  );
  safe_limit integer := greatest(1, least(coalesce(p_limit, 50), 100));
  safe_offset integer := greatest(0, least(coalesce(p_offset, 0), 999900));
begin
  if raw_query = '' then
    return query
    select
      a.id,
      a.spotify_id,
      a.name,
      a.spotify_url,
      a.image_url,
      a.monthly_listeners_latest,
      a.last_collected_at
    from public.artists a
    where a.discovery_status = 'active'
      and a.tracking_enabled = true
      and a.monthly_listeners_latest >= 10000
    order by a.monthly_listeners_latest desc nulls last, a.id
    limit safe_limit
    offset safe_offset;
    return;
  end if;

  if char_length(q) < 2 then
    return;
  end if;

  return query
  with candidates as (
    select a.id, 0 as match_rank
    from public.artists a
    where a.discovery_status = 'active'
      and a.tracking_enabled = true
      and a.monthly_listeners_latest >= 10000
      and (
        a.search_key = q
        or a.search_key_without_the = q
        or (q_without_the <> '' and (
          a.search_key = q_without_the
          or a.search_key_without_the = q_without_the
        ))
      )

    union all

    select a.id, 1
    from public.artists a
    where a.discovery_status = 'active'
      and a.tracking_enabled = true
      and a.monthly_listeners_latest >= 10000
      and (
        a.search_key like q || '%'
        or a.search_key_without_the like q || '%'
        or (q_without_the <> '' and (
          a.search_key like q_without_the || '%'
          or a.search_key_without_the like q_without_the || '%'
        ))
      )

    union all

    select s.artist_id, 2
    from public.site_artist_aliases s
    join public.artists a on a.id = s.artist_id
    where a.discovery_status = 'active'
      and a.tracking_enabled = true
      and a.monthly_listeners_latest >= 10000
      and (
        s.search_key = q
        or s.search_key_without_the = q
        or s.search_key like q || '%'
        or s.search_key_without_the like q || '%'
        or (q_without_the <> '' and (
          s.search_key = q_without_the
          or s.search_key_without_the = q_without_the
          or s.search_key like q_without_the || '%'
          or s.search_key_without_the like q_without_the || '%'
        ))
      )

    union all

    select a.id, 3
    from public.artists a
    where a.discovery_status = 'active'
      and a.tracking_enabled = true
      and a.monthly_listeners_latest >= 10000
      and (
        a.search_key like '%' || q || '%'
        or a.search_key_without_the like '%' || q || '%'
      )
  ),
  ranked as (
    select c.id, min(c.match_rank) as match_rank
    from candidates c
    group by c.id
  )
  select
    a.id,
    a.spotify_id,
    a.name,
    a.spotify_url,
    a.image_url,
    a.monthly_listeners_latest,
    a.last_collected_at
  from ranked r
  join public.artists a on a.id = r.id
  order by r.match_rank, a.monthly_listeners_latest desc nulls last, a.id
  limit safe_limit
  offset safe_offset;
end;
$$;

-- Seven-day values were removed from the site. Remove the unused backend fields
-- and their lateral history scans while preserving the 30-day API contract.
drop function if exists public.site_artist_search(text, integer, integer);

create function public.site_artist_search(
  p_query text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table(
  id bigint,
  spotify_id text,
  name text,
  spotify_url text,
  monthly_listeners bigint,
  last_collected_at timestamptz,
  change_30d bigint,
  peak bigint,
  low bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
set statement_timeout = '2s'
as $$
  with selected as (
    select p.id, p.spotify_id, p.name, p.spotify_url,
           p.monthly_listeners_latest, p.last_collected_at
    from public.public_artist_search(p_query, p_limit, p_offset) p
  )
  select
    a.id,
    a.spotify_id,
    a.name,
    a.spotify_url,
    a.monthly_listeners_latest::bigint,
    a.last_collected_at,
    case when h30.monthly_listeners is null then null
         else a.monthly_listeners_latest - h30.monthly_listeners end,
    stats.peak,
    stats.low
  from selected a
  left join lateral (
    select h.monthly_listeners
    from public.monthly_listener_history h
    where h.artist_id = a.id
      and h.collected_at between a.last_collected_at - interval '33 days'
                             and a.last_collected_at - interval '27 days'
    order by abs(extract(epoch from (
      h.collected_at - (a.last_collected_at - interval '30 days')
    )))
    limit 1
  ) h30 on true
  left join lateral (
    select max(h.monthly_listeners)::bigint as peak,
           min(h.monthly_listeners)::bigint as low
    from public.monthly_listener_history h
    where h.artist_id = a.id
  ) stats on true;
$$;

drop function if exists public.site_artist_detail(bigint);

create function public.site_artist_detail(p_artist_id bigint)
returns table(
  id bigint,
  spotify_id text,
  name text,
  spotify_url text,
  monthly_listeners bigint,
  last_collected_at timestamptz,
  change_30d bigint,
  peak bigint,
  low bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
set statement_timeout = '2s'
as $$
  with selected as (
    select a.*
    from public.artists a
    where a.id = p_artist_id
      and a.discovery_status = 'active'
      and a.tracking_enabled = true
      and a.monthly_listeners_latest >= 10000
  )
  select
    a.id,
    a.spotify_id,
    a.name,
    a.spotify_url,
    a.monthly_listeners_latest::bigint,
    a.last_collected_at,
    case when h30.monthly_listeners is null then null
         else a.monthly_listeners_latest - h30.monthly_listeners end,
    stats.peak,
    stats.low
  from selected a
  left join lateral (
    select h.monthly_listeners
    from public.monthly_listener_history h
    where h.artist_id = a.id
      and h.collected_at between a.last_collected_at - interval '33 days'
                             and a.last_collected_at - interval '27 days'
    order by abs(extract(epoch from (
      h.collected_at - (a.last_collected_at - interval '30 days')
    )))
    limit 1
  ) h30 on true
  left join lateral (
    select max(h.monthly_listeners)::bigint as peak,
           min(h.monthly_listeners)::bigint as low
    from public.monthly_listener_history h
    where h.artist_id = a.id
  ) stats on true;
$$;

alter function public.site_artist_history(bigint)
  set statement_timeout = '2s';
alter function public.site_artist_sitemap()
  set statement_timeout = '2s';
alter function public.site_rising_artists(integer)
  set statement_timeout = '2s';

revoke all on function public.public_artist_search(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.site_artist_search(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.site_artist_detail(bigint)
  from public, anon, authenticated;

grant execute on function public.public_artist_search(text, integer, integer)
  to anon, authenticated, service_role;
grant execute on function public.site_artist_search(text, integer, integer)
  to anon, authenticated, service_role;
grant execute on function public.site_artist_detail(bigint)
  to anon, authenticated, service_role;

commit;
