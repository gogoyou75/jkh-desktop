// Local DOM stubs for the No Name selection and history views. No server calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const newHtml = fs.readFileSync('web/new_abonent.html', 'utf8');
const mainScript = [...newHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1]).find(source => source.includes('function refreshDebtTransferBox'));
assert.ok(mainScript);

const elements = Object.fromEntries([
  'debtTransferBox', 'debtTransferInfo', 'na_regnum', 'na_date_from',
  'newDebtStart', 'transferStartPreview', 'transferEndPreview',
  'debtTransferTitle', 'btnTransferWithDebt', 'btnTransferNoDebt'
].map(id => [id, { value: '', textContent: '', style: {} }]));
const context = vm.createContext({
  window: { AbonentsDB: { abonents: {}, premises: { p73: { flat: '73' } }, links: [] },
    location: { search: '' } },
  document: { getElementById: id => elements[id], addEventListener() {} },
  location: { href: '' }, console, URLSearchParams, Date, Math, setTimeout
});
vm.runInContext(mainScript, context);

const activeGap = { technicalType: 'NO_NAME', abonentId: '', regnum: 'p73',
  dateFrom: '2025-02-01', dateTo: '' };
context.window.AbonentsDB.links = [activeGap];
elements.na_regnum.value = 'p73';
elements.na_date_from.value = '2025-02-01';
assert.match(vm.runInContext("formatPremiseOption('p73', window.AbonentsDB.premises.p73)", context),
  /Требуется назначить ответственного/);
vm.runInContext('refreshDebtTransferBox()', context);
assert.equal(elements.debtTransferBox.style.display, 'block');
assert.equal(vm.runInContext('__transferCtx.noName', context), true);
assert.match(elements.debtTransferInfo.textContent, /No Name/);

elements.na_date_from.value = '2025-02-02';
vm.runInContext('refreshDebtTransferBox()', context);
assert.equal(elements.debtTransferBox.style.display, 'none');
assert.match(elements.debtTransferInfo.textContent, /2025-02-01/);

context.window.AbonentsDB.abonents.D = { fio: 'Д', uid: 'uid_d' };
context.window.AbonentsDB.links = [
  { ...activeGap, dateTo: '2025-02-28' },
  { abonentId: 'D', regnum: 'p73', dateFrom: '2025-03-01', dateTo: '' }
];
elements.na_date_from.value = '2025-02-01';
vm.runInContext('refreshDebtTransferBox()', context);
assert.equal(vm.runInContext('__transferCtx.noName', context), true);
assert.equal(elements.transferEndPreview.textContent, '2025-02-28');

const cardHtml = fs.readFileSync('web/abonent_card.html', 'utf8');
const start = cardHtml.indexOf('function renderResponsibilityHistory(regnum)');
const end = cardHtml.indexOf('\nfunction __r2', start);
assert.ok(start >= 0 && end > start);
const rows = [];
const body = { innerHTML: '', appendChild(row) { rows.push(row); } };
const historyContext = vm.createContext({
  document: { getElementById: id => id === 'respHistoryBody' ? body : null,
    createElement: () => ({ innerHTML: '' }) },
  getLinks: () => context.window.AbonentsDB.links,
  getDb: () => context.window.AbonentsDB.abonents
});
vm.runInContext(cardHtml.slice(start, end), historyContext);
vm.runInContext("renderResponsibilityHistory('p73')", historyContext);
const gapRow = rows.find(row => row.innerHTML.includes('No Name'));
assert.ok(gapRow);
assert.match(gapRow.innerHTML, /Требуется назначить ответственного/);
assert.doesNotMatch(gapRow.innerHTML, /abonent_card\.html\?abonent=/);

const registrySource = fs.readFileSync('web/premises_admin.js', 'utf8');
const registryLabels = [...registrySource.matchAll(/const fio = link && link\.technicalType === 'NO_NAME'[\s\S]*?;\n/g)];
assert.equal(registryLabels.length, 2);
for (const match of registryLabels) {
  const label = vm.runInNewContext(`(function() {
    const link = { technicalType: 'NO_NAME', abonentId: '' };
    const db = { abonents: {} };
    const fioById = () => '';
    ${match[0]}
    return fio;
  })()`);
  assert.match(label, /Требуется назначить ответственного/);
}

const formFields = {
  na_last: 'Иванов', na_first: 'Иван', na_mid: '', na_regnum: 'p73',
  na_city: '', na_street: '', na_house: '', na_flat: '73', na_square: '',
  na_phone: '', na_email: '', na_note: '', na_ls: '0100',
  na_date_from: '2025-02-01', na_src: '', na_return: ''
};
for (const [id, value] of Object.entries(formFields)) elements[id] = { value, textContent: '', style: {} };
elements.createStatusText = { textContent: '' };
let assignCalls = 0;
let legacyCalls = 0;
let assignmentOutcome = new Error('synthetic stop before server write');
const Data = {
  assignNoNameAtomic: async options => {
    assignCalls++;
    assert.equal(options.dateFrom, '2025-02-01');
    assert.equal(options.mode, 'WITH_DEBT');
    if (assignmentOutcome instanceof Error) throw assignmentOutcome;
    return assignmentOutcome;
  },
  transferResponsibility: async () => { legacyCalls++; },
  createEmptyPaymentLedger: () => { legacyCalls++; },
  resolvePaymentLedgerKey: () => 'payments_uid_test'
};
context.Data = Data;
context.window.Data = Data;
context.window.canWriteOrExplain = () => true;
context.crypto = { randomUUID: () => 'synthetic-operation' };
context.window.AbonentsDB = { abonents: {}, premises: { p73: { flat: '73', status: 'active' } },
  links: [activeGap], premiseEvents: [] };
