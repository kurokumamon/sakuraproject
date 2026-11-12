-- プッシュ通知: メッセージが追加されたら Edge Function "push" を呼ぶ
-- 実行前に <PROJECT_REF> と <WEBHOOK_SECRET> を置き換えること。
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
  ('push_secret', '<WEBHOOK_SECRET>')
on conflict (key) do update set value = excluded.value;

create or replace function private.notify_push() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url := (select value from private.settings where key = 'push_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', (select value from private.settings where key = 'push_secret')
    ),
    body := jsonb_build_object('record', to_jsonb(new))
  );
  return new;
exception when others then
  return new; -- 通知の失敗でメッセージ送信を止めない
end $$;

drop trigger if exists messages_push on public.messages;
create trigger messages_push
  after insert on public.messages
  for each row execute function private.notify_push();
