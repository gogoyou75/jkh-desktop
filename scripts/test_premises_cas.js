const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../web/premises_admin.js'), 'utf8');
const saveCode = source.slice(source.indexOf('    async function uploadOnlyAbonentsDbToServer'), source.indexOf('    function renderDupHints'));
assert.ok(saveCode.includes('async function persistPremiseTransaction'));

function harness(owner, response) {
  const calls = { writes: [], cache: [], messages: [], restored: 0, success: 0 };
  const window = {
    AbonentsDB: { premises: {}, abonents: {}, links: [] },
    JKHDbCas: { write: async (id, raw) => { calls.writes.push({ id, raw }); return typeof response === 'function' ? response() : response; } },
    JKHStore: { normalizeOwnerId: x => x, setJSON: (key, db, id) => calls.cache.push({ key, db, id }) }
  };
  const context = vm.createContext({ window, JKHStore: window.JKHStore, KEY_DB: 'abonents_db_v1',
    state: { busy: false }, console: { log() {}, warn() {} },
    getPersistOwnerIdOrThrow: () => owner,
    setBusyUI: () => {},
    makeTxSnapshot: () => JSON.parse(JSON.stringify(window.AbonentsDB)),
    restoreFromTxSnapshot: snapshot => { calls.restored++; window.AbonentsDB = snapshot; },
    runExistingRecalcForAbonents: async () => ({ ok: true }),
    setWarn: (message, ok) => calls.messages.push({ message, ok }),
    renderTable: () => {}, refreshAddressDatalists: () => {},
    fetch: () => { throw new Error('premises must not bypass shared CAS'); }
  });
  vm.runInContext(saveCode, context);
  const save = () => context.persistPremiseTransaction({ mutate: () => {
    window.AbonentsDB.premises.TEST = { regnum: 'TEST', regnumTemp: true, flat: '1234' };
    return { ok: true };
  }, onSuccess: () => calls.success++ });
  return { calls, window, context, save };
}

(async () => {
  for (const owner of ['synthetic-owner-a', 'synthetic-owner-b']) {
    const h = harness(owner, { ok: true, state: 'confirmed', version: 1 });
    await h.save();
    assert.equal(h.calls.writes[0].id, owner);
    assert.equal(JSON.parse(h.calls.writes[0].raw).premises.TEST.regnumTemp, true);
    assert.equal(h.calls.cache.length, 1);
    assert.equal(h.calls.success, 1);
    assert.equal(h.calls.restored, 0);
  }
  for (const response of [
    { ok: false, state: 'conflict', error: 'version_conflict' },
    { ok: false, state: 'conflict', error: 'expected_version_required' },
    { ok: false, state: 'unknown', error: 'DB_VERSION_NOT_LOADED' },
    { ok: false, state: 'unknown', error: 'SERVER_OUTCOME_UNKNOWN' }
  ]) {
    const h = harness('synthetic-owner', response);
    await h.save();
    assert.equal(h.calls.writes.length, 1, 'no automatic retry or latest-version read');
    assert.equal(h.calls.cache.length, 0, 'unconfirmed data must not enter persistent cache');
    assert.equal(h.calls.success, 0);
    assert.equal(h.calls.restored, 1);
    assert.equal(Object.keys(h.window.AbonentsDB.premises).length, 0);
    assert.equal(h.calls.messages.at(-1).ok, false);
  }
  let complete;
  const h = harness('synthetic-owner', () => new Promise(resolve => { complete = resolve; }));
  const pending = h.save();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.success, 0);
  assert.equal(h.calls.cache.length, 0);
  complete({ ok: true, state: 'confirmed', version: 1 });
  await pending;
  assert.equal(h.calls.success, 1);
  console.log('premises CAS save tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
