const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.resolve(__dirname, "..", "web", "offline_origin_diag.js"), "utf8");
const listeners = {};
const windowStub = {
  JKH_UI_STATE: {
    data: { status: "loading", source: "server" },
    server: { status: "online" }
  },
  AbonentsDB: { abonents: { one: {} }, premises: {}, links: [] },
  fetch: () => Promise.resolve({ ok: true, status: 200 }),
  addEventListener: (name, fn) => { listeners[name] = fn; }
};
const context = { window: windowStub, console, Date, Object, Math, Promise, String, Number, Boolean, RegExp, Error };
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "offline_origin_diag.js" });

windowStub.__offlineOriginRecordTransition({
  module: "storage",
  setter: "storage._setUIState",
  stack: "Error\n at _setUIState (storage.js:750:1)\n at _loadFromServerServerFirst (storage.js:2100:1)",
  reason: "Failed to fetch",
  previousDataStatus: "loading",
  newDataStatus: "offline",
  previousDataSource: "server",
  newDataSource: "server",
  previousServerStatus: "online",
  newServerStatus: "offline"
});
windowStub.JKH_UI_STATE.data.status = "offline";
windowStub.JKH_UI_STATE.server.status = "offline";
windowStub.__offlineOriginRecordEndpoint({ endpoint: "/api/card_snapshot/test", method: "GET", ok: true, status: 200 });
windowStub.__offlineOriginMarkPassiveRestore({ snapshotFresh: true, backendSucceeded: true, restoredRows: 230, rowsRestoreOk: true });
const report = windowStub.__offlineOriginReportBeforeManualRecalc();

assert.strictEqual(report.allStatusChangingWritesSincePageStart.length, 1);
assert.strictEqual(report.firstTransitionToOffline.module, "storage");
assert.strictEqual(report.lastTransitionToOffline.module, "storage");
assert.strictEqual(report.backendSnapshotGetLaterSucceeded, true);
assert.strictEqual(report.runtimeRowsRestoredAfterOffline, true);
assert.strictEqual(report.laterReadyOrEmptyTransitionOccurred, false);
assert.strictEqual(report.finalUiStatus, "offline");
assert.strictEqual(report.exactOriginClassification, "PASSIVE_RESTORE_NO_READY_PROMOTION");

windowStub.__offlineOriginRecordTransition({
  module: "storage",
  setter: "storage._setUIState",
  stack: "Error\n at _setUIState (storage.js:750:1)\n at _loadFromServerServerFirst (storage.js:2100:1)",
  reason: "recovered",
  previousDataStatus: "offline",
  newDataStatus: "ready",
  previousDataSource: "server",
  newDataSource: "server",
  previousServerStatus: "offline",
  newServerStatus: "online"
});
windowStub.__offlineOriginMarkLocalStorageError({ name: "QuotaExceededError", message: "Quota exceeded" }, "storage._lsSetDirect");
windowStub.__offlineOriginRecordTransition({
  module: "storage",
  setter: "storage._setUIState",
  stack: "Error\n at _setUIState (storage.js:750:1)\n at _loadFromServerServerFirst (storage.js:2100:1)",
  reason: "Quota exceeded",
  previousDataStatus: "ready",
  newDataStatus: "offline",
  previousDataSource: "server",
  newDataSource: "server",
  previousServerStatus: "online",
  newServerStatus: "offline"
});
windowStub.JKH_UI_STATE.data.status = "offline";
windowStub.JKH_UI_STATE.server.status = "offline";
const quotaReport = windowStub.__offlineOriginReportBeforeManualRecalc();
assert.strictEqual(quotaReport.exactOriginClassification, "LOCAL_CACHE_ERROR_MISCLASSIFIED");
assert.strictEqual(quotaReport.lastTransitionToOffline.localStorageErrorActive, true);
assert.strictEqual(quotaReport.lastTransitionToOffline.networkErrorActive, false);

console.log("offline origin diagnostic test passed");
