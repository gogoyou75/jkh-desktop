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
  Data.inspectClosedTransferRetry = () => ({ eligible: true, priorOperationId: '', deletedRecipients: [] });
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

  context.window.AbonentsDB = { abonents: { A: { uid: 'uid_a', fio: 'A' } },
    premises: { p73: { flat: '73', status: 'active' } },
    links: [{ abonentId: 'A', regnum: 'p73', dateFrom: '2025-01-01', dateTo: '2025-01-31' },
      { technicalType: 'NO_NAME', abonentId: '', regnum: 'p73', dateFrom: '2025-02-01', dateTo: '' }],
    premiseEvents: [{ type: 'RESPONSIBILITY_TRANSFER', oldAbonentId: 'A', newAbonentId: 'B',
      transferMode: 'NO_DEBT', fromRegnums: ['p73'], operationId: 'old-a-b' }] };
  elements.na_date_from.value = '2025-02-01';
  Data.inspectClosedTransferRetry = () => ({ eligible: true, priorOperationId: 'old-a-b', deletedRecipients: ['B'] });
  vm.runInContext('refreshDebtTransferBox()', context);
  assert.equal(vm.runInContext('__transferCtx.closed', context), true);
  assert.match(elements.debtTransferInfo.textContent, /ранее удалённого/);
  assert.match(elements.debtTransferInfo.textContent, /ЛС B/);
  assert.match(elements.debtTransferInfo.textContent, /2025-01-31/);
  Data.inspectClosedTransferRetry = () => ({ eligible: false, reason: 'Есть действующий получатель' });
  vm.runInContext('refreshDebtTransferBox()', context);
  assert.equal(elements.btnTransferWithDebt.disabled, true);
  assert.equal(elements.btnTransferNoDebt.disabled, true);
  assert.match(elements.debtTransferInfo.textContent, /Есть действующий получатель/);

  const sourceData = fs.readFileSync('web/data.js', 'utf8');
  assert.match(sourceData, /getConfirmedClosedOutgoingTransfer/);
  assert.match(sourceData, /getFinancialTransferHistory/);
  assert.match(sourceData, /inspectClosedTransferRetry/);
  const retrySource = sourceData.match(/Data\.inspectClosedTransferRetry = function\(abonentId, regnum\) \{[\s\S]*?\n  \};\n  Data\.getFinancialTransferHistory/);
  assert.ok(retrySource);
  const retryDb = { abonents: { A: { uid: 'uid_a' } }, links: [], premiseEvents: [
    { type: 'RESPONSIBILITY_TRANSFER', oldAbonentId: 'A', newAbonentId: 'B',
      transferMode: 'NO_DEBT', fromRegnums: ['p73'], operationId: 'old-a-b' },
    { type: 'ABONENT_DELETED', abonentId: 'B', uid: 'uid_b', regnum: 'p73' }] };
  const retryFinancial = [{ type: 'TRANSFER_WITHOUT_DEBT', mode: 'WITHOUT_DEBT',
    sourceAbonentId: 'A', targetAbonentId: 'B', regnum: 'p73', operationId: 'old-a-b', debtAmount: 0 }];
  const retryContext = vm.createContext({ Data: {}, window: { AbonentsDB: retryDb }, Set,
    normalizeRegnumValue: value => String(value || ''),
    _getProjectRaw: key => key === 'jkh_financial_events_v1' ? JSON.stringify(retryFinancial) : '',
    getFinancialTransferInfo: () => ({ outgoing: [], incoming: null }) });
  vm.runInContext(retrySource[0].replace(/\n  Data\.getFinancialTransferHistory$/, ''), retryContext);
  assert.equal(vm.runInContext("Data.inspectClosedTransferRetry('A', 'p73').eligible", retryContext), true);
  retryFinancial[0].type = 'TRANSFER_WITH_DEBT';
  assert.equal(vm.runInContext("Data.inspectClosedTransferRetry('A', 'p73').eligible", retryContext), false);
  const historySource = sourceData.match(/Data\.getFinancialTransferHistory = function\(abonentId, regnum\) \{[\s\S]*?\n  \};\n  Data\.getConfirmedClosedOutgoingTransfer/);
  assert.ok(historySource);
  const financialHistory = [
    { ...retryFinancial[0], type: 'TRANSFER_WITHOUT_DEBT', mode: 'WITHOUT_DEBT', date: '2025-02-01' },
    { type: 'TRANSFER_WITH_DEBT', mode: 'WITH_DEBT', sourceAbonentId: 'A', targetAbonentId: 'C',
      regnum: 'p73', date: '2025-03-01', freezeDate: '2025-01-31', operationId: 'new-a-c',
      replacesOperationId: 'old-a-b', sourcePrincipal: 10000, sourcePenalty: 100,
      principal: 10000, penalty: 100 }];
  const historyContext = vm.createContext({ Data: {}, window: { AbonentsDB: {
    abonents: { A: { fio: 'A Name' }, C: { fio: 'C Name' } },
    premiseEvents: [{ operationId: 'old-a-b', oldRespTo: '2025-01-31' }] } },
    normalizeRegnumValue: value => String(value || ''),
    _getProjectRaw: key => key === 'jkh_financial_events_v1' ? JSON.stringify(financialHistory) :
      key === 'jkh_frozen_debt_v1:A:2025-01-31' ? JSON.stringify({ success: true, calculatedAt: '2025-01-31', principal: 10000, penalty: 100 }) :
      key === 'jkh_transfer_balance_v1:C:p73' ? JSON.stringify({ fromAbonentId: 'A', startDate: '2025-03-01', principal: 10000, penalty: 100 }) : null });
  vm.runInContext(historySource[0].replace(/\n  Data\.getConfirmedClosedOutgoingTransfer$/, ''), historyContext);
  const oldHistory = vm.runInContext("Data.getFinancialTransferHistory('A', 'p73')", historyContext);
  assert.equal(oldHistory.length, 2);
  assert.equal(oldHistory[0].status, 'DELETED_RECIPIENT');
  assert.equal(oldHistory[1].sourcePrincipal, 10000);
  assert.equal(oldHistory[1].replacesOperationId, 'old-a-b');
  const newHistory = vm.runInContext("Data.getFinancialTransferHistory('C', 'p73')", historyContext);
  assert.equal(newHistory.length, 1);
  assert.equal(newHistory[0].transferredPrincipal, 10000);
  retryFinancial[0].type = 'TRANSFER_WITHOUT_DEBT';
  retryDb.abonents.B = { uid: 'uid_b' };
  assert.equal(vm.runInContext("Data.inspectClosedTransferRetry('A', 'p73').eligible", retryContext), false);
  assert.match(cardHtml, /Передача задолженности/);
  assert.match(cardHtml, /Полученная задолженность/);
  const renderSource = cardHtml.match(/function renderTransferInfo\(abonentId, regnum\)\{[\s\S]*?\n\}\n\nfunction openResponsibilityReport/);
  assert.ok(renderSource);
  const cardElements = new Map();
  const createElement = () => ({ children: [], style: {}, textContent: '', appendChild(node) { this.children.push(node); },
    replaceChildren() { this.children = []; } });
  for (const id of ['transferCard', 'transferIncoming', 'transferFreeze', 'transferOutgoing', 'transferClosedNotice']) {
    cardElements.set(id, createElement());
  }
  const oldTransfer = { operationId: 'old-a-b', date: '2025-02-01', sourceId: 'A', targetId: 'B',
    sourceName: 'A Name', targetName: '', mode: 'NO_DEBT', sourcePrincipal: null, sourcePenalty: null,
    transferredPrincipal: 0, transferredPenalty: 0, status: 'DELETED_RECIPIENT', replacesOperationId: '' };
  const newTransfer = { operationId: 'new-a-c', date: '2025-03-01', sourceId: 'A', targetId: 'C',
    sourceName: 'A Name', targetName: 'C Name', mode: 'WITH_DEBT', sourcePrincipal: 10000, sourcePenalty: 100,
    transferredPrincipal: 10000, transferredPenalty: 100, status: 'CONFIRMED', replacesOperationId: 'old-a-b' };
  const cardContext = vm.createContext({ window: { Data: { getFinancialTransferHistory: id =>
      id === 'A' ? [oldTransfer, newTransfer] : [newTransfer] } },
    document: { getElementById: id => cardElements.get(id) || null, createElement },
    __getIncomingTransfer: () => null, __getFreezeToISO: () => '', __findOutgoingTransfers: () => [],
    getDb: () => ({ A: { fio: 'A Name' }, C: { fio: 'C Name' } }),
    __fmt2: value => Number(value).toFixed(2), encodeURIComponent });
  vm.runInContext(renderSource[0].replace(/\n\nfunction openResponsibilityReport$/, ''), cardContext);
  vm.runInContext("renderTransferInfo('A', 'p73')", cardContext);
  const history = cardElements.get('transferClosedNotice');
  assert.equal(history.children.length, 2);
  assert.match(history.children[0].children[1].textContent, /получатель удалён/);
  assert.match(history.children[1].children[1].textContent, /10000\.00/);
  assert.match(history.children[1].children[1].textContent, /old-a-b/);
  vm.runInContext("renderTransferInfo('C', 'p73')", cardContext);
  assert.equal(history.children.length, 1);
  assert.match(history.children[0].children[0].textContent, /Полученная задолженность/);
  assert.equal(history.children[0].children[2].href, 'abonent_card.html?abonent=A');
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
