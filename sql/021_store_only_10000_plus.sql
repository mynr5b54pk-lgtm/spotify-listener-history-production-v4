begin;

delete from public.monthly_listener_history
where monthly_listeners < 10000;

delete from public.artists
where discovery_status = 'below_threshold'
   or (monthly_listeners_latest is not null and monthly_listeners_latest < 10000);

alter table public.monthly_listener_history
  drop constraint if exists monthly_listener_history_min_10000;
alter table public.monthly_listener_history
  add constraint monthly_listener_history_min_10000
  check (monthly_listeners >= 10000);

alter table public.artists
  drop constraint if exists artists_known_listener_min_10000;
alter table public.artists
  add constraint artists_known_listener_min_10000
  check (monthly_listeners_latest is null or monthly_listeners_latest >= 10000);

alter table public.artists
  drop constraint if exists artists_no_below_threshold_status;
alter table public.artists
  add constraint artists_no_below_threshold_status
  check (discovery_status <> 'below_threshold');

create or replace function public.delete_artist_on_low_listener_observation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.monthly_listeners < 10000 then
    delete from public.artists where id = new.artist_id;
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists delete_artist_on_low_listener_observation
  on public.monthly_listener_history;
create trigger delete_artist_on_low_listener_observation
before insert or update on public.monthly_listener_history
for each row execute function public.delete_artist_on_low_listener_observation();

revoke all on function public.delete_artist_on_low_listener_observation() from public, anon, authenticated;

commit;
