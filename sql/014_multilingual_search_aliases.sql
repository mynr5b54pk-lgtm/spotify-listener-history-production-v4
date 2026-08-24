begin;

alter table public.site_artist_aliases
  add column if not exists locale text,
  add column if not exists alias_type text not null default 'alternate';

create or replace function public.site_search_key(value text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select regexp_replace(
    translate(
      lower(trim(coalesce(value, ''))),
      'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽぁぃぅぇぉっゃゅょゎゔ',
      'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポァィゥェォッャュョヮヴ'
    ),
    '[^[:alnum:]ぁ-んァ-ヶ一-龠가-힣]+', '', 'g'
  );
$$;

create index if not exists idx_site_artist_aliases_locale_search
  on public.site_artist_aliases (locale, search_key text_pattern_ops)
  where locale is not null;

-- Keep canonical display names separate from localized search spellings.
insert into public.site_artist_aliases (artist_id, alias, locale, alias_type)
select id, 'スーサイド・サイレンス', 'ja', 'localized'
from public.artists where spotify_id = '6HZr7Fs2VfV1PYHIwo8Ylc'
on conflict (artist_id, alias) do update
set locale=excluded.locale, alias_type=excluded.alias_type;

insert into public.site_artist_aliases (artist_id, alias, locale, alias_type)
select id, 'スーサイドサイレンス', 'ja', 'transliteration'
from public.artists where spotify_id = '6HZr7Fs2VfV1PYHIwo8Ylc'
on conflict (artist_id, alias) do update
set locale=excluded.locale, alias_type=excluded.alias_type;

insert into public.site_artist_aliases (artist_id, alias, locale, alias_type)
select id, 'パレダスク', 'ja', 'transliteration'
from public.artists where lower(name)='paledusk'
on conflict (artist_id, alias) do update
set locale=excluded.locale, alias_type=excluded.alias_type;

commit;
