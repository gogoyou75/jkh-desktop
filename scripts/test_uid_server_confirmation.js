// Isolated tests: real UID/registry readers, fake session-scoped HTTP, no browser or MySQL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const data = fs.readFileSync(path.join(__dirname, '../web/data.js'), 'utf8');
const storage = fs.readFileSync(path.join(__dirname, '../web/storage.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function install(context, source, name) {
  let start = source.indexOf('function ' + name + '(');
  assert(start >= 0, name);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  for (let end = source.indexOf('}', start); end >= 0; end = source.indexOf('}', end + 1)) {
    const code = source.slice(start, end + 1);
    try { new vm.Script(code); } catch (_) { continue; }
    vm.runInContext(code, context); return;
  }
  throw Error('Cannot extract ' + name);
}
function fixture() {
  return { abonents: { '8801': { id:'8801', uid:'uid_isolated_test', square:50, calcStartDate:'2026-11-01' } },
    premises: { test:{square:50} }, links:[{abonentId:'8801',regnum:'test',dateFrom:'2026-11-01',dateTo:''}],
    premiseEvents:[{type:'NO_NAME_RESTORED',operationId:'unchanged-history'}] };
}
function setup(options = {}) {
  const local = clone(options.local || fixture());
  const server = {db:clone(options.server || local), version:22};
  const before = JSON.stringify(local);
  const protectedKV = { frozen:{version:4,value:'frozen'}, transfer:{version:4,value:'transfer'} };
  const protectedBefore = JSON.stringify(protectedKV);
  const calls = {get:[],writes:0,upload:0,save:0,finance:0};
  let owner = 'codex-test';
  const forbiddenWrite = () => { calls.writes++; throw Error('Unexpected write'); };
  const context = vm.createContext({window:{AbonentsDB:local}, console:{log(){},warn(){},error(){}},
    KEY_DB:'abonents_db_v1', _ownerId:()=>owner, _canWriteStorage:()=>!options.readonly,
    _apiGet:async url=>{
      calls.get.push(url);
      assert.equal(url, '/api/store?key=abonents_db_v1&client_owner_hint=codex-test');
      if (options.onRead) options.onRead({local,server,changeOwner:()=>{owner='another-owner'}});
      if (options.offline) throw Error('Server unavailable');
      if (options.status && options.status !== 200) return {status:options.status,data:{ok:false}};
      return {status:options.missing ? 404 : 200,data:{ok:true,
        value:options.missing ? null : options.badJson ? '{' : JSON.stringify(server.db),
        version:options.badVersion ? null : server.version}};
    },
    _apiPost:forbiddenWrite, _setProjectRaw:forbiddenWrite,
    normalizeDb:forbiddenWrite, saveToStorage:()=>{calls.save++;throw Error('Unexpected local save')},
    ensureAbonentUidOnRecord:forbiddenWrite,
    Data:{flushDbToServer:()=>{calls.upload++;throw Error('General upload forbidden')}},
    fetch:forbiddenWrite});
  context.window.Data=context.Data;
  for (const name of ['isValidUid','_findAbonentByIdOrUid','_stableFinancialJson','_serverStoreGet','ensureAbonentUid']) install(context,data,name);
  install(context,storage,'_readDbCas');
  context.window.JKHDbCas={read:context._readDbCas,version:()=>21,write:forbiddenWrite};
  return {context,local,server,calls,before,verify(){
    assert.equal(calls.writes,0); assert.equal(calls.upload,0); assert.equal(calls.save,0); assert.equal(calls.finance,0);
    assert.equal(JSON.stringify(protectedKV),protectedBefore);
    assert.equal(context.window.JKHDbCas.version(),21,'A read must not bypass/reset cached CAS');
    if (!options.onRead) assert.equal(JSON.stringify(local),before,'Local drafts must not be overwritten');
  }};
}
let passed=0;
async function test(name, body) { await body(); passed++; console.log('PASS '+name); }
async function result(options, expectedReason) {
  const f=setup(options); const r=await f.context.ensureAbonentUid('8801');
  assert.equal(r.ok,false); assert.equal(r.reason,expectedReason); assert(r.message);
  f.verify(); return f;
}
(async()=>{
  await test('confirmed UID: session-scoped GET only, no global upload',async()=>{
    for (const input of ['8801','uid_isolated_test',{id:'8801'}]) {
      const f=setup(); const r=await f.context.ensureAbonentUid(input);
      assert.equal(r.ok,true); assert.equal(r.serverConfirmed,true); assert.equal(r.uid,'uid_isolated_test');
      assert.equal(r.version,22); assert.equal(r.changed,false); assert.equal(f.calls.get.length,1); f.verify();
    }
  });
  await test('new local UID is blocked until ordinary registration completes',async()=>{
    const unregistered=fixture(); delete unregistered.abonents['8801'];
    const f=setup({server:unregistered});
    let r=await f.context.ensureAbonentUid('8801');
    assert.equal(r.ok,false); assert.equal(r.reason,'UID_REGISTRATION_REQUIRED');
    // Simulate completion of the separate, existing registration workflow.
    // ensureAbonentUid itself may not register or synchronize business data.
    f.server.db=clone(f.local);
    r=await f.context.ensureAbonentUid('8801');
    assert.equal(r.ok,true); assert.equal(r.serverConfirmed,true); f.verify();
  });
  await test('missing server registry is not localStorage confirmation',()=>result({missing:true},'UID_REGISTRATION_REQUIRED'));
  await test('offline server cannot yield false success',()=>result({offline:true},'UID_SERVER_UNAVAILABLE'));
  await test('auth/owner failures do not fall back to upload',async()=>{
    for(const status of [401,403,500]) await result({status},'UID_SERVER_UNAVAILABLE');
  });
  await test('malformed JSON and missing version are rejected',async()=>{
    await result({badJson:true},'UID_SERVER_UNAVAILABLE'); await result({badVersion:true},'UID_SERVER_UNAVAILABLE');
  });
  await test('wrong or duplicate server UID is rejected',async()=>{
    const server=fixture();server.abonents['8801'].uid='uid_other';
    await result({server},'UID_SERVER_MISMATCH');
    server.abonents['8801'].uid='uid_isolated_test';server.abonents['9999']=clone(server.abonents['8801']);
    await result({server},'UID_SERVER_MISMATCH');
  });
  await test('server record without UID requires safe registration, never UID replacement',async()=>{
    const server=fixture();delete server.abonents['8801'].uid;
    await result({server},'UID_REGISTRATION_REQUIRED');
  });
  await test('unsaved fields, links and other records are preserved and block calculation',async()=>{
    for (const edit of [d=>d.abonents['8801'].square=51,d=>d.links[0].dateFrom='2025-01-01',
      d=>d.abonents.other={uid:'uid_local_draft'}]) {
      const local=fixture();edit(local);await result({local,server:fixture()},'LOCAL_DB_UNSAVED_CHANGES');
    }
  });
  await test('owner switching and concurrent local edits are rejected',async()=>{
    await result({onRead:({changeOwner})=>changeOwner()},'OWNER_CHANGED');
    const f=await result({onRead:({local})=>{local.abonents['8801'].square=51}},'LOCAL_DB_UNSAVED_CHANGES');
    assert.equal(f.local.abonents['8801'].square,51);
  });
  await test('missing UID and readonly contexts do not mutate local state',async()=>{
    const local=fixture(); delete local.abonents['8801'].uid;
    const f=await result({local},'UID_REGISTRATION_REQUIRED');assert.equal(f.calls.get.length,0);
    await result({readonly:true},'READ_ONLY');
  });
  await test('object property order does not require save',async()=>{
    const local=fixture();const server=fixture();
    server.abonents['8801']={calcStartDate:'2026-11-01',square:50,uid:'uid_isolated_test',id:'8801'};
    const f=setup({local,server});assert.equal((await f.context.ensureAbonentUid('8801')).ok,true);f.verify();
  });
  console.log('UID server confirmation: '+passed+' tests passed; no real HTTP/MySQL used');
})().catch(e=>{console.error(e);process.exitCode=1});
