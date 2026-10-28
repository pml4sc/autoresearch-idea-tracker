-- AutoResearch Idea Tracker V2: collaborative ideas, independent participant
-- results, and per-idea discussion. Run the entire file in the project's SQL
-- Editor as postgres. No accounts, research data, or credentials are seeded.
--
-- Fresh install: run this file once. Rerunning it is safe and keeps all data.
-- Existing V1 project: this SAME file upgrades V1 to V2 in ONE transaction. It
-- moves the V1 ideas and history unchanged into the private schema
-- tracker_v1_archive and then installs V2. It refuses to start unless the
-- fingerprint of a saved, verified backup is pasted below (README section 1B).
-- Any failure rolls back everything, leaving V1 exactly as it was.
-- auth.users and public.profiles are never modified by this file.
begin;

-- V1 UPGRADE ONLY: paste the fingerprint printed by supabase/export_v1_backup.sql
-- here, after saving the backup and checking it with tools/verify_v1_backup.mjs.
-- Ignored on fresh installs and on V2 reruns.
select set_config('tracker.v1_backup_fingerprint', '', true);

create schema if not exists tracker_private;
revoke all on schema tracker_private from public, anon, authenticated;
grant usage on schema public, tracker_private to authenticated;

-- Temporary helpers for the V1 upgrade, dropped again at the end of this file.
-- They MUST produce exactly the canonical rows and fingerprint of
-- supabase/export_v1_backup.sql and tools/verify_v1_backup.mjs.
create or replace function tracker_private.v1_line(p_row jsonb)
returns text language sql immutable set search_path = '' as $$
  select coalesce(string_agg(case when e.value is null then e.key else e.key || '=' || e.value end,
    chr(31) order by e.key collate "C"), '')
  from jsonb_each_text(p_row) e;
