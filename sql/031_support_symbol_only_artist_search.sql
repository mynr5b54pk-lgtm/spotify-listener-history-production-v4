begin;

-- Preserve the two-character minimum while allowing real artist names made
-- entirely from symbols (for example "!!!" or "¥$") to be found by name.
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

  if char_length(q) < 2 and char_length(raw_query) < 2 then return; end if;

  if q = '' then
    return query
    with symbol_candidates as (
      select a.id,
             case when lower(a.name) = lower(raw_query) then 0 else 1 end as match_rank
      from public.artists a
      where a.discovery_status = 'active'
        and a.tracking_enabled = true
        and a.monthly_listeners_latest >= 10000
        and left(lower(a.name), char_length(raw_query)) = lower(raw_query)

      union all

      select s.artist_id,
             case when lower(s.alias) = lower(raw_query) then 0 else 2 end
      from public.site_artist_aliases s
      join public.artists a on a.id = s.artist_id
      where a.discovery_status = 'active'
        and a.tracking_enabled = true
        and a.monthly_listeners_latest >= 10000
        and left(lower(s.alias), char_length(raw_query)) = lower(raw_query)
    ), symbol_ranked as (
      select c.id, min(c.match_rank) as match_rank
      from symbol_candidates c
      group by c.id
    )
    select a.id, a.spotify_id, a.name, a.spotify_url, a.image_url,
           a.monthly_listeners_latest, a.last_collected_at
    from symbol_ranked r
    join public.artists a on a.id = r.id
    order by r.match_rank, a.monthly_listeners_latest desc nulls last, a.id
    limit safe_limit offset safe_offset;
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

revoke all on function public.public_artist_search(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.public_artist_search(text, integer, integer)
  to anon, service_role;

commit;
