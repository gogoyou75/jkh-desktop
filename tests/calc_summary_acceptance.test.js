const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const OWNER = 'acceptance-user';
const ABONENT_ID = '9001';
const UID = 'UID-ACCEPTANCE-9001';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return Array.from(this.map.keys())[i] || null; }
  getItem(k) { k = String(k); return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(String(k)); }
  clear() { this.map.clear(); }
}

class TestElement {
  constructor(document, tagName, id) {
    this.ownerDocument = document;
    this.tagName = String(tagName || 'div').toUpperCase();
    this.id = id || '';
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attributes = {};
    this.eventListeners = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.open = false;
    this._textContent = '';
    this._innerHTML = '';
    this.className = '';
    this.classList = { add(){}, remove(){}, contains(){ return false; }, toggle(){ return false; } };
  }
  set innerHTML(value) {
    this._innerHTML = String(value ?? '');
    this._textContent = this._innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const idRe = /<([a-zA-Z0-9-]+)([^>]*\sid=["']([^"']+)["'][^>]*)>/g;
    let match;
    while ((match = idRe.exec(this._innerHTML))) {
      const child = this.ownerDocument.ensureElement(match[3], match[1]);
      child.parentNode = this;
      if (!this.children.includes(child)) this.children.push(child);
      const textAfter = this._innerHTML.slice(match.index + match[0].length);
      const close = new RegExp(`</${match[1]}>`, 'i').exec(textAfter);
      if (close) child.textContent = textAfter.slice(0, close.index).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  get innerHTML() { return this._innerHTML; }
  set textContent(value) { this._textContent = String(value ?? ''); this._innerHTML = this._textContent; }
  get textContent() { return this._textContent || this._innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'id') this.ownerDocument.registerElement(this, String(value)); }
  getAttribute(name) { return this.attributes[name] || null; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); child.parentNode = null; return child; }
  insertBefore(child, ref) { child.parentNode = this; const i = this.children.indexOf(ref); if (i < 0) this.children.unshift(child); else this.children.splice(i, 0, child); return child; }
  addEventListener(type, handler) { (this.eventListeners[type] ||= []).push(handler); }
  dispatchEvent(event) { for (const h of this.eventListeners[event.type] || []) h.call(this, event); }
  click() { if (typeof this.onclick === 'function') this.onclick({ target: this, preventDefault(){} }); this.dispatchEvent({ type: 'click', target: this, preventDefault(){} }); }
  querySelector(selector) { return this.ownerDocument.querySelector(selector); }
  querySelectorAll(selector) { return this.ownerDocument.querySelectorAll(selector); }
  focus() {}
  select() {}
}

class TestDocument {
  constructor() {
    this.elements = new Map();
    this.eventListeners = {};
    this.readyState = 'loading';
    this.body = this.ensureElement('body', 'body');
  }
  ensureElement(id, tagName = 'div') {
    if (!this.elements.has(id)) this.elements.set(id, new TestElement(this, tagName, id));
    return this.elements.get(id);
  }
  registerElement(el, id) { el.id = id; this.elements.set(id, el); }
  getElementById(id) { return this.elements.get(String(id)) || null; }
  createElement(tagName) { return new TestElement(this, tagName); }
  addEventListener(type, handler) { (this.eventListeners[type] ||= []).push(handler); }
  dispatchDOMContentLoaded() { this.readyState = 'complete'; for (const h of this.eventListeners.DOMContentLoaded || []) h({ type: 'DOMContentLoaded' }); }
  querySelector(selector) {
    if (!selector) return null;
    if (selector.startsWith('#')) return this.getElementById(selector.slice(1));
    if (selector === 'body') return this.body;
    return null;
  }
  querySelectorAll(selector) { const found = this.querySelector(selector); return found ? [found] : []; }
  execCommand() { return true; }
}

function scoped(key) { return `jkhdb::${OWNER}::${key}`; }
function globalScoped(key) { return `jkhdb::GLOBAL::${key}`; }

