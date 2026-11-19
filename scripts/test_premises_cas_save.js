const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'premises_admin.js'), 'utf8');
const start = source.indexOf('    function deepCloneRuntimeDb(db) {');
const end = source.indexOf('    function renderDupHints() {', start);
assert(start >= 0 && end > start, 'premise transaction functions must be present');
const transactionSource = source.slice(start, end);

function setup(result, initialRaw = JSON.stringify({ premises: { old: { regnum: 'old' } }, links: [], abonents: {} })) {
    let localRaw = initialRaw;
    const calls = [];
    const warnings = [];
    const initialDb = initialRaw ? JSON.parse(initialRaw) : { premises: {}, links: [], abonents: {} };
    const window = {
        AbonentsDB: JSON.parse(JSON.stringify(initialDb)),
        JKHStore: {
            getOwnerId: () => 'owner1',
            normalizeOwnerId: id => id.replace(/^(LAB|PROD):/i, ''),
            getRaw: (key, owner) => { assert.strictEqual(key, 'abonents_db_v1'); assert.strictEqual(owner, 'owner1'); return localRaw; },
            setRaw: (key, raw) => { assert.strictEqual(key, 'abonents_db_v1'); localRaw = raw; },
            removeRaw: key => { assert.strictEqual(key, 'abonents_db_v1'); localRaw = null; },
            setJSON: (key, db) => { assert.strictEqual(key, 'abonents_db_v1'); localRaw = JSON.stringify(db); }
        },
        JKHDbCas: result === 'missing' ? null : {
            write: async (owner, raw) => { calls.push({ owner, raw }); return result; }
        }
    };
    const state = { busy: false, editingRegnum: null };
    const context = {
        window, state, JKHStore: window.JKHStore, KEY_DB: 'abonents_db_v1',
        getActiveOwnerId: () => 'owner1',
        setBusyUI: busy => { state.busy = busy; },
        setWarn: (message, ok) => { warnings.push({ message, ok }); },
        renderTable: () => {}, refreshAddressDatalists: () => {},
        setFormModeAdd: () => {}, setFormModeEdit: () => {},
        console: { log: () => {}, warn: () => {}, error: () => {} },
        structuredClone
    };
    vm.runInNewContext(transactionSource + '\nthis.persist = persistPremiseTransaction;', context, { filename: 'premises_admin.js' });
    return { context, window, calls, warnings, getLocalRaw: () => localRaw, initialRaw };
}

async function runTransaction(test, mutate, onSuccess) {
    await test.context.persist({ mutate: () => { mutate(test.window.AbonentsDB); return { ok: true }; }, onSuccess });
    assert.strictEqual(test.context.state.busy, false);
}

(async () => {
    const confirmed = setup({ ok: true, state: 'confirmed', version: 26 });
    let successCount = 0;
    await runTransaction(confirmed, db => { db.premises.new = { regnum: 'new' }; }, () => { successCount++; });
    assert.strictEqual(confirmed.calls.length, 1);
    assert.strictEqual(confirmed.calls[0].owner, 'owner1');
    assert.deepStrictEqual(JSON.parse(confirmed.calls[0].raw).premises.new, { regnum: 'new' });
    assert.deepStrictEqual(JSON.parse(confirmed.getLocalRaw()).premises.new, { regnum: 'new' });
    assert.strictEqual(successCount, 1);
    assert.strictEqual(confirmed.warnings.at(-1).ok, true);

    for (const [name, result, expectedMessage] of [
        ['conflict', { ok: false, state: 'conflict', error: 'version_conflict' }, 'Конфликт версии'],
        ['unknown', { ok: false, state: 'unknown', error: 'SERVER_OUTCOME_UNKNOWN' }, 'неизвестен'],
        ['version missing', { ok: false, state: 'unknown', error: 'DB_VERSION_NOT_LOADED' }, 'Версия базы не загружена'],
        ['failed', { ok: false, state: 'failed', error: 'server_error' }, 'server_error'],
        ['missing', 'missing', 'DB_VERSION_NOT_LOADED']
    ]) {
        const test = setup(result);
        await runTransaction(test, db => { db.premises.new = { regnum: 'new' }; });
        assert.strictEqual(test.getLocalRaw(), test.initialRaw, `${name}: local DB rollback`);
        assert.strictEqual(JSON.stringify(test.window.AbonentsDB), test.initialRaw, `${name}: runtime DB rollback`);
        assert(test.warnings.at(-1).message.includes(expectedMessage), `${name}: useful error`);
        assert.strictEqual(test.warnings.at(-1).ok, false);
    }

    const noPreviousCache = setup({ ok: false, state: 'conflict' }, null);
    await runTransaction(noPreviousCache, db => { db.premises.new = { regnum: 'new' }; });
    assert.strictEqual(noPreviousCache.getLocalRaw(), null, 'absent cache must remain absent after rejection');

    for (const [name, mutate] of [
        ['edit', db => { db.premises.old.square = 45; }],
        ['delete', db => { delete db.premises.old; }]
    ]) {
        const test = setup({ ok: false, state: 'conflict' });
        await runTransaction(test, mutate);
        assert.strictEqual(test.getLocalRaw(), test.initialRaw, `${name}: local DB rollback`);
        assert.strictEqual(JSON.stringify(test.window.AbonentsDB), test.initialRaw, `${name}: runtime DB rollback`);
    }

    assert(!transactionSource.includes("fetch('/api/store'"), 'premise save must use the shared CAS writer');
    console.log('premise CAS save and rollback tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
