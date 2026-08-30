begin;

-- Keep an empty request as the ranking query, but do not turn punctuation-only
-- input into the ranking. Search terms must contain at least two normalized
-- letters or numbers.
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
as $$
declare
  raw_query text := trim(coalesce(p_query, ''));
  q text := public.site_search_key(raw_query);
  q_without_the text := public.site_search_key(
    regexp_replace(raw_query, '^the(?:[[:space:][:punct:]]+|$)', '', 'i')
  );
  safe_limit integer := greatest(1, least(p_limit, 100));
  safe_offset integer := greatest(0, p_offset);
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
      and a.monthly_listeners_latest is not null
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
      and a.monthly_listeners_latest is not null
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
      and a.monthly_listeners_latest is not null
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
      and a.monthly_listeners_latest is not null
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
      and a.monthly_listeners_latest is not null
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

-- The worker already preserves discovered name variants. Seed the well-known
-- abbreviation that cannot be derived from the full name automatically.
insert into public.site_artist_aliases (artist_id, alias)
select a.id, alias.value
from public.artists a
cross join (values
  ('BMTH'),
  ('Bring Me The Horizon'),
  ('Bring Me'),
  ('ブリングミー')
) as alias(value)
where a.spotify_id = '1Ffb6ejR6Fe5IamqA5oRUF'
on conflict do nothing;

commit;
