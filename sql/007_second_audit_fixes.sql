begin;

-- Restore previously successful artists that were temporarily hidden by the
-- old failure handler. A scrape error should not erase the last good public state.
update public.artists
set discovery_status = case
      when monthly_listeners_latest >= 10000 then 'active'
      else 'below_threshold'
    end,
    tracking_enabled = true,
    updated_at = now()
where discovery_status = 'error'
  and last_collected_at is not null
  and monthly_listeners_latest is not null;

-- Keep search normalization in one place. This makes spaces, hyphens and most
-- punctuation insignificant and also allows a leading "The" to be omitted.
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
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with params as (
    select
      public.site_search_key(trim(coalesce(p_query, ''))) as q,
      public.site_search_key(
        regexp_replace(trim(coalesce(p_query, '')), '^the(?:[[:space:][:punct:]]+|$)', '', 'i')
      ) as q_without_the
  ),
  eligible as (
    select
      a.*,
      public.site_search_key(a.name) as name_key,
      public.site_search_key(
        regexp_replace(a.name, '^the(?:[[:space:][:punct:]]+|$)', '', 'i')
      ) as name_without_the_key
    from public.artists a
    where a.discovery_status = 'active'
      and a.monthly_listeners_latest is not null
  ),
  matched as (
    select e.*,
      case
        when p.q = '' then 4
        when e.name_key = p.q or e.name_without_the_key = p.q or (p.q_without_the <> '' and (e.name_key = p.q_without_the or e.name_without_the_key = p.q_without_the)) then 0
        when e.name_key like p.q || '%' or e.name_without_the_key like p.q || '%' or (p.q_without_the <> '' and (e.name_key like p.q_without_the || '%' or e.name_without_the_key like p.q_without_the || '%')) then 1
        when exists (
          select 1 from public.site_artist_aliases saa
          where saa.artist_id = e.id
            and (
              public.site_search_key(saa.alias) = p.q
              or public.site_search_key(regexp_replace(saa.alias, '^the(?:[[:space:][:punct:]]+|$)', '', 'i')) = p.q
              or public.site_search_key(saa.alias) like p.q || '%'
              or public.site_search_key(regexp_replace(saa.alias, '^the(?:[[:space:][:punct:]]+|$)', '', 'i')) like p.q || '%'
            )
        ) then 2
        when e.name_key like '%' || p.q || '%' or e.name_without_the_key like '%' || p.q || '%' then 3
        else 9
      end as match_rank
    from eligible e
    cross join params p
  )
  select
    m.id,
    m.spotify_id,
    m.name,
    m.spotify_url,
    m.image_url,
    m.monthly_listeners_latest,
    m.last_collected_at
  from matched m
  where m.match_rank < 9
  order by m.match_rank, m.monthly_listeners_latest desc nulls last, m.id
  limit greatest(1, least(p_limit, 100))
  offset greatest(0, p_offset);
$$;

revoke all on function public.public_artist_search(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.public_artist_search(text, integer, integer)
  to anon, authenticated, service_role;

commit;
