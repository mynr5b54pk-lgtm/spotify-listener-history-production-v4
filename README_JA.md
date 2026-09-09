# Spotify Listener History Production v4

Spotifyのアーティスト探索、プレイリスト巡回、月間リスナー収集、履歴保存、公開API、運用監視をまとめた本番用バックエンドです。

## 現在の運用方針

- 保存対象: 月間リスナー1万人以上のみ。1万人未満は履歴・アーティストとも保存しない
- 有効アーティスト: 成功から168時間（7日）後に再取得対象へ戻し、キュー待ちを含めて約7〜10.5日で一巡
- 履歴: 1アーティストにつきUTC日ごとに1点。同日中の再取得は最新値へ更新
- 急上昇: 約30日前と比較し、現在値が11日以内に取得された増加アーティストのみ表示
- 取得失敗: 指数バックオフで再試行。公開済みアーティストは一時的な失敗だけでは非公開にしない
- 異常値: 前回比1.5倍以上は再読み込みで確認してから保存
- プレイリスト: 新規候補を生むものを優先し、アクティブ枠は最大2,000件
- アーティスト名: SpotifyのOpen Graph metadataを正規名として優先
- 検索: 大文字小文字、空白、ハイフン、先頭のTheを吸収。完全一致・前方一致を優先し、1文字検索は無効
- 履歴API: 固定件数で打ち切らず、ページングして全履歴を取得

## GitHub Actions

| Worker | 起動予約 | 1回の上限 | 最大稼働 | ブラウザ並列 |
| --- | --- | --- | --- | --- |
| 有効アーティスト更新 | 6時間ごと | 5,000組 | 325分 | 14 |
| 候補アーティスト確認 | 6時間ごと | 5,000組 | 325分 | 12 |
| 新規探索 | 6時間ごと | プレイリスト100件・検索5件 | 90分 | 2 |
| 監視・復旧 | 3時間ごと | 8時間更新がなければ復旧判定 | 325分 | 14 |

同一Workerは重複実行しません。長時間処理中は次の予約が待機または省略されます。

## 現実的な安全上限

- アーティスト更新予約: 50,000件/日（異常時の安全上限。通常は到達しない）
- プレイリスト巡回: 400件/日
- Spotify検索: 20件/日
- 候補キュー抑制開始: 25,000件
- 抑制中のプレイリスト巡回: 1回30件

候補が増えすぎた場合は新規探索を自動で絞り、既存アーティスト更新と候補確認を優先します。

## Supabase SQL

新規環境では `sql/001_production_v4.sql` を適用後、番号順に追加SQLを適用してください。既存環境では未適用分だけを順番に適用します。

```text
sql/001_production_v4.sql
sql/002_public_security.sql
sql/003_artist_aliases.sql
sql/004_fix_artist_search.sql
sql/005_daily_listener_history.sql
sql/006_remove_hidden_collection_limits.sql
sql/007_second_audit_fixes.sql
sql/008_quota_accounting.sql
sql/009_artist_identity_integrity.sql
sql/010_search_performance.sql
sql/011_scalability_cleanup.sql
sql/012_micro_integrity_hardening.sql
sql/013_fix_reserve_run_quota_ambiguity.sql
sql/014_multilingual_search_aliases.sql
sql/015_worker_lifecycle_hardening.sql
sql/016_active_48_hour_cadence.sql
sql/017_operational_balance_and_security.sql
sql/018_stale_run_reconciliation.sql
sql/019_search_edge_cases.sql
sql/020_full_production_audit_fixes.sql
sql/021_store_only_10000_plus.sql
sql/022_playlist_priority_and_worker_split.sql
sql/023_worker_split_and_monitoring.sql
sql/024_correct_worker_run_labels.sql
sql/025_harden_public_read_api.sql
sql/026_require_fresh_current_value_for_rising_artists.sql
sql/027_align_public_sitemap_threshold.sql
sql/028_active_7_day_cadence.sql
sql/029_align_rising_freshness_with_weekly_cadence.sql
```

## ローカル実行

```bash
npm install
npm run install:browsers
npm test
npm run worker
npm start
```

公開API:

```text
GET /api/v1/artists?q=artist&page=1&limit=50
GET /api/v1/artists/:id
```

管理API:

```text
GET /api/admin/summary
x-admin-token: ADMIN_TOKEN
```

## 必須Secret

GitHub Actionsには `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`ADMIN_TOKEN` を登録します。秘密値はブラウザ側へ埋め込みません。

## 運用メモ

Spotify Web画面の変更やアクセス制限の影響を受けるため、`worker_runs` と `job_errors` で実行時間・失敗率・未処理件数を確認し、必要な場合だけ収集容量を調整します。
