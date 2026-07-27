# Spotify Listener History Production v4

探索、プレイリスト巡回、アーティスト登録、月間リスナー履歴、公開API、運用監視画面を一体化した最初の本番版です。

## 収録機能

- Spotify検索語によるプレイリスト自動発見
- 発見済みプレイリストの定期再巡回
- アーティスト自動登録
- 月間リスナー履歴保存
- 1万人以上は168時間（7日）ごとに更新
- 1万人未満は30日ごとに再確認
- 日次上限
- 1回あたりの上限
- DB排他ロック
- 並列ブラウザ処理
- ランダム待機
- 指数バックオフ
- 連続失敗時の自動停止
- 実行履歴
- エラー履歴
- 公開検索API
- アーティスト履歴API
- 公開ダッシュボード
- 管理用サマリーAPI
- Docker
- GitHub Actions
- テスト

## 本番上限

1日:

- アーティスト更新 10,000人
- プレイリスト巡回 800件
- Spotify検索 160検索語

GitHub Actionsを3時間ごとに実行し、DBの `daily_usage` で日次上限を管理します。

## 導入手順

### 1. ZIPを展開してVS Codeで開く

### 2. SupabaseへSQLを実行

Supabaseの SQL Editor で次のファイルを実行します。

```text
sql/001_production_v4.sql
```

### 3. `.env` を作る

`.env.example` を複製して `.env` に変更します。

```env
SUPABASE_URL=https://jsqrkbsfaosyunsnknly.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
ADMIN_TOKEN=長いランダム文字列
HEADLESS=false
```

注意:

- `sb_publishable_...` は使用しません。
- SupabaseのSecret key `sb_secret_...` を使います。
- `.env` はGitへ追加しません。

### 4. インストール

```bash
npm install
npm run install:browsers
```

### 5. テスト

```bash
npm test
```

### 6. ローカルでワーカー実行

```bash
npm run worker
```

### 7. Web画面を起動

```bash
npm start
```

ブラウザで:

```text
http://localhost:3000
```

ヘルスチェック:

```text
http://localhost:3000/healthz
```

### 8. GitHub Secrets

GitHub Repository Settings → Secrets and variables → Actions に追加:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_TOKEN`

### 9. GitHub Actions

Actions → `Spotify production worker v4` → Run workflow

成功後は3時間ごとに自動実行されます。

## API

アーティスト一覧:

```text
GET /api/v1/artists?q=artist&page=1&limit=50
```

アーティストと履歴:

```text
GET /api/v1/artists/:id
```

管理サマリー:

```text
GET /api/admin/summary
x-admin-token: ADMIN_TOKEN
```

## 運用上の注意

SpotifyのWeb画面をPlaywrightで読む方式は、Spotify側の画面変更やアクセス制御の影響を受けます。完全に無停止を保証する方式ではありません。

`worker_runs` と `job_errors` を確認し、失敗率や実行時間が急増した場合は以下を調整してください。

- `BROWSER_CONCURRENCY`
- `REQUEST_DELAY_MS`
- `MAX_*_PER_DAY`
- セレクタ・解析ロジック

Secret keyはブラウザへ埋め込まず、サーバーとGitHub Secretsだけで扱ってください。


## v4.1 最適化内容

- 新規候補は初回取得時に月間リスナーが `MIN_MONTHLY_LISTENERS` 未満なら削除し、登録対象にしません。
- 既存アーティストは基準未満になっても削除せず、`BELOW_THRESHOLD_RECHECK_DAYS` 後に再確認します。
- 基準以上のアーティストは `ACTIVE_RECHECK_HOURS=168`（7日）ごとに更新します。
- ダッシュボードの HTML / JavaScript / CSS は UTF-8 を明示し、日本語の文字化けを防止します。
- CSS と JavaScript のURLにバージョンを付け、古い文字化け済みキャッシュを避けます。

現在約3,039件ある既存データは、この変更だけでは削除されません。
