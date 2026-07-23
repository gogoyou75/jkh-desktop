"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const core = require(path.join(__dirname, "..", "web", "full_recalc_core.js"));
const calc = require(path.join(__dirname, "..", "web", "calc_engine.js"));
const compare = require(path.join(__dirname, "..", "shared", "full_recalc_shadow_compare.js"));
const EXIT = { PASS:0, BLOCKED:1, ERROR:2, USAGE:3 };
function hash(value){ return crypto.createHash("sha256").update(compare.stableStringify(value)).digest("hex"); }
function fail(message, code){ console.log("SHADOW RESULT: ERROR"); console.error(message); process.exit(code); }
const inputIndex = process.argv.indexOf("--input");
if (inputIndex < 0 || !process.argv[inputIndex+1]) fail("Usage: node scripts/run_full_recalc_shadow.js --input fixture.json [--report report.json]", EXIT.USAGE);
let input;
try { input = JSON.parse(fs.readFileSync(process.argv[inputIndex+1], "utf8")); } catch(e) { fail("Invalid input JSON", EXIT.ERROR); }
if (!input || input.schemaVersion !== 1 || input.mode !== "permanent_full_recalc" || input.executionMode !== "shadow") fail("Invalid shadow schema or mode", EXIT.ERROR);
if (!input.uid || !Array.isArray(input.ledger) || !input.financialInputs || !input.referenceResult || !Array.isArray(input.calculatedRows)) fail("Missing UID, ledger, financialInputs, calculatedRows, or referenceResult", EXIT.ERROR);
const inputForHash = Object.assign({}, input); delete inputForHash.inputHash; delete inputForHash.referenceResult;
if (!input.inputHash || input.inputHash !== hash(inputForHash)) fail("Input hash mismatch", EXIT.ERROR);
const candidateRows = core.run({ mode:"permanent_full_recalc", ledger:input.ledger, calculatedRows:input.calculatedRows, financialInputs:input.financialInputs, calculationOptions:input.calculationOptions || {}, versions:input.versions || null }, {
  calculateTotals: function(request){ return calc.calcTotalsAsOfAdjusted(request.ledger, new Date(request.asOf), Object.assign({}, request.calculationOptions, { financialInputs:request.financialInputs })); }
});
if (!candidateRows.ok) fail(candidateRows.reason || "Core calculation failed", EXIT.ERROR);
const finalTotals = calc.calcTotalsAsOfAdjusted(input.ledger, new Date(input.calculationDate), Object.assign({}, input.calculationOptions || {}, { financialInputs:input.financialInputs }));
const accrued = input.ledger.reduce((s,row)=>s+(Number(row.accrued)||0),0), paid = input.ledger.reduce((s,row)=>s+(Number(row.paid)||0),0);
const candidate = { status:"calculated", reason:"OK", mode:"permanent_full_recalc", uid:input.uid, calculationDate:input.calculationDate, ledgerRowsCount:input.ledger.length, calculatedRows:input.calculatedRows, rowsById:candidateRows.rowsById, totals:{ accrued:accrued, paid:paid, debt:finalTotals.total, penalty:finalTotals.penaltyDebt, total:finalTotals.total }, totalAccrued:accrued, totalPaid:paid, totalDebt:finalTotals.total, totalPenalty:finalTotals.penaltyDebt, total:finalTotals.total, versions:input.versions || null, engineVersion:input.engineVersion || "", ledgerVersion:input.ledgerVersion || "", inputHash:input.inputHash, financialInputs:input.financialInputs, timings:{} };
const diffs = compare.strictDiff(input.referenceResult, candidate);
const result = diffs.length ? "BLOCKED" : "PASS";
const report = { schemaVersion:1, generatedAt:new Date().toISOString(), uid:input.uid, inputHash:input.inputHash, referenceHash:hash(input.referenceResult), candidateHash:hash(candidate), result:result, criticalDiffCount:diffs.length, warningDiffCount:0, ignoredDiffCount:compare.IGNORED_FIELDS.length, diffs:diffs, referenceResult:input.referenceResult, candidateResult:candidate };
const reportIndex = process.argv.indexOf("--report"); if (reportIndex >= 0 && process.argv[reportIndex+1]) fs.writeFileSync(process.argv[reportIndex+1], JSON.stringify(report, null, 2));
console.log("UID: " + input.uid + " | ledger rows: " + input.ledger.length + " | rowsById: " + Object.keys(candidate.rowsById).length + " | critical differences: " + diffs.length);
console.log("SHADOW RESULT: " + result);
process.exit(result === "PASS" ? EXIT.PASS : EXIT.BLOCKED);
