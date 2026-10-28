// Development-only integration test. Never connects to the hosted project.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {randomUUID, randomBytes, createHash} from 'node:crypto';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
const require = createRequire(join(resolve(process.env.TRACKER_TEST_DEPS || '.'), 'package.json'));
const {default:EmbeddedPostgres} = await import(pathToFileURL(require.resolve('embedded-postgres')));
const directory = await mkdtemp(join(tmpdir(),'tracker-db-'));
const db = new EmbeddedPostgres({databaseDir:join(directory,'data'),user:'postgres',password:randomBytes(24).toString('hex'),
  port:Number(process.env.TRACKER_TEST_PORT || 55439),persistent:false,
  postgresFlags:['-c','listen_addresses=127.0.0.1','-c','wal_level=logical'],onLog:() => {},onError:() => {}});
const clients = [];
let checks = 0;
function check(actual, expected, label) { assert.deepEqual(actual, expected, label); checks++; }
async function rejects(fn, pattern, label) { await assert.rejects(fn,pattern,label); checks++; }
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
// Resolves to 'settled' if the promise finishes within the window, else 'pending'.
const settlesWithin = (promise,ms) => Promise.race([promise.then(() => 'settled',() => 'settled'),delay(ms).then(() => 'pending')]);
const users = Object.fromEntries(['Shibo','Yan','Junqi','Yifan','Outsider'].map(name => [name,randomUUID()]));
// Minimal stand-in for Supabase's auth schema (per database; roles are cluster-wide).
const authStub = `create schema auth; create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  grant usage on schema auth to anon,authenticated;
  grant execute on function auth.uid() to anon,authenticated;`;