$$;
create or replace function tracker_private.v1_fingerprint(p_schema text)
returns text language plpgsql stable set search_path = '' as $$
declare v_profiles text; v_ideas text; v_events text;
begin
  select md5(coalesce(string_agg(tracker_private.v1_line(r), chr(10) order by r->>'id' collate "C"), '')) into v_profiles
  from (select jsonb_build_object('id', p.id::text, 'display_name', p.display_name, 'role', p.role,
    'active', p.active::text, 'created_at', to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) r
    from public.profiles p) s;
  execute format($q$
    select md5(coalesce(string_agg(tracker_private.v1_line(r), chr(10) order by n), ''))
    from (select i.idea_number n, jsonb_build_object('id', i.id::text, 'idea_number', i.idea_number::text,
      'title', i.title, 'description', i.description, 'week_start', to_char(i.week_start, 'YYYY-MM-DD'),
      'priority', i.priority, 'status', i.status, 'assigned_to', i.assigned_to::text, 'result', i.result,
      'notes', i.notes, 'experiment_url', i.experiment_url, 'created_by', i.created_by::text,
      'created_at', to_char(i.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'updated_at', to_char(i.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'completed_at', to_char(i.completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'revision', i.revision::text) r from %I.ideas i) s$q$, p_schema) into v_ideas;
  execute format($q$
    select md5(coalesce(string_agg(tracker_private.v1_line(r), chr(10) order by n), ''))
    from (select e.id n, jsonb_build_object('id', e.id::text, 'idea_id', e.idea_id::text,
      'idea_number', e.idea_number::text, 'actor_id', e.actor_id::text, 'event_type', e.event_type,
      'previous_state', e.previous_state::text, 'new_state', e.new_state::text,
      'created_at', to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) r
      from %I.idea_events e) s$q$, p_schema) into v_events;
  return md5('autoresearch-v1-backup-1' || chr(10) || 'profiles=' || v_profiles || chr(10)
    || 'ideas=' || v_ideas || chr(10) || 'events=' || v_events);
end;
$$;
revoke all on function tracker_private.v1_line(jsonb) from public, anon, authenticated;
revoke all on function tracker_private.v1_fingerprint(text) from public, anon, authenticated;

do $$
declare
  v_expected text := nullif(btrim(current_setting('tracker.v1_backup_fingerprint', true)), '');
  v_users text;
begin
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'ideas' and column_name = 'assigned_to') then
    return; -- fresh install or V2 rerun: nothing to upgrade
  end if;
  if to_regclass('public.idea_participants') is not null or to_regclass('public.idea_comments') is not null
    or exists (select 1 from pg_namespace where nspname = 'tracker_v1_archive') then
    raise exception using message = 'Unexpected mix of V1 and V2/archive objects; nothing was changed';
  end if;
  -- Hold V1 still between the fingerprint check and the archive move.
  lock table public.ideas, public.idea_events in access exclusive mode;
  if v_expected is null then
    raise exception using
      message = 'V1 business schema detected: a verified backup is required before upgrading; nothing was changed',
      hint = 'Run supabase/export_v1_backup.sql, save and verify the backup, then paste its fingerprint at the top of this file.';
  end if;
  if v_expected <> tracker_private.v1_fingerprint('public') then
    raise exception using
      message = 'V1 data does not match the backup fingerprint; nothing was changed',
      hint = 'The data changed after the export, or a different fingerprint was pasted. Export and verify a new backup.';
  end if;
  select coalesce(md5(string_agg(u.id::text, ',' order by u.id)), 'none') into v_users from auth.users u;
  perform set_config('tracker.v1_users_before', v_users, true);

  -- Detach V1 from Realtime and the API before moving it.
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'idea_events') then
    alter publication supabase_realtime drop table public.idea_events;
  end if;
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'ideas') then
    alter publication supabase_realtime drop table public.ideas;
  end if;
  drop function public.create_idea(text, text, date, text);
  drop function public.update_idea(uuid, bigint, text, text, date, text);
  drop function public.delete_idea(uuid, bigint);
  drop function public.claim_idea(uuid);
  drop function public.release_idea(uuid, bigint);
  drop function public.complete_idea(uuid, bigint, text, text, text);
  drop function public.reopen_idea(uuid, bigint);
  drop function tracker_private.lock_idea(uuid, bigint);
  drop trigger ideas_touch on public.ideas;
  drop trigger ideas_audit on public.ideas;
  drop policy members_read_ideas on public.ideas;
  drop policy members_read_events on public.idea_events;

  -- Move (not copy, not delete) the V1 tables. Rows, identities, indexes,
  -- constraints and their references to profiles are kept as they are.
  create schema tracker_v1_archive;
  revoke all on schema tracker_v1_archive from public, anon, authenticated;
  alter table public.idea_events set schema tracker_v1_archive;
  alter table public.ideas set schema tracker_v1_archive;
  revoke all on all tables in schema tracker_v1_archive from public, anon, authenticated;
  revoke all on all sequences in schema tracker_v1_archive from public, anon, authenticated;
  drop function tracker_private.touch_idea();
  drop function tracker_private.audit_idea();

  if tracker_private.v1_fingerprint('tracker_v1_archive') <> v_expected then
    raise exception 'Archived V1 data does not match the backup fingerprint; rolled back';
  end if;
  perform set_config('tracker.v1_upgraded', 'yes', true);
  raise notice 'V1 archived to tracker_v1_archive (fingerprint %). Installing V2.', v_expected;
end;
$$;

-- Administrator-managed allowlist. Unchanged from V1, so existing member
-- profiles, UUIDs and roles carry over as they are.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  display_name text not null unique,
  role text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint authorized_member check (
    (display_name = 'Shibo' and role = 'pi') or
    (display_name in ('Yan', 'Junqi', 'Yifan') and role = 'researcher')
  )
);

create table if not exists public.ideas (
  id uuid primary key default gen_random_uuid(),
  idea_number bigint generated always as identity unique,
  title text not null check (length(btrim(title)) between 1 and 200),
  description text not null default '' check (octet_length(description) <= 1048576),
  week_start date not null check (extract(isodow from week_start) = 1),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision bigint not null default 1 check (revision > 0)
);

-- One row per member per idea: each researcher's status and result live in
-- their own row, so no member's result can overwrite another's.
create table if not exists public.idea_participants (
  idea_id uuid not null references public.ideas(id) on delete restrict,
  member_id uuid not null references public.profiles(id) on delete restrict,
  status text not null default 'testing' check (status in ('testing', 'completed', 'withdrawn')),
  result text check (result in ('success', 'fail')),
  notes text check (length(notes) <= 20000),
  experiment_url text check (
    experiment_url is null or
    (length(experiment_url) <= 2048 and experiment_url ~* '^https?://[^[:space:]]+$')
  ),
  joined_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  revision bigint not null default 1 check (revision > 0),
  primary key (idea_id, member_id),
  constraint participant_state check (
    (status in ('testing', 'withdrawn') and result is null and completed_at is null
      and notes is null and experiment_url is null) or
    (status = 'completed' and result is not null and completed_at is not null)
  )
);

