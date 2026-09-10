begin;

-- Keep a minimal, durable deny-list so artists observed below the public
-- threshold are not rediscovered and checked again on every playlist scan.
create table if not exists public.excluded_spotify_artists (
  spotify_id text primary key,
  excluded_at timestamptz not null default now()
);

alter table public.excluded_spotify_artists enable row level security;
drop policy if exists "service role manages excluded artists"
  on public.excluded_spotify_artists;
create policy "service role manages excluded artists"
  on public.excluded_spotify_artists
  for all
  to service_role
  using (true)
  with check (true);
revoke all on table public.excluded_spotify_artists from public, anon, authenticated;
grant select, insert, update, delete on table public.excluded_spotify_artists to service_role;

drop trigger if exists delete_artist_on_low_listener_observation
  on public.monthly_listener_history;

-- Search is exact or prefix based. Spaces, punctuation, hyphens, leading "the"
-- and stored multilingual aliases are normalized by site_search_key.
create or replace function public.public_artist_search(
  p_query text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table(
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
set search_path = public, pg_temp
set statement_timeout = '2s'
as $function$
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
    select a.id, a.spotify_id, a.name, a.spotify_url, a.image_url,
           a.monthly_listeners_latest, a.last_collected_at
    from public.artists a
    where a.discovery_status = 'active'
      and a.tracking_enabled = true
      and a.monthly_listeners_latest >= 10000
    order by a.monthly_listeners_latest desc nulls last, a.id
    limit safe_limit offset safe_offset;
    return;
  end if;

  if char_length(q) < 2 then return; end if;

  return query
  with candidates as (
    select a.id, 0 as match_rank
    from public.artists a
    where a.discovery_status = 'active'
      and a.tracking_enabled = true
      and a.monthly_listeners_latest >= 10000
      and (
        a.search_key = q or a.search_key_without_the = q
        or (q_without_the <> '' and (
          a.search_key = q_without_the or a.search_key_without_the = q_without_the
        ))
      )

    union all

    select a.id, 1
    from public.artists a
    where a.discovery_status = 'active'
      and a.tracking_enabled = true
      and a.monthly_listeners_latest >= 10000
      and (
        a.search_key like q || '%' or a.search_key_without_the like q || '%'
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
        s.search_key = q or s.search_key_without_the = q
        or s.search_key like q || '%' or s.search_key_without_the like q || '%'
        or (q_without_the <> '' and (
          s.search_key = q_without_the or s.search_key_without_the = q_without_the
          or s.search_key like q_without_the || '%'
          or s.search_key_without_the like q_without_the || '%'
        ))
      )
  ), ranked as (
    select c.id, min(c.match_rank) as match_rank
    from candidates c
    group by c.id
  )
  select a.id, a.spotify_id, a.name, a.spotify_url, a.image_url,
         a.monthly_listeners_latest, a.last_collected_at
  from ranked r
  join public.artists a on a.id = r.id
  order by r.match_rank, a.monthly_listeners_latest desc nulls last, a.id
  limit safe_limit offset safe_offset;
end;
$function$;

drop function if exists public.site_rising_artists(integer);
create function public.site_rising_artists(p_limit integer default 4)
returns table(
  id bigint,
  name text,
  monthly_listeners bigint,
  change_30d bigint,
  change_period bigint,
  growth_rate numeric,
  period_days integer
)
language sql
stable
set search_path to ''
set statement_timeout to '2s'
as $function$
  with measured as (
    select
      a.id,
      a.name,
      a.monthly_listeners_latest,
      coalesce(h30.monthly_listeners, h7.monthly_listeners) as baseline,
      case when h30.monthly_listeners is not null then 30 else 7 end as period_days
    from public.artists a
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
      select h.monthly_listeners
      from public.monthly_listener_history h
      where h.artist_id = a.id
        and h.collected_at between a.last_collected_at - interval '10 days'
                               and a.last_collected_at - interval '4 days'
      order by abs(extract(epoch from (
        h.collected_at - (a.last_collected_at - interval '7 days')
      )))
      limit 1
    ) h7 on h30.monthly_listeners is null
    where a.discovery_status = 'active'
      and a.tracking_enabled = true
      and a.monthly_listeners_latest >= 10000
      and a.last_collected_at >= now() - interval '11 days'
  )
  select
    m.id,
    m.name,
    m.monthly_listeners_latest::bigint,
    (m.monthly_listeners_latest - m.baseline)::bigint,
    (m.monthly_listeners_latest - m.baseline)::bigint,
    round(
      (m.monthly_listeners_latest::numeric - m.baseline) / m.baseline * 100,
      2
    ),
    m.period_days
  from measured m
  where m.baseline > 0
    and m.monthly_listeners_latest > m.baseline
  order by
    (m.monthly_listeners_latest::numeric - m.baseline) / m.baseline desc,
    m.monthly_listeners_latest desc
  limit least(greatest(coalesce(p_limit, 4), 1), 50);
$function$;

create or replace function public.site_artist_sitemap_count()
returns bigint
language sql
stable
set search_path = public, pg_temp
set statement_timeout = '2s'
as $function$
  select count(*)::bigint
  from public.artists a
  where a.discovery_status = 'active'
    and a.tracking_enabled = true
    and a.monthly_listeners_latest >= 10000;
$function$;

create or replace function public.site_artist_sitemap_page(
  p_limit integer default 45000,
  p_offset integer default 0
)
returns table(id bigint, last_collected_at timestamptz)
language sql
stable
set search_path = public, pg_temp
set statement_timeout = '2s'
as $function$
  select a.id, a.last_collected_at
  from public.artists a
  where a.discovery_status = 'active'
    and a.tracking_enabled = true
    and a.monthly_listeners_latest >= 10000
  order by a.id
  limit least(greatest(coalesce(p_limit, 45000), 1), 45000)
  offset greatest(coalesce(p_offset, 0), 0);
$function$;

revoke all on function public.site_rising_artists(integer) from public, anon, authenticated;
revoke all on function public.site_artist_sitemap_count() from public, anon, authenticated;
revoke all on function public.site_artist_sitemap_page(integer, integer) from public, anon, authenticated;
grant execute on function public.site_rising_artists(integer) to anon, service_role;
grant execute on function public.site_artist_sitemap_count() to anon, service_role;
grant execute on function public.site_artist_sitemap_page(integer, integer) to anon, service_role;

commit;
