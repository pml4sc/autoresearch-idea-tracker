-- AutoResearch Idea Tracker V2 migration: archive ideas the lab has given up on.
--
-- Run the whole file ONCE in the SQL Editor as postgres on the existing V2
-- database, BEFORE deploying the frontend that shows Archive and Restore.
-- Transactional and repeatable. It adds three nullable columns to
-- public.ideas (archived_at, archived_by, archive_reason) with their check
-- constraint, allows the 'archived' and 'unarchived' history events, replaces
-- tracker_private.audit_idea and public.join_idea, and adds public.archive_idea
-- and public.unarchive_idea. Every existing idea stays active. No row, RLS
-- policy, table grant or Realtime setting is changed.
--
-- Rules (enforced here, not only in the browser):
--   * the idea's creator or the PI may archive it, optionally with a reason,
--     and may restore it;
--   * nobody can join or rejoin an archived idea; results, comments and edits
--     are still allowed, and archived ideas are never deleted automatically;
--   * archiving and restoring are recorded in the activity history.
--
-- Re-adding the two check constraints briefly locks public.ideas and
-- public.idea_events while they check the existing rows. If another
-- transaction holds them, the migration gives up after 5 seconds instead of
-- making members wait; nothing is changed and it can simply be rerun.
begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.ideas') is null or to_regclass('public.idea_participants') is null
    or to_regprocedure('public.join_idea(uuid)') is null
    or to_regprocedure('tracker_private.lock_idea(uuid,bigint,boolean)') is null
    or to_regprocedure('tracker_private.require_member(boolean)') is null then
    raise exception 'This migration requires the V2 schema; nothing was changed';
  end if;
end;
$$;

-- >>> shared: idea archive (identical in supabase/schema.sql and supabase/migrations/add_idea_archive.sql)
-- An idea the lab has given up on is archived rather than deleted: its text,
-- results and discussion stay readable, but nobody can join it any more. The
-- idea's creator or the PI archives it, optionally saying why, and can restore
-- it. Written as idempotent ALTERs so the same statements upgrade an existing
-- V2 database and build a fresh one.
alter table public.ideas add column if not exists archived_at timestamptz;
alter table public.ideas add column if not exists archived_by uuid references public.profiles(id) on delete restrict;
alter table public.ideas add column if not exists archive_reason text;
alter table public.ideas drop constraint if exists idea_archive_state;
alter table public.ideas add constraint idea_archive_state check (
  (archived_at is null and archived_by is null and archive_reason is null) or
  (archived_at is not null and archived_by is not null and
    (archive_reason is null or length(archive_reason) between 1 and 2000)));
alter table public.idea_events drop constraint if exists idea_events_event_type_check;
alter table public.idea_events add constraint idea_events_event_type_check check (event_type in (
  'created', 'edited', 'deleted',
  'joined', 'withdrew', 'rejoined', 'result_submitted', 'result_reopened', 'participant_updated',
  'commented', 'comment_removed', 'archived', 'unarchived'));

-- Archiving locks the idea FOR UPDATE, like deletion: it waits for in-flight
-- joins (KEY SHARE) and holds new ones until it commits, after which join_idea
-- sees the archive and refuses. Comments, results and edits stay allowed.
create or replace function public.archive_idea(p_idea_id uuid, p_expected_revision bigint, p_reason text default null)
returns public.ideas language plpgsql security definer set search_path = '' as $$
declare v_idea public.ideas; v_role text;
begin
  v_role := tracker_private.require_member();
  v_idea := tracker_private.lock_idea(p_idea_id, p_expected_revision, true);
  if v_role <> 'pi' and v_idea.created_by is distinct from auth.uid() then
    raise exception using errcode = '42501',
      message = 'Permission denied: only the PI or the idea creator can archive this idea';
  end if;
  if v_idea.archived_at is not null then raise exception 'Idea already archived'; end if;
  update public.ideas set archived_at = clock_timestamp(), archived_by = auth.uid(),
    archive_reason = nullif(btrim(p_reason), '')
  where id = p_idea_id returning * into v_idea;
  return v_idea;
end;
$$;

-- Restoring makes the idea joinable again. The archive (who, when, why) stays
-- in the 'archived' event of the activity history.
create or replace function public.unarchive_idea(p_idea_id uuid, p_expected_revision bigint)
returns public.ideas language plpgsql security definer set search_path = '' as $$
declare v_idea public.ideas; v_role text;
begin
  v_role := tracker_private.require_member();
  v_idea := tracker_private.lock_idea(p_idea_id, p_expected_revision, false);
  if v_role <> 'pi' and v_idea.created_by is distinct from auth.uid() then
    raise exception using errcode = '42501',
      message = 'Permission denied: only the PI or the idea creator can restore this idea';
  end if;
  if v_idea.archived_at is null then raise exception 'Idea is not archived'; end if;
  update public.ideas set archived_at = null, archived_by = null, archive_reason = null
  where id = p_idea_id returning * into v_idea;
  return v_idea;
end;
$$;
revoke all on function public.archive_idea(uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.unarchive_idea(uuid, bigint) from public, anon, authenticated;
grant execute on function public.archive_idea(uuid, bigint, text) to authenticated;
grant execute on function public.unarchive_idea(uuid, bigint) to authenticated;
-- <<< shared

-- >>> shared: audit_idea (identical in supabase/schema.sql and supabase/migrations/add_idea_archive.sql)
-- Archiving and restoring are recorded as their own event types; every other
-- idea update is an edit.
create or replace function tracker_private.audit_idea()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.idea_events(idea_id, idea_number, actor_id, event_type, previous_state, new_state)
  values (new.id, new.idea_number, tracker_private.current_actor(),
    case when tg_op = 'INSERT' then 'created'
      when old.archived_at is null and new.archived_at is not null then 'archived'
      when old.archived_at is not null and new.archived_at is null then 'unarchived'
      else 'edited' end,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end, to_jsonb(new));
  return new;
end;
$$;
-- <<< shared

-- >>> shared: join_idea (identical in supabase/schema.sql and supabase/migrations/add_idea_archive.sql)
-- Join, or rejoin after withdrawing. Each member only ever writes their own row.
-- Archived ideas cannot be joined. archive_idea locks the idea FOR UPDATE, so
-- the archive check below, made after this join's KEY SHARE lock, always sees
-- an archive that committed first.
create or replace function public.join_idea(p_idea_id uuid)
returns public.idea_participants language plpgsql security definer set search_path = '' as $$
declare v_row public.idea_participants;
begin
  perform tracker_private.require_member();
  perform tracker_private.require_idea(p_idea_id);
  if exists (select 1 from public.ideas where id = p_idea_id and archived_at is not null) then
    raise exception 'This idea is archived';
  end if;
  insert into public.idea_participants(idea_id, member_id) values (p_idea_id, auth.uid())
  on conflict (idea_id, member_id) do update set status = 'testing', joined_at = clock_timestamp()
    where public.idea_participants.status = 'withdrawn'
  returning * into v_row;
  if not found then raise exception 'Already participating in this idea'; end if;
  return v_row;
end;
$$;
-- <<< shared

revoke all on function tracker_private.audit_idea() from public, anon, authenticated;
revoke all on function public.join_idea(uuid) from public, anon, authenticated;
grant execute on function public.join_idea(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
