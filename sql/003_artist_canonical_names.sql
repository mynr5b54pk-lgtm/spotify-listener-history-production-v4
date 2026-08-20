begin;
create table if not exists public.site_artist_aliases (
  artist_id bigint not null references public.artists(id) on delete cascade,
  alias text not null,
  created_at timestamptz not null default now(),
  primary key (artist_id, alias)
);
revoke all on table public.site_artist_aliases from anon, authenticated;
grant select, insert, update on table public.site_artist_aliases to service_role;
insert into public.site_artist_aliases (artist_id, alias)
select id, name from public.artists where nullif(trim(name), '') is not null
on conflict do nothing;
commit;