function baseDb() {
  return {
    orgName: 'Acceptance Org', orgInn: '0000000000', chairman: 'Tester',
    premises: {
      'P-9001': { regnum: 'P-9001', city: 'Тест', street: 'Тестовая', house: '1', flat: '1', square: 10, createdAt: '2025-01-01' }
    },
    links: [{ abonentId: ABONENT_ID, regnum: 'P-9001', dateFrom: '2025-01-01', dateTo: '' }],
    premiseEvents: [],
    abonents: {
      [ABONENT_ID]: {
        id: ABONENT_ID, uid: UID, fio: 'ТЕСТОВЫЙ АБОНЕНТ', fam: 'ТЕСТОВЫЙ', name: 'АБОНЕНТ', otch: '',
        regnum: 'P-9001', premiseRegnum: 'P-9001', city: 'Тест', street: 'Тестовая', house: '1', flat: '1',
        square: 10, rooms: '', share: '', calcStartDate: '2025-01-01', calcEndDate: '', dateFrom: '2025-01-01', premiseCreatedAt: '2025-01-01'
      }
    }
  };
}

function seedStorage(localStorage, { periodFrom = '2025-01-01', periodTo = '2025-03-31', activePeriod = true, ledgerRows = [], withTariffs = true } = {}) {
  localStorage.clear();
  localStorage.setItem('auth_session_v1', JSON.stringify({ userId: OWNER, role: 'user', email: 'acceptance@example.test', createdAt: Date.now(), expiresAt: 0 }));
  localStorage.setItem(scoped('abonents_db_v1'), JSON.stringify(baseDb()));
  localStorage.setItem(scoped(`payments_${UID}`), JSON.stringify(ledgerRows));
  localStorage.setItem(scoped(`calc_period_${UID}`), JSON.stringify({ from: periodFrom, to: periodTo }));
  localStorage.setItem(scoped(`calc_period_active_${UID}`), activePeriod ? '1' : '0');
  localStorage.setItem(scoped('payment_sources_v1'), JSON.stringify(['Acceptance']));
  if (withTariffs) localStorage.setItem(scoped(`tariffs_${OWNER}`), JSON.stringify([{ id: 'acceptance-per-m2', active: true, type: 'per_m2', rates: [{ from: '2025-01-01', value: 20 }] }]));
  localStorage.setItem(globalScoped('refinancing_rates_normal_v1'), JSON.stringify([{ from: '01.01.2025', rate: '11' }]));
  localStorage.setItem(globalScoped('refinancing_rates_moratorium_v1'), JSON.stringify([{ from: '01.01.2025', rate: '0' }]));
}

function makeContext(url = `file://${path.join(WEB, 'abonent_card.html')}?abonent=${ABONENT_ID}`) {
  const document = new TestDocument();
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const logs = [];
  const alerts = [];
  const context = {
    console: {
      log: (...args) => logs.push(['log', ...args]),
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
      debug: (...args) => logs.push(['debug', ...args])
    },
    window: null,
    document,
    localStorage,
    sessionStorage,
    Storage: MemoryStorage,
    location: new URL(url),
    navigator: { clipboard: { writeText: async () => {} } },
    alert: (msg) => alerts.push(String(msg)),
    confirm: () => true,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    URL,
    Date,
    Math,
    JSON,
    Promise,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
    fetch: async () => ({ ok: false, status: 404, text: async () => '{}' })
  };
  context.window = context;
  context.globalThis = context;
  return { context: vm.createContext(context), document, localStorage, sessionStorage, logs, alerts };
}

function runScript(ctx, relativePath) {
  const filename = path.join(WEB, relativePath);
  vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx, { filename });
}

function loadCore(ctx) {
  runScript(ctx, 'auth.js');
  runScript(ctx, 'storage.js');
  runScript(ctx, 'constants.js');
  runScript(ctx, 'data.js');
  runScript(ctx, 'calc_engine.js');
  runScript(ctx, 'autoaccrual_engine.js');
}

