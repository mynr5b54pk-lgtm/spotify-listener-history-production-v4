begin;

-- Save the public current value and its chart point atomically. A gateway
-- timeout can make the client retry after the first call committed, so the
-- same UTC day's history point is updated instead of duplicated.
create or replace function public.save_artist_observation(
  p_artist_id bigint,
  p_monthly_listeners bigint,
  p_collected_at timestamptz,
  p_next_collect_at timestamptz,
  p_canonical_name text default null
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_updated_rows integer;
begin
  if p_artist_id is null
     or p_monthly_listeners is null
     or p_monthly_listeners < 10000
     or p_collected_at is null
     or p_next_collect_at is null then
    raise exception 'invalid artist observation';
  end if;

  begin
    insert into public.monthly_listener_history (
      artist_id,
      monthly_listeners,
      collected_at
    ) values (
      p_artist_id,
      p_monthly_listeners,
      p_collected_at
    );
  exception when unique_violation then
    update public.monthly_listener_history
    set monthly_listeners = p_monthly_listeners,
        collected_at = p_collected_at
    where artist_id = p_artist_id
      and collected_at >= date_trunc('day', p_collected_at at time zone 'UTC') at time zone 'UTC'
      and collected_at < (date_trunc('day', p_collected_at at time zone 'UTC') + interval '1 day') at time zone 'UTC';

    get diagnostics v_updated_rows = row_count;
    if v_updated_rows <> 1 then
      raise exception 'daily artist observation conflict could not be resolved';
    end if;
  end;

  update public.artists
  set name = case
        when nullif(btrim(p_canonical_name), '') is not null then btrim(p_canonical_name)
        else name
      end,
      monthly_listeners_latest = p_monthly_listeners,
      last_collected_at = p_collected_at,
      next_collect_at = p_next_collect_at,
      tracking_enabled = true,
      discovery_status = 'active',
      failure_count = 0,
      last_error = null,
      updated_at = p_collected_at
  where id = p_artist_id;

  get diagnostics v_updated_rows = row_count;
  if v_updated_rows <> 1 then
    raise exception 'artist % does not exist', p_artist_id;
  end if;

  return true;
end;
$$;

revoke all on function public.save_artist_observation(bigint, bigint, timestamptz, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.save_artist_observation(bigint, bigint, timestamptz, timestamptz, text)
  to service_role;

commit;
