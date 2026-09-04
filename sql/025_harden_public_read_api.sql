begin;

-- Public site reads run with the caller's limited privileges. RLS exposes only
-- active artists at or above the 10,000-listener threshold.
alter table public.artists enable row level security;
alter table public.monthly_listener_history enable row level security;
alter table public.site_artist_aliases enable row level security;

drop policy if exists deny_direct_access on public.artists;
drop policy if exists deny_direct_access on public.monthly_listener_history;
drop policy if exists deny_direct_access on public.site_artist_aliases;
drop policy if exists site_read_active_artists on public.artists;
drop policy if exists site_read_active_history on public.monthly_listener_history;
drop policy if exists site_read_active_aliases on public.site_artist_aliases;

create policy site_read_active_artists
on public.artists for select to anon
using (
  tracking_enabled = true
  and discovery_status = 'active'
  and monthly_listeners_latest >= 10000
);

create policy site_read_active_history
on public.monthly_listener_history for select to anon
using (
  exists (
    select 1 from public.artists a
    where a.id = monthly_listener_history.artist_id
      and a.tracking_enabled = true
      and a.discovery_status = 'active'
      and a.monthly_listeners_latest >= 10000
  )
);

create policy site_read_active_aliases
on public.site_artist_aliases for select to anon
using (
  exists (
    select 1 from public.artists a
    where a.id = site_artist_aliases.artist_id
      and a.tracking_enabled = true
      and a.discovery_status = 'active'
      and a.monthly_listeners_latest >= 10000
  )
);

revoke all on table public.artists from public, anon, authenticated;
revoke all on table public.monthly_listener_history from public, anon, authenticated;
revoke all on table public.site_artist_aliases from public, anon, authenticated;

grant select (
  id, spotify_id, name, spotify_url, image_url,
  tracking_enabled, discovery_status, monthly_listeners_latest,
  last_collected_at, search_key, search_key_without_the
) on public.artists to anon;
grant select (artist_id, monthly_listeners, collected_at)
  on public.monthly_listener_history to anon;
grant select (artist_id, search_key, search_key_without_the)
  on public.site_artist_aliases to anon;

-- Avoid selecting internal artist columns through a.* when called as anon.
create or replace function public.site_artist_detail(p_artist_id bigint)
returns table (
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
security invoker
set search_path = public, pg_temp
set statement_timeout = '2s'
as $$
  with selected as (
    select
      a.id, a.spotify_id, a.name, a.spotify_url,
      a.monthly_listeners_latest, a.last_collected_at
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

alter function public.public_artist_search(text, integer, integer) security invoker;
alter function public.site_artist_search(text, integer, integer) security invoker;
alter function public.site_artist_history(bigint) security invoker;
alter function public.site_artist_sitemap() security invoker;
alter function public.site_rising_artists(integer) security invoker;

revoke all on function public.site_search_key(text) from public, anon, authenticated;
revoke all on function public.public_artist_search(text, integer, integer) from public, anon, authenticated;
revoke all on function public.site_artist_search(text, integer, integer) from public, anon, authenticated;
revoke all on function public.site_artist_detail(bigint) from public, anon, authenticated;
revoke all on function public.site_artist_history(bigint) from public, anon, authenticated;
revoke all on function public.site_artist_sitemap() from public, anon, authenticated;
revoke all on function public.site_rising_artists(integer) from public, anon, authenticated;

grant execute on function public.site_search_key(text) to anon, service_role;
grant execute on function public.public_artist_search(text, integer, integer) to anon, service_role;
grant execute on function public.site_artist_search(text, integer, integer) to anon, service_role;
grant execute on function public.site_artist_detail(bigint) to anon, service_role;
grant execute on function public.site_artist_history(bigint) to anon, service_role;
grant execute on function public.site_artist_sitemap() to anon, service_role;
grant execute on function public.site_rising_artists(integer) to anon, service_role;

commit;