-- Comments keep their author, server timestamp and exact original Markdown.
-- They are never edited; the PI can remove one, which hides it but keeps it.
create table if not exists public.idea_comments (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references public.ideas(id) on delete restrict,
  author_id uuid not null references public.profiles(id) on delete restrict,
  body text not null check (body ~ '[^[:space:]]' and octet_length(body) <= 20480),
  -- Makes a retried submission after an uncertain network failure idempotent.
  client_request_id uuid not null,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references public.profiles(id) on delete restrict,
  constraint comment_removal check ((removed_at is null) = (removed_by is null)),
  constraint comment_request_once unique (author_id, client_request_id)
);

-- Threaded replies. A reply points at a comment of the SAME idea: the composite
-- foreign key (parent_comment_id, idea_id) -> (id, idea_id) enforces both that
-- the parent exists and that it belongs to the same idea. Comments are
-- immutable (guard_comment_update) and a parent must exist before its reply,
-- so the replies always form a tree: cycles cannot occur. Comments without a
-- parent are top-level. Written as idempotent ALTERs so the same statements
-- upgrade an existing V2 database and build a fresh one.
alter table public.idea_comments add column if not exists parent_comment_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint
      where conrelid = 'public.idea_comments'::regclass and conname = 'comment_id_idea_unique') then
    alter table public.idea_comments add constraint comment_id_idea_unique unique (id, idea_id);
  end if;
  if not exists (select 1 from pg_constraint
      where conrelid = 'public.idea_comments'::regclass and conname = 'comment_parent_same_idea') then
    alter table public.idea_comments add constraint comment_parent_same_idea
      foreign key (parent_comment_id, idea_id) references public.idea_comments (id, idea_id);
  end if;
  if not exists (select 1 from pg_constraint
      where conrelid = 'public.idea_comments'::regclass and conname = 'comment_not_own_parent') then
    alter table public.idea_comments add constraint comment_not_own_parent
      check (parent_comment_id is distinct from id);
  end if;
end;
$$;
create index if not exists idea_comments_parent_idx on public.idea_comments(parent_comment_id);

