const assert = require("assert");
const fs = require("fs");

const card = fs.readFileSync("web/abonent_card.html", "utf8");
const table = fs.readFileSync("web/payment_table.js", "utf8");

assert.match(table, /JKH_DEBUG_TEMPORARY_PERIOD_RESET !== true\) return null/);
assert.match(table, /window\.JKH_debugTemporaryPeriodResetState = __temporaryPeriodResetDebugState/);
assert.match(table, /temporary-period-reset-rendered/);
assert.match(table, /PASS_CANONICAL_VALUES/);
assert.match(table, /FAIL_TEMPORARY_VALUES_SURVIVED/);
assert.match(table, /FAIL_MIXED_RENDER_STATE/);
assert.match(card, /temporary-period-reset-before/);
assert.match(card, /temporary-period-reset-cleared/);
assert.match(card, /temporaryPeriodResetDebug: true/);
assert.match(card, /temporary-period-reset-rendered/);
assert.match(card, /JKH_resetPaymentTablePeriodRuntime\("card-period-reset"\)/);
const debugStart = table.indexOf("function __temporaryPeriodResetDebugState");
const debugEnd = table.indexOf("window.JKH_debugTemporaryPeriodResetState", debugStart);
assert.ok(debugStart >= 0 && debugEnd > debugStart, "debug helper boundaries must exist");
const debugBody = table.slice(debugStart, debugEnd);
assert.doesNotMatch(debugBody, /writePaymentLedger|saveCardSnapshot|flushDbToServer|fetch\(/);
console.log("temporary period reset contract: OK");
