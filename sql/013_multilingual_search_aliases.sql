-- Search aliases are separate from the canonical Spotify artist name.
-- This lets every locale add familiar spellings/transliterations without
-- changing what the site displays as the artist's official name.

alter table public.site_artist_aliases
  add column if not exists locale text,
  add column if not exists alias_type text not null default 'alternate';

create index if not exists idx_site_artist_aliases_locale_search
  on public.site_artist_aliases (locale, search_key text_pattern_ops)
  where locale is not null;

-- Japanese kana normalization: hiragana queries and katakana aliases share
-- one search key. Existing Latin/Unicode normalization remains in
-- site_search_key; locale-specific aliases can be added for ko/zh/etc.
create or replace function public.site_search_key(input text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select regexp_replace(
    translate(
      lower(trim(coalesce(input, ''))),
      'ぁあぃいぅうぇえぉおかがきぎくぐけげこござさしじすずせぜそぞただちぢっつづてでとどなにぬねのはばぱひびぴふぶぷへべぺほぼぽまみむめもゃやゅゆょよらりるれろゎわをんゔ',
      'ァアィイゥウェエォオカガキギクグケゲコゴサザシジスズセゼソゾタダチヂッツヅテデトドナニヌネノハバパヒビピフブプヘベペホボポマミムメモャヤュユョヨラリルレロヮワヲンヴ'
    ),
    '[^[:alnum:]ぁ-んァ-ヶ一-龠가-힣]+', '', 'g'
  );
$$;

-- Recompute generated/search columns if they are trigger-maintained in the
-- current schema. Touching aliases also refreshes updated indexes safely.
update public.site_artist_aliases set alias = alias where alias is not null;
update public.artists set name = name where name is not null;

-- Seed a verified Japanese reading example without changing canonical name.
-- It becomes active automatically once Suicide Silence exists in artists.
insert into public.site_artist_aliases (artist_id, alias, locale, alias_type)
select id, 'スーサイドサイレンス', 'ja', 'transliteration'
from public.artists
where lower(name) = 'suicide silence'
on conflict (artist_id, alias) do update
set locale = excluded.locale, alias_type = excluded.alias_type;