create table if not exists public.idea_events (
  id bigint generated always as identity primary key,
  -- Intentionally no idea FK: deletion preserves immutable historical snapshots.
  idea_id uuid not null,
  idea_number bigint not null,
  actor_id uuid references public.profiles(id) on delete restrict,
  -- The participant whose row changed, for participation events.
  member_id uuid references public.profiles(id) on delete restrict,
  event_type text not null check (event_type in (
    'created', 'edited', 'deleted',
    'joined', 'withdrew', 'rejoined', 'result_submitted', 'result_reopened', 'participant_updated',
    'commented', 'comment_removed', 'archived', 'unarchived')),
  previous_state jsonb,
  new_state jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ideas_week_number_idx on public.ideas(week_start desc, idea_number desc);
create index if not exists idea_participants_member_idx on public.idea_participants(member_id, status);
create index if not exists idea_comments_idea_idx on public.idea_comments(idea_id, created_at);
create index if not exists idea_events_idea_idx on public.idea_events(idea_id, id desc);
create index if not exists idea_events_created_idx on public.idea_events(id desc);

alter table public.profiles enable row level security;
alter table public.ideas enable row level security;
alter table public.idea_participants enable row level security;
alter table public.idea_comments enable row level security;
alter table public.idea_events enable row level security;

-- Owner-only lookup avoids recursive profile RLS. Role comes ONLY from the
-- administrator-managed allowlist, never JWT user_metadata or client input.
create or replace function tracker_private.member_role()
returns text language sql stable security definer set search_path = '' as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.active;
$$;

create or replace function tracker_private.require_member(p_pi_only boolean default false)
returns text language plpgsql security definer set search_path = '' as $$
declare v_role text;
begin
  v_role := tracker_private.member_role();
  if v_role is null or (p_pi_only and v_role <> 'pi') then
    raise exception using errcode = '42501', message = 'Permission denied';
  end if;
  return v_role;
end;
$$;

drop policy if exists members_read_profiles on public.profiles;
create policy members_read_profiles on public.profiles for select to authenticated
  using ((select tracker_private.member_role()) is not null);
drop policy if exists members_read_ideas on public.ideas;
create policy members_read_ideas on public.ideas for select to authenticated
  using ((select tracker_private.member_role()) is not null);
drop policy if exists members_read_participants on public.idea_participants;
create policy members_read_participants on public.idea_participants for select to authenticated
  using ((select tracker_private.member_role()) is not null);
drop policy if exists members_read_comments on public.idea_comments;
create policy members_read_comments on public.idea_comments for select to authenticated
  using ((select tracker_private.member_role()) is not null);
drop policy if exists members_read_events on public.idea_events;
create policy members_read_events on public.idea_events for select to authenticated
  using ((select tracker_private.member_role()) is not null);

-- No INSERT/UPDATE/DELETE policies or grants for clients. RPCs are the only
-- mutation path, and every one explicitly authorizes the caller.
revoke all on public.profiles, public.ideas, public.idea_participants, public.idea_comments, public.idea_events
  from public, anon, authenticated;
grant select on public.profiles, public.ideas, public.idea_participants, public.idea_comments, public.idea_events
  to authenticated;
revoke all on sequence public.ideas_idea_number_seq, public.idea_events_id_seq from public, anon, authenticated;

create or replace function tracker_private.touch_row()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  new.revision := old.revision + 1;
  return new;
end;
$$;
drop trigger if exists ideas_touch on public.ideas;
create trigger ideas_touch before update on public.ideas
  for each row execute function tracker_private.touch_row();
drop trigger if exists idea_participants_touch on public.idea_participants;
create trigger idea_participants_touch before update on public.idea_participants
  for each row execute function tracker_private.touch_row();

-- SQL Editor maintenance may have no Auth identity; do not invent an actor.
create or replace function tracker_private.current_actor()
returns uuid language sql stable security definer set search_path = '' as $$
  select p.id from public.profiles p where p.id = auth.uid();
$$;

-- Audit triggers record snapshots in the SAME transaction as each mutation.
-- Every participant/comment change therefore also inserts an idea_events row,
-- which is what Realtime delivers to other members.
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
drop trigger if exists ideas_audit on public.ideas;
create trigger ideas_audit after insert or update on public.ideas
  for each row execute function tracker_private.audit_idea();

create or replace function tracker_private.audit_participant()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_type text;
begin
  if tg_op = 'INSERT' then v_type := 'joined';
  elsif old.status = 'testing' and new.status = 'withdrawn' then v_type := 'withdrew';
  elsif old.status = 'withdrawn' and new.status = 'testing' then v_type := 'rejoined';
  elsif old.status = 'testing' and new.status = 'completed' then v_type := 'result_submitted';
  elsif old.status = 'completed' and new.status = 'testing' then v_type := 'result_reopened';
  else v_type := 'participant_updated';
  end if;
  insert into public.idea_events(idea_id, idea_number, actor_id, member_id, event_type, previous_state, new_state)
  select new.idea_id, i.idea_number, tracker_private.current_actor(), new.member_id, v_type,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end, to_jsonb(new)
  from public.ideas i where i.id = new.idea_id;
  return new;
end;
$$;
drop trigger if exists idea_participants_audit on public.idea_participants;
create trigger idea_participants_audit after insert or update on public.idea_participants
  for each row execute function tracker_private.audit_participant();

create or replace function tracker_private.audit_comment()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.idea_events(idea_id, idea_number, actor_id, event_type, previous_state, new_state)
  select new.idea_id, i.idea_number, tracker_private.current_actor(),
    case when tg_op = 'INSERT' then 'commented' else 'comment_removed' end,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end, to_jsonb(new)
  from public.ideas i where i.id = new.idea_id;
  return new;
end;
$$;
drop trigger if exists idea_comments_audit on public.idea_comments;
create trigger idea_comments_audit after insert or update on public.idea_comments
  for each row execute function tracker_private.audit_comment();

-- Comments are immutable. The only permitted change is the author's or PI's one-time
-- removal (remove_comment), which sets removed_at/removed_by and nothing else.
create or replace function tracker_private.guard_comment_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.removed_at is not null
    or (new.id, new.idea_id, new.author_id, new.body, new.client_request_id, new.created_at, new.parent_comment_id)
      is distinct from (old.id, old.idea_id, old.author_id, old.body, old.client_request_id, old.created_at, old.parent_comment_id) then
    raise exception 'Comments are immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists idea_comments_immutable on public.idea_comments;
create trigger idea_comments_immutable before update on public.idea_comments
  for each row execute function tracker_private.guard_comment_update();

-- Lock order is always PARENT IDEA FIRST, then child rows:
--   * every participant/comment change first takes FOR KEY SHARE on the idea
--     (require_idea). KEY SHARE locks never conflict with each other, so members
--     still change their own rows concurrently;
--   * delete_idea takes FOR UPDATE, which conflicts with KEY SHARE. A deletion
--     therefore waits for in-flight child changes to commit and then snapshots
--     them, and a child change that arrives during a deletion waits and then
--     finds the idea gone;
--   * idea edits take FOR NO KEY UPDATE, which does not conflict with KEY SHARE,
--     so editing an idea never blocks or waits for participation and comments.
-- A revision check prevents a stale edit/delete from applying to a newer idea.
-- Locks last until the surrounding RPC transaction commits.
drop function if exists tracker_private.lock_idea(uuid, bigint);
create or replace function tracker_private.lock_idea(p_idea_id uuid, p_expected_revision bigint, p_for_delete boolean)
returns public.ideas language plpgsql security definer set search_path = '' as $$
declare v_idea public.ideas;
begin
  if p_for_delete then
    select * into v_idea from public.ideas where id = p_idea_id for update;
  else
    select * into v_idea from public.ideas where id = p_idea_id for no key update;
  end if;
  if not found then raise exception 'Idea not found'; end if;
  if p_expected_revision is null or v_idea.revision <> p_expected_revision then
    raise exception 'Idea changed. Refresh and try again';
  end if;
  return v_idea;
end;
$$;

create or replace function tracker_private.require_idea(p_idea_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.ideas where id = p_idea_id for key share;
  if not found then raise exception 'Idea not found'; end if;
end;
$$;

-- Parent first, then one member's participation row; other members' rows stay free.
create or replace function tracker_private.lock_participation(
  p_idea_id uuid, p_member_id uuid, p_expected_revision bigint
) returns public.idea_participants language plpgsql security definer set search_path = '' as $$
declare v_row public.idea_participants;
begin
  perform tracker_private.require_idea(p_idea_id);
  select * into v_row from public.idea_participants
  where idea_id = p_idea_id and member_id = p_member_id for update;
  if not found then raise exception 'Participation not found'; end if;
  if p_expected_revision is null or v_row.revision <> p_expected_revision then
    raise exception 'Participation changed. Refresh and try again';
  end if;
  return v_row;
end;
$$;


create or replace function public.create_idea(
  p_title text, p_description text, p_week_start date, p_priority text
) returns public.ideas language plpgsql security definer set search_path = '' as $$
declare v_idea public.ideas;
begin
  perform tracker_private.require_member();
  insert into public.ideas(title, description, week_start, priority, created_by)
  values (btrim(p_title), coalesce(p_description, ''), p_week_start, p_priority, auth.uid())
  returning * into v_idea;
  return v_idea;
end;
$$;

-- The idea's creator or the PI may edit its title, Markdown and metadata.
create or replace function public.update_idea(
  p_idea_id uuid, p_expected_revision bigint, p_title text,
  p_description text, p_week_start date, p_priority text
) returns public.ideas language plpgsql security definer set search_path = '' as $$
declare v_idea public.ideas; v_role text;
begin
  v_role := tracker_private.require_member();
  v_idea := tracker_private.lock_idea(p_idea_id, p_expected_revision, false);
  if v_role <> 'pi' and v_idea.created_by is distinct from auth.uid() then
    raise exception using errcode = '42501', message = 'Permission denied';
  end if;
  update public.ideas set title = btrim(p_title), description = coalesce(p_description, ''),
    week_start = p_week_start, priority = p_priority
  where id = p_idea_id returning * into v_idea;
  return v_idea;
end;
$$;

-- The PI may delete any idea. Its creator may delete it only while nobody has
-- joined it (withdrawn participants count) and no comment exists (removed
-- comments count). The checks run after the idea is locked FOR UPDATE, which
-- waits for in-flight joins and comments (they hold KEY SHARE) and blocks new
-- ones until this transaction ends, so no contribution can slip in between the
-- check and the deletion. The 'deleted' event stores the idea with all
-- participant results and comments, then the rows are removed explicitly
-- (no cascading deletes).
create or replace function public.delete_idea(p_idea_id uuid, p_expected_revision bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_idea public.ideas; v_role text;
begin
  v_role := tracker_private.require_member();
  v_idea := tracker_private.lock_idea(p_idea_id, p_expected_revision, true);
  if v_role <> 'pi' then
    if v_idea.created_by is distinct from auth.uid() then
      raise exception using errcode = '42501',
        message = 'Permission denied: only the PI or the idea creator can delete this idea';
    end if;
    if exists (select 1 from public.idea_participants where idea_id = v_idea.id)
      or exists (select 1 from public.idea_comments where idea_id = v_idea.id) then
      raise exception using errcode = '42501',
        message = 'Permission denied: this idea already has participants or comments; only the PI can delete it';
    end if;
  end if;
  insert into public.idea_events(idea_id, idea_number, actor_id, event_type, previous_state)
  values (v_idea.id, v_idea.idea_number, tracker_private.current_actor(), 'deleted',
    to_jsonb(v_idea) || jsonb_build_object(
      'participants', coalesce((select jsonb_agg(to_jsonb(p) order by p.joined_at)
        from public.idea_participants p where p.idea_id = v_idea.id), '[]'::jsonb),
      'comments', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at)
        from public.idea_comments c where c.idea_id = v_idea.id), '[]'::jsonb)));
  delete from public.idea_comments where idea_id = v_idea.id;
  delete from public.idea_participants where idea_id = v_idea.id;
  delete from public.ideas where id = v_idea.id;
