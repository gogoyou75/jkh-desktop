const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const zones = ['UTC', 'Europe/Moscow', 'America/New_York', 'Asia/Tokyo'];
if (!process.argv.includes('--zone')) {
  for (const TZ of zones) {
    const child = spawnSync(process.execPath, [__filename, '--zone'], {
      cwd: root, env: { ...process.env, TZ }, encoding: 'utf8'
    });
    process.stdout.write(child.stdout || '');
    if (child.error) { console.error('timezone child process blocked:', child.error.code); process.exit(1); }
    if (child.status !== 0) { process.stderr.write(child.stderr || ''); process.exit(1); }
  }
  console.log('rate calendar regression matrix passed (4 time zones)');
  process.exit(0);
}

function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, 'source function boundaries must exist');
  return source.slice(a, b);
}
const engineSource = fs.readFileSync(path.join(root, 'web/calc_engine.js'), 'utf8');
const tableSource = fs.readFileSync(path.join(root, 'web/payment_table.js'), 'utf8');
const rateFunction = s => between(s, '  function rateOnDate(', '  function capRateUntil2027(');
const capFunction = s => {
  const a = s.indexOf('  function capRateUntil2027('), b = s.indexOf('\n  }', a);
  assert(a >= 0 && b > a, 'cap function boundaries must exist');
  return s.slice(a, b + 4);
};
// Only the existing rate lookup patch and the exact calendar-cutoff replacement are allowed.
for (const [file, current] of [['web/calc_engine.js', engineSource], ['web/payment_table.js', tableSource]]) {
  const committed = execFileSync('git', ['show', 'HEAD:' + file], { cwd: root, encoding: 'utf8' });
  assert.equal(capFunction(current), capFunction(committed).replace('new Date("2027-01-01")', 'new Date(2027, 0, 1)'), file + ': unrelated cap change');
  const outsideAllowedFunctions = s => s.replace(rateFunction(s), '').replace(capFunction(s), '');
  assert.equal(outsideAllowedFunctions(current), outsideAllowedFunctions(committed), file + ': unrelated calculation change');
}
const quiet = { log() {}, warn() {}, error() {}, time() {}, timeEnd() {}, timeLog() {} };
function engine(source = engineSource) {
  const data = new Map();
  const context = { console: quiet, location: { hostname: '127.0.0.1', search: '?abonent=test' },
    URLSearchParams, performance, Date, setTimeout, clearTimeout };
  context.window = context;
  context.JKH_DATA_READY = true;
  context.JKHStore = { getRaw: key => data.has(key) ? data.get(key) : null };
  vm.createContext(context); vm.runInContext(source, context);
  return { api: context.JKHCalcEngine, data };
}
const { api: e, data } = engine();
const lookup = s => new Function('console', 'toISODateString', rateFunction(s) + '; return rateOnDate;')(quiet, e.toISODateString);
const lookups = [lookup(engineSource), lookup(tableSource)];
const dates = [['30.06.2025', 7], ['01.07.2025', 9], ['02.07.2025', 9],
  ['31.12.2025', 9], ['01.01.2026', 10], ['02.01.2026', 10]];
const schedule = [['01.01.2025', 7], ['01.07.2025', 9], ['01.01.2026', 10]];
function format(dmy, kind) {
  const [d, m, y] = dmy.split('.').map(Number);
  if (kind === 'ISO') return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (kind === 'Excel') return Date.UTC(y, m - 1, d) / 86400000 + 25569;
  return dmy;
}
for (const kind of ['DMY', 'ISO', 'Excel']) {
  const rates = schedule.map(([d, rate]) => ({ from: e.parseDateAnyToDate(format(d, kind)), rate }));
  assert(rates.every(r => r.from.getHours() === 12), 'shared parser must remain unchanged');
  for (const lookup of lookups) {
    for (const [dmy, expected] of dates) for (const [h, min] of [[0, 0], [12, 0], [23, 59]]) {
      const d = e.parseDateAnyToDate(dmy); d.setHours(h, min, 0, 0);
      assert.equal(lookup(d, rates), expected, `${kind} ${dmy} ${h}:${min}`);
    }
    assert.equal(lookup(new Date(2025, 0, 1), rates), 7, 'first effective date at midnight');
    assert.equal(lookup(new Date(2024, 11, 31, 23, 59), rates), null, 'before first rate');
    assert.equal(lookup(new Date(NaN), rates), null);
    assert.equal(lookup(new Date(), []), null);
    // Both US DST transitions: local calendar dates must not depend on day length.
    for (const [m, d] of [[2, 9], [10, 2]]) {
      const transition = [{ from: new Date(2025, m, d - 1, 12), rate: 7 }, { from: new Date(2025, m, d, 12), rate: 8 }];
      for (const h of [0, 12, 23]) assert.equal(lookup(new Date(2025, m, d, h), transition), 8);
    }
  }
}