vm.runInContext("__jkhTransferConfirmed = true; __transferMode = 'WITH_DEBT'; __transferCtx = { noName:true, gap:window.AbonentsDB.links[0] };", context);

(async () => {
  await vm.runInContext('createAbonent()', context);
  assert.equal(assignCalls, 1);
  assert.equal(legacyCalls, 0);
  assert.equal(Object.keys(context.window.AbonentsDB.abonents).length, 0);
  assert.match(elements.createStatusText.textContent, /synthetic stop before server write/);

  assignmentOutcome = false;
  await vm.runInContext('createAbonent()', context);
  assert.equal(assignCalls, 2);
  assert.equal(Object.keys(context.window.AbonentsDB.abonents).length, 0);
  assert.match(elements.createStatusText.textContent, /NO_NAME_ASSIGN_NOT_COMMITTED/);
  assert.equal(context.location.href, '');

  assignmentOutcome = true;
  await vm.runInContext('createAbonent()', context);
  assert.equal(assignCalls, 3);
  assert.equal(legacyCalls, 0);
  assert.equal(context.window.AbonentsDB.abonents['0100'].uid.length > 0, true);
  assert.equal(context.location.href, 'abonent_card.html?abonent=0100');

  let closedCalls = 0;
  let closedOutcome = false;
  Data.assignClosedResponsibilityAtomic = async options => {
    closedCalls++;
    assert.equal(options.sourceAbonentId, 'A');
    assert.equal(options.sourceCloseDate, '2025-01-31');
    assert.equal(options.dateFrom, '2025-03-01');
    assert.equal(options.mode, 'WITH_DEBT');
    return closedOutcome;
  };
  Data.getFinancialTransferInfo = () => ({ outgoing: [] });
  context.window.JKHCalcEngine = { calculateFrozenDebt: () => ({
    success: true, principal: 10000, penalty: 100, calculatedAt: '2025-01-31'
  }) };
  context.window.AbonentsDB = { abonents: { A: { uid: 'uid_a', fio: 'A' } },
    premises: { p73: { flat: '73', status: 'active' } },
    links: [{ abonentId: 'A', regnum: 'p73', dateFrom: '2025-01-01', dateTo: '2025-01-31' }],
    premiseEvents: [] };
  elements.na_ls.value = '0101';
  elements.na_date_from.value = '2025-03-01';
  context.location.href = '';
  vm.runInContext('refreshDebtTransferBox()', context);
  assert.equal(elements.debtTransferBox.style.display, 'block');
  assert.equal(vm.runInContext('__transferCtx.closed', context), true);
  assert.match(elements.debtTransferInfo.textContent, /10000\.00/);
  await vm.runInContext('createAbonent()', context);
  assert.equal(closedCalls, 0);
  assert.match(elements.createStatusText.textContent, /обычное создание заблокировано/);
  vm.runInContext("__jkhTransferConfirmed = true; __transferMode = 'WITH_DEBT'", context);
  await vm.runInContext('createAbonent()', context);
  assert.equal(closedCalls, 1);
  assert.equal(context.window.AbonentsDB.abonents['0101'], undefined);
  assert.equal(context.location.href, '');
  assert.match(elements.createStatusText.textContent, /CLOSED_ASSIGN_NOT_COMMITTED/);
  closedOutcome = true;
  await vm.runInContext('createAbonent()', context);
  assert.equal(closedCalls, 2);
  assert.equal(legacyCalls, 0);
  assert.equal(context.location.href, 'abonent_card.html?abonent=0101');

  const sourceData = fs.readFileSync('web/data.js', 'utf8');
  assert.match(sourceData, /getConfirmedClosedOutgoingTransfer/);
  assert.match(cardHtml, /Задолженность передана новому абоненту/);
  const courtHtml = fs.readFileSync('web/spravka_sud.html', 'utf8');
  const courtScript = fs.readFileSync('web/spravka_sud.js', 'utf8');
  assert.match(courtHtml, /id="transferredDebtNotice"/);
  assert.match(courtScript, /getConfirmedClosedOutgoingTransfer/);

  const deleteStart = cardHtml.indexOf('let __deleteAbonentBusy = false;');
  const deleteEnd = cardHtml.indexOf('\nasync function saveAbonentEdit()', deleteStart);
  assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);
  const deletionAlerts = [];
  let closeCalls = 0;
  let deleteOutcome = false;
  const deleteContext = vm.createContext({
    window: { confirm: () => true, location: { href: '' }, Data: {
      deleteAbonentAtomic: async () => deleteOutcome
    } },
    Data: { deleteAbonentAtomic: async () => deleteOutcome },
    canWriteOrExplainLocal: () => true,
    getCurrentAbonent: () => ({ id: '0100', a: { uid: 'uid_test' } }),
    crypto: { randomUUID: () => 'synthetic-delete' },
    alert: message => deletionAlerts.push(message),
    closeAbonentEdit: () => { closeCalls++; },
    console: { error() {} }
  });
  vm.runInContext(cardHtml.slice(deleteStart, deleteEnd), deleteContext);
  await vm.runInContext('deleteAbonentFromCard()', deleteContext);
  assert.equal(closeCalls, 0);
  assert.equal(deleteContext.window.location.href, '');
  assert.equal(deletionAlerts.some(message => message === 'Абонент удалён'), false);
  assert.match(deletionAlerts.at(-1), /ATOMIC_DELETE_NOT_COMMITTED/);

  deleteOutcome = true;
  await vm.runInContext('deleteAbonentFromCard()', deleteContext);
  assert.equal(closeCalls, 1);
  assert.equal(deleteContext.window.location.href, 'index.html');
  assert.equal(deletionAlerts.at(-1), 'Абонент удалён');
  console.log('No Name UI tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
