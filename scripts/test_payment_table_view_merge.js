const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repoRoot = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(repoRoot, "web", "payment_table.js"), "utf8");

const documentStub = {
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: () => ({ appendChild: () => {}, style: {}, dataset: {}, classList: { add: () => {} } }),
  createDocumentFragment: () => ({ appendChild: () => {} }),
  head: { appendChild: () => {} }
};

const windowStub = {
  __JKH_PAYMENT_TABLE_TEST_HOOKS: true,
  JKH_UI_STATE: { data: { status: "loading" } },
  location: { search: "?abonent=test-uid" },
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout,
  clearTimeout
};

const context = {
  window: windowStub,
  document: documentStub,
  console,
  setTimeout,
  clearTimeout,
  URLSearchParams,
  performance: { now: () => 0 },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
};
context.globalThis = context;
context.window.window = context.window;
context.window.document = context.document;

vm.runInNewContext(source, context, { filename: "payment_table.js" });

assert(context.window.__paymentTableTestHooks, "payment table test hooks were not installed");
const { mergeComputedRowsIntoViewRows } = context.window.__paymentTableTestHooks;
assert.strictEqual(typeof mergeComputedRowsIntoViewRows, "function");
const { materializeCanonicalSnapshotRowsForEmptyLedger } = context.window.__paymentTableTestHooks;
assert.strictEqual(typeof materializeCanonicalSnapshotRowsForEmptyLedger, "function");
const { recordPaymentRenderRegression } = context.window.__paymentTableTestHooks;
assert.strictEqual(typeof recordPaymentRenderRegression, "function");
recordPaymentRenderRegression("snapshot-restore-start", { snapshotRowsCount: 230, ledgerRowsCount: 0, reason: "test" });
recordPaymentRenderRegression("snapshot-restore-rendered", { snapshotRowsCount: 230, rowCount: 230, reason: "OK" });
recordPaymentRenderRegression("render", { rowCount: 0, ledgerRowsCount: 0, reason: "late-test-load", caller: "test-late-caller" });
const renderRegression = context.window.__getPaymentRenderRegressionSequence();
assert.strictEqual(renderRegression.firstZeroReported, true);
assert.strictEqual(renderRegression.events[renderRegression.events.length - 1].caller, "test-late-caller");
const { setPaymentTableCalculatedRenderState, applyFreshCalculatedRowsForRender } = context.window.__paymentTableTestHooks;
assert.strictEqual(typeof setPaymentTableCalculatedRenderState, "function");
assert.strictEqual(typeof applyFreshCalculatedRowsForRender, "function");
const {
  readinessRegressionState,
  readinessRegressionReadable,
  logReadinessRegressionAfterPassiveRestore,
  logReadinessRegressionBeforeManualRecalc,
  startReadinessWriteSequence,
  finishReadinessWriteSequence,
  manualRecalcReadinessEvaluation,
  serverFirstReadableState,
  beginReadableDiagnostic,
  finishReadableDiagnostic
} = context.window.__paymentTableTestHooks;
assert.strictEqual(typeof readinessRegressionState, "function");
assert.strictEqual(typeof readinessRegressionReadable, "function");
assert.strictEqual(typeof startReadinessWriteSequence, "function");
assert.strictEqual(typeof finishReadinessWriteSequence, "function");
assert.strictEqual(typeof manualRecalcReadinessEvaluation, "function");
assert.strictEqual(typeof serverFirstReadableState, "function");
assert.strictEqual(typeof beginReadableDiagnostic, "function");
assert.strictEqual(typeof finishReadableDiagnostic, "function");

startReadinessWriteSequence("test-run-id");
context.window.__recordReadinessWrite({
  previousUiStatus: "ready",
  newUiStatus: "offline",
  previousServerStatus: "online",
  newServerStatus: "offline",
  caller: "loadFromServer",
  function: "storage._setUIState",
  line: "storage.js:2075:9",
  reason: "network failed",
  stack: ["loadFromServer (storage.js:2075:9)"]
});
finishReadinessWriteSequence();
assert.strictEqual(context.window.__JKH_READINESS_WRITE_SEQUENCE.active, false);
assert.strictEqual(context.window.__JKH_READINESS_WRITE_SEQUENCE.writes.length, 1);
assert.strictEqual(context.window.__JKH_READINESS_WRITE_SEQUENCE.writes[0].runId, "test-run-id");
assert.strictEqual(context.window.__JKH_READINESS_WRITE_SEQUENCE.writes[0].newUiStatus, "offline");