end;
$$;

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

create or replace function public.leave_idea(p_idea_id uuid, p_expected_revision bigint)
returns public.idea_participants language plpgsql security definer set search_path = '' as $$
declare v_row public.idea_participants;
begin
  perform tracker_private.require_member();
  v_row := tracker_private.lock_participation(p_idea_id, auth.uid(), p_expected_revision);
  if v_row.status <> 'testing' then raise exception 'Invalid status transition'; end if;
  update public.idea_participants set status = 'withdrawn'
  where idea_id = p_idea_id and member_id = auth.uid() returning * into v_row;
  return v_row;
end;
$$;

-- Records the CALLER's own result. There is deliberately no member parameter:
-- no one, including the PI, can submit a result into another member's row.
-- A member may also change their own completed result (e.g. fail -> success);
-- the audit trigger records it as participant_updated with both states.
create or replace function public.submit_result(
  p_idea_id uuid, p_expected_revision bigint, p_result text,
  p_notes text default null, p_experiment_url text default null
) returns public.idea_participants language plpgsql security definer set search_path = '' as $$
declare v_row public.idea_participants;
begin
  perform tracker_private.require_member();
  if p_result is null or p_result not in ('success', 'fail') then
    raise exception 'Invalid completion result';
  end if;
  v_row := tracker_private.lock_participation(p_idea_id, auth.uid(), p_expected_revision);
  if v_row.status not in ('testing', 'completed') then raise exception 'Invalid status transition'; end if;
  if v_row.status = 'completed' and v_row.result = p_result
    and v_row.notes is not distinct from nullif(btrim(p_notes), '')
    and v_row.experiment_url is not distinct from nullif(btrim(p_experiment_url), '') then
    raise exception 'Result unchanged';
  end if;
  update public.idea_participants set status = 'completed', result = p_result,
    notes = nullif(btrim(p_notes), ''), experiment_url = nullif(btrim(p_experiment_url), ''),
    completed_at = clock_timestamp()
  where idea_id = p_idea_id and member_id = auth.uid() returning * into v_row;
  return v_row;
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

