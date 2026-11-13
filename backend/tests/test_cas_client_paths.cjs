const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const web = path.resolve(__dirname, '../../web');
function functionSource(file, start, end) {
  const source = fs.readFileSync(path.join(web, file), 'utf8');
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${file}: function boundary missing`);
  return source.slice(from, to);
}

test('premises direct save uses loaded CAS version and never sends an unversioned POST', async () => {
  const source = functionSource('premises_admin.js',
    'async function uploadOnlyAbonentsDbToServer(ownerId)',
    'async function flushDbToServerStrict(ownerId)');
  const calls = [];
  const context = {
    window: {
      AbonentsDB: { abonents: {}, premises: {}, links: [] },
      JKHStore: { normalizeOwnerId: value => value },
      JKHDbCas: { write: async (owner, raw) => {
        calls.push({ owner, raw });
        return { ok: true, version: 2 };
      } }
    },
    JKHStore: { normalizeOwnerId: value => value },
    fetch: () => { throw new Error('unversioned direct request'); }
  };
  vm.runInNewContext(source, context);
  await vm.runInNewContext('uploadOnlyAbonentsDbToServer("synthetic-owner")', context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].owner, 'synthetic-owner');
  assert.deepEqual(JSON.parse(calls[0].raw), context.window.AbonentsDB);
  context.window.JKHDbCas.write = async () => ({ ok: false, error: 'version_conflict' });
  await assert.rejects(vm.runInNewContext('uploadOnlyAbonentsDbToServer("synthetic-owner")', context), /version_conflict/);
  context.window.JKHDbCas.write = async () => ({ ok: false, error: 'expected_version_required' });
  await assert.rejects(vm.runInNewContext('uploadOnlyAbonentsDbToServer("synthetic-owner")', context), /обновить вкладку/);
});

test('background save stops on 428 before writing another key', async () => {
  const source = functionSource('storage.js', 'async function _uploadImpl(scope)', 'async function download(scope)');
  const writes = [];
  let blocked = false;
  const owner = 'synthetic-owner';
  const raw = JSON.stringify({ abonents: {}, premises: {}, links: [] });
  const context = {
    window: {}, console,
    isOnlineMode: () => true, _isGuestOrAll: () => false,
    K_AS_ONLY_CHANGED: 'only-changed', KEY_DB: 'abonents_db_v1',
    _ownerId: () => owner, _lsGet: () => '0', _sigForDB: () => 'changed', _sigForALL: () => 'changed',
    _getLastSigKey: () => 'signature', _dbCasVersion: () => 1,
    __lastSavedDbRaw: {}, _dbCasScope: () => owner,
    _projectKeysForScope: () => ['abonents_db_v1', 'jkh_financial_events_v1'],
    _readLocalCompat: () => raw, _isDbEffectivelyEmpty: () => false,
    _validateAbonentsDbRaw: () => true, _isVersionedFinancialKey: () => false,
    _financialCasVersion: () => null,
    _writeDbCas: async () => { writes.push('abonents_db_v1'); return { ok: false, error: 'expected_version_required' }; },
    _apiPost: async () => { writes.push('jkh_financial_events_v1'); return { okHttp: true, data: { ok: true } }; },
    _blockUploadUntilRefresh: () => { blocked = true; }, _setStatus: () => {},
    _rawPreview: () => '', _setFinancialCasVersion: () => {}, _lsSet: () => {}, _nowISO: () => ''
  };
  vm.runInNewContext(source, context);
  assert.equal(await vm.runInNewContext('_uploadImpl("all")', context), false);
  assert.equal(blocked, true);
  assert.deepEqual(writes, ['abonents_db_v1']);
  assert.equal(context.window.__JKH_LAST_DB_UPLOAD.state, 'conflict');
});

test('background save sends financial snapshot version and advances it on confirmation', async () => {
  const source = functionSource('storage.js', 'async function _uploadImpl(scope)', 'async function download(scope)');
  const requests = [];
  let version = 3;
  const context = {
    window: {}, console, KEY_DB: 'abonents_db_v1', K_AS_ONLY_CHANGED: 'only-changed',
    isOnlineMode: () => true, _isGuestOrAll: () => false,
    _ownerId: () => 'synthetic-owner', _lsGet: () => '0',
    _sigForDB: () => 'changed', _sigForALL: () => 'changed', _getLastSigKey: () => 'signature',
    _dbCasVersion: () => 1, __lastSavedDbRaw: {}, _dbCasScope: () => 'synthetic-owner',
    _projectKeysForScope: () => ['abonents_db_v1', 'jkh_financial_events_v1'],
    _readLocalCompat: key => key === 'abonents_db_v1'
      ? JSON.stringify({ abonents: {}, premises: {}, links: [] }) : '[]',
    _isDbEffectivelyEmpty: () => false, _validateAbonentsDbRaw: () => true,
    _isVersionedFinancialKey: key => key === 'jkh_financial_events_v1',
    _financialCasVersion: () => version,
    _setFinancialCasVersion: (_owner, _key, next) => { version = next; },
    _writeDbCas: async () => ({ ok: true }),
    _apiPost: async (_url, body) => {
      requests.push(body);
      return { okHttp: true, data: { ok: true, version: body.expected_version + 1 } };
    },
    _setStatus: () => {}, _lsSet: () => {}, _nowISO: () => '',
    _blockUploadUntilRefresh: () => { throw new Error('unexpected refresh block'); }
  };
  vm.runInNewContext(source, context);
  assert.equal(await vm.runInNewContext('_uploadImpl("all")', context), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].expected_version, 3);
  assert.equal(version, 4);
});
