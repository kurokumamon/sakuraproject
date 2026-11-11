# さくらトーク

電話番号なしで使える、家族専用のメッセージアプリです。ビルド不要の静的 PWA と Supabase で動きます。

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` / `style.css` / `app.js` | アプリ本体（`npm install` 不要） |
| `config.js` | Supabase の接続先 |
| `sw.js` / `manifest.webmanifest` | ホーム画面アプリ化、プッシュ通知の受け口 |
| `supabase/migrations/001_init.sql` | テーブル、アクセス制御、招待まわりの関数 |

## セットアップ

1. Supabase の SQL Editor で `supabase/migrations/001_init.sql` を実行する。
2. Authentication の設定で **Anonymous sign-ins** を有効にする。
3. `config.js` に Project URL と anon (publishable) キーを入れる。
4. このリポジトリを Vercel や Cloudflare Pages に静的サイトとして公開する（ビルドコマンドなし、出力先はリポジトリ直下）。
5. Authentication の URL 設定で、Site URL を公開先の URL にする。

手元で試す場合は、リポジトリ直下で `npx serve` など任意の静的サーバーを起動します。

## 使い方

1. 親: 公開 URL を開き、ホーム画面に追加してから「おとな」で登録し、家族を作る。
2. 親: 「せってい」で子供を追加し、招待コードを出す。
3. 子供の iPhone: Safari で URL を開き、**先にホーム画面に追加**してから、アプリ内でコードを入力する。

iPhone では Safari とホーム画面アプリでログイン状態が別になるため、必ずホーム画面のアイコンから開いて参加します。

## 対応端末

iOS 16.4 以降（iPhone 8 を含む）、Android の Chrome。

## 未実装

- プッシュ通知の送信（受け口の `sw.js` のみ実装済み）
- ボイスメッセージ、通話、位置共有
