begin;

create extension if not exists pg_trgm;

create index if not exists site_artist_aliases_alias_trgm_idx
  on public.site_artist_aliases using gin(lower(alias) gin_trgm_ops);

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
  with normalized as (
    select nullif(
      lower(
        regexp_replace(
          translate(coalesce(p_query, ''), chr(8203) || chr(8204) || chr(8205) || chr(65279), ''),
          '[[:space:]]+',
          ' ',
          'g'
        )
      ),
      ''
    ) as q
  )
  select
    a.id,
    a.spotify_id,
    a.name,
    a.spotify_url,
    a.image_url,
    a.monthly_listeners_latest,
    a.last_collected_at
  from public.artists a
  cross join normalized n
  where a.discovery_status = 'active'
    and (
      n.q is null
      or lower(
        regexp_replace(
          translate(a.name, chr(8203) || chr(8204) || chr(8205) || chr(65279), ''),
          '[[:space:]]+',
          ' ',
          'g'
        )
      ) like '%' || n.q || '%'
      or exists (
        select 1
        from public.site_artist_aliases saa
        where saa.artist_id = a.id
          and lower(
            regexp_replace(
              translate(saa.alias, chr(8203) || chr(8204) || chr(8205) || chr(65279), ''),
              '[[:space:]]+',
              ' ',
              'g'
            )
          ) like '%' || n.q || '%'
      )
    )
  order by
    case
      when n.q is not null and lower(
        regexp_replace(
          translate(a.name, chr(8203) || chr(8204) || chr(8205) || chr(65279), ''),
          '[[:space:]]+',
          ' ',
          'g'
        )
      ) = n.q then 0
      when n.q is not null and lower(
        regexp_replace(
          translate(a.name, chr(8203) || chr(8204) || chr(8205) || chr(65279), ''),
          '[[:space:]]+',
          ' ',
          'g'
        )
      ) like n.q || '%' then 1
      else 2
    end,
    a.monthly_listeners_latest desc nulls last,
    a.id
  limit greatest(1, least(p_limit, 100))
  offset greatest(0, p_offset);
$$;

revoke all on function public.public_artist_search(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.public_artist_search(text, integer, integer)
  to anon, authenticated, service_role;

commit;