context.window.JKH_UI_STATE = {
  server: { status: "online" },
  data: { status: "ready", source: "server" }
};
context.window.JKH_DATA_READY = false;
beginReadableDiagnostic("readable-test-run");
const readyReadable = serverFirstReadableState();
assert.strictEqual(readyReadable.ok, true);
assert.strictEqual(readyReadable.acceptedReason, "manual_recalc_data_ready_server_ready");
context.window.JKH_UI_STATE.data.status = "offline";
const offlineReadable = serverFirstReadableState();
assert.strictEqual(offlineReadable.ok, false);
assert.strictEqual(offlineReadable.uiStatus, "offline");
assert.strictEqual(offlineReadable.legacyDataReady, false);
finishReadableDiagnostic();
context.window.JKH_UI_STATE.data.status = "ready";
context.window.AbonentsDB = { abonents: { "test-uid": {} }, premises: {}, links: [] };
context.window.JKHStore = {
  getEnvType: () => "production",
  getRaw: () => "[{\"date\":\"2026-01-01\",\"rate\":21}]"
};
context.JKHStore = context.window.JKHStore;
const passiveReadiness = logReadinessRegressionAfterPassiveRestore(230);
assert.deepStrictEqual(JSON.parse(JSON.stringify(passiveReadiness)), {
  uiStatus: "ready",
  uiSource: "server",
  serverStatus: "online",
  runtimeHydrated: true,
  restoredRowsCount: 230,
  normalRateReadable: true,
  moratoriumRateReadable: true,
  envType: "production"
});
assert.strictEqual(readinessRegressionReadable(passiveReadiness), true);
const failedEvaluation = manualRecalcReadinessEvaluation(3, 250, {
  uiStatus: "offline"
}, {
  ok: false,
  readable: false,
  hasNormal: true,
  hasMoratorium: true,
  hydrated: true,
  envStable: true,
  uiStatus: "offline"
});
assert.strictEqual(failedEvaluation.iteration, 3);
assert.strictEqual(failedEvaluation.uiStatus, "offline");
assert.strictEqual(failedEvaluation.serverStatus, "online");
assert.strictEqual(failedEvaluation.restoredRowsCount, 230);
assert.strictEqual(failedEvaluation.failedCondition, "readable.ok === true");
assert.strictEqual(failedEvaluation.readyExpressionResult, false);
context.window.JKH_UI_STATE.data.status = "offline";
const manualReadiness = logReadinessRegressionBeforeManualRecalc("test", "before-wait");
assert.strictEqual(manualReadiness.uiStatus, "offline");
assert.strictEqual(manualReadiness.restoredRowsCount, 230);
assert.strictEqual(readinessRegressionReadable(manualReadiness), false);

const rawRows = [{
  id: "row-1",
  year: 2026,
  month: 1,
  accrued: 100,
  paid: 0,
  debt: 0,
  penalty: 0,
  total: ""
}];
const calculatedRowsById = {
  "row-1": {
    principalDebt: 123.45,
    penaltyDebt: 67.89,
    runningTotal: 191.34
  }
};

const merged = mergeComputedRowsIntoViewRows(rawRows, calculatedRowsById);
assert.notStrictEqual(merged[0], rawRows[0], "merge must not mutate the input view row");
assert.strictEqual(merged[0].accrued, 100, "raw ledger fields must be preserved");
assert.strictEqual(merged[0].debt, 123.45, "computed debt must override raw zero");
assert.strictEqual(merged[0].principalDebt, 123.45);
assert.strictEqual(merged[0].runningDebt, 123.45);
assert.strictEqual(merged[0].penalty, 67.89, "computed penalty must override raw zero");
assert.strictEqual(merged[0].penaltyDebt, 67.89);
assert.strictEqual(merged[0].runningPenalty, 67.89);
assert.strictEqual(merged[0].total, 191.34, "computed total must be rendered instead of empty raw value");
assert.strictEqual(merged[0].runningTotal, 191.34);

const freshRows = [{
  id: "fresh-row-id",
  year: 2026,
  month: 1,
  type: "accrual",
  accrued: 100,
  paid: 0
}];
const freshRowsById = {
  "fresh-row-id": {
    pay_main: 222,
    pay_penalty: 33,
    total: 255
  }
};
assert.strictEqual(setPaymentTableCalculatedRenderState(freshRows, freshRowsById, {
  uid: "test-uid",
  ledgerVersion: "old-ledger-version",
  runtimeSignature: "old-signature",
  periodActive: false
}), true);

const mismatchedView = [{
  id: "current-row-id",
  year: 2026,
  month: 1,
  type: "accrual",
  accrued: 100,
  paid: 0,
  debt: 0,
  penalty: 0,
  total: 0
}];
const relaxed = applyFreshCalculatedRowsForRender(mismatchedView, {
  ledgerVersion: "new-ledger-version",
  runtimeSignature: "new-signature",
  periodActive: false
});
assert.strictEqual(relaxed.applied, true, "fresh calculated rows must render despite id/signature mismatch");
assert.strictEqual(relaxed.mismatchReason, "relaxed_stable_fields");
assert.strictEqual(relaxed.fallbackAllowed, false);
assert.strictEqual(relaxed.matchedCount, 1);
assert.strictEqual(mismatchedView[0].debt, 222);
assert.strictEqual(mismatchedView[0].penalty, 33);
assert.strictEqual(mismatchedView[0].total, 255);

