# さくらトーク（sakuraproject）引き継ぎメモ

家族専用のメッセージアプリ。子供は電話番号もメールアドレスも持たず、親が出す招待QR／8桁コードで参加する。
このリポジトリは**公開リポジトリ**なので、秘密の値（秘密鍵・シークレット・service_role キー）は絶対にコミットしないこと。

## 構成

- フロント: ビルド不要の静的 PWA（`index.html` / `style.css` / `app.js`）。GitHub Pages で `main` を直接公開
  - 公開 URL: https://kurokumamon.github.io/sakuraproject/
  - 変更したら `index.html` の `app.js?v=N` / `style.css?v=N` を上げる（GitHub Pages のキャッシュ対策。最大10分残る）
- `lib/supa.js`: Supabase の最小クライアント（認証・テーブル・RPC・ストレージ・リアルタイム）。supabase-js は iOS 12 で動かないため自作。API は supabase-js 風で `{ data, error }` を返す
- `lib/compat.js`: 古い Safari 向けのおぎない（replaceChildren、Object.fromEntries、uuid）
- `vendor/qrcode.js`: 招待QR生成（Kazuhiko Arase, MIT）
- `sw.js`: プッシュ通知の受け口（キャッシュはしない）
- バックエンド: Supabase プロジェクト「連絡アプリ」（ref: `fvzanzeexiqwqblogqwt`、Pro、ap-northeast-2）
  - `supabase/migrations/001_init.sql`: テーブル、RLS、招待・家族作成などの RPC、写真用バケット `chat-images`
  - `002_push.sql`: メッセージ追加時に Edge Function `push` を呼ぶトリガー（値は `private.settings` に入っている。リポジトリ版はプレースホルダー）
  - `003_remove_pending_member.sql`: 未参加メンバーの削除 RPC
  - `004_calls.sql`: 通話（`calls` / `call_tokens`、`start_call` などの RPC、着信のプッシュ通知トリガー）。本番に適用済み
  - `supabase/functions/call`: 通話ページ用。トークンを確かめ、部屋と ICE サーバー（Cloudflare TURN）を返す。**JWT 検証オフ**でデプロイ（ログインなしで呼ぶため、トークンで確かめる）。シークレット `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` は登録済み。DB には `SUPABASE_DB_URL` でつなぐ（API キーに頼らない）
  - `supabase/functions/push`: Web Push 送信。シークレット `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` / `WEBHOOK_SECRET` は Supabase に登録済み
  - Edge Function の JWT 検証はオンのまま。トリガーは legacy anon キーを Authorization に付けて呼んでいる → **legacy キーは 2027年初めに廃止予定なので、それまでに呼び出し方式を変える**
  - Auth: 親はメール＋パスワード、子供は匿名サインイン（Anonymous sign-ins 有効）。Site URL と Redirect URL は公開 URL に設定済み

## 守ること（対応端末）

**子供の端末は iOS 12。** 次を守る。

- `?.` `??` クラスフィールド、論理代入などの ES2020 以降の構文は使わない
- iOS 12 にない API（`replaceChildren`、Pointer Events、`crypto.randomUUID`、flex の `gap`、`dvh` など）は使わないか、`lib/compat.js` でおぎなう
- 確認方法: acorn で ES2019 としてパースする（`import(` は置き換えてから）。例は下の「テストのやり方」
- プッシュ通知は iOS 16.4 以降のみ。iOS 12 ではアプリを開いている間だけ届く（`pushBanner()` は非対応端末では何も出さない）

- 通話ページ: `call/`（`index.html` / `call.js` / `call.css`）。`scripts/build-call.sh` で `dist-call/` にまとめて Cloudflare Pages に出す（`lib/` と `config.js` も一緒にコピーされる）。URL は `config.js` の `CALL_URL`
- Cloudflare: アカウント ID は API の `GET /accounts` で取れる。TURN キー `sakuraproject-2` を使用中
- Supabase 管理 API（`api.supabase.com`）と Cloudflare API（`api.cloudflare.com`）のトークンは、クラウド環境「sakuraproject」のネットワークシークレットに入っている（プロキシが自動で付ける）。
  - **注意**: プロキシは `Authorization` を上書きするので、`wrangler pages deploy` はアップロード用の一時トークンが消されて失敗する
  - Edge Function のデプロイは `POST /v1/projects/{ref}/functions/deploy?slug=...`（multipart）、SQL は `POST /v1/projects/{ref}/database/query`
  - Node から通信するときは `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`。WebSocket は `ws` ＋ `https-proxy-agent` が必要