// Different values prove that the moratorium selector still selects its own dictionary.
data.set('refinancing_rates_normal_v1', JSON.stringify([{ from: '01.01.2025', rate: '7' }]));
data.set('refinancing_rates_moratorium_v1', JSON.stringify([{ from: '01.01.2025', rate: '4' }]));
data.set('moratorium_test', '0'); assert.equal(e.loadRates('test')[0].rate, 7);
data.set('moratorium_test', '1'); assert.equal(e.loadRates('test')[0].rate, 4);
data.set('moratorium_test', '0');

const tablePenalty = between(tableSource, 'function calcPenaltyForObligation(', 'function calcTotalsAsOf(');
const excluded = between(tableSource, '  function isExcludedDay(', '  function loadRates(');
const tableCalc = new Function('startOfDay', 'addDays', 'sortApplications', 'sumAppliedUpTo',
  'rateOnDate', 'capRateUntil2027', 'incRecalcCallCount', 'addRecalcLoopCount', 'setRecalcLoopMaxDays',
  'emitActiveFullRecalcHeartbeat', 'throwRatesFatal', 'toISODateString', excluded + tablePenalty + ';return calcPenaltyForObligation;')(
  e.startOfDay, (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; },
  e.sortApplications, e.sumAppliedUpTo, lookups[1],
  new Function(between(tableSource, '  function capRateUntil2027(', '  // ✅ FIX #1:') + ';return capRateUntil2027;')(),
  () => {}, () => {}, () => {}, () => {}, code => { throw Error(code); }, e.toISODateString);
const calculators = [e.calcPenaltyForObligation, tableCalc];
const constant = [{ from: new Date(2025, 0, 1, 12), rate: 10 }];
const due = new Date(2026, 1, 10);
const after = n => { const d = new Date(due); d.setDate(d.getDate() + n); return d; };
const close = (a, b, label) => assert(Math.abs(a - b) < 1e-8, `${label}: ${a} != ${b}`);
for (const calc of calculators) {
  const ob = applications => ({ key: '2026-01', amount: 1250, dueDate: due, applications: applications || [] });
  close(calc(ob(), after(30), [], constant), 0, '30 days grace');
  close(calc(ob(), after(31), [], constant), 1250 * .095 / 300, 'day 31, 9.5% cap');
  close(calc(ob(), after(90), [], constant), 60 * 1250 * .095 / 300, 'day 90');
  close(calc(ob(), after(91), [], constant), 60 * 1250 * .095 / 300 + 1250 * .095 / 130, 'day 91');
  close(calc(ob([{ date: after(31), amount: 500 }]), after(31), [], constant), 750 * .095 / 300, 'payment effective same day');
  close(calc(ob(), after(31), [{ from: after(31), to: after(31) }], constant), 0, 'excluded day');
  close(calc(ob(), after(32), [{ from: after(31), to: after(31) }], constant), 1250 * .095 / 300, 'exclusion does not consume overdue day');
}
const paymentRows = [{ id: 1, year: '2025', month: '01', accrued: 1250 },
  { id: 2, year: '2025', month: '02', accrued: 1250 },
  { id: 3, year: '2026', month: '11', paid: 500, paid_date: '20.11.2026' }];
const obligations = e.buildObligationsFromRows(paymentRows);
const payments = e.buildPaymentEventsFromRows(paymentRows, 'test');
e.allocatePaymentsFIFO(obligations, payments);
assert.equal(e.sumAppliedUpTo(obligations[0], new Date(2026, 10, 20)), 500);
assert.equal(e.sumAppliedUpTo(obligations[1], new Date(2026, 10, 20)), 0);

const rates = schedule.map(([d, rate]) => ({ from: e.parseDateAnyToDate(d), rate }));
const ledger = [];
for (let y = 2025; y <= 2026; y++) for (let m = 1; m <= (y === 2025 ? 12 : 11); m++) ledger.push({ year: String(y), month: String(m), accrued: 1250 });
const total = e.r2(e.buildObligationsFromRows(ledger).reduce((s, ob) => s + e.calcPenaltyForObligation(ob, new Date(2026, 10, 20), [], rates), 0));
assert.equal(total, 5339.99, 'independent LOCAL control amount');