-- Stores the Markdown exactly as submitted. Repeating the same client request
-- ID returns the original comment instead of posting a duplicate.
create or replace function public.add_comment(p_idea_id uuid, p_body text, p_client_request_id uuid)
returns public.idea_comments language plpgsql security definer set search_path = '' as $$
declare v_comment public.idea_comments;
begin
  perform tracker_private.require_member();
  if p_client_request_id is null then raise exception 'Missing comment request ID'; end if;
  perform tracker_private.require_idea(p_idea_id);
  insert into public.idea_comments(idea_id, author_id, body, client_request_id)
  values (p_idea_id, auth.uid(), p_body, p_client_request_id)
  on conflict on constraint comment_request_once do nothing
  returning * into v_comment;
  if not found then
    select * into v_comment from public.idea_comments
    where author_id = auth.uid() and client_request_id = p_client_request_id;
    if v_comment.idea_id <> p_idea_id or v_comment.parent_comment_id is not null then
      raise exception 'Comment request ID already used';
    end if;
  end if;
  return v_comment;
end;
$$;

-- Reply to any comment or reply. The idea is taken from the parent, so a reply
-- can never be attached to another idea. Same idempotency as add_comment: the
-- same client request ID returns the original reply instead of a duplicate.
create or replace function public.reply_to_comment(p_parent_comment_id uuid, p_body text, p_client_request_id uuid)
returns public.idea_comments language plpgsql security definer set search_path = '' as $$
declare v_comment public.idea_comments; v_parent public.idea_comments; v_idea_id uuid;
begin
  perform tracker_private.require_member();
  if p_client_request_id is null then raise exception 'Missing comment request ID'; end if;
  select * into v_comment from public.idea_comments
  where author_id = auth.uid() and client_request_id = p_client_request_id;
  if found then
    if v_comment.parent_comment_id is distinct from p_parent_comment_id then
      raise exception 'Comment request ID already used';
    end if;
    return v_comment; -- an earlier attempt already succeeded
  end if;
  select idea_id into v_idea_id from public.idea_comments where id = p_parent_comment_id;
  if not found then raise exception 'Comment not found'; end if;
  perform tracker_private.require_idea(v_idea_id); -- parent idea before child rows
  select * into v_parent from public.idea_comments where id = p_parent_comment_id;
  if not found then raise exception 'Comment not found'; end if;
  if v_parent.removed_at is not null then raise exception 'Cannot reply to a removed comment'; end if;
  insert into public.idea_comments(idea_id, author_id, body, client_request_id, parent_comment_id)
  values (v_parent.idea_id, auth.uid(), p_body, p_client_request_id, p_parent_comment_id)
  on conflict on constraint comment_request_once do nothing
  returning * into v_comment;
  if not found then
    select * into v_comment from public.idea_comments
    where author_id = auth.uid() and client_request_id = p_client_request_id;
    if v_comment.parent_comment_id is distinct from p_parent_comment_id then
      raise exception 'Comment request ID already used';
    end if;
  end if;
  return v_comment;