function createCardDom(document) {
  const ids = [
    'abonentCalcSummaryStatus', 'calcSummaryDebugBody', 'calcSummaryDebugPanel', 'paymentTableBody',
    'calcFrom', 'calcTo', 'calcRunBtn', 'calcReportsBtn', 'calcResetBtn', 'clearBrokenExcludesBtn',
    'abonentTitle', 'abonentInfoBody', 'moratoriumToggle'
  ];
  for (const id of ids) document.ensureElement(id, id === 'paymentTableBody' ? 'tbody' : 'div');
  const tableParent = document.ensureElement('paymentTableParent', 'div');
  tableParent.appendChild(document.getElementById('paymentTableBody'));
}

function loadCardInlineScripts(ctx) {
  const html = fs.readFileSync(path.join(WEB, 'abonent_card.html'), 'utf8');
  const scripts = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)).map((m) => m[1]).filter((code) => code.trim());
  for (const code of scripts) {
    if (code.includes('renderLayout()') || code.includes('closeLayout()')) continue;
    vm.runInContext(code, ctx, { filename: path.join(WEB, 'abonent_card.html') });
  }
}

function loadCardApp(options = {}) {
  const env = makeContext(options.url);
  seedStorage(env.localStorage, options.seed || {});
  createCardDom(env.document);
  loadCore(env.context);
  loadCardInlineScripts(env.context);
  return env;
}

function recalcStartLogCount(logs) {
  return logs.filter((entry) => entry.some((item) => typeof item === 'string' && item.includes('[abonent-card-recalc][start]'))).length;
}

function summaryRaw(localStorage) { return localStorage.getItem(scoped(`calc_summary_${UID}`)); }
function dirtyRaw(localStorage) { return localStorage.getItem(scoped(`calc_dirty_${UID}`)); }
function ledgerRows(localStorage) { return JSON.parse(localStorage.getItem(scoped(`payments_${UID}`)) || '[]'); }

async function clickInlineButton(ctx, buttonText) {
  const fn = buttonText === 'Подготовить и пересчитать'
    ? 'prepareAndRecalculateAbonentCalcSummaryFromCard'
    : buttonText === 'Подготовить начисления'
      ? 'prepareAbonentPeriodAccrualsFromCard'
      : 'recalculateAbonentCalcSummaryFromCard';
  assert.equal(typeof ctx[fn], 'function', `${fn} is available`);
  await ctx[fn]();
}

test('1. Opening index/card does not run recalculation', () => {
  const indexEnv = makeContext(`file://${path.join(WEB, 'index.html')}`);
  seedStorage(indexEnv.localStorage);
  loadCore(indexEnv.context);
  assert.equal(recalcStartLogCount(indexEnv.logs), 0);
  assert.equal(summaryRaw(indexEnv.localStorage), null);

  const cardEnv = loadCardApp();
  cardEnv.context.renderAbonentCalcSummaryStatus();
  assert.equal(recalcStartLogCount(cardEnv.logs), 0);
  assert.equal(summaryRaw(cardEnv.localStorage), null);
});

test('2. Missing summary renders “Требуется пересчёт”', () => {
  const env = loadCardApp();
  env.context.renderAbonentCalcSummaryStatus();
  assert.match(env.document.getElementById('abonentCalcSummaryStatus').textContent, /Требуется пересчёт/);
});

test('3. No accruals requires “Подготовить начисления” after recalc attempt', async () => {
  const env = loadCardApp();
  await env.context.recalculateAbonentCalcSummaryFromCard();
  const text = env.document.getElementById('abonentCalcSummaryStatus').textContent;
  assert.match(text, /Требуется пересчёт/);
  assert.match(text, /Подготовить начисления/);
});

test('4. “Подготовить и пересчитать” creates a fresh summary', async () => {
  const env = loadCardApp();
  await env.context.recalculateAbonentCalcSummaryFromCard();
  await clickInlineButton(env.context, 'Подготовить и пересчитать');
  const state = env.context.Data.readCalcSummary(ABONENT_ID);
  assert.equal(state.status, 'fresh');
  assert.equal(state.summary.periodFrom, '2025-01-01');
  assert.equal(state.summary.periodTo, '2025-03-31');
  assert.match(env.document.getElementById('abonentCalcSummaryStatus').textContent, /Актуальные итоги/);
});

