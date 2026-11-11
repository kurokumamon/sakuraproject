-- 家族メッセンジャー 初期スキーマ (Supabase / Postgres)
-- 前提: Authentication > Sign In / Providers で「Anonymous sign-ins」を有効にする
--   親   = メールアドレスで登録
--   子供 = 端末で匿名サインイン → 親が発行した招待コードで members に紐づく

create extension if not exists pgcrypto with schema extensions;

-- ========== テーブル ==========

create table public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  user_id uuid unique references auth.users on delete set null, -- 未参加の間は null
  display_name text not null,
  role text not null check (role in ('parent', 'child')),
  created_at timestamptz not null default now()
);
create index members_family_idx on public.members (family_id);

create table public.invites (
  code text primary key,
  member_id uuid not null references public.members on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  is_group boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations on delete cascade,
  member_id uuid not null references public.members on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, member_id)
);
create index conversation_members_member_idx on public.conversation_members (member_id);

create table public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations on delete cascade,
  sender_id uuid not null references public.members on delete cascade,
  body text,
  image_path text,
  created_at timestamptz not null default now(),
  check (body is not null or image_path is not null)
);
create index messages_conversation_idx on public.messages (conversation_id, created_at desc);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- ========== RLS 用ヘルパー (security definer で再帰を避ける) ==========

create function public.my_member_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.members where user_id = (select auth.uid())
$$;

create function public.my_family_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select family_id from public.members where user_id = (select auth.uid())
$$;

create function public.i_am_parent() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.members
    where user_id = (select auth.uid()) and role = 'parent'
  )
$$;

create function public.my_conversation_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select conversation_id from public.conversation_members
  where member_id = public.my_member_id()
$$;

-- ========== RLS ==========

alter table public.families enable row level security;
alter table public.members enable row level security;
alter table public.invites enable row level security;            -- ポリシーなし = RPC 経由のみ
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.push_subscriptions enable row level security;

create policy "自分の家族を読む" on public.families
  for select to authenticated using (id = (select public.my_family_id()));

create policy "家族のメンバーを読む" on public.members
  for select to authenticated using (family_id = (select public.my_family_id()));

create policy "親はメンバーを編集" on public.members
  for update to authenticated
  using (family_id = (select public.my_family_id()) and (select public.i_am_parent()))
  with check (family_id = (select public.my_family_id()));

create policy "親は子供を削除" on public.members
  for delete to authenticated
  using (family_id = (select public.my_family_id()) and (select public.i_am_parent()) and role = 'child');

create policy "参加中の会話を読む" on public.conversations
  for select to authenticated using (id in (select public.my_conversation_ids()));

create policy "参加中の会話のメンバーを読む" on public.conversation_members
  for select to authenticated using (conversation_id in (select public.my_conversation_ids()));

create policy "自分の既読を更新" on public.conversation_members
  for update to authenticated
  using (member_id = (select public.my_member_id()))
  with check (member_id = (select public.my_member_id()));

create policy "参加中の会話のメッセージを読む" on public.messages
  for select to authenticated using (conversation_id in (select public.my_conversation_ids()));

create policy "自分の名前で参加中の会話に送る" on public.messages
  for insert to authenticated
  with check (
    sender_id = (select public.my_member_id())
    and conversation_id in (select public.my_conversation_ids())
  );

create policy "自分の通知購読を管理" on public.push_subscriptions
  for all to authenticated
  using (member_id = (select public.my_member_id()))
  with check (member_id = (select public.my_member_id()));

-- 列単位の権限: 既読時刻以外は書き換えさせない / 送信時刻・ID は偽装させない
revoke insert, update, delete on public.conversation_members from anon, authenticated;
grant update (last_read_at) on public.conversation_members to authenticated;

revoke insert, update, delete on public.messages from anon, authenticated;
grant insert (conversation_id, sender_id, body, image_path) on public.messages to authenticated;

revoke insert, update, delete on public.families, public.conversations from anon, authenticated;
revoke insert on public.members from anon, authenticated;
revoke update on public.members from anon, authenticated;
grant update (display_name) on public.members to authenticated;

-- ========== RPC ==========

