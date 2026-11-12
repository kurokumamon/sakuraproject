// プッシュ通知を送る Edge Function。
// DB のトリガー (002_push.sql) が、通知の文面と宛先 (購読情報) をまとめて送ってくる。
// JWT 検証 (anon キー) に加えて、x-webhook-secret が一致しない呼び出しは拒否する。
// 必要なシークレット: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT / WEBHOOK_SECRET
import webpush from 'npm:web-push@3.6.7';

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT')!,
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
);

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };

Deno.serve(async (req) => {
  if (req.headers.get('x-webhook-secret') !== Deno.env.get('WEBHOOK_SECRET')) {
    return new Response('forbidden', { status: 403 });
  }

  const { title, body, tag, subs } = await req.json() as
    { title?: string; body?: string; tag?: string; subs?: Sub[] };
  if (!Array.isArray(subs)) return new Response('bad request', { status: 400 });

  const payload = JSON.stringify({ title, body, tag });
  const gone: string[] = []; // 端末側で消えている購読 (アプリ削除など)
  let sent = 0;

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 60 * 60 * 24, urgency: 'high' },
      );
      sent++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) gone.push(s.id);
      else console.error('push failed', status, (e as Error).message);
    }
  }));

  return Response.json({ sent, gone });
});
