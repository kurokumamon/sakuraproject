// メッセージが追加されたら、会話の相手にプッシュ通知を送る Edge Function。
// DB のトリガー (002_push.sql) から呼ばれる。x-webhook-secret が一致しない呼び出しは拒否する。
// 必要なシークレット: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT / WEBHOOK_SECRET
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT')!,
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
);

Deno.serve(async (req) => {
  if (req.headers.get('x-webhook-secret') !== Deno.env.get('WEBHOOK_SECRET')) {
    return new Response('forbidden', { status: 403 });
  }

  const { record } = await req.json();
  if (!record?.conversation_id || !record?.sender_id) {
    return new Response('bad request', { status: 400 });
  }

  const [{ data: sender }, { data: targets }] = await Promise.all([
    admin.from('members').select('display_name').eq('id', record.sender_id).maybeSingle(),
    admin.from('conversation_members').select('member_id')
      .eq('conversation_id', record.conversation_id).neq('member_id', record.sender_id),
  ]);
  const memberIds = (targets ?? []).map((t) => t.member_id);
  if (!memberIds.length) return Response.json({ sent: 0 });

  const { data: subs } = await admin.from('push_subscriptions')
    .select('id,endpoint,p256dh,auth').in('member_id', memberIds);

  const payload = JSON.stringify({
    title: sender?.display_name ?? 'さくらトーク',
    body: record.image_path ? '📷 しゃしん' : String(record.body ?? '').slice(0, 120),
    tag: record.conversation_id,
  });

  let sent = 0;
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 60 * 60 * 24, urgency: 'high' },
      );
      sent++;
    } catch (e) {
      // 端末側で購読が消えている (アプリ削除など) → 登録を片付ける
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await admin.from('push_subscriptions').delete().eq('id', s.id);
      } else {
        console.error('push failed', status, (e as Error).message);
      }
    }
  }));

  return Response.json({ sent });
});
