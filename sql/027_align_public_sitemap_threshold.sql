create or replace function public.site_artist_sitemap()
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
set statement_timeout to '2s'
as $function$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'last_collected_at', a.last_collected_at
      )
      order by a.id
    ),
    '[]'::jsonb
  )
  from public.artists a
  where a.discovery_status = 'active'
    and a.tracking_enabled = true
    and a.monthly_listeners_latest >= 10000;
$function$;
