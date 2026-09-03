# Spotify Listener History Production v4

Spotifyのアーティスト探索、プレイリスト巡回、月間リスナー収集、履歴保存、公開API、運用監視をまとめた本番用バックエンドです。

## 現在の本番仕様

- GitHub Actions: 毎時起動を予約し、同一Workerは直列実行
- アクティブアーティスト: 実処理能力に合わせて原則120時間（5日）後に再取得対象へ戻し、全体を約5〜6日で一巡
- 保存対象: 月間リスナー1万人以上のみ。1万人未満は履歴・アーティストとも保存しない
- 履歴: 1アーティストにつきUTC日ごとに1点。1日に複数回成功した場合はその日の最新値へ更新
- 収集分離: 既存1万人以上は325分Workerで直接アーティストページを更新し、新規探索は6時間ごとの専用Workerで処理
- 新規探索: 22検索語 → プレイリスト最大150件 → 候補最大250件を検証
- 取得失敗: 指数バックオフで再試行。既に公開済みのアーティストは一時的な取得失敗だけでは公開状態から外さない
- 異常値: 前回比1.5倍以上の変化は再読み込みで一致確認してから保存
- プレイリスト: 新規候補を生むものを優先し、アクティブ枠を最大2,000件に制限。成果なし2回または取得失敗3回で90日停止
- アーティスト名: Spotify Open Graph metadataを正規名として優先。プレイリスト上のリンク文字列は、正常取得済みアーティストの正規名を上書きしない
- 誤取得対策: 確認済みのSpotify UIラベル `Your Library` は正規名・別名として保存しない
- アーティスト履歴API: 1000件・365件の固定打ち切りなし。ページングして全履歴を取得
- 検索: 大文字小文字、空白、ハイフンなどの句読点差を吸収し、先頭の `The` 省略にも対応。完全一致・前方一致を優先。1文字検索は無効

## 現在の本番上限

GitHub Actionsの1回あたり設定:

- アーティスト更新: 2,500件
- プレイリスト巡回: 0件（探索Workerへ分離）
- Spotify検索: 0検索語（探索Workerへ分離）
- 候補検証: 0件（探索Workerへ分離）
- 最大稼働: 325分
- ブラウザ同時実行: 10

1日あたりの安全上限:

- アーティスト更新予約: 50,000件
- プレイリスト巡回: 800件
- Spotify検索: 160検索語

アーティスト側の50,000件/日は、毎時予約・直列実行・2,500件/回でも通常到達しない安全上限です。異常終了時の未使用予約は次回監視で自動回収します。

探索Worker（6時間ごと）の1回あたり設定:

- プレイリスト巡回: 最大150件
- Spotify検索: 最大22検索語
- 候補検証: 最大250件
- 最大稼働: 90分
- ブラウザ同時実行: 2

## Supabase SQL

新規環境では `sql/001_production_v4.sql` を適用した後、番号順に追加マイグレーションをすべて適用してください。既存本番環境では未適用の番号だけを順番に適用します。

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

GitHub Actionsには次を登録します。

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
ADMIN_TOKEN
```

`SUPABASE_SERVICE_ROLE_KEY` と `ADMIN_TOKEN` はブラウザ側へ埋め込まないでください。

## 運用メモ

Spotify Web画面をPlaywrightで読むため、Spotify側のUI変更やアクセス制限の影響は受けます。`worker_runs` と `job_errors` を確認し、実行時間・失敗率・未処理件数が増えた場合は収集容量や解析ロジックを見直します。
