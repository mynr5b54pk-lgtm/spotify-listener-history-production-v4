begin;

alter table public.playlists
  add column if not exists successful_scans integer not null default 0,
  add column if not exists new_candidate_count integer not null default 0,
  add column if not exists last_yield_count integer not null default 0,
  add column if not exists consecutive_zero_yield integer not null default 0,
  add column if not exists priority_score integer not null default 0;

alter table public.playlists
  drop constraint if exists playlists_successful_scans_nonnegative,
  drop constraint if exists playlists_new_candidate_count_nonnegative,
  drop constraint if exists playlists_last_yield_count_nonnegative,
  drop constraint if exists playlists_consecutive_zero_yield_nonnegative,
  drop constraint if exists playlists_priority_score_nonnegative;
alter table public.playlists
  add constraint playlists_successful_scans_nonnegative check (successful_scans >= 0),
  add constraint playlists_new_candidate_count_nonnegative check (new_candidate_count >= 0),
  add constraint playlists_last_yield_count_nonnegative check (last_yield_count >= 0),
  add constraint playlists_consecutive_zero_yield_nonnegative check (consecutive_zero_yield >= 0),
  add constraint playlists_priority_score_nonnegative check (priority_score >= 0);

update public.playlists
set successful_scans = greatest(successful_scans, case when last_scanned_at is null then 0 else 1 end),
    priority_score = greatest(priority_score,
      case
        when lower(coalesce(name, '') || ' ' || coalesce(source_query, '')) ~ '(this is|公式|official)' then 300
        when lower(coalesce(name, '') || ' ' || coalesce(source_query, '')) ~ '(top|viral|new music|急上昇|ヒット)' then 200
        when last_scanned_at is not null then 50
        else 0
      end);

with ranked as (
  select id,
         row_number() over (
           order by priority_score desc, last_scanned_at desc nulls last, id asc
         ) as position
  from public.playlists
  where scan_status = 'active'
)
update public.playlists p
set scan_status = 'paused',
    next_scan_at = now() + interval '90 days',
    updated_at = now()
from ranked r
where p.id = r.id and r.position > 1500;

update public.playlists
set scan_status = 'paused',
    next_scan_at = now() + interval '90 days',
    updated_at = now()
where scan_status = 'error' and failure_count >= 3;

drop index if exists public.playlists_priority_due_idx;
create index playlists_priority_due_idx
  on public.playlists(scan_status, priority_score desc, next_scan_at, id)
  where scan_status in ('pending', 'active', 'error');

create or replace function public.record_playlist_scan(
  p_playlist_id bigint,
  p_new_candidate_count integer,
  p_rescan_days integer,
  p_max_active integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_row public.playlists%rowtype;
  worst_row public.playlists%rowtype;
  next_status text;
  next_at timestamptz;
  next_score integer;
  zero_streak integer;
  active_count integer;
  yield_count integer := greatest(0, coalesce(p_new_candidate_count, 0));
begin
  select * into current_row
  from public.playlists
  where id = p_playlist_id
  for update;

  if not found then
    raise exception 'playlist % not found', p_playlist_id;
  end if;

  if yield_count = 0 then
    zero_streak := current_row.consecutive_zero_yield + 1;
    next_score := greatest(0, floor(current_row.priority_score * 0.70)::integer);
    if zero_streak >= 2 then
      next_status := 'paused';
      next_at := now() + interval '90 days';
    else
      next_status := 'pending';
      next_at := now() + interval '30 days';
    end if;
  else
    zero_streak := 0;
    next_score := least(100000,
      floor(current_row.priority_score * 0.80)::integer + yield_count * 100);
    next_status := 'active';
    next_at := now() + make_interval(days => greatest(1, p_rescan_days));

    if current_row.scan_status <> 'active' then
      select count(*)::integer into active_count
      from public.playlists
      where scan_status = 'active' and id <> p_playlist_id;

      if active_count >= greatest(100, p_max_active) then
        select * into worst_row
        from public.playlists
        where scan_status = 'active' and id <> p_playlist_id
        order by priority_score asc, last_yield_count asc, last_scanned_at asc nulls first, id desc
        for update skip locked
        limit 1;

        if worst_row.id is not null and worst_row.priority_score < next_score then
          update public.playlists
          set scan_status = 'paused',
              next_scan_at = now() + interval '90 days',
              updated_at = now()
          where id = worst_row.id;
        else
          next_status := 'paused';
          next_at := now() + interval '90 days';
        end if;
      end if;
    end if;
  end if;

  update public.playlists
  set scan_status = next_status,
      successful_scans = successful_scans + 1,
      new_candidate_count = new_candidate_count + yield_count,
      last_yield_count = yield_count,
      consecutive_zero_yield = zero_streak,
      priority_score = next_score,
      last_scanned_at = now(),
      next_scan_at = next_at,
      failure_count = 0,
      last_error = null,
      updated_at = now()
  where id = p_playlist_id;
end;
$$;

revoke all on function public.record_playlist_scan(bigint, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.record_playlist_scan(bigint, integer, integer, integer)
  to service_role;

commit;
