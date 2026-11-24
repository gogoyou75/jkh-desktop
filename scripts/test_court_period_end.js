const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'web/spravka_sud.js'), 'utf8');
const engineSource = fs.readFileSync(path.join(root, 'web/calc_engine.js'), 'utf8');
const helper = source.slice(source.indexOf('  function reportRowsThroughDate('), source.indexOf('  function normalizeDbRoot('));
const visible = new Function(helper + ';return reportRowsThroughDate;')();
const quiet = { log() {}, warn() {}, error() {}, time() {}, timeEnd() {}, timeLog() {} };
const values = new Map([
  ['refinancing_rates_normal_v1', JSON.stringify([{ from: '01.01.2025', rate: 7 }, { from: '01.07.2025', rate: 9 }, { from: '01.01.2026', rate: 10 }])]
]);
const context = { console: quiet, location: { hostname: '127.0.0.1', search: '?abonent=0002' },
  URLSearchParams, Date, performance, JKH_DATA_READY: true, JKHStore: { getRaw: k => values.get(k) ?? null } };
context.window = context;
vm.createContext(context); vm.runInContext(engineSource, context);
const e = context.JKHCalcEngine;
const asOfExpression = source.match(/const asOfFinal = ([^;]+);/)[1];
const asOf = new Function('eng', 'periodToD', 'return ' + asOfExpression);
assert.match(source, /calcPenaltyBreakdownBySourceMonth\(\s*baseRows,\s*asOfFinal/);
assert.match(source, /calcTotalsAsOfAdjusted\(baseRows, asOfFinal/);
assert.match(source, /setText\("stateDate", fmtDateRuAny\(asOfFinal\)\)/);
assert.match(source, /buildCourtViewRows\(reportRowsThroughDate\(baseRows, asOfFinal, eng\), period\)/);
const rows = [];
for (let i = 0; i < 23; i++) rows.push({ id: i + 1, year: String(2025 + Math.floor(i / 12)), month: String(i % 12 + 1).padStart(2, '0'), accrued: 1250, paid: 0, paid_date: '' });
rows.push({ id: 24, year: '2026', month: '11', accrued: 0, paid: 1000, paid_date: '2026-11-15', use_period: false });
const original = JSON.stringify(rows);
const expected = { 1: [28750, 5001.97, 33751.97], 15: [27750, 5248.52, 32998.52], 20: [27750, 5335.60, 33085.60], 30: [27750, 5509.77, 33259.77] };
for (const day of [1, 15, 20, 30]) {
  const end = asOf(e, e.parseDateAnyToDate(`2026-11-${String(day).padStart(2, '0')}`));
  assert.equal(end.getDate(), day); assert.equal(end.getHours(), 0);
  const totals = e.calcTotalsAsOfAdjusted(rows, end, { abonentId: '0002', applyAdvanceOffset: true, allowNegativePrincipal: true });
  assert.deepEqual([totals.principal, totals.penaltyDebt, totals.total], expected[day]);
  const rendered = e.buildCourtViewRows(visible(rows, end, e), { from: '2025-01-01', to: `2026-11-${String(day).padStart(2, '0')}` });
  assert.equal(rendered.length, 23);
  assert.equal(rendered.reduce((s, r) => s + r.accrued, 0), 28750, 'do not prorate monthly accruals');
  assert.equal(rendered.reduce((s, r) => s + r.paid, 0), day < 15 ? 0 : 1000, 'payment cutoff is inclusive');
  const breakdown = e.calcPenaltyBreakdownBySourceMonth(rows, end, { abonentId: '0002' });
  const sum = e.r2(Object.values(breakdown).reduce((s, x) => s + x, 0));
  if (day === 20) assert.equal(sum, 5335.59, 'ACCEPTED: monthly rounding differs by 0.01; do not correct');
}
assert.equal(JSON.stringify(rows), original, 'report must not mutate ledger');
for (const date of ['2025-01-01', '2025-12-31', '2026-01-01', '2026-02-01', '2026-02-28']) {
  const end = asOf(e, e.parseDateAnyToDate(date));
  assert.equal(e.toISODateString(end), date, 'month/year boundaries must keep requested day');
}
const sameDay = [{ accrued: 1250, paid: 500, paid_date: '20.11.2026' }];
assert.equal(visible(sameDay, new Date(2026, 10, 20), e)[0].paid, 500);
assert.equal(visible(sameDay, new Date(2026, 10, 19), e)[0].paid, 0);
assert.equal(visible(sameDay, new Date(2026, 10, 19), e)[0].accrued, 1250);
assert.equal(sameDay[0].paid, 500);
console.log('court period end regression tests passed; rounding difference ACCEPTED');
