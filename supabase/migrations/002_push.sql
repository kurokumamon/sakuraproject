-- プッシュ通知: メッセージが追加されたら Edge Function "push" を呼ぶ
-- 実行前に <PROJECT_REF>、<ANON_JWT>、<WEBHOOK_SECRET> を置き換えること。
-- (ANON_JWT は legacy の anon キー。Edge Function の JWT 検証を通すために使う)
-- (WEBHOOK_SECRET は Edge Function のシークレットと同じ値。リポジトリには入れない)

create extension if not exists pg_net with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.settings (
  key text primary key,
  value text not null
);

insert into private.settings (key, value) values
  ('push_url', 'https://<PROJECT_REF>.supabase.co/functions/v1/push'),
  ('push_jwt', '<ANON_JWT>'),
  ('push_secret', '<WEBHOOK_SECRET>')
on conflict (key) do update set value = excluded.value;

-- 送り主以外の会話メンバーの宛先と、通知の文面をまとめて Edge Function に渡す
create or replace function private.notify_push() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  subs jsonb;
  sender text;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
    into subs
    from public.push_subscriptions s
    join public.conversation_members cm on cm.member_id = s.member_id
    where cm.conversation_id = new.conversation_id and cm.member_id <> new.sender_id;
  if jsonb_array_length(subs) = 0 then return new; end if;

  select display_name into sender from public.members where id = new.sender_id;

  perform net.http_post(
    url := (select value from private.settings where key = 'push_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select value from private.settings where key = 'push_jwt'),
      'x-webhook-secret', (select value from private.settings where key = 'push_secret')
    ),
    body := jsonb_build_object(
      'title', coalesce(sender, 'さくらトーク'),
      'body', case when new.image_path is not null then '📷 しゃしん' else left(new.body, 120) end,
      'tag', new.conversation_id,
      'subs', subs
    )
  );
  return new;
exception when others then
  return new; -- 通知の失敗でメッセージ送信を止めない
end $$;

drop trigger if exists messages_push on public.messages;
create trigger messages_push
  after insert on public.messages
  for each row execute function private.notify_push();