// Old timestamp lookup is retained only in this in-memory regression baseline.
const oldLookup = `  function rateOnDate(d, rates){ const t=d.getTime(); let cur=null; for(const r of rates){if(r.from.getTime()<=t)cur=r.rate;else break;} return cur; }\n`;
const old = engine(engineSource.replace(rateFunction(engineSource), oldLookup)).api;
for (const [m, d] of [[5, 29], [5, 30], [6, 2], [6, 3], [11, 30]]) {
  const end = new Date(2025, m, d), prev = new Date(2025, m, d - 1);
  const ob = () => ({ key: '2025-01', amount: 1250, dueDate: new Date(2025, 1, 10), applications: [] });
  const daily = api => api.calcPenaltyForObligation(ob(), end, [], rates) - api.calcPenaltyForObligation(ob(), prev, [], rates);
  close(daily(e), daily(old), 'daily penalty outside rate transitions');
}
const caps = [engineSource, tableSource].map(s => new Function(capFunction(s) + ';return capRateUntil2027;')());
const tableParser = new Function(between(tableSource, '  function parseDateAnyToDate(', '  function toISODateString(') + ';return parseDateAnyToDate;')();
const boundaryDates = ['31.12.2026', '01.01.2027', '02.01.2027'];
for (const kind of ['DMY', 'ISO', 'Excel', 'ISO_LOCAL_TIMESTAMP', 'ISO_Z_TIMESTAMP', 'ISO_OFFSET_TIMESTAMP']) {
  for (const dmy of boundaryDates) {
    const [d, m, y] = dmy.split('.').map(Number);
    const iso = format(dmy, 'ISO'), local = new Date(y, m - 1, d, 12);
    const offset = -local.getTimezoneOffset(), sign = offset >= 0 ? '+' : '-';
    const offsetText = sign + String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0') + ':' + String(Math.abs(offset) % 60).padStart(2, '0');
    const input = kind === 'ISO_LOCAL_TIMESTAMP' ? iso + 'T00:00:00'
      : kind === 'ISO_Z_TIMESTAMP' ? local.toISOString()
      : kind === 'ISO_OFFSET_TIMESTAMP' ? iso + 'T12:00:00' + offsetText : format(dmy, kind);
    for (const parse of [e.parseDateAnyToDate, tableParser]) {
      const parsed = parse(input);
      assert.equal(e.toISODateString(parsed), iso, kind + ': local calendar date');
      for (const [h, min] of [[0, 0], [1, 0], [3, 0], [9, 0], [12, 0], [23, 59]]) {
        const day = new Date(parsed); day.setHours(h, min, 0, 0);
        for (const raw of [7, 9.5, 10, 12]) for (const cap of caps) {
          assert.equal(cap(day, raw), y < 2027 ? Math.min(9.5, raw) : raw, kind + ' ' + dmy + ' ' + h + ':' + min + ' raw=' + raw);
        }
      }
    }
  }
}
const boundaryMoney = [];
for (const raw of [7, 9.5, 10, 12]) {
  const boundaryRates = [{ from: new Date(2026, 0, 1, 12), rate: raw }];
  const makeOb = applications => ({ key: '2026-08', amount: 10000, dueDate: new Date(2026, 8, 1), applications: applications || [] });
  const capped = Math.min(9.5, raw) / 100;
  const before2027 = 60 * 10000 * capped / 300 + 31 * 10000 * capped / 130;
  for (const [i, calc] of calculators.entries()) for (const [day, daysAfter] of [[new Date(2026, 11, 31), 0], [new Date(2027, 0, 1), 1], [new Date(2027, 0, 2), 2]]) {
    const prev = new Date(day); prev.setDate(prev.getDate() - 1);
    const actual = calc(makeOb(), day, [], boundaryRates);
    const daily = actual - calc(makeOb(), prev, [], boundaryRates);
    close(daily, 10000 * (daysAfter ? raw / 100 : capped) / 130, 'cutoff daily penalty');
    close(actual, before2027 + daysAfter * 10000 * raw / 100 / 130, 'cutoff accumulated penalty');
    if (raw === 10) {
      const expected = [416.54, 424.23, 431.92][daysAfter];
      assert.equal(e.r2(actual), expected, 'cutoff rounded monetary control');
      boundaryMoney.push({ path: i === 0 ? 'engine' : 'table', date: e.toISODateString(day), daily, total: e.r2(actual) });
    }
  }
  const jan1 = new Date(2027, 0, 1), dec31 = new Date(2026, 11, 31);
  for (const calc of calculators) {
    const paidOb = () => makeOb([{ date: jan1, amount: 5000 }]);
    close(calc(paidOb(), jan1, [], boundaryRates) - calc(paidOb(), dec31, [], boundaryRates), 5000 * raw / 100 / 130, 'cutoff same-day payment');
    close(calc(makeOb(), jan1, [{ from: jan1, to: jan1 }], boundaryRates), calc(makeOb(), dec31, [], boundaryRates), 'cutoff excluded day');
  }
}
const cap2027 = caps[0](new Date(2027, 0, 1), 10);
assert.equal(cap2027, 10);
console.log(JSON.stringify({ tz: process.env.TZ, boundariesAndRegressions: 'PASS', controlPenalty: total,
  cutoff2027: 'PASS', cutoffActual: cap2027, boundaryMoney }));
