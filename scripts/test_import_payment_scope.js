const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { context: c, XLSX, productionFunction } = require('./test_import_a15_year');

// Mock storage, identity lookup and DOM. Run the real collector, date validation,
// duplicate/conflict checks, button logic and blocked apply handler without writes.
for (const name of [
  'normalizePaidDate', 'parseYearMonthFromAny', 'getLedgerYearMonth',
  'getLedgerPaidDate', 'getLedgerPaidAmount', 'getAbonentStartDate', 'getYearMonthFromDateISO',
  'isPaymentBeforeAbonentStart', 'isPaymentAfterResponsibilityStop',
  'paymentPairsCount', 'makeEmptyImportPaymentsCollection',
  'collectImportPaymentsToApply', 'getPaymentImportPlan',
  'hasRowsWithUid', 'canEnterPaymentsMode', 'isImportBlockedByFileYear',
  'isApplyBlockedByTemplateMode', 'escHtml', 'setFileYearAnalysis',
  'setButtons', 'setImportStatus', 'setImportBusy', 'isLedgerJsonInvalidError'
]) vm.runInContext(productionFunction(name), c);
vm.runInContext('async ' + productionFunction('applyPayments').split("\n$('previewBody')")[0], c);

const elements = {};
c.$ = id => elements[id] ||= { files: [], checked: false, disabled: false,
  innerHTML: '', textContent: '', style: {}, classList: { toggle() {} } };
c.window = {};
c.getDB = () => c.window.AbonentsDB;
c.getPrimaryApplyPlan = () => ({ applicable: 1, skippedError: 0 });
c.canWriteOrExplain = () => c.writeAllowed;
c.findAbonentByUid = (db, uid) => {
  const entry = Object.entries(db.abonents).find(([, a]) => a.uid === uid);
  return entry ? { key: entry[0], abonent: entry[1] } : null;
};
c.evaluatePrimaryRow = (db, row) => ({ status: row.testStatus ||
  (c.findAbonentByUid(db, row.uid) ? 'OK' : 'ERROR') });
