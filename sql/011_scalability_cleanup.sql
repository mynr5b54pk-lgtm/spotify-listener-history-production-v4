begin;

alter table public.site_artist_aliases
  add column if not exists created_at timestamptz not null default now();

create index if not exists playlists_next_scan_due_idx
  on public.playlists(next_scan_at, id)
  where scan_status in ('pending','active','error');

create index if not exists artists_active_latest_idx
  on public.artists(monthly_listeners_latest desc, id)
  where discovery_status = 'active' and monthly_listeners_latest is not null;

create or replace function public.site_artist_search(
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
  change_7d bigint,
  change_30d bigint,
  peak bigint,
  low bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
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
    case when h7.monthly_listeners is null then null
         else a.monthly_listeners_latest - h7.monthly_listeners end,
    case when h30.monthly_listeners is null then null
         else a.monthly_listeners_latest - h30.monthly_listeners end,
    stats.peak,
    stats.low
  from selected a
  left join lateral (
    select h.monthly_listeners
    from public.monthly_listener_history h
    where h.artist_id = a.id
      and h.collected_at between a.last_collected_at - interval '8 days'
                             and a.last_collected_at - interval '6 days'
    order by abs(extract(epoch from (h.collected_at - (a.last_collected_at - interval '7 days'))))
    limit 1
  ) h7 on true
  left join lateral (
    select h.monthly_listeners
    from public.monthly_listener_history h
    where h.artist_id = a.id
      and h.collected_at between a.last_collected_at - interval '33 days'
                             and a.last_collected_at - interval '27 days'
    order by abs(extract(epoch from (h.collected_at - (a.last_collected_at - interval '30 days'))))
    limit 1
  ) h30 on true
  left join lateral (
    select max(h.monthly_listeners)::bigint as peak,
           min(h.monthly_listeners)::bigint as low
    from public.monthly_listener_history h
    where h.artist_id = a.id
  ) stats on true;
$$;

commit;
