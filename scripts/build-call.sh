#!/bin/sh
# 通話ページ (call/) を、Cloudflare Pages に出す形 (dist-call/) にまとめる。
# 通話ページは別オリジンに置くので、lib/ と config.js も一緒にコピーする。
# 出し方: CLOUDFLARE_ACCOUNT_ID=... npx wrangler pages deploy dist-call --project-name sakura-call --branch main
set -e
cd "$(dirname "$0")/.."
rm -rf dist-call
mkdir -p dist-call/lib
cp call/index.html call/call.js call/call.css dist-call/
cp lib/supa.js lib/compat.js dist-call/lib/
cp config.js dist-call/
# リンクの #t=... が外に漏れないよう、リファラーを送らない・検索にのせない
cat > dist-call/_headers <<'H'
/*
  Referrer-Policy: no-referrer
  X-Robots-Tag: noindex
  Permissions-Policy: camera=(self), microphone=(self)
H
echo "dist-call/ を作りました"
