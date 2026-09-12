begin;

-- The public RPC needs to read the private alias table without granting that
-- table directly to anonymous clients. Its fixed search_path and read-only
-- body keep the elevated execution narrowly scoped.
alter function public.public_artist_search(text, integer, integer)
  security definer;

revoke all on function public.public_artist_search(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.public_artist_search(text, integer, integer)
  to anon, service_role;

commit;
