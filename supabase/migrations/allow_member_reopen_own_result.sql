-- AutoResearch Idea Tracker V2 migration: members may move their own result
-- back to Testing.
--
-- Run the whole file ONCE in the SQL Editor as postgres on the existing V2
-- database, BEFORE deploying the frontend that shows "Back to Testing".
-- Transactional and repeatable. It replaces only public.reopen_result and
-- re-applies its EXECUTE grant. No table, row, trigger, RLS policy, table grant,
-- Realtime setting or history event is changed.
--
-- New rule (enforced here, not only in the browser):
--   * the PI may reopen any member's completed result, as before;
--   * a member may reopen their own completed result;
--   * nobody else may reopen it.
-- The existing audit trigger records it as 'result_reopened' with the complete
-- previous state, so the earlier result stays in history.
begin;

do $$
begin
  if to_regclass('public.idea_participants') is null
    or to_regprocedure('public.reopen_result(uuid,uuid,bigint)') is null
    or to_regprocedure('tracker_private.lock_participation(uuid,uuid,bigint)') is null
    or to_regprocedure('tracker_private.require_member(boolean)') is null then
    raise exception 'This migration requires the V2 schema; nothing was changed';
  end if;
end;
$$;

-- >>> shared: reopen_result (identical in supabase/schema.sql and supabase/migrations/allow_member_reopen_own_result.sql)
-- Return one member's completed result to Testing so it can be run again. The
-- PI may reopen anyone's result; a member may reopen only their own. The
-- previous result stays in the activity history.
create or replace function public.reopen_result(
  p_idea_id uuid, p_member_id uuid, p_expected_revision bigint
) returns public.idea_participants language plpgsql security definer set search_path = '' as $$
declare v_row public.idea_participants; v_role text;
begin
  v_role := tracker_private.require_member();
  if v_role <> 'pi' and p_member_id is distinct from auth.uid() then
    raise exception using errcode = '42501', message = 'Permission denied';
  end if;
  v_row := tracker_private.lock_participation(p_idea_id, p_member_id, p_expected_revision);
  if v_row.status <> 'completed' then raise exception 'Invalid status transition'; end if;
  update public.idea_participants set status = 'testing', result = null, notes = null,
    experiment_url = null, completed_at = null
  where idea_id = p_idea_id and member_id = p_member_id returning * into v_row;
  return v_row;
end;
$$;
-- <<< shared

revoke all on function public.reopen_result(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.reopen_result(uuid, uuid, bigint) to authenticated;

notify pgrst, 'reload schema';
commit;
