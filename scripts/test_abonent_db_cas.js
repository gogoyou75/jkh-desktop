const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'storage.js'), 'utf8');
const cardHtml = fs.readFileSync(path.join(__dirname, '..', 'web', 'abonent_card.html'), 'utf8');
for (const match of cardHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
  if (match[1].trim()) new vm.Script(match[1], { filename: 'abonent_card.html' });
}
const initialDb = { abonents: { '1006': { id: '1006', square: 40, premiseRegnum: 'P1' } }, premises: { P1: { regnum: 'P1', square: 40 } }, links: [] };

class MemoryStorage {
  constructor() { this.values = new Map(); }
  get length() { return this.values.size; }
  key(i) { return Array.from(this.values.keys())[i] || null; }
  getItem(k) { return this.values.has(String(k)) ? this.values.get(String(k)) : null; }
  setItem(k, v) { this.values.set(String(k), String(v)); }
  removeItem(k) { this.values.delete(String(k)); }
}

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data), json: async () => data };
}

function server() {
  return { value: JSON.stringify(initialDb), version: 1, posts: 0, postKeys: [], extraData: {}, failLater: false, loseResponse: false };
}

function contextFor(state) {
  const localStorage = new MemoryStorage();
  const document = { readyState: 'loading', getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
  const window = {
    location: { protocol: 'http:', pathname: '/abonent_card.html', search: '?abonent=1006' },
    Auth: { getCurrentUser: () => ({ id: 'owner1', role: 'user' }), getActiveDbOwnerId: () => 'owner1', isGuest: () => false },
    addEventListener: () => {}, dispatchEvent: () => {}, JKHBoot: { markReady: () => {} }
  };
  async function fetch(url, options = {}) {
    if (String(url).startsWith('/api/store_dump')) return response({ ok: true, owner: 'owner1', env_type: 'LAB', data: Object.assign({ abonents_db_v1: state.value }, state.extraData), abonents_db_version: state.version });
    if (String(url).startsWith('/api/store?')) {
      if (state.readFail) throw new Error('read unavailable');
      return response({ ok: true, value: state.value, version: state.version });
    }
    if (url === '/api/store' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      state.postKeys.push(body.key);
      if (body.key === 'abonents_db_v1') {
        state.posts++;
        if (body.expected_version !== state.version) return response({ ok: false, error: 'version_conflict' }, 409);
        state.value = body.value;
        state.version++;
        if (state.loseResponse) { state.loseResponse = false; throw new Error('response lost'); }
        return response({ ok: true, version: state.version });
      }
      if (/^payments_uid_[a-z0-9][a-z0-9_-]*$/i.test(body.key)) {
        let ledger;
        try { ledger = JSON.parse(body.value); } catch (_) { return response({ ok: false, error: 'payment_ledger_value_must_be_json_array' }, 422); }
        if (!Array.isArray(ledger)) return response({ ok: false, error: 'payment_ledger_value_must_be_json_array' }, 422);
      }
      if (state.failLater && body.key === 'abonent_notes_v1') return response({ ok: false, error: 'later_key_failed' }, 500);
      return response({ ok: true });
    }
    throw new Error('unexpected request: ' + url);
  }
  const context = { window, document, localStorage, Storage: MemoryStorage, Auth: window.Auth, fetch, console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {}, URLSearchParams, CustomEvent: function () {} };
  context.globalThis = context;
  window.window = window;
  window.document = document;
  window.localStorage = localStorage;
  vm.runInNewContext(source, context, { filename: 'storage.js' });
  return context;
}

async function loaded(state) {
  const context = contextFor(state);
  const result = await context.window.JKHDataLoader.loadFromServer({ force: true, reason: 'test' });
  assert.strictEqual(result.ok, true);
  return context;
}

(async () => {
  const state = server();
  const context = await loaded(state);
  const cas = context.window.JKHDbCas;
  context.localStorage.setItem('jkh_sync_as_onlychg_v1', '1');
  const modified = JSON.parse(state.value);
  modified.abonents['1006'].square = 45;
  modified.premises.P1.square = 45;
  context.window.JKHStore.setRaw('abonents_db_v1', JSON.stringify(modified));
  const saved = await context.window.JKHRemoteSync.uploadNow();
  assert.strictEqual(saved, true);
  assert.strictEqual(state.version, 2);
  assert.strictEqual(JSON.parse(state.value).premises.P1.square, 45);
  modified.abonents['1006'].square = 46;
  modified.premises.P1.square = 46;
  context.window.JKHStore.setRaw('abonents_db_v1', JSON.stringify(modified));
  const beforeAreaOnly = state.posts;
  assert.strictEqual(await context.window.JKHRemoteSync.uploadNow(), true);
  assert.strictEqual(state.posts, beforeAreaOnly + 1, 'area-only change must trigger POST');
  assert.strictEqual(JSON.parse(state.value).abonents['1006'].square, 46);

  const legacyLedgerState = server();
  const emptyLedgerKey = 'payments_uid_legacy';
  const validLedgerKey = 'payments_uid_valid';
  legacyLedgerState.extraData = { [emptyLedgerKey]: '', [validLedgerKey]: '[]' };
  const legacyLedgerContext = await loaded(legacyLedgerState);
  const legacyChanged = JSON.parse(legacyLedgerState.value);
  legacyChanged.abonents['1006'].square = 47;
  legacyChanged.premises.P1.square = 47;
  legacyLedgerContext.window.JKHStore.setRaw('abonents_db_v1', JSON.stringify(legacyChanged));
  assert.strictEqual(await legacyLedgerContext.window.JKHRemoteSync.uploadNow(), true);
  assert.strictEqual(JSON.parse(legacyLedgerState.value).abonents['1006'].square, 47);
  assert.strictEqual(legacyLedgerState.postKeys.includes(emptyLedgerKey), false, 'empty legacy ledger must not be resent');
  assert.strictEqual(legacyLedgerState.postKeys.includes(validLedgerKey), true, 'valid ledger must still sync');

  const stale = await cas.write('owner1', JSON.stringify(modified));
  assert.strictEqual(stale.ok, true);
  const secondContext = await loaded(state);
  state.version++;
  const conflict = await secondContext.window.JKHDbCas.write('owner1', JSON.stringify(modified));
  assert.strictEqual(conflict.state, 'conflict');
  secondContext.window.JKHStore.setRaw('abonents_db_v1', JSON.stringify(modified));
  assert.strictEqual(await secondContext.window.JKHRemoteSync.uploadNow(), false);
  assert.strictEqual(secondContext.window.JKHRemoteSync.lastDbUpload().state, 'conflict');

  const partialState = server();
  partialState.failLater = true;
  const partialContext = await loaded(partialState);
  const changed = JSON.parse(partialState.value);
  changed.abonents['1006'].square = 50;
  changed.premises.P1.square = 50;
  partialContext.window.JKHStore.setRaw('abonents_db_v1', JSON.stringify(changed));
  assert.strictEqual(await partialContext.window.JKHRemoteSync.uploadNow(), false);
  assert.strictEqual(partialContext.window.JKHRemoteSync.lastDbUpload().state, 'partial');
  assert.strictEqual(JSON.parse(partialState.value).abonents['1006'].square, 50);

  const lostState = server();
  const lostContext = await loaded(lostState);
  lostState.loseResponse = true;
  const lost = await lostContext.window.JKHDbCas.write('owner1', JSON.stringify(changed));
  assert.strictEqual(lost.ok, true);
  assert.strictEqual(lost.verifiedAfterNetworkError, true);
  const refreshed = await loaded(lostState);
  assert.strictEqual(refreshed.window.JKHDbCas.version('owner1'), lostState.version);
  assert.strictEqual(JSON.parse(refreshed.window.JKHStore.getRaw('abonents_db_v1')).abonents['1006'].square, 50);
  const unknownState = server();
  const unknownContext = await loaded(unknownState);
  unknownState.loseResponse = true;
  unknownState.readFail = true;
  const unknown = await unknownContext.window.JKHDbCas.write('owner1', JSON.stringify(changed));
  assert.strictEqual(unknown.state, 'unknown');
  assert.strictEqual(unknownState.version, 2, 'commit may have succeeded despite lost response');
  assert.strictEqual(unknownContext.window.JKHDbCas.version('owner1'), 1, 'unknown result must not advance local version');
  console.log('abonent db CAS client tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