end;
$$;

create or replace function public.remove_comment(p_comment_id uuid)
returns public.idea_comments language plpgsql security definer set search_path = '' as $$
declare v_comment public.idea_comments; v_role text;
begin
  v_role := tracker_private.require_member();
  select * into v_comment from public.idea_comments where id = p_comment_id;
  if not found then raise exception 'Comment not found'; end if;
  perform tracker_private.require_idea(v_comment.idea_id); -- parent before child
  if v_role <> 'pi' and v_comment.author_id is distinct from auth.uid() then
    raise exception using errcode = '42501', message = 'Permission denied';
  end if;
  update public.idea_comments set removed_at = clock_timestamp(), removed_by = auth.uid()
  where id = p_comment_id and removed_at is null returning * into v_comment;
  if not found then raise exception 'Comment not found'; end if;
  return v_comment;
end;
$$;

-- Apply exact signatures, not broad grants on every function in public.
revoke all on function tracker_private.member_role() from public, anon, authenticated;
revoke all on function tracker_private.require_member(boolean) from public, anon, authenticated;
revoke all on function tracker_private.current_actor() from public, anon, authenticated;
revoke all on function tracker_private.lock_idea(uuid, bigint, boolean) from public, anon, authenticated;
revoke all on function tracker_private.lock_participation(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function tracker_private.require_idea(uuid) from public, anon, authenticated;
revoke all on function tracker_private.touch_row() from public, anon, authenticated;
revoke all on function tracker_private.audit_idea() from public, anon, authenticated;
revoke all on function tracker_private.audit_participant() from public, anon, authenticated;
revoke all on function tracker_private.audit_comment() from public, anon, authenticated;
revoke all on function tracker_private.guard_comment_update() from public, anon, authenticated;
grant execute on function tracker_private.member_role() to authenticated;

revoke all on function public.create_idea(text, text, date, text) from public, anon, authenticated;
revoke all on function public.update_idea(uuid, bigint, text, text, date, text) from public, anon, authenticated;
revoke all on function public.delete_idea(uuid, bigint) from public, anon, authenticated;
revoke all on function public.join_idea(uuid) from public, anon, authenticated;
revoke all on function public.leave_idea(uuid, bigint) from public, anon, authenticated;
revoke all on function public.submit_result(uuid, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.reopen_result(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.add_comment(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.remove_comment(uuid) from public, anon, authenticated;
revoke all on function public.reply_to_comment(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.create_idea(text, text, date, text) to authenticated;
grant execute on function public.update_idea(uuid, bigint, text, text, date, text) to authenticated;
grant execute on function public.delete_idea(uuid, bigint) to authenticated;
grant execute on function public.join_idea(uuid) to authenticated;
grant execute on function public.leave_idea(uuid, bigint) to authenticated;
grant execute on function public.submit_result(uuid, bigint, text, text, text) to authenticated;
grant execute on function public.reopen_result(uuid, uuid, bigint) to authenticated;
grant execute on function public.add_comment(uuid, text, uuid) to authenticated;
grant execute on function public.remove_comment(uuid) to authenticated;
grant execute on function public.reply_to_comment(uuid, text, uuid) to authenticated;

-- Notifications are derived in the browser from idea_events; this table only
-- remembers, per member, the newest event they have seen, so read/unread is the
-- same on every device. Members can read only their own row and change it only
-- through mark_notifications_read, which never moves backwards.
create table if not exists public.notification_reads (
  member_id uuid primary key references public.profiles(id) on delete restrict,
  last_read_event_id bigint not null default 0 check (last_read_event_id >= 0),
  updated_at timestamptz not null default now()
);
alter table public.notification_reads enable row level security;
drop policy if exists members_read_own_notification_reads on public.notification_reads;
create policy members_read_own_notification_reads on public.notification_reads for select to authenticated
  using (member_id = auth.uid() and (select tracker_private.member_role()) is not null);
revoke all on public.notification_reads from public, anon, authenticated;
grant select on public.notification_reads to authenticated;

-- Marks everything up to p_last_event_id as read for the caller. The position
-- never moves backwards and never passes the newest existing event.
create or replace function public.mark_notifications_read(p_last_event_id bigint)
returns public.notification_reads language plpgsql security definer set search_path = '' as $$
declare v_row public.notification_reads; v_newest bigint;
begin
  perform tracker_private.require_member();
  if p_last_event_id is null or p_last_event_id < 0 then raise exception 'Invalid notification position'; end if;
  select coalesce(max(e.id), 0) into v_newest from public.idea_events e;
  insert into public.notification_reads(member_id, last_read_event_id, updated_at)
  values (auth.uid(), least(p_last_event_id, v_newest), clock_timestamp())
  on conflict (member_id) do update
    set last_read_event_id = greatest(public.notification_reads.last_read_event_id, excluded.last_read_event_id),
        updated_at = clock_timestamp()
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.mark_notifications_read(bigint) from public, anon, authenticated;
grant execute on function public.mark_notifications_read(bigint) to authenticated;

-- Existing members start with all current history marked as read, so the bell
-- does not open with the whole history as unread. Never overwrites a row.
insert into public.notification_reads(member_id, last_read_event_id)
select p.id, (select coalesce(max(e.id), 0) from public.idea_events e) from public.profiles p
on conflict (member_id) do nothing;

-- >>> shared: description limit (identical in supabase/schema.sql)
-- Descriptions hold whole Markdown documents: at most 1 MiB of UTF-8 text.
alter table public.ideas drop constraint if exists ideas_description_check;
alter table public.ideas add constraint ideas_description_check
  check (octet_length(description) <= 1048576);
-- <<< shared

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

-- Supabase Postgres Changes does not apply row-level RLS to DELETE events.
-- Publish only INSERT/UPDATE. Every participant, comment and deletion change
-- inserts an idea_events row in the same transaction, which Realtime authorizes
-- with SELECT RLS, so participant and comment tables need no publication.
-- Publication actions apply to EVERY member table. Fail closed if this existing
-- publication is shared; never silently change another application's event feed.
-- Requires PostgreSQL 15+ (schema-level publication catalog).
do $$
declare v_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime with (publish = 'insert, update');
  else
    if exists (select 1 from pg_publication
        where pubname = 'supabase_realtime' and puballtables)
      or exists (select 1 from pg_publication_namespace pn
        join pg_publication p on p.oid = pn.pnpubid
        where p.pubname = 'supabase_realtime')
      or exists (select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and not (schemaname = 'public' and tablename in ('profiles', 'ideas', 'idea_events'))) then
      raise exception using
        message = 'Refusing to change shared supabase_realtime publication',
        hint = 'Review publication tables, schema membership and consumers. Resolve shared usage before deploying; do not remove this guard or disable RLS.';
    end if;
    alter publication supabase_realtime set (publish = 'insert, update');
  end if;
  foreach v_table in array array['profiles', 'ideas', 'idea_events'] loop
    if not exists (select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end;
$$;

-- V1 upgrade only: confirm again, after the full V2 install, that the archived
-- V1 data and the profiles still match the backup and no Auth user changed.
do $$
begin
  if current_setting('tracker.v1_upgraded', true) = 'yes' then
    if tracker_private.v1_fingerprint('tracker_v1_archive') <> btrim(current_setting('tracker.v1_backup_fingerprint', true))
      or current_setting('tracker.v1_users_before', true) is distinct from
        (select coalesce(md5(string_agg(u.id::text, ',' order by u.id)), 'none') from auth.users u) then
      raise exception 'Post-install verification failed; rolled back';
    end if;
  end if;
end;
$$;
drop function tracker_private.v1_fingerprint(text);
drop function tracker_private.v1_line(jsonb);

notify pgrst, 'reload schema';
commit;
