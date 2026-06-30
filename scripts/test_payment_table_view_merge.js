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

console.log("payment_table view merge test passed");
