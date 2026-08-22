begin;

alter table public.artists
  add column if not exists search_key text
  generated always as (public.site_search_key(name)) stored;

alter table public.artists
  add column if not exists search_key_without_the text
  generated always as (
    public.site_search_key(regexp_replace(name, '^the(?:[[:space:][:punct:]]+|$)', '', 'i'))
  ) stored;

alter table public.site_artist_aliases
  add column if not exists search_key text
  generated always as (public.site_search_key(alias)) stored;

alter table public.site_artist_aliases
  add column if not exists search_key_without_the text
  generated always as (
    public.site_search_key(regexp_replace(alias, '^the(?:[[:space:][:punct:]]+|$)', '', 'i'))
  ) stored;

create index if not exists artists_search_key_trgm_idx
  on public.artists using gin(search_key gin_trgm_ops);
create index if not exists artists_search_key_without_the_trgm_idx
  on public.artists using gin(search_key_without_the gin_trgm_ops);
create index if not exists aliases_search_key_trgm_idx
  on public.site_artist_aliases using gin(search_key gin_trgm_ops);
create index if not exists aliases_search_key_without_the_trgm_idx
  on public.site_artist_aliases using gin(search_key_without_the gin_trgm_ops);

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
  q text := public.site_search_key(trim(coalesce(p_query, '')));
  q_without_the text := public.site_search_key(
    regexp_replace(trim(coalesce(p_query, '')), '^the(?:[[:space:][:punct:]]+|$)', '', 'i')
  );
  safe_limit integer := greatest(1, least(p_limit, 100));
  safe_offset integer := greatest(0, p_offset);
begin
  if q = '' then
    return query
      select a.id, a.spotify_id, a.name, a.spotify_url, a.image_url,
             a.monthly_listeners_latest, a.last_collected_at
      from public.artists a
      where a.discovery_status = 'active'
        and a.monthly_listeners_latest is not null
      order by a.monthly_listeners_latest desc nulls last, a.id
      limit safe_limit offset safe_offset;
    return;
  end if;

  -- Product requirement: one-character searches are intentionally disabled.
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
          a.search_key = q or a.search_key_without_the = q
          or (q_without_the <> '' and (a.search_key = q_without_the or a.search_key_without_the = q_without_the))
        )

      union all

      select a.id, 1
      from public.artists a
      where a.discovery_status = 'active'
        and a.monthly_listeners_latest is not null
        and (
          a.search_key like q || '%' or a.search_key_without_the like q || '%'
          or (q_without_the <> '' and (a.search_key like q_without_the || '%' or a.search_key_without_the like q_without_the || '%'))
        )

      union all

      select s.artist_id, 2
      from public.site_artist_aliases s
      join public.artists a on a.id = s.artist_id
      where a.discovery_status = 'active'
        and a.monthly_listeners_latest is not null
        and (
          s.search_key = q or s.search_key_without_the = q
          or s.search_key like q || '%' or s.search_key_without_the like q || '%'
          or (q_without_the <> '' and (
            s.search_key = q_without_the or s.search_key_without_the = q_without_the
            or s.search_key like q_without_the || '%' or s.search_key_without_the like q_without_the || '%'
          ))
        )

      union all

      select a.id, 3
      from public.artists a
      where a.discovery_status = 'active'
        and a.monthly_listeners_latest is not null
        and (a.search_key like '%' || q || '%' or a.search_key_without_the like '%' || q || '%')
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
$$;

revoke all on function public.public_artist_search(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.public_artist_search(text, integer, integer)
  to anon, authenticated, service_role;

commit;
