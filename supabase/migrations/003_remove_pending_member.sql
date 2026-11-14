-- 親: 招待したがまだ参加していないメンバーを削除する (おとな・こどもどちらも)
-- 参加ずみのメンバーは対象外。その人との 1対1 の会話も一緒に片付ける。
create or replace function public.remove_pending_member(target_member uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.i_am_parent() then raise exception '親のみ実行できます'; end if;
  if not exists (
    select 1 from public.members
    where id = target_member and family_id = public.my_family_id() and user_id is null
  ) then raise exception 'まだ参加していないメンバーだけ削除できます'; end if;

  delete from public.conversations
    where not is_group and id in (
      select conversation_id from public.conversation_members where member_id = target_member);
  delete from public.members where id = target_member;
end $$;

revoke execute on function public.remove_pending_member(uuid) from public, anon;
grant execute on function public.remove_pending_member(uuid) to authenticated;