const lateRenderSnapshotRows = [{
  id: "snapshot-row-late-render",
  year: 2026,
  month: 2,
  type: "accrual",
  accrued: 100,
  paid: 0
}];
const lateRenderSnapshotRowsById = {
  "snapshot-row-late-render": { pay_main: 300, pay_penalty: 40, total: 340 }
};
assert.strictEqual(setPaymentTableCalculatedRenderState(lateRenderSnapshotRows, lateRenderSnapshotRowsById, {
  uid: "test-uid",
  ledgerVersion: "empty-ledger-version",
  runtimeSignature: "empty-ledger-signature",
  periodActive: false
}), true);
const emptyLateLoadView = [];
const preservedLateRender = applyFreshCalculatedRowsForRender(emptyLateLoadView, {
  ledgerVersion: "empty-ledger-version",
  runtimeSignature: "empty-ledger-signature",
  periodActive: false
});
assert.strictEqual(preservedLateRender.applied, true, "a late empty-ledger load must retain accepted snapshot rows");
assert.strictEqual(preservedLateRender.mismatchReason, "fresh_calculated_rows_empty_ledger");
assert.strictEqual(emptyLateLoadView.length, 1);
assert.strictEqual(emptyLateLoadView[0].id, "snapshot-row-late-render");
assert.strictEqual(emptyLateLoadView[0].total, 340);

const snapshotRows = Array.from({ length: 230 }, (_, index) => ({
  id: `snapshot-row-${index + 1}`,
  year: 2026 - Math.floor(index / 12),
  month: 12 - (index % 12),
  accrued: 100 + index,
  paid: index,
  paid_date: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
  source: "snapshot-source",
  note: `row-${index + 1}`
}));
const snapshotRowsById = Object.fromEntries(snapshotRows.map((row, index) => [row.id, {
  pay_main: 1000 + index,
  pay_penalty: 100 + index,
  total: 1100 + index
}]));
const canonicalSnapshot = {
  uid: "test-uid",
  summary_status: "fresh",
  snapshotMode: "full",
  periodActive: false,
  rows: snapshotRows,
  rowsById: snapshotRowsById
};
const materialized = materializeCanonicalSnapshotRowsForEmptyLedger(canonicalSnapshot, []);
assert.strictEqual(materialized.ok, true);
assert.strictEqual(materialized.rows.length, 230);
assert.strictEqual(Object.keys(materialized.rowsById).length, 230);
assert.strictEqual(materialized.rows[0].id, "snapshot-row-1");
assert.strictEqual(materialized.rows[0].debt, 1000);
assert.strictEqual(materialized.rows[0].penalty, 100);
assert.strictEqual(materialized.rows[0].total, 1100);
assert.strictEqual(materialized.rows[0].accrued, 100);
assert.strictEqual(materialized.rows[0].paid, 0);
assert.strictEqual(materialized.rows[0].source, "snapshot-source");
assert.strictEqual(materialized.rows[0].note, "row-1");

const existingLedger = [{ id: "ledger-row", accrued: 50 }];
const skippedExisting = materializeCanonicalSnapshotRowsForEmptyLedger(canonicalSnapshot, existingLedger);
assert.strictEqual(skippedExisting.ok, false);
assert.strictEqual(skippedExisting.reason, "EXISTING_LEDGER_USED");
assert.strictEqual(existingLedger.length, 1, "existing ledger must not be duplicated or mutated");

const temporarySnapshot = Object.assign({}, canonicalSnapshot, { snapshotMode: "period", periodActive: true });
const rejectedTemporary = materializeCanonicalSnapshotRowsForEmptyLedger(temporarySnapshot, []);
assert.strictEqual(rejectedTemporary.ok, false);
assert.strictEqual(rejectedTemporary.reason, "CARD_SNAPSHOT_PERIOD_NOT_ALLOWED");

const rejectedEmpty = materializeCanonicalSnapshotRowsForEmptyLedger(Object.assign({}, canonicalSnapshot, { rowsById: {} }), []);
assert.strictEqual(rejectedEmpty.ok, false);
assert.strictEqual(rejectedEmpty.reason, "CARD_SNAPSHOT_ROWS_MISSING");

const rejectedMissingStructure = materializeCanonicalSnapshotRowsForEmptyLedger(Object.assign({}, canonicalSnapshot, { rows: [] }), []);
assert.strictEqual(rejectedMissingStructure.ok, false);
assert.strictEqual(rejectedMissingStructure.reason, "CARD_SNAPSHOT_STRUCTURAL_ROWS_MISSING");

console.log("payment_table view merge test passed");
