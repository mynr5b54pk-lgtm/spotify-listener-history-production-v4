begin;

-- 同一アーティストの履歴を「月1件」から「1日1件」へ変更。
-- 週1回更新でも各回の履歴が保存される。
drop index if exists listener_history_artist_minute_unique;
drop index if exists listener_history_artist_day_unique;
create unique index listener_history_artist_day_unique
  on monthly_listener_history(
    artist_id,
    date_trunc('day', collected_at AT TIME ZONE 'UTC')
  );

commit;