test('5. Changing selected period makes old summary not fresh', async () => {
  const env = loadCardApp();
  await clickInlineButton(env.context, 'Подготовить и пересчитать');
  assert.equal(env.context.Data.readCalcSummary(ABONENT_ID).status, 'fresh');
  env.localStorage.setItem(scoped(`calc_period_${UID}`), JSON.stringify({ from: '2025-02-01', to: '2025-03-31' }));
  env.context.Data.markCalcDirty(ABONENT_ID, 'calc_period_changed');
  const state = env.context.Data.readCalcSummary(ABONENT_ID);
  assert.notEqual(state.status, 'fresh');
  assert.match(String(state.reason), /DIRTY|dirty|calc_period_changed|period/i);
});

test('6. Changing a payment marks calc summary dirty', async () => {
  const env = loadCardApp();
  await clickInlineButton(env.context, 'Подготовить и пересчитать');
  assert.equal(env.context.Data.readCalcSummary(ABONENT_ID).status, 'fresh');
  const rows = ledgerRows(env.localStorage);
  rows.push({ id: 999, year: '2025', month: '02', accrued: 0, paid: 15, paid_date: '15.02.2025', source: 'Acceptance', payment_period: '' });
  env.context.Data.writePaymentLedger(ABONENT_ID, rows, { dirtyReason: 'payments_changed' });
  assert.match(dirtyRaw(env.localStorage), /payments_changed/);
  assert.equal(env.context.Data.readCalcSummary(ABONENT_ID).status, 'dirty');
});

test('7. Debug panel shows the reason', async () => {
  const env = loadCardApp();
  await clickInlineButton(env.context, 'Подготовить и пересчитать');
  env.context.Data.markCalcDirty(ABONENT_ID, 'payments_changed');
  env.context.renderCalcSummaryDebugPanel();
  const text = env.document.getElementById('calcSummaryDebugBody').textContent;
  assert.match(text, /Reason/);
  assert.match(text, /dirty|payments_changed/i);
});

test('8. Three-month period does not calculate the full history', async () => {
  const env = loadCardApp({ seed: { ledgerRows: [
    { id: 1, year: '2024', month: '12', accrued: 500, paid: 0, paid_date: '', source: 'Acceptance', payment_period: '' }
  ] } });
  await clickInlineButton(env.context, 'Подготовить и пересчитать');
  const state = env.context.Data.readCalcSummary(ABONENT_ID);
  assert.equal(state.status, 'fresh');
  assert.equal(state.summary.periodFrom, '2025-01-01');
  assert.equal(state.summary.periodTo, '2025-03-31');
  assert.equal(state.summary.rowsInPeriod, 3);
  assert.ok(state.summary.rowsTotal >= 4, 'fixture contains rows outside the selected period');
  assert.equal(state.summary.accrued, 600);
});


