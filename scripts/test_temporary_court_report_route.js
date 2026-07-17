const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

async function main() {
const root = path.resolve(__dirname, "..");
const cardSource = fs.readFileSync(path.join(root, "web", "abonent_card.html"), "utf8");
const reportsSource = fs.readFileSync(path.join(root, "web", "reports.html"), "utf8");
const spravkaSource = fs.readFileSync(path.join(root, "web", "spravka_sud.js"), "utf8");

function balancedBlock(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.notStrictEqual(markerIndex, -1, `production marker not found: ${marker}`);
  const start = source.indexOf("{", markerIndex + marker.length - 1);
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(start + 1, i);
  }
  throw new Error(`unterminated production block: ${marker}`);
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(String(key)) ? values.get(String(key)) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
    has: (key) => values.has(String(key))
  };
}

function fnFromBody(body, context, asyncFn) {
  const source = `(${asyncFn ? "async " : ""}function(){${body}})`;
  return vm.runInNewContext(source, context);
}

const uid = "uid_mqmevxsl_wlr604";
const abonentId = "1009";
const from = "2025-02-01";
const to = "2026-05-03";
const rows = [{ id: "row-1", year: 2025, month: 2, accrued: 100, paid: 0 }];
const rowsById = { "row-1": rows[0] };
const storage = memoryStorage();
const runtime = {
  periodActive: true,
  period: { from, to },
  ledgerVersion: "",
  runtimeSignature: "runtime-signature-1009",
  rows,
  rowsById
};

const cardContext = {
  window: { __getPaymentTableComputedRowsSnapshot: () => runtime },
  sessionStorage: storage,
  console: { log: () => {}, warn: () => {} },
  getCalcPeriodStorageMeta: () => ({ resolvedUid: uid, ownerId: "owner", storageKey: "calc", activeStorageKey: "active" }),
  currentAbonentId: abonentId,
  from,
  to,
  String,
  Object,
  Array
};

// Execute the exact state-persistence block that runs after successful temporary calculation.
const successAnchor = cardSource.indexOf('__saveTemporaryPeriodState({ from: from, to: to }, { abonentId: currentAbonentId, source: "temporary-recalc-done"');
assert.notStrictEqual(successAnchor, -1, "temporary success anchor not found");
const runtimeStateAnchor = cardSource.indexOf("                    const runtime = typeof window.__getPaymentTableComputedRowsSnapshot", successAnchor);
assert.notStrictEqual(runtimeStateAnchor, -1, "temporary runtime state anchor not found");
const stateStart = cardSource.lastIndexOf("                try {", runtimeStateAnchor);
const stateEndMarker = "                } catch(eTemporaryReportState) { delete window.__JKH_TEMPORARY_PERIOD_REPORT_STATE; console.warn(\"[spravka][temporary-payload-not-ready]\", { reason: \"TEMPORARY_RUNTIME_STATE_READ_FAILED\" }); }";
const stateEnd = cardSource.indexOf(stateEndMarker, successAnchor);
assert.notStrictEqual(stateEnd, -1, "temporary state block end not found");
const stateBody = cardSource.slice(stateStart, stateEnd + stateEndMarker.length);
fnFromBody(stateBody, cardContext, false)();

const state = cardContext.window.__JKH_TEMPORARY_PERIOD_REPORT_STATE;
assert.deepStrictEqual(JSON.parse(JSON.stringify(state)), {
  mode: "temporary_court_period", uid, abonentId, from, to,
  ledgerVersion: "temporary:runtime-signature-1009", runtimeSignature: "runtime-signature-1009"
});
assert.strictEqual(storage.has(`temporary_spravka_payload_${uid}`), false, "stale payload must be removed before a new bridge is made");

const elements = {
  calcFrom: { value: from }, calcTo: { value: to }, calcRunHint: { textContent: "" }
};
const cardReportsContext = Object.assign({}, cardContext, {
  document: { getElementById: (id) => elements[id] || null },
  fromEl: elements.calcFrom,
  toEl: elements.calcTo,
  getAbonentIdFromURL: () => abonentId,
  buildDefaultReportPeriodForCard: () => ({ ok: true, from, to }),
  isValidPeriod: (a, b) => a === from && b === to,
  __saveTemporaryPeriodState: () => {},
  __logCardPeriodSaved: () => {},
  getReportPeriodStorageKey: () => "report_period",
  JKHStore: { scopePrefixFor: () => "jkhdb::LAB::owner::" },
  location: { search: "?db=jkhdb%3A%3ALAB%3A%3Aowner%3A%3Aabonents_db_v1", href: "" },
  encodeURIComponent,
  alert: (message) => { throw new Error(message); },
  JSON,
  Math
});
cardReportsContext.window.JKHStore = cardReportsContext.JKHStore;
const cardReportsBody = balancedBlock(cardSource, 'repBtn.addEventListener("click", async () => {');
await fnFromBody(cardReportsBody, cardReportsContext, true)();
assert.match(cardReportsContext.location.href, /reports\.html\?/);
assert.match(cardReportsContext.location.href, /temporary_court_period=1/);
assert.strictEqual(storage.has(`temporary_spravka_payload_${uid}`), true, "card must create the one-time payload before navigation");

const reportElements = { repFrom: { value: from }, repTo: { value: to } };
const reportsContext = {
  document: { getElementById: (id) => reportElements[id] || null },
  getAbonentIdFromURL: () => abonentId,
  requireValidReportPeriod: (a, b) => ({ ok: a === from && b === to, from: a, to: b }),
  getReportsUrlParams: () => new URLSearchParams(`?abonent=${abonentId}&uid=${uid}&temporary_court_period=1`),
  showMissingAbonentError: () => { throw new Error("unexpected missing abonent"); },
  console: { log: () => {} }, location: { href: "" }, encodeURIComponent, URLSearchParams
};
const appendSource = balancedBlock(reportsSource, "function appendReportsContextToHref(href){");
vm.runInNewContext(`function appendReportsContextToHref(href){${appendSource}}; this.appendReportsContextToHref = appendReportsContextToHref;`, reportsContext);
reportsContext.appendReportsContextToHref = reportsContext.appendReportsContextToHref;
const reportsBody = balancedBlock(reportsSource, 'document.getElementById("openReport01").addEventListener("click", () => {');
fnFromBody(reportsBody, reportsContext, false)();
assert.match(reportsContext.location.href, /spravka_sud\.html\?/);
assert.match(reportsContext.location.href, /temporary_court_period=1/);

const consumeSource = balancedBlock(spravkaSource, "function consumeTemporarySpravkaPayload(ctx, uid, period){");
const consumeContext = { sessionStorage: storage, console: { warn: () => {} }, JSON, String, Math, Object, Array };
vm.runInNewContext(`function consumeTemporarySpravkaPayload(ctx, uid, period){${consumeSource}}; this.consume = consumeTemporarySpravkaPayload;`, consumeContext);
const consumed = consumeContext.consume({ abonentId }, uid, { from, to });
assert.strictEqual(consumed.ok, true, "spravka must accept the payload passed through both click handlers");
assert.deepStrictEqual(JSON.parse(JSON.stringify(consumed.payload.rows)), rows);
assert.strictEqual(storage.has(`temporary_spravka_payload_${uid}`), false, "payload must be consumed exactly once");

console.log("temporary court report route test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