const read = path => readFile(new URL(path,import.meta.url),'utf8');
try {
  await db.initialise(); await db.start();
  const admin = db.getPgClient(); await admin.connect(); clients.push(admin);
  await admin.query(`create role anon nologin; create role authenticated nologin; ${authStub}`);
  const [schema, exportSQL, dropArchiveSQL, v1Schema, repliesMigration, v20Schema, creatorDeleteMigration, notifyMigration, authorDeleteMigration, resultEditMigration, limitMigration, imagesMigration, archiveMigration, reopenMigration] = await Promise.all([read('../supabase/schema.sql'),read('../supabase/export_v1_backup.sql'),
    read('../supabase/drop_v1_archive.sql'),read('./fixtures/schema_v1.sql'),read('../supabase/migrations/add_comment_replies.sql'),read('./fixtures/schema_v2_0.sql'),read('../supabase/migrations/allow_creator_delete_untouched_idea.sql'),read('../supabase/migrations/add_notification_reads.sql'),read('../supabase/migrations/allow_comment_author_delete.sql'),read('../supabase/migrations/allow_member_update_result.sql'),read('../supabase/migrations/raise_description_limit.sql'),read('../supabase/migrations/add_comment_images.sql'),read('../supabase/migrations/add_idea_archive.sql'),read('../supabase/migrations/allow_member_reopen_own_result.sql')]);
  for (const [name,sql] of [['schema.sql',schema],['export',exportSQL],['archive cleanup',dropArchiveSQL],['replies migration',repliesMigration],['author deletion migration',authorDeleteMigration],['creator deletion migration',creatorDeleteMigration],['notification migration',notifyMigration],['result edit migration',resultEditMigration],['description limit migration',limitMigration],['comment image migration',imagesMigration],['archive migration',archiveMigration],['reopen migration',reopenMigration]]) {
    check(/```|\\[_*<>]|&(?:lt|gt);/.test(sql),false,`${name} is plain SQL, not escaped Markdown`);
    check(/\bcascade\b/i.test(sql.replace(/--.*$/gm,'')),false,`${name} uses no CASCADE`);
  }
  await admin.query(schema); await admin.query(schema); checks++; // fresh install, then repeatable rerun
  const descriptionLimit = async client => (await client.query("select pg_get_constraintdef(oid) d from pg_constraint where conrelid='public.ideas'::regclass and conname='ideas_description_check'")).rows.map(r => r.d);

  // ---- Catalog: publication, RLS, grants, no cascading foreign keys, no V1 objects.
  const publicationFlags = async (client = admin) => (await client.query(`select pubinsert, pubupdate, pubdelete, pubtruncate
    from pg_publication where pubname='supabase_realtime'`)).rows[0];
  const safeFlags = {pubinsert:true,pubupdate:true,pubdelete:false,pubtruncate:false};
  const publishedTables = async (client = admin) => (await client.query("select tablename from pg_publication_tables where pubname='supabase_realtime' order by tablename")).rows.map(r => r.tablename);
  check(await publicationFlags(),safeFlags,'publication publishes only INSERT/UPDATE');
  check(await publishedTables(),['idea_events','ideas','profiles'],'publication tables unchanged; participant/comment tables unpublished');
  check((await admin.query("select count(*)::int n from pg_class where relnamespace='public'::regnamespace and relkind='r' and relrowsecurity")).rows[0].n,6,'RLS on all six tables');
  check((await admin.query("select count(*)::int n from pg_constraint where contype='f' and connamespace='public'::regnamespace and confdeltype='c'")).rows[0].n,0,'no ON DELETE CASCADE foreign keys');
  check((await admin.query("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='ideas' and column_name in ('status','assigned_to','result','notes','experiment_url','completed_at')")).rows[0].n,0,'no single-assignee columns on ideas');
  check((await admin.query("select count(*)::int n from pg_proc where proname in ('claim_idea','release_idea','complete_idea','reopen_idea')")).rows[0].n,0,'no V1 RPCs');
  const rpcNames = ['create_idea','update_idea','delete_idea','join_idea','leave_idea','submit_result','reopen_result','add_comment','reply_to_comment','remove_comment','mark_notifications_read','archive_idea','unarchive_idea'];
  const acl = await admin.query(`select p.proname, has_function_privilege('anon',p.oid,'EXECUTE') as anon,
    has_function_privilege('authenticated',p.oid,'EXECUTE') as member, p.proconfig, p.prosecdef
    from pg_proc p where p.pronamespace='public'::regnamespace and p.proname = any($1)`,[rpcNames]);
  check(acl.rows.map(r => r.proname).sort(),[...rpcNames].sort(),'thirteen V2 RPCs');
  for (const fn of acl.rows) check([fn.anon,fn.member,fn.prosecdef,fn.proconfig.includes('search_path=""')],[false,true,true,true],`${fn.proname}: grants and fixed search path`);
  check((await admin.query("select pg_get_function_identity_arguments('public.submit_result'::regproc)")).rows[0].pg_get_function_identity_arguments,
    'p_idea_id uuid, p_expected_revision bigint, p_result text, p_notes text, p_experiment_url text','submit_result has no member parameter');

  for (const [name,id] of Object.entries(users)) {
    await admin.query('insert into auth.users values ($1)',[id]);
    if (name !== 'Outsider') await admin.query('insert into public.profiles(id,display_name,role) values ($1,$2,$3)',[id,name,name === 'Shibo' ? 'pi' : 'researcher']);
  }
  async function member(name, role = 'authenticated', database = 'postgres') {
    const client = db.getPgClient(database); await client.connect(); clients.push(client);
    await client.query(`set role ${role}`);
    await client.query("select set_config('request.jwt.claim.sub',$1,false)",[users[name] || '']);
    return client;
  }
  const shibo = await member('Shibo'), yan = await member('Yan'), junqi = await member('Junqi'), yifan = await member('Yifan');
  const outsider = await member('Outsider'), anon = await member(null,'anon');
  const rpc = async (client,name,args) => (await client.query(`select * from public.${name}(${args.map((_,i) => `$${i+1}`).join(',')})`,args)).rows[0];
  const create = (client,title = 'Isolated test idea') => rpc(client,'create_idea',[title,'Synthetic test description','2026-10-12','high']);
  const idea = async id => (await admin.query('select * from public.ideas where id=$1',[id])).rows[0];
  const part = async (id,name) => (await admin.query('select * from public.idea_participants where idea_id=$1 and member_id=$2',[id,users[name]])).rows[0];
  const events = async id => (await admin.query('select * from public.idea_events where idea_id=$1 order by id',[id])).rows;
  const tables = ['profiles','ideas','idea_participants','idea_comments','idea_events','notification_reads'];

  // ---- Member-only access.
  for (const table of tables) {
    await rejects(() => anon.query(`select * from public.${table}`),/permission denied/,`anonymous denied ${table}`);
    check((await outsider.query(`select * from public.${table}`)).rowCount,0,`outsider sees no ${table}`);
  }

  // ---- All four members create ideas; creator or PI edits; PI-only delete.
  const shiboIdea = await create(shibo,'Shared PI idea');
  const yanIdea = await create(yan,'Yan research idea');
  check([shiboIdea.created_by,yanIdea.created_by],[users.Shibo,users.Yan],'creator recorded from auth.uid()');
  for (const client of [junqi,yifan]) check((await create(client,'Researcher idea')).created_by !== undefined,true,'every researcher can create');
  for (const client of [shibo,yan,junqi,yifan]) check((await client.query('select * from public.ideas')).rowCount,4,'members read all ideas');
  await rejects(() => create(outsider),/Permission denied/,'outsider cannot create');
  await rejects(() => create(anon),/permission denied/,'anon cannot execute RPC');
  const edited = await rpc(yan,'update_idea',[yanIdea.id,yanIdea.revision,'Yan edited','Own edit','2026-10-19','low']);
  check([edited.title,edited.revision],['Yan edited','2'],'creator edits own idea');
  await rejects(() => rpc(junqi,'update_idea',[yanIdea.id,edited.revision,'Hijack','','2026-10-12','low']),/Permission denied/,'other researcher cannot edit');
  await rejects(() => rpc(yan,'update_idea',[shiboIdea.id,shiboIdea.revision,'Hijack','','2026-10-12','low']),/Permission denied/,'researcher cannot edit PI idea');
  const piEdited = await rpc(shibo,'update_idea',[yanIdea.id,edited.revision,'PI edited','Admin edit','2026-10-19','medium']);
  check(piEdited.title,'PI edited','PI edits any idea');
  await rejects(() => rpc(yan,'update_idea',[yanIdea.id,edited.revision,'Stale','','2026-10-12','low']),/Idea changed/,'stale edit rejected');
  await rejects(() => rpc(junqi,'delete_idea',[yanIdea.id,piEdited.revision]),/only the PI or the idea creator/,'researcher cannot delete another member\'s idea');
  await rejects(() => rpc(shibo,'create_idea',['Bad Monday','','2026-10-13','low']),/check constraint/,'Monday constraint');
  await rejects(() => create(shibo,'   '),/check constraint/,'blank title');
  await rejects(() => rpc(shibo,'create_idea',['Bad priority','','2026-10-12','urgent']),/check constraint/,'priority constraint');
  await rejects(() => admin.query("update public.profiles set role='pi' where id=$1",[users.Yan]),/check constraint/,'only Shibo may be PI');

  // ---- No direct writes, sequences or private helpers.
  const target = shiboIdea.id;
  await rejects(() => yan.query("insert into public.ideas(title,week_start,created_by) values ('x','2026-10-12',$1)",[users.Yan]),/permission denied/,'direct idea insert');
  await rejects(() => yan.query('insert into public.idea_participants(idea_id,member_id) values ($1,$2)',[target,users.Yan]),/permission denied/,'direct participation insert');
  await rejects(() => yan.query("insert into public.idea_comments(idea_id,author_id,body,client_request_id) values ($1,$2,'x',gen_random_uuid())",[target,users.Yan]),/permission denied/,'direct comment insert');
  await rejects(() => yan.query("insert into public.idea_events(idea_id,idea_number,event_type) values ($1,1,'joined')",[target]),/permission denied/,'forged event');
  await rejects(() => yan.query("update public.profiles set role='pi' where id=$1",[users.Yan]),/permission denied/,'role escalation');
  await rejects(() => yan.query('delete from public.idea_events'),/permission denied/,'immutable history');
  await rejects(() => yan.query("select nextval('public.ideas_idea_number_seq')"),/permission denied/,'identity sequence denied');
  await rejects(() => yan.query('select tracker_private.lock_participation($1,$2,1)',[target,users.Junqi]),/permission denied/,'private helper denied');

  // ---- Concurrent participation: different members never block each other.
  await yan.query('begin');
  const yanJoin = await rpc(yan,'join_idea',[target]);
  const junqiJoin = rpc(junqi,'join_idea',[target]);
  check(await settlesWithin(junqiJoin,3000),'settled','second member joins while the first join is uncommitted');
  await yan.query('commit');
  check([yanJoin.status,(await junqiJoin).status],['testing','testing'],'both members participate');
  await rejects(() => rpc(yan,'join_idea',[target]),/Already participating/,'duplicate join rejected');
  // The same member in two sessions: exactly one join succeeds.
  await yifan.query('begin');
  await rpc(yifan,'join_idea',[yanIdea.id]);
  const yifanTwin = await member('Yifan');
  const twinJoin = rpc(yifanTwin,'join_idea',[yanIdea.id]).then(value => ({value}),error => ({error}));
  check(await settlesWithin(twinJoin,300),'pending','same member second session waits on the unique key');
  await yifan.query('commit');
  check((await twinJoin).error?.message,'Already participating in this idea','same member cannot join twice concurrently');
  check((await admin.query('select count(*)::int n from public.idea_participants where idea_id=$1 and member_id=$2',[yanIdea.id,users.Yifan])).rows[0].n,1,'one participation row per member');

  // ---- Independent results submitted in parallel.
  let yanRow = await part(target,'Yan'), junqiRow = await part(target,'Junqi');
  await yan.query('begin');
  const yanResult = await rpc(yan,'submit_result',[target,yanRow.revision,'success','Yan notes','https://example.org/yan']);
  const junqiResult = rpc(junqi,'submit_result',[target,junqiRow.revision,'fail','Junqi notes',null]);
  check(await settlesWithin(junqiResult,3000),'settled','second result not blocked by first');
  await yan.query('commit');
  yanRow = await part(target,'Yan'); junqiRow = await part(target,'Junqi');
  check([yanRow.status,yanRow.result,yanRow.notes,yanRow.experiment_url],['completed','success','Yan notes','https://example.org/yan'],'Yan result stored');
  check([junqiRow.status,junqiRow.result,junqiRow.notes,(await junqiResult).result],['completed','fail','Junqi notes','fail'],'Junqi result stored independently');
  check(yanResult.member_id,users.Yan,'submit_result writes the caller row');

  // ---- No cross-user modification.
  await rejects(() => yan.query("update public.idea_participants set result='success' where member_id=$1",[users.Junqi]),/permission denied/,'direct cross-user update denied');
  await rejects(() => rpc(yan,'reopen_result',[target,users.Junqi,junqiRow.revision]),/Permission denied/,'researcher cannot reopen another result');
  await rejects(() => rpc(yan,'submit_result',[target,yanRow.revision,'success','Yan notes','https://example.org/yan']),/Result unchanged/,'identical resubmission is rejected');
  await rejects(() => rpc(yan,'leave_idea',[target,yanRow.revision]),/Invalid status transition/,'cannot leave after a result');
  await rejects(() => rpc(shibo,'submit_result',[target,1,'success',null,null]),/Participation not found/,'PI cannot submit into another row');
  check((await part(target,'Junqi')).result,'fail','Junqi result untouched by every attempt');
  const yifanRevision = (await part(yanIdea.id,'Yifan')).revision;
  await rejects(() => rpc(yifan,'submit_result',[yanIdea.id,yifanRevision,'maybe',null,null]),/Invalid completion result/,'result enum');
  await rejects(() => rpc(yifan,'submit_result',[yanIdea.id,yifanRevision,'success',null,'javascript:alert(1)']),/check constraint/,'URL scheme');
  await rejects(() => rpc(yifan,'submit_result',[yanIdea.id,999,'success',null,null]),/Participation changed/,'stale participation revision');

  // ---- PI reopens one result; others stay; history keeps the old result.
  const reopened = await rpc(shibo,'reopen_result',[target,users.Yan,yanRow.revision]);
  check([reopened.status,reopened.result,reopened.notes],['testing',null,null],'PI reopened Yan result');
  check((await part(target,'Junqi')).result,'fail','reopening Yan leaves Junqi intact');
  const reopenEvent = (await events(target)).at(-1);
  check([reopenEvent.event_type,reopenEvent.member_id,reopenEvent.actor_id,reopenEvent.previous_state.result,reopenEvent.previous_state.notes],
    ['result_reopened',users.Yan,users.Shibo,'success','Yan notes'],'previous result preserved in history');
  await rpc(yan,'submit_result',[target,reopened.revision,'fail','Second trial',null]);
  // A member may move their own result back to Testing, never someone else's.
  const ownBack = await rpc(yan,'reopen_result',[target,users.Yan,(await part(target,'Yan')).revision]);
  check([ownBack.status,ownBack.result,ownBack.notes],['testing',null,null],'member moves own result back to Testing');
  const ownBackEvent = (await events(target)).at(-1);
  check([ownBackEvent.event_type,ownBackEvent.actor_id,ownBackEvent.member_id,ownBackEvent.previous_state.result,ownBackEvent.previous_state.notes],
    ['result_reopened',users.Yan,users.Yan,'fail','Second trial'],'own reopen keeps the previous result in history');
  await rejects(() => rpc(yan,'reopen_result',[target,users.Yan,ownBack.revision]),/Invalid status transition/,'a Testing row cannot be reopened');
  await rejects(() => rpc(outsider,'reopen_result',[target,users.Junqi,junqiRow.revision]),/Permission denied/,'outsider cannot reopen');
  await rpc(yan,'submit_result',[target,ownBack.revision,'fail','Second trial',null]);

  // ---- A member changes their own completed result; history keeps both states.
  const secondTrial = await part(target,'Yan');
  const changed = await rpc(yan,'submit_result',[target,secondTrial.revision,'success','Second trial',null]);
  check([changed.status,changed.result,changed.notes,changed.member_id],['completed','success','Second trial',users.Yan],'member changes own result fail -> success');
  const changeEvent = (await events(target)).at(-1);
  check([changeEvent.event_type,changeEvent.actor_id,changeEvent.member_id,changeEvent.previous_state.result,changeEvent.new_state.result],
    ['participant_updated',users.Yan,users.Yan,'fail','success'],'result change recorded with both states');
  await rejects(() => rpc(yan,'submit_result',[target,secondTrial.revision,'fail',null,null]),/Participation changed/,'stale revision cannot overwrite a changed result');
  check((await part(target,'Junqi')).result,'fail','changing Yan result leaves Junqi intact');

  // ---- Leave and rejoin.
  const left = await rpc(yifan,'leave_idea',[yanIdea.id,(await part(yanIdea.id,'Yifan')).revision]);
  check(left.status,'withdrawn','member withdraws');
  const rejoined = await rpc(yifan,'join_idea',[yanIdea.id]);
  check(rejoined.status,'testing','member rejoins');
  check((await events(yanIdea.id)).filter(e => e.member_id === users.Yifan).map(e => e.event_type),['joined','withdrew','rejoined'],'participation history');

  // ---- Comments: verbatim Markdown, idempotent posting, PI removal.
  const markdown = '﻿## Thoughts\r\n\r\n$$\\alpha_i^2$$ and `code`\r\n- **bold**\r\n  ';
  const requestId = randomUUID();
  const comment = await rpc(yan,'add_comment',[target,markdown,requestId]);
  check([comment.body,comment.author_id,!!comment.created_at],[markdown,users.Yan,true],'comment stored verbatim with author and time');
  check((await rpc(yan,'add_comment',[target,markdown,requestId])).id,comment.id,'retried request returns the same comment');
  check((await admin.query('select count(*)::int n from public.idea_comments')).rows[0].n,1,'retry did not duplicate');
  await rejects(() => rpc(yan,'add_comment',[yanIdea.id,'other',requestId]),/already used/,'request ID cannot be reused on another idea');
  for (const client of [shibo,junqi,yifan]) await rpc(client,'add_comment',[target,'Member reply $x$',randomUUID()]);
  check((await yifan.query('select * from public.idea_comments where idea_id=$1',[target])).rowCount,4,'all members comment and read');
  await rejects(() => rpc(yan,'add_comment',[target,' \r\n\t ',randomUUID()]),/check constraint/,'whitespace-only comment rejected');
  await rejects(() => rpc(yan,'add_comment',[target,'x'.repeat(20481),randomUUID()]),/check constraint/,'oversized comment rejected');
  await rejects(() => rpc(yan,'add_comment',[randomUUID(),'x',randomUUID()]),/Idea not found/,'comment on missing idea');
  await rejects(() => rpc(outsider,'add_comment',[target,'x',randomUUID()]),/Permission denied/,'outsider cannot comment');
  await rejects(() => rpc(yan,'add_comment',[target,'x',null]),/Missing comment request ID/,'request ID required');
  await rejects(() => rpc(junqi,'remove_comment',[comment.id]),/Permission denied/,'researcher cannot remove another author comment');
  const removed = await rpc(shibo,'remove_comment',[comment.id]);
  check([removed.removed_by,!!removed.removed_at,removed.body],[users.Shibo,true,markdown],'PI removal hides but keeps original text');
  await rejects(() => rpc(shibo,'remove_comment',[comment.id]),/Comment not found/,'already removed');
  check((await events(target)).filter(e => ['commented','comment_removed'].includes(e.event_type)).length,5,'comment history recorded');

  // ---- Notification read state: own row only, never backwards, RPC-only writes.
  const newestEvent = async () => Number((await admin.query('select coalesce(max(id),0) n from public.idea_events')).rows[0].n);
  check((await yan.query('select * from public.notification_reads')).rowCount,0,'no read row before first use on a fresh install');
  const firstRead = await rpc(yan,'mark_notifications_read',[5]);
  check([firstRead.member_id,Number(firstRead.last_read_event_id)],[users.Yan,5],'member records a read position');
  check(Number((await rpc(yan,'mark_notifications_read',[2])).last_read_event_id),5,'read position never moves backwards');
  const newestNow = await newestEvent();
  check(Number((await rpc(yan,'mark_notifications_read',[newestNow + 1000])).last_read_event_id),newestNow,'read position cannot pass the newest event');
  await rpc(junqi,'mark_notifications_read',[1]);
  check((await yan.query('select member_id from public.notification_reads')).rows.map(r => r.member_id),[users.Yan],'members see only their own read state');
  check((await shibo.query('select member_id from public.notification_reads')).rowCount,0,'even the PI sees no one else\'s read state');
  await rejects(() => yan.query('update public.notification_reads set last_read_event_id=0'),/permission denied/,'no direct updates');
  await rejects(() => yan.query('insert into public.notification_reads(member_id) values ($1)',[users.Shibo]),/permission denied/,'no direct inserts');
  await rejects(() => yan.query('delete from public.notification_reads'),/permission denied/,'no direct deletes');
  for (const bad of [-1,null]) await rejects(() => rpc(yan,'mark_notifications_read',[bad]),/Invalid notification position/,`invalid position ${bad} rejected`);
  await rejects(() => rpc(outsider,'mark_notifications_read',[1]),/Permission denied/,'outsider cannot record a read position');
  await rejects(() => rpc(anon,'mark_notifications_read',[1]),/permission denied/,'anonymous cannot execute');
  // Two devices of the same member racing: the furthest position wins.
  const yanPhone = await member('Yan');
  await yan.query('begin');
  await rpc(yan,'mark_notifications_read',[newestNow]);
  const phoneRead = rpc(yanPhone,'mark_notifications_read',[3]);
  await yan.query('commit');
  check(Number((await phoneRead).last_read_event_id),newestNow,'a slower device cannot move the position back');

  // ---- Threaded replies: same-idea tree, immutability, idempotency, removed parents.
  const threadIdea = await create(shibo,'Threaded discussion');
  const otherIdea = await create(shibo,'Another idea');
  const root = await rpc(yan,'add_comment',[threadIdea.id,'Root comment',randomUUID()]);
  check(root.parent_comment_id,null,'add_comment creates a top-level comment');
  const replyRequest = randomUUID(), replyBody = '**Reply** with $x$ <img src=x onerror=alert(1)>\r\n';
  const reply = await rpc(junqi,'reply_to_comment',[root.id,replyBody,replyRequest]);
  check([reply.idea_id,reply.parent_comment_id,reply.author_id,reply.body],[threadIdea.id,root.id,users.Junqi,replyBody],'reply stored verbatim under its parent and idea');
  const chain = [reply];
  for (const [index,client] of [shibo,yifan,yan,junqi,shibo].entries()) chain.push(await rpc(client,'reply_to_comment',[chain.at(-1).id,`Level ${index + 2}`,randomUUID()]));
  check((await admin.query(`with recursive t as (select id, 0 d from public.idea_comments where id=$1
    union all select c.id, t.d + 1 from public.idea_comments c join t on c.parent_comment_id = t.id) select max(d)::int d from t`,[root.id])).rows[0].d,6,'six levels of nested replies');
  check((await rpc(junqi,'reply_to_comment',[root.id,'ignored',replyRequest])).id,reply.id,'retried reply returns the original');
  check((await admin.query('select count(*)::int n from public.idea_comments where client_request_id=$1',[replyRequest])).rows[0].n,1,'no duplicate reply');
  await rejects(() => rpc(junqi,'reply_to_comment',[chain[1].id,'x',replyRequest]),/already used/,'request ID cannot move to another parent');
  await rejects(() => rpc(junqi,'add_comment',[threadIdea.id,'x',replyRequest]),/already used/,'reply request ID cannot become a top-level comment');
  await rejects(() => rpc(yan,'reply_to_comment',[randomUUID(),'x',randomUUID()]),/Comment not found/,'reply to a missing comment');
  await rejects(() => rpc(outsider,'reply_to_comment',[root.id,'x',randomUUID()]),/Permission denied/,'outsider cannot reply');
  await rejects(() => rpc(anon,'reply_to_comment',[root.id,'x',randomUUID()]),/permission denied/,'anon cannot execute the reply RPC');
  await rejects(() => rpc(yan,'reply_to_comment',[root.id,' \n ',randomUUID()]),/check constraint/,'whitespace-only reply rejected');
  await rejects(() => rpc(yan,'reply_to_comment',[root.id,'x'.repeat(20481),randomUUID()]),/check constraint/,'oversized reply rejected');
  await rejects(() => rpc(yan,'reply_to_comment',[root.id,'x',null]),/Missing comment request ID/,'reply request ID required');
  // Cross-idea links and cycles are impossible, even for the database owner.
  const otherRoot = await rpc(yan,'add_comment',[otherIdea.id,'Other idea comment',randomUUID()]);
  await rejects(() => admin.query("insert into public.idea_comments(idea_id,author_id,body,client_request_id,parent_comment_id) values ($1,$2,'cross',gen_random_uuid(),$3)",[threadIdea.id,users.Yan,otherRoot.id]),/comment_parent_same_idea/,'parent must belong to the same idea');
  await rejects(() => admin.query("insert into public.idea_comments(idea_id,author_id,body,client_request_id,parent_comment_id) values ($1,$2,'orphan',gen_random_uuid(),gen_random_uuid())",[threadIdea.id,users.Yan]),/comment_parent_same_idea/,'parent must exist');
  const selfId = randomUUID();
  await rejects(() => admin.query("insert into public.idea_comments(id,idea_id,author_id,body,client_request_id,parent_comment_id) values ($1,$2,$3,'self',gen_random_uuid(),$1)",[selfId,threadIdea.id,users.Yan]),/comment_not_own_parent/,'a comment cannot be its own parent');
  await rejects(() => admin.query('update public.idea_comments set parent_comment_id=$1 where id=$2',[chain.at(-1).id,root.id]),/Comments are immutable/,'parent links cannot change, so no cycle can form');
  await rejects(() => admin.query("update public.idea_comments set body='edited' where id=$1",[reply.id]),/Comments are immutable/,'comment text is immutable');
  await rejects(() => yan.query("update public.idea_comments set parent_comment_id=null where id=$1",[reply.id]),/permission denied/,'clients cannot update comments');
  // Removing a parent keeps the thread.
  await rejects(() => rpc(junqi,'remove_comment',[root.id]),/Permission denied/,'researcher cannot remove another author parent');
  const rootRemoved = await rpc(yan,'remove_comment',[root.id]);
  check([rootRemoved.removed_by,rootRemoved.body],[users.Yan,root.body],'author soft-deletes own top-level comment');
  check((await admin.query('select count(*)::int n from public.idea_comments where idea_id=$1',[threadIdea.id])).rows[0].n,7,'removing a parent keeps every reply');
  await rejects(() => rpc(yifan,'reply_to_comment',[root.id,'x',randomUUID()]),/Cannot reply to a removed comment/,'no new replies to a removed comment');
  check((await rpc(yifan,'reply_to_comment',[reply.id,'Still possible under a removed parent',randomUUID()])).parent_comment_id,reply.id,'the thread under a removed parent stays usable');
  await rejects(() => admin.query('update public.idea_comments set removed_at=null, removed_by=null where id=$1',[root.id]),/Comments are immutable/,'a removal cannot be undone or edited');
  const replyEvents = (await events(threadIdea.id)).filter(e => e.event_type === 'commented' && e.new_state.parent_comment_id);
  check([replyEvents.length,replyEvents[0].new_state.parent_comment_id,replyEvents[0].actor_id],[7,root.id,users.Junqi],'replies recorded in activity history');
  // Each reply has its own author; owning an ancestor confers no deletion rights.
  const commentRow = async id => (await admin.query('select * from public.idea_comments where id=$1',[id])).rows[0];
  const nested = chain[4], nestedBefore = await commentRow(nested.id);
  const nestedJSON = async () => (await admin.query('select to_jsonb(c) snapshot from public.idea_comments c where id=$1',[nested.id])).rows[0].snapshot;
  const nestedJSONBefore = await nestedJSON();
  const threadBefore = (await admin.query('select * from public.idea_comments where idea_id=$1 order by id',[threadIdea.id])).rows;
  const historyBefore = await events(threadIdea.id);
  await rejects(() => rpc(yan,'remove_comment',[nested.id]),/Permission denied/,'ancestor author cannot delete another author nested reply');
  for (const denied of [anon,outsider]) await rejects(() => rpc(denied,'remove_comment',[nested.id]),/permission denied/i,'anonymous/nonmember cannot delete');
  for (const name of ['Junqi','Shibo']) {
    await admin.query('update public.profiles set active=false where id=$1',[users[name]]);
    await rejects(() => rpc(name === 'Junqi' ? junqi : shibo,'remove_comment',[nested.id]),/Permission denied/,'inactive author/PI cannot delete');
    await admin.query('update public.profiles set active=true where id=$1',[users[name]]);
  }
  await rejects(() => junqi.query('update public.idea_comments set removed_at=now(),removed_by=$1 where id=$2',[users.Junqi,nested.id]),/permission denied/,'author cannot bypass RPC with direct update');
  await rejects(() => shibo.query('delete from public.idea_comments where id=$1',[nested.id]),/permission denied/,'PI cannot physically delete comments');
  await rejects(() => junqi.query('delete from public.idea_comments where id=$1',[nested.id]),/permission denied/,'author cannot physically delete comments');
  check(await commentRow(nested.id),nestedBefore,'denied requests do not change comment');
  check(await events(threadIdea.id),historyBefore,'denied requests add no history');
  const nestedRemoved = await rpc(junqi,'remove_comment',[nested.id]);
  check({...nestedRemoved,removed_at:null,removed_by:null},nestedBefore,'nested author removal changes only removal metadata');
  check(nestedRemoved.removed_by,users.Junqi,'nested author attributed from Auth identity');
  check((await admin.query('select * from public.idea_comments where idea_id=$1 and id<>$2 order by id',[threadIdea.id,nested.id])).rows,
    threadBefore.filter(c=>c.id!==nested.id),'nested deletion leaves all ancestors and descendants byte-for-byte intact');
  const removalEvent = (await events(threadIdea.id)).at(-1);
  check([removalEvent.event_type,removalEvent.actor_id,removalEvent.previous_state,removalEvent.new_state],
    ['comment_removed',users.Junqi,nestedJSONBefore,await nestedJSON()],'author deletion audits full before/after state');
  await rejects(() => rpc(junqi,'remove_comment',[nested.id]),/Comment not found/,'repeat author deletion rejected');
  check((await events(threadIdea.id)).length,historyBefore.length+1,'repeated removal adds no audit');
  await rejects(() => rpc(yan,'remove_comment',[randomUUID()]),/Comment not found/,'missing comment deletion rejected');
  // Concurrent author/PI deletion commits exactly one row update and audit event.
  const raceComment = await rpc(yan,'add_comment',[threadIdea.id,'Removal race',randomUUID()]);
  const beforeRaceEvents = (await events(threadIdea.id)).length;
  await yan.query('begin');
  const winner = await rpc(yan,'remove_comment',[raceComment.id]);
  const piRace = rpc(shibo,'remove_comment',[raceComment.id]).then(value=>({value}),error=>({error}));
  check(await settlesWithin(piRace,300),'pending','PI waits for concurrent author deletion');
  await yan.query('commit');
  check((await piRace).error?.message,'Comment not found','concurrent second deletion is rejected');
  check(await commentRow(raceComment.id),winner,'first deletion actor/time preserved');
  check((await events(threadIdea.id)).length,beforeRaceEvents+1,'one concurrent deletion audit');
  // Two members reply to the same comment at the same time.
  await yan.query('begin');
  await rpc(yan,'reply_to_comment',[reply.id,'Concurrent A',randomUUID()]);
  const concurrentReply = rpc(junqi,'reply_to_comment',[reply.id,'Concurrent B',randomUUID()]);
  check(await settlesWithin(concurrentReply,3000),'settled','a second member replies while the first reply is uncommitted');
  await yan.query('commit');
  check((await admin.query("select count(*)::int n from public.idea_comments where parent_comment_id=$1 and body like 'Concurrent%'",[reply.id])).rows[0].n,2,'both concurrent replies stored');
  // Deleting the idea removes the whole tree in one statement and snapshots it.
  await rpc(shibo,'delete_idea',[threadIdea.id,(await idea(threadIdea.id)).revision]);
  const treeSnapshot = (await events(threadIdea.id)).at(-1).previous_state.comments;
  check([treeSnapshot.length,treeSnapshot.filter(c => c.parent_comment_id).length,(await admin.query('select count(*)::int n from public.idea_comments where idea_id=$1',[threadIdea.id])).rows[0].n],
    [11,9,0],'deletion snapshot keeps the whole reply tree');

  // ---- Deactivated members lose access; their results remain attributed.
  await admin.query('update public.profiles set active=false where id=$1',[users.Junqi]);
  for (const table of tables) check((await junqi.query(`select * from public.${table}`)).rowCount,0,`deactivated member cannot read ${table}`);
  await rejects(() => rpc(junqi,'add_comment',[target,'x',randomUUID()]),/Permission denied/,'deactivated member cannot comment');
  check((await part(target,'Junqi')).result,'fail','deactivated member result retained');
  await admin.query('update public.profiles set active=true where id=$1',[users.Junqi]);

  // ---- Realtime: every change reaches subscribers as an idea_events INSERT.
  await admin.query("select * from pg_create_logical_replication_slot('tracker_realtime_test','pgoutput')");
  const streamIdea = await create(shibo,'Publication stream test');
  const streamJoin = await rpc(junqi,'join_idea',[streamIdea.id]);
  await rpc(junqi,'submit_result',[streamIdea.id,streamJoin.revision,'success',null,null]);
  await rpc(yan,'add_comment',[streamIdea.id,'Stream comment',randomUUID()]);
  await rpc(shibo,'delete_idea',[streamIdea.id,streamIdea.revision]);
  const messages = (await admin.query(`select data from pg_logical_slot_get_binary_changes(
    'tracker_realtime_test',null,null,'proto_version','1','publication_names','supabase_realtime')`)).rows.map(r => r.data);
  await admin.query("select pg_drop_replication_slot('tracker_realtime_test')");
  const oid = async table => (await admin.query(`select '${table}'::regclass::oid as oid`)).rows[0].oid;
  const [ideaOid,eventOid,partOid,commentOid] = await Promise.all(['public.ideas','public.idea_events','public.idea_participants','public.idea_comments'].map(oid));
  const rowMessages = messages.filter(data => [73,85,68].includes(data[0]));
  check(messages.some(data => data[0] === 68),false,'no DELETE message in logical replication output');
  check(rowMessages.filter(data => data[0] === 73 && data.readUInt32BE(1) === eventOid).length,5,'created/joined/result/comment/deleted all published as event INSERTs');
  check(rowMessages.some(data => [partOid,commentOid].includes(data.readUInt32BE(1))),false,'participant/comment rows themselves are not published');
  check(rowMessages.some(data => data[0] === 73 && data.readUInt32BE(1) === ideaOid),true,'idea INSERT published');

  // ---- Deletion snapshots all participant results and comments; no cascades.
  const beforeDelete = await idea(target);
  await rejects(() => rpc(yan,'delete_idea',[target,beforeDelete.revision]),/Permission denied/,'researcher cannot delete');
  // A comment in flight holds the idea; deletion waits and then includes it.
  await yifan.query('begin');
  await rpc(yifan,'add_comment',[target,'Posted during deletion',randomUUID()]);
  const deletion = rpc(shibo,'delete_idea',[target,beforeDelete.revision]);
  check(await settlesWithin(deletion,300),'pending','deletion waits for the in-flight comment');
  await yifan.query('commit'); await deletion;
  check(await idea(target),undefined,'idea deleted');
  check((await admin.query('select (select count(*) from public.idea_participants where idea_id=$1)::int p, (select count(*) from public.idea_comments where idea_id=$1)::int c',[target])).rows[0],{p:0,c:0},'children removed explicitly');
  const deletedEvent = (await events(target)).at(-1);
  check(deletedEvent.event_type,'deleted','deletion event');
  check(deletedEvent.previous_state.participants.map(p => [p.member_id,p.result]).sort(),[[users.Junqi,'fail'],[users.Yan,'success']].sort(),'deleted snapshot keeps every participant result');
  check(deletedEvent.previous_state.comments.length,5,'deleted snapshot keeps every comment, including removed and late ones');
  check(deletedEvent.previous_state.comments.some(c => c.body === markdown && c.removed_by === users.Shibo),true,'removed comment original preserved');
  await rejects(() => rpc(yan,'join_idea',[target]),/Idea not found/,'cannot join a deleted idea');
  for (const observer of [shibo,yan]) check((await observer.query('select * from public.idea_events where idea_id=$1',[target])).rowCount > 0,true,'history readable after deletion');
  const next = await create(shibo);
  check(Number(next.idea_number) > Number(streamIdea.idea_number),true,'idea numbers never reused');

  // ---- Deleting ideas: the PI any idea; the creator only an untouched one.
  const emptyOwn = await create(yan,'Yan empty idea');
  await rejects(() => rpc(junqi,'delete_idea',[emptyOwn.id,emptyOwn.revision]),/only the PI or the idea creator/,'another researcher cannot delete it');
  await rejects(() => rpc(outsider,'delete_idea',[emptyOwn.id,emptyOwn.revision]),/Permission denied/,'outsider cannot delete it');
  await rpc(yan,'delete_idea',[emptyOwn.id,emptyOwn.revision]);
  const ownDeleted = (await events(emptyOwn.id)).at(-1);
  check([await idea(emptyOwn.id),ownDeleted.event_type,ownDeleted.actor_id,ownDeleted.previous_state.title,ownDeleted.previous_state.participants,ownDeleted.previous_state.comments],
    [undefined,'deleted',users.Yan,'Yan empty idea',[],[]],'creator deletes an untouched idea; deletion audited');
  for (const [label,contribute] of [
    ['a participant',async id => { await rpc(junqi,'join_idea',[id]); }],
    ['a withdrawn participant',async id => { const row = await rpc(junqi,'join_idea',[id]); await rpc(junqi,'leave_idea',[id,row.revision]); }],
    ['the creator\'s own result',async id => { const row = await rpc(yan,'join_idea',[id]); await rpc(yan,'submit_result',[id,row.revision,'fail',null,null]); }],
    ['a comment',async id => { await rpc(junqi,'add_comment',[id,'Feedback',randomUUID()]); }],
    ['a removed comment',async id => { const comment = await rpc(yan,'add_comment',[id,'Own note',randomUUID()]); await rpc(yan,'remove_comment',[comment.id]); }]]) {
    const own = await create(yan,`Yan idea with ${label}`);
    await contribute(own.id);
    const revision = (await idea(own.id)).revision;
    await rejects(() => rpc(yan,'delete_idea',[own.id,revision]),/already has participants or comments; only the PI can delete it/,`creator cannot delete an idea with ${label}`);
    check((await idea(own.id))?.title,`Yan idea with ${label}`,`idea with ${label} kept`);
  }
  // The PI deletes an idea with contributions; the audit snapshot is complete.
  const rich = await create(yan,'Yan idea with contributions');
  const richJoin = await rpc(junqi,'join_idea',[rich.id]);
  await rpc(junqi,'submit_result',[rich.id,richJoin.revision,'success','Rich result','https://example.org/rich']);
  const richComment = await rpc(yifan,'add_comment',[rich.id,'Rich comment',randomUUID()]);
  await rpc(yan,'reply_to_comment',[richComment.id,'Rich reply',randomUUID()]);
  const richHistoryBefore = (await events(rich.id)).length;
  await rpc(shibo,'delete_idea',[rich.id,(await idea(rich.id)).revision]);
  const richEvents = await events(rich.id), richSnapshot = richEvents.at(-1).previous_state;
  check([richEvents.length,richEvents.at(-1).actor_id],[richHistoryBefore + 1,users.Shibo],'earlier history kept, deletion appended');
  check([richSnapshot.created_by,richSnapshot.participants.map(p => [p.member_id,p.result,p.notes,p.experiment_url]),richSnapshot.comments.map(c => [c.body,c.parent_comment_id === richComment.id])],
    [users.Yan,[[users.Junqi,'success','Rich result','https://example.org/rich']],[['Rich comment',false],['Rich reply',true]]],'PI deletion snapshot keeps results, comments and replies');
  check((await admin.query('select (select count(*) from public.idea_participants where idea_id=$1)::int p, (select count(*) from public.idea_comments where idea_id=$1)::int c',[rich.id])).rows[0],{p:0,c:0},'no orphaned participants, results or comments');
  // Creator deletion racing a join or comment, in both orders.
  for (const [label,contribute] of [['join',id => rpc(junqi,'join_idea',[id])],['comment',id => rpc(junqi,'add_comment',[id,'Racing comment',randomUUID()])]]) {
    const first = await create(yan,`Race: ${label} first`);
    await junqi.query('begin');
    await contribute(first.id);
    const refused = rpc(yan,'delete_idea',[first.id,first.revision]).then(value => ({value}),error => ({error}));
    check(await settlesWithin(refused,300),'pending',`${label} first: the creator's deletion waits`);
    await junqi.query('commit');
    check((await refused).error?.message,'Permission denied: this idea already has participants or comments; only the PI can delete it',`${label} first: deletion refused once it commits`);
    check((await idea(first.id))?.id,first.id,`${label} first: idea kept`);
    const second = await create(yan,`Race: deletion before ${label}`);
    await yan.query('begin');
    await rpc(yan,'delete_idea',[second.id,second.revision]);
    const late = contribute(second.id).then(value => ({value}),error => ({error}));
    check(await settlesWithin(late,300),'pending',`deletion first: the ${label} waits`);
    await yan.query('commit');
    check((await late).error?.message,'Idea not found',`deletion first: the ${label} is rejected`);
    check((await admin.query('select (select count(*) from public.idea_participants where idea_id=$1)::int p, (select count(*) from public.idea_comments where idea_id=$1)::int c',[second.id])).rows[0],{p:0,c:0},`deletion first: no orphaned ${label}`);
  }
  // Correcting a broken Markdown upload keeps the idea, its number and its history.
  const broken = await rpc(yan,'create_idea',['Truncated upload','# Truncated\n\n| a | b |\n|---','2026-10-12','high']);
  const corrected = await rpc(yan,'update_idea',[broken.id,broken.revision,'Corrected upload','# Corrected\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n$x^2$','2026-10-12','high']);
  check([corrected.id,corrected.idea_number,corrected.created_by,corrected.created_at,corrected.revision],[broken.id,broken.idea_number,users.Yan,broken.created_at,'2'],'editing keeps the identifier, number, creator and creation time');
  const correction = (await events(broken.id)).at(-1);
  check([correction.event_type,correction.previous_state.description,Number(correction.new_state.idea_number)],['edited','# Truncated\n\n| a | b |\n|---',Number(broken.idea_number)],'history keeps the incomplete Markdown');
  // Idea numbers beyond 999 are plain bigints: numeric order, no truncation.
  for (const n of [999,1000,10000]) await admin.query("insert into public.ideas(idea_number,title,week_start,created_by) overriding system value values ($1,$2,'2026-10-12',$3)",[n,`Number ${n}`,users.Shibo]);
  check((await yan.query("select idea_number from public.ideas where title like 'Number %' order by idea_number")).rows.map(r => r.idea_number),['999','1000','10000'],'numeric order beyond 999');
  const big = (await admin.query('select * from public.ideas where idea_number=10000')).rows[0];
  await rpc(junqi,'join_idea',[big.id]);
  check((await events(big.id)).map(e => [e.event_type,e.idea_number]),[['created','10000'],['joined','10000']],'five-digit ideas work end to end');

  // ---- Parent-before-child lock order: deletion vs. every child change, in both orders.
  // child first: the deletion must wait, then snapshot the committed change.
  // deletion first: the change must wait, then fail because the idea is gone.
  const shiboDeleter = await member('Shibo'); // separate PI session that performs the deletions
  const deletedSnapshot = async id => (await events(id)).find(e => e.event_type === 'deleted').previous_state;
  const raceCases = [
    {name:'submit_result',client:yan,
      prepare:async id => { await rpc(yan,'join_idea',[id]); },
      change:async id => rpc(yan,'submit_result',[id,(await part(id,'Yan')).revision,'success','Concurrent result',null]),
      committed:s => s.participants.some(p => p.member_id === users.Yan && p.result === 'success' && p.notes === 'Concurrent result'),
      untouched:s => s.participants.some(p => p.member_id === users.Yan && p.status === 'testing')},
    {name:'leave_idea',client:junqi,
      prepare:async id => { await rpc(junqi,'join_idea',[id]); },
      change:async id => rpc(junqi,'leave_idea',[id,(await part(id,'Junqi')).revision]),
      committed:s => s.participants.some(p => p.member_id === users.Junqi && p.status === 'withdrawn'),
      untouched:s => s.participants.some(p => p.member_id === users.Junqi && p.status === 'testing')},
    {name:'reopen_result',client:shibo,
      prepare:async id => { const row = await rpc(yifan,'join_idea',[id]); await rpc(yifan,'submit_result',[id,row.revision,'fail','Before reopen',null]); },
      change:async id => rpc(shibo,'reopen_result',[id,users.Yifan,(await part(id,'Yifan')).revision]),
      committed:s => s.participants.some(p => p.member_id === users.Yifan && p.status === 'testing' && p.result === null),
      untouched:s => s.participants.some(p => p.member_id === users.Yifan && p.result === 'fail' && p.notes === 'Before reopen')},
    {name:'remove_comment',client:shibo,
      prepare:async id => { await rpc(yan,'add_comment',[id,'Comment under race',randomUUID()]); },
      change:async id => rpc(shibo,'remove_comment',[(await admin.query('select id from public.idea_comments where idea_id=$1',[id])).rows[0].id]),
      committed:s => s.comments.some(c => c.body === 'Comment under race' && c.removed_by === users.Shibo),
      untouched:s => s.comments.some(c => c.body === 'Comment under race' && c.removed_at === null)},
    {name:'author remove_comment',client:yan,
      prepare:async id => { await rpc(yan,'add_comment',[id,'Author comment under race',randomUUID()]); },
      change:async id => rpc(yan,'remove_comment',[(await admin.query('select id from public.idea_comments where idea_id=$1',[id])).rows[0].id]),
      committed:s => s.comments.some(c => c.body === 'Author comment under race' && c.removed_by === users.Yan),
      untouched:s => s.comments.some(c => c.body === 'Author comment under race' && c.removed_at === null)},
    {name:'reply_to_comment',client:junqi,
      prepare:async id => { await rpc(yan,'add_comment',[id,'Parent under race',randomUUID()]); },
      change:async id => rpc(junqi,'reply_to_comment',[(await admin.query('select id from public.idea_comments where idea_id=$1',[id])).rows[0].id,'Reply under race',randomUUID()]),
      committed:s => s.comments.some(c => c.body === 'Reply under race' && c.parent_comment_id),
      untouched:s => !s.comments.some(c => c.body === 'Reply under race')},
  ];
  for (const race of raceCases) {
    const first = await create(shibo,`${race.name} before deletion`); await race.prepare(first.id);
    await race.client.query('begin');
    await race.change(first.id);
    const deletion = rpc(shiboDeleter,'delete_idea',[first.id,(await idea(first.id)).revision]);
    check(await settlesWithin(deletion,300),'pending',`${race.name} first: deletion waits for the uncommitted change`);
    await race.client.query('commit'); await deletion;
    check(race.committed(await deletedSnapshot(first.id)),true,`${race.name} first: deletion snapshot includes the committed change`);
    check(await idea(first.id),undefined,`${race.name} first: idea deleted afterwards`);

    const second = await create(shibo,`${race.name} after deletion`); await race.prepare(second.id);
    await shiboDeleter.query('begin');
    await rpc(shiboDeleter,'delete_idea',[second.id,(await idea(second.id)).revision]);
    const late = race.change(second.id).then(value => ({value}),error => ({error}));
    check(await settlesWithin(late,300),'pending',`${race.name} second: change waits for the uncommitted deletion`);
    await shiboDeleter.query('commit');
    check((await late).error?.message,'Idea not found',`${race.name} second: change after deletion is rejected`);
    check(race.untouched(await deletedSnapshot(second.id)),true,`${race.name} second: snapshot holds the state the deletion saw`);
  }
  // Parent KEY SHARE locks do not serialize members, comments or idea edits.
  const shared = await create(shibo,'Concurrent different participants');
  for (const client of [yan,junqi]) await rpc(client,'join_idea',[shared.id]);
  const junqiShared = await part(shared.id,'Junqi');
  await yan.query('begin');
  await rpc(yan,'submit_result',[shared.id,(await part(shared.id,'Yan')).revision,'success',null,null]);
  check(await settlesWithin(rpc(junqi,'submit_result',[shared.id,junqiShared.revision,'fail',null,null]),3000),'settled','another participant submits while a result is in flight');
  check(await settlesWithin(rpc(yifan,'add_comment',[shared.id,'Concurrent comment',randomUUID()]),3000),'settled','comments are not blocked by an in-flight result');
  check(await settlesWithin(rpc(shibo,'update_idea',[shared.id,shared.revision,'Edited during a submission','','2026-10-12','low']),3000),'settled','idea edits are not blocked by an in-flight result');
  await yan.query('commit');
  check([(await part(shared.id,'Yan')).result,(await part(shared.id,'Junqi')).result,(await idea(shared.id)).title],['success','fail','Edited during a submission'],'all concurrent changes kept');

  // ---- Archive: creator or PI, optional reason, no joins while archived, reversible.
  const dead = await create(yan,'Idea that did not work');
  await rpc(junqi,'join_idea',[dead.id]);
  await rejects(() => rpc(junqi,'archive_idea',[dead.id,dead.revision,null]),/only the PI or the idea creator can archive/,'participant cannot archive another member\'s idea');
  await rejects(() => rpc(outsider,'archive_idea',[dead.id,dead.revision,null]),/Permission denied/,'outsider cannot archive');
  await rejects(() => rpc(anon,'archive_idea',[dead.id,dead.revision,null]),/permission denied/,'anon cannot archive');
  const archived = await rpc(yan,'archive_idea',[dead.id,dead.revision,'  Baseline already beats it  ']);
  check([archived.archived_by,archived.archive_reason,archived.archived_at !== null,Number(archived.revision)],[users.Yan,'Baseline already beats it',true,Number(dead.revision) + 1],'creator archives with a trimmed reason');
  await rejects(() => rpc(yan,'archive_idea',[dead.id,dead.revision,null]),/Idea changed/,'stale archive rejected');
  await rejects(() => rpc(yan,'archive_idea',[dead.id,archived.revision,null]),/Idea already archived/,'cannot archive twice');
  await rejects(() => rpc(yifan,'join_idea',[dead.id]),/This idea is archived/,'nobody can join an archived idea');
  await rpc(junqi,'leave_idea',[dead.id,(await part(dead.id,'Junqi')).revision]);
  await rejects(() => rpc(junqi,'join_idea',[dead.id]),/This idea is archived/,'nobody can rejoin an archived idea');
  check((await rpc(yifan,'add_comment',[dead.id,'Why it failed',randomUUID()])).idea_id,dead.id,'archived ideas keep their discussion open');
  const archivedEdit = await rpc(yan,'update_idea',[dead.id,archived.revision,'Idea that did not work (notes)','','2026-10-12','low']);
  check([archivedEdit.archived_at !== null,archivedEdit.archive_reason],[true,'Baseline already beats it'],'editing an archived idea keeps it archived');
  await rejects(() => rpc(junqi,'unarchive_idea',[dead.id,archivedEdit.revision]),/only the PI or the idea creator can restore/,'others cannot restore');
  const restored = await rpc(shibo,'unarchive_idea',[dead.id,archivedEdit.revision]);
  check([restored.archived_at,restored.archived_by,restored.archive_reason],[null,null,null],'PI restores any idea');
  await rejects(() => rpc(shibo,'unarchive_idea',[dead.id,restored.revision]),/Idea is not archived/,'cannot restore an active idea');
  check((await rpc(junqi,'join_idea',[dead.id])).status,'testing','a restored idea can be joined again');
  check((await events(dead.id)).map(e => e.event_type).filter(t => ['archived','edited','unarchived'].includes(t)),['archived','edited','unarchived'],'archive and restore have their own history events');
  check((await events(dead.id)).find(e => e.event_type === 'archived').new_state.archive_reason,'Baseline already beats it','the reason stays in history after restoring');
  const blank = await rpc(shibo,'archive_idea',[restored.id,restored.revision,'   ']);
  check(blank.archive_reason,null,'a blank reason is stored as no reason');
  const yanRevision = (await idea(yanIdea.id)).revision;
  await rejects(() => rpc(shibo,'archive_idea',[yanIdea.id,yanRevision,'x'.repeat(2001)]),/idea_archive_state/,'reason limited to 2000 characters');
  await rejects(() => admin.query('update public.ideas set archived_at=now() where id=$1',[yanIdea.id]),/idea_archive_state/,'archive columns stay consistent');
  // Join and archive race: whichever commits first wins, never both silently.
  const raced = await create(shibo,'Archive while someone joins');
  await yan.query('begin');
  await rpc(yan,'join_idea',[raced.id]);
  const archiving = rpc(shiboDeleter,'archive_idea',[raced.id,raced.revision,null]);
  check(await settlesWithin(archiving,300),'pending','archive waits for an uncommitted join');
  await yan.query('commit'); await archiving;
  check((await part(raced.id,'Yan')).status,'testing','the earlier join is kept');
  const raced2 = await create(shibo,'Join while archiving');
  await shiboDeleter.query('begin');
  await rpc(shiboDeleter,'archive_idea',[raced2.id,raced2.revision,null]);
  const lateJoin = rpc(yan,'join_idea',[raced2.id]).then(value => ({value}),error => ({error}));
  check(await settlesWithin(lateJoin,300),'pending','a join waits for an uncommitted archive');
  await shiboDeleter.query('commit');
  check((await lateJoin).error?.message,'This idea is archived','a join after the archive is refused');

  // ---- Rerun keeps all V2 data.
  const counts = async () => (await admin.query('select (select count(*) from public.ideas)::int i,(select count(*) from public.idea_participants)::int p,(select count(*) from public.idea_comments)::int c,(select count(*) from public.idea_events)::int e')).rows[0];
  const beforeRerun = await counts();
  await admin.query(schema);
  check(await counts(),beforeRerun,'schema rerun preserves V2 data');
  check(await publicationFlags(),safeFlags,'rerun keeps INSERT/UPDATE-only publication');
  check((await admin.query("select to_regprocedure('tracker_private.v1_fingerprint(text)') f, to_regclass('tracker_v1_archive.ideas') a")).rows[0],{f:null,a:null},'no upgrade helpers or archive on a fresh install');

  // ---- V1 → V2: mandatory verified backup, then ONE transaction.
  await admin.query('create database v1_upgrade');
  const v1 = db.getPgClient('v1_upgrade'); await v1.connect(); clients.push(v1);
  await v1.query(authStub);
  await v1.query(v1Schema);
  for (const [name,id] of Object.entries(users)) {
    await v1.query('insert into auth.users values ($1)',[id]);
    if (name !== 'Outsider') await v1.query('insert into public.profiles(id,display_name,role) values ($1,$2,$3)',[id,name,name === 'Shibo' ? 'pi' : 'researcher']);
  }
  // Realistic V1 history: IDEA-001 with long Markdown, a claimed+completed idea, and a deleted idea.
  const asMember = name => v1.query("select set_config('request.jwt.claim.sub',$1,false)",[users[name] || '']);
  const idea001 = '﻿# IDEA-001 synthetic Markdown\r\n\r\n| a | b |\r\n|---|---|\r\n| $x_i$ | **bold** |\r\n\r\n$$\r\n\\frac{a}{b}\r\n$$\r\n\r\n```py\r\nprint("$x$")\r\n```\r\n' + 'é😀 '.repeat(3000);
  await asMember('Shibo');
  await v1.query("insert into public.ideas(title,description,week_start,created_by) values ('IDEA-001 synthetic',$1,'2026-10-12',$2)",[idea001,users.Shibo]);
  await v1.query("insert into public.ideas(title,description,week_start,created_by,priority) values ('Second V1 idea','Second','2026-10-19',$1,'low')",[users.Shibo]);
  await v1.query("insert into public.ideas(title,week_start,created_by) values ('Deleted V1 idea','2026-10-12',$1)",[users.Shibo]);
  await asMember('Yan');
  await v1.query("update public.ideas set status='testing', assigned_to=$1 where idea_number=2",[users.Yan]);
  await v1.query("update public.ideas set status='completed', result='fail', notes='V1 notes', experiment_url='https://example.org/v1', completed_at=now() where idea_number=2");
  await asMember('Shibo');
  await v1.query('delete from public.ideas where idea_number=3');
  await asMember(null);
  const v1Counts = (await v1.query('select (select count(*) from public.ideas)::int i, (select count(*) from public.idea_events)::int e')).rows[0];
  check(v1Counts,{i:2,e:6},'V1 fixture: two ideas and six history events');

  // Read-only export: runs inside a READ ONLY transaction.
  const runExport = async (sql = exportSQL) => {
    await v1.query('begin transaction read only');
    try { return (await v1.query(sql)).rows[0]; } finally { await v1.query('rollback'); }
  };
  const exported = await runExport();
  check([exported.profiles,exported.ideas,exported.events].map(Number),[4,2,6],'export counts');
  check([exported.idea_001_title,Number(exported.idea_001_description_bytes),exported.idea_001_description_md5],
    ['IDEA-001 synthetic',Buffer.byteLength(idea001,'utf8'),createHash('md5').update(idea001,'utf8').digest('hex')],'IDEA-001 summary');
  const backupIdea001 = exported.backup.ideas.find(i => i.idea_number === '1');
  check([backupIdea001.description,backupIdea001.created_by],[idea001,users.Shibo],'complete Markdown and author exported verbatim');
  check(exported.backup.ideas.find(i => i.idea_number === '2').notes,'V1 notes','metadata exported');
  check(exported.backup.idea_events.map(e => e.event_type),['created','created','created','claimed','completed','deleted'],'complete activity history exported');
  check(exported.backup.idea_events.filter(e => e.actor_id).map(e => e.actor_id),[users.Shibo,users.Shibo,users.Shibo,users.Yan,users.Yan,users.Shibo],'history attribution exported');
  check(JSON.parse(exported.backup.idea_events.at(-1).previous_state).title,'Deleted V1 idea','deleted-idea snapshot exported');

  // Offline verification of the saved file with the real script.
  const verifier = fileURLToPath(new URL('../tools/verify_v1_backup.mjs',import.meta.url));
  const backupDir = await mkdtemp(join(tmpdir(),'tracker-backup-'));
  const verify = async (content,fingerprint = exported.fingerprint) => {
    const path = join(backupDir,`backup-${randomUUID()}.json`); await writeFile(path,content);
    return new Promise(done => execFile(process.execPath,[verifier,path,fingerprint],(error,stdout,stderr) => done({code:error ? error.code : 0,stdout,stderr})));
  };
  try {
    const raw = JSON.stringify(exported.backup);
    const ok = await verify(raw);
    check([ok.code,ok.stdout.includes(exported.fingerprint),ok.stdout.includes('IDEA-001'),ok.stdout.includes(exported.idea_001_description_md5)],[0,true,true,true],'verifier accepts the exported backup');
    check((await verify(JSON.stringify([exported]))).code,0,'verifier accepts a SQL Editor JSON result');
    check((await verify(`fingerprint,backup\n${exported.fingerprint},"${raw.replaceAll('"','""')}"\n`)).code,0,'verifier accepts a SQL Editor CSV result');
    const tampered = structuredClone(exported.backup);
    tampered.ideas.find(i => i.idea_number === '1').description = idea001.replace('synthetic','synthetiC');
    const altered = await verify(JSON.stringify(tampered));
    check([altered.code,altered.stderr.includes('altered or corrupted')],[1,true],'one changed character is detected');
    const missing = structuredClone(exported.backup); missing.idea_events.pop(); missing.counts.idea_events = 5;
    check((await verify(JSON.stringify(missing))).code,1,'a missing history event is detected');
    check((await verify(raw.slice(0,-200))).code,1,'a truncated file is rejected');
    check((await verify(raw,'0'.repeat(32))).code,1,'a different fingerprint is rejected');
  } finally { await rm(backupDir,{recursive:true,force:true}); }

  // Upgrade refusals and failures leave V1 exactly as it was.
  const withFingerprint = fingerprint => schema.replace("set_config('tracker.v1_backup_fingerprint', '', true)",`set_config('tracker.v1_backup_fingerprint', '${fingerprint}', true)`);
  check(withFingerprint('x') !== schema,true,'fingerprint line present in schema.sql');
  const isV1 = async () => (await v1.query("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='ideas' and column_name='assigned_to'")).rows[0].n === 1;
  const v1Intact = async (fingerprint,label) => {
    check([await isV1(),(await runExport()).fingerprint],[true,fingerprint],`${label}: V1 data identical`);
    check((await v1.query("select to_regnamespace('tracker_v1_archive') a, to_regclass('public.idea_participants') p, to_regprocedure('public.claim_idea(uuid)') is not null c")).rows[0],{a:null,p:null,c:true},`${label}: no archive, no V2, V1 RPCs present`);
    check(await publishedTables(v1),['idea_events','ideas','profiles'],`${label}: V1 publication unchanged`);
  };
  await rejects(() => v1.query(schema),/verified backup is required/,'upgrade refuses without a backup fingerprint');
  await v1.query('rollback');
  await v1Intact(exported.fingerprint,'no fingerprint');
  await v1.query("update public.ideas set title = title || ' (edited after backup)' where idea_number = 2");
  await rejects(() => v1.query(withFingerprint(exported.fingerprint)),/does not match the backup fingerprint/,'upgrade refuses when data changed after the backup');
  await v1.query('rollback');
  const current = await runExport();
  check(current.fingerprint !== exported.fingerprint,true,'changed data needs a new backup');
  await v1Intact(current.fingerprint,'stale fingerprint');
  const failing = withFingerprint(current.fingerprint).replace("notify pgrst, 'reload schema';","select 1/0;");
  check(failing !== withFingerprint(current.fingerprint),true,'failure injected after the full V2 install');
  await rejects(() => v1.query(failing),/division by zero/,'late failure aborts the upgrade');
  await v1.query('rollback');
  await v1Intact(current.fingerprint,'failed upgrade');

  // Successful single-transaction upgrade.
  const profileRows = async () => (await v1.query('select * from public.profiles order by id')).rows;
  const authRows = async () => (await v1.query('select * from auth.users order by id')).rows;
  const [profilesBefore,authBefore] = [await profileRows(),await authRows()];
  await v1.query(withFingerprint(current.fingerprint));
  check(await isV1(),false,'public schema is V2 after the upgrade');
  const archiveExport = exportSQL.replaceAll('public.ideas','tracker_v1_archive.ideas').replaceAll('public.idea_events','tracker_v1_archive.idea_events');
  check((await runExport(archiveExport)).fingerprint,current.fingerprint,'archived V1 data identical to the verified backup');
  check((await v1.query('select description from tracker_v1_archive.ideas where idea_number=1')).rows[0].description,idea001,'IDEA-001 Markdown preserved in the archive');
  check(await profileRows(),profilesBefore,'profiles identical after the upgrade');
  check(await authRows(),authBefore,'auth users identical after the upgrade');
  check((await v1.query(`select to_regprocedure('public.claim_idea(uuid)') c, to_regprocedure('tracker_private.lock_idea(uuid,bigint)') l,
    to_regprocedure('tracker_private.touch_idea()') t, to_regprocedure('tracker_private.v1_fingerprint(text)') f`)).rows[0],{c:null,l:null,t:null,f:null},'V1 functions and upgrade helpers removed');
  check(await publishedTables(v1),['idea_events','ideas','profiles'],'V2 tables published; archive not published');
  check((await v1.query("select count(*)::int n from pg_publication_tables where schemaname='tracker_v1_archive'")).rows[0].n,0,'archive absent from Realtime');
  const v1Yan = await member('Yan','authenticated','v1_upgrade');
  await rejects(() => v1Yan.query('select * from tracker_v1_archive.ideas'),/permission denied/,'members cannot read the archive');
  const firstV2 = await create(v1Yan,'First V2 idea');
  check([firstV2.idea_number,(await rpc(v1Yan,'join_idea',[firstV2.id])).status],['1','testing'],'existing member works on V2; numbering starts fresh');
  await v1.query(withFingerprint(current.fingerprint));
  check((await v1.query('select count(*)::int n from public.ideas')).rows[0].n,1,'rerun after the upgrade is a no-op for data');

  // Optional archive removal, much later: explicit confirmation, profiles untouched.
  await rejects(() => v1.query(dropArchiveSQL),/not confirmed/,'archive removal requires confirmation');
  await v1.query('rollback');
  const confirmedDrop = dropArchiveSQL.replace("set_config('tracker.confirm_drop_v1_archive', 'no', true)","set_config('tracker.confirm_drop_v1_archive', 'yes', true)");
  check(confirmedDrop !== dropArchiveSQL,true,'archive confirmation line present');
  await v1.query(confirmedDrop);
  check([(await v1.query("select to_regnamespace('tracker_v1_archive') a")).rows[0].a,await profileRows()],[null,profilesBefore],'archive removed; profiles unchanged');
  await rejects(() => v1.query(confirmedDrop),/No V1 archive found/,'archive removal is not repeatable');
  await v1.query('rollback');


  // ---- Replies migration on a database built from the deployed V2 schema.
  await admin.query('create database v2_replies');
  const live = db.getPgClient('v2_replies'); await live.connect(); clients.push(live);
  await live.query(authStub);
  await live.query(v20Schema);
  for (const [name,id] of Object.entries(users)) {
    await live.query('insert into auth.users values ($1)',[id]);
    if (name !== 'Outsider') await live.query('insert into public.profiles(id,display_name,role) values ($1,$2,$3)',[id,name,name === 'Shibo' ? 'pi' : 'researcher']);
  }
  const [liveShibo,liveYan,liveJunqi] = await Promise.all(['Shibo','Yan','Junqi'].map(name => member(name,'authenticated','v2_replies')));
  const liveIdea = await create(liveShibo,'Live idea with data');
  const liveJoin = await rpc(liveYan,'join_idea',[liveIdea.id]);
  await rpc(liveYan,'submit_result',[liveIdea.id,liveJoin.revision,'success','Live result',null]);
  await rpc(liveJunqi,'join_idea',[liveIdea.id]);
  const liveComment = await rpc(liveYan,'add_comment',[liveIdea.id,'Existing **comment** $x$',randomUUID()]);
  const removedLive = await rpc(liveJunqi,'add_comment',[liveIdea.id,'Existing removed comment',randomUUID()]);
  await rpc(liveShibo,'remove_comment',[removedLive.id]);
  const gone = await create(liveShibo,'Deleted live idea');
  await rpc(liveYan,'add_comment',[gone.id,'Comment on a deleted idea',randomUUID()]);
  await rpc(liveShibo,'delete_idea',[gone.id,gone.revision]);
  const liveState = async () => (await live.query(`select
    (select md5(string_agg(to_jsonb(i)::text, ',' order by i.id)) from public.ideas i) ideas,
    (select md5(string_agg(to_jsonb(p)::text, ',' order by p.idea_id, p.member_id)) from public.idea_participants p) participants,
    (select md5(string_agg((to_jsonb(c) - 'parent_comment_id')::text, ',' order by c.id)) from public.idea_comments c) comments,
    (select md5(string_agg(to_jsonb(e)::text, ',' order by e.id)) from public.idea_events e) events,
    (select md5(string_agg(to_jsonb(p)::text, ',' order by p.id)) from public.profiles p) profiles,
    (select md5(string_agg(u.id::text, ',' order by u.id)) from auth.users u) users`)).rows[0];
  const beforeMigration = await liveState();
  check((await live.query("select to_regprocedure('public.reply_to_comment(uuid,text,uuid)') r")).rows[0].r,null,'deployed V2 has no reply RPC yet');
  await live.query(repliesMigration);
  check(await liveState(),beforeMigration,'migration preserves ideas, results, comments, removals, history, profiles and users');
  check((await live.query('select count(*)::int n from public.idea_comments where parent_comment_id is not null')).rows[0].n,0,'existing comments become top-level');
  const liveReply = await rpc(liveJunqi,'reply_to_comment',[liveComment.id,'First reply after migration',randomUUID()]);
  check([liveReply.parent_comment_id,liveReply.idea_id],[liveComment.id,liveIdea.id],'replies work after the migration');
  check((await rpc(liveYan,'add_comment',[liveIdea.id,'Old-style call',randomUUID()])).parent_comment_id,null,'existing add_comment calls keep working');
  await rejects(() => rpc(liveYan,'reply_to_comment',[removedLive.id,'x',randomUUID()]),/Cannot reply to a removed comment/,'migrated removed comments stay closed');
  check((await live.query("select event_type, new_state->>'parent_comment_id' p from public.idea_events order by id desc limit 2")).rows.map(r => [r.event_type,r.p]),
    [['commented',null],['commented',liveComment.id]],'replies reach activity history and the Realtime source');
  const beforeRerun2 = await liveState();
  await live.query(repliesMigration);
  check(await liveState(),beforeRerun2,'rerunning the migration changes nothing');
  // The migrated and the freshly installed databases define identical comment objects.
  const commentCatalog = async client => (await client.query(`select
    (select string_agg(conname || ':' || pg_get_constraintdef(oid), ' | ' order by conname) from pg_constraint where conrelid = 'public.idea_comments'::regclass) constraints,
    (select string_agg(indexdef, ' | ' order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'idea_comments') indexes,
    (select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = 'public.idea_comments'::regclass and not tgisinternal) triggers,
    (select string_agg(column_name || ' ' || data_type || ' ' || is_nullable, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'idea_comments') columns,
    (select string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || has_function_privilege('authenticated',p.oid,'EXECUTE') || has_function_privilege('anon',p.oid,'EXECUTE'), ',' order by p.proname)
      from pg_proc p where p.proname in ('add_comment','reply_to_comment','remove_comment','guard_comment_update','audit_comment','delete_idea')) functions`)).rows[0];
  // ---- Incremental author-delete migration on the deployed schema + replies.
  const liveGrandchild = await rpc(liveYan,'reply_to_comment',[liveReply.id,'Existing grandchild',randomUUID()]);
  const dataSnapshot = async () => ({...await liveState(),comments:(await live.query('select * from public.idea_comments order by id')).rows});
  const policySnapshot = async () => (await live.query(`select policyname, cmd, roles, qual, with_check from pg_policies
    where schemaname='public' order by tablename,policyname`)).rows;
  const beforeAuthorMigration = await dataSnapshot(), beforeAuthorCatalog = await commentCatalog(live), beforePolicies = await policySnapshot();
  await rejects(() => rpc(liveYan,'remove_comment',[liveComment.id]),/Permission denied/,'old deployed RPC denies even the author');
  // Prove an error rolls back the replacement and ACL together.
  await rejects(() => live.query(authorDeleteMigration.replace(/commit;\s*$/i,()=>"do $$ begin raise exception 'Injected migration failure'; end; $$; commit;")),/Injected migration failure/,'author migration is transactional');
  await live.query('rollback');
  check(await commentCatalog(live),beforeAuthorCatalog,'failed migration restores old function and grants');
  check(await dataSnapshot(),beforeAuthorMigration,'failed migration preserves all data');
  await live.query(authorDeleteMigration);
  check(await dataSnapshot(),beforeAuthorMigration,'author migration preserves every row, parent link, result, removal and event');
  check(await policySnapshot(),beforePolicies,'SELECT-only RLS policies unchanged');
  check((await live.query(`select relrowsecurity rls,
    has_table_privilege('authenticated',oid,'UPDATE') u, has_table_privilege('authenticated',oid,'DELETE') d,
    has_table_privilege('authenticated',oid,'INSERT') i, has_table_privilege('anon',oid,'SELECT') a
    from pg_class where oid='public.idea_comments'::regclass`)).rows[0],{rls:true,u:false,d:false,i:false,a:false},'migration does not open direct writes or anonymous reads');
  await live.query(authorDeleteMigration);
  check(await dataSnapshot(),beforeAuthorMigration,'repeating author migration preserves all data');
  // ---- Creator-delete migration on the deployed schema + both earlier migrations.
  const liveOwn = await create(liveYan,'Live untouched idea by Yan');
  await rejects(() => rpc(liveYan,'delete_idea',[liveOwn.id,liveOwn.revision]),/Permission denied/,'deployed RPC: creators cannot delete yet');
  const beforeCreatorMigration = await dataSnapshot(), deleteDefinition = async () => (await live.query("select md5(pg_get_functiondef('public.delete_idea(uuid,bigint)'::regprocedure)) d")).rows[0].d;
  const oldDeleteDefinition = await deleteDefinition();
  await rejects(() => live.query(creatorDeleteMigration.replace(/commit;\s*$/i,()=>"do $$ begin raise exception 'Injected migration failure'; end; $$; commit;")),/Injected migration failure/,'creator migration is transactional');
  await live.query('rollback');
  check([await deleteDefinition(),await dataSnapshot()],[oldDeleteDefinition,beforeCreatorMigration],'failed creator migration restores the old function and changes no data');
  await live.query(creatorDeleteMigration);
  check(await dataSnapshot(),beforeCreatorMigration,'creator migration preserves every row, result, comment and event');
  check(await policySnapshot(),beforePolicies,'RLS policies unchanged by the creator migration');
  await live.query(creatorDeleteMigration);
  check(await dataSnapshot(),beforeCreatorMigration,'repeating the creator migration preserves all data');
  check(await commentCatalog(live),await commentCatalog(admin),'migrated and freshly installed comment schemas are identical');
  await rejects(() => rpc(liveJunqi,'remove_comment',[liveComment.id]),/Permission denied/,'migrated RPC rejects other authors');
  const liveDeleted = await rpc(liveYan,'remove_comment',[liveComment.id]);
  check([liveDeleted.removed_by,liveDeleted.body],[users.Yan,liveComment.body],'migrated author deletes pre-existing comment');
  check((await live.query('select * from public.idea_comments where id=$1',[liveReply.id])).rows[0],liveReply,'pre-existing reply stays intact after parent deletion');
  const liveDeletedReply = await rpc(liveJunqi,'remove_comment',[liveReply.id]);
  check([liveDeletedReply.removed_by,liveDeletedReply.parent_comment_id],[users.Junqi,liveComment.id],'migrated author deletes own pre-existing reply');
  check((await live.query('select * from public.idea_comments where id=$1',[liveGrandchild.id])).rows[0],liveGrandchild,'pre-existing grandchild stays intact');
  check((await rpc(liveShibo,'remove_comment',[liveGrandchild.id])).removed_by,users.Shibo,'migrated PI still deletes another author reply');
  // ---- Result-edit migration on the deployed schema + earlier migrations.
  const resultIdea = await create(liveShibo,'Live result to correct');
  const resultJoin = await rpc(liveJunqi,'join_idea',[resultIdea.id]);
  const liveFail = await rpc(liveJunqi,'submit_result',[resultIdea.id,resultJoin.revision,'fail','Deployed fail',null]);
  await rejects(() => rpc(liveJunqi,'submit_result',[resultIdea.id,liveFail.revision,'success',null,null]),/Invalid status transition/,'deployed RPC: completed results are final');
  const submitDefinition = async client => (await client.query(`select md5(pg_get_functiondef('public.submit_result(uuid,bigint,text,text,text)'::regprocedure))
    || has_function_privilege('authenticated','public.submit_result(uuid,bigint,text,text,text)','EXECUTE')
    || has_function_privilege('anon','public.submit_result(uuid,bigint,text,text,text)','EXECUTE') d`)).rows[0].d;
  const beforeResultMigration = await dataSnapshot(), oldSubmitDefinition = await submitDefinition(live);
  await rejects(() => live.query(resultEditMigration.replace(/commit;\s*$/i,()=>"do $$ begin raise exception 'Injected migration failure'; end; $$; commit;")),/Injected migration failure/,'result-edit migration is transactional');
  await live.query('rollback');
  check([await submitDefinition(live),await dataSnapshot()],[oldSubmitDefinition,beforeResultMigration],'failed result-edit migration restores the old function and changes no data');
  await live.query(resultEditMigration);
  check(await dataSnapshot(),beforeResultMigration,'result-edit migration preserves every row, result and event');
  check(await policySnapshot(),beforePolicies,'RLS policies unchanged by the result-edit migration');
  await live.query(resultEditMigration);
  check(await dataSnapshot(),beforeResultMigration,'repeating the result-edit migration preserves all data');
  check(await submitDefinition(live),await submitDefinition(admin),'migrated and freshly installed submit_result are identical');
  const liveSuccess = await rpc(liveJunqi,'submit_result',[resultIdea.id,liveFail.revision,'success','Deployed fail',null]);
  check([liveSuccess.status,liveSuccess.result,liveSuccess.notes],['completed','success','Deployed fail'],'migrated RPC: member changes a pre-existing result');
  await rejects(() => rpc(liveYan,'submit_result',[resultIdea.id,liveSuccess.revision,'fail',null,null]),/Participation not found/,'migrated RPC: no one else can change it');
  // ---- Description-limit migration (100 KiB -> 1 MiB) on the deployed schema + every earlier migration.
  const limitIdea = await create(liveShibo,'Live idea before the limit change');
  const overOld = 'é'.repeat(51201); // 102,402 bytes: just over the deployed 100 KiB limit
  await rejects(() => rpc(liveYan,'create_idea',['Too large for the deployed limit',overOld,'2026-10-12','low']),/ideas_description_check/,'deployed schema: 100 KiB limit in force');
  const beforeLimitMigration = await dataSnapshot(), oldLimit = await descriptionLimit(live);
  await rejects(() => live.query(limitMigration.replace(/commit;\s*$/i,()=>"do $$ begin raise exception 'Injected migration failure'; end; $$; commit;")),/Injected migration failure/,'description-limit migration is transactional');
  await live.query('rollback');
  check([await descriptionLimit(live),await dataSnapshot()],[oldLimit,beforeLimitMigration],'failed description-limit migration keeps the old limit and all data');
  await live.query(limitMigration);
  check(await dataSnapshot(),beforeLimitMigration,'description-limit migration preserves every row, result, comment and event');
  check(await policySnapshot(),beforePolicies,'RLS policies unchanged by the description-limit migration');
  await live.query(limitMigration);
  check(await dataSnapshot(),beforeLimitMigration,'repeating the description-limit migration preserves all data');
  check([await descriptionLimit(live),(await descriptionLimit(live))[0].includes('1048576')],[await descriptionLimit(admin),true],'migrated and freshly installed description limits are identical (1 MiB)');
  const atLimit = 'é'.repeat(524287) + 'xx'; // exactly 1,048,576 UTF-8 bytes
  const bigIdea = await rpc(liveYan,'create_idea',['Large Markdown idea',atLimit,'2026-10-12','low']);
  check((await live.query('select octet_length(description) n, description = $2 same from public.ideas where id=$1',[bigIdea.id,atLimit])).rows[0],{n:1048576,same:true},'migrated: exactly 1 MiB stored verbatim');
  await rejects(() => rpc(liveYan,'create_idea',['One byte too large',atLimit + 'x','2026-10-12','low']),/ideas_description_check/,'migrated: 1 MiB + 1 byte rejected');
  const grown = await rpc(liveShibo,'update_idea',[limitIdea.id,limitIdea.revision,limitIdea.title,overOld,'2026-10-12','high']);
  check(Number(grown.revision),Number(limitIdea.revision) + 1,'migrated: an existing idea can grow beyond 100 KiB');
  check((await live.query("select new_state->>'description' = $2 same from public.idea_events where idea_id=$1 and event_type='edited' order by id desc limit 1",[limitIdea.id,overOld])).rows[0].same,true,'history keeps the full larger description');
  await rejects(() => rpc(liveShibo,'update_idea',[limitIdea.id,grown.revision,limitIdea.title,atLimit + 'x','2026-10-12','high']),/ideas_description_check/,'migrated: edits above 1 MiB rejected');
  // ---- Archive migration on the deployed schema + every earlier migration.
  const archiveCatalog = async client => (await client.query(`select
    (select string_agg(column_name || ' ' || data_type || ' ' || is_nullable, ',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='ideas') columns,
    (select string_agg(conname || ':' || pg_get_constraintdef(oid), ' | ' order by conname) from pg_constraint where conrelid in ('public.ideas'::regclass,'public.idea_events'::regclass)) constraints,
    (select string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || has_function_privilege('authenticated',p.oid,'EXECUTE') || has_function_privilege('anon',p.oid,'EXECUTE'), ',' order by p.proname)
      from pg_proc p where p.proname in ('archive_idea','unarchive_idea','join_idea','audit_idea')) functions`)).rows[0];
  // Existing ideas gain three null columns; everything else must stay byte-identical.
  const archiveData = async () => ({...await dataSnapshot(),ideas:(await live.query(`select md5(string_agg((to_jsonb(i) - 'archived_at' - 'archived_by' - 'archive_reason')::text, ',' order by i.id)) h from public.ideas i`)).rows[0].h});
  const beforeArchiveMigration = await archiveData(), oldArchiveCatalog = await archiveCatalog(live);
  check((await live.query("select to_regprocedure('public.archive_idea(uuid,bigint,text)') r")).rows[0].r,null,'deployed V2 has no archive RPC yet');
  await rejects(() => live.query(archiveMigration.replace(/commit;\s*$/i,()=>"do $$ begin raise exception 'Injected migration failure'; end; $$; commit;")),/Injected migration failure/,'archive migration is transactional');
  await live.query('rollback');
  check([await archiveCatalog(live),await archiveData()],[oldArchiveCatalog,beforeArchiveMigration],'failed archive migration changes no column, function or data');
  await live.query(archiveMigration);
  check(await archiveData(),beforeArchiveMigration,'archive migration preserves every idea, result, comment and event');
  check((await live.query('select count(*)::int n from public.ideas where archived_at is not null or archived_by is not null or archive_reason is not null')).rows[0].n,0,'existing ideas stay active');
  check(await policySnapshot(),beforePolicies,'RLS policies unchanged by the archive migration');
  await live.query(archiveMigration);
  check(await archiveData(),beforeArchiveMigration,'repeating the archive migration preserves all data');
  check(await archiveCatalog(live),await archiveCatalog(admin),'migrated and freshly installed archive columns, constraints and functions are identical');
  const liveArchived = await rpc(liveShibo,'archive_idea',[limitIdea.id,grown.revision,'Superseded']);
  check([liveArchived.archive_reason,liveArchived.archived_by],['Superseded',users.Shibo],'migrated RPC archives a pre-existing idea');
  await rejects(() => rpc(liveYan,'join_idea',[limitIdea.id]),/This idea is archived/,'migrated join_idea refuses archived ideas');
  await rejects(() => rpc(liveYan,'unarchive_idea',[limitIdea.id,liveArchived.revision]),/only the PI or the idea creator can restore/,'migrated: only creator or PI restores');
  const liveRestored = await rpc(liveShibo,'unarchive_idea',[limitIdea.id,liveArchived.revision]);
  check((await live.query("select event_type from public.idea_events where idea_id=$1 order by id desc limit 2",[limitIdea.id])).rows.map(r => r.event_type),['unarchived','archived'],'migrated history records archive and restore');
  check((await rpc(liveYan,'join_idea',[limitIdea.id])).status,'testing','migrated: a restored idea can be joined');
  check(liveRestored.archived_at,null,'migrated RPC restores the idea');
  // ---- Own-reopen migration on the deployed schema + every earlier migration.
  const reopenDefinition = async client => (await client.query(`select md5(pg_get_functiondef('public.reopen_result(uuid,uuid,bigint)'::regprocedure))
    || has_function_privilege('authenticated','public.reopen_result(uuid,uuid,bigint)','EXECUTE')
    || has_function_privilege('anon','public.reopen_result(uuid,uuid,bigint)','EXECUTE') d`)).rows[0].d;
  const junqiDone = await live.query('select revision from public.idea_participants where idea_id=$1 and member_id=$2',[resultIdea.id,users.Junqi]);
  await rejects(() => rpc(liveJunqi,'reopen_result',[resultIdea.id,users.Junqi,junqiDone.rows[0].revision]),/Permission denied/,'deployed RPC: only the PI reopens');
  const beforeReopenMigration = await dataSnapshot(), oldReopenDefinition = await reopenDefinition(live);
  await rejects(() => live.query(reopenMigration.replace(/commit;\s*$/i,()=>"do $$ begin raise exception 'Injected migration failure'; end; $$; commit;")),/Injected migration failure/,'reopen migration is transactional');
  await live.query('rollback');
  check([await reopenDefinition(live),await dataSnapshot()],[oldReopenDefinition,beforeReopenMigration],'failed reopen migration restores the old function and changes no data');
  await live.query(reopenMigration);
  check(await dataSnapshot(),beforeReopenMigration,'reopen migration preserves every row, result and event');
  check(await policySnapshot(),beforePolicies,'RLS policies unchanged by the reopen migration');
  await live.query(reopenMigration);
  check(await dataSnapshot(),beforeReopenMigration,'repeating the reopen migration preserves all data');
  check(await reopenDefinition(live),await reopenDefinition(admin),'migrated and freshly installed reopen_result are identical');
  await rejects(() => rpc(liveYan,'reopen_result',[resultIdea.id,users.Junqi,junqiDone.rows[0].revision]),/Permission denied/,'migrated RPC: others still cannot reopen');
  check((await rpc(liveJunqi,'reopen_result',[resultIdea.id,users.Junqi,junqiDone.rows[0].revision])).status,'testing','migrated RPC: member moves a pre-existing result back to Testing');
  const afterAuthorDeletes = await dataSnapshot();
  await live.query(authorDeleteMigration);
  check(await dataSnapshot(),afterAuthorDeletes,'rerun preserves removals and history');
  await live.query(schema);
  check(await dataSnapshot(),afterAuthorDeletes,'running the full schema.sql afterwards changes nothing');
  // Behaviour after the creator migration, on pre-existing data.
  const liveOwnRevision = (await live.query('select revision from public.ideas where id=$1',[liveOwn.id])).rows[0].revision;
  await rejects(() => rpc(liveJunqi,'delete_idea',[liveOwn.id,liveOwnRevision]),/only the PI or the idea creator/,'migrated RPC: others cannot delete');
  await rpc(liveYan,'delete_idea',[liveOwn.id,liveOwnRevision]);
  check((await live.query('select count(*)::int n from public.ideas where id=$1',[liveOwn.id])).rows[0].n,0,'migrated RPC: creator deletes an untouched idea');
  const liveIdeaRevision = (await live.query('select revision from public.ideas where id=$1',[liveIdea.id])).rows[0].revision;
  await rpc(liveShibo,'delete_idea',[liveIdea.id,liveIdeaRevision]);
  const liveSnapshot = (await live.query("select previous_state from public.idea_events where idea_id=$1 and event_type='deleted'",[liveIdea.id])).rows[0].previous_state;
  check([liveSnapshot.participants.length,liveSnapshot.comments.length >= 4,liveSnapshot.comments.some(c => c.parent_comment_id)],[2,true,true],'migrated PI deletion snapshots pre-existing results, comments and replies');
  // ---- Notification migration on a database built exactly like the deployed notifyDb.
  await admin.query('create database v2_notify');
  const notifyDb = db.getPgClient('v2_notify'); await notifyDb.connect(); clients.push(notifyDb);
  await notifyDb.query(authStub);
  for (const sql of [v20Schema,repliesMigration,authorDeleteMigration,creatorDeleteMigration]) await notifyDb.query(sql);
  for (const [name,id] of Object.entries(users)) {
    await notifyDb.query('insert into auth.users values ($1)',[id]);
    if (name !== 'Outsider') await notifyDb.query('insert into public.profiles(id,display_name,role) values ($1,$2,$3)',[id,name,name === 'Shibo' ? 'pi' : 'researcher']);
  }
  const [notifyShibo,notifyYan] = await Promise.all(['Shibo','Yan'].map(name => member(name,'authenticated','v2_notify')));
  const notifyIdea = await create(notifyShibo,'Deployed idea with history');
  await rpc(notifyYan,'join_idea',[notifyIdea.id]);
  await rpc(notifyYan,'add_comment',[notifyIdea.id,'Existing comment',randomUUID()]);
  const notifyState = async () => (await notifyDb.query(`select
    (select md5(string_agg(to_jsonb(i)::text, ',' order by i.id)) from public.ideas i) ideas,
    (select md5(string_agg(to_jsonb(p)::text, ',' order by p.idea_id, p.member_id)) from public.idea_participants p) participants,
    (select md5(string_agg(to_jsonb(c)::text, ',' order by c.id)) from public.idea_comments c) comments,
    (select md5(string_agg(to_jsonb(e)::text, ',' order by e.id)) from public.idea_events e) events,
    (select md5(string_agg(to_jsonb(p)::text, ',' order by p.id)) from public.profiles p) profiles,
    (select md5(string_agg(u.id::text, ',' order by u.id)) from auth.users u) users,
    (select json_agg(json_build_object('t',tablename,'p',policyname,'q',qual) order by tablename,policyname) from pg_policies where schemaname='public' and tablename <> 'notification_reads')::text policies,
    (select string_agg(tablename, ',' order by tablename) from pg_publication_tables where pubname='supabase_realtime') publication`)).rows[0];
  const beforeNotify = await notifyState(), notifyNewest = Number((await notifyDb.query('select max(id) n from public.idea_events')).rows[0].n);
  await rejects(() => notifyDb.query(notifyMigration.replace(/commit;\s*$/i,()=>"do $$ begin raise exception 'Injected migration failure'; end; $$; commit;")),/Injected migration failure/,'notification migration is transactional');
  await notifyDb.query('rollback');
  check([(await notifyDb.query("select to_regclass('public.notification_reads') t")).rows[0].t,await notifyState()],[null,beforeNotify],'failed notification migration leaves nothing behind');
  await notifyDb.query(notifyMigration);
  check(await notifyState(),beforeNotify,'notification migration changes no data, policy or publication');
  check((await notifyDb.query('select last_read_event_id from public.notification_reads order by member_id')).rows.map(r => Number(r.last_read_event_id)),[notifyNewest,notifyNewest,notifyNewest,notifyNewest],'existing members start with all history read');
  await rpc(notifyShibo,'add_comment',[notifyIdea.id,'New after migration',randomUUID()]);
  await notifyDb.query(notifyMigration);
  check((await notifyDb.query('select last_read_event_id from public.notification_reads order by member_id')).rows.map(r => Number(r.last_read_event_id)),[notifyNewest,notifyNewest,notifyNewest,notifyNewest],'rerun never overwrites read positions');
  check((await notifyYan.query('select member_id from public.notification_reads')).rows.map(r => r.member_id),[users.Yan],'migrated: own row only');
  check(Number((await rpc(notifyYan,'mark_notifications_read',[notifyNewest + 1])).last_read_event_id),notifyNewest + 1,'migrated RPC advances the read position');
  const notificationCatalog = async client => (await client.query(`select
    (select string_agg(column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default,''), ',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='notification_reads') columns,
    (select string_agg(conname || ':' || pg_get_constraintdef(oid), ' | ' order by conname) from pg_constraint where conrelid='public.notification_reads'::regclass) constraints,
    (select string_agg(policyname || ':' || cmd || ':' || qual, ' | ' order by policyname) from pg_policies where schemaname='public' and tablename='notification_reads') policies,
    (select relrowsecurity from pg_class where oid='public.notification_reads'::regclass) rls,
    (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_name='notification_reads' and grantee in ('anon','authenticated','PUBLIC')) grants,
    (select md5(pg_get_functiondef('public.mark_notifications_read(bigint)'::regprocedure)) || has_function_privilege('authenticated','public.mark_notifications_read(bigint)','EXECUTE') || has_function_privilege('anon','public.mark_notifications_read(bigint)','EXECUTE')) fn`)).rows[0];
  check(await notificationCatalog(notifyDb),await notificationCatalog(admin),'migrated and freshly installed notification schemas are identical');
  await admin.query('create database not_v2');
  const notV2 = db.getPgClient('not_v2'); await notV2.connect(); clients.push(notV2);
  await notV2.query(authStub);
  await rejects(() => notV2.query(repliesMigration),/requires the V2 schema/,'migration refuses to run without V2');
  await notV2.query('rollback');
  await rejects(() => notV2.query(authorDeleteMigration),/requires the V2 schema/,'author migration refuses a missing V2 schema');
  await notV2.query('rollback');
  await rejects(() => notV2.query(creatorDeleteMigration),/requires the V2 schema/,'creator migration refuses a missing V2 schema');
  await notV2.query('rollback');
  await rejects(() => notV2.query(notifyMigration),/requires the V2 schema/,'notification migration refuses a missing V2 schema');
  await notV2.query('rollback');
  await rejects(() => notV2.query(resultEditMigration),/requires the V2 schema/,'result-edit migration refuses a missing V2 schema');
  await notV2.query('rollback');
  await rejects(() => notV2.query(limitMigration),/requires the V2 schema/,'description-limit migration refuses a missing V2 schema');
  await notV2.query('rollback');
  await rejects(() => notV2.query(imagesMigration),/requires the V2 schema/,'comment-image migration refuses a missing V2 schema');
  await notV2.query('rollback');
  await rejects(() => notV2.query(archiveMigration),/requires the V2 schema/,'archive migration refuses a missing V2 schema');
  await notV2.query('rollback');
  await rejects(() => notV2.query(reopenMigration),/requires the V2 schema/,'reopen migration refuses a missing V2 schema');
  await notV2.query('rollback');

  // ---- Comment images (Supabase Storage). A minimal stand-in for Storage's
  // tables, with Supabase's grants: clients may touch storage.objects and only
  // the RLS policies decide what happens.
  await rejects(() => admin.query(imagesMigration),/requires Supabase Storage/,'comment-image migration refuses a database without Storage');
  await admin.query('rollback');
  await admin.query(`create schema storage;
    create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
      name text not null, owner_id text default current_setting('request.jwt.claim.sub',true), unique (bucket_id, name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon, authenticated;
    grant select, insert, update, delete on storage.objects to anon, authenticated;
    insert into storage.buckets values ('comment-images','comment-images',true,null,null), ('other','other',false,null,null);`);
  const storagePolicies = async () => (await admin.query("select policyname, cmd, roles::text from pg_policies where schemaname='storage' order by policyname")).rows;
  await rejects(() => admin.query(imagesMigration.replace(/commit;\s*$/i,()=>"do $$ begin raise exception 'Injected migration failure'; end; $$; commit;")),/Injected migration failure/,'comment-image migration is transactional');
  await admin.query('rollback');
  check([await storagePolicies(),(await admin.query("select public from storage.buckets where id='comment-images'")).rows[0].public],[[],true],'failed comment-image migration changes nothing');
  const publicPolicies = async () => (await admin.query("select policyname, cmd, roles, qual, with_check from pg_policies where schemaname='public' order by tablename, policyname")).rows;
  const beforeImages = await publicPolicies();
  await admin.query(imagesMigration); await admin.query(imagesMigration);
  check((await admin.query("select public, file_size_limit::int, allowed_mime_types from storage.buckets where id='comment-images'")).rows[0],
    {public:false,file_size_limit:5242880,allowed_mime_types:['image/png','image/jpeg','image/gif','image/webp']},'repeatable migration makes the bucket private, 5 MiB, raster images only');
  check(await storagePolicies(),[{policyname:'members_read_comment_images',cmd:'SELECT',roles:'{authenticated}'},{policyname:'members_upload_comment_images',cmd:'INSERT',roles:'{authenticated}'}],
    'members may only read and upload: no UPDATE or DELETE policy');
  check(await publicPolicies(),beforeImages,'RLS policies on public tables unchanged by the comment-image migration');
  const image = (owner,ext = 'png') => `${users[owner]}/${randomUUID()}.${ext}`;
  const upload = (client,name,bucket = 'comment-images') => client.query('insert into storage.objects (bucket_id, name) values ($1,$2)',[bucket,name]);
  const yanImage = image('Yan');
  await upload(yan,yanImage); await upload(junqi,image('Junqi','webp')); checks++;
  for (const [client,name,label] of [[yan,image('Junqi'),'into another member’s folder'],[yan,image('Yan','svg'),'as SVG'],[yan,image('Yan','html'),'as HTML'],
    [yan,`${users.Yan}/../${randomUUID()}.png`,'with a crafted path'],[yan,`${users.Yan}/${randomUUID()}.png/x.png`,'into a subfolder'],[outsider,image('Outsider'),'as a non-member']])
    await rejects(() => upload(client,name),/row-level security/,`no upload ${label}`);
  await rejects(() => upload(yan,image('Yan'),'other'),/row-level security/,'no upload into another bucket');
  await rejects(() => upload(anon,image('Yan')),/row-level security/,'no anonymous upload');
  for (const client of [shibo,junqi,yifan]) check((await client.query("select name from storage.objects where bucket_id='comment-images' order by name")).rowCount,2,'every member sees every comment image');
  for (const client of [outsider,anon]) check((await client.query('select * from storage.objects')).rowCount,0,'outsiders and anonymous users see no images');
  check([(await yan.query("update storage.objects set name=$2 where name=$1",[yanImage,image('Yan')])).rowCount,
    (await yan.query('delete from storage.objects where name=$1',[yanImage])).rowCount,(await shibo.query('delete from storage.objects')).rowCount],[0,0,0],'images cannot be renamed, replaced or deleted, even by the PI');
  await admin.query('update public.profiles set active=false where id=$1',[users.Yifan]);
  check((await yifan.query('select * from storage.objects')).rowCount,0,'a deactivated member sees no images');
  await rejects(() => upload(yifan,image('Yifan')),/row-level security/,'a deactivated member cannot upload');
  await admin.query('update public.profiles set active=true where id=$1',[users.Yifan]);

  console.log(`PASS: ${checks} PostgreSQL checks, including idea archiving and its migration, members reopening their own result and its migration, the 1 MiB description limit and its migration, notification read state and its migration, creator/PI idea deletion rules and their migration, threaded replies and their additive migration, concurrent participation, parallel independent results, comment idempotency, publication WAL filtering, parent-before-child deletion races, and the backup-verified single-transaction V1 upgrade. Hosted Supabase was not used.`);
} finally {
  await Promise.allSettled(clients.map(client => client.end()));
  await db.stop(); await rm(directory,{recursive:true,force:true});
}
