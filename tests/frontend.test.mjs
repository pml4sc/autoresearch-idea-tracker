// DOM integration tests with an isolated transport double, never hosted Auth/data.
// PostgreSQL permissions/concurrency are tested separately in database.test.mjs.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join,resolve,dirname} from 'node:path';
import vm from 'node:vm';
const require = createRequire(join(resolve(process.env.TRACKER_TEST_DEPS || '.'),'package.json'));
const {JSDOM} = require('jsdom');
// Execute the actual pinned browser libraries, not parser/sanitizer mocks.
const libraryScripts = await Promise.all([
  join(dirname(require.resolve('markdown-it')),'browser/markdown-it.umd.min.js'),
  join(dirname(require.resolve('dompurify')),'purify.min.js'),
  join(dirname(require.resolve('katex')),'katex.min.js'),
  require.resolve('markdown-it-texmath')
].map(path=>readFile(path,'utf8')));
function installMarkdownLibraries(window) {
  window.TextEncoder=TextEncoder; window.TextDecoder=TextDecoder;
  libraryScripts.forEach((source,index)=>window.eval(source + (index===3 ? '\nwindow.texmath=texmath;' : '')));
}
const html = await readFile(new URL('../index.html',import.meta.url),'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
new vm.Script(script);
let checks = 1;
function check(actual,expected,label) { assert.deepEqual(actual,expected,label); checks++; }
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const profiles = ['Shibo','Yan','Junqi','Yifan'].map((name,index) => ({id:`member-${index}`,display_name:name,role:index ? 'researcher' : 'pi',active:true}));
const base = {description:'Synthetic test data only. Evaluate the experiment and record its outcome.',week_start:'2026-10-12',priority:'high',created_by:'member-0',revision:1,created_at:'2026-10-12T14:00:00Z',updated_at:'2026-10-12T14:00:00Z'};
let ideas = [
  {...base,id:'idea-1',idea_number:1,title:'Evaluate tool selection instructions'},
  {...base,id:'idea-2',idea_number:2,title:'Compare memory retrieval strategies',priority:'medium',created_by:'member-1'},
  {...base,id:'idea-3',idea_number:3,title:'Measure search quality',priority:'low'},
  {...base,id:'idea-4',idea_number:4,title:'Test retry budgets',week_start:'2026-10-19'},
];
const participation = (idea_id,member_id,extra = {}) => ({idea_id,member_id,status:'testing',result:null,notes:null,experiment_url:null,
  joined_at:'2026-10-12T15:00:00Z',completed_at:null,updated_at:'2026-10-12T15:00:00Z',revision:1,...extra});
const completed = (result,notes = null,experiment_url = null) => ({status:'completed',result,notes,experiment_url,completed_at:'2026-10-13T15:00:00Z',revision:2});
let participants = [
  participation('idea-2','member-1'),
  participation('idea-3','member-1',completed('success','Yan synthetic success')),
  participation('idea-3','member-2',{...completed('fail','Synthetic failed trial — preserve this result.','https://example.org/experiment'),joined_at:'2026-10-12T16:00:00Z'}),
  participation('idea-4','member-3',completed('success')),
];
let comments = [{id:'comment-1',idea_id:'idea-3',author_id:'member-2',body:'Initial **synthetic** note with $x^2$.',
  client_request_id:'00000000-0000-4000-8000-000000000001',created_at:'2026-10-13T16:00:00Z',removed_at:null,removed_by:null}];
let events = [], currentId = 'member-0', authCallback, channel, rpcError, loseNextResponse = false, readsFail = false, delayRead, calls = [], removed = 0, serial = 100;
let notificationReads = [], readCalls = [], notificationsFail = false, reads = [];
let stored = new Map(), storageCalls = [], uploadError = null, holdUpload = null, imageCleanup;
const session = () => currentId ? {user:{id:currentId},access_token:'synthetic-test-token'} : null;
const rowsFor = table => ({profiles,ideas,idea_participants:participants,idea_comments:comments,notification_reads:notificationReads})[table] || [...events].reverse();
// Applies a PostgREST select list, including JSON paths such as "title:new_state->>title".
const project = (rows,columns) => !columns || columns === '*' ? rows : rows.map(row => Object.fromEntries(columns.split(',').map(part => {
  const [alias,expression] = part.includes(':') ? part.split(':') : [part,part];
  const path = expression.match(/^(\w+)->(>?)(\w+)$/);
  if (!path) return [alias,row[expression]];
  const value = row[path[1]]?.[path[3]];
  return [alias,value === undefined || value === null ? null : path[2] ? (typeof value === 'object' ? JSON.stringify(value) : String(value)) : value];
})));
function query(table) {
  reads.push(table);
  const filters = []; let low=0, high=Infinity, limit=Infinity, single=false, counted=false;
  const builder = {
    select(columns,options){this.columns=columns;counted=options?.count==='exact';return this;},order(){return this;},eq(key,value){filters.push(row=>row[key]===value);return this;},
    lt(key,value){filters.push(row=>Number(row[key])<Number(value));return this;},
    range(from,to){low=from;high=to;return this;},limit(value){limit=value;return this;},maybeSingle(){single=true;return this;},
    async then(resolve,reject) {
      try {
        if (delayRead && table==='ideas') { const delay=delayRead; delayRead=null; await delay; }
        if (readsFail) return resolve({data:null,error:{message:'Network unavailable'}});
        if (notificationsFail && table==='notification_reads') return resolve({data:null,error:{code:'42P01',message:'relation "public.notification_reads" does not exist'}});
        let rows = clone(rowsFor(table)).filter(row=>filters.every(filter=>filter(row)));
        const count = rows.length;
        rows = project(rows.slice(low,Math.min(high+1,low+limit)),this.columns);
        resolve({data:single ? rows[0] || null : rows,error:null,...(counted ? {count} : {})});
      } catch(error) { reject(error); }
    }
  }; return builder;
}
// Mirrors the V2 RPC rules closely enough for UI tests; the database suite is authoritative.
const ok = data => ({data:clone(data),error:null}), fail = message => ({data:null,error:{message}});
const record = (idea,event_type,previous_state,new_state,member_id = null) => events.push({id:events.length+1,idea_id:idea.id,idea_number:idea.idea_number,
  actor_id:currentId,member_id,event_type,previous_state:clone(previous_state) ?? null,new_state:clone(new_state) ?? null,created_at:'2026-10-16T14:00:00Z'});
function perform(name,args) {
  const idea = ideas.find(i=>i.id===args.p_idea_id);
  const mine = idea && participants.find(p=>p.idea_id===idea.id && p.member_id===currentId);
  if (name==='create_idea') {
    const created = {...base,id:`idea-${serial++}`,idea_number:Math.max(0,...ideas.map(i=>i.idea_number),...events.map(e=>e.idea_number))+1,title:args.p_title,
      description:args.p_description,week_start:args.p_week_start,priority:args.p_priority,created_by:currentId};
    ideas.push(created); record(created,'created',null,created); return ok(created);
  }
  if (name==='remove_comment') {
    const profile = profiles.find(p=>p.id===currentId && p.active);
    if (!profile) return fail('Permission denied');
    const comment = comments.find(c=>c.id===args.p_comment_id && !c.removed_at);
    if (!comment) return fail('Comment not found');
    if (profile.role!=='pi' && comment.author_id!==currentId) return fail('Permission denied');
    const before = clone(comment); Object.assign(comment,{removed_at:'2026-10-16T15:00:00Z',removed_by:currentId});
    record(ideas.find(i=>i.id===comment.idea_id),'comment_removed',before,comment); return ok(comment);
  }
  if (name==='reply_to_comment') {
    const existing = comments.find(c=>c.author_id===currentId && c.client_request_id===args.p_client_request_id);
    if (existing) return existing.parent_comment_id===args.p_parent_comment_id ? ok(existing) : fail('Comment request ID already used');
    const parent = comments.find(c=>c.id===args.p_parent_comment_id);
    if (!parent) return fail('Comment not found');
    if (parent.removed_at) return fail('Cannot reply to a removed comment');
    const reply = {id:`comment-${serial++}`,idea_id:parent.idea_id,author_id:currentId,body:args.p_body,client_request_id:args.p_client_request_id,
      parent_comment_id:parent.id,created_at:new Date(Date.parse('2026-10-16T15:00:00Z')+serial*1000).toISOString(),removed_at:null,removed_by:null};
    comments.push(reply); record(ideas.find(i=>i.id===parent.idea_id),'commented',null,reply); return ok(reply);
  }
  if (!idea) return fail('Idea not found');
  if (name==='update_idea') {
    if (idea.revision!==args.p_expected_revision) return fail('Idea changed. Refresh and try again');
    const before = clone(idea);
    Object.assign(idea,{title:args.p_title,description:args.p_description,week_start:args.p_week_start,priority:args.p_priority,revision:idea.revision+1});
    record(idea,'edited',before,idea); return ok(idea);
  }
  if (name==='delete_idea') {
    // Same rule as the database: PI any idea; creator only an untouched one.
    if (profiles.find(p=>p.id===currentId)?.role !== 'pi') {
      if (idea.created_by !== currentId) return {data:null,error:{code:'42501',message:'Permission denied: only the PI or the idea creator can delete this idea'}};
      if (participants.some(p=>p.idea_id===idea.id) || comments.some(c=>c.idea_id===idea.id)) {
        return {data:null,error:{code:'42501',message:'Permission denied: this idea already has participants or comments; only the PI can delete it'}};
      }
    }
    const before = {...clone(idea),participants:clone(participants.filter(p=>p.idea_id===idea.id)),comments:clone(comments.filter(c=>c.idea_id===idea.id))};
    ideas = ideas.filter(i=>i!==idea); participants = participants.filter(p=>p.idea_id!==idea.id); comments = comments.filter(c=>c.idea_id!==idea.id);
    record(idea,'deleted',before,null); return {data:null,error:null};
  }
  if (name==='archive_idea' || name==='unarchive_idea') {
    // Same rule as the database: the creator or the PI.
    if (profiles.find(p=>p.id===currentId)?.role !== 'pi' && idea.created_by !== currentId) return {data:null,error:{code:'42501',message:'Permission denied: only the PI or the idea creator can archive this idea'}};
    if (idea.revision!==args.p_expected_revision) return fail('Idea changed. Refresh and try again');
    const archiving = name==='archive_idea';
    if (archiving === !!idea.archived_at) return fail(archiving ? 'Idea already archived' : 'Idea is not archived');
    const before = clone(idea);
    Object.assign(idea,archiving ? {archived_at:'2026-10-16T14:00:00Z',archived_by:currentId,archive_reason:args.p_reason?.trim() || null} :
      {archived_at:null,archived_by:null,archive_reason:null},{revision:idea.revision+1});
    record(idea,archiving ? 'archived' : 'unarchived',before,idea); return ok(idea);
  }
  if (name==='join_idea') {
    if (idea.archived_at) return fail('This idea is archived');
    if (mine && mine.status!=='withdrawn') return fail('Already participating in this idea');
    const before = clone(mine);
    const joined = mine ? Object.assign(mine,{status:'testing',revision:mine.revision+1}) : participation(idea.id,currentId,{joined_at:'2026-10-16T14:00:00Z'});
    if (!mine) participants.push(joined);
    record(idea,mine ? 'rejoined' : 'joined',before,joined,currentId); return ok(joined);
  }
  if (name==='leave_idea' || name==='submit_result') {
    if (!mine) return fail('Participation not found');
    if (mine.revision!==args.p_expected_revision) return fail('Participation changed. Refresh and try again');
    const editing = name==='submit_result' && mine.status==='completed';
    if (mine.status!=='testing' && !editing) return fail('Invalid status transition');
    const notes = args.p_notes?.trim() || null, url = args.p_experiment_url?.trim() || null;
    if (editing && mine.result===args.p_result && mine.notes===notes && mine.experiment_url===url) return fail('Result unchanged');
    const before = clone(mine);
    Object.assign(mine,name==='leave_idea' ? {status:'withdrawn'} : {status:'completed',result:args.p_result,notes,
      experiment_url:url,completed_at:'2026-10-16T14:00:00Z'},{revision:mine.revision+1});
    record(idea,name==='leave_idea' ? 'withdrew' : editing ? 'participant_updated' : 'result_submitted',before,mine,currentId); return ok(mine);
  }
  if (name==='reopen_result') {
    // Same rule as the database: the PI reopens anyone's result, a member only their own.
    if (profiles.find(p=>p.id===currentId)?.role !== 'pi' && args.p_member_id !== currentId) return {data:null,error:{code:'42501',message:'Permission denied'}};
    const target = participants.find(p=>p.idea_id===idea.id && p.member_id===args.p_member_id);
    if (!target) return fail('Participation not found');
    if (target.revision!==args.p_expected_revision) return fail('Participation changed. Refresh and try again');
    const before = clone(target);
    Object.assign(target,{status:'testing',result:null,notes:null,experiment_url:null,completed_at:null,revision:target.revision+1});
    record(idea,'result_reopened',before,target,target.member_id); return ok(target);
  }
  if (name==='add_comment') {
    const existing = comments.find(c=>c.author_id===currentId && c.client_request_id===args.p_client_request_id);
    if (existing) return ok(existing);
    const comment = {id:`comment-${serial++}`,idea_id:idea.id,author_id:currentId,body:args.p_body,client_request_id:args.p_client_request_id,
      created_at:'2026-10-16T14:30:00Z',removed_at:null,removed_by:null};
    comments.push(comment); record(idea,'commented',null,comment); return ok(comment);
  }
  throw new Error(`Unexpected RPC ${name}`);
}
const client = {
  from:query,
  auth:{
    onAuthStateChange(callback){authCallback=callback;setTimeout(()=>callback('INITIAL_SESSION',session()),0);},
    async signInWithPassword(){return {error:{message:'Invalid login credentials'}};},
    async getSession(){return {data:{session:session()},error:null};},
    async signOut(){currentId=null;setTimeout(()=>authCallback('SIGNED_OUT',null),0);return {error:null};}
  },
  realtime:{async setAuth(){}},
  // Private comment-images bucket: uploads never overwrite, downloads need an existing object.
  storage:{from:bucket=>({
    async upload(path,file,options){
      storageCalls.push({op:'upload',bucket,path,...clone(options)});
      if (holdUpload) await holdUpload;
      if (uploadError) return {data:null,error:uploadError};
      if (stored.has(path)) return {data:null,error:{message:'The resource already exists'}};
      stored.set(path,file);return {data:{path},error:null};
    },
    async download(path){
      storageCalls.push({op:'download',bucket,path});
      return stored.has(path) ? {data:stored.get(path),error:null} : {data:null,error:{message:'Object not found'}};
    }
  })},
  channel(){ channel={handlers:[],on(type,filter,callback){this.handlers.push({filter,callback});return this;},subscribe(callback){this.status=callback;setTimeout(()=>callback('SUBSCRIBED'),0);return this;}}; return channel; },
  async removeChannel(){removed++;},
  async rpc(name,args){
    // Read-position updates happen in the background; record them separately so
    // they never shift the action calls the other tests inspect.
    if (name==='mark_notifications_read') {
      readCalls.push(clone(args));
      const newest = Math.max(0,...events.map(e=>e.id)), position = Math.min(args.p_last_event_id,newest);
      let row = notificationReads.find(r=>r.member_id===currentId);
      if (!row) notificationReads.push(row = {member_id:currentId,last_read_event_id:position});
      else row.last_read_event_id = Math.max(row.last_read_event_id,position);
      return ok(row);
    }
    calls.push({name,args:clone(args)});
    if (rpcError) return {data:null,error:rpcError};
    const result = perform(name,args);
    // Simulates a committed request whose response never arrived.
    if (loseNextResponse && !result.error) { loseNextResponse = false; return {data:null,error:{message:'Failed to fetch'}}; }
    return result;
  }
};
const dom = new JSDOM(html,{url:'http://127.0.0.1:8765/autoresearch-idea-tracker/',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
installMarkdownLibraries(w);
w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
w.HTMLDialogElement.prototype.close=function(){this.open=false;};
w.supabase={createClient:()=>client};
w.eval(script+'\nwindow.__app = {state,loadIdeas,checkForChanges,pollTick,loadCurrentUser,renderDashboard,openIdeaDialog,openResultDialog,confirmAction,joinIdea,mutate,openHistory,safeURL,closeModal,filteredIdeas,renderMarkdown,suggestedMarkdownTitle,readMarkdownFile,markdownFileName};');
const app=w.__app;
const wait=async condition=>{for(let n=0;n<200;n++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Timed out waiting for DOM test condition');};
const click = id => d.getElementById(id).click();
const submit = () => d.querySelector('#modal-body form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
const text = id => d.getElementById(id).textContent;
const card = number => [...d.querySelectorAll('.idea')].find(el=>el.querySelector('.idea-number').textContent===number);
const labels = element => [...element.querySelectorAll('button')].map(b=>b.textContent);
const openAll = () => { for (const el of d.querySelectorAll('.week,.idea')) if (!el.open) { el.open=true; el.dispatchEvent(new w.Event('toggle')); } };
const press = (element,label) => [...element.querySelectorAll('button')].find(b=>b.textContent===label).click();
const settled = () => wait(()=>!app.state.pending && !app.state.refreshTask);
const ideaById = id => app.state.ideas.find(i=>i.id===id);
const rowOf = (ideaId,memberId) => app.state.participants.find(p=>p.idea_id===ideaId && p.member_id===memberId);
async function snapshot(name) {
  if (!process.env.TRACKER_PREVIEW_DIR) return;
  const copy=d.documentElement.cloneNode(true);
  copy.querySelectorAll('script').forEach(el=>el.remove());
  const originals=[...d.querySelectorAll('input,textarea,select')];
  copy.querySelectorAll('input,textarea,select').forEach((control,index)=>{
    const original=originals[index];
    if(control.tagName==='TEXTAREA') control.textContent=original.value;
    else if(control.tagName==='SELECT') [...control.options].forEach(option=>option.toggleAttribute('selected',option.value===original.value));
    else if(control.type!=='file') {control.setAttribute('value',original.value);control.toggleAttribute('checked',original.checked);}
  });
  copy.querySelector('.brand').textContent='LOCAL TEST FIXTURE · Synthetic data';
  copy.querySelector('#notifications').replaceChildren();
  if (copy.querySelector('#modal').open) {
    const openDialog=copy.ownerDocument.createElement('script');
    openDialog.textContent='const dialog=document.getElementById("modal");dialog.removeAttribute("open");dialog.showModal();';
    copy.querySelector('body').append(openDialog);
    copy.querySelector('#modal-title').textContent='Local test · '+copy.querySelector('#modal-title').textContent;
  }
  await mkdir(process.env.TRACKER_PREVIEW_DIR,{recursive:true});
  await writeFile(join(process.env.TRACKER_PREVIEW_DIR,name),'<!doctype html>\n'+copy.outerHTML);
}
try {
  await wait(()=>app.state.loaded && app.state.live);
  check(d.getElementById('dashboard').hidden,false,'authorized dashboard');
  check(text('identity'),'Logged in as Shibo','profile identity');
  check(text('connection'),'Connected','subscription status');
  check([...d.querySelectorAll('.stat-label')].map(el=>el.textContent),['Total ideas','Open','In progress','With results','Success results','Fail results'],'V2 counters');
  check([...d.querySelectorAll('.stat-value')].map(el=>el.textContent),['4','1','1','2','2','1'],'counts derived from participants');
  check(text('progress-percent'),'50%','share of ideas with results');
  check(text('progress-text'),'2 / 4 ideas have results','progress label');
  check(d.querySelectorAll('.week').length,2,'weekly groups');
  check(channel.handlers.map(h=>h.filter.table),['ideas','idea_events','profiles'],'subscribed tables');
  check(channel.handlers.every(h=>h.filter.event==='*'),true,'all change types');
  check(d.getElementById('create-button').hidden,false,'PI can publish');
  check(d.getElementById('expand-all'),null,'no Expand all: one idea is read at a time');
  openAll();check([...d.querySelectorAll('.idea,.week')].every(el=>el.open),true,'all cards open');
  await snapshot('dashboard.html');
  click('collapse-all');check([...d.querySelectorAll('.idea,.week')].every(el=>!el.open),true,'collapse all');
  const setFilter=(id,value)=>{d.getElementById(id).value=value;d.getElementById(id).dispatchEvent(new w.Event(id==='search'?'input':'change'));};
  for (const [id,value,expected] of [['search','IDEA-003',1],['search','retrieval',1],['search','synthetic',4],['status-filter','open',1],['status-filter','testing',1],
    ['status-filter','results',2],['member-filter','member-1',2],['member-filter','none',1],['result-filter','fail',1],['result-filter','success',2],
    ['result-filter','none',2],['priority-filter','high',2],['week-filter','2026-10-19',1]]) {
    click('clear-filters');setFilter(id,value);check(d.querySelectorAll('.idea').length,expected,`filter ${id}=${value}`);
  }
  click('clear-filters');setFilter('search','no-matching-idea');check(text('ideas').includes('No ideas match'),true,'empty search');click('clear-filters');
  setFilter('sort','number');check(app.filteredIdeas()[0].idea_number,1,'number sort');
  check(app.safeURL('javascript:alert(1)'),null,'unsafe URL blocked');
  check(app.safeURL('https://example.org/test'),'https://example.org/test','HTTPS URL');
  ideas[0].description='<img src=x onerror=alert(1)><script>evil</script>';
  await app.loadIdeas();check(d.querySelectorAll('.idea-body img,.idea-body script').length,0,'untrusted content is text');
  check(text('ideas').includes('<img src=x'),true,'text not stripped or interpreted');
  ideas[0].description=base.description;

  // ---- Independent participants on one idea.
  await app.loadIdeas();
  let c3 = card('IDEA-003');
  check(c3.querySelector('.summary-assignee').textContent,'Yan, Junqi · 1 comment','participants and comment count summarized on the card');
  check([...c3.querySelectorAll('.summary-badges .badge')].map(b=>b.textContent),['1 success','1 fail'],'aggregated badges');
  check([...c3.querySelectorAll('.participant')].map(li=>[li.querySelector('.participant-name').textContent,[...li.querySelectorAll('.badge')].map(b=>b.textContent).join('/')]),
    [['Yan','Completed/Success'],['Junqi','Completed/Fail']],'each participant shows their own status and result');
  check(c3.textContent.includes('Synthetic failed trial'),true,'participant notes shown');
  check(c3.querySelector('.participant a[href]').getAttribute('rel'),'noopener noreferrer','safe experiment link');
  check(labels(c3).filter(l=>l==='Reopen result').length,2,'PI can reopen each result');
  check(c3.querySelector('.discussion-head h3').textContent,'Discussion (1)','comment count on card');
  check([...card('IDEA-001').querySelectorAll('.summary-badges .badge')].map(b=>b.textContent),['Open'],'idea without participants is open');
  check(card('IDEA-001').querySelector('.summary-assignee').textContent,'No participants','empty participant summary');
  check(card('IDEA-002').textContent.includes('Published by'),true,'creator shown');

  // ---- Publish and edit (creator or PI).
  app.openIdeaDialog();
  const form=d.querySelector('#modal-body form');
  form.querySelector('input[type=text]').value='Created through form';
  form.querySelector('input[type=date]').value='2026-10-13';submit();
  check(d.querySelector('#modal-body .error-text').textContent.includes('Monday'),true,'Monday form validation');
  check(calls.length,0,'invalid input makes no RPC');
  form.querySelector('input[type=date]').value='2026-10-12';submit();
  await wait(()=>!app.state.pending && !d.getElementById('modal').open);
  check(calls.at(-1).name,'create_idea','publish RPC');
  check(app.state.ideas.length,5,'publish refetch');
  let created=app.state.ideas.find(i=>i.title==='Created through form');
  app.openIdeaDialog(created);d.querySelector('#modal-body input[type=text]').value='Revised test idea';submit();
  await wait(()=>!app.state.pending && !d.getElementById('modal').open);
  check(calls.at(-1).args.p_expected_revision,created.revision,'edit revision');

  // ---- Join, then submit only my own result.
  press(card('IDEA-001'),'Join idea');
  await wait(()=>rowOf('idea-1','member-0'));await settled();
  check(calls.at(-1),{name:'join_idea',args:{p_idea_id:'idea-1'}},'join RPC takes only the idea');
  check(labels(card('IDEA-001')).includes('Join idea'),false,'join hidden once participating');
  check(labels(card('IDEA-001')).includes('Submit my result'),true,'own testing row offers result submission');
  press(card('IDEA-001'),'Submit my result');
  check(text('modal-title'),'Submit my result','result dialog');
  d.querySelector('input[value=fail]').checked=true;
  d.querySelector('#modal-body textarea').value='Synthetic notes';
  d.querySelector('input[type=url]').value='javascript:alert(1)';submit();
  check(d.querySelector('#modal-body .error-text').textContent.includes('HTTP(S)'),true,'result URL validation');
  d.querySelector('input[type=url]').value='https://example.org/trial';
  await snapshot('result.html');submit();
  await wait(()=>!app.state.pending && !d.getElementById('modal').open);await settled();
  check(calls.at(-1).name,'submit_result','submit result RPC');
  check(Object.keys(calls.at(-1).args),['p_idea_id','p_expected_revision','p_result','p_notes','p_experiment_url'],'no member argument: only the caller row can change');
  check(calls.at(-1).args.p_result,'fail','submitted result');

  // ---- Change my own completed result (fail -> success); the old one stays in history.
  check(labels(card('IDEA-001')).includes('Edit my result'),true,'own completed row offers result editing');
  press(card('IDEA-001'),'Edit my result');
  check([text('modal-title'),d.querySelector('input[value=fail]').checked,d.querySelector('#modal-body textarea').value,d.querySelector('input[type=url]').value],
    ['Edit my result',true,'Synthetic notes','https://example.org/trial'],'edit dialog starts from the current result');
  const callsBeforeEdit=calls.length;submit();
  check([calls.length,d.querySelector('#modal-body .error-text').textContent.includes('Nothing changed')],[callsBeforeEdit,true],'unchanged edit is not sent');
  d.querySelector('input[value=success]').checked=true;submit();
  await wait(()=>!app.state.pending && !d.getElementById('modal').open);await settled();
  check([calls.at(-1).name,calls.at(-1).args.p_result,calls.at(-1).args.p_notes],['submit_result','success','Synthetic notes'],'edited result sent through the same caller-only RPC');
  check(rowOf('idea-1','member-0').result,'success','own result changed');
  check(events.at(-1).event_type,'participant_updated','change recorded in history');
  check([...card('IDEA-003').querySelectorAll('.summary-badges .badge')].map(b=>b.textContent),['1 success','1 fail'],'other ideas and members unaffected');

  // ---- A second member's view: own result only, no PI controls.
  currentId='member-1';await app.loadCurrentUser(session());await settled();
  check(text('identity'),'Logged in as Yan','researcher session');
  check([text('avatar'),d.getElementById('avatar').classList.contains('tone-1')],['Ya',true],'account avatar uses the same initials and tone');
  check(d.getElementById('create-button').hidden,false,'researchers can publish');
  check(labels(d.getElementById('ideas')).includes('Delete'),false,'researcher cannot delete');
  check(labels(d.getElementById('ideas')).filter(l=>l==='Edit').length,app.state.ideas.filter(i=>i.created_by==='member-1').length,'edit only own ideas');
  check(labels(d.getElementById('ideas')).includes('Reopen result'),false,'researcher cannot reopen results');
  check(labels(card('IDEA-001')).includes('Submit my result'),false,'cannot submit into another member row');
  check(labels(card('IDEA-001')).includes('Edit my result'),false,'cannot edit another member result');
  check(labels(card('IDEA-002')).includes('Submit my result'),true,'own testing row actionable');
  press(card('IDEA-002'),'Submit my result');d.querySelector('input[value=success]').checked=true;submit();
  await wait(()=>!app.state.pending && !d.getElementById('modal').open);await settled();
  check(calls.at(-1).args.p_idea_id,'idea-2','Yan submits on her own idea');
  check([rowOf('idea-1','member-0').result,rowOf('idea-2','member-1').result],['success','success'],'two members keep independent results');
  // A member moves their own result back to Testing; never another member's.
  check(labels(d.getElementById('ideas')).filter(l=>l==='Back to Testing').length,app.state.participants.filter(p=>p.member_id==='member-1' && p.status==='completed').length,'Back to Testing only on own completed rows');
  press(card('IDEA-002'),'Edit my result');
  check(text('modal-body').includes('use Back to Testing'),true,'the edit dialog points to Back to Testing');app.closeModal();
  press(card('IDEA-002'),'Back to Testing');
  check([text('modal-title'),text('modal-body').includes('previous result remains in activity history')],['Move your result back to Testing?',true],'confirmation explains that history keeps the result');
  const yanDone=rowOf('idea-2','member-1');
  submit();await wait(()=>!app.state.pending && !d.getElementById('modal').open);await settled();
  check(calls.at(-1),{name:'reopen_result',args:{p_idea_id:'idea-2',p_member_id:'member-1',p_expected_revision:yanDone.revision}},'own reopen uses reopen_result for the caller');
  check([rowOf('idea-2','member-1').status,labels(card('IDEA-002')).includes('Submit my result'),text('notifications').includes('You are back to Testing.')],['testing',true,true],'back to Testing and can submit again');
  press(card('IDEA-002'),'Submit my result');d.querySelector('input[value=success]').checked=true;submit();
  await wait(()=>!app.state.pending && !d.getElementById('modal').open);await settled();
  currentId='member-0';await app.loadCurrentUser(session());await settled();

  // ---- PI reopens exactly one member's result.
  const yanRow=rowOf('idea-3','member-1');
  app.confirmAction('reopen',ideaById('idea-3'),yanRow);
  check(text('modal-title'),'Reopen Yan’s result?','reopen confirmation names the member');
  submit();await wait(()=>!app.state.pending && !d.getElementById('modal').open);await settled();
  check(calls.at(-1),{name:'reopen_result',args:{p_idea_id:'idea-3',p_member_id:'member-1',p_expected_revision:yanRow.revision}},'reopen targets one member row');
  check([...card('IDEA-003').querySelectorAll('.summary-badges .badge')].map(b=>b.textContent),['1 testing','1 fail'],'Junqi result kept after Yan reopened');

  // ---- Leave and rejoin.
  press(card('IDEA-004'),'Join idea');await wait(()=>rowOf('idea-4','member-0'));await settled();
  press(card('IDEA-004'),'Leave');check(text('modal-title'),'Leave IDEA-004?','leave confirmation');
  submit();await wait(()=>!app.state.pending && !d.getElementById('modal').open);await settled();
  check(calls.at(-1).name,'leave_idea','leave RPC');
  check(Object.keys(calls.at(-1).args),['p_idea_id','p_expected_revision'],'leave affects only the caller');
  check(labels(card('IDEA-004')).includes('Rejoin idea'),true,'withdrawn member can rejoin');
  check(card('IDEA-004').querySelector('.summary-assignee').textContent,'Yifan','withdrawn member hidden from card');

  // ---- Deletion keeps history.
  created=ideaById(created.id);
  app.confirmAction('delete',created);submit();await wait(()=>!app.state.pending && !d.getElementById('modal').open);await settled();
  check(calls.at(-1).name,'delete_idea','delete RPC');check(app.state.ideas.length,4,'delete refetch');
  app.openHistory();await wait(()=>d.querySelectorAll('.history li').length>0);
  for (const phrase of ['submitted a result','Synthetic notes','reopened Yan’s result','moved their result back to Testing','Yan synthetic success','left the idea','joined the idea','deleted the idea','Preserved: 0 participants'])
    check(text('modal-body').includes(phrase),true,`history shows: ${phrase}`);
  app.closeModal();

  // ---- Inline discussion under each idea: no modal, Markdown/LaTeX, drafts, paging.
  const thread = number => card(number).querySelector('[data-slot="thread"]');
  const composerOf = number => card(number).querySelector('.comment-input');
  const postIn = number => card(number).querySelector('.composer').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  const composerError = number => card(number).querySelector('.composer .error-text').textContent;
  const type = (number,value) => { const input=composerOf(number); input.value=value; input.dispatchEvent(new w.Event('input')); };
  const openCard = number => { const el=card(number); if (!el.open) { el.open=true; el.dispatchEvent(new w.Event('toggle')); } };
  check([...d.querySelectorAll('.idea')].every(el=>el.querySelector('.discussion .composer .comment-input')),true,'every idea card has an inline composer');
  check(card('IDEA-003').querySelector('.discussion-head h3').textContent,'Discussion (1)','discussion heading shows the count');
  check(card('IDEA-003').querySelector('.idea-meta').textContent.includes('1 comment'),true,'comment count in the card meta row');
  openCard('IDEA-003');
  await wait(()=>thread('IDEA-003').querySelector('.comment'));
  const first=thread('IDEA-003').querySelector('.comment');
  check([first.querySelector('.comment-head strong').textContent,first.querySelector('.comment-avatar').textContent,first.querySelector('.markdown-body strong')?.textContent,!!first.querySelector('.katex')],
    ['Junqi','J','synthetic',true],'comment shows author, avatar, Markdown and math inline');
  const stamp=first.querySelector('time');
  check([stamp.dateTime,stamp.title.length>0,stamp.textContent.length>0],['2026-10-13T16:00:00Z',true,true],'relative time with exact timestamp');
  check(d.getElementById('modal').open,false,'reading comments needs no dialog');
  const callsBeforeComment=calls.length;
  postIn('IDEA-003');check(composerError('IDEA-003'),'Write a comment before posting.','empty comment rejected');
  type('IDEA-003','x'.repeat(20481));postIn('IDEA-003');check(composerError('IDEA-003').includes('20 KiB'),true,'oversized comment rejected');
  check(calls.length,callsBeforeComment,'invalid comments make no RPC');
  const commentText='## Proposal\n\n$$\\alpha_i$$ <img src=x onerror=alert(1)> [x](javascript:alert(1))';
  type('IDEA-003',commentText);
  press(card('IDEA-003').querySelector('.composer'),'Preview');
  await wait(()=>card('IDEA-003').querySelector('.composer .markdown-preview h2'));
  check([!!card('IDEA-003').querySelector('.composer .markdown-preview .katex'),card('IDEA-003').querySelector('.composer .markdown-preview').hidden],[true,false],'composer preview renders math');
  loseNextResponse=true;postIn('IDEA-003');await settled();
  const firstAttempt=calls.at(-1).args;
  check([calls.at(-1).name,composerOf('IDEA-003').value],['add_comment',commentText],'draft kept after an uncertain failure');
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(firstAttempt.p_client_request_id),true,'request ID is a UUID');
  postIn('IDEA-003');await settled();
  check(calls.at(-1).args.p_client_request_id,firstAttempt.p_client_request_id,'retry reuses the request ID');
  check(comments.filter(c=>c.body===commentText).length,1,'lost response plus retry posts once');
  check([composerOf('IDEA-003').value,d.getElementById('modal').open],['',false],'composer clears after posting, without any dialog');
  await wait(()=>thread('IDEA-003').querySelectorAll('.comment').length===2);
  const posted=[...thread('IDEA-003').querySelectorAll('.comment')].at(-1);
  check([posted.querySelector('.comment-head strong').textContent,!!posted.querySelector('h2'),!!posted.querySelector('.katex')],['Shibo',true,true],'new comment appears at the end of the thread');
  check(posted.querySelector('img,script,[onerror],a[href^="javascript"]'),null,'comment XSS inert');
  check(card('IDEA-003').querySelector('.discussion-head h3').textContent,'Discussion (2)','count updated');

  // Realtime while typing: new comments appear, the focused draft is untouched.
  type('IDEA-003','Draft in progress');
  const typing=composerOf('IDEA-003');typing.focus();typing.setSelectionRange(5,5);
  const requestBeforeRefresh=app.state.commentDrafts.get('idea-3').requestId;
  currentId='member-1';await client.rpc('add_comment',{p_idea_id:'idea-3',p_body:'Remote reply while typing',p_client_request_id:'00000000-0000-4000-8000-000000000042'});currentId='member-0';
  await app.loadIdeas();
  check([composerOf('IDEA-003')===typing,typing.value,d.activeElement===typing,typing.selectionStart],[true,'Draft in progress',true,5],'refresh keeps the same textarea, text, focus and caret');
  check(thread('IDEA-003').textContent.includes('Remote reply while typing'),true,'remote comment appears while typing');
  check(card('IDEA-003').querySelector('.discussion-head h3').textContent,'Discussion (3)','count updates while typing');
  check(app.state.renderPending,true,'structural rebuild deferred while typing');
  typing.blur();
  await app.loadIdeas();
  check([composerOf('IDEA-003')!==typing,composerOf('IDEA-003').value,app.state.commentDrafts.get('idea-3').requestId],[true,'Draft in progress',requestBeforeRefresh],'rebuilt card restores the draft and its request ID');
  type('IDEA-003','');

  // Sorting and "Load more".
  for (let n=0;n<22;n++) comments.push({id:`bulk-${String(n).padStart(2,'0')}`,idea_id:'idea-2',author_id:`member-${n%4}`,body:`Bulk comment ${n}`,
    client_request_id:`00000000-0000-4000-8000-0000000001${String(n).padStart(2,'0')}`,created_at:`2026-10-14T10:${String(n).padStart(2,'0')}:00Z`,removed_at:null,removed_by:null});
  await app.loadIdeas();openCard('IDEA-002');
  const bodies=()=>[...thread('IDEA-002').querySelectorAll('.comment .markdown-body')].map(el=>el.textContent.trim());
  await wait(()=>bodies().length===10);
  check([bodies()[0],bodies().at(-1)],['Bulk comment 12','Bulk comment 21'],'oldest-first shows the latest page chronologically');
  check(thread('IDEA-002').firstChild.textContent,'Show 10 earlier comments','load earlier control above the thread');
  thread('IDEA-002').firstChild.click();
  check(bodies().length,20,'second page loaded');
  thread('IDEA-002').firstChild.click();
  check([bodies().length,bodies()[0],thread('IDEA-002').querySelector('.more-comments')],[22,'Bulk comment 0',null],'all comments loaded; control removed');
  const sort=card('IDEA-002').querySelector('.discussion-head select');sort.value='newest';sort.dispatchEvent(new w.Event('change'));
  check([bodies()[0],bodies().at(-1)],['Bulk comment 21','Bulk comment 0'],'newest-first ordering');
  check(card('IDEA-002').querySelector('.discussion-head h3').textContent,'Discussion (22)','count with many comments');
  // Avatars: Yan and Yifan share a first letter, so both initials and colours must differ.
  const avatarOf=body=>[...thread('IDEA-002').querySelectorAll('li.comment')].find(li=>li.querySelector('.markdown-body')?.textContent.trim()===body).querySelector('.comment-avatar');
  const avatars=['Bulk comment 20','Bulk comment 21','Bulk comment 18','Bulk comment 19'].map(avatarOf);
  check(avatars.map(a=>[a.textContent,[...a.classList].find(c=>c.startsWith('tone-'))]),[['S','tone-0'],['Ya','tone-1'],['J','tone-2'],['Yi','tone-3']],'Shibo S, Yan Ya, Junqi J, Yifan Yi, each with its own tone');
  check(new Set(avatars.map(a=>w.getComputedStyle(a).backgroundColor)).size,4,'four members, four avatar colours');

  // PI deletion inline; researchers see Delete only on their own comments.
  w.confirm=()=>true;
  press(thread('IDEA-003').querySelector('.comment'),'Delete');
  await wait(()=>thread('IDEA-003').querySelector('.comment.removed'));await settled();
  check(calls.at(-1),{name:'remove_comment',args:{p_comment_id:'comment-1'}},'PI removes a comment inline');
  check(thread('IDEA-003').querySelector('.comment.removed').textContent.includes('Comment removed by Shibo'),true,'removed comment placeholder');
  check(thread('IDEA-003').querySelector('.comment.removed .markdown-body'),null,'removed body hidden in UI');
  check(card('IDEA-003').querySelector('.discussion-head h3').textContent,'Discussion (2)','count excludes removed comment');
  openAll();
  await snapshot('discussion.html');
  click('collapse-all');
  currentId='member-1';await app.loadCurrentUser(session());await settled();
  openCard('IDEA-003');await wait(()=>thread('IDEA-003').querySelector('.comment'));
  for (const li of thread('IDEA-003').querySelectorAll('li.comment')) {
    const comment = comments.find(c=>c.id===li.dataset.commentId);
    check(!!li.querySelector('.comment-remove'),!comment.removed_at && comment.author_id===currentId,'researcher Delete visibility follows authorship');
  }
  check(app.state.commentDrafts.size,0,'drafts never carry over to another account');
  currentId='member-0';await app.loadCurrentUser(session());await settled();

  // ---- Threaded replies: inline Reply composer, nesting, collapse, drafts, removal.
  const commentNode = (number,id) => [...card(number).querySelectorAll('li.comment')].find(li=>li.dataset.commentId===id);
  const own = (li,selector) => li.querySelector(`:scope > .comment-main > ${selector}`);
  const submitForm = form => form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  const typeInto = (box,value) => { box.value=value; box.dispatchEvent(new w.Event('input')); };
  const openReply = id => { press(own(commentNode('IDEA-004',id),'.comment-actions'),'Reply'); return own(commentNode('IDEA-004',id),'.reply-slot .comment-input'); };
  openCard('IDEA-004');
  type('IDEA-004','Root for replies');postIn('IDEA-004');await settled();
  const rootId=comments.find(c=>c.body==='Root for replies').id;
  await wait(()=>commentNode('IDEA-004',rootId));
  check(labels(own(commentNode('IDEA-004',rootId),'.comment-actions')),['Reply'],'every comment has a Reply control');
  let replyBox=openReply(rootId);
  check([!!replyBox,d.activeElement===replyBox,replyBox.placeholder,d.getElementById('modal').open],[true,true,'Reply to Shibo…',false],'inline reply composer opens under the comment, focused');
  const replyForm=()=>own(commentNode('IDEA-004',rootId),'.reply-slot form');
  submitForm(replyForm());
  check(replyForm().querySelector('.error-text').textContent,'Write a reply before posting.','empty reply rejected');
  const replyText='**Nested** $y^2$ <img src=x onerror=alert(1)> [x](javascript:alert(1))';
  typeInto(replyBox,replyText);
  loseNextResponse=true;submitForm(replyForm());await settled();
  const firstReplyCall=calls.at(-1);
  check([firstReplyCall.name,Object.keys(firstReplyCall.args),firstReplyCall.args.p_parent_comment_id],['reply_to_comment',['p_parent_comment_id','p_body','p_client_request_id'],rootId],'reply RPC sends only the parent, body and request ID');
  check(own(commentNode('IDEA-004',rootId),'.reply-slot .comment-input')?.value,replyText,'reply draft kept after an uncertain failure');
  submitForm(replyForm());await settled();
  check(calls.at(-1).args.p_client_request_id,firstReplyCall.args.p_client_request_id,'reply retry reuses the request ID');
  check(comments.filter(c=>c.parent_comment_id===rootId).length,1,'lost response plus retry posts one reply');
  const firstReply=comments.find(c=>c.parent_comment_id===rootId);
  await wait(()=>commentNode('IDEA-004',firstReply.id));
  let replyLi=commentNode('IDEA-004',firstReply.id);
  check([replyLi.parentElement===own(commentNode('IDEA-004',rootId),'.replies'),replyLi.dataset.depth,own(commentNode('IDEA-004',rootId),'.reply-slot').children.length],[true,'1',0],'reply nested under its parent; composer closed');
  check([replyLi.querySelector('.comment-head strong').textContent,!!replyLi.querySelector('.markdown-body strong'),!!replyLi.querySelector('.katex'),!!replyLi.querySelector('time[datetime]')],['Shibo',true,true,true],'reply shows author, time, Markdown and math');
  check(replyLi.querySelector('img,script,[onerror],a[href^="javascript"]'),null,'reply XSS inert');
  check(card('IDEA-004').querySelector('.discussion-head h3').textContent,'Discussion (2)','replies count toward the discussion total');
  let parentId=firstReply.id;
  for (let level=2;level<=6;level++) {
    typeInto(openReply(parentId),`Level ${level}`);
    submitForm(own(commentNode('IDEA-004',parentId),'.reply-slot form'));await settled();
    parentId=comments.find(c=>c.body===`Level ${level}`).id;
    await wait(()=>commentNode('IDEA-004',parentId));
  }
  const deepest=commentNode('IDEA-004',parentId), level3=commentNode('IDEA-004',comments.find(c=>c.body==='Level 3').id);
  check([deepest.dataset.depth,deepest.classList.contains('capped'),deepest.parentElement.classList.contains('flat'),own(level3,'.replies').classList.contains('flat')],
    ['6',true,true,false],'six levels nest; indentation stops after four');
  check(deepest.querySelector('.replying-to').textContent,'↪ Shibo','capped replies still name their parent');
  check(own(level3,'.replies').classList.contains('flat-mobile'),true,'phones stop indenting after two levels');
  const rootToggle=()=>own(commentNode('IDEA-004',rootId),'.comment-actions .thread-toggle');
  check(rootToggle().textContent,'Hide replies','thread expanded by default');
  rootToggle().click();
  check([own(commentNode('IDEA-004',rootId),'.replies').hidden,rootToggle().textContent],[true,'Show 6 replies'],'long thread collapses');
  rootToggle().click();
  check(own(commentNode('IDEA-004',rootId),'.replies').hidden,false,'thread expands again');

  // An open reply box survives Realtime refreshes untouched.
  const draftBox=openReply(rootId);
  typeInto(draftBox,'Reply draft in progress');draftBox.focus();draftBox.setSelectionRange(6,6);
  currentId='member-2';
  await client.rpc('reply_to_comment',{p_parent_comment_id:rootId,p_body:'Remote nested reply',p_client_request_id:'00000000-0000-4000-8000-000000000077'});
  await client.rpc('add_comment',{p_idea_id:'idea-4',p_body:'Remote top-level',p_client_request_id:'00000000-0000-4000-8000-0000000c0de2'});
  currentId='member-0';
  await app.loadIdeas();
  check([own(commentNode('IDEA-004',rootId),'.reply-slot .comment-input')===draftBox,draftBox.value,d.activeElement===draftBox,draftBox.selectionStart],[true,'Reply draft in progress',true,6],'open reply box keeps its node, text, focus and caret');
  const remoteReply=comments.find(c=>c.body==='Remote nested reply');
  check(commentNode('IDEA-004',remoteReply.id)?.parentElement===own(commentNode('IDEA-004',rootId),'.replies'),true,'remote reply inserted under the right parent while typing');
  check([card('IDEA-004').textContent.includes('Remote top-level'),card('IDEA-004').querySelector('.discussion-head h3').textContent],[true,'Discussion (9)'],'remote top-level comment and count update while typing');
  draftBox.blur();await app.loadIdeas();
  const rebuiltBox=own(commentNode('IDEA-004',rootId),'.reply-slot .comment-input');
  check([rebuiltBox!==draftBox,rebuiltBox.value],[true,'Reply draft in progress'],'rebuilt thread restores the open reply box and its draft');
  w.confirm=()=>false;press(own(commentNode('IDEA-004',rootId),'.reply-slot form'),'Cancel');
  check(own(commentNode('IDEA-004',rootId),'.reply-slot .comment-input')?.value,'Reply draft in progress','cancel asks before discarding a draft');
  w.confirm=()=>true;press(own(commentNode('IDEA-004',rootId),'.reply-slot form'),'Cancel');
  check([own(commentNode('IDEA-004',rootId),'.reply-slot').children.length,app.state.commentDrafts.has(`reply:${rootId}`)],[0,false],'cancel closes the reply box and discards the draft');

  // Sorting applies to top-level comments; replies stay chronological.
  const sort4=card('IDEA-004').querySelector('.discussion-head select');sort4.value='newest';sort4.dispatchEvent(new w.Event('change'));
  const topBodies=()=>[...card('IDEA-004').querySelectorAll('.comment-list > li.comment')].map(li=>own(li,'.comment-content').textContent.trim());
  check(topBodies(),['Remote top-level','Root for replies'],'newest-first top-level order');
  check([...own(commentNode('IDEA-004',rootId),'.replies').children].map(li=>li.dataset.commentId),[firstReply.id,remoteReply.id],'replies stay oldest-first');
  sort4.value='oldest';sort4.dispatchEvent(new w.Event('change'));

  // Removing a parent keeps its replies and closes it to new replies.
  press(own(commentNode('IDEA-004',rootId),'.comment-head'),'Delete');
  await wait(()=>commentNode('IDEA-004',rootId)?.classList.contains('removed'));await settled();
  const removedRoot=commentNode('IDEA-004',rootId);
  check([own(removedRoot,'.comment-content').textContent.includes('Comment removed by Shibo'),own(removedRoot,'.replies').children.length,labels(own(removedRoot,'.comment-actions')).includes('Reply')],
    [true,2,false],'removed parent shows a placeholder and keeps its replies');
  check(labels(own(commentNode('IDEA-004',firstReply.id),'.comment-actions')).includes('Reply'),true,'replies under a removed parent can still be answered');
  typeInto(openReply(firstReply.id),'Draft **reply** with $x^2$');await snapshot('replies.html');
  w.confirm=()=>true;press(own(commentNode('IDEA-004',firstReply.id),'.reply-slot form'),'Cancel');
  app.openHistory(ideaById('idea-4'));await wait(()=>d.querySelectorAll('.history li').length>0);
  check(text('modal-body').includes('replied to Shibo’s comment'),true,'history shows replies');
  app.closeModal();

  // ---- Author deletion at top level and deep in a mixed-author thread.
  currentId='member-2';await app.loadCurrentUser(session());await settled();
  openCard('IDEA-004');await wait(()=>commentNode('IDEA-004',remoteReply.id));
  const deleteControl = id => own(commentNode('IDEA-004',id),'.comment-head .comment-remove');
  for (const li of card('IDEA-004').querySelectorAll('li.comment')) {
    const comment=comments.find(c=>c.id===li.dataset.commentId);
    check(!!own(li,'.comment-head .comment-remove'),!comment.removed_at && comment.author_id===currentId,'mixed-author nested Delete visibility');
  }
  const ownTop = comments.find(c=>c.body==='Remote top-level');
  check([deleteControl(ownTop.id)?.textContent,deleteControl(remoteReply.id)?.textContent,!!deleteControl(firstReply.id)],['Delete','Delete',false],'researcher can delete own root/reply but not another author reply');
  const callsBeforeCancel=calls.length;let confirmText;
  w.confirm=message=>{confirmText=message;return false;};deleteControl(ownTop.id).click();await settled();
  check([calls.length,ownTop.removed_at],[callsBeforeCancel,null],'cancel deletion makes no RPC or change');
  check(confirmText.includes('replies and its original text in the activity history are kept'),true,'confirmation explains soft deletion');
  w.confirm=()=>true;
  rpcError={code:'42501',message:'Permission denied'};deleteControl(ownTop.id).click();await settled();rpcError=null;
  check([ownTop.removed_at,!!deleteControl(ownTop.id),text('notifications').includes('permission')],[null,true,true],'failed deletion keeps body and Delete control and shows permission error');
  deleteControl(ownTop.id).click();await settled();
  check([ownTop.removed_by,!!deleteControl(ownTop.id),own(commentNode('IDEA-004',ownTop.id),'.comment-content').textContent.includes('Comment removed by Junqi')],['member-2',false,true],'author deletes own top-level comment with attribution');
  // A nested author deletion retains another member's child and its Reply action.
  currentId='member-1';await client.rpc('reply_to_comment',{p_parent_comment_id:remoteReply.id,p_body:'Retained child of deleted reply',p_client_request_id:'00000000-0000-4000-8000-000000000079'});currentId='member-2';
  await app.loadIdeas();await settled();
  const retainedChild=comments.find(c=>c.body==='Retained child of deleted reply');
  const retainedBefore=clone(retainedChild);
  deleteControl(remoteReply.id).click();await settled();
  check([remoteReply.removed_by,!!deleteControl(remoteReply.id),!!commentNode('IDEA-004',retainedChild.id)],['member-2',false,true],'author deletes own nested reply and retains child');
  check(retainedChild,retainedBefore,'child data unchanged');
  check(labels(own(commentNode('IDEA-004',retainedChild.id),'.comment-actions')).includes('Reply'),true,'retained child still accepts replies');
  // Realtime removal while typing keeps the descendant composer and its draft.
  currentId='member-1';await app.loadCurrentUser(session());await settled();openCard('IDEA-004');
  const childBox=openReply(retainedChild.id);typeInto(childBox,'Keep this descendant draft');childBox.focus();childBox.setSelectionRange(4,4);
  currentId='member-0';await client.rpc('remove_comment',{p_comment_id:retainedChild.id});currentId='member-1';
  await app.loadIdeas();
  check([!!deleteControl(retainedChild.id),own(commentNode('IDEA-004',retainedChild.id),'.comment-content').textContent.includes('Comment removed by Shibo'),childBox.value,d.activeElement===childBox,childBox.selectionStart],
    [false,true,'Keep this descendant draft',true,4],'remote PI removal hides Delete and preserves focused draft');
  childBox.blur();currentId='member-0';await app.loadCurrentUser(session());await settled();

  // ---- Default numeric order and IDs beyond 999, including restored ideas with old timestamps.
  const restoredIdeas=[[1000,'Restored idea A','2026-09-01T00:00:00Z'],[10000,'Restored idea B','2026-08-01T00:00:00Z'],[999,'Restored idea C','2026-10-20T00:00:00Z']]
    .map(([n,title,created])=>({...base,id:`idea-n${n}`,idea_number:n,title,created_at:created,updated_at:created}));
  ideas.push(...restoredIdeas);await app.loadIdeas();click('clear-filters');
  check(d.getElementById('sort').value,'number-desc','default sort is idea number descending');
  check([...d.getElementById('sort').options].map(o=>[o.value,o.textContent]),[['number-desc','Idea number ↓'],['number','Idea number ↑'],['newest','Newest first'],['oldest','Oldest first']],'number ↓ (default), number ↑ and both date sorts');
  check([...app.filteredIdeas()].map(i=>i.idea_number),[10000,1000,999,4,3,2,1],'default order is numeric descending regardless of timestamps');
  const orderOf=value=>{setFilter('sort',value);return [...app.filteredIdeas()].map(i=>i.idea_number);};
  check(orderOf('number'),[1,2,3,4,999,1000,10000],'numeric ascending, not lexicographic');
  check(orderOf('number-desc'),[10000,1000,999,4,3,2,1],'numeric descending');
  check(orderOf('newest'),[999,1,2,3,4,1000,10000],'newest first still uses creation time');
  check(orderOf('oldest'),[10000,1000,1,2,3,4,999],'oldest first still uses creation time');
  setFilter('sort','newest');click('clear-filters');
  check(d.getElementById('sort').value,'number-desc','Clear filters restores Idea number ↓');
  const weekNumbers=()=>[...d.querySelectorAll('.week')].map(week=>[week.querySelector('.week-name').textContent,[...week.querySelectorAll('.idea-number')].map(el=>el.textContent)]);
  check(weekNumbers().map(([,numbers])=>numbers),[['IDEA-10000','IDEA-1000','IDEA-999','IDEA-003','IDEA-002','IDEA-001'],['IDEA-004']],'week grouping kept; numeric descending within each week, full IDs');
  setFilter('sort','number');
  check(weekNumbers().map(([,numbers])=>numbers),[['IDEA-001','IDEA-002','IDEA-003','IDEA-999','IDEA-1000','IDEA-10000'],['IDEA-004']],'number ↑ within each week');
  click('clear-filters');
  check([card('IDEA-10000')?.querySelector('.idea-title').textContent,card('IDEA-1000')?.querySelector('.idea-title').textContent],['Restored idea B','Restored idea A'],'four- and five-digit IDs are not truncated');
  await snapshot('numbers.html');

  // ---- Two collapsible levels: slate week headers, neutral idea headers.
  click('collapse-all');
  for (const week of d.querySelectorAll('.week')) { week.open=true; week.dispatchEvent(new w.Event('toggle')); }
  const firstWeek=()=>d.querySelector('.week'), weekHead=()=>firstWeek().querySelector(':scope > summary');
  const ideaHead=number=>card(number).querySelector(':scope > summary');
  const style=el=>w.getComputedStyle(el);
  const weekKey=weekHead().dataset.focusKey.replace('week-','');
  weekHead().click();
  await wait(()=>app.state.weekOpen.get(weekKey)===false);
  check(firstWeek().open,false,'clicking a week header collapses the week');
  await app.loadIdeas();
  check(firstWeek().open,false,'collapsed week stays collapsed after a Realtime refresh');
  weekHead().click();
  await wait(()=>app.state.weekOpen.get(weekKey)===true);
  check(firstWeek().open,true,'clicking again expands the week');
  check(card('IDEA-1000').open,false,'ideas start collapsed');
  const collapsedIdea=style(ideaHead('IDEA-1000')).backgroundColor;
  ideaHead('IDEA-1000').click();
  await wait(()=>app.state.ideaOpen.get('idea-n1000')===true);
  check(card('IDEA-1000').open,true,'clicking an idea header expands the idea');
  // jsdom treats the element just clicked as hovered, so measure resting colours on
  // an idea opened without a click.
  const restingOpen=card('IDEA-999');restingOpen.open=true;restingOpen.dispatchEvent(new w.Event('toggle'));
  const expandedIdea=style(ideaHead('IDEA-999')).backgroundColor, weekBackground=style(weekHead()).backgroundColor;
  check([weekBackground,collapsedIdea,expandedIdea],['rgb(31, 41, 55)','rgb(37, 43, 53)','rgb(19, 23, 28)'],'slate week header; lighter collapsed and darker expanded idea header');
  check(new Set([weekBackground,collapsedIdea,expandedIdea,style(card('IDEA-1000')).backgroundColor]).size,4,'week header, idea headers and idea content are all distinct');
  check([style(weekHead()).cursor,style(ideaHead('IDEA-1000')).cursor],['pointer','pointer'],'both headers show a pointer');
  check([...weekHead().querySelectorAll('.chevron'),...ideaHead('IDEA-1000').querySelectorAll('.chevron')].length,2,'both headers keep a caret');
  const css=[...d.querySelectorAll('style')].map(el=>el.textContent).join('');
  check(['.week>summary:hover','.idea>summary:hover','.idea[open]>summary:hover','.week:not([open])>summary .chevron,.idea:not([open])>summary .chevron{transform:rotate(-90deg)}'].every(rule=>css.includes(rule)),true,'hover feedback and rotating carets defined for both levels');
  await app.loadIdeas();
  check([card('IDEA-1000').open,style(ideaHead('IDEA-1000')).backgroundColor],[true,'rgb(19, 23, 28)'],'expanded idea stays expanded and dark after a refresh');
  ideaHead('IDEA-1000').click();
  await wait(()=>app.state.ideaOpen.get('idea-n1000')===false);
  await app.loadIdeas();
  check([card('IDEA-1000').open,style(ideaHead('IDEA-1000')).backgroundColor],[false,collapsedIdea],'collapsing restores the lighter header');
  check(style(ideaHead('IDEA-1000')).backgroundColor!==style(weekHead()).backgroundColor,true,'idea header stays distinct from the week header');
  // Collapsing a week collapses the ideas inside it; other weeks are untouched.
  const weekOfIdea=card('IDEA-1000').closest('.week'),otherWeek=[...d.querySelectorAll('.week')].find(wk=>wk!==weekOfIdea),otherIdea=otherWeek?.querySelector('.idea');
  if (otherIdea) { otherIdea.querySelector(':scope > summary').click(); await wait(()=>otherIdea.open); }
  ideaHead('IDEA-1000').click();await wait(()=>card('IDEA-1000').open);
  const innerIds=[...weekOfIdea.querySelectorAll('.idea')].map(c=>c.dataset.ideaId);
  check(innerIds.length>1 && [...weekOfIdea.querySelectorAll('.idea[open]')].length>=1,true,'an idea is expanded inside the week');
  const innerKey=weekOfIdea.querySelector(':scope > summary').dataset.focusKey.replace('week-','');
  weekOfIdea.querySelector(':scope > summary').click();
  await wait(()=>app.state.weekOpen.get(innerKey)===false);
  check(innerIds.map(id=>app.state.ideaOpen.get(id)??false),innerIds.map(()=>false),'collapsing a week collapses every idea inside it');
  await app.loadIdeas();
  const reopenedWeek=card('IDEA-1000').closest('.week');reopenedWeek.querySelector(':scope > summary').click();
  await wait(()=>app.state.weekOpen.get(innerKey)===true);
  check([...reopenedWeek.querySelectorAll('.idea[open]')].length,0,'reopening the week shows its ideas collapsed, even after a refresh');
  if (otherIdea) check(card(otherIdea.querySelector('.idea-number').textContent).open,true,'ideas in other weeks stay expanded');
  ideaHead('IDEA-10000').click();await wait(()=>card('IDEA-10000').open);
  await snapshot('headers.html');

  // ---- Priority colours: titles, a tag after every title, and both priority dropdowns.
  const tagOf=n=>card(n).querySelector('.idea-heading > .priority-tag');
  check(['IDEA-001','IDEA-002','IDEA-003','IDEA-004'].map(n=>[card(n).dataset.priority,tagOf(n)?.textContent,tagOf(n)?.previousElementSibling?.className]),
    [['high','High','idea-title'],['medium','Medium','idea-title'],['low','Low','idea-title'],['high','High','idea-title']],'each title is followed by its priority tag');
  check(card('IDEA-002').querySelector('.idea-title').textContent,'Compare memory retrieval strategies','title text itself unchanged');
  const priorityColours={high:['rgb(255, 195, 155)','rgb(255, 176, 122)'],medium:['rgb(245, 220, 150)','rgb(242, 210, 126)'],low:['rgb(205, 196, 255)','rgb(195, 184, 255)']};
  for (const [number,priority] of [['IDEA-001','high'],['IDEA-002','medium'],['IDEA-003','low']]) {
    check([style(card(number).querySelector('.idea-title')).color,style(tagOf(number)).color],priorityColours[priority],`${priority} title and tag colours`);
  }
  check(new Set(['IDEA-001','IDEA-002','IDEA-003'].map(n=>style(card(n).querySelector('.idea-title')).color)).size,3,'three priorities have three title colours');
  const priorityFilter=d.getElementById('priority-filter');
  check([priorityFilter.classList.contains('priority-select'),...['high','medium','low'].map(v=>style(priorityFilter.querySelector(`option[value=${v}]`)).color)],
    [true,priorityColours.high[1],priorityColours.medium[1],priorityColours.low[1]],'filter dropdown options use the priority colours');
  setFilter('priority-filter','low');
  check([priorityFilter.dataset.priority,style(priorityFilter).color,[...app.filteredIdeas()].map(i=>i.priority)],['low',priorityColours.low[1],['low']],'chosen priority tints the filter and still filters');
  click('clear-filters');
  check([priorityFilter.value,priorityFilter.dataset.priority],['',''],'Clear filters removes the tint');
  app.openIdeaDialog();
  const dialogPriority=d.querySelector('#modal-body select');
  check([dialogPriority.classList.contains('priority-select'),dialogPriority.dataset.priority],[true,'medium'],'publish dialog priority dropdown is tinted');
  dialogPriority.value='high';dialogPriority.dispatchEvent(new w.Event('change'));
  check([dialogPriority.dataset.priority,style(dialogPriority).color],['high',priorityColours.high[1]],'dialog dropdown follows the chosen priority');
  app.closeModal();
  ideaHead('IDEA-10000').click();await wait(()=>!card('IDEA-10000').open);
  for (const [query,expected] of [['IDEA-1000',[1000]],['idea-10000',[10000]],['1000',[1000]],['IDEA-001',[1]],['IDEA-1',[1]],['idea 999',[999]]]) {
    setFilter('search',query);check([...app.filteredIdeas()].map(i=>i.idea_number),expected,`search ${query} finds the exact number`);
  }
  click('clear-filters');
  ideas=ideas.filter(i=>!restoredIdeas.includes(i));await app.loadIdeas();

  // ---- Creator deletion: offered only on the creator's untouched ideas; enforced by the RPC.
  const ideaActions=number=>labels(card(number).querySelector('[data-slot="actions"]'));
  ideas.push({...base,id:'idea-yan-empty',idea_number:5000,title:'Yan untouched idea',created_by:'member-1'},
    {...base,id:'idea-yan-commented',idea_number:5001,title:'Yan idea with a comment',description:'# Truncated upload\n\n| a |',created_by:'member-1'},
    {...base,id:'idea-yan-race',idea_number:5002,title:'Yan idea joined meanwhile',created_by:'member-1'});
  comments.push({id:'comment-on-5001',idea_id:'idea-yan-commented',author_id:'member-2',body:'Already discussed',client_request_id:'00000000-0000-4000-8000-000000000501',
    created_at:'2026-10-15T00:00:00Z',removed_at:null,removed_by:null,parent_comment_id:null});
  currentId='member-1';await app.loadCurrentUser(session());await settled();
  check([ideaActions('IDEA-5000').includes('Delete'),ideaActions('IDEA-5000').includes('Edit')],[true,true],'creator sees Delete next to Edit on an untouched idea');
  check([ideaActions('IDEA-5001').includes('Delete'),ideaActions('IDEA-5001').includes('Edit')],[false,true],'no Delete once someone commented; Edit remains');
  check(ideaActions('IDEA-002').includes('Delete'),false,'no Delete once someone joined');
  check(ideaActions('IDEA-001').includes('Delete'),false,'no Delete on another member\'s idea');
  press(card('IDEA-5000').querySelector('[data-slot="actions"]'),'Delete');
  check([text('modal-title'),text('modal-body').includes('removes IDEA-5000 from the active workspace'),text('modal-body').includes('use Edit')],['Delete IDEA-5000?',true,true],'explicit confirmation explains the removal');
  submit();await wait(()=>!app.state.pending && !d.getElementById('modal').open);await settled();
  check(calls.at(-1),{name:'delete_idea',args:{p_idea_id:'idea-yan-empty',p_expected_revision:1}},'creator deletion uses the delete RPC');
  check(card('IDEA-5000'),undefined,'deleted idea leaves the workspace');
  participants.push(participation('idea-yan-race','member-2'));   // joined after Yan's page loaded
  press(card('IDEA-5002').querySelector('[data-slot="actions"]'),'Delete');submit();
  await wait(()=>!app.state.pending);await settled();
  check(d.querySelector('#modal-body .error-text')?.textContent,'Someone has already joined or commented on this idea, so only the PI can delete it. You can still use Edit to correct it.','server refusal explained');
  check(!!card('IDEA-5002'),true,'refused idea stays');app.closeModal();
  rpcError={code:'42501',message:'Permission denied: only the PI or the idea creator can delete this idea'};
  app.confirmAction('delete',ideaById('idea-1'));submit();await wait(()=>!app.state.pending);
  check(d.querySelector('#modal-body .error-text').textContent,'Only the PI or the member who published this idea can delete it.','ownership refusal explained');
  rpcError=null;app.closeModal();await settled();
  // Fixing a broken Markdown upload keeps the idea and its number.
  app.openIdeaDialog(ideaById('idea-yan-commented'));
  const fixEditor=d.querySelector('#modal-body textarea');fixEditor.value='# Fixed upload\n\n| a | b |\n|---|---|\n| 1 | 2 |';fixEditor.dispatchEvent(new w.Event('input'));
  submit();await wait(()=>!app.state.pending && !d.getElementById('modal').open);await settled();
  check([calls.at(-1).name,calls.at(-1).args.p_idea_id,ideaById('idea-yan-commented').idea_number,!!card('IDEA-5001')],['update_idea','idea-yan-commented',5001,true],'creator corrects Markdown in place; number unchanged');
  check(ideaById('idea-yan-commented').description.startsWith('# Fixed upload'),true,'corrected Markdown saved');
  currentId='member-0';await app.loadCurrentUser(session());await settled();
  check([ideaActions('IDEA-5001').includes('Delete'),ideaActions('IDEA-5002').includes('Delete')],[true,true],'the PI may delete ideas with contributions');
  ideas=ideas.filter(i=>!['idea-yan-commented','idea-yan-race'].includes(i.id));
  participants=participants.filter(p=>p.idea_id!=='idea-yan-race');comments=comments.filter(c=>c.id!=='comment-on-5001');
  await app.loadIdeas();

  // ---- Archive: creator or PI; archived ideas are hidden by default, greyed when shown, and cannot be joined.
  ideas.push({...base,id:'idea-dead',idea_number:5100,title:'Idea the lab gave up on',created_by:'member-1'});
  participants.push(participation('idea-dead','member-2'));
  currentId='member-1';await app.loadCurrentUser(session());await settled();
  const statValue=kind=>d.querySelector(`.stat[data-kind=${kind}] .stat-value`).textContent;
  const totalBefore=statValue('total');
  check([ideaActions('IDEA-5100').includes('Archive'),ideaActions('IDEA-001').includes('Archive'),text('overview-scope')],[true,false,'All weeks · All ideas'],'the creator may archive; others\' ideas offer no Archive');
  press(card('IDEA-5100').querySelector('[data-slot="actions"]'),'Archive');
  check([text('modal-title'),text('modal-body').includes('restore it at any time')],['Archive IDEA-5100?',true],'archive dialog explains that it is reversible');
  d.querySelector('#modal-body textarea').value='  Baseline already beats it  ';
  submit();await wait(()=>!app.state.pending && !d.getElementById('modal').open);await settled();
  check(calls.at(-1),{name:'archive_idea',args:{p_idea_id:'idea-dead',p_expected_revision:1,p_reason:'  Baseline already beats it  '}},'archive uses the archive RPC with the reason');
  check([card('IDEA-5100'),app.filteredIdeas().some(i=>i.id==='idea-dead')],[undefined,false],'archived ideas are hidden by default');
  check([statValue('total'),text('overview-scope')],[String(Number(totalBefore)-1),'All weeks · Active ideas · 1 archived'],'the overview counts active ideas and mentions the archived one');
  setFilter('archive-filter','all');
  const deadCard=card('IDEA-5100');
  deadCard.open=true;deadCard.dispatchEvent(new w.Event('toggle'));await snapshot('archived.html');
  check([deadCard.classList.contains('archived'),[...deadCard.querySelectorAll('summary .badge')].map(b=>b.textContent).includes('Archived'),
    deadCard.querySelector('.archive-note').textContent.includes('Archived by Yan'),deadCard.querySelector('.archive-note p').textContent],[true,true,true,'Baseline already beats it'],'shown archived ideas are greyed, badged and say who archived them and why');
  check([ideaActions('IDEA-5100').includes('Join idea'),ideaActions('IDEA-5100').includes('Restore'),ideaActions('IDEA-5100').includes('Archive')],[false,true,false],'no Join on an archived idea; Restore replaces Archive');
  setFilter('archive-filter','only');
  check([...app.filteredIdeas()].map(i=>i.id),['idea-dead'],'Archived only');
  setFilter('status-filter','open');
  check(app.filteredIdeas().length,0,'an archived idea is never Open');
  click('clear-filters');
  check([d.getElementById('archive-filter').value,!!card('IDEA-5100')],['',false],'Clear filters hides archived ideas again');
  app.joinIdea(ideaById('idea-dead'));await settled();
  check(text('notifications').includes('This idea has been archived, so it can no longer be joined.'),true,'a join refused by the server is explained');
  currentId='member-2';await app.loadCurrentUser(session());await settled();await wait(()=>app.state.notifications.lastRead!==null);
  setFilter('archive-filter','all');
  check([ideaActions('IDEA-5100').includes('Restore'),ideaActions('IDEA-5100').includes('Archive')],[false,false],'a participant who did not publish it cannot restore it');
  currentId='member-1';await client.rpc('unarchive_idea',{p_idea_id:'idea-dead',p_expected_revision:ideaById('idea-dead').revision});currentId='member-2';
  await app.loadIdeas();await wait(()=>app.state.notifications.items[0]?.text==='Yan restored an idea you joined');
  check([card('IDEA-5100').classList.contains('archived'),!!card('IDEA-5100').querySelector('.archive-note')],[false,false],'a restored idea is active again');
  app.openHistory(ideaById('idea-dead'));await wait(()=>d.querySelectorAll('#modal-body .history li').length>=2);
  check([...d.querySelectorAll('#modal-body .history li strong')].map(el=>el.textContent).slice(0,2),['IDEA-5100 · Yan restored the idea.','IDEA-5100 · Yan archived the idea.'],'history records archive and restore');
  check([...d.querySelectorAll('#modal-body .history li .notes')].some(el=>el.textContent==='Baseline already beats it'),true,'history keeps the reason');
  app.closeModal();click('clear-filters');
  ideas=ideas.filter(i=>i.id!=='idea-dead');participants=participants.filter(p=>p.idea_id!=='idea-dead');
  currentId='member-0';await app.loadCurrentUser(session());await settled();

  // ---- Notifications: derived from activity history; read position shared across devices.
  const bellCount=()=>d.getElementById('bell-count').hidden ? 0 : d.getElementById('bell-count').textContent;
  const bellTexts=()=>[...d.querySelectorAll('#bell-list .bell-text')].map(el=>el.textContent);
  const bellButton=d.getElementById('bell-button'), bellPanel=d.getElementById('bell-panel');
  const openBell=()=>{ if (bellPanel.hidden) bellButton.click(); };
  const closeBell=()=>{ if (!bellPanel.hidden) bellButton.click(); };
  const actAs=async (member,name,args)=>{ const previous=currentId; currentId=member; try { return (await client.rpc(name,args)).data; } finally { currentId=previous; } };
  await app.loadIdeas();await wait(()=>app.state.notifications.lastRead!==null);
  openBell();await wait(()=>bellCount()===0);closeBell();
  check(notificationReads.find(r=>r.member_id==='member-0').last_read_event_id,events.at(-1).id,'opening the bell records the read position');
  ideas.push({...base,id:'idea-notify',idea_number:6000,title:'Notification test idea',created_by:'member-0'});
  comments.push({id:'comment-notify-root',idea_id:'idea-notify',author_id:'member-0',body:'Root by Shibo',client_request_id:'00000000-0000-4000-8000-000000000601',
    created_at:'2026-10-16T16:00:00Z',removed_at:null,removed_by:null,parent_comment_id:null});
  await app.loadIdeas();
  await actAs('member-1','create_idea',{p_title:'Yan idea for everyone',p_description:'',p_week_start:'2026-10-12',p_priority:'low'});
  await actAs('member-2','add_comment',{p_idea_id:'idea-notify',p_body:'Junqi top-level',p_client_request_id:'00000000-0000-4000-8000-000000000602'});
  await actAs('member-2','reply_to_comment',{p_parent_comment_id:'comment-notify-root',p_body:'Junqi reply',p_client_request_id:'00000000-0000-4000-8000-000000000603'});
  const yifanJoin=await actAs('member-3','join_idea',{p_idea_id:'idea-notify'});
  const yifanResult=await actAs('member-3','submit_result',{p_idea_id:'idea-notify',p_expected_revision:yifanJoin.revision,p_result:'success',p_notes:null,p_experiment_url:null});
  await actAs('member-3','submit_result',{p_idea_id:'idea-notify',p_expected_revision:yifanResult.revision,p_result:'fail',p_notes:null,p_experiment_url:null});
  await actAs('member-1','add_comment',{p_idea_id:'idea-2',p_body:'Yan on her own idea',p_client_request_id:'00000000-0000-4000-8000-000000000604'});
  await actAs('member-0','add_comment',{p_idea_id:'idea-notify',p_body:'Shibo own comment',p_client_request_id:'00000000-0000-4000-8000-000000000605'});
  await app.loadIdeas();
  await wait(()=>bellCount()==='6');
  check(text('notifications').includes('Yifan changed their result from Success to Fail on your idea: IDEA-6000 Notification test idea'),true,'new notifications pop up while the page is open');
  check(bellButton.getAttribute('aria-label'),'Notifications, 6 unread','unread count announced');
  openBell();
  check(bellTexts().slice(0,6),['Yifan changed their result from Success to Fail on your idea','Yifan submitted a Success result on your idea','Yifan joined your idea','Junqi replied to your comment','Junqi commented on your idea','Yan published a new idea'],
    'relevant notifications newest first; own actions and unrelated comments excluded');
  check(bellTexts().length > 6 && [...d.querySelectorAll('#bell-list .bell-item')].slice(6).every(li=>!li.classList.contains('unread')),true,'older notifications stay listed as read');
  check([d.querySelectorAll('#bell-list .bell-item.unread').length,d.querySelector('#bell-list .bell-item .comment-avatar').textContent],[6,'Yi'],'unread items highlighted with the actor avatar');
  await snapshot('notifications.html');
  await wait(()=>bellCount()===0);
  check([readCalls.at(-1).p_last_event_id,notificationReads.find(r=>r.member_id==='member-0').last_read_event_id],[events.at(-1).id,events.at(-1).id],'opening the list marks everything read on the server');
  [...d.querySelectorAll('#bell-list .bell-item button')].find(b=>b.textContent.includes('replied to your comment')).click();
  await wait(()=>card('IDEA-6000')?.open && card('IDEA-6000').querySelector('li.comment.flash'));
  check([bellPanel.hidden,card('IDEA-6000').querySelector('li.comment.flash .markdown-body').textContent.trim()],[true,'Junqi reply'],'a notification opens the idea and highlights the reply');
  openBell();d.body.click();check(bellPanel.hidden,true,'clicking outside closes the list');
  openBell();d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape'}));check([bellPanel.hidden,d.activeElement===bellButton],[true,true],'Escape closes the list and returns focus');
  await actAs('member-2','add_comment',{p_idea_id:'idea-notify',p_body:'Another comment',p_client_request_id:'00000000-0000-4000-8000-000000000606'});
  await app.loadIdeas();await wait(()=>bellCount()==='1');
  notificationReads.find(r=>r.member_id==='member-0').last_read_event_id=events.at(-1).id; // read on another device
  await app.loadIdeas();await wait(()=>bellCount()===0);
  check(bellCount(),0,'reading on another device clears the badge here');
  // A researcher: own idea deleted, own comment removed, own result reopened, and new ideas from others.
  currentId='member-1';await app.loadCurrentUser(session());await settled();
  await wait(()=>app.state.notifications.lastRead!==null);
  openBell();await wait(()=>bellCount()===0);closeBell();
  const yanIdea=ideas.find(i=>i.title==='Yan idea for everyone');
  const yanComment=(await client.rpc('add_comment',{p_idea_id:'idea-notify',p_body:'Yan comment',p_client_request_id:'00000000-0000-4000-8000-000000000607'})).data;
  const yanJoin=(await client.rpc('join_idea',{p_idea_id:'idea-notify'})).data;
  const yanResult=(await client.rpc('submit_result',{p_idea_id:'idea-notify',p_expected_revision:yanJoin.revision,p_result:'fail',p_notes:null,p_experiment_url:null})).data;
  await actAs('member-0','remove_comment',{p_comment_id:yanComment.id});
  await actAs('member-0','reopen_result',{p_idea_id:'idea-notify',p_member_id:'member-1',p_expected_revision:yanResult.revision});
  await actAs('member-2','create_idea',{p_title:'Junqi idea for everyone',p_description:'',p_week_start:'2026-10-12',p_priority:'medium'});
  await actAs('member-0','delete_idea',{p_idea_id:yanIdea.id,p_expected_revision:yanIdea.revision});
  await app.loadIdeas();await wait(()=>bellCount()==='4');
  openBell();
  check(bellTexts().slice(0,4),['Shibo deleted your idea','Junqi published a new idea','Shibo reopened your result','Shibo removed your comment'],'researcher notifications');
  [...d.querySelectorAll('#bell-list .bell-item button')].find(b=>b.textContent.includes('deleted your idea')).click();
  await wait(()=>d.getElementById('modal').open);
  check(text('modal-title'),`${'IDEA-'+String(yanIdea.idea_number).padStart(3,'0')} · History`,'a deleted idea opens its activity history');
  app.closeModal();
  notificationsFail=true;await app.loadIdeas();await wait(()=>app.state.notifications.unavailable);
  check(d.getElementById('dashboard').hidden,false,'the dashboard keeps working without the notification table');
  openBell();check(text('bell-list').includes('unavailable'),true,'the list explains that notifications are unavailable');closeBell();
  notificationsFail=false;
  ideas=ideas.filter(i=>i.id!=='idea-notify' && i.title!=='Junqi idea for everyone');
  comments=comments.filter(c=>c.idea_id!=='idea-notify');participants=participants.filter(p=>p.idea_id!=='idea-notify');
  currentId='member-0';await app.loadCurrentUser(session());await settled();
  check([bellPanel.hidden,app.state.notifications.items.every(item=>item.event.actor_id!=='member-0')],[true,true],'switching accounts closes the list and rebuilds it for the new member');

  // ---- Conflicts, refresh coalescing, stale and offline states.
  rpcError={message:'Already participating in this idea'};
  await app.joinIdea(ideaById('idea-2'));check(text('notifications').includes('already participating'),true,'conflict notification');rpcError=null;
  let releaseRead;delayRead=new Promise(resolve=>releaseRead=resolve);
  const refresh=app.loadIdeas();const again=app.loadIdeas();check(refresh===again,true,'duplicate refresh coalescing');releaseRead();await refresh;
  readsFail=true;await app.loadIdeas();check(app.state.stale,true,'stale state surfaced');
  check(d.getElementById('sync-banner').hidden,false,'stale banner');
  check(d.getElementById('create-button').disabled,true,'stale mutations disabled');readsFail=false;await app.loadIdeas();
  check(app.state.stale,false,'successful refresh clears stale');
  Object.defineProperty(w.navigator,'onLine',{configurable:true,value:false});w.dispatchEvent(new w.Event('offline'));
  check(text('connection'),'Offline','offline indicator');check(d.getElementById('create-button').disabled,true,'offline mutations paused');
  Object.defineProperty(w.navigator,'onLine',{configurable:true,value:true});w.dispatchEvent(new w.Event('online'));await wait(()=>app.state.live);
  check(removed>0,true,'old channel cleaned up');
  currentId='member-1';await app.loadCurrentUser(session());

  // Two receiving frontends, neither of which submits the remote mutations.
  // Disable periodic polling so only the delivered idea_events INSERTs can
  // cause these refreshes. Transport delivery is simulated, not hosted Realtime.
  await wait(()=>app.state.live && !app.state.refreshTask);
  w.clearInterval(app.state.pollTimer);
  const firstChannel=channel;
  const observerDOM=new JSDOM(html,{url:'http://127.0.0.1:8765/',runScripts:'outside-only',pretendToBeVisual:true});
  const observerWindow=observerDOM.window;
  installMarkdownLibraries(observerWindow);
  observerWindow.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  observerWindow.HTMLDialogElement.prototype.close=function(){this.open=false;};
  let observerChannel;
  observerWindow.supabase={createClient:()=>({
    ...client,
    auth:{...client.auth,onAuthStateChange(callback){setTimeout(()=>callback('INITIAL_SESSION',{user:{id:'member-3'},access_token:'observer-test-token'}),0);}},
    channel(){observerChannel=client.channel();return observerChannel;}
  })};
  observerWindow.eval(script+'\nwindow.__app = {state};');
  try {
    await wait(()=>observerWindow.__app.state.loaded && observerWindow.__app.state.live && !observerWindow.__app.state.refreshTask);
    observerWindow.clearInterval(observerWindow.__app.state.pollTimer);
    const receivers=[app.state,observerWindow.__app.state];
    check(receivers.map(s=>s.userId),['member-1','member-3'],'independent authorized receiver identities');
    const deliverEvent=()=>{
      for (const receiver of [firstChannel,observerChannel]) {
        receiver.handlers.filter(h=>h.filter.table==='idea_events').forEach(h=>h.callback({schema:'public',table:'idea_events',eventType:'INSERT',new:clone(events.at(-1))}));
      }
    };
    const remote=async (member,name,args)=>{currentId=member;const result=await client.rpc(name,args);currentId='member-1';return result;};
    await remote('member-2','join_idea',{p_idea_id:'idea-1'});
    check(receivers.every(s=>!s.participants.some(p=>p.idea_id==='idea-1' && p.member_id==='member-2')),true,'receivers unchanged before delivery');
    deliverEvent();
    await wait(()=>receivers.every(s=>s.participants.some(p=>p.idea_id==='idea-1' && p.member_id==='member-2')));
    check(true,true,'remote join reaches both receivers through the audit INSERT');
    const junqiRow=participants.find(p=>p.idea_id==='idea-1' && p.member_id==='member-2');
    await remote('member-2','submit_result',{p_idea_id:'idea-1',p_expected_revision:junqiRow.revision,p_result:'fail',p_notes:null,p_experiment_url:null});
    deliverEvent();
    await wait(()=>receivers.every(s=>s.participants.some(p=>p.idea_id==='idea-1' && p.member_id==='member-2' && p.result==='fail')));
    check(receivers.every(s=>s.participants.find(p=>p.idea_id==='idea-1' && p.member_id==='member-0')?.result==='success'),true,'remote result leaves Shibo result intact');
    await remote('member-2','add_comment',{p_idea_id:'idea-1',p_body:'Remote comment',p_client_request_id:'00000000-0000-4000-8000-000000000099'});
    deliverEvent();
    await wait(()=>receivers.every(s=>s.commentCounts.get('idea-1')===1));
    check(true,true,'remote comment count reaches both receivers');
    const remoteParent=comments.find(c=>c.idea_id==='idea-1' && c.body==='Remote comment');
    await remote('member-3','reply_to_comment',{p_parent_comment_id:remoteParent.id,p_body:'Remote reply',p_client_request_id:'00000000-0000-4000-8000-000000000098'});
    deliverEvent();
    await wait(()=>receivers.every(s=>(s.commentsByIdea.get('idea-1') || []).some(c=>c.parent_comment_id===remoteParent.id)));
    check(receivers.every(s=>s.commentCounts.get('idea-1')===2),true,'remote reply reaches both receivers');
    const target=ideas.find(i=>i.id==='idea-1');
    await remote('member-0','delete_idea',{p_idea_id:'idea-1',p_expected_revision:target.revision});
    check(events.at(-1).event_type,'deleted','remote deletion audit source');
    deliverEvent();
    await wait(()=>receivers.every(s=>!s.ideas.some(i=>i.id==='idea-1')));
    check(receivers.every(s=>!s.participants.some(p=>p.idea_id==='idea-1')),true,'audit INSERT alone removes deleted idea and its participants');
    check([d,observerWindow.document].every(doc=>!doc.getElementById('ideas').textContent.includes('Evaluate tool selection')),true,'both rendered lists remove deleted idea');
  } finally { observerWindow.close(); }

  await app.loadCurrentUser({user:{id:'outsider'},access_token:'test'});
  check(d.getElementById('dashboard').hidden,true,'unauthorized cannot enter dashboard');
  check(text('access-title'),'Access has not been granted','allowlist denial');
  check(d.querySelectorAll('.idea').length,0,'previous account data cleared');
  check(app.state.participants.length,0,'previous participant data cleared');
  currentId='member-0';await app.loadCurrentUser(session());

  const markdown = '\uFEFF# Suggested **research** title\r\n\r\n## Method\r\n- **Bold** and *italic*\r\n- ~~Discarded~~\r\n\r\n| Model | Score |\r\n| --- | --- |\r\n| A | $x_i^2$ |\r\n\r\nInline $\\alpha_i+\\beta$ and [paper](https://example.org/paper).\r\n\r\n$$\r\n\\begin{aligned} a &= b \\\\ c &= \\sqrt{x} \\end{aligned}\r\n$$\r\n\r\n```python\r\n# Not another idea\r\nprint("$literal$")\r\n```\r\n\r\n# A second H1 stays in the same idea\r\n\r\n$$x$$ trailing explanation\r\n\r\n$$\\text{cost: \\$5}$$\r\n';
  const rendered=d.createElement('div');app.renderMarkdown(rendered,markdown);
  check(rendered.querySelector('h1').textContent,'Suggested research title','Markdown H1 rendered');
  check(rendered.querySelectorAll('h1').length,2,'multiple headings kept in one document');
  check(rendered.querySelectorAll('table tbody tr').length,1,'GFM table rendered');
  check(!!rendered.querySelector('ul li strong') && !!rendered.querySelector('em') && !!rendered.querySelector('s'),true,'lists, emphasis and strikethrough');
  check(rendered.querySelectorAll('.katex').length,5,'inline/table/display math rendered by actual KaTeX');
  check(rendered.querySelectorAll('.katex-display').length,3,'display math');
  check(rendered.querySelector('pre code').textContent.includes('$literal$'),true,'code dollar signs not rendered as math');
  check(rendered.querySelector('a').getAttribute('rel'),'noopener noreferrer','safe external link');
  check(rendered.querySelector('a').getAttribute('target'),'_blank','external link tab');
  check(app.suggestedMarkdownTitle(markdown,'fallback.md').title,'Suggested research title','first H1 suggestion');
  check(app.suggestedMarkdownTitle('```md\n# Fake H1\n```\n\nReal title\n==========','fallback.md').title,'Real title','Setext H1 and fenced heading exclusion');
  check(app.suggestedMarkdownTitle('    # Code only\n\n## Second level','fallback.MD').title,'fallback','no H1 uses filename');
  check(app.suggestedMarkdownTitle('# '+ 'a'.repeat(210),'fallback.md').title.length,200,'long suggested title is bounded');
  app.renderMarkdown(rendered,'Escaped \\$5 and `$$not_math$$`.\n\n$$\\def\\loop{\\loop}\\loop$$');
  check(rendered.textContent.includes('$5') && rendered.querySelector('code').textContent==='$$not_math$$',true,'escaped dollar and inline code');
  check(!!rendered.querySelector('.katex-error'),true,'malformed/infinite math fails safely');
  app.renderMarkdown(rendered,'$\\gdef\\leak{123}\\leak$ then $\\leak$');
  check(rendered.textContent.includes('\\leak'),true,'macros do not leak between expressions');
  // Regressions: capture source passed to the real KaTeX engine (DOMPurify
  // removes annotation nodes), then inspect the sanitized result and prose.
  const mathCases = [
    ['$$x$$ trailing explanation', ['x'], 1, ['trailing explanation']],
    [String.raw`$$\text{cost: \$5}$$`, [String.raw`\text{cost: \$5}`], 1, []],
    ['before $$x$$ after $y$ end', ['x','y'], 1, ['before','after','end']],
    ['$$x$$ between $$y$$ trailing', ['x','y'], 2, ['between','trailing']],
    ['$$x$$$$y$$ adjacent', ['x','y'], 2, ['adjacent']],
    [String.raw`$\text{cost: \$5}$ and $z$`, [String.raw`\text{cost: \$5}`,'z'], 0, ['and']],
    [String.raw`$$\text{cost: \$5 and \$10}$$ (1) explanation`, [String.raw`\text{cost: \$5 and \$10}`], 1, ['(1)','explanation']],
    [String.raw`$$\{x\}\quad 50\%\quad a\_b$$ tail`, [String.raw`\{x\}\quad 50\%\quad a\_b`], 1, ['tail']],
    ['$$\n\\begin{aligned}a &= b \\\\\nc &= d\\end{aligned}\n$$ closing explanation\n\n# Next heading', ['\n\\begin{aligned}a &= b \\\\\nc &= d\\end{aligned}\n'], 1, ['closing explanation','Next heading']],
    ['$$\nx+1\n\n+y\n$$ trailing after blank line', ['\nx+1\n\n+y\n'], 1, ['trailing after blank line']],
    ['$$x$$\nnext line $y$\n\n$$z$$ final line', ['x','y','z'], 2, ['next line','final line']],
    ['> $$x+1$$ quoted tail', ['x+1'], 1, ['quoted tail']],
    ['- $$x$$ list tail $y$', ['x','y'], 1, ['list tail']],
    [String.raw`$$\$$$ escaped dollar at end`, [String.raw`\$`], 1, ['escaped dollar at end']],
    [String.raw`$\$$ inline escaped dollar`, [String.raw`\$`], 0, ['inline escaped dollar']],
    [String.raw`$$x\\$$ even backslashes before delimiter`, [String.raw`x\\`], 1, ['even backslashes before delimiter']],
    [String.raw`Escaped \$5, $x$ and \$10.`, ['x'], 0, ['$5', '$10']],
    [String.raw`$$\text{slash: \\}$$ tail`, [String.raw`\text{slash: \\}`], 1, ['tail']],
  ];
  for (const [source, formulas, displays, prose] of mathCases) {
    const mathEngine=w.katex.renderToString, received=[];
    w.katex.renderToString=(tex,options)=>{received.push(tex);return mathEngine(tex,options);};
    try { app.renderMarkdown(rendered,source); } finally { w.katex.renderToString=mathEngine; }
    check(received,formulas,`complete TeX reaches KaTeX: ${source}`);
    check(rendered.querySelectorAll('.katex-display').length,displays,'inline/display modes retained');
    check(rendered.querySelector('.katex-error,.markdown-notice'),null,'valid escaped and multiline math renders without fallback');
    check(prose.every(part=>rendered.textContent.includes(part)),true,`adjacent prose retained: ${source}`);
    check((await app.readMarkdownFile(new w.File([source],'math.md'))).source,source,'math import preserves the complete original source');
  }
  app.renderMarkdown(rendered,'Unclosed $$x and tail\n\n`$$literal$$`\n\n```tex\n$$\\text{cost: \\$5}$$\n```');
  check(rendered.textContent.includes('Unclosed $$x and tail'),true,'unclosed display delimiters remain visible');
  check([...rendered.querySelectorAll('code')].map(el=>el.textContent),['$$literal$$','$$\\text{cost: \\$5}$$\n'],'code math and escapes remain literal');

  // ---- Research-style Markdown: escaped stars, \( \) / \[ \] delimiters, Chinese
  // mixed with math, nested lists and long formulas (synthetic content only).
  const unsupported = el => [...el.querySelectorAll('.katex [style*="cc0000"],.katex-error')].map(node=>node.textContent);
  const texSeen = source => {
    const engine=w.katex.renderToString, received=[];
    w.katex.renderToString=(tex,options)=>{received.push([tex,!!options.displayMode]);return engine(tex,options);};
    try { app.renderMarkdown(rendered,source); } finally { w.katex.renderToString=engine; }
    return received;
  };
  check(texSeen(String.raw`总质量 $\nu(\mathcal{M}) = \|\theta^{\*}\|^2/L$ 由 Euler 恒等式给定；被 $\theta^\*$ 约束的只有 margin。`),
    [[String.raw`\nu(\mathcal{M}) = \|\theta^{\*}\|^2/L`,false],[String.raw`\theta^\*`,false]],'escaped stars reach KaTeX unchanged');
  check([unsupported(rendered),rendered.textContent.includes('∗')],[[],true],'Markdown-escaped \\* inside math renders as a star, not a red \\*');
  check(texSeen(String.raw`行内 \(\nu \ll \pi\) 与 \(\int_{\mathcal{M}} \phi\,d\nu = m\)，以及 \[ \sum_k \mu_k \] 行内展示。`),
    [[String.raw`\nu \ll \pi`,false],[String.raw`\int_{\mathcal{M}} \phi\,d\nu = m`,false],[String.raw` \sum_k \mu_k `,true]],'\\( \\) inline and \\[ \\] inline-display delimiters');
  check([rendered.querySelectorAll('.katex').length,rendered.querySelectorAll('.katex-display').length,rendered.textContent.includes('行内展示')],[3,1,true],'bracket math rendered with surrounding Chinese prose');
  check(texSeen('\\[\n\\int_{\\mathcal{M}} \\phi_k \\, d\\nu = m_k\n\\] 之后的说明\n\n下一段'),[['\n\\int_{\\mathcal{M}} \\phi_k \\, d\\nu = m_k\n',true]],'\\[ \\] block math');
  check([rendered.querySelectorAll('.katex-display').length,rendered.textContent.includes('之后的说明'),rendered.textContent.includes('下一段')],[1,true,true],'\\[ \\] block keeps trailing prose and the next paragraph');
  app.renderMarkdown(rendered,'字面量 \\\\(不是公式\\\\) 与代码 `\\(code\\)`');
  check([rendered.querySelectorAll('.katex').length,rendered.textContent.includes('\\(不是公式\\)'),rendered.querySelector('code').textContent],[0,true,'\\(code\\)'],'escaped \\\\( and code spans stay literal');
  const research=['**Must preserve:**','','- 未知量是**测度**，不是有限个点。任何把方法退化成 "优化 $M$ 张候选图" 的实现都不算实现本方法。',
    '- KKT stationarity 以**精确等式约束**进入，不作为 loss 上再加一项的 soft regularizer。',
    '  - 嵌套：reference prior $\\pi$，必须显式声明且可替换；自由度都归到 $\\pi$ 上。',
    '    - 第三层：残差证书 (moment residual + margin residual，含 held-out sketch 方向) 必须在无任何训练数据访问下可计算。',
    '- 长公式：$\\mathcal{L}(\\theta)=\\sum_{i=1}^{n}\\lambda_i\\,\\ell\\big(y_i f_\\theta(x_i)\\big)+\\frac{\\beta}{2}\\|\\theta\\|_2^2+\\gamma\\,\\mathrm{KL}\\big(q_\\phi(z\\mid x)\\,\\|\\,p(z)\\big)$ 之后继续。',
    '- 中文标点紧跟公式：$\\pi$，$\\nu$；以及「$\\theta^{*}$」。'].join('\n');
  app.renderMarkdown(rendered,research);
  check([!!rendered.querySelector('ul ul ul li'),rendered.querySelectorAll('strong').length,rendered.querySelectorAll('.katex').length,unsupported(rendered)],[true,3,7,[]],'nested lists, bold Chinese labels and all seven formulas render');
  check(['不是有限个点','soft regularizer','必须在无任何训练数据访问下可计算','之后继续','」'].every(part=>rendered.textContent.includes(part)),true,'Chinese prose around math is kept intact');
  app.renderMarkdown(rendered,'$\\unknowncommand{x}$ 后文');
  check([unsupported(rendered).length > 0,rendered.textContent.includes('后文'),rendered.querySelector('script')],[true,true,null],'unsupported commands stay visible and safe without breaking the paragraph');
  for (const attack of [String.raw`\(\href{javascript:alert(1)}{x}\)`,String.raw`\[<img src=x onerror=alert(1)>\]`,String.raw`\(\htmlStyle{background:url(https://example.org/t)}{x}\)`]) {
    app.renderMarkdown(rendered,attack);
    check(rendered.querySelector('script,img,[onerror],[href^="javascript"],[style*="url("]'),null,`bracket math stays sanitized: ${attack}`);
  }
  const attacks=[
    '$$x$$ <img src=x onerror=evil> [bad](javascript:evil)',
    String.raw`$$\text{cost: \$5}$$ <script>evil</script>`,
    '<script>alert(1)</script><img src=x onerror=alert(2)><svg onload=alert(3)></svg>',
    '[bad](javascript:alert(1)) [data](data:text/html,evil) [encoded](java&#x73;cript:alert(1))',
    '<form id=modal><input name=state></form><iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '$\\href{javascript:alert(1)}{bad}$ $\\includegraphics{https://example.org/tracker}$ $\\htmlStyle{background:url(https://example.org/tracker)}{x}$',
    '![Tracking](https://example.org/tracker.png) [relative](./secret.md)',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">'
  ];
  for (const attack of attacks) {
    app.renderMarkdown(rendered,attack);
    check(rendered.querySelector('script,img,iframe,form,input,style,object,embed,[onerror],[onload],[id],[name]'),null,'XSS/DOM clobbering payload inert');
    check([...rendered.querySelectorAll('[href],[src]')].every(el=>/^https?:/.test(el.getAttribute('href') || el.getAttribute('src'))),true,'unsafe URLs stripped');
  }
  // Verify the actual sanitizer runs after rendering. Then force unsafe math
  // renderer output to exercise the final sanitizer independently of the parser.
  const originalSanitize=w.DOMPurify.sanitize;let sanitizerCalls=0;
  w.DOMPurify.sanitize=(...args)=>{sanitizerCalls++;return originalSanitize(...args);};
  app.renderMarkdown(rendered,'# Sanitized');check(sanitizerCalls,1,'final HTML is passed to real sanitizer');
  w.DOMPurify.sanitize=originalSanitize;
  const originalMathRender=w.katex.renderToString;
  w.katex.renderToString=()=>'<img src=x onerror=evil><script>evil</script><span id=modal>safe text</span>';
  app.renderMarkdown(rendered,'$x$');
  check(rendered.querySelector('img,script,[id],[onerror]'),null,'unsafe generated markup is sanitized');
  check(rendered.textContent.includes('safe text'),true,'safe generated content retained');w.katex.renderToString=originalMathRender;
  const savedPurify=w.DOMPurify;w.DOMPurify=null;app.renderMarkdown(rendered,'<img onerror=evil> **raw**');
  check(rendered.querySelector('img,strong'),null,'missing sanitizer falls back to plain text');
  check(rendered.textContent.includes('**raw**'),true,'fallback preserves source');w.DOMPurify=savedPurify;
  const file=new w.File([markdown],'research.md',{type:'text/markdown'});
  check((await app.readMarkdownFile(file)).source,markdown,'UTF-8 BOM, CRLF and complete original source preserved');
  for (const [badFile,pattern] of [
    [new w.File(['# Title'],'not.txt',{type:'text/plain'}),/\.md/],
    [new w.File(['# Title'],'not.md',{type:'text/html'}),/file type/],
    [new w.File(['x'.repeat(1048577)],'large.md'),/1 MiB/],
    [new w.File([new Uint8Array([0xff,0xfe])],'invalid.md'),/UTF-8/],
    [new w.File(['a\0b'],'null.md'),/null character/]
  ]) { await assert.rejects(()=>app.readMarkdownFile(badFile),pattern);checks++; }
  const longSource='# Long research idea\n\n'+'é'.repeat(25000);
  check((await app.readMarkdownFile(new w.File([longSource],'long.md'))).source,longSource,'document beyond old character limit preserved');
  const beyondOld='# Large research idea\n\n'+'é $x_i$ '.repeat(60000);check(Buffer.byteLength(beyondOld)>102400,true,'fixture exceeds the old 100 KiB limit');
  check((await app.readMarkdownFile(new w.File([beyondOld],'large-ok.md'))).source,beyondOld,'document beyond the old 100 KiB limit preserved');
  await assert.rejects(()=>app.readMarkdownFile(new w.File(['😀'.repeat(262145)],'unicode.md')),/1 MiB/);checks++;
  check((await app.readMarkdownFile(new w.File(['x'.repeat(1048576)],'boundary.md'))).source.length,1048576,'exact 1 MiB byte limit accepted');

  w.confirm=()=>true;
  const importIntoForm=async files=>{
    const input=d.querySelector('#modal-body input[type=file]');
    Object.defineProperty(input,'files',{configurable:true,value:files});
    input.dispatchEvent(new w.Event('change'));
    await wait(()=>!d.querySelector('#modal-body form')?.dataset.importing);
  };
  app.openIdeaDialog();const callsBeforeImport=calls.length,ideasBeforeImport=ideas.length;
  check(d.querySelector('#modal-body input[type=file]').multiple,false,'single file picker');
  await importIntoForm([file]);
  check(calls.length,callsBeforeImport,'import never publishes');check(ideas.length,ideasBeforeImport,'import creates no rows');
  check(d.querySelector('#modal-body input[type=text]').value,'Suggested research title','import fills editable suggested title');
  check(d.querySelector('.markdown-preview h1').textContent,'Suggested research title','import shows formatted preview');
  await snapshot('markdown-preview.html');
  await importIntoForm([file,file]);check(d.querySelector('#modal-body .error-text').textContent.includes('exactly one'),true,'bulk import rejected');
  await importIntoForm([new w.File(['bad'],'bad.txt')]);
  check(d.querySelector('#modal-body textarea').value.includes('A second H1'),true,'bad import preserves previous draft');
  d.querySelector('#modal-body input[type=text]').value='PI-edited title';
  submit();await wait(()=>!app.state.pending && !d.getElementById('modal').open);
  check(calls.length,callsBeforeImport+1,'explicit publish makes one RPC');
  check(ideas.length,ideasBeforeImport+1,'one file creates exactly one idea');
  check(calls.at(-1).args.p_title,'PI-edited title','PI can override suggested title');
  check(calls.at(-1).args.p_description,markdown,'publication sends untouched full Markdown');
  const markdownIdea=app.state.ideas.at(-1);app.openIdeaDialog(markdownIdea);
  d.querySelector('#modal-body input[type=text]').value='Metadata-only edit';submit();
  await wait(()=>!app.state.pending && !d.getElementById('modal').open);
  check(calls.at(-1).args.p_description,markdown,'metadata-only edit preserves original line endings');
  // Download .md: the stored Markdown byte for byte, under the idea's number and title.
  {
    const downloadIdea=app.state.ideas.find(i=>i.id===markdownIdea.id),downloads=[],savedCreate=w.URL.createObjectURL,savedRevoke=w.URL.revokeObjectURL;
    w.URL.createObjectURL=blob=>{downloads.push({blob});return 'blob:synthetic-download';};w.URL.revokeObjectURL=()=>{};
    const catchDownload=event=>{const a=event.target.closest?.('a[download]');if(a){event.preventDefault();Object.assign(downloads.at(-1),{name:a.download,href:a.getAttribute('href')});}};
    d.addEventListener('click',catchDownload,true);
    const card=[...d.querySelectorAll('.idea[data-idea-id]')].find(c=>c.dataset.ideaId===downloadIdea.id);
    const downloadButton=[...card.querySelectorAll('.idea-actions button')].find(b=>b.textContent==='Download .md');
    check([!!downloadButton,downloadButton?.dataset.mutation],[true,undefined],'Download .md offered on the idea and not treated as a write');
    const callsBefore=calls.length;downloadButton.click();
    const saved=downloads.at(-1),bytes=new Uint8Array(await new Promise(r=>{const reader=new w.FileReader();reader.onload=()=>r(reader.result);reader.readAsArrayBuffer(saved.blob);}));
    check([saved.name,saved.href,saved.blob.type],[`${'IDEA-'+String(downloadIdea.idea_number).padStart(3,'0')} Metadata-only edit.md`,'blob:synthetic-download','text/markdown;charset=utf-8'],'file named after the idea number and title');
    check([...bytes],[...Buffer.from(markdown,'utf8')],'downloaded file is the stored Markdown byte for byte (BOM and CRLF kept)');
    check([calls.length,d.querySelectorAll('a[download]').length],[callsBefore,0],'download makes no request and leaves no link behind');
    check(app.markdownFileName({idea_number:7,title:' a/b:c*d?"e"<f>|g\\h. '}),'IDEA-007 a b c d e f g h.md','unsafe filename characters replaced');
    check(app.markdownFileName({idea_number:12345,title:'超长标题'.repeat(40)}),'IDEA-12345 '+'超长标题'.repeat(20)+'.md','long titles shortened by character');
    check(app.markdownFileName({idea_number:3,title:'...'}),'IDEA-003.md','title without usable characters falls back to the number');
    d.removeEventListener('click',catchDownload,true);w.URL.createObjectURL=savedCreate;w.URL.revokeObjectURL=savedRevoke;
  }
  // ---- Wide screens: one idea's Markdown in the reading pane; the rest stays in the list.
  {
    const savedMatch=w.matchMedia,savedScroll=w.scrollTo,scrolls=[];let wide=true;w.scrollTo=options=>scrolls.push(options);
    w.matchMedia=query=>({matches:wide && query==='(min-width: 1100px)',addEventListener(){}});
    click('collapse-all');for (const week of d.querySelectorAll('.week')) { week.open=true; week.dispatchEvent(new w.Event('toggle')); }
    const reader=d.getElementById('reader'), dash=d.getElementById('dashboard'), head=number=>card(number).querySelector(':scope > summary');
    const [first,second]=[...d.querySelectorAll('.idea')].map(c=>c.querySelector('.idea-number').textContent);
    const firstIdea=app.state.ideas.find(i=>i.id===card(first).dataset.ideaId);
    head(first).click();await settled();
    check([reader.hidden,dash.classList.contains('reading'),card(first).open,card(first).classList.contains('selected'),text('reader-number')],[false,true,true,true,first],'wide screen: clicking an idea opens its text in the reading pane');
    check([d.querySelector('#reader-title .idea-title').textContent,!!card(first).querySelector('.discussion'),!!card(first).querySelector('[data-slot="participants"]')],[firstIdea.title,true,true],'title in the pane; participants and discussion stay in the list');
    card(second).getBoundingClientRect=()=>({top:500,bottom:560,left:0,right:0,width:0,height:60});
    head(second).click();await settled();
    check([card(first).open,card(second).open,text('reader-number'),d.querySelectorAll('.idea.selected').length],[false,true,second,1],'selecting another idea closes the previous one and shows the new text');
    check({...scrolls.at(-1)},{top:484,behavior:'smooth'},'the selected idea scrolls to the top, level with the pane');
    head(second).click();await settled();
    check([reader.hidden,dash.classList.contains('reading'),card(second).open],[true,false,false],'clicking the selected idea again closes the pane');
    head(first).click();d.getElementById('reader-close').click();
    check([reader.hidden,card(first).open,d.activeElement===head(first)],[true,false,true],'close button returns to the centered list and focuses the idea');
    head(first).click();d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape'}));
    check([reader.hidden,card(first).open],[true,false],'Escape closes the pane');
    head(first).click();click('collapse-all');
    check([reader.hidden,d.querySelectorAll('.idea[open]').length,app.state.readingId],[true,0,null],'Collapse all closes the pane');
    for (const week of d.querySelectorAll('.week')) { week.open=true; week.dispatchEvent(new w.Event('toggle')); }
    head(first).click();
    const row=ideas.find(i=>i.id===firstIdea.id), saved={description:row.description,revision:row.revision};
    Object.assign(row,{description:'# Updated live\n\nNew text',revision:row.revision+1});
    await app.loadIdeas();await wait(()=>d.querySelector('#reader-body h1')?.textContent==='Updated live');
    check([reader.hidden,card(first).classList.contains('selected')],[false,true],'a live edit refreshes the open text and keeps the selection');
    wide=false;await app.loadIdeas();
    check([reader.hidden,dash.classList.contains('reading'),card(first).open],[true,false,true],'narrow screens keep the inline card');
    Object.assign(row,saved);w.matchMedia=savedMatch;w.scrollTo=savedScroll;click('collapse-all');await app.loadIdeas();
  }
  app.openIdeaDialog(app.state.ideas.at(-1));
  const editor=d.querySelector('#modal-body textarea');editor.value='# Revised Markdown\n\n$x^2$';editor.dispatchEvent(new w.Event('input'));
  await wait(()=>d.querySelector('.markdown-preview h1')?.textContent==='Revised Markdown');
  check(!!d.querySelector('.markdown-preview .katex'),true,'live preview updates math');
  submit();await wait(()=>!app.state.pending && !d.getElementById('modal').open);
  check(calls.at(-1).args.p_description,'# Revised Markdown\n\n$x^2$','edited Markdown submitted');
  check(events.at(-1).previous_state.description,markdown,'edit history preserves earlier Markdown');
  app.openIdeaDialog();await importIntoForm([new w.File([longSource],'long.md')]);
  rpcError={code:'23514',message:'violates check constraint "ideas_description_check"'};submit();await wait(()=>!app.state.pending);
  check(d.getElementById('modal').open,true,'old database constraint keeps draft open');
  check(d.querySelector('#modal-body .error-text').textContent.includes('raise_description_limit.sql'),true,'old schema error names the migration');
  check(d.querySelector('#modal-body textarea').value,longSource,'old schema error never truncates draft');rpcError=null;
  const manual=d.querySelector('#modal-body textarea');manual.value='x'.repeat(1048577);manual.dispatchEvent(new w.Event('input'));
  const beforeOversize=calls.length;submit();check(calls.length,beforeOversize,'oversized manual draft cannot submit');
  check(manual.value.length,1048577,'oversized manual draft not truncated');app.closeModal();

  // ---- Change checks: polls and reconnects download the workspace only when it changed.
  {
    const bulk=['ideas','idea_participants','idea_comments'];
    const fullReads=()=>reads.filter(table=>bulk.includes(table)).length;
    const flush=async()=>{await settled();await new Promise(resolve=>setTimeout(resolve,20));await settled();};
    const tick=async live=>{const saved=app.state.live;app.state.live=live;app.pollTick();await flush();app.state.live=saved;};
    await settled();reads=[];
    await tick(false);
    check([fullReads(),reads.filter(t=>t==='idea_events').length,reads.filter(t=>t==='profiles').length],[0,1,1],'Realtime down, nothing changed: the 30-second poll reads only the change token');
    reads=[];await tick(true);
    w.dispatchEvent(new w.Event('focus'));const savedLive=app.state.live;app.state.live=true;d.dispatchEvent(new w.Event('visibilitychange'));app.state.live=savedLive;await flush();
    check(reads,[],'Realtime live: no poll within the hour, and focus or a tab switch makes no request');
    app.state.checkedAt=Date.now()-3600000;reads=[];await tick(true);
    check([fullReads(),reads.includes('idea_events')],[0,true],'Realtime live: one safety-net check per hour');
    currentId='member-2';await client.rpc('add_comment',{p_idea_id:'idea-3',p_body:'Change seen by the next check',p_client_request_id:'00000000-0000-4000-8000-0000000c0de1'});currentId='member-0';
    reads=[];await tick(false);
    check([fullReads(),[...app.state.commentsByIdea.get('idea-3')].some(c=>c.body==='Change seen by the next check')],[3,true],'a change missed by Realtime makes the next check reload everything once');
    reads=[];await tick(false);check(fullReads(),0,'and the following check is cheap again');
    // An earlier transaction committing late: same newest ID, one more event.
    const late={...events.at(-1),id:events.at(-1).id-0.5};events.splice(events.length-1,0,late);
    reads=[];await app.checkForChanges();await settled();
    check(fullReads(),3,'a late commit (count changes, newest ID does not) still reloads');
    events.splice(events.indexOf(late),1);await app.loadIdeas();
    profiles[2].display_name='Junqi Renamed';reads=[];await app.checkForChanges();await settled();
    check([fullReads(),app.state.profiles.some(p=>p.display_name==='Junqi Renamed')],[3,true],'a profile change reloads');
    profiles[2].display_name='Junqi';await app.loadIdeas();
    readsFail=true;await app.checkForChanges();
    check([app.state.stale,text('last-synced')],[true,'Refresh failed · data may be stale'],'a failed check marks the data stale');
    readsFail=false;reads=[];await app.checkForChanges();
    check([app.state.stale,fullReads(),text('last-synced').startsWith('Synced')],[false,0,true],'recovery with an unchanged token needs no full download');
    let releaseSlow;delayRead=new Promise(resolve=>releaseSlow=resolve);const slow=app.loadIdeas();
    currentId='member-1';await client.rpc('add_comment',{p_idea_id:'idea-3',p_body:'Committed during a slow load',p_client_request_id:'00000000-0000-4000-8000-0000000c0de2'});currentId='member-0';
    const waiting=app.checkForChanges();releaseSlow();await slow;await waiting;await settled();
    check(app.state.commentsByIdea.get('idea-3').some(c=>c.body==='Committed during a slow load'),true,'a check during a load runs after it and catches a change the load missed');
  }

  // ---- Comment images: private bucket, paste/drop/pick upload, blob: display.
  {
    const savedCreate=w.URL.createObjectURL,savedRevoke=w.URL.revokeObjectURL,revoked=[];let blobs=0;
    w.URL.createObjectURL=blob=>`blob:synthetic-image-${++blobs}-${blob.type}`;w.URL.revokeObjectURL=url=>revoked.push(url);
    const uid='11111111-1111-4111-8111-111111111111',existing=`${uid}/22222222-2222-4222-8222-222222222222.png`;
    stored.set(existing,new w.Blob(['synthetic png'],{type:'text/html'}));
    const box=d.createElement('div');
    app.renderMarkdown(box,`Before\n\n![loss curve](attachment:${existing})\n\n![remote](https://example.org/track.png) ![bad](attachment:../${existing}) ![svg](attachment:${uid}/22222222-2222-4222-8222-222222222222.svg)`);
    await wait(()=>box.querySelector('img'));
    const shown=box.querySelector('.attachment a img');
    check([shown.alt,shown.getAttribute('src'),shown.parentElement.target,shown.parentElement.rel],['loss curve','blob:synthetic-image-1-image/png','_blank','noopener'],'attachment image shown from a blob: URL typed by its extension, not the server');
    check([box.querySelectorAll('img').length,box.textContent.includes('[Image: remote]'),box.textContent.includes('[Image: bad]'),box.textContent.includes('[Image: svg]'),box.querySelector('.attachment[title]')],[1,true,true,true,null],'remote, malformed and non-raster images stay text labels');
    check(storageCalls.map(c=>[c.op,c.bucket,c.path]),[['download','comment-images',existing]],'only the valid attachment is downloaded, from the private bucket');
    app.renderMarkdown(box,`![again](attachment:${existing})`);await wait(()=>box.querySelector('img'));
    check(storageCalls.length,1,'a rerendered image is served from the cache');
    const missing=`${uid}/33333333-3333-4333-8333-333333333333.jpg`;
    app.renderMarkdown(box,`![gone](attachment:${missing})`);await wait(()=>box.textContent.includes('[Image unavailable: gone]'));
    app.renderMarkdown(box,`![gone](attachment:${missing})`);await wait(()=>storageCalls.length===3);
    check(storageCalls.at(-1).path,missing,'a failed download is retried on the next render');

    const target=d.querySelector('.idea .idea-number').textContent,targetId=app.state.ideas.find(i=>card(target)&&i.idea_number===Number(target.slice(5))).id;
    openCard(target);storageCalls=[];
    const realUser=app.state.userId;app.state.userId=uid; // Auth user IDs are UUIDs; the synthetic profiles are not.
    const input=composerOf(target),form=input.closest('.composer');
    check(labels(form).includes('Image'),true,'composer offers an Image button');
    const paste=(files,types=['Files'])=>{const event=new w.Event('paste',{bubbles:true,cancelable:true});
      Object.defineProperty(event,'clipboardData',{value:{files,types}});input.dispatchEvent(event);return event;};
    type(target,'Result:');input.setSelectionRange(7,7);
    let release;holdUpload=new Promise(resolve=>release=resolve);
    const pasted=paste([new w.File(['png bytes'],'image.png',{type:'image/png'})]);
    check(pasted.defaultPrevented,true,'a pasted screenshot is intercepted');
    check(/^Result:\n!\[Uploading image…\]\([0-9a-f-]{36}\)\n$/.test(input.value),true,'a marker holds the image place on its own line');
    const beforeEarlyPost=calls.length;postIn(target);
    check([calls.length,composerError(target)],[beforeEarlyPost,'Wait for the image upload to finish before posting.'],'cannot post while an image uploads');
    release();holdUpload=null;await wait(()=>!input.value.includes('Uploading'));
    const upload=storageCalls.find(c=>c.op==='upload');
    check([upload.bucket,upload.contentType,upload.upsert,new RegExp(`^${uid}/[0-9a-f-]{36}\\.png$`).test(upload.path)],['comment-images','image/png',false,true],'upload goes into the member’s own folder without overwriting');
    check(input.value,`Result:\n![image](attachment:${upload.path})\n`,'marker replaced by the attachment reference');
    check(app.state.commentDrafts.get(targetId).text,input.value,'draft keeps the reference');
    check(paste([new w.File(['x'],'chart.png',{type:'image/png'})],['text/plain','Files']).defaultPrevented,false,'pasted text that also carries a picture stays text');
    const picker=form.querySelector('input[type=file]');
    check([picker.multiple,picker.accept],[true,'image/png,image/jpeg,image/gif,image/webp'],'image picker accepts several raster images');
    const pick=files=>{Object.defineProperty(picker,'files',{configurable:true,value:files});picker.dispatchEvent(new w.Event('change'));};
    const uploadsBefore=storageCalls.length;
    pick([new w.File(['<svg/>'],'evil.svg',{type:'image/svg+xml'})]);
    check(composerError(target),'evil.svg is not a PNG, JPEG, GIF or WebP image.','non-raster file refused');
    const huge=new w.File(['x'],'huge.png',{type:'image/png'});Object.defineProperty(huge,'size',{value:5242881});pick([huge]);
    check([composerError(target),storageCalls.length],['huge.png is larger than 5 MiB.',uploadsBefore],'oversized image refused before uploading');
    uploadError={message:'Bucket not found'};const valueBefore=input.value;input.setSelectionRange(valueBefore.length,valueBefore.length);
    const drop=new w.Event('drop',{bubbles:true,cancelable:true});
    Object.defineProperty(drop,'dataTransfer',{value:{files:[new w.File(['jpg'],'photo.jpg',{type:'image/jpeg'})],types:['Files']}});
    input.dispatchEvent(drop);await wait(()=>!input.value.includes('Uploading'));uploadError=null;
    check([drop.defaultPrevented,input.value,composerError(target).includes('add_comment_images.sql')],[true,valueBefore,true],'a failed upload removes its marker and names the migration');
    app.state.userId=realUser;
    postIn(target);await settled();
    check(calls.at(-1).args.p_body,`Result:\n![image](attachment:${upload.path})\n`,'the comment stores only the reference');
    await wait(()=>thread(target).querySelector('.comment .attachment img'));
    check(storageCalls.filter(c=>c.op==='download').length,0,'the uploader sees the image without downloading it again');
    imageCleanup=async()=>{
      await wait(()=>revoked.length===2);
      check(app.state.attachments.size,0,'sign-out discards and revokes the images it downloaded or uploaded');
      w.URL.createObjectURL=savedCreate;w.URL.revokeObjectURL=savedRevoke;
    };
  }

  let releaseLate;delayRead=new Promise(resolve=>releaseLate=resolve);const late=app.loadIdeas();
  await app.loadCurrentUser(null);releaseLate();await late;
  check(d.getElementById('dashboard').hidden,true,'late response cannot resurrect logged-out dashboard');
  check(app.state.ideas.length,0,'late response cannot restore private data');
  check(d.getElementById('login-view').hidden,false,'logout view');
  await imageCleanup();
  console.log(`PASS: ${checks} syntax/DOM integration checks. Transport was simulated; no live Auth or Realtime claims.`);
} finally { w.close(); }
