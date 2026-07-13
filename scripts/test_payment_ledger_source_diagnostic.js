const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const KEY = "payments_uid_mqmevxsl_wlr604";
const dataPath = path.resolve(__dirname, "..", "web", "data.js");
const dataSource = fs.readFileSync(dataPath, "utf8");

function rows(count) {
  return JSON.stringify(Array.from({ length: count }, (_, index) => ({ id: index + 1 })));
}

function loadData({ overrideRaw, runtime, localRaw }) {
  const localValues = new Map();
  if (localRaw !== undefined) localValues.set(KEY, localRaw);
  const windowStub = {
    location: { protocol: "http:", search: "" },
    Auth: { getActiveDbOwnerId: () => "owner-test", isGuest: () => false },
    JKHBoot: { markReady: () => {} },
    JKHDataLoader: { readServerDumpRuntimeValue: () => runtime },
    JKHStore: { getOwnerId: () => "owner-test", getRaw: (key) => localValues.has(key) ? localValues.get(key) : null },
    addEventListener: () => {}
  };
  const context = {
    window: windowStub,
    document: { addEventListener: () => {} },
    console: { log: () => {}, warn: () => {}, error: () => {}, time: () => {}, timeEnd: () => {} },
    URLSearchParams,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: false, status: 404, text: async () => "" })
  };
  context.globalThis = context;
  context.JKHStore = windowStub.JKHStore;
  windowStub.window = windowStub;
  windowStub.document = context.document;
  const instrumented = dataSource.replace(
    "window.Data = Data;",
    "window.__testGetProjectRaw = _getProjectRaw; window.__testSetProjectRawRuntimeOverride = _setProjectRawRuntimeOverride; window.Data = Data;"
  );
  vm.runInNewContext(instrumented, context, { filename: "data.js" });
  if (overrideRaw !== undefined) windowStub.__testSetProjectRawRuntimeOverride(KEY, overrideRaw);
  return windowStub;
}

function previousBehavior({ overrideRaw, runtime, localRaw }) {
  if (overrideRaw !== undefined) return String(overrideRaw == null ? "" : overrideRaw);
  if (runtime && runtime.active === true) return runtime.present === true ? runtime.raw : null;
  return localRaw === undefined ? null : localRaw;
}

function verifyScenario(name, scenario, expectedWinner, expectedRows) {
  const windowStub = loadData(scenario);
  const actual = windowStub.__testGetProjectRaw(KEY);
  assert.strictEqual(actual, previousBehavior(scenario), name + ": return value must match pre-diagnostic behavior");
  const diagnostic = windowStub.JKH_getLastPaymentLedgerSourceDiagnostic();
  assert.ok(diagnostic, name + ": diagnostic must be available");
  assert.strictEqual(diagnostic.key, KEY);
  assert.strictEqual(diagnostic.winner, expectedWinner);
  assert.strictEqual(diagnostic.returnedRowsCount, expectedRows);
  const copy = windowStub.JKH_getLastPaymentLedgerSourceDiagnostic();
  copy.winner = "modified";
  assert.strictEqual(windowStub.JKH_getLastPaymentLedgerSourceDiagnostic().winner, expectedWinner, name + ": getter must return a copy");
}

verifyScenario("runtime override", {
  overrideRaw: rows(3),
  runtime: { active: true, present: true, raw: rows(2) },
  localRaw: rows(1)
}, "runtime_override", 3);

verifyScenario("server dump runtime", {
  runtime: { active: true, present: true, raw: rows(2) },
  localRaw: rows(1)
}, "server_dump_runtime", 2);

verifyScenario("local JKHStore", {
  runtime: { active: false, present: false, raw: null },
  localRaw: rows(1)
}, "local_jkhstore", 1);

verifyScenario("missing", {
  runtime: { active: false, present: false, raw: null }
}, "missing", 0);

console.log("payment ledger source diagnostic tests passed");
