-- ビデオ通話 (1対1)
-- 通話ページは別オリジンの Safari で開くので、ログイン状態に頼れない。
-- アプリ (ログイン済み) が RPC で「短時間だけ有効なトークン」を発行し、URL で通話ページに渡す。
-- 通話ページは Edge Function "call" にトークンを送り、部屋 (Realtime の broadcast チャンネル名) と
-- TURN の情報を受け取る。トークンの確認は call_action() で行い、これは service_role / postgres だけが呼べる。

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations on delete cascade,
  caller_id uuid not null references public.members on delete cascade,
  callee_id uuid not null references public.members on delete cascade,
  video boolean not null default true,
  status text not null default 'ringing'
    check (status in ('ringing', 'active', 'ended', 'declined', 'missed', 'canceled')),
  room text not null default encode(extensions.gen_random_bytes(16), 'hex'), -- シグナリング用のチャンネル名 (推測できない値)
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz
);
create index calls_callee_idx on public.calls (callee_id, created_at desc);
create index calls_caller_idx on public.calls (caller_id, created_at desc);

create table public.call_tokens (
  token text primary key,
  call_id uuid not null references public.calls on delete cascade,
  member_id uuid not null references public.members on delete cascade,
  created_at timestamptz not null default now()
);
create index call_tokens_call_idx on public.call_tokens (call_id);

alter table public.calls enable row level security;
alter table public.call_tokens enable row level security; -- ポリシーなし = 関数経由のみ

create policy "自分の通話を読む" on public.calls
  for select to authenticated
  using (caller_id = (select public.my_member_id()) or callee_id = (select public.my_member_id()));

revoke insert, update, delete on public.calls from anon, authenticated;
revoke all on public.call_tokens from anon, authenticated;

alter publication supabase_realtime add table public.calls;

-- 呼び出しは 60 秒で打ち切り (出なかった)
create function private.expire_ringing() returns void
language sql security definer set search_path = '' as $$
  update public.calls set status = 'missed', ended_at = now()
  where status = 'ringing' and created_at < now() - interval '60 seconds'
$$;