-- 親: 家族を作成 (自分が親メンバーになり、家族グループの会話もできる)
create function public.create_family(family_name text, my_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare f uuid; m uuid; c uuid;
begin
  if auth.uid() is null then raise exception 'ログインが必要です'; end if;
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception '家族の作成は親アカウントのみです';
  end if;
  if public.my_member_id() is not null then raise exception 'すでに家族に参加しています'; end if;

  insert into public.families (name) values (family_name) returning id into f;
  insert into public.members (family_id, user_id, display_name, role)
    values (f, auth.uid(), my_name, 'parent') returning id into m;
  insert into public.conversations (family_id, is_group) values (f, true) returning id into c;
  insert into public.conversation_members (conversation_id, member_id) values (c, m);
  return f;
end $$;

-- 親: メンバー(子供・もう一人の親・祖父母など)の枠を追加。まだ端末は紐づかない
create function public.add_member(member_name text, member_role text default 'child') returns uuid
language plpgsql security definer set search_path = '' as $$
declare f uuid := public.my_family_id(); m uuid;
begin
  if not public.i_am_parent() then raise exception '親のみ実行できます'; end if;
  insert into public.members (family_id, display_name, role)
    values (f, member_name, member_role) returning id into m;
  insert into public.conversation_members (conversation_id, member_id)
    select id, m from public.conversations where family_id = f and is_group;
  return m;
end $$;

-- 親: 招待コードを発行 (15分有効・1回限り)。端末の入れ替え時も再発行すればよい
create function public.create_invite(target_member uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare new_code text;
begin
  if not public.i_am_parent() then raise exception '親のみ実行できます'; end if;
  if not exists (
    select 1 from public.members
    where id = target_member and family_id = public.my_family_id()
  ) then raise exception '対象のメンバーが見つかりません'; end if;

  delete from public.invites where member_id = target_member;
  new_code := upper(encode(extensions.gen_random_bytes(4), 'hex')); -- 8桁の英数字
  insert into public.invites (code, member_id, expires_at)
    values (new_code, target_member, now() + interval '15 minutes');
  return new_code;
end $$;

-- 子供の端末: 匿名サインイン後に招待コードを入力して参加
create function public.redeem_invite(invite_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare m uuid;
begin
  if auth.uid() is null then raise exception 'サインインが必要です'; end if;
  if public.my_member_id() is not null then raise exception 'この端末はすでに参加済みです'; end if;

  select member_id into m from public.invites
    where code = upper(trim(invite_code)) and used_at is null and expires_at > now()
    for update;
  if m is null then raise exception 'コードが正しくないか、期限切れです'; end if;

  -- 以前の端末があれば切り離す (紛失時の遠隔ログアウトを兼ねる)
  delete from public.push_subscriptions where member_id = m;
  update public.members set user_id = auth.uid() where id = m;
  update public.invites set used_at = now() where code = upper(trim(invite_code));
  return m;
end $$;

-- 1対1の会話を取得 (なければ作成)
create function public.get_or_create_dm(other_member uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.my_member_id(); f uuid := public.my_family_id(); c uuid;
begin
  if me is null then raise exception '家族に参加していません'; end if;
  if other_member = me or not exists (
    select 1 from public.members where id = other_member and family_id = f
  ) then raise exception '相手が見つかりません'; end if;

  select cv.id into c
    from public.conversations cv
    join public.conversation_members a on a.conversation_id = cv.id and a.member_id = me
    join public.conversation_members b on b.conversation_id = cv.id and b.member_id = other_member
    where not cv.is_group
    limit 1;
  if c is not null then return c; end if;

  insert into public.conversations (family_id, is_group) values (f, false) returning id into c;
  insert into public.conversation_members (conversation_id, member_id) values (c, me), (c, other_member);
  return c;
end $$;

revoke execute on function
  public.create_family(text, text),
  public.add_member(text, text),
  public.create_invite(uuid),
  public.redeem_invite(text),
  public.get_or_create_dm(uuid)
from public, anon;
grant execute on function
  public.create_family(text, text),
  public.add_member(text, text),
  public.create_invite(uuid),
  public.redeem_invite(text),
  public.get_or_create_dm(uuid)
to authenticated;

-- ========== Realtime ==========

alter publication supabase_realtime add table public.messages, public.conversation_members;

-- ========== 写真用ストレージ (非公開。パスは <conversation_id>/<ファイル名>) ==========

insert into storage.buckets (id, name, public) values ('chat-images', 'chat-images', false);

create policy "参加中の会話の写真を読む" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-images'
    and (storage.foldername(name))[1] in (select public.my_conversation_ids()::text)
  );

create policy "参加中の会話に写真を送る" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-images'
    and (storage.foldername(name))[1] in (select public.my_conversation_ids()::text)
  );