test('9. History 200 months recalculates only selected 3 months plus one checkpoint', async () => {
  const rows = [];
  let y = 2025;
  let m = 1;
  for (let i = 0; i < 200; i += 1) {
    const row = {
      id: i + 1,
      year: String(y),
      month: String(m).padStart(2, '0'),
      accrued: 100,
      paid: 0,
      paid_date: '',
      source: 'Acceptance',
      payment_period: ''
    };
    if (i === 196) {
      row.pay_main = 19700;
      row.pay_penalty = 0;
      row.total = 19700;
      row.total_debt = 19700;
    }
    rows.push(row);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }

  const env = loadCardApp({ seed: {
    periodFrom: '2041-06-01',
    periodTo: '2041-08-31',
    activePeriod: true,
    ledgerRows: rows
  } });

  const db = JSON.parse(env.localStorage.getItem(scoped('abonents_db_v1')));
  db.links[0].dateTo = '2041-08-31';
  db.abonents[ABONENT_ID].calcEndDate = '2041-08-31';
  db.abonents[ABONENT_ID].dateTo = '2041-08-31';
  env.localStorage.setItem(scoped('abonents_db_v1'), JSON.stringify(db));
  env.context.AbonentsDB = db;

  const originalCalc = env.context.JKHCalcEngine.calcTotalsAsOfAdjusted;
  let calcCalls = 0;
  env.context.JKHCalcEngine.calcTotalsAsOfAdjusted = function () {
    calcCalls += 1;
    return originalCalc.apply(this, arguments);
  };

  const res = await env.context.Data.recalculateAbonentCard(ABONENT_ID, { source: 'acceptance_200_month_checkpoint' });
  assert.equal(res.ok, true);
  assert.equal(calcCalls, 4);

  const savedRows = ledgerRows(env.localStorage);
  assert.equal(savedRows.length, 200);
  assert.equal(savedRows[0].pay_main, undefined);
  assert.equal(savedRows[196].pay_main, 19700);
  assert.equal(savedRows[197].pay_main, undefined);
  assert.equal(savedRows[198].pay_main, undefined);
  assert.equal(savedRows[199].pay_main, undefined);
  assert.equal(env.localStorage.getItem(scoped('jkh_financial_events_v1')), null);

  const fastLog = env.logs.find((entry) => entry.some((item) => typeof item === 'string' && item.includes('[abonent-card-recalc][period-fast-path]')));
  const fastPayload = fastLog && fastLog.find((item) => item && typeof item === 'object' && !Array.isArray(item));
  assert.equal(fastPayload.rowsTotal, 200);
  assert.equal(fastPayload.rowsInPeriod, 3);
  assert.equal(fastPayload.skippedRows, 197);
});

test('10. Empty report period opens reports for full responsibility period', () => {
  const env = loadCardApp({ seed: { activePeriod: false } });
  const db = baseDb();
  db.links[0].dateTo = '2025-05-31';
  db.abonents[ABONENT_ID].calcEndDate = '';
  db.abonents[ABONENT_ID].dateTo = '2025-05-31';
  env.localStorage.setItem(scoped('abonents_db_v1'), JSON.stringify(db));
  env.localStorage.removeItem(scoped(`calc_period_${UID}`));
  env.localStorage.removeItem(scoped(`calc_period_active_${UID}`));
  env.context.AbonentsDB = db;
  env.context.location = { search: `?abonent=${ABONENT_ID}`, href: `file://${path.join(WEB, 'abonent_card.html')}?abonent=${ABONENT_ID}` };
  env.document.getElementById('calcFrom').value = '';
  env.document.getElementById('calcTo').value = '';
  env.context.bindCalcButtons();

  env.document.getElementById('calcReportsBtn').click();

  assert.equal(env.document.getElementById('calcFrom').value, '2025-01-01');
  assert.equal(env.document.getElementById('calcTo').value, '2025-05-31');
  assert.match(String(env.context.location.href), /reports\.html\?abonent=9001/);
  assert.match(String(env.context.location.href), /from=2025-01-01/);
  assert.match(String(env.context.location.href), /to=2025-05-31/);
  assert.equal(env.localStorage.getItem(scoped(`calc_period_active_${UID}`)), null);
});