create function private.new_call_token(target_call uuid, member uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare t text := encode(extensions.gen_random_bytes(24), 'hex'); -- 48 けたの16進数
begin
  delete from public.call_tokens where created_at < now() - interval '1 day';
  insert into public.call_tokens (token, call_id, member_id) values (t, target_call, member);
  return t;
end $$;

-- ========== アプリ (ログイン済み) から呼ぶ ==========

-- 1対1の会話の相手に電話をかける。{ call_id, token } を返す
create function public.start_call(conv uuid, with_video boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.my_member_id(); other uuid; c uuid;
begin
  if me is null then raise exception '家族に参加していません'; end if;
  if not exists (select 1 from public.conversations where id = conv and not is_group)
     or conv not in (select public.my_conversation_ids()) then
    raise exception '1対1のトークからだけ、でんわできます';
  end if;
  select cm.member_id into other from public.conversation_members cm
    join public.members m on m.id = cm.member_id
    where cm.conversation_id = conv and cm.member_id <> me and m.user_id is not null;
  if other is null then raise exception 'あいてが まだ参加していません'; end if;

  perform private.expire_ringing();
  -- かけっぱなしの古い呼び出しは取り消す
  update public.calls set status = 'canceled', ended_at = now()
    where caller_id = me and status = 'ringing';

  insert into public.calls (conversation_id, caller_id, callee_id, video)
    values (conv, me, other, coalesce(with_video, true)) returning id into c;
  return jsonb_build_object('call_id', c, 'token', private.new_call_token(c, me));
end $$;

-- 通話ページを開くためのトークン (着信に出るとき、もう一度ひらくとき)
create function public.call_token(target_call uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.my_member_id();
begin
  perform private.expire_ringing();
  if not exists (
    select 1 from public.calls
    where id = target_call and (caller_id = me or callee_id = me) and status in ('ringing', 'active')
  ) then raise exception 'この でんわは もう おわっています'; end if;
  return private.new_call_token(target_call, me);
end $$;

-- 出ない (着信側) / 取り消す (かけた側)
create function public.decline_call(target_call uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.my_member_id();
begin
  update public.calls set
      status = case when callee_id = me then 'declined' else 'canceled' end,
      ended_at = now()
    where id = target_call and (caller_id = me or callee_id = me) and status = 'ringing';
end $$;

-- いま自分にかかってきている電話 (アプリを開いたときに確認する)
create function public.my_ringing_call() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  perform private.expire_ringing();
  select jsonb_build_object('id', c.id, 'caller_id', c.caller_id, 'video', c.video, 'conversation_id', c.conversation_id)
    into r
    from public.calls c
    where c.callee_id = public.my_member_id() and c.status = 'ringing'
    order by c.created_at desc limit 1;
  return r;
end $$;

revoke execute on function
  public.start_call(uuid, boolean), public.call_token(uuid), public.decline_call(uuid), public.my_ringing_call()
from public, anon;
grant execute on function
  public.start_call(uuid, boolean), public.call_token(uuid), public.decline_call(uuid), public.my_ringing_call()
to authenticated;

-- ========== Edge Function "call" から呼ぶ (トークンで確認) ==========
-- act: 'join' = 通話ページをひらいた / 'status' = 状態の確認 / 'end' = おわる
create function public.call_action(t text, act text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  tk public.call_tokens;
  c public.calls;
  role text;
  peer uuid;
begin
  select * into tk from public.call_tokens where token = t;
  if tk.token is null then return jsonb_build_object('error', 'invalid'); end if;
  -- ひらくのはトークン発行から 10 分以内。通話中の確認・終了は 12 時間まで
  if act = 'join' and tk.created_at < now() - interval '10 minutes' then
    return jsonb_build_object('error', 'expired');
  end if;
  if tk.created_at < now() - interval '12 hours' then return jsonb_build_object('error', 'expired'); end if;

  perform private.expire_ringing();
  select * into c from public.calls where id = tk.call_id for update;
  role := case when c.caller_id = tk.member_id then 'caller' else 'callee' end;
  peer := case when role = 'caller' then c.callee_id else c.caller_id end;

  if act = 'join' then
    if c.status not in ('ringing', 'active') then
      return jsonb_build_object('error', 'over', 'status', c.status);
    end if;
    if role = 'callee' and c.status = 'ringing' then
      update public.calls set status = 'active', answered_at = now() where id = c.id returning * into c;
    end if;
  elsif act = 'end' then
    if c.status = 'ringing' then
      update public.calls set status = 'canceled', ended_at = now() where id = c.id returning * into c;
    elsif c.status = 'active' then
      update public.calls set status = 'ended', ended_at = now() where id = c.id returning * into c;
    end if;
  elsif act <> 'status' then
    return jsonb_build_object('error', 'bad_action');
  end if;

  return jsonb_build_object(
    'call_id', c.id,
    'status', c.status,
    'role', role,
    'video', c.video,
    'room', case when act = 'join' then c.room end,
    'me', (select display_name from public.members where id = tk.member_id),
    'peer', (select display_name from public.members where id = peer)
  );
end $$;

revoke execute on function public.call_action(text, text) from public, anon, authenticated;
grant execute on function public.call_action(text, text) to service_role;

-- ========== 着信のプッシュ通知 (iOS 16.4+) ==========
-- 002_push.sql の private.settings (push_url / push_jwt / push_secret) を使う
create function private.notify_call() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  subs jsonb;
  caller text;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
    into subs
    from public.push_subscriptions s
    where s.member_id = new.callee_id;
  if jsonb_array_length(subs) = 0 then return new; end if;

  select display_name into caller from public.members where id = new.caller_id;

  perform net.http_post(
    url := (select value from private.settings where key = 'push_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select value from private.settings where key = 'push_jwt'),
      'x-webhook-secret', (select value from private.settings where key = 'push_secret')
    ),
    body := jsonb_build_object(
      'title', coalesce(caller, 'さくらトーク'),
      'body', case when new.video then '📹 ビデオでんわ です' else '📞 でんわ です' end,
      'tag', 'call-' || new.id,
      'subs', subs
    )
  );
  return new;
exception when others then
  return new; -- 通知の失敗で電話を止めない
end $$;

create trigger calls_push
  after insert on public.calls
  for each row execute function private.notify_call();
