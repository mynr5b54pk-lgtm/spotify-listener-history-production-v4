create or replace function public.site_rising_artists(p_limit integer default 4)
returns table(id bigint, name text, monthly_listeners bigint, change_30d bigint, growth_rate numeric)
language sql
stable
set search_path to ''
set statement_timeout to '2s'
as $function$
  select
    a.id,
    a.name,
    a.monthly_listeners_latest::bigint as monthly_listeners,
    (a.monthly_listeners_latest - h30.monthly_listeners)::bigint as change_30d,
    round(
      (a.monthly_listeners_latest::numeric - h30.monthly_listeners)
      / h30.monthly_listeners * 100,
      2
    ) as growth_rate
  from public.artists a
  join lateral (
    select h.monthly_listeners
    from public.monthly_listener_history h
    where h.artist_id = a.id
      and h.collected_at between
        a.last_collected_at - interval '33 days'
        and a.last_collected_at - interval '27 days'
    order by abs(extract(epoch from (
      h.collected_at - (a.last_collected_at - interval '30 days')
    )))
    limit 1
  ) h30 on true
  where a.discovery_status = 'active'
    and a.tracking_enabled = true
    and a.monthly_listeners_latest >= 10000
    and a.last_collected_at >= now() - interval '48 hours'
    and h30.monthly_listeners > 0
    and a.monthly_listeners_latest > h30.monthly_listeners
  order by
    (a.monthly_listeners_latest::numeric - h30.monthly_listeners)
      / h30.monthly_listeners desc,
    a.monthly_listeners_latest desc
  limit least(greatest(coalesce(p_limit, 4), 1), 50);
$function$;
