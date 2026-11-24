const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

// Exercise production parser/serializer functions, without DOM, HTTP or database writes.
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web/import_xls.html'), 'utf8');
for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
  if (script[1].trim()) new vm.Script(script[1]);
}
const context = vm.createContext({ console: { log() {}, warn() {} } });
vm.runInContext(fs.readFileSync(path.join(root, 'web/xlsx.full.min.js'), 'utf8'), context);
function productionFunction(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name);
  const tail = html.slice(start);
  const next = tail.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
const names = [
  'normStr', 'normNum', 'pad2', 'normalizePeriod', 'normalizePaidDateStrict',
  'toIsoDateFromDisplayDate', 'ensureImportRowUidFields', 'getResolvedUid',
  'extractYearFromAny', 'detectWorkbookYear', 'readFileYearFromA15',
  'getFileYearA15Error', 'getPaymentYearForValidation', 'validatePaymentYears',
  'collectPaymentRowsForYearValidation', 'normalizeHeaderIndex',
  'findCustomer2009HeaderRow', 'parseSheetToRows', 'resolveExplicitPaymentPeriod',
  'makeContractError', 'buildServerPaymentRow'
];
context.sourceNameByIndex = n => 'Source ' + n;
context.logPaymentPeriodContract = () => {};
for (const name of names) vm.runInContext(productionFunction(name), context);
const XLSX = context.XLSX;
let checks = 0;
function check(label, run) {
  run();
  checks++;
  console.log('PASS ' + label);
}
function fixture(year, paidDate = '2025-08-03') {
  const rows = Array.from({ length: 16 }, () => []);
  rows[14][0] = year;
  for (let n = 0; n <= 77; n++) rows[14][n + 1] = n;
  Object.assign(rows[15], {
    1: 'uid_local_a15_test', 2: '1004', 3: 'Synthetic', 4: 'Test',
    5: 'Only', 6: 41.5,
    49: 454.84, 50: paidDate // Fields 48/49: August, source 1.
  });
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (year === undefined) delete sheet.A15;
  return sheet;
}
function parse(sheet) {
  return context.parseSheetToRows(sheet, 'misleading_1999.xlsx', 'Sheet2000');
}
for (const year of [2009, 2025, 2026, '2025']) {
  check('A15=' + year + ': parser and server payload', () => {
    const date = Number(year) + '-08-03';
    const result = parse(fixture(year, date));
    assert.equal(result.ok, true);
    assert.equal(context.parseMeta.mode, 'strict-template-customer-2009');
    assert.equal(context.parseMeta.workbookYear, String(year));
    const row = result.rows[0];
    assert.equal(row.rowYear, String(year));
    assert.equal(row.uid, 'uid_local_a15_test');
    assert.equal(row.ls, '1004');
    assert.equal(row.square, 41.5);
    assert.equal(row.payments.length, 36);
    for (const payment of row.payments) {
      assert.equal(payment.year, String(year));
      assert.equal(payment.periodRaw, year + '-' + payment.month);
    }
    const payment = row.payments.find(p => Number(p.amount) > 0);
    const payload = context.buildServerPaymentRow(row, payment, { uid: row.uid, id: row.ls });
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
      account_uid: row.uid, account_number: '1004', payment_date: date,
      payment_period: year + '-08', amount: 454.84, source_index: 1
    });
  });
}
for (const invalid of [undefined, null, '', ' ', 'invalid', 2025.5, 1899, 2101]) {
  check('invalid A15=' + String(invalid) + ': explicit failure', () => {
    const result = parse(fixture(invalid));
    assert.equal(result.ok, false);
    assert.match(result.msg, /A15/);
    assert.match(result.msg, /не указан|некорректный/);
    assert.equal(result.rows, undefined);
  });
}
for (const paymentYear of [2024, 2025, 2026, 2027]) {
  check('payment date year=' + paymentYear + ': existing validation', () => {
    const row = parse(fixture(2025, paymentYear + '-08-03')).rows[0];
    const payment = row.payments.find(p => Number(p.amount) > 0);
    const payload = context.buildServerPaymentRow(row, payment, { uid: row.uid, id: row.ls });
    assert.equal(payload.payment_date, paymentYear + '-08-03');
    assert.equal(payload.payment_period, '2025-08');
    const validation = context.validatePaymentYears(context.collectPaymentRowsForYearValidation([row]), 2025);
    assert.equal(validation.status, paymentYear === 2025 ? 'ok' : paymentYear === 2027 ? 'error' : 'warning');
    assert.equal(validation.neighborYearCount, [2024, 2026].includes(paymentYear) ? 1 : 0);
    assert.equal(validation.invalidYearCount, paymentYear === 2027 ? 1 : 0);
  });
}
check('duplicate field-map indexes remain rejected', () => {
  const sheet = fixture(2025);
  sheet[XLSX.utils.encode_cell({ r: 14, c: 21 })].v = 19;
  const result = parse(sheet);
  assert.equal(result.ok, false);
  assert.match(result.msg, /дубли/);
});
if (process.argv[2]) {
  check('prepared workbook: all six payment payloads and UID/LS/square preserved', () => {
    const wb = XLSX.read(new Uint8Array(fs.readFileSync(process.argv[2])), { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const result = context.parseSheetToRows(sheet, path.basename(process.argv[2]), wb.SheetNames[0]);
    assert.equal(result.ok, true);
    const wanted = [
      ['1001', 'uid_mwpy0vdo_4uhqe6', 29.9],
      ['1003', 'uid_mwpy1g75_mmjhsk', 86.4],
      ['1004', 'uid_mwpy1w12_mp3ffp', 41.5]
    ];
    const expected = [
      ['2025-08-03', 454.84, '2025-08', 1], ['2025-08-30', 454.84, '2025-08', 2],
      ['2025-09-28', 454.84, '2025-09', 1], ['2025-09-04', 78.76, '2025-09', 2],
      ['2025-11-02', 454.84, '2025-11', 1], ['2025-12-04', 454.84, '2025-12', 1]
    ];
    for (const [ls, uid, square] of wanted) {
      const row = result.rows.find(r => r.uid === uid);
      assert.ok(row);
      assert.equal(row.ls, ls);
      assert.equal(row.square, square);
      assert.equal(row.rowYear, '2025');
      const payloads = row.payments.filter(p => Number(p.amount) > 0)
        .map(p => context.buildServerPaymentRow(row, p, { uid, id: ls }));
      const actual = payloads.map(p => [p.payment_date, p.amount, p.payment_period, p.source_index]);
      assert.deepEqual(JSON.parse(JSON.stringify(actual)), ls === '1004' ? expected : []);
      if (ls === '1004') assert.equal(Math.round(payloads.reduce((s, p) => s + p.amount, 0) * 100), 235296);
    }
  });
}
console.log('Import A15 year checks passed: ' + checks);
module.exports = { context, XLSX, fixture, parse, productionFunction };
