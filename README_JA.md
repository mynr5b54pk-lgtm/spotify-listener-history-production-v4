# Spotify Listener History Production v4

Spotifyのアーティスト探索、プレイリスト巡回、月間リスナー収集、履歴保存、公開API、運用監視をまとめた本番用バックエンドです。

## 現在の本番仕様

- GitHub Actions: 3時間ごとに起動
- アクティブアーティスト: 実処理能力に合わせて原則120時間（5日）後に再取得対象へ戻し、全体を約5〜6日で一巡
- 1万人未満: 30日ごとに再確認
- 履歴: 1アーティストにつきUTC日ごとに1点。1日に複数回成功した場合はその日の最新値へ更新
- 収集優先順位: `active` → 未成功の`error`再試行 → `candidate` → `below_threshold`
- ワーカー内の処理順: 新規探索2検索語 → プレイリスト巡回6件 → 月間リスナー収集。少量の探索枠を先に確保し、既存データの更新能力をほぼ維持
- 取得失敗: 指数バックオフで再試行。既に公開済みのアーティストは一時的な取得失敗だけでは公開状態から外さない
- 異常値: 前回比3倍超/3分の1未満の値は再読み込みで一致確認してから保存
- プレイリスト: 7日ごとに再巡回
- アーティスト名: Spotify Open Graph metadataを正規名として優先。プレイリスト上のリンク文字列は、正常取得済みアーティストの正規名を上書きしない
- 誤取得対策: 確認済みのSpotify UIラベル `Your Library` は正規名・別名として保存しない
- アーティスト履歴API: 1000件・365件の固定打ち切りなし。ページングして全履歴を取得
- 検索: 大文字小文字、空白、ハイフンなどの句読点差を吸収し、先頭の `The` 省略にも対応。完全一致・前方一致を優先。1文字検索は無効

## 現在の本番上限

GitHub Actionsの1回あたり設定:

- アーティスト更新: 2,500件
- プレイリスト巡回: 6件
- Spotify検索: 2検索語

1日あたりの安全上限:

- アーティスト更新予約: 50,000件
- プレイリスト巡回: 800件
- Spotify検索: 160検索語

アーティスト側の50,000件/日は、現在の3時間ごと・2,500件/回では通常到達しない安全上限です。

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
