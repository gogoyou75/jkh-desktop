const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/tariffs.html'), 'utf8');
for (const m of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if (m[1].trim()) new vm.Script(m[1]);
const add = source.slice(source.indexOf('  function addTariff(){'), source.indexOf('  function addRateRow('));
for (const populated of [true, false]) {
  let saved;
  const draft = [{ id: 'existing', title: 'Содержание', type: 'per_m2', active: true, rates: [{ from: '2026-01-01', value: 20 }] }];
  const existingInput = { value: 'unfinished month draft' };
  const host = { innerHTML: 'empty notice', querySelector: () => populated ? existingInput : null,
    insertAdjacentHTML: (where, html) => { assert.equal(where, 'beforeend'); assert.equal(html, 'new-card'); } };
  const ctx = { canEditTariffs: () => true, readFromUI: () => populated ? structuredClone(draft) : [], uid: () => 'new',
    saveTariffsToCanon: value => { saved = value; }, $: () => host, cardHtml: () => 'new-card', refreshEditLocks() {},
    loadTariffsFromCanon: () => { throw Error('must not reload stale cache'); },
    renderTariffs: () => { throw Error('must not replace existing DOM inputs'); } };
  vm.createContext(ctx); vm.runInContext(add, ctx); ctx.addTariff();
  assert.equal(saved.length, populated ? 2 : 1);
  if (populated) {
    assert.equal(saved[0].title, 'Содержание'); assert.equal(saved[0].rates[0].value, 20);
    assert.equal(existingInput.value, 'unfinished month draft'); assert.equal(host.innerHTML, 'empty notice');
  } else assert.equal(host.innerHTML, '');
}
console.log('tariff draft preservation tests passed');
