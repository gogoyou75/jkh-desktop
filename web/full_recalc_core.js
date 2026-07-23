/*
 * Phase 2 shared Full Recalc Core.
 *
 * This file intentionally contains no persistence, browser state, transport, or
 * financial-input loading.  Browser callers inject the already-selected
 * calculator and normalized row/as-of pairs.  The UMD shell is only an export
 * bridge; the factory and returned API do not read browser globals.
 */
(function(root, factory){
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.JKHFullRecalcCore = api;
})(typeof globalThis !== "undefined" ? globalThis : null, function(){
  "use strict";

  var PERMANENT_MODE = "permanent_full_recalc";

  function buildRowsById(input, dependencies){
    var source = input && typeof input === "object" ? input : null;
    var deps = dependencies && typeof dependencies === "object" ? dependencies : null;
    if (!source || source.mode !== PERMANENT_MODE) {
      return { ok:false, status:"error", reason:"CORE_MODE_INVALID", mode:source && source.mode || "", ledger:[], calculatedRows:[], rowsById:{}, totals:null, versions:source && source.versions || null, warnings:[], diagnostics:{}, timings:{} };
    }
    if (!Array.isArray(source.ledger) || !Array.isArray(source.calculatedRows) || !deps || typeof deps.calculateTotals !== "function") {
      return { ok:false, status:"error", reason:"CORE_INPUT_INVALID", mode:PERMANENT_MODE, ledger:Array.isArray(source && source.ledger) ? source.ledger : [], calculatedRows:[], rowsById:{}, totals:null, versions:source && source.versions || null, warnings:[], diagnostics:{}, timings:{} };
    }

    var rowsById = {};
    var uniqueAsOf = {};
    for (var i = 0; i < source.calculatedRows.length; i++) {
      var item = source.calculatedRows[i] || {};
      var rowId = String(item.rowId || "").trim();
      var asOf = item.asOf;
      var asOfKey = String(item.asOfKey || "").trim();
      if (!rowId || !asOf || !asOfKey) continue;
      uniqueAsOf[asOfKey] = true;
      var totals = deps.calculateTotals({
        ledger: source.ledger,
        asOfKey: asOfKey,
        asOf: asOf,
        financialInputs: source.financialInputs || null,
        calculationOptions: source.calculationOptions || null
      });
      var principal = Number(totals && totals.principal);
      var penalty = Number(totals && totals.penaltyDebt);
      var total = Number(totals && totals.total);
      if (!Number.isFinite(principal) || !Number.isFinite(penalty) || !Number.isFinite(total)) continue;
      rowsById[rowId] = { pay_main: principal, pay_penalty: penalty, total: total };
    }

    var hasRows = Object.keys(rowsById).length > 0;
    return {
      ok: hasRows,
      status: hasRows ? "calculated" : "error",
      reason: hasRows ? "OK" : "ROWS_BY_ID_EMPTY_AFTER_WITH_ROWS_RECALC",
      mode: PERMANENT_MODE,
      ledger: source.ledger,
      calculatedRows: source.calculatedRows,
      rowsById: rowsById,
      totals: null,
      versions: source.versions || null,
      warnings: [],
      diagnostics: { uniqueAsOfKeys: Object.keys(uniqueAsOf).length },
      timings: {}
    };
  }

  function run(input, dependencies){
    return buildRowsById(input, dependencies);
  }

  return { PERMANENT_MODE: PERMANENT_MODE, run: run, buildRowsById: buildRowsById };
});
