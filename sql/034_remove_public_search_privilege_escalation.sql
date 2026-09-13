begin;

-- Public artist rows and aliases are already filtered by read-only RLS
-- policies. Let the search RPC run with the caller's privileges instead of
-- elevating anonymous requests to the function owner's privileges.
grant select (alias) on public.site_artist_aliases to anon;

alter function public.public_artist_search(text, integer, integer)
  security invoker;

commit;