c.findAbonentByRules = (db, row) => ({ type: row.matchType || 'UID_OK' });
c.softFioMatch = () => true;
c.getImportAbonentResponsibilityStatus = (db, key, ab) => ({ stopped: !!ab.stopTo, to: ab.stopTo || '' });
c.logImportResponsibilityStopped = () => {};
c.getPaymentsByUid = uid => c.ledgers[uid] || [];
c.PAYMENT_PERIOD_MISSING_MESSAGE = 'Missing payment period';
c.UID_SOFT_MISMATCH_TEXT = 'Soft mismatch';
c.LEDGER_FATAL_MESSAGE = 'Invalid ledger';
let requests = 0;
c.apiJson = async () => { requests++; throw new Error('Network writes forbidden in this test'); };
let checks = 0;
async function check(label, run) {
  await run(); checks++; console.log('PASS ' + label);
}
function row(date = '2025-08-03', uid = 'uid_test') {
  return { excelRow: 16, uid, excelUid: uid, resolvedUid: uid, ls: '1004',
    square: 41.5, fam: 'Synthetic', name: 'Test', otch: 'Only',
    payments: [{ amount: 454.84, paidDateRaw: date, year: '2025', month: '08',
      periodRaw: '2025-08', sourceIndex: 1 }] };
}
function setup(rows = [row()]) {
  c.dataRows = rows;
  c.window.AbonentsDB = { abonents: { '1004': { id: '1004', uid: 'uid_test', calcStartDate: '2025-01-01' } } };
  c.ledgers = {};
  c.fileYearValidation = c.validatePaymentYears(c.collectPaymentRowsForYearValidation(rows), 2025);
  c.fileYearBlockReason = c.fileYearValidation.status === 'error' ? 'Обнаружены некорректные даты оплат' : '';
  c.parseMeta = { mode: 'strict-template-customer-2009', workbookYear: '2025' };
  c.mode = 'payments'; c.primaryApplied = false; c.importApplyBusy = false;
  c.currentFileName = 'test.xlsx'; c.writeAllowed = true; c.serverPaymentRows = [];
  requests = 0;
}
async function main() {
  await check('excluded row year errors do not block eligible payments; diagnostics retained', () => {
    const bad = row('2007-08-03', 'uid_missing'); bad.excelRow = 19;
    setup([row(), bad]);
    const plan = c.getPaymentImportPlan(c.getDB());
    assert.equal(c.fileYearValidation.invalidYearCount, 1);
    assert.equal(plan.blocked, false);
    assert.equal(plan.collection.rows.length, 1);
    assert.equal(plan.collection.rows[0].account_uid, 'uid_test');
    assert.equal(plan.collection.totalErrorRows, 1);
    assert.equal(c.canEnterPaymentsMode(plan), true);
    c.setButtons();
    assert.equal(c.$('btnApplyPayments').disabled, false);
    assert.match(c.$('fileYearAnalysisBox').innerHTML, /Исключено ошибочных строк: 1/);
    assert.match(c.$('fileYearAnalysisBox').innerHTML, /2007/);
    c.mode = 'primary'; c.setButtons();
    assert.equal(c.$('btnApplyPrimary').disabled, true, 'primary data writes retain their existing whole-file guard');
  });
  await check('invalid year of eligible payment blocks button and apply before HTTP', async () => {
    setup([row('2007-08-03')]);
    const plan = c.getPaymentImportPlan(c.getDB());
    assert.equal(plan.blocked, true);
    assert.equal(plan.yearValidation.invalidYearCount, 1);
    assert.equal(c.canEnterPaymentsMode(plan), false);
    c.setButtons(); assert.equal(c.$('btnApplyPayments').disabled, true);
    await c.applyPayments(); assert.equal(requests, 0);
  });
  for (const year of [null, undefined, '', '2025', 2025.5, 1899, 2101]) {
    await check('missing/invalid validated A15=' + String(year) + ' blocks apply', async () => {
      setup(); c.fileYearValidation = year === null ? null : { fileYear: year };
      assert.equal(c.getPaymentImportPlan(c.getDB()).blocked, true);
      c.setButtons(); assert.equal(c.$('btnApplyPayments').disabled, true);
      await c.applyPayments(); assert.equal(requests, 0);
    });
  }
  for (const year of [2024, 2026]) {
    await check('neighbor year=' + year + ' remains warning', () => {
      setup([row(year + '-08-03')]);
      const plan = c.getPaymentImportPlan(c.getDB());
      assert.equal(plan.blocked, false);
      assert.equal(plan.yearValidation.status, 'warning');
      assert.equal(plan.collection.rows[0].payment_period, '2025-08');
    });
  }
  for (const status of ['ERROR', 'NOT_FOUND', 'FOUND_NEEDS_EXCEL_UID']) {
    await check(status + ' rows remain excluded', () => {
      const bad = row('2007-08-03'); bad.testStatus = status;
      setup([bad]); const plan = c.getPaymentImportPlan(c.getDB());
      assert.equal(plan.collection.rows.length, 0);
      assert.equal(plan.collection.totalErrorRows, 1);
      c.setButtons(); assert.equal(c.$('btnApplyPayments').disabled, true);
    });
  }
  await check('duplicate remains excluded', () => {
    setup(); c.ledgers.uid_test = [{ year: '2025', month: '08', paid: 454.84, paid_date: '03.08.2025' }];
    const plan = c.getPaymentImportPlan(c.getDB());
    assert.equal(plan.collection.totalDuplicate, 1); assert.equal(plan.collection.rows.length, 0);
    c.setButtons(); assert.equal(c.$('btnApplyPayments').disabled, true);
  });
  await check('conflict remains excluded', () => {
    setup(); c.ledgers.uid_test = [{ year: '2025', month: '08', paid: 400, paid_date: '03.08.2025' }];
    const plan = c.getPaymentImportPlan(c.getDB());
    assert.equal(plan.collection.totalConflict, 1); assert.equal(plan.collection.rows.length, 0);
  });
  await check('responsibility end and accrual start remain enforced', () => {
    setup(); c.getDB().abonents['1004'].stopTo = '2025-07-31';
    assert.equal(c.getPaymentImportPlan(c.getDB()).collection.rows.length, 0);
    setup(); c.getDB().abonents['1004'].calcStartDate = '2025-09-01';
    assert.equal(c.getPaymentImportPlan(c.getDB()).collection.rows.length, 0);
  });
  await check('auth, mode, busy and template still disable button', () => {
    for (const mutate of [() => { c.writeAllowed = false; }, () => { c.mode = 'primary'; },
      () => { c.importApplyBusy = true; }, () => { c.parseMeta.mode = 'unknown'; }]) {
      setup(); mutate(); c.setButtons(); assert.equal(c.$('btnApplyPayments').disabled, true);
    }
  });
  await check('readiness is recomputed after UID/status changes', () => {
    const bad = row('2007-08-03', 'uid_missing'); setup([row(), bad]);
    assert.equal(c.getPaymentImportPlan(c.getDB()).blocked, false);
    c.getDB().abonents['new'] = { uid: 'uid_missing', id: '1005', calcStartDate: '2025-01-01' };
    assert.equal(c.getPaymentImportPlan(c.getDB()).blocked, true);
  });
  await check('apply handler sends only eligible rows to mocked transport', async () => {
    const excluded = row('2007-08-03', 'uid_missing'); excluded.excelRow = 19;
    setup([row(), excluded]);
    const originalApi = c.apiJson;
    const sent = [];
    c.apiJson = async (url, options) => {
      sent.push({ url, payload: JSON.parse(options.body) });
      throw new Error('Mock transport: no actual request');
    };
    try {
      await c.applyPayments();
      assert.equal(sent.length, 1);
      assert.equal(sent[0].url, '/api/import/payments/upload_rows');
      assert.equal(sent[0].payload.rows.length, 1);
      assert.equal(sent[0].payload.rows[0].account_uid, 'uid_test');
      assert.equal(sent[0].payload.rows[0].payment_period, '2025-08');
    } finally { c.apiJson = originalApi; }
  });
  await check('apply handler retains auth, mode and template guards before HTTP', async () => {
    for (const mutate of [() => { c.writeAllowed = false; }, () => { c.mode = 'primary'; },
      () => { c.parseMeta.mode = 'unknown'; }]) {
      setup(); mutate(); await c.applyPayments(); assert.equal(requests, 0);
    }
  });
  if (process.argv[2]) await check('real Excel: exactly six rows for LS 1004; all other rows excluded', () => {
    const wb = XLSX.read(new Uint8Array(fs.readFileSync(process.argv[2])), { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const parsed = c.parseSheetToRows(sheet, 'test_2025.xlsx', wb.SheetNames[0]);
    setup(parsed.rows);
    c.getDB().abonents = Object.fromEntries([
      ['1001', 'uid_mwpy0vdo_4uhqe6'], ['1003', 'uid_mwpy1g75_mmjhsk'], ['1004', 'uid_mwpy1w12_mp3ffp']
    ].map(([id, uid]) => [id, { id, uid, calcStartDate: '2025-01-01' }]));
    const plan = c.getPaymentImportPlan(c.getDB());
    assert.equal(plan.blocked, false); assert.equal(plan.collection.totalNew, 6);
    assert.equal(plan.collection.totalErrorRows, 81); assert.equal(c.fileYearValidation.invalidYearCount, 213);
    assert.ok(plan.collection.rows.every(p => p.account_number === '1004' && p.payment_period.startsWith('2025-')));
    assert.equal(Math.round(plan.collection.rows.reduce((s, p) => s + p.amount, 0) * 100), 235296);
    c.setButtons(); assert.equal(c.$('btnApplyPayments').disabled, false);
  });
  console.log('Selective payment import checks passed: ' + checks);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
