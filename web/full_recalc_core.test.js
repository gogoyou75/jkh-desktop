"use strict";

const assert = require("assert");
const core = require("./full_recalc_core.js");

const input = {
  mode: "permanent_full_recalc",
  ownerId: "owner-fixture",
  namespace: "lab",
  abonentId: "fixture-1",
  uid: "uid_fixture_1",
  calculationDate: "2026-07-23",
  responsibilityPeriod: { from: "2026-01-01", to: "2026-12-31" },
  ledger: [{ id: "a" }, { id: "b" }],
  tariffs: null,
  rates: [],
  exclusions: [],
  transfer: null,
  freeze: null,
  versions: { inputHash: "fixture" },
  rounding: null,
  diagnostics: null,
  calculatedRows: [
    { rowId: "a", asOf: new Date(2026, 0, 31), asOfKey: "2026-01-31" },
    { rowId: "b", asOf: new Date(2026, 1, 28), asOfKey: "2026-02-28" }
  ]
};

const totalsByDate = {
  "2026-01-31": { principal: 10.12, penaltyDebt: 0.01, total: 10.13 },
  "2026-02-28": { principal: 20.23, penaltyDebt: 0.02, total: 20.25 }
};

const result = core.run(input, { calculateTotals: (key) => totalsByDate[key] });
assert.equal(result.ok, true);
assert.equal(result.status, "calculated");
assert.deepEqual(result.rowsById, {
  a: { pay_main: 10.12, pay_penalty: 0.01, total: 10.13 },
  b: { pay_main: 20.23, pay_penalty: 0.02, total: 20.25 }
});
assert.equal(result.diagnostics.uniqueAsOfKeys, 2);
assert.equal(core.run(Object.assign({}, input, { mode: "temporary_court_period" }), { calculateTotals: () => ({}) }).reason, "CORE_MODE_INVALID");

const source = require("fs").readFileSync(__dirname + "/full_recalc_core.js", "utf8");
for (const forbidden of ["window", "document", "localStorage", "sessionStorage", "fetch(", "alert(", "confirm("]) {
  assert.equal(source.includes(forbidden), false, "core body must not contain " + forbidden);
}

// Browser compatibility golden: the existing JKHCalcEngine remains the formula
// source; the Phase 2 core receives it only through an explicit adapter.
global.window = global;
global.location = { hostname: "fixture", search: "", href: "http://fixture/?id=fixture-1" };
global.JKH_DATA_READY = true;
const store = {
  refinancing_rates_normal_v1: JSON.stringify([{ from: "2020-01-01", rate: 10 }]),
  "exclude_periods_fixture-1": JSON.stringify([]),
  "jkh_freeze_to_v1:fixture-1": "2026-03-15",
  "jkh_transfer_balance_v1:fixture-1:fixture-regnum": JSON.stringify({ startDate: "2026-02-01", principal: 3, penalty: 1 })
};
global.JKHStore = { getRaw: (key) => Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null };
global.AbonentsDB = {
  abonents: { "fixture-1": { uid: "uid_fixture_1", premiseRegnum: "fixture-regnum" } },
  links: [{ abonentId: "fixture-1", dateFrom: "2026-01-01" }]
};
require("./calc_engine.js");
assert.equal(typeof global.JKHCalcEngine.calcTotalsAsOfAdjusted, "function");

const financialLedger = [
  { id: "jan", year: "2026", month: "01", accrued: 100, paid: 0 },
  { id: "feb", year: "2026", month: "02", accrued: 50, paid: 40, paid_date: "2026-02-20" }
];
const asOf = new Date(2026, 2, 31);
const oldTotals = global.JKHCalcEngine.calcTotalsAsOfAdjusted(financialLedger, asOf, {
  abonentId: "fixture-1", applyAdvanceOffset: true, allowNegativePrincipal: true
});
const golden = core.run(Object.assign({}, input, {
  ledger: financialLedger,
  calculatedRows: [{ rowId: "mar", asOf, asOfKey: "2026-03-31" }]
}), {
  calculateTotals: (_key, date) => global.JKHCalcEngine.calcTotalsAsOfAdjusted(financialLedger, date, {
    abonentId: "fixture-1", applyAdvanceOffset: true, allowNegativePrincipal: true
  })
});
assert.deepEqual(golden.rowsById.mar, {
  pay_main: oldTotals.principal,
  pay_penalty: oldTotals.penaltyDebt,
  total: oldTotals.total
});

console.log("full_recalc_core.test.js: PASS");