## 現在の状態（2026-11-15）

- できている: 親の登録・家族作成、招待QR／コードでの子供参加（QR から開いてホーム画面に追加すると自動参加）、1対1・家族グループのチャット、写真、既読、通知（iOS 16.4+）、未参加メンバーのスワイプ削除、最初の画面の使い方
- 親は実機でログイン済み。子供の端末はこれから参加

## ビデオ通話（作業ブランチ `claude/kind-gates-v8ykzh`、main には未マージ）

できていること（本番 Supabase ＋ Chromium 2台で確認済み）: 1対1のトークの 📹/📞 ボタン → かける画面 → 相手のアプリに着信画面（Realtime）→ 両方が通話ページ（`target=_blank` で Safari）で双方向ビデオ、再読み込みしても再接続、切ると相手も終了、出ない/取り消し/60秒で不在。

残り:
- **通話ページの公開先が未定**（プロキシのせいで wrangler が使えない）。案: Cloudflare Pages の GitHub 連携（ユーザーがダッシュボードで GitHub アプリを入れる → `sakuratalk-call` プロジェクトをビルドコマンド `sh scripts/build-call.sh`、出力 `dist-call` で作る）。`CALL_URL` は今 `https://sakuratalk-call.pages.dev/` を仮に入れてある
- 公開後に main へマージ（`app.js?v=6` / `style.css?v=5` は上げ済み）
- 実機テスト: iOS 12 の Safari でのカメラ・H.264、ホーム画面アプリから `target=_blank` で Safari が開くか、モバイル回線（TURN 経由）
- 家族グループの通話は未対応（全員どうしを直接つなぐ形は iOS 12 の端末に重い）

設計メモ（以下は最初に決めた方針）:

要件: 子供の iPhone は iOS 12、ビデオも必要、中継には Cloudflare を使う。

iOS 12 の制約と方針:

1. **ホーム画面アプリ（standalone）では iOS 13.4 まで getUserMedia が使えない。** Safari のタブでは iOS 11 から WebRTC＋カメラ/マイクが使える
   → 通話画面は Safari で開かせる。manifest の scope 内のリンクはアプリ内で開いてしまうので、**通話ページは別オリジン（Cloudflare Pages など）に置く**のが確実
2. **Safari とホーム画面アプリはログイン状態（localStorage）が別。** 通話ページはログインに頼らず、アプリ側で作った「部屋 ID＋短時間だけ有効なトークン」を URL で渡して参加させる（Supabase の RPC でトークンを発行・検証する）
3. **シグナリング**: Supabase Realtime の broadcast（部屋ごとのチャンネル）でよい。`lib/supa.js` は現在 postgres_changes のみ対応なので broadcast を追加する
4. **TURN**: Cloudflare Realtime の TURN を使う。TURN の認証情報は Edge Function でその都度発行してクライアントに渡す（API トークンはフロントに置かない）
5. **着信**: iOS 16.4+ は通知 → タップで通話ページへ。iOS 12 は通知が来ないので、アプリを開いているときに着信画面を出す（Realtime で着信を受ける）
6. iOS 12 の Safari の WebRTC は古い（Unified Plan 移行前後）。`addTrack` / `ontrack` を使い、映像は H.264 を優先する。実機での確認が必須

ユーザー側の準備: Cloudflare アカウントで TURN（Realtime）のキーを作る、2台の端末での実機テスト。

## テストのやり方

- 構文チェック（ES2019）:
  ```js
  // node check.cjs app.js lib/supa.js lib/compat.js vendor/qrcode.js
  const acorn = require('acorn');
  for (const f of process.argv.slice(2)) {
    const src = require('fs').readFileSync(f, 'utf8').replace(/\bimport\(/g, '__dynimport(');
    acorn.parse(src, { ecmaVersion: 2019, sourceType: 'module' });
  }
  ```
- 画面テスト: `lib/supa.js` を偽のクライアントに差し替え、Playwright で 375×667（iPhone 8）表示。`Element.prototype.replaceChildren` / `PointerEvent` / `crypto.randomUUID` を消した状態でも動くことを見る
- 本番 Supabase での通信テスト: 匿名ユーザー2人を作り、SQL でテスト用の家族に紐づけて送受信・リアルタイムを確認 → 終わったら家族と匿名ユーザーを削除する
