"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const core = require("../web/full_recalc_core.js"), calc = require("../web/calc_engine.js"), compare = require("../shared/full_recalc_shadow_compare.js");
const hash = value => crypto.createHash("sha256").update(compare.stableStringify(value)).digest("hex");
const ledger = [{ id:"jan", year:"2026", month:"01", accrued:100, paid:0 }, { id:"feb", year:"2026", month:"02", accrued:50, paid:40, paid_date:"2026-02-20" }];
const financialInputs = { responsibility:{from:"2026-01-01",to:""}, rates:[{date:"2020-01-01",value:10},{date:"2026-02-01",value:9}], exclusions:[{from:"2026-02-10",to:"2026-02-12"}], freeze:{to:"2026-03-15"}, transfer:{startDate:"2026-02-01",principal:3,penalty:1}, paymentPeriod:null };
const calculatedRows = [{rowId:"jan",asOf:"2026-01-31",asOfKey:"2026-01-31"},{rowId:"feb",asOf:"2026-02-28",asOfKey:"2026-02-28"}];
function candidate(input){
  const rows = core.run({mode:"permanent_full_recalc",ledger:input.ledger,calculatedRows:input.calculatedRows,financialInputs:input.financialInputs,calculationOptions:input.calculationOptions},{calculateTotals:r=>calc.calcTotalsAsOfAdjusted(r.ledger,new Date(r.asOf),Object.assign({},r.calculationOptions,{financialInputs:r.financialInputs}))});
  const final = calc.calcTotalsAsOfAdjusted(input.ledger,new Date(input.calculationDate),Object.assign({},input.calculationOptions,{financialInputs:input.financialInputs}));
  const accrued=input.ledger.reduce((s,r)=>s+(Number(r.accrued)||0),0), paid=input.ledger.reduce((s,r)=>s+(Number(r.paid)||0),0);
  return {status:"calculated",reason:"OK",mode:"permanent_full_recalc",uid:input.uid,calculationDate:input.calculationDate,ledgerRowsCount:input.ledger.length,calculatedRows:input.calculatedRows,rowsById:rows.rowsById,totals:{accrued,paid,debt:final.total,penalty:final.penaltyDebt,total:final.total},totalAccrued:accrued,totalPaid:paid,totalDebt:final.total,totalPenalty:final.penaltyDebt,total:final.total,versions:input.versions,engineVersion:input.engineVersion,ledgerVersion:input.ledgerVersion,inputHash:input.inputHash,financialInputs:input.financialInputs,timings:{browserOnly:1}};
}
function fixture(){ const f={schemaVersion:1,mode:"permanent_full_recalc",executionMode:"shadow",ownerId:"fixture",namespace:"LAB",abonentId:"fixture-1",uid:"uid_shadow_fixture",calculationDate:"2026-03-31",responsibilityPeriod:financialInputs.responsibility,ledger,financialInputs,calculatedRows,versions:{input:"fixture"},engineVersion:"fixture",ledgerVersion:"ledger-fixture",calculationOptions:{abonentId:"fixture-1",applyAdvanceOffset:true,allowNegativePrincipal:true}}; f.inputHash=hash(f); f.referenceResult=candidate(f); return f; }
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"jkh-shadow-")), runner=path.join(__dirname,"run_full_recalc_shadow.js");
function run(data){ const file=path.join(tmp,"input.json"); fs.writeFileSync(file,JSON.stringify(data)); return cp.spawnSync(process.execPath,[runner,"--input",file],{encoding:"utf8"}); }
const pass=run(fixture()); if (pass.status !== 0) throw new Error(JSON.stringify({ status:pass.status, signal:pass.signal, error:String(pass.error||""), stdout:pass.stdout, stderr:pass.stderr })); assert.match(pass.stdout,/SHADOW RESULT: PASS/);
const blocked=fixture(); blocked.referenceResult.totalDebt+=1; const blockedRun=run(blocked); assert.equal(blockedRun.status,1); assert.match(blockedRun.stdout,/SHADOW RESULT: BLOCKED/);
const missingKey=fixture(); delete missingKey.referenceResult.rowsById.jan; assert.equal(run(missingKey).status,1);
const uidMismatch=fixture(); uidMismatch.referenceResult.uid="uid_other"; assert.equal(run(uidMismatch).status,1);
const versionMismatch=fixture(); versionMismatch.referenceResult.engineVersion="other"; assert.equal(run(versionMismatch).status,1);
const hashMismatch=fixture(); hashMismatch.inputHash="bad"; assert.equal(run(hashMismatch).status,2);
const missingLedger=fixture(); delete missingLedger.ledger; assert.equal(run(missingLedger).status,2);
const missingInputs=fixture(); delete missingInputs.financialInputs; assert.equal(run(missingInputs).status,2);
const invalid=fixture(); invalid.mode="temporary_court_period"; const invalidRun=run(invalid); assert.equal(invalidRun.status,2); assert.match(invalidRun.stdout,/SHADOW RESULT: ERROR/);
const runnerSource=fs.readFileSync(runner,"utf8"); for(const forbidden of ["fetch(","writePaymentLedger","saveCardSnapshot","saveAbonentSummary","complete_uid","JKHStore"]) assert.equal(runnerSource.includes(forbidden),false,forbidden);
console.log("test_full_recalc_shadow.js: PASS");
