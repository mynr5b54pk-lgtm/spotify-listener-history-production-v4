begin;

create table if not exists public.site_artist_aliases (
  artist_id bigint not null references public.artists(id) on delete cascade,
  alias text not null,
  created_at timestamptz not null default now(),
  primary key (artist_id, alias)
);

create index if not exists site_artist_aliases_lower_idx
  on public.site_artist_aliases (lower(alias));

alter table public.site_artist_aliases enable row level security;

revoke all on table public.site_artist_aliases from anon, authenticated;

insert into public.site_artist_aliases (artist_id, alias)
select id, name
from public.artists
where nullif(btrim(name), '') is not null
on conflict (artist_id, alias) do nothing;

commit;