test('11. Selected March-May period uses previous calculated row as checkpoint', async () => {
  const env = loadCardApp({ seed: {
    periodFrom: '2025-03-01',
    periodTo: '2025-05-31',
    activePeriod: true,
    ledgerRows: [
      { id: 1, year: '2025', month: '02', accrued: 10000, paid: 0, paid_date: '', source: 'Acceptance', payment_period: '', pay_main: 10000, pay_penalty: 0, total: 10000, total_debt: 10000 },
      { id: 2, year: '2025', month: '03', accrued: 100, paid: 0, paid_date: '', source: 'Acceptance', payment_period: '' },
      { id: 3, year: '2025', month: '04', accrued: 100, paid: 0, paid_date: '', source: 'Acceptance', payment_period: '' },
      { id: 4, year: '2025', month: '05', accrued: 100, paid: 0, paid_date: '', source: 'Acceptance', payment_period: '' }
    ]
  } });

  const res = await env.context.Data.recalculateAbonentCard(ABONENT_ID, { source: 'acceptance_selected_period' });
  assert.equal(res.ok, true);
  const state = env.context.Data.readCalcSummary(ABONENT_ID);
  assert.equal(state.status, 'fresh');
  assert.equal(state.summary.periodMode, 'selected_calc_period');
  assert.equal(state.summary.periodFrom, '2025-03-01');
  assert.equal(state.summary.periodTo, '2025-05-31');
  assert.equal(state.summary.rowsInPeriod, 3);
  assert.equal(state.summary.accrued, 300);
  assert.equal(state.summary.principal, 10300);
  assert.equal(state.summary.total, 10300.66);
  const savedRows = ledgerRows(env.localStorage);
  assert.equal(savedRows[1].pay_main, undefined);
  assert.equal(savedRows[2].pay_main, undefined);
  assert.equal(savedRows[3].pay_main, undefined);
  assert.equal(env.localStorage.getItem(scoped('jkh_financial_events_v1')), null);
  assert.equal(env.logs.filter((entry) => entry.some((item) => typeof item === 'string' && item.includes('[abonent-card-recalc][checkpoint]'))).length, 1);
  assert.equal(env.logs.filter((entry) => entry.some((item) => typeof item === 'string' && item.includes('[abonent-card-recalc][period-fast-path]'))).length, 1);
  assert.equal(env.logs.filter((entry) => entry.some((item) => typeof item === 'string' && item.includes('[abonent-card-recalc][ledger-write-skip]'))).length, 1);
});

test('12. Reset with empty fields and no active period is a no-op', async () => {
  const env = loadCardApp({ seed: { activePeriod: false } });
  env.localStorage.removeItem(scoped(`calc_period_${UID}`));
  env.localStorage.removeItem(scoped(`calc_period_active_${UID}`));
  env.document.getElementById('calcFrom').value = '';
  env.document.getElementById('calcTo').value = '';
  env.context.bindCalcButtons();

  env.document.getElementById('calcResetBtn').click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(recalcStartLogCount(env.logs), 0);
  assert.equal(env.localStorage.getItem(scoped(`calc_period_${UID}`)), null);
  assert.equal(env.localStorage.getItem(scoped(`calc_period_active_${UID}`)), null);
  assert.equal(env.localStorage.getItem(scoped('jkh_financial_events_v1')), null);
});

test('13. Reset removes active selected period without ledger write', async () => {
  const env = loadCardApp({ seed: {
    periodFrom: '2025-03-01',
    periodTo: '2025-05-31',
    activePeriod: true,
    ledgerRows: [
      { id: 1, year: '2025', month: '02', accrued: 10000, paid: 0, paid_date: '', source: 'Acceptance', payment_period: '', pay_main: 10000, pay_penalty: 0, total: 10000, total_debt: 10000 },
      { id: 2, year: '2025', month: '03', accrued: 100, paid: 0, paid_date: '', source: 'Acceptance', payment_period: '' }
    ]
  } });
  const beforeLedger = env.localStorage.getItem(scoped(`payments_${UID}`));
  env.context.loadCalcPeriodUI();
  env.context.bindCalcButtons();

  env.document.getElementById('calcResetBtn').click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(recalcStartLogCount(env.logs), 0);
  assert.equal(env.localStorage.getItem(scoped(`calc_period_${UID}`)), null);
  assert.equal(env.localStorage.getItem(scoped(`calc_period_active_${UID}`)), null);
  assert.equal(env.localStorage.getItem(scoped(`payments_${UID}`)), beforeLedger);
  assert.equal(env.localStorage.getItem(scoped('jkh_financial_events_v1')), null);
});
