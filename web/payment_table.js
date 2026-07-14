/* ============================================================
   🔒 CRITICAL — НЕ ТРОГАТЬ (ПАПАЖКХ)
   Doc: docs/LOGIC_SPEC_v1.5.3.md  |  Date: 2026-01-27
   Эталон архива: jkh_site_full_v01.27.3.zip
   SHA256: 6b4254a9b3b74327fe2d2c48c34e3e446ba9ae4e3369c6c554a683bde7b6ceec

   1) Карточка абонента (UI) = ИСТОЧНИК ИСТИНЫ (source of truth).
      Любые отчёты/справки — производные и НЕ имеют права менять логику карточки.

   2) // CRITICAL:
      // payments_<uid> — основной формат хранения ledger
      // payments_<LS> — legacy (устаревший, только для совместимости)
      // ledger остаётся помесячным (НЕ журнал событий), в одном месяце
      // допускается несколько строк (начисление + оплаты).

   3) "Оплата за период" (use_period/pay_for_period) влияет ТОЛЬКО на пеню.
      Запрещена ретро‑перезапись: дата фактической оплаты не меняется.

   4) Исключённые периоды отключают ТОЛЬКО пеню, основной долг не трогают.

   5) ES-modules (type="module", import/export) в v1.5.x ЗАПРЕЩЕНЫ:
      проект должен работать в режиме file:// без сервера.

   Любая правка этого блока/связанных расчётов → только через новую версию SPEC.
   ============================================================ */

/* =====================================================================
   PAYMENT_TABLE.JS — ТАБЛИЦА ОПЛАТ
   ===================================================================== */

(function () {
  function qs(sel, root = document) { return root.querySelector(sel); }
  function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
  function pad2(n) { return String(n).padStart(2, "0"); }
  const __paymentRenderRegression = { sequence: 0, events: [], snapshotRestoreSeen: false, firstZeroReported: false };
  let __paymentTableCurrentLoadMeta = null;

  function paymentRenderCaller(stack){
    const frames = String(stack || "").split("\n").slice(1, 8).map(function(line){ return String(line || "").trim(); }).filter(Boolean);
    const caller = frames.filter(function(line){
      return line.indexOf("recordPaymentRenderRegression") < 0 && line.indexOf("requestLoadPaymentTable") < 0 && line.indexOf("loadPaymentTable (") < 0;
    })[0] || "";
    return { caller: caller, stack: frames };
  }

  function recordPaymentRenderRegression(stage, detail){
    const input = detail && typeof detail === "object" ? detail : {};
    const suppliedFrames = Array.isArray(input.stack) ? input.stack : (Array.isArray(input.stackFrames) ? input.stackFrames : null);
    const trace = suppliedFrames ? { caller: "", stack: suppliedFrames } : paymentRenderCaller(input.stack || "");
    const entry = {
      sequence: ++__paymentRenderRegression.sequence,
      timestamp: new Date().toISOString(),
      stage: String(stage || ""),
      reason: String(input.reason || ""),
      renderSource: String(input.renderSource || ""),
      rowCount: Number(input.rowCount || 0),
      ledgerRowsCount: Number(input.ledgerRowsCount || 0),
      snapshotRowsCount: Number(input.snapshotRowsCount || 0),
      caller: String(input.caller || trace.caller || ""),
      stack: suppliedFrames || trace.stack
    };
    __paymentRenderRegression.events.push(entry);
    if (stage === "snapshot-restore-start" || stage === "snapshot-restore-rendered") __paymentRenderRegression.snapshotRestoreSeen = true;
    try { console.log("[render-regression][event]", entry); } catch(e) {}
    if (__paymentRenderRegression.snapshotRestoreSeen && stage === "render" && entry.rowCount === 0 && !__paymentRenderRegression.firstZeroReported) {
      __paymentRenderRegression.firstZeroReported = true;
      try {
        console.warn("[render-regression][first-zero]", entry);
        console.warn("[render-regression][sequence]", {
          events: __paymentRenderRegression.events.slice(),
          firstZeroRender: entry
        });
      } catch(eZeroLog) {}
    }
    return entry;
  }

  window.__getPaymentRenderRegressionSequence = function(){
    return { events: __paymentRenderRegression.events.slice(), firstZeroReported: __paymentRenderRegression.firstZeroReported };
  };
  function serverFirstReadableState(){
    const out = {
      ok: false,
      acceptedReason: "",
      uiStatus: "",
      uiSource: "",
      legacyDataReady: false
    };
    try {
      const st = window.JKH_UI_STATE && window.JKH_UI_STATE.data || {};
      out.uiStatus = String(st.status || "");
      out.uiSource = String(st.source || "");
      out.legacyDataReady = window.JKH_DATA_READY === true;
      if (out.uiStatus === "ready") {
        out.ok = true;
        out.acceptedReason = "manual_recalc_data_ready_server_ready";
        diagnoseServerFirstReadable(out, "uiStatus === ready", "web/payment_table.js:49");
        return out;
      }
      if (out.uiStatus === "empty" && out.uiSource === "server") {
        out.ok = true;
        out.acceptedReason = "manual_recalc_data_ready_server_empty";
        diagnoseServerFirstReadable(out, "uiStatus === empty && uiSource === server", "web/payment_table.js:55");
        return out;
      }
      if (out.legacyDataReady) {
        out.ok = true;
        out.acceptedReason = "manual_recalc_data_ready_legacy";
        diagnoseServerFirstReadable(out, "legacyDataReady === true", "web/payment_table.js:61");
        return out;
      }
    } catch(e) {}
    diagnoseServerFirstReadable(out, "no readable branch matched", "web/payment_table.js:37");
    return out;
  }

  let __readableDiagnosticNextId = 0;
  let __readableDiagnosticLatest = null;
  let __readableDiagnosticLatestTrue = null;
  const __readableDiagnosticMeta = typeof WeakMap === "function" ? new WeakMap() : null;

  function readableDiagnosticContext(){
    const value = window.__JKH_READABLE_DIAGNOSTIC;
    return value && value.active === true ? value : null;
  }

  function beginReadableDiagnostic(runId){
    __readableDiagnosticLatest = null;
    __readableDiagnosticLatestTrue = null;
    window.__JKH_READABLE_DIAGNOSTIC = {
      active: true,
      runId: String(runId || ""),
      startedAt: Date.now()
    };
  }

  function finishReadableDiagnostic(){
    const context = window.__JKH_READABLE_DIAGNOSTIC;
    if (context) context.active = false;
  }

  function diagnoseServerFirstReadable(readable, matchedBranch, assignmentSite){
    const context = readableDiagnosticContext();
    if (!context) return;
    const objectId = "readable-" + (++__readableDiagnosticNextId);
    const createdAt = Date.now();
    const stack = String((new Error()).stack || "").split("\n").slice(2, 7).map(function(line){ return String(line || "").trim(); });
    const creator = "serverFirstReadableState";
    const allocationSite = "web/payment_table.js:36";
    const operands = [
      { operandName: "uiStatus === ready", currentValue: readable.uiStatus, expectedValue: "ready", expressionResult: readable.uiStatus === "ready", sourceFunction: creator, sourceFile: "web/payment_table.js", sourceLine: 48 },
      { operandName: "uiStatus === empty", currentValue: readable.uiStatus, expectedValue: "empty", expressionResult: readable.uiStatus === "empty", sourceFunction: creator, sourceFile: "web/payment_table.js", sourceLine: 54 },
      { operandName: "uiSource === server", currentValue: readable.uiSource, expectedValue: "server", expressionResult: readable.uiSource === "server", sourceFunction: creator, sourceFile: "web/payment_table.js", sourceLine: 54 },
      { operandName: "legacyDataReady === true", currentValue: readable.legacyDataReady, expectedValue: true, expressionResult: readable.legacyDataReady === true, sourceFunction: creator, sourceFile: "web/payment_table.js", sourceLine: 60 }
    ];
    operands.forEach(function(operand){
      try { console.log("[readable-operand]", Object.assign({}, operand, { objectIdentity: objectId, runId: context.runId })); } catch(eOperandLog) {}
    });
    const meta = {
      objectIdentity: objectId,
      creator: creator,
      allocationSite: allocationSite,
      createdAt: createdAt,
      allocationNumber: __readableDiagnosticNextId,
      runId: context.runId,
      ok: readable.ok === true,
      matchedBranch: String(matchedBranch || ""),
      assignmentSite: String(assignmentSite || ""),
      stack: stack
    };
    if (__readableDiagnosticMeta) __readableDiagnosticMeta.set(readable, meta);
    __readableDiagnosticLatest = meta;
    if (meta.ok) __readableDiagnosticLatestTrue = meta;
    try {
      console.log("[readable-expression]", {
        expression: '(uiStatus === "ready") || (uiStatus === "empty" && uiSource === "server") || (legacyDataReady === true)',
        evaluatedExpression: "(" + String(readable.uiStatus === "ready") + ") || (" + String(readable.uiStatus === "empty") + " && " + String(readable.uiSource === "server") + ") || (" + String(readable.legacyDataReady === true) + ")",
        result: readable.ok === true,
        matchedBranch: meta.matchedBranch,
        firstFalseAssignmentSite: readable.ok === true ? "" : "web/payment_table.js:37",
        objectIdentity: objectId,
        creator: creator,
        allocationSite: allocationSite,
        runId: context.runId
      });
    } catch(eExpressionLog) {}
  }

  function diagnoseReadableConsumer(readable, consumer){
    const context = readableDiagnosticContext();
    if (!context) return;
    const meta = __readableDiagnosticMeta && readable && typeof readable === "object" ? __readableDiagnosticMeta.get(readable) : null;
    const latest = __readableDiagnosticLatest;
    const stale = !!(meta && latest && meta.objectIdentity !== latest.objectIdentity);
    const payload = {
      creator: meta && meta.creator || "unknown",
      allocationSite: meta && meta.allocationSite || "unknown",
      consumer: String(consumer || ""),
      objectIdentity: meta && meta.objectIdentity || "unknown",
      createdAt: meta && meta.createdAt || null,
      consumedAt: Date.now(),
      runId: context.runId,
      ok: !!(readable && readable.ok === true),
      stale: stale,
      latestObjectIdentity: latest && latest.objectIdentity || "",
      newerReadableAlreadyTrue: !!(__readableDiagnosticLatestTrue && meta && __readableDiagnosticLatestTrue.allocationNumber > meta.allocationNumber),
      newerTrueObjectIdentity: __readableDiagnosticLatestTrue && __readableDiagnosticLatestTrue.objectIdentity || "",
      dependencyChain: [
        String(consumer || ""),
        "serverFirstReadableState",
        "window.JKH_UI_STATE.data.status/source + window.JKH_DATA_READY",
        '(uiStatus === "ready") || (uiStatus === "empty" && uiSource === "server") || (legacyDataReady === true)'
      ]
    };
    try { console.log("[readable-consumer]", payload); } catch(eConsumerLog) {}
    if (stale) {
      try { console.warn("STALE_READABLE_REFERENCE", payload); } catch(eStaleLog) {}
    }
  }

  function diagnoseReadableWrapper(readable, gate){
    const context = readableDiagnosticContext();
    if (!context) return;
    const meta = __readableDiagnosticMeta && readable && typeof readable === "object" ? __readableDiagnosticMeta.get(readable) : null;
    const wrapperStack = String((new Error()).stack || "").split("\n").slice(2, 5).map(function(line){ return String(line || "").trim(); });
    try {
      console.log("[readable-wrapper]", {
        sourceExpression: "gate.readable = readable.ok === true",
        sourceFunction: "manualRecalcDataReadyForSync",
        sourceFile: "web/payment_table.js",
        sourceLine: wrapperStack[0] || "",
        readableOk: !!(readable && readable.ok === true),
        wrapperReadable: !!(gate && gate.readable === true),
        wrapperReplacedResult: !!(readable && gate && (readable.ok === true) !== (gate.readable === true)),
        objectIdentity: meta && meta.objectIdentity || "unknown",
        runId: context.runId
      });
    } catch(eWrapperLog) {}
  }
  function isDataReady(){
    return serverFirstReadableState().ok === true;
  }
  function storeGetRaw(key){
    if (!isDataReady()) return null;
    if (!(window.JKHStore && typeof window.JKHStore.getRaw === "function")) return null;
    try { return JKHStore.getRaw(String(key)); } catch { return null; }
  }
  const __calcPeriodLogOnce = new Set();
  function logCalcPeriodOnce(tag, payload){
    try {
      const key = String(tag || "") + ":" + String(payload && (payload.key || payload.storageKey || payload.activeKey || payload.reason) || "");
      if (__calcPeriodLogOnce.has(key)) return;
      __calcPeriodLogOnce.add(key);
      console.log(tag, payload || {});
    } catch(e) {}
  }
  function isLegacyCalcPeriodKey(key){
    const k = String(key || "");
    return /^calc_period_active_(?!uid_)/.test(k) || /^calc_period_(?!uid_|active_uid_)/.test(k);
  }
  function storeSetRaw(key, value){
    if (!(window.JKHStore && typeof window.JKHStore.setRaw === "function")) return;
    if (isLegacyCalcPeriodKey(key)) {
      logCalcPeriodOnce("[calc-period][legacy-write-prevented]", { key: String(key || ""), source: "payment_table.storeSetRaw" });
      return;
    }
    try { JKHStore.setRaw(String(key), value); } catch(e) { console.error(e); throw e; }
  }
  function storeRemoveRaw(key){
    if (!(window.JKHStore && typeof window.JKHStore.removeRaw === "function")) return;
    try { JKHStore.removeRaw(String(key)); } catch(e) { console.error(e); throw e; }
  }

  let __paymentTableMode = "default";
  let __runtimeCacheState = { valid: false, reason: "", dataById: {} };

  function isReadonlyNoRecalcMode(){ return __paymentTableMode === "readonly_no_recalc"; }
  function isTemporaryCourtPeriodMode(){ return __paymentTableMode === "temporary_court_period"; }

  function postRecalcState(){
    const state = window.__JKH_POST_RECALC_SNAPSHOT;
    return state && typeof state === "object" ? state : null;
  }

  window.__markPostRecalcSnapshotFresh = function(runId, snapshot){
    const s = snapshot && typeof snapshot === "object" ? snapshot : {};
    const map = s.rowsById && typeof s.rowsById === "object" && !Array.isArray(s.rowsById) ? s.rowsById : {};
    window.__JKH_POST_RECALC_SNAPSHOT = {
      runId: String(runId || ""),
      uid: String(s.uid || getAbonentId() || ""),
      ledgerVersion: String(s.ledgerVersion || ""),
      runtimeSignature: String(s.runtimeSignature || ""),
      summaryStatus: String(s.summary_status || s.status || ""),
      snapshotMode: String(s.snapshotMode || ""),
      periodActive: s.periodActive === true,
      period: s.period && typeof s.period === "object" ? { from: String(s.period.from || ""), to: String(s.period.to || "") } : null,
      rowsById: map,
      createdAt: Date.now(),
      startedAt: currentFullRecalcRunState() && currentFullRecalcRunState().startedAt || Date.now(),
      saveOk: false
    };
  };

  window.__setPostRecalcSnapshotSaveResult = function(runId, saveOk){
    const state = postRecalcState();
    if (!state || String(state.runId || "") !== String(runId || "")) return;
    state.saveOk = saveOk === true;
  };

  function getFreshPostRecalcSnapshotRows(expectedLedgerVersion, periodActive, selectedPeriod, expectedSignature){
    const state = postRecalcState();
    if (!state) return null;
    if (Date.now() - Number(state.createdAt || 0) > 120000) return null;
    if (String(state.summaryStatus || "").toLowerCase() !== "fresh") return null;
    if (String(state.uid || "") !== String(getAbonentId() || "")) return null;
    if (String(state.ledgerVersion || "") !== String(expectedLedgerVersion || "")) return null;
    if (expectedSignature && state.runtimeSignature && String(state.runtimeSignature) !== String(expectedSignature)) return null;
    if ((state.periodActive === true) !== !!periodActive) return null;
    if (periodActive) {
      const p = state.period || {};
      if (String(p.from || "") !== String(selectedPeriod && selectedPeriod.from || "") || String(p.to || "") !== String(selectedPeriod && selectedPeriod.to || "")) return null;
    }
    const map = state.rowsById && typeof state.rowsById === "object" && !Array.isArray(state.rowsById) ? state.rowsById : null;
    return map && Object.keys(map).length ? map : null;
  }

  function runtimePeriodDescriptor(periodActive, selectedPeriod){
    const active = !!periodActive;
    const p = selectedPeriod && typeof selectedPeriod === "object" ? selectedPeriod : null;
    return {
      active: active,
      from: active && p ? String(p.from || "") : "",
      to: active && p ? String(p.to || "") : ""
    };
  }

  function runtimeCacheSignature(ledgerVersion, periodActive, selectedPeriod){
    const p = runtimePeriodDescriptor(periodActive, selectedPeriod);
    return String(ledgerVersion || "") + "::period:" + (p.active ? "1" : "0") + ":" + p.from + ":" + p.to;
  }

  function runtimeCachePeriodMatches(cache, ledgerVersion, periodActive, selectedPeriod){
    const expected = runtimePeriodDescriptor(periodActive, selectedPeriod);
    const expectedSignature = runtimeCacheSignature(ledgerVersion, periodActive, selectedPeriod);
    const cacheSignature = cache && cache.runtimeSignature ? String(cache.runtimeSignature || "") : "";
    if (cacheSignature) return cacheSignature === expectedSignature;
    const cacheActive = cache && cache.periodActive === true;
    const cachePeriod = cache && cache.period && typeof cache.period === "object" ? cache.period : null;
    const cacheFrom = cachePeriod ? String(cachePeriod.from || "") : "";
    const cacheTo = cachePeriod ? String(cachePeriod.to || "") : "";
    if (!expected.active) return !cacheActive;
    return cacheActive && cacheFrom === expected.from && cacheTo === expected.to;
  }

  function runtimeRowsByIdFromRows(rows, baseRows, ledgerSignature){
    const out = {};
    const calcRows = Array.isArray(baseRows) ? baseRows : (Array.isArray(rows) ? rows : []);
    const sig = ledgerSignature || ledgerSignatureForRows(calcRows);
    (Array.isArray(rows) ? rows : []).forEach(function(r){
      const asOf = asOfForRow(r);
      const t = calcTotalsAsOfMemoized(calcRows, asOf, sig, "runtimeRowsByIdFromRows");
      out[String(r.id)] = { pay_main: t.principal, pay_penalty: t.penalty, total: t.total };
    });
    return out;
  }

  function summarizeRowsById(rows, rowsById){
    const map = rowsById && typeof rowsById === "object" && !Array.isArray(rowsById) ? rowsById : {};
    let selected = null;
    let selectedMs = -Infinity;
    (Array.isArray(rows) ? rows : []).forEach(function(r){
      const id = String(r && r.id || "");
      const item = map[id] || null;
      if (!item) return;
      const ms = asOfForRow(r).getTime();
      if (ms >= selectedMs) {
        selectedMs = ms;
        selected = item;
      }
    });
    const debt = selected ? toNum(selected.pay_main) : 0;
    const penalty = selected ? toNum(selected.pay_penalty) : 0;
    return { debt: r2(debt), penalty: r2(penalty), total: r2(debt + penalty) };
  }

  function buildTemporaryPeriodRowsById(displayRows, visibleRows, selectedPeriod){
    const responsibility = getActiveResponsibilityRangeISO();
    const calcFrom = responsibility && responsibility.from ? responsibility.from : String(selectedPeriod && selectedPeriod.from || "");
    const calcPeriod = { from: calcFrom, to: String(selectedPeriod && selectedPeriod.to || "") };
    const calcRows = applyResponsibilityRangeToView(applyCalcFilter(displayRows, true, calcPeriod)).filter(function(r){ return !isPaymentDraftRow(r); }).slice();
    const baseRows = runningTotalsBaseRows(calcRows);
    const sig = ledgerSignatureForRows(baseRows) + "::temporary_court_period:" + String(calcPeriod.from || "") + ":" + String(calcPeriod.to || "");
    const rowsById = runtimeRowsByIdFromRows(visibleRows, baseRows, sig);
    applyRuntimeRowsById(visibleRows, rowsById);
    const totals = summarizeRowsById(visibleRows, rowsById);
    try {
      const months = (Array.isArray(visibleRows) ? visibleRows : []).map(function(r){ return ymKeyOfRow(r); }).filter(Boolean).sort();
      console.log("[period-recalc][rows-built]", {
        rowsCount: Array.isArray(visibleRows) ? visibleRows.length : 0,
        accruedCount: (Array.isArray(visibleRows) ? visibleRows : []).filter(function(r){ return Math.abs(toNum(r && r.accrued || 0)) > 0.0000001; }).length
      });
      console.log("[period-recalc][range-rendered]", {
        periodFrom: String(selectedPeriod && selectedPeriod.from || ""),
        periodTo: String(selectedPeriod && selectedPeriod.to || ""),
        rowsCount: Array.isArray(visibleRows) ? visibleRows.length : 0,
        firstRowMonth: months.length ? months[0] : "",
        lastRowMonth: months.length ? months[months.length - 1] : ""
      });
      console.log("[period-recalc][totals-built]", totals);
    } catch(ePeriodRowsLog) {}
    return { rowsById: rowsById, totals: totals, calcPeriod: calcPeriod };
  }

  function assignComputedFieldsToPaymentRow(row, computedRow){
    if (!row || !computedRow) return row;
    const fields = computedFinancialFields(computedRow);
    row.pay_main = fields.debt;
    row.pay_penalty = fields.penalty;
    row.total = fields.total;
    row.debt = fields.debt;
    row.principalDebt = fields.debt;
    row.runningDebt = fields.debt;
    row.penalty = fields.penalty;
    row.penaltyDebt = fields.penalty;
    row.runningPenalty = fields.penalty;
    row.runningTotal = fields.total;
    return row;
  }

  function mergeComputedRowsIntoViewRows(rows, rowsById){
    const map = rowsById && typeof rowsById === "object" && !Array.isArray(rowsById) ? rowsById : {};
    return (Array.isArray(rows) ? rows : []).map(function(row){
      const merged = row && typeof row === "object" ? Object.assign({}, row) : {};
      const item = map[String(merged.id)] || null;
      return item ? assignComputedFieldsToPaymentRow(merged, item) : merged;
    });
  }

  function materializeCanonicalSnapshotRowsForEmptyLedger(snapshot, ledgerRows){
    const source = snapshot && typeof snapshot === "object" ? snapshot : null;
    const existingLedger = Array.isArray(ledgerRows) ? ledgerRows : [];
    const out = { ok: false, reason: "CARD_ROWS_NOT_RESTORED", rows: [], rowsById: {}, snapshotRowsCount: 0, ledgerRowsCount: existingLedger.length };
    if (existingLedger.length) { out.reason = "EXISTING_LEDGER_USED"; return out; }
    if (!source) { out.reason = "CARD_SNAPSHOT_INVALID"; return out; }
    const status = String(source.summary_status || source.snapshot_status || source.status || "").trim().toLowerCase();
    if (status !== "fresh") { out.reason = "CARD_SNAPSHOT_NOT_FRESH"; return out; }
    const mode = String(source.snapshotMode || source.snapshot_mode || source.validationScope || source.validation_scope || "").trim().toLowerCase();
    const scope = String(source.summaryScope || source.summary_scope || source.reportScope || source.report_scope || source.scope || "").trim().toLowerCase();
    const forbidden = [mode, scope].some(function(value){ return value === "period" || value === "report" || value === "temporary" || value === "temporary_court_period" || value === "report_period_calculation"; });
    if (forbidden || source.periodActive === true || source.period_active === true || source.temporary === true || source.temporaryCalculation === true || source.temporary_calculation === true) {
      out.reason = "CARD_SNAPSHOT_PERIOD_NOT_ALLOWED";
      return out;
    }
    if (mode !== "full" && mode !== "canonical" && mode !== "canonical_full") { out.reason = "CARD_SNAPSHOT_FULL_MODE_REQUIRED"; return out; }
    const map = source.rowsById && typeof source.rowsById === "object" && !Array.isArray(source.rowsById) ? source.rowsById : {};
    const mapKeys = Object.keys(map);
    out.snapshotRowsCount = mapKeys.length;
    if (!mapKeys.length) { out.reason = "CARD_SNAPSHOT_ROWS_MISSING"; return out; }
    const structuralRows = Array.isArray(source.rows) ? source.rows : [];
    if (!structuralRows.length) { out.reason = "CARD_SNAPSHOT_STRUCTURAL_ROWS_MISSING"; return out; }
    const seen = {};
    for (let i = 0; i < structuralRows.length; i += 1) {
      const id = String(structuralRows[i] && structuralRows[i].id || "").trim();
      if (!id || seen[id] || !map[id] || typeof map[id] !== "object") {
        out.reason = !id ? "CARD_SNAPSHOT_ROW_ID_MISSING" : (seen[id] ? "CARD_SNAPSHOT_ROW_ID_DUPLICATE" : "CARD_SNAPSHOT_ROWS_NOT_APPLIED");
        return out;
      }
      seen[id] = true;
    }
    if (Object.keys(seen).length !== mapKeys.length) { out.reason = "CARD_SNAPSHOT_ROWS_NOT_APPLIED"; return out; }
    out.rows = mergeComputedRowsIntoViewRows(structuralRows, map);
    out.rowsById = Object.assign({}, map);
    out.ok = out.rows.length === structuralRows.length && out.rows.length === mapKeys.length;
    out.reason = out.ok ? "OK" : "CARD_ROWS_NOT_RESTORED";
    return out;
  }

  try {
    if (window.__JKH_PAYMENT_TABLE_TEST_HOOKS === true) {
      window.__paymentTableTestHooks = Object.assign(window.__paymentTableTestHooks || {}, {
        mergeComputedRowsIntoViewRows: mergeComputedRowsIntoViewRows,
        materializeCanonicalSnapshotRowsForEmptyLedger: materializeCanonicalSnapshotRowsForEmptyLedger,
        recordPaymentRenderRegression: recordPaymentRenderRegression
      });
    }
  } catch(e) {}

  function applyRuntimeRowsById(rows, rowsById){
    const map = rowsById && typeof rowsById === "object" && !Array.isArray(rowsById) ? rowsById : {};
    (Array.isArray(rows) ? rows : []).forEach(function(r){
      const item = map[String(r && r.id)] || null;
      if (!item) return;
      assignComputedFieldsToPaymentRow(r, item);
    });
  }

  let __paymentTableComputedRowsSnapshot = null;
  let __paymentTableCalculatedRenderState = null;

  function setPaymentTableCalculatedRenderState(rows, rowsById, meta){
    const map = normalizeComputedRowsByIdForSnapshot(rows, rowsById);
    if (!Object.keys(map).length) return false;
    const resolvedCanonicalUid = resolveCanonicalAccountUidForCalculatedRender();
    __paymentTableCalculatedRenderState = {
      uid: String(meta && meta.uid || resolvedCanonicalUid.uid || ""),
      rows: clonePaymentRowsForSnapshot(rows, map),
      rowsById: map,
      ledgerVersion: String(meta && meta.ledgerVersion || ""),
      runtimeSignature: String(meta && meta.runtimeSignature || ""),
      periodActive: !!(meta && meta.periodActive),
      period: meta && meta.period ? { from: String(meta.period.from || ""), to: String(meta.period.to || "") } : null,
      source: String(meta && meta.source || ""),
      passiveSnapshotRestore: meta && meta.passiveSnapshotRestore === true,
      createdAt: Date.now()
    };
    try {
      console.log("[payment-table][calculated-rows-ready]", {
        rowsCount: Array.isArray(rows) ? rows.length : 0,
        rowsByIdCount: Object.keys(map).length,
        ledgerVersion: __paymentTableCalculatedRenderState.ledgerVersion,
        periodActive: __paymentTableCalculatedRenderState.periodActive
      });
    } catch(e) {}
    return true;
  }

  function getPassiveSnapshotCalculatedRenderStateForEmptyLedger(){
    const state = __paymentTableCalculatedRenderState;
    if (!isReadonlyNoRecalcMode() || !state || typeof state !== "object") return null;
    if (state.passiveSnapshotRestore !== true || String(state.source || "") !== "canonical_backend_snapshot") return null;
    if (Date.now() - Number(state.createdAt || 0) > 10 * 60 * 1000) return null;
    const canonicalUid = resolveCanonicalAccountUidForCalculatedRender();
    if (!canonicalUid.ok || (state.uid && String(state.uid || "") !== canonicalUid.uid)) return null;
    if (state.periodActive === true) return null;
    const rowsById = state.rowsById && typeof state.rowsById === "object" && !Array.isArray(state.rowsById) ? state.rowsById : {};
    const rows = mergeComputedRowsIntoViewRows(state.rows, rowsById);
    const stats = computedRowsStats(rows, null);
    if (!rows.length || !Object.keys(rowsById).length || !(stats.hasDebtTotals && stats.hasPenaltyTotals && stats.hasTotalTotals)) return null;
    return state;
  }

  function getMatchingCalculatedRenderRows(ledgerVersion, periodActive, selectedPeriod, runtimeSignatureValue){
    const state = __paymentTableCalculatedRenderState;
    if (!state || typeof state !== "object") return null;
    if (Date.now() - Number(state.createdAt || 0) > 10 * 60 * 1000) return null;
    if (String(state.ledgerVersion || "") !== String(ledgerVersion || "")) return null;
    if (!!state.periodActive !== !!periodActive) return null;
    const selected = selectedPeriod && typeof selectedPeriod === "object" ? selectedPeriod : null;
    const statePeriod = state.period && typeof state.period === "object" ? state.period : null;
    if (periodActive) {
      if (!selected || !statePeriod) return null;
      if (String(statePeriod.from || "") !== String(selected.from || "") || String(statePeriod.to || "") !== String(selected.to || "")) return null;
    }
    if (runtimeSignatureValue && state.runtimeSignature && String(state.runtimeSignature) !== String(runtimeSignatureValue)) return null;
    const map = state.rowsById && typeof state.rowsById === "object" && !Array.isArray(state.rowsById) ? state.rowsById : {};
    return Object.keys(map).length ? map : null;
  }

  function getCalculatedRenderRowsForView(rows){
    const state = __paymentTableCalculatedRenderState;
    if (!state || typeof state !== "object") return null;
    if (Date.now() - Number(state.createdAt || 0) > 10 * 60 * 1000) return null;
    if (state.uid && String(state.uid || "") !== String(getAbonentId() || "")) return null;
    const map = state.rowsById && typeof state.rowsById === "object" && !Array.isArray(state.rowsById) ? state.rowsById : {};
    if (!Object.keys(map).length) return null;
    const matchedRows = (Array.isArray(rows) ? rows : []).filter(function(row){
      return !!map[String(row && row.id || "")];
    });
    if (!matchedRows.length) return null;
    const stats = computedRowsStats(matchedRows, map);
    return stats.rowsWithTotals > 0 ? map : null;
  }

  function resolveCanonicalAccountUidForCalculatedRender(){
    const abonentId = String(getAbonentId() || "").trim();
    if (!abonentId) return { ok: false, uid: "", reason: "canonical_uid_unavailable" };
    if (typeof window.getAbonentTechId !== "function") {
      return { ok: false, uid: "", reason: "canonical_uid_resolver_unavailable" };
    }
    const uid = String(window.getAbonentTechId(abonentId) || "").trim();
    if (!uid) return { ok: false, uid: "", reason: "canonical_uid_unavailable" };
    return { ok: true, uid: uid, reason: "" };
  }

  function paymentRowStableKeys(row){
    const r = row && typeof row === "object" ? row : {};
    const keys = [];
    const add = function(prefix, value){
      const text = String(value == null ? "" : value).trim();
      if (text) keys.push(prefix + ":" + text);
    };
    add("id", r.id);
    const year = String(r.year || "").trim();
    const month = String(r.month || "").trim().padStart(2, "0");
    const type = String(r.type || r.row_type || r.rowType || r.kind || "").trim();
    if (year && month && type) keys.push("ymt:" + year + "-" + month + ":" + type);
    add("ym", r.yearMonth || r.year_month || r.ym || (year && month ? year + "-" + month : ""));
    [
      "source_payment_id",
      "sourcePaymentId",
      "payment_id",
      "paymentId",
      "import_payment_id",
      "original_payment_id",
      "sourceRowId",
      "source_row_id"
    ].forEach(function(field){ add(field, r[field]); });
    return keys;
  }

  function buildUniqueCalculatedRowsByKey(rows, rowsById){
    const map = rowsById && typeof rowsById === "object" && !Array.isArray(rowsById) ? rowsById : {};
    const byKey = {};
    const duplicates = {};
    (Array.isArray(rows) ? rows : []).forEach(function(row){
      const id = String(row && row.id || "").trim();
      const item = map[id] || row || {};
      if (!ledgerRowHasComputedFields(item) && !ledgerRowHasComputedFields(row)) return;
      paymentRowStableKeys(row).forEach(function(key){
        if (!key || duplicates[key]) return;
        if (byKey[key]) {
          delete byKey[key];
          duplicates[key] = true;
          return;
        }
        byKey[key] = item;
      });
    });
    return byKey;
  }

  function applyFreshCalculatedRowsForRender(rows, context){
    const state = __paymentTableCalculatedRenderState;
    const arr = Array.isArray(rows) ? rows : [];
    const originalViewRowsCount = arr.length;
    const ctx = context && typeof context === "object" ? context : {};
    const out = {
      applied: false,
      dataById: {},
      sourceRows: null,
      matchedCount: 0,
      mismatchReason: "no_calculated_rows",
      fallbackAllowed: true
    };
    let freshRowsCount = 0;
    let freshRowsByIdCount = 0;
    try {
      if (!state || typeof state !== "object") return out;
      const freshRows = Array.isArray(state.rows) ? state.rows : [];
      const freshRowsById = state.rowsById && typeof state.rowsById === "object" && !Array.isArray(state.rowsById) ? state.rowsById : {};
      freshRowsCount = freshRows.length;
      freshRowsByIdCount = Object.keys(freshRowsById).length;
      out.fallbackAllowed = !(freshRowsCount || freshRowsByIdCount);
      if (Date.now() - Number(state.createdAt || 0) > 10 * 60 * 1000) {
        out.mismatchReason = "calculated_rows_expired";
        out.fallbackAllowed = true;
        return out;
      }
      const canonicalUid = resolveCanonicalAccountUidForCalculatedRender();
      if (!canonicalUid.ok) {
        out.mismatchReason = canonicalUid.reason;
        out.fallbackAllowed = true;
        return out;
      }
      if (!state.uid || String(state.uid || "") !== canonicalUid.uid) {
        out.mismatchReason = "uid_mismatch";
        out.fallbackAllowed = true;
        return out;
      }
      if (!freshRowsCount && !freshRowsByIdCount) return out;

      if (String(state.ledgerVersion || "") !== String(ctx.ledgerVersion || "")) {
        out.mismatchReason = "ledger_version_mismatch";
        out.fallbackAllowed = true;
        return out;
      }
      if (!!state.periodActive !== !!ctx.periodActive) {
        out.mismatchReason = "period_active_mismatch";
        out.fallbackAllowed = true;
        return out;
      }
      const statePeriod = state.period && typeof state.period === "object" ? state.period : null;
      const selectedPeriod = ctx.selectedPeriod && typeof ctx.selectedPeriod === "object" ? ctx.selectedPeriod : null;
      if (state.periodActive && (!statePeriod || !selectedPeriod || String(statePeriod.from || "") !== String(selectedPeriod.from || "") || String(statePeriod.to || "") !== String(selectedPeriod.to || ""))) {
        out.mismatchReason = "period_mismatch";
        out.fallbackAllowed = true;
        return out;
      }
      if (ctx.runtimeSignature && state.runtimeSignature && String(state.runtimeSignature) !== String(ctx.runtimeSignature)) {
        out.mismatchReason = "runtime_signature_mismatch";
        out.fallbackAllowed = true;
        return out;
      }
      if (!freshRowsCount || !freshRowsByIdCount || computedRowsStats(freshRows, freshRowsById).rowsWithTotals <= 0) {
        out.mismatchReason = "calculated_rows_not_renderable";
        out.fallbackAllowed = true;
        return out;
      }

      const strictRowsById = getMatchingCalculatedRenderRows(
        ctx.ledgerVersion,
        !!ctx.periodActive,
        ctx.selectedPeriod || null,
        ctx.runtimeSignature
      );
      if (strictRowsById) {
        // A canonical snapshot can be rendered before the ordinary table load
        // completes.  If that later load sees an empty hydrated ledger, retain
        // the already accepted snapshot rows instead of treating an empty view
        // as a successful in-place rowsById application.
        if (!arr.length) {
          const freshStats = computedRowsStats(freshRows, freshRowsById);
          if (freshRows.length && freshStats.rowsWithTotals > 0) {
            const renderRows = mergeComputedRowsIntoViewRows(freshRows, freshRowsById);
            arr.splice.apply(arr, [0, 0].concat(renderRows));
            out.applied = true;
            out.dataById = strictRowsById;
            out.sourceRows = renderRows;
            out.matchedCount = renderRows.length;
            out.mismatchReason = "fresh_calculated_rows_empty_ledger";
            out.fallbackAllowed = false;
            return out;
          }
        }
        applyRuntimeRowsById(arr, strictRowsById);
        out.applied = true;
        out.dataById = strictRowsById;
        out.matchedCount = Object.keys(strictRowsById).length;
        out.mismatchReason = "";
        out.fallbackAllowed = false;
        return out;
      }

      const byKey = buildUniqueCalculatedRowsByKey(freshRows, freshRowsById);
      const matchedById = {};
      arr.forEach(function(row){
        const rowId = String(row && row.id || "").trim();
        const keys = paymentRowStableKeys(row);
        for (let i = 0; i < keys.length; i += 1) {
          const item = byKey[keys[i]];
          if (!item) continue;
          assignComputedFieldsToPaymentRow(row, item);
          if (rowId) matchedById[rowId] = normalizeComputedRowsByIdForSnapshot([row], { [rowId]: item })[rowId] || item;
          out.matchedCount += 1;
          break;
        }
      });
      if (out.matchedCount > 0) {
        out.applied = true;
        out.dataById = matchedById;
        out.mismatchReason = "relaxed_stable_fields";
        out.fallbackAllowed = false;
        return out;
      }

      const freshStats = computedRowsStats(freshRows, null);
      if (freshRows.length && freshStats.rowsWithTotals > 0) {
        const renderRows = mergeComputedRowsIntoViewRows(freshRows, freshRowsById);
        const renderRowsById = normalizeComputedRowsByIdForSnapshot(renderRows, freshRowsById);
        arr.splice.apply(arr, [0, arr.length].concat(renderRows));
        out.applied = true;
        out.dataById = renderRowsById;
        out.sourceRows = renderRows;
        out.matchedCount = renderRows.length;
        out.mismatchReason = "fresh_calculated_rows_direct";
        out.fallbackAllowed = false;
        return out;
      }

      out.mismatchReason = "calculated_rows_not_renderable";
      out.fallbackAllowed = false;
      return out;
    } finally {
      try {
        console.log("[payment-table][calculated-rows-match]", {
          freshRowsCount: freshRowsCount,
          freshRowsByIdCount: freshRowsByIdCount,
          viewRowsCount: originalViewRowsCount,
          matchedCount: out.matchedCount,
          mismatchReason: out.mismatchReason,
          fallbackAllowed: out.fallbackAllowed
        });
      } catch(eMatchLog) {}
    }
  }

  try {
    if (window.__JKH_PAYMENT_TABLE_TEST_HOOKS === true) {
      window.__paymentTableTestHooks = Object.assign(window.__paymentTableTestHooks || {}, {
        setPaymentTableCalculatedRenderState: setPaymentTableCalculatedRenderState,
        applyFreshCalculatedRowsForRender: applyFreshCalculatedRowsForRender,
        getPassiveSnapshotCalculatedRenderStateForEmptyLedger: getPassiveSnapshotCalculatedRenderStateForEmptyLedger,
        setPaymentTableModeForTest: function(mode){ __paymentTableMode = String(mode || "default"); },
        expireCalculatedRenderState: function(){
          if (__paymentTableCalculatedRenderState) __paymentTableCalculatedRenderState.createdAt = 0;
        },
        setCalculatedRenderStateForTest: function(state){
          __paymentTableCalculatedRenderState = state && typeof state === "object" ? state : null;
        }
      });
    }
  } catch(e) {}

  function clonePaymentRowsForSnapshot(rows, rowsById){
    const map = rowsById && typeof rowsById === "object" && !Array.isArray(rowsById) ? rowsById : {};
    return (Array.isArray(rows) ? rows : []).map(function(row){
      const copy = Object.assign({}, row || {});
      const item = map[String(copy.id || "")] || null;
      if (item && typeof item === "object") {
        const fields = computedFinancialFields(item);
        copy.pay_main = fields.debt;
        copy.pay_penalty = fields.penalty;
        copy.total = fields.total;
        copy.debt = fields.debt;
        copy.principalDebt = fields.debt;
        copy.runningDebt = fields.debt;
        copy.penalty = fields.penalty;
        copy.penaltyDebt = fields.penalty;
        copy.runningPenalty = fields.penalty;
        copy.runningTotal = fields.total;
      }
      return copy;
    });
  }

  function normalizeComputedRowsByIdForSnapshot(rows, rowsById){
    const out = {};
    const map = rowsById && typeof rowsById === "object" && !Array.isArray(rowsById) ? rowsById : {};
    (Array.isArray(rows) ? rows : []).forEach(function(row){
      const id = String(row && row.id || "").trim();
      if (!id) return;
      const item = map[id] || row || {};
      const fields = computedFinancialFields(item);
      const pm = Number(fields.debt);
      const pp = Number(fields.penalty);
      const total = Number(fields.total);
      if (!Number.isFinite(pm) || !Number.isFinite(pp) || !Number.isFinite(total)) return;
      out[id] = {
        pay_main: pm,
        pay_penalty: pp,
        total: total,
        debt: pm,
        principalDebt: pm,
        runningDebt: pm,
        penalty: pp,
        penaltyDebt: pp,
        runningPenalty: pp,
        runningTotal: total
      };
    });
    return out;
  }

  function computedRowsStats(rows, rowsById){
    const map = rowsById && typeof rowsById === "object" && !Array.isArray(rowsById) ? rowsById : null;
    let rowsCount = 0;
    let debtTotalsCount = 0;
    let penaltyTotalsCount = 0;
    let totalTotalsCount = 0;
    let rowsWithAnyTotals = 0;
    let rowsWithZeroTotals = 0;
    (Array.isArray(rows) ? rows : []).forEach(function(row){
      const item = map ? (map[String(row && row.id || "")] || {}) : (row || {});
      rowsCount += 1;
      const pm = Number(item.pay_main);
      const pp = Number(item.pay_penalty);
      const totalRaw = Object.prototype.hasOwnProperty.call(item, "total") ? item.total : (pm + pp);
      const total = Number(totalRaw);
      const hasDebt = Number.isFinite(pm) && Math.abs(pm) > 0.0000001;
      const hasPenalty = Number.isFinite(pp) && Math.abs(pp) > 0.0000001;
      const hasTotal = Number.isFinite(total) && Math.abs(total) > 0.0000001;
      if (hasDebt) debtTotalsCount += 1;
      if (hasPenalty) penaltyTotalsCount += 1;
      if (hasTotal) totalTotalsCount += 1;
      if (hasDebt || hasPenalty || hasTotal) rowsWithAnyTotals += 1;
      if (Number.isFinite(pm) && Number.isFinite(pp) && Number.isFinite(total) && Math.abs(pm) <= 0.0000001 && Math.abs(pp) <= 0.0000001 && Math.abs(total) <= 0.0000001) rowsWithZeroTotals += 1;
    });
    return {
      rowsCount: rowsCount,
      hasDebtTotals: debtTotalsCount > 0,
      hasPenaltyTotals: penaltyTotalsCount > 0,
      hasTotalTotals: totalTotalsCount > 0,
      rowsWithTotals: rowsWithAnyTotals,
      rowsWithZeroTotals: rowsWithZeroTotals
    };
  }

  function ledgerRowHasComputedFields(row){
    if (!row || typeof row !== "object") return false;
    const fields = computedFinancialFields(row);
    return Math.abs(Number(fields.debt) || 0) > 0.0000001
      || Math.abs(Number(fields.penalty) || 0) > 0.0000001
      || Math.abs(Number(fields.total) || 0) > 0.0000001;
  }

  function logLedgerFields(rows, rowsById, source){
    const arr = Array.isArray(rows) ? rows : [];
    const map = rowsById && typeof rowsById === "object" && !Array.isArray(rowsById) ? rowsById : null;
    const first = arr[0] || {};
    let hasDebt = false;
    let hasPenalty = false;
    let hasTotal = false;
    arr.forEach(function(row){
      const item = map ? (map[String(row && row.id || "")] || row || {}) : (row || {});
      const fields = computedFinancialFields(item);
      if (Math.abs(Number(fields.debt) || 0) > 0.0000001) hasDebt = true;
      if (Math.abs(Number(fields.penalty) || 0) > 0.0000001) hasPenalty = true;
      if (Math.abs(Number(fields.total) || 0) > 0.0000001) hasTotal = true;
    });
    try {
      console.log("[payment-table][ledger-fields]", {
        source: String(source || ""),
        firstRowKeys: Object.keys(first || {}),
        hasDebt: hasDebt,
        hasPenalty: hasPenalty,
        hasTotal: hasTotal,
        rowsCount: arr.length
      });
    } catch(e) {}
    return { hasDebt: hasDebt, hasPenalty: hasPenalty, hasTotal: hasTotal, rowsCount: arr.length };
  }

  function logPaymentTableRenderSource(source, rows, rowsById){
    const arr = Array.isArray(rows) ? rows : [];
    const map = rowsById && typeof rowsById === "object" && !Array.isArray(rowsById) ? rowsById : {};
    const stats = computedRowsStats(arr, Object.keys(map).length ? map : null);
    try {
      console.log("[payment-table][render-source]", {
        source: String(source || "raw_payments_ledger"),
        rowsCount: arr.length,
        rowsByIdCount: Object.keys(map).length,
        hasDebt: !!stats.hasDebtTotals,
        hasPenalty: !!stats.hasPenaltyTotals,
        hasTotal: !!stats.hasTotalTotals,
        hasDebtPenaltyTotal: !!(stats.hasDebtTotals && stats.hasPenaltyTotals && stats.hasTotalTotals)
      });
    } catch(e) {}
    return stats;
  }

  function applyComputedSnapshotRowsToLedgerRows(rows, reason){
    const snapshot = __paymentTableComputedRowsSnapshot && typeof __paymentTableComputedRowsSnapshot === "object"
      ? __paymentTableComputedRowsSnapshot
      : null;
    let map = snapshot && snapshot.rowsById && typeof snapshot.rowsById === "object" && !Array.isArray(snapshot.rowsById)
      ? snapshot.rowsById
      : {};
    if ((!map || !Object.keys(map).length) && snapshot && Array.isArray(snapshot.rows)) {
      const fromRows = {};
      snapshot.rows.forEach(function(row){
        const id = String(row && row.id || "").trim();
        if (!id || !ledgerRowHasComputedFields(row)) return;
        fromRows[id] = row;
      });
      map = fromRows;
    }
    if (!Array.isArray(rows) || !rows.length || !Object.keys(map).length) return false;
    applyRuntimeRowsById(rows, map);
    const ok = rows.some(ledgerRowHasComputedFields);
    if (ok) {
      try {
        console.log("[payment-table][ledger-fields-restored-from-snapshot]", {
          reason: String(reason || ""),
          rowsCount: rows.length,
          rowsByIdCount: Object.keys(map).length
        });
      } catch(e) {}
    }
    return ok;
  }

  function logCardReloadRestoreRowsSource(source, rows, rowsById, extra){
    const stats = computedRowsStats(rows, rowsById);
    try {
      console.log("[card-reload][restore-rows-source]", Object.assign({
        source: String(source || ""),
        rowsCount: stats.rowsCount,
        hasDebtTotals: stats.hasDebtTotals,
        hasPenaltyTotals: stats.hasPenaltyTotals,
        hasTotalTotals: stats.hasTotalTotals,
        rowsWithTotals: stats.rowsWithTotals,
        rowsWithZeroTotals: stats.rowsWithZeroTotals,
        snapshotStatus: "",
        snapshotReason: ""
      }, extra || {}));
    } catch(eRestoreSourceLog) {}
    return stats;
  }

  function capturePaymentTableComputedRowsSnapshot(rows, rowsById, periodActive, selectedPeriod, runtimeSignatureValue, ledgerVersionValue){
    const normalizedRowsById = normalizeComputedRowsByIdForSnapshot(rows, rowsById);
    __paymentTableComputedRowsSnapshot = {
      rows: clonePaymentRowsForSnapshot(rows, normalizedRowsById),
      rowsById: normalizedRowsById,
      periodActive: !!periodActive,
      period: periodActive && selectedPeriod ? { from: String(selectedPeriod.from || ""), to: String(selectedPeriod.to || "") } : null,
      runtimeSignature: String(runtimeSignatureValue || ""),
      ledgerVersion: String(ledgerVersionValue || "")
    };
    return __paymentTableComputedRowsSnapshot;
  }

  window.__getPaymentTableComputedRowsSnapshot = function(){
    if (!__paymentTableComputedRowsSnapshot || typeof __paymentTableComputedRowsSnapshot !== "object") return null;
    return {
      rows: clonePaymentRowsForSnapshot(__paymentTableComputedRowsSnapshot.rows, __paymentTableComputedRowsSnapshot.rowsById),
      rowsById: Object.assign({}, __paymentTableComputedRowsSnapshot.rowsById || {}),
      periodActive: __paymentTableComputedRowsSnapshot.periodActive === true,
      period: __paymentTableComputedRowsSnapshot.period ? Object.assign({}, __paymentTableComputedRowsSnapshot.period) : null,
      runtimeSignature: String(__paymentTableComputedRowsSnapshot.runtimeSignature || ""),
      ledgerVersion: String(__paymentTableComputedRowsSnapshot.ledgerVersion || "")
    };
  };

  function tryApplyCardSnapshotToRows(rows, expectedLedgerVersion, periodActive, selectedPeriod, expectedSignature){
    const out = { valid: false, reason: "CARD_SNAPSHOT_MISSING", dataById: {}, periodMatches: false, missingRows: [] };
    let snapshotForDiagnostics = null;
    function dispatchInvalid(reason, extra){
      out.valid = false;
      out.reason = reason || "CARD_SNAPSHOT_ROWS_NOT_APPLIED";
      const snapshotRowsById = snapshotForDiagnostics && snapshotForDiagnostics.rowsById && typeof snapshotForDiagnostics.rowsById === "object" && !Array.isArray(snapshotForDiagnostics.rowsById) ? snapshotForDiagnostics.rowsById : {};
      const snapshotPeriod = snapshotForDiagnostics && snapshotForDiagnostics.period && typeof snapshotForDiagnostics.period === "object" ? snapshotForDiagnostics.period : null;
      const visibleFinancialRowsCount = Array.isArray(rows)
        ? rows.filter(function(r){ return Math.abs(toNum(r && r.accrued || 0)) > 0.0000001 || Math.abs(toNum(r && r.paid || 0)) > 0.0000001; }).length
        : 0;
      try {
        console.warn("[card-snapshot][apply-failed]", Object.assign({
          uid: String(getAbonentId() || ""),
          reason: out.reason,
          rowsByIdCount: Object.keys(snapshotRowsById).length,
          visibleFinancialRowsCount: visibleFinancialRowsCount,
          missingRowsCount: 0,
          snapshotLedgerVersion: snapshotForDiagnostics ? String(snapshotForDiagnostics.ledgerVersion || "") : "",
          expectedLedgerVersion: expectedLedgerVersion,
          runtimeSignature: snapshotForDiagnostics ? String(snapshotForDiagnostics.runtimeSignature || "") : "",
          expectedSignature: expectedSignature,
          periodActive: !!periodActive,
          snapshotPeriodActive: snapshotForDiagnostics ? snapshotForDiagnostics.periodActive === true : false,
          snapshotPeriod: snapshotPeriod,
          selectedPeriod: selectedPeriod || null
        }, extra || {}));
      } catch(eFailLog) {}
      try {
        console.warn("[card-snapshot][validation-failed]", Object.assign({
          reason: out.reason,
          snapshotMode: snapshotForDiagnostics ? String(snapshotForDiagnostics.snapshotMode || "legacy") : "",
          currentPeriodActive: !!periodActive,
          currentPeriod: periodActive && selectedPeriod ? { from: String(selectedPeriod.from || ""), to: String(selectedPeriod.to || "") } : null,
          snapshotPeriod: snapshotForDiagnostics && snapshotForDiagnostics.period && typeof snapshotForDiagnostics.period === "object" ? snapshotForDiagnostics.period : null
        }, extra || {}));
      } catch(eValidationFailLog) {}
      try {
        window.dispatchEvent(new CustomEvent("jkh:card-snapshot-invalid", { detail: Object.assign({ reason: out.reason }, extra || {}) }));
      } catch(eEvent) {}
      return out;
    }
    if (!window.Data || typeof Data.readCardSnapshot !== "function") return dispatchInvalid("CARD_SNAPSHOT_MISSING");
    const id = String(getAbonentId() || "");
    const freshPostRecalcRowsById = getFreshPostRecalcSnapshotRows(expectedLedgerVersion, periodActive, selectedPeriod, expectedSignature);
    if (freshPostRecalcRowsById) {
      applyRuntimeRowsById(rows, freshPostRecalcRowsById);
      out.valid = true;
      out.reason = "";
      out.dataById = freshPostRecalcRowsById;
      out.periodMatches = true;
      try {
        window.dispatchEvent(new CustomEvent("jkh:card-snapshot-valid", {
          detail: {
            uid: id,
            ledgerVersion: expectedLedgerVersion,
            runtimeSignature: expectedSignature,
            periodActive: !!periodActive,
            selectedPeriod: selectedPeriod || null,
            rowsByIdCount: Object.keys(freshPostRecalcRowsById).length,
            source: "post-recalc-memory"
          }
        }));
      } catch(eMemoryEvent) {}
      return out;
    }
    const snapshot = Data.readCardSnapshot(id);
    snapshotForDiagnostics = snapshot;
    if (!snapshot) return dispatchInvalid("CARD_SNAPSHOT_MISSING");
    const snapshotModeRaw = String(snapshot.snapshotMode || "").trim().toLowerCase();
    const snapshotMode = snapshotModeRaw === "full" || snapshotModeRaw === "period" ? snapshotModeRaw : "legacy";
    const snapshotPeriod = snapshot.period && typeof snapshot.period === "object" ? { from: String(snapshot.period.from || ""), to: String(snapshot.period.to || "") } : null;
    const currentPeriod = periodActive && selectedPeriod ? { from: String(selectedPeriod.from || ""), to: String(selectedPeriod.to || "") } : null;
    try {
      console.log("[card-snapshot][contract]", {
        snapshotMode: snapshotMode,
        snapshotPeriodActive: snapshot.periodActive === true,
        snapshotPeriod: snapshotPeriod,
        currentPeriodActive: !!periodActive,
        currentPeriod: currentPeriod,
        ledgerVersion: expectedLedgerVersion,
        snapshotLedgerVersion: String(snapshot.ledgerVersion || "")
      });
    } catch(eContractLog) {}
    if (snapshot.dirty === true) {
      return dispatchInvalid(snapshot.dirtyReason || "CARD_SNAPSHOT_DIRTY");
    }
    if (String(snapshot.ledgerVersion || "") !== String(expectedLedgerVersion || "")) {
      return dispatchInvalid("CARD_SNAPSHOT_STALE", { snapshotLedgerVersion: String(snapshot.ledgerVersion || "") });
    }
    if (snapshotMode === "full" && periodActive) {
      return dispatchInvalid("CARD_SNAPSHOT_MODE_MISMATCH_FULL_VS_PERIOD", { snapshotMode: snapshotMode, currentPeriodActive: !!periodActive, currentPeriod: currentPeriod, snapshotPeriod: snapshotPeriod });
    }
    if (snapshotMode === "period" && !periodActive) {
      return dispatchInvalid("CARD_SNAPSHOT_PERIOD_MISMATCH", { snapshotMode: snapshotMode, currentPeriodActive: !!periodActive, currentPeriod: currentPeriod, snapshotPeriod: snapshotPeriod });
    }
    if (snapshotMode === "legacy" && periodActive) {
      return dispatchInvalid("CARD_SNAPSHOT_LEGACY_MODE_AMBIGUOUS", { snapshotMode: snapshotMode, currentPeriodActive: !!periodActive, currentPeriod: currentPeriod, snapshotPeriod: snapshotPeriod });
    }
    if (snapshotMode === "period" && snapshot.periodActive !== true) {
      return dispatchInvalid("CARD_SNAPSHOT_PERIOD_MISMATCH", { snapshotMode: snapshotMode, currentPeriodActive: !!periodActive, currentPeriod: currentPeriod, snapshotPeriod: snapshotPeriod });
    }
    if (snapshotMode === "full" && snapshot.periodActive === true) {
      return dispatchInvalid("CARD_SNAPSHOT_MODE_MISMATCH_FULL_VS_PERIOD", { snapshotMode: snapshotMode, currentPeriodActive: !!periodActive, currentPeriod: currentPeriod, snapshotPeriod: snapshotPeriod });
    }
    const expectedPeriod = periodActive && selectedPeriod ? selectedPeriod : null;
    if (snapshotMode === "period" && (!snapshotPeriod || String(snapshotPeriod.from || "") !== String(expectedPeriod && expectedPeriod.from || "") || String(snapshotPeriod.to || "") !== String(expectedPeriod && expectedPeriod.to || ""))) {
      return dispatchInvalid("CARD_SNAPSHOT_PERIOD_MISMATCH", { snapshotMode: snapshotMode, currentPeriodActive: !!periodActive, currentPeriod: currentPeriod, snapshotPeriod: snapshotPeriod });
    }
    if (expectedSignature && snapshot.runtimeSignature && String(snapshot.runtimeSignature) !== String(expectedSignature)) {
      return dispatchInvalid("CARD_SNAPSHOT_STALE", { reasonDetail: "CARD_SNAPSHOT_SIGNATURE_MISMATCH" });
    }
    const map = snapshot.rowsById && typeof snapshot.rowsById === "object" && !Array.isArray(snapshot.rowsById) ? snapshot.rowsById : {};
    const mapKeys = Object.keys(map);
    if (!mapKeys.length) return dispatchInvalid("CARD_SNAPSHOT_ROWS_MISSING", { rowsByIdCount: 0 });
    applyRuntimeRowsById(rows, map);
    const visibleFinancialRows = window.Data && typeof Data.getVisibleFinancialRowsForCacheValidation === "function"
      ? Data.getVisibleFinancialRowsForCacheValidation(rows, { periodActive: !!periodActive, selectedPeriod: selectedPeriod })
      : (Array.isArray(rows) ? rows : []).filter(function(r){ return Math.abs(toNum(r && r.accrued || 0)) > 0.0000001 || Math.abs(toNum(r && r.paid || 0)) > 0.0000001; });
    let appliedCount = 0;
    let finiteComputedCount = 0;
    let nonZeroComputedCount = 0;
    const missingIds = [];
    visibleFinancialRows.forEach(function(r){
      const rowId = String(r && r.id || "");
      const item = map[rowId] || null;
      if (!rowId || !item) {
        if (rowId) missingIds.push(rowId);
        return;
      }
      appliedCount++;
      const pm = Number(r.pay_main);
      const pp = Number(r.pay_penalty);
      const total = Number(r.total);
      if (Number.isFinite(pm) && Number.isFinite(pp) && Number.isFinite(total)) {
        finiteComputedCount++;
        if (Math.abs(pm) > 0.0000001 || Math.abs(pp) > 0.0000001 || Math.abs(total) > 0.0000001) nonZeroComputedCount++;
      }
    });
    if (visibleFinancialRows.length && missingIds.length) return dispatchInvalid("CARD_SNAPSHOT_ROWS_NOT_APPLIED", { rowsByIdCount: mapKeys.length, visibleFinancialRowsCount: visibleFinancialRows.length, missingRowsCount: missingIds.length, missingRows: missingIds.slice(0, 20) });
    if (visibleFinancialRows.length && (!appliedCount || !finiteComputedCount)) return dispatchInvalid("CARD_SNAPSHOT_ROWS_NOT_APPLIED", { rowsByIdCount: mapKeys.length, visibleFinancialRowsCount: visibleFinancialRows.length, appliedCount: appliedCount, finiteComputedCount: finiteComputedCount });
    if (visibleFinancialRows.length && nonZeroComputedCount <= 0) return dispatchInvalid("CARD_SNAPSHOT_ROWS_NOT_APPLIED", { rowsByIdCount: mapKeys.length, visibleFinancialRowsCount: visibleFinancialRows.length, appliedCount: appliedCount, finiteComputedCount: finiteComputedCount, nonZeroComputedCount: nonZeroComputedCount });
    out.valid = true;
    out.reason = "";
    out.dataById = map;
    out.periodMatches = true;
    try {
      console.log("[card-snapshot][applied]", {
        uid: id,
        ledgerVersion: expectedLedgerVersion,
        runtimeSignature: expectedSignature,
        periodActive: !!periodActive,
        selectedPeriod: selectedPeriod || null,
        rowsByIdCount: Object.keys(map).length
      });
      logCardReloadRestoreRowsSource("card_snapshot", rows, map, {
        uid: id,
        reason: "valid",
        snapshotStatus: "fresh",
        snapshotReason: "",
        ledgerVersion: expectedLedgerVersion,
        snapshotLedgerVersion: String(snapshot.ledgerVersion || ""),
        runtimeSignature: expectedSignature,
        periodActive: !!periodActive,
        selectedPeriod: selectedPeriod || null,
        rowsByIdCount: Object.keys(map).length
      });
    } catch(eLog) {}
    try { console.log("[card-snapshot][validation-ok]", { snapshotMode: snapshotMode, rowsByIdCount: Object.keys(map).length }); } catch(eValidationOkLog) {}
    try {
      window.dispatchEvent(new CustomEvent("jkh:card-snapshot-valid", {
        detail: {
          uid: id,
          ledgerVersion: expectedLedgerVersion,
          runtimeSignature: expectedSignature,
          periodActive: !!periodActive,
          selectedPeriod: selectedPeriod || null,
          rowsByIdCount: Object.keys(map).length
        }
      }));
    } catch(eEvent) {}
    return out;
  }

  function tryApplyDisplayOnlyCardSnapshotRows(rows, reason, periodActive, selectedPeriod, expectedLedgerVersion, expectedSignature){
    const out = { valid: false, reason: reason || "CARD_SNAPSHOT_DISPLAY_ONLY", dataById: {}, periodMatches: false, missingRows: [] };
    if (!window.Data || typeof Data.readCardSnapshot !== "function") return out;
    const id = String(getAbonentId() || "");
    const snapshot = Data.readCardSnapshot(id);
    const map = snapshot && snapshot.rowsById && typeof snapshot.rowsById === "object" && !Array.isArray(snapshot.rowsById) ? snapshot.rowsById : null;
    if (!map || !Object.keys(map).length) return out;
    const rawStatsBeforeApply = computedRowsStats(rows, null);
    applyRuntimeRowsById(rows, map);
    out.dataById = map;
    out.reason = String(snapshot.dirtyReason || snapshot.summary_reason || reason || "CARD_SNAPSHOT_DISPLAY_ONLY");
    try {
      const stats = logCardReloadRestoreRowsSource(snapshot.dirty === true ? "dirty_card_snapshot" : "card_snapshot_display_only", rows, map, {
        uid: id,
        reason: out.reason,
        snapshotStatus: snapshot.dirty === true ? "dirty" : "display_only",
        snapshotReason: out.reason,
        ledgerVersion: String(expectedLedgerVersion || ""),
        snapshotLedgerVersion: String(snapshot.ledgerVersion || ""),
        runtimeSignature: String(expectedSignature || ""),
        periodActive: !!periodActive,
        selectedPeriod: selectedPeriod || null,
        rowsByIdCount: Object.keys(map).length
      });
      console.warn("[card-reload][dirty-snapshot-display-fallback]", {
        uid: id,
        rowsCount: stats.rowsCount,
        reason: out.reason
      });
      console.warn("[card-reload][prevent-zero-overwrite]", {
        uid: id,
        oldRowsWithTotals: stats.rowsWithTotals,
        newRowsWithZeroTotals: rawStatsBeforeApply.rowsWithZeroTotals
      });
    } catch(eRestoreRowsLog) {}
    return out;
  }

  function applyRuntimeCacheToRows(rows, periodActiveOverride, selectedPeriodOverride){
    const out = { valid: false, reason: "", dataById: {}, periodMatches: false, missingRows: [] };
    if (!isReadonlyNoRecalcMode()) return out;
    const id = String(getAbonentId() || "");
    if (!id || !window.Data) { out.reason = "no-abonent"; return out; }
    const periodActive = (typeof periodActiveOverride === "boolean") ? periodActiveOverride : isCalcPeriodActive();
    const selectedPeriod = selectedPeriodOverride || (periodActive ? getCalcPeriod() : null);
    const version = (typeof Data.computeLedgerRuntimeVersion === "function") ? String(Data.computeLedgerRuntimeVersion(id) || "") : "";
    const expectedSignature = runtimeCacheSignature(version, periodActive, selectedPeriod);
    const validationOptions = {
      rows: Array.isArray(rows) ? rows : [],
      visibleRows: Array.isArray(rows) && Data.getVisibleFinancialRowsForCacheValidation
        ? Data.getVisibleFinancialRowsForCacheValidation(rows, { periodActive: periodActive, selectedPeriod: selectedPeriod })
        : undefined,
      periodActive: periodActive,
      selectedPeriod: selectedPeriod,
      runtimeSignature: expectedSignature
    };
    const cache = (typeof Data.readLedgerRuntimeCache === "function") ? Data.readLedgerRuntimeCache(id, validationOptions) : null;
    const cacheVersion = cache && typeof cache === "object" ? String(cache.ledgerVersion || "") : "";
    const map = cache && cache.rowsById && typeof cache.rowsById === "object" ? cache.rowsById : null;
    const validity = (typeof Data.isLedgerRuntimeCacheValid === "function") ? Data.isLedgerRuntimeCacheValid(id, cache, validationOptions) : null;
    const snapshotFirstState = tryApplyCardSnapshotToRows(rows, version, periodActive, selectedPeriod, expectedSignature);
    if (snapshotFirstState.valid) return snapshotFirstState;
    const displayOnlyFirstSnapshot = tryApplyDisplayOnlyCardSnapshotRows(rows, snapshotFirstState.reason || "CARD_SNAPSHOT_DISPLAY_ONLY", periodActive, selectedPeriod, version, expectedSignature);
    if (displayOnlyFirstSnapshot.dataById && Object.keys(displayOnlyFirstSnapshot.dataById).length) return displayOnlyFirstSnapshot;
    if (validity && validity.valid !== true) {
      const rawReason = String(validity.reason || "");
      out.reason = rawReason || "RUNTIME_CACHE_STALE";
      out.missingRows = Array.isArray(validity.missingRows) ? validity.missingRows : [];
      try {
        console.warn(out.reason === "RUNTIME_CACHE_INCOMPLETE" ? "[payment-table][runtime-cache-incomplete]" : "[runtime-cache][invalid]", {
          uid: id,
          reason: out.reason,
          ledgerVersion: version,
          runtimeSignature: expectedSignature,
          periodActive: periodActive,
          selectedPeriod: selectedPeriod || null,
          missingRowsCount: out.missingRows.length,
          missingRows: out.missingRows.slice(0, 20)
        });
      } catch(eInvalidLog) {}
      return out;
    }
    if (!version || !cache || !map || !cacheVersion || cacheVersion !== version) {
      out.reason = cache ? "RUNTIME_CACHE_STALE" : "RUNTIME_CACHE_MISSING";
      try {
        console.warn("[runtime-cache][invalid]", {
          uid: id,
          reason: out.reason,
          ledgerVersion: version,
          runtimeSignature: expectedSignature,
          periodActive: periodActive,
          selectedPeriod: selectedPeriod || null,
          missingRowsCount: 0
        });
      } catch(eFallbackInvalidLog) {}
      return out;
    }
    out.periodMatches = runtimeCachePeriodMatches(cache, version, periodActive, selectedPeriod);
    if (!out.periodMatches) {
      out.reason = "RUNTIME_CACHE_PERIOD_MISMATCH";
      try {
        console.warn("[runtime-cache][invalid]", {
          uid: id,
          reason: out.reason,
          ledgerVersion: version,
          runtimeSignature: expectedSignature,
          periodActive: periodActive,
          selectedPeriod: selectedPeriod || null,
          missingRowsCount: 0
        });
      } catch(ePeriodInvalidLog) {}
      return out;
    }
    out.valid = true;
    out.dataById = map;
    applyRuntimeRowsById(rows, map);
    try {
      console.log("[runtime-cache][valid]", {
        uid: id,
        ledgerVersion: version,
        runtimeSignature: expectedSignature,
        periodActive: periodActive,
        selectedPeriod: selectedPeriod || null,
        rowsByIdCount: Object.keys(map).length,
        missingRowsCount: 0
      });
      console.log("[payment-table][runtime-cache-applied]", {
        uid: id,
        ledgerVersion: version,
        runtimeSignature: expectedSignature,
        periodActive: periodActive,
        selectedPeriod: selectedPeriod || null,
        rowsByIdCount: Object.keys(map).length
      });
      logCardReloadRestoreRowsSource("runtime_cache", rows, map, {
        uid: id,
        reason: "valid",
        snapshotStatus: "runtime_cache",
        snapshotReason: "",
        ledgerVersion: version,
        runtimeSignature: expectedSignature,
        periodActive: periodActive,
        selectedPeriod: selectedPeriod || null,
        rowsByIdCount: Object.keys(map).length
      });
    } catch(eValidLog) {}
    return out;
  }

  function inspectRuntimeCachePeriodMatch(periodActive, selectedPeriod){
    const id = String(getAbonentId() || "");
    if (!id || !window.Data) return false;
    const version = (typeof Data.computeLedgerRuntimeVersion === "function") ? String(Data.computeLedgerRuntimeVersion(id) || "") : "";
    const cache = (typeof Data.readLedgerRuntimeCache === "function") ? Data.readLedgerRuntimeCache(id) : null;
    const cacheVersion = cache && typeof cache === "object" ? String(cache.ledgerVersion || "") : "";
    const map = cache && cache.rowsById && typeof cache.rowsById === "object" ? cache.rowsById : null;
    if (!version || !cache || !map || !cacheVersion || cacheVersion !== version) return false;
    return runtimeCachePeriodMatches(cache, version, periodActive, selectedPeriod);
  }

  function notifyRuntimeCacheSummaryState(state, periodActive, selectedPeriod){
    const s = state && typeof state === "object" ? state : {};
    const detail = {
      valid: !!s.valid,
      reason: String(s.reason || ""),
      uid: String(getAbonentId() || ""),
      ledgerVersion: "",
      runtimeSignature: "",
      periodActive: !!periodActive,
      selectedPeriod: selectedPeriod || null,
      missingRows: Array.isArray(s.missingRows) ? s.missingRows : [],
      missingRowsCount: Array.isArray(s.missingRows) ? s.missingRows.length : 0,
      rowsByIdCount: s.dataById && typeof s.dataById === "object" ? Object.keys(s.dataById).length : 0,
      temporary: s.temporary === true || isTemporaryCourtPeriodMode()
    };
    try {
      if (window.Data && typeof Data.computeLedgerRuntimeVersion === "function") {
        detail.ledgerVersion = String(Data.computeLedgerRuntimeVersion(getAbonentId()) || "");
        detail.runtimeSignature = runtimeCacheSignature(detail.ledgerVersion, periodActive, selectedPeriod);
      }
      window.dispatchEvent(new CustomEvent(s.valid ? "jkh:runtime-cache-valid" : "jkh:runtime-cache-invalid", { detail: detail }));
    } catch(eState) {}
    if (!isReadonlyNoRecalcMode() || s.valid) return;
  }

  // Read-only ledger cache: parsed rows are reused while storage raw value is unchanged.
  // Corrupted ledgers are never cached as valid. Explicit writes/reloads clear the cache.
  const __ledgerReadCache = new Map();
  let __ledgerReadCacheOwner = null;
  const __paymentKeyReadLogOnce = new Set();

  function currentOwnerIdForPaymentCache(){
    try {
      if (window.JKHStore && typeof JKHStore.getOwnerId === "function") return String(JKHStore.getOwnerId() || "");
      if (window.Auth && typeof Auth.getActiveDbOwnerId === "function") return String(Auth.getActiveDbOwnerId() || "");
    } catch(e) {}
    return "";
  }

  function clearPaymentLedgerReadCache(reason){
    __ledgerReadCache.clear();
    __paymentKeyReadLogOnce.clear();
    __ledgerReadCacheOwner = currentOwnerIdForPaymentCache();
    try {
      if (window.JKH_DEBUG_PAYMENT_KEY) console.debug('[payment-key] ledger cache reset', { reason: String(reason || '') });
    } catch(e) {}
  }

  function ensurePaymentLedgerReadCacheFresh(){
    const owner = currentOwnerIdForPaymentCache();
    if (__ledgerReadCacheOwner !== owner) clearPaymentLedgerReadCache('owner-change');
  }

  function cloneLedgerRows(rows){
    if (!Array.isArray(rows)) return [];
    return rows.map(function(r){ return (r && typeof r === 'object') ? Object.assign({}, r) : r; });
  }

  function readPaymentLedgerRowsCached(key, abonentId){
    ensurePaymentLedgerReadCacheFresh();
    const serviceAbonentId = String(abonentId || getAbonentId() || "");
    if (window.Data && typeof window.Data.readPaymentLedger === "function") {
      const rowsFromApi = cloneLedgerRows(window.Data.readPaymentLedger(serviceAbonentId));
      return rowsFromApi;
    }

    const cacheKey = currentOwnerIdForPaymentCache() + '::' + String(key || '');
    const raw = storeGetRaw(key);
    if (raw === null || raw === undefined) return [];

    const cached = __ledgerReadCache.get(cacheKey);
    if (cached && cached.raw === raw && Array.isArray(cached.rows)) {
      const cachedRows = cloneLedgerRows(cached.rows);
      return cachedRows;
    }

    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        __ledgerReadCache.set(cacheKey, { raw: raw, rows: arr });
        const parsedRows = cloneLedgerRows(arr);
        return parsedRows;
      }
      logLedgerJsonInvalid(key, "parsed value is not an array");
      throw makeLedgerJsonInvalidError(key, "parsed value is not an array");
    } catch (e) {
      __ledgerReadCache.delete(cacheKey);
      if (e && e.code === "LEDGER_JSON_INVALID") throw e;
      logLedgerJsonInvalid(key, e);
      throw makeLedgerJsonInvalidError(key, e);
    }
  }

  function logPaymentKeyReadOnce(payload){
    try {
      if (!window.JKH_DEBUG_PAYMENT_KEY) return;
      const onceKey = String(payload && payload.abonentId || '') + ':' + String(payload && (payload.key || payload.reason) || '');
      if (__paymentKeyReadLogOnce.has(onceKey)) return;
      __paymentKeyReadLogOnce.add(onceKey);
      console.debug('[payment-key] read', payload);
    } catch(e) {}
  }

  window.JKHClearPaymentLedgerReadCache = clearPaymentLedgerReadCache;

  const LEDGER_FATAL_MESSAGE = "Данные платежей повреждены. Расчёт/импорт остановлен, чтобы не потерять историю платежей.";

  function makeLedgerJsonInvalidError(key, cause){
    const err = new Error(LEDGER_FATAL_MESSAGE);
    err.code = "LEDGER_JSON_INVALID";
    err.key = key || "";
    err.cause = cause;
    return err;
  }

  function logLedgerJsonInvalid(key, cause){
    console.error("[fatal][ledger-json-invalid]", { key: key || "", error: cause });
  }

  const EXCLUDES_FATAL_MESSAGE = "Исключённые периоды повреждены. Расчёт пени остановлен.";

  function isExcludesFatalError(e){
    const code = String(e && e.code || "");
    return code === "EXCLUDES_JSON_INVALID" || code === "EXCLUDES_INVALID";
  }

  function makeExcludesFatalError(code, key, details, cause){
    const err = new Error(EXCLUDES_FATAL_MESSAGE);
    err.code = code || "EXCLUDES_INVALID";
    err.key = key || "";
    err.details = details || {};
    err.cause = cause;
    return err;
  }

  function logExcludesFatal(err){
    if (window.JKHCalcEngine && typeof window.JKHCalcEngine.logExcludesFatal === "function") {
      window.JKHCalcEngine.logExcludesFatal(err);
      return;
    }
    const code = String(err && err.code || "");
    console.error("[fatal][excludes-json-invalid]", { code: code, key: err && err.key || "", details: err && err.details || {}, error: err && err.cause });
  }

  function throwExcludesFatal(code, key, details, cause){
    const err = makeExcludesFatalError(code, key, details, cause);
    logExcludesFatal(err);
    throw err;
  }

  function renderExcludesFatal(tbody){
    try { alert(EXCLUDES_FATAL_MESSAGE); } catch (_) {}
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="20" style="color:#b00020;font-weight:700;">' + EXCLUDES_FATAL_MESSAGE + '</td></tr>';
    }
  }

  const RATES_FATAL_MESSAGE = "Ставки рефинансирования отсутствуют или повреждены. Расчёт пени остановлен.";
  const RATES_FATAL_LEDGER_VISIBLE_MESSAGE = "Ставки рефинансирования отсутствуют или повреждены. Начисления показаны, пеня и итоговый summary не рассчитаны.";

  function isRatesFatalError(e){
    const code = String(e && e.code || "");
    return code === "RATES_MISSING" || code === "RATES_JSON_INVALID" || code === "MISSING_REQUIRED_RATE";
  }

  function makeRatesFatalError(code, key, details){
    const err = new Error(RATES_FATAL_MESSAGE);
    err.code = code || "RATES_ERROR";
    err.key = key || "";
    err.details = details || {};
    return err;
  }

  function logRatesFatal(err){
    const code = String(err && err.code || "");
    const tag = (code === "RATES_JSON_INVALID") ? "[fatal][rates-json-invalid]" :
      (code === "MISSING_REQUIRED_RATE" ? "[fatal][missing-required-rate]" :
      (code === "RATES_MISSING" ? "[fatal][rates-missing]" : "[fatal][rates-error]"));
    console.error(tag, { code: code, key: err && err.key || "", details: err && err.details || {} });
  }

  function parseRatesDiagnostic(raw){
    const out = { count: 0, first: null, last: null };
    if (raw === null || raw === undefined) return out;
    try {
      const arr = JSON.parse(String(raw || ""));
      if (!Array.isArray(arr)) return out;
      const normalized = arr.map(function(item){
        return {
          from: String(item && (item.from || item.dateFrom || item.start || item.fromISO || item.from_iso) || ""),
          rate: item && (item.rate !== undefined ? item.rate : item.value)
        };
      }).filter(function(item){ return item.from || item.rate !== undefined; });
      normalized.sort(function(a, b){ return String(a.from || "").localeCompare(String(b.from || "")); });
      out.count = normalized.length;
      out.first = normalized.length ? normalized[0] : null;
      out.last = normalized.length ? normalized[normalized.length - 1] : null;
    } catch(eParse) {}
    return out;
  }

  function ratesDiagnosticShape(raw){
    const out = { isArray: false, count: 0, firstKeys: [] };
    if (raw === null || raw === undefined) return out;
    try {
      const parsed = JSON.parse(String(raw || ""));
      out.isArray = Array.isArray(parsed);
      out.count = Array.isArray(parsed) ? parsed.length : 0;
      if (Array.isArray(parsed) && parsed.length && parsed[0] && typeof parsed[0] === "object") out.firstKeys = Object.keys(parsed[0]).slice(0, 12);
      else if (parsed && typeof parsed === "object") out.firstKeys = Object.keys(parsed).slice(0, 12);
    } catch(eShape) {
      out.parseError = String(eShape && eShape.message || eShape);
    }
    return out;
  }

  function ratesDiagnosticStorageKey(baseKey, ownerId){
    try {
      if (window.JKHStore && typeof JKHStore.key === "function") return JKHStore.key(baseKey, ownerId);
    } catch(eKey) {}
    return String(baseKey || "");
  }

  function ratesDiagnosticRaw(baseKey, ownerId){
    try {
      if (window.JKHStore && typeof JKHStore.getRaw === "function") return JKHStore.getRaw(baseKey, ownerId);
    } catch(eStore) {}
    try {
      const storageKey = ratesDiagnosticStorageKey(baseKey, ownerId);
      if (storageKey && window.localStorage) return localStorage.getItem(storageKey);
    } catch(eLs) {}
    return null;
  }

  function emitManualRatesDiagnostic(err, source){
    try {
      const rawOwnerId = currentOwnerIdForPaymentCache();
      const ownerId = (window.JKHStore && typeof JKHStore.normalizeOwnerId === "function") ? JKHStore.normalizeOwnerId(rawOwnerId) : String(rawOwnerId || "").replace(/^(LAB|PROD):/i, "");
      let activeOwnerId = ownerId;
      try {
        if (window.Auth && typeof Auth.getActiveDbOwnerId === "function") activeOwnerId = (window.JKHStore && typeof JKHStore.normalizeOwnerId === "function") ? JKHStore.normalizeOwnerId(Auth.getActiveDbOwnerId()) : String(Auth.getActiveDbOwnerId() || "");
      } catch(eActiveOwner) {}
      let envType = "";
      try { envType = window.JKHStore && typeof JKHStore.getEnvType === "function" ? String(JKHStore.getEnvType() || "") : ""; } catch(eEnv) {}
      const normalBase = REFI_KEY_NORMAL;
      const moraBase = REFI_KEY_MORA;
      const legacyNormal = "refinancing_v1";
      const ownerNormal = "ref_rates_" + ownerId;
      const ownerMora = "ref_rates_moratorium_" + ownerId;
      const normalKeys = [normalBase, ratesDiagnosticStorageKey(normalBase, "GLOBAL"), ratesDiagnosticStorageKey(normalBase, ownerId), ownerNormal, legacyNormal];
      const moraKeys = [moraBase, ratesDiagnosticStorageKey(moraBase, "GLOBAL"), ratesDiagnosticStorageKey(moraBase, ownerId), ownerMora];
      let rawNormal = ratesDiagnosticRaw(normalBase, "GLOBAL");
      if (rawNormal === null || rawNormal === undefined) rawNormal = ratesDiagnosticRaw(normalBase, ownerId);
      if (rawNormal === null || rawNormal === undefined) rawNormal = ratesDiagnosticRaw(ownerNormal, ownerId);
      if (rawNormal === null || rawNormal === undefined) rawNormal = ratesDiagnosticRaw(legacyNormal, ownerId);
      let rawMora = ratesDiagnosticRaw(moraBase, "GLOBAL");
      if (rawMora === null || rawMora === undefined) rawMora = ratesDiagnosticRaw(moraBase, ownerId);
      if (rawMora === null || rawMora === undefined) rawMora = ratesDiagnosticRaw(ownerMora, ownerId);
      const parsedNormal = parseRatesDiagnostic(rawNormal);
      const parsedMora = parseRatesDiagnostic(rawMora);
      const shapeNormal = ratesDiagnosticShape(rawNormal);
      const shapeMora = ratesDiagnosticShape(rawMora);
      const period = getCalcPeriod();
      const payload = {
        uid: String(getAbonentTechnicalId() || ""),
        abonentId: String(getAbonentId() || ""),
        ownerId: ownerId,
        activeOwnerId: activeOwnerId,
        envType: envType,
        moratorium: isMoratoriumActive(),
        requestedDate: String(err && err.details && err.details.date || ""),
        periodFrom: String(period && period.from || ""),
        periodTo: String(period && period.to || ""),
        normalKeysChecked: normalKeys,
        moratoriumKeysChecked: moraKeys,
        rawNormalExists: rawNormal !== null && rawNormal !== undefined,
        rawMoratoriumExists: rawMora !== null && rawMora !== undefined,
        normalShape: shapeNormal,
        moratoriumShape: shapeMora,
        parsedNormalCount: parsedNormal.count,
        parsedMoratoriumCount: parsedMora.count,
        firstNormalRate: parsedNormal.first,
        lastNormalRate: parsedNormal.last,
        firstMoratoriumRate: parsedMora.first,
        lastMoratoriumRate: parsedMora.last,
        hasCalcEngineLoadRates: !!(window.JKHCalcEngine && typeof window.JKHCalcEngine.loadRates === "function"),
        calcInputAssembly: "payment_table.loadRates_or_JKHCalcEngine.loadRates",
        source: String(source || "payment_table.throwRatesFatal"),
        reason: String(err && err.code || "")
      };
      console.log("[manual-recalc][rates]", payload);
      if (typeof fetch === "function") {
        [
          { kind: "normal", key: normalBase },
          { kind: "moratorium", key: moraBase }
        ].forEach(function(item){
          const url = "/api/store?key=" + encodeURIComponent(item.key) + "&client_owner_hint=" + encodeURIComponent(ownerId);
          fetch(url, { method: "GET", credentials: "include" })
            .then(function(res){ return res.text().then(function(text){
              let data = null;
              try { data = JSON.parse(text); } catch(eJson) {}
              const parsed = parseRatesDiagnostic(data && data.value);
              const shape = ratesDiagnosticShape(data && data.value);
              const serverHasRates = !!(res.ok && data && data.ok === true && parsed.count > 0);
              console.log("[manual-recalc][rates]", Object.assign({}, payload, {
                rawNormalExists: item.kind === "normal" ? data && data.value !== null && data.value !== undefined : payload.rawNormalExists,
                rawMoratoriumExists: item.kind === "moratorium" ? data && data.value !== null && data.value !== undefined : payload.rawMoratoriumExists,
                normalShape: item.kind === "normal" ? shape : payload.normalShape,
                moratoriumShape: item.kind === "moratorium" ? shape : payload.moratoriumShape,
                parsedNormalCount: item.kind === "normal" ? parsed.count : payload.parsedNormalCount,
                parsedMoratoriumCount: item.kind === "moratorium" ? parsed.count : payload.parsedMoratoriumCount,
                firstNormalRate: item.kind === "normal" ? parsed.first : payload.firstNormalRate,
                lastNormalRate: item.kind === "normal" ? parsed.last : payload.lastNormalRate,
                firstMoratoriumRate: item.kind === "moratorium" ? parsed.first : payload.firstMoratoriumRate,
                lastMoratoriumRate: item.kind === "moratorium" ? parsed.last : payload.lastMoratoriumRate,
                source: "server:/api/store:" + item.kind,
                serverOk: !!(res.ok && data && data.ok === true),
                serverOwner: String(data && data.owner || ""),
                requestedKey: item.key,
                returnedKeysCount: data && data.value !== null && data.value !== undefined ? 1 : 0,
                hasRefinancingRatesNormalV1: item.kind === "normal" && serverHasRates,
                hasRefinancingRatesMoratoriumV1: item.kind === "moratorium" && serverHasRates,
                localExistsFalseExpected: item.kind === "normal" ? payload.rawNormalExists === false && serverHasRates : payload.rawMoratoriumExists === false && serverHasRates,
                reason: serverHasRates ? "diagnose_rates_backend_exists" : (res.ok && data && data.ok === true ? "diagnose_rates_backend_shape_mismatch" : "diagnose_rates_backend_missing")
              }));
            }); })
            .catch(function(eFetch){
              console.log("[manual-recalc][rates]", Object.assign({}, payload, { source: "server:/api/store:" + item.kind, reason: "SERVER_RATE_READ_EXCEPTION:" + String(eFetch && eFetch.message || eFetch) }));
            });
        });
      }
    } catch(eDiag) {}
  }

  function throwRatesFatal(code, key, details){
    const err = makeRatesFatalError(code, key, details);
    logRatesFatal(err);
    emitManualRatesDiagnostic(err, "payment_table.throwRatesFatal");
    throw err;
  }

  function renderRatesFatal(tbody){
    try { alert(RATES_FATAL_MESSAGE); } catch (_) {}
    const hasRows = !!(tbody && tbody.querySelector && tbody.querySelector("tr[data-row-id]"));
    const statusBox = qs("#paymentTableStatus") || qs("#paymentStatus") || qs("#paymentsStatus");
    if (hasRows) {
      if (statusBox) statusBox.textContent = RATES_FATAL_LEDGER_VISIBLE_MESSAGE;
      try { console.warn("[payment-table][rates-fatal-rows-preserved]", { rows: tbody.querySelectorAll("tr[data-row-id]").length }); } catch(ePreserveLog) {}
    } else if (tbody) {
      tbody.innerHTML = '<tr><td colspan="20" style="color:#b00020;font-weight:700;">' + RATES_FATAL_MESSAGE + ' Строки ledger недоступны.</td></tr>';
      if (statusBox) statusBox.textContent = RATES_FATAL_MESSAGE + " Строки ledger недоступны.";
    }
  }

  // ===========================
  // UI: сворачиваемые блоки месяца (ledger)
  // хранение состояния: `payments_ui_collapsed_<LS>` -> {"YYYY-MM": true/false}
  function collapseStoreKey() {
    return `payments_ui_collapsed_${getAbonentId()}`;
  }
  function loadCollapsedMap() {
    try { return JSON.parse(storeGetRaw(collapseStoreKey()) || "{}") || {}; } catch { return {}; }
  }
  function saveCollapsedMap(map) {
    storeSetRaw(collapseStoreKey(), JSON.stringify(map || {}));
  }
  function ymKeyOfRow(r) {
    return `${String(r.year)}-${pad2(Number(r.month))}`;
  }
  let __collapsedMonths = null;   // lazy-loaded per page
  let __monthHasPayments = null;  // recalculated in loadPaymentTable()

  function toNum(v) {
    const n = parseFloat(String(v ?? "").replace(",", "."));
    return isNaN(n) ? 0 : n;
  }
  function r2(x) { return Math.round(x * 100) / 100; }
  function fmtMoney(v){ return r2(toNum(v)).toFixed(2); }

  // =============================================================
  // CRITICAL UI (ПАПАЖКХ):
  // 1) Ввод суммы "Оплачено": запятая -> точка, нули должны заменяться полностью,
  //    отображение: если копеек нет — показываем без .00; если есть — без лишних нулей.
  // 2) Дата оплаты (type=date): НЕЛЬЗЯ перерисовывать строку на каждый input,
  //    иначе календарь "срывается" при прокрутке. Перерисовка — ТОЛЬКО на change.
  // 3) Строка начисления (accrued>0): поле "Оплачено" показывает сумму оплат месяца,
  //    но без даты/источника; строка НЕудаляемая и НЕредактируемая.
  // 4) Excel-импорт (locked): удаление/редактирование запрещено.
  // =============================================================
  function fmtMoneyHuman(v){
    const n = r2(toNum(v));
    if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
    return n.toFixed(2).replace(/0+$/,'').replace(/\.$/,'');
  }

  function isAccrualRowGlobal(r){
    return toNum(r?.accrued ?? 0) > 0.0000001;
  }

  let __monthPaidSum = null; // recalculated in loadPaymentTable()


  // =========================
  // ИСТОЧНИК ПЛАТЕЖА (source)
  // =========================
  // Справочник источников хранится на уровне owner. Нельзя делать GLOBAL, потому что импорт платежей использует source_index текущей базы.
  // По умолчанию: «Платёж 1/2/3».
  const PAYMENT_SOURCES_KEY = 'payment_sources_v1';

  function defaultPaymentSources(){
    return ['Платёж 1','Платёж 2','Платёж 3'];
  }

  function loadPaymentSources(){
    try {
      const raw = storeGetRaw(PAYMENT_SOURCES_KEY);
      if (!raw) return defaultPaymentSources();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return defaultPaymentSources();
      const cleaned = arr.map(x => String(x||'').trim()).filter(Boolean);
      return cleaned.length ? cleaned : defaultPaymentSources();
    } catch {
      return defaultPaymentSources();
    }
  }

  let __paymentSourcesUploadTimer = null;
  let __paymentSourcesLastValueForUpload = '';

  async function uploadPaymentSourcesKeyToServer(value){
    const rawOwnerId = (window.JKHStore && typeof JKHStore.getOwnerId === 'function') ? String(JKHStore.getOwnerId() || '').trim() : '';
    const ownerId = (window.JKHStore && typeof JKHStore.normalizeOwnerId === 'function') ? JKHStore.normalizeOwnerId(rawOwnerId) : rawOwnerId.replace(/^(LAB|PROD):/i, '');
    if (!ownerId || ownerId === 'guest' || ownerId === 'ALL') {
      throw new Error('PAYMENT_SOURCES_UPLOAD_FORBIDDEN_OWNER');
    }
    const payload = {
      client_owner_hint: ownerId,
      key: PAYMENT_SOURCES_KEY,
      value: String(value ?? '')
    };
    let res;
    try {
      res = await fetch('/api/store', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      throw new Error('PAYMENT_SOURCES_UPLOAD_NETWORK_ERROR');
    }
    if (!res || !res.ok) {
      throw new Error('PAYMENT_SOURCES_UPLOAD_HTTP_ERROR');
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!(data && data.ok === true)) {
      throw new Error('PAYMENT_SOURCES_UPLOAD_API_ERROR');
    }
    console.info('[payment_sources] owner=%s uploaded key=payment_sources_v1 size=%s', ownerId, String(payload.value || '').length);
  }

  function schedulePaymentSourcesUpload(value){
    __paymentSourcesLastValueForUpload = String(value ?? '');
    if (__paymentSourcesUploadTimer) clearTimeout(__paymentSourcesUploadTimer);
    __paymentSourcesUploadTimer = setTimeout(async () => {
      __paymentSourcesUploadTimer = null;
      try {
        await uploadPaymentSourcesKeyToServer(__paymentSourcesLastValueForUpload);
      } catch (e) {
        console.warn('[payment_sources] upload failed', e);
      }
    }, 800);
  }

  function savePaymentSources(arr){
    const cleaned = (arr||[]).map(x => String(x||'').trim()).filter(Boolean);
    if (!cleaned.length) cleaned.push(...defaultPaymentSources());
    const serialized = JSON.stringify(cleaned);
    storeSetRaw(PAYMENT_SOURCES_KEY, serialized);
    console.info('[payment_sources] owner=%s saved count=%s', (window.JKHStore && typeof JKHStore.getOwnerId === 'function') ? JKHStore.getOwnerId() : 'unknown', cleaned.length);
    schedulePaymentSourcesUpload(serialized);
  }

  function ensurePaymentSources(){
    let cur = null;
    try { cur = loadPaymentSources(); } catch { cur = defaultPaymentSources(); }
    if (!cur || !cur.length){
      savePaymentSources(defaultPaymentSources());
      return defaultPaymentSources();
    }
    try {
      if (!storeGetRaw(PAYMENT_SOURCES_KEY)) savePaymentSources(cur);
    } catch(e) { console.error(e); throw e; }
    return cur;
  }

  function sourceOptionsHtml(selected){
    const sources = ensurePaymentSources();
    const sel = String(selected || '').trim();
    let html = sources.map(s => {
      const v = String(s);
      return `<option value="${escapeHtml(v)}" ${v===sel?'selected':''}>${escapeHtml(v)}</option>`;
    }).join('');
    html += `<option value="__new__">➕ новый</option>`;
    return html;
  }

// =======================================================
// CRITICAL: Пропорциональное разделение начисления по дням
// при смене владельца (ответственного)
// =======================================================

function daysInMonth(year, month1to12) {
  return new Date(year, month1to12, 0).getDate();
}

// history = [{ abonentId, from:'YYYY-MM-DD', to:'YYYY-MM-DD|null' }]
function splitAccrualByOwnership(accr, year, month, history) {
  if (!Array.isArray(history) || history.length === 0) {
    return [];
  }

  const dim = daysInMonth(year, month);
  const mStart = new Date(year, month - 1, 1);
  const mEnd   = new Date(year, month - 1, dim);

  const parts = [];

  for (const h of history) {
    const from = h.from ? new Date(h.from) : mStart;
    const to   = h.to   ? new Date(h.to)   : mEnd;

    const a = new Date(Math.max(from, mStart));
    const b = new Date(Math.min(to, mEnd));

    if (b < a) continue;

    const ownedDays = Math.floor((b - a) / 86400000) + 1;
    const amount = r2(accr * ownedDays / dim);

    parts.push({
      abonentId: h.abonentId,
      amount,
      ownedDays
    });
  }

  return parts;
}

function prorateAccrualByRange(accr, year, month, range) {
  const dim = daysInMonth(year, month);
  const mStart = new Date(year, month - 1, 1);
  const mEnd = new Date(year, month - 1, dim);
  const from = range && range.from ? new Date(range.from) : mStart;
  const to = range && range.to ? new Date(range.to) : mEnd;
  const a = new Date(Math.max(from, mStart));
  const b = new Date(Math.min(to, mEnd));
  if (b < a) return 0;
  const days = Math.floor((b - a) / 86400000) + 1;
  return r2(accr * days / dim);
}

  // =========================
  // МЕСЯЦА (для вывода "ЯНВАРЬ 2026")
  // =========================
  const RU_MONTHS_UP = {
    "01": "ЯНВАРЬ",
    "02": "ФЕВРАЛЬ",
    "03": "МАРТ",
    "04": "АПРЕЛЬ",
    "05": "МАЙ",
    "06": "ИЮНЬ",
    "07": "ИЮЛЬ",
    "08": "АВГУСТ",
    "09": "СЕНТЯБРЬ",
    "10": "ОКТЯБРЬ",
    "11": "НОЯБРЬ",
    "12": "ДЕКАБРЬ"
  };

  function ymText(month, year) {
    const mm = pad2(month);
    const name = RU_MONTHS_UP[mm] || mm;
    return `${name} ${year || ""}`.trim();
  }

  // =========================
  // ДАТЫ: поддержка ISO и ДД.ММ.ГГГГ
  // =========================
  function parseDateAnyToDate(value) {
    if (value === null || value === undefined) return null;

    // Excel serial может приехать как number или как строка "45234"
    const tryExcelSerial = (v) => {
      const n = (typeof v === 'number')
        ? v
        : (typeof v === 'string' && v.trim() && /^[0-9]+(\.[0-9]+)?$/.test(v.trim()) ? Number(v.trim()) : NaN);
      if (!isFinite(n)) return null;
      // разумный диапазон Excel-дат
      if (n < 20000 || n > 90000) return null;

      // Excel epoch: 1899-12-30
      const ms = Math.round((n - 25569) * 86400 * 1000);
      const dt = new Date(ms);
      const y = dt.getUTCFullYear();
      const m = dt.getUTCMonth();
      const d = dt.getUTCDate();
      const out = new Date(y, m, d, 12, 0, 0);
      return isNaN(out) ? null : out;
    };

    const excelDt = tryExcelSerial(value);
    if (excelDt) return excelDt;

    const s = String(value).trim();
    if (!s) return null;

    // CRITICAL: ISO-дата вида YYYY-MM-DD — это календарная дата (без времени).
    // НЕЛЬЗЯ парсить её через new Date(iso) — браузер воспринимает ISO как UTC.
    // В часовых поясах UTC+ (например, Россия) это может сдвигать дату на -1 день.
    // Поэтому ISO разбираем вручную и создаём Date(y, m-1, d) в 12:00 (без сдвига).

    // ISO: YYYY-MM-DD
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      const dt = new Date(y, mo - 1, d, 12, 0, 0);
      return isNaN(dt) ? null : dt;
    }

    // RU: DD.MM.YYYY (допускаем 1-2 цифры)
    m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) {
      const dd = Number(m[1]);
      const mm = Number(m[2]);
      const yy = Number(m[3]);
      const dt = new Date(yy, mm - 1, dd, 12, 0, 0);
      return isNaN(dt) ? null : dt;
    }

    // Fallback: любые другие форматы (на всякий)
    const d2 = new Date(s);
    if (isNaN(d2)) return null;
    return new Date(d2.getFullYear(), d2.getMonth(), d2.getDate(), 12, 0, 0);
  }


  function toISODateString(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function paidDateMs(row) {
    const d = parseDateAnyToDate(row?.paid_date);
    return d ? d.getTime() : 0;
  }

  // для сортировки "по возрастанию": пустые даты должны идти в конце
  function paidDateMsAscKey(row) {
    const d = parseDateAnyToDate(row?.paid_date);
    return d ? d.getTime() : Number.POSITIVE_INFINITY;
  }

  function normalizePaidDateISO(row) {
    const d = parseDateAnyToDate(row?.paid_date);
    if (!d) return;
    row.paid_date = toISODateString(d);
  }
  // =========================

  function showAbonentIdRequiredError() {
    const msg = "Не передан параметр abonent в URL. Загрузка карточки платежей остановлена.";
    try { console.warn("[readonly][blocked-write-path]", { page: "payment_table", reason: "MISSING_ABONENT_ID" }); } catch(e) {}
    const tbody = qs("#paymentTableBody");
    if (tbody) tbody.innerHTML = '<tr><td colspan="12" style="color:#b00000;font-weight:bold;">' + msg + '</td></tr>';
    const box = qs("#paymentTableStatus") || qs("#paymentStatus") || qs("#paymentsStatus");
    if (box) box.textContent = msg;
  }

  function getAbonentId() {
    const p = new URLSearchParams(window.location.search);
    const fromUrl = String(p.get("abonent") || "").trim();
    if (fromUrl) return fromUrl;
    showAbonentIdRequiredError();
    return "";
  }
  function getAbonentTechnicalId() {
    const id = String(getAbonentId() || "");
    if (typeof window.getAbonentTechId === "function") return window.getAbonentTechId(id);
    return id;
  }

  function paymentsKey() {
    const id = String(getAbonentId() || "");
    const key = (window.Data && typeof window.Data.resolvePaymentLedgerKey === "function")
      ? window.Data.resolvePaymentLedgerKey(id)
      : (window.getPaymentsKeyForAbonent ? window.getPaymentsKeyForAbonent(id) : "");

    if (!key) {
      logPaymentKeyReadOnce({ abonentId: id, reason: "ABONENT_NOT_READY" });
      return "";
    }

    logPaymentKeyReadOnce({ abonentId: id, key: key });
    return key;
  }

  /* =========================================================
     АВТО-НАЧИСЛЕНИЕ (тарифы × площадь) по периоду ответственности
     Правила:
     - В одном месяце только одно начисление
     - Если в месяце несколько строк оплат: начисление только у строки с минимальным ID, остальные accrued = 0
     - Если строки за месяц нет: создаём строку с accrued и paid=0
     ========================================================= */

  function toNum(v){ const n = parseFloat(String(v ?? "").replace(",", ".")); return isFinite(n) ? n : 0; }

  function parseAnyDateToISO(d){
    const s = String(d || "").trim();
    if (!s) return "";
    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // DD.MM.YYYY (допускаем 1-2 цифры в дне/месяце)
    const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
    return "";
  }

  function ymKeyFromMY(month, year){ return `${pad2(month)}.${year}`; }

  function monthIter(startISO, endISO){
    const s = parseAnyDateToISO(startISO);
    const e = parseAnyDateToISO(endISO) || toISODateString(new Date());
    const ds = parseDateAnyToDate(s);
    const de = parseDateAnyToDate(e);
    if (!ds || !de) return [];
    const out = [];
    const cur = new Date(ds.getFullYear(), ds.getMonth(), 1);
    const last = new Date(de.getFullYear(), de.getMonth(), 1);
    while (cur.getTime() <= last.getTime()){
      out.push({ year: String(cur.getFullYear()), month: pad2(cur.getMonth()+1) });
      cur.setMonth(cur.getMonth()+1);
    }
    return out;
  }

  
  // ---- период ответственности / расчёта начислений ----
  // Ищем максимально "живуче", потому что структура AbonentsDB могла меняться.
  function suggestResponsibilityStartFromPayments(abonentId){
    const id = String(abonentId || getAbonentId() || "");
    if (!id) return null;
    try {
      const pKey = (window.Data && typeof window.Data.resolvePaymentLedgerKey === "function")
        ? window.Data.resolvePaymentLedgerKey(id)
        : ((typeof window.getPaymentsKeyForAbonent === "function") ? window.getPaymentsKeyForAbonent(id) : "");
      if (!pKey) {
        logPaymentKeyReadOnce({ abonentId: id, reason: "ABONENT_NOT_READY_OR_UID_MISSING" });
        return null;
      }
      logPaymentKeyReadOnce({ abonentId: id, key: pKey });
      const arr = readPaymentLedgerRowsCached(pKey, id);
      if (!Array.isArray(arr) || !arr.length) return null;
      let minY = null;
      let minM = null;
      for (const r of arr) {
        const y = parseInt(String(r && r.year || ""), 10);
        const m = parseInt(String(r && r.month || ""), 10);
        if (!y || !m || m < 1 || m > 12) continue;
        if (minY == null || y < minY || (y === minY && m < minM)) {
          minY = y;
          minM = m;
        }
      }
      if (minY == null || minM == null) return null;
      return { suggestedStartDate: `${minY}-${pad2(minM)}-01`, source: "payments_min_month" };
    } catch (e) {
      return null;
    }
  }
  window.suggestResponsibilityStartFromPayments = suggestResponsibilityStartFromPayments;

  function getActiveResponsibilityRangeISO(){
    const id = String(getAbonentId());

    const db = window.AbonentsDB || {};
    const linksRaw = Array.isArray(db.links) ? db.links : (Array.isArray(db.abonentPremiseLinks) ? db.abonentPremiseLinks : []);

    const linkForId = (l) => {
      const aId = l?.abonentId ?? l?.abonent_id ?? l?.abonent ?? l?.accountId ?? l?.ls ?? l?.personalAccount;
      return String(aId ?? "") === id;
    };

    const links = (linksRaw || []).filter(linkForId);

    const parseLink = (l) => ({
      l,
      dateFromISO: parseAnyDateToISO(l.dateFrom ?? l.from ?? l.start ?? l.startDate ?? l.date_start ?? l.respFrom),
      dateToISO:   parseAnyDateToISO(l.dateTo   ?? l.to   ?? l.end   ?? l.endDate   ?? l.date_end   ?? l.respTo),
    });

    const norm = links.map(parseLink).filter(l => l.dateFromISO);

    // Приоритетный "жёсткий" диапазон расчёта на самом абоненте (если задан).
    // В разных версиях проекта поле "Дата начала расчёта" могло называться по-разному,
    // поэтому читаем максимально "живуче".
    // calcStartDate/calcEndDate обычно ставим при смене ответственного, но при создании
    // нового абонента поле может сохраняться как calcDate или startCalc.
    const aStrict = (db.abonents && db.abonents[id]) ? db.abonents[id] : {};
    const strictFrom = parseAnyDateToISO(
      aStrict?.calcStartDate ??
      aStrict?.calc_start_date ??
      aStrict?.calcStart ??
      aStrict?.calc_start ??
      aStrict?.startCalc ??
      aStrict?.start_calc ??
      aStrict?.dateStartCalc ??
      aStrict?.date_start_calc ??
      aStrict?.calcDateStart ??
      aStrict?.calc_date_start ??
      // ⚠️ legacy: в некоторых формах "Дата начала расчёта" сохранялась в calcDate
      aStrict?.calcDate ??
      aStrict?.calc_date
    );
    const strictTo   = parseAnyDateToISO(
      aStrict?.calcEndDate ??
      aStrict?.calc_end_date ??
      aStrict?.calcEnd ??
      aStrict?.calc_end
    );

    const clamp = (range, isOpenEndedLink) => {
      if (!range || !range.from) return range;
      let from = range.from;
      let to   = range.to || "";
      if (strictFrom && strictFrom > from) from = strictFrom;

      // 🔴 CRITICAL: если ответственность "по настоящее время" (link без dateTo),
      // не имеем права обрезать период начислений старым a.calcEndDate.
      // Иначе пропадают месяцы нового года (например, январь 2026).
      if (strictTo && !isOpenEndedLink) {
        // если строгий конец задан — он всегда ограничивает начисления
        if (!to || strictTo < to) to = strictTo;
      }
      return { from, to };
    };

    if (norm.length){
      const active = norm.filter(l => !l.dateToISO);
      const pick = (arr) => arr.sort((a,b)=> (a.dateFromISO < b.dateFromISO ? 1 : -1))[0];
      const chosen = active.length ? pick(active) : pick(norm);
      return clamp({ from: chosen.dateFromISO, to: chosen.dateToISO || "" }, !chosen.dateToISO);
    }

    // fallback: если нет links — берём из самого абонента (дата начала расчёта)
    const a = (db.abonents && db.abonents[id]) ? db.abonents[id] : {};
    const fromISO = parseAnyDateToISO(
      a.dateFrom ?? a.date_from ?? a.calcFrom ?? a.calc_from ??
      a.calcStartDate ?? a.calc_start_date ?? a.calcStart ?? a.calc_start ??
      a.startCalc ?? a.start_calc ??
      a.dateStartCalc ?? a.date_start_calc ?? a.responsibilityFrom ?? a.respFrom
    );
    const toISO = parseAnyDateToISO(
      a.dateTo ?? a.date_to ?? a.calcTo ?? a.calc_to ??
      a.calcEndDate ?? a.calc_end_date ?? a.calcEnd ?? a.calc_end ??
      a.endCalc ?? a.end_calc ??
      a.dateEndCalc ?? a.date_end_calc ?? a.responsibilityTo ?? a.respTo
    );

    if (fromISO) return clamp({ from: fromISO, to: toISO || "" });

    const suggested = suggestResponsibilityStartFromPayments(id);
    if (suggested && suggested.suggestedStartDate) {
      console.warn("[responsibility][missing-period-suggestion]", {
        abonentId: id,
        suggestedStartDate: suggested.suggestedStartDate,
        source: suggested.source
      });
    }
    console.warn("[autoaccrual] responsibility period is missing; payment history is diagnostic only");
    return null;
  }
function getOwnershipHistoryForPremise() {
  const db = window.AbonentsDB || {};
  const links = Array.isArray(db.links) ? db.links : [];

  // ⚠️ CRITICAL:
  // Раньше здесь возвращались ВСЕ links из базы, из-за чего начисление могло
  // делиться между чужими квартирами/адресами. Теперь мы фильтруем историю
  // строго по той же квартире (premiseId/regnum/адрес), что и у текущего абонента.

  const curId = String(getAbonentId());

  const normLinkKey = (l) => {
    if (!l) return "";
    // 1) приоритет: premiseId / premise
    const pid = l.premiseId ?? l.premise_id ?? l.premise ?? l.flatId ?? l.premisesId;
    if (pid != null && String(pid) !== "") return "pid:" + String(pid);

    // 2) регистрационный номер квартиры (если используешь его как ключ квартиры)
    const reg = l.regnum ?? l.regNum ?? l.registrationNumber ?? l.apartmentRegnum ?? l.flatRegnum;
    if (reg != null && String(reg) !== "") return "reg:" + String(reg);

    // 3) fallback: адресная склейка
    const city = (l.city ?? l.town ?? l.locality ?? "").toString().trim().toLowerCase();
    const street = (l.street ?? l.addrStreet ?? l.ulica ?? "").toString().trim().toLowerCase();
    const house = (l.house ?? l.dom ?? l.addrHouse ?? "").toString().trim().toLowerCase();
    const flat = (l.flat ?? l.kv ?? l.apartment ?? l.addrFlat ?? "").toString().trim().toLowerCase();
    const key = [city, street, house, flat].filter(Boolean).join("|");
    return key ? "addr:" + key : "";
  };

  // ключ текущей квартиры берём из links текущего абонента
  const curLink = links.find(l => String(l?.abonentId ?? l?.abonent_id ?? l?.abonent ?? l?.ls ?? "") === curId);
  let curKey = normLinkKey(curLink);

  // если в links нет нормального ключа — пробуем взять ключ из самого абонента (адрес)
  if (!curKey) {
    const a = (db.abonents && db.abonents[curId]) ? db.abonents[curId] : {};
    const city = (a.city ?? a.town ?? a.locality ?? a["город"] ?? a["Город"] ?? "").toString().trim().toLowerCase();
    const street = (a.street ?? a["улица"] ?? a["Улица"] ?? "").toString().trim().toLowerCase();
    const house = (a.house ?? a.dom ?? a["дом"] ?? a["Дом"] ?? "").toString().trim().toLowerCase();
    const flat = (a.flat ?? a.kv ?? a.apartment ?? a["квартира"] ?? a["Квартира"] ?? "").toString().trim().toLowerCase();
    const key = [city, street, house, flat].filter(Boolean).join("|");
    if (key) curKey = "addr:" + key;
  }

  // фильтруем историю по ключу текущей квартиры
  const filtered = curKey ? links.filter(l => normLinkKey(l) === curKey) : links;

  return filtered
    .map(l => ({
      abonentId: String(
        l.abonentId ?? l.abonent_id ?? l.abonent ?? l.ls
      ),
      from: parseAnyDateToISO(l.dateFrom ?? l.from ?? l.start ?? l.respFrom),
      to:   parseAnyDateToISO(l.dateTo   ?? l.to   ?? l.end   ?? l.respTo)
    }))
    .filter(x => x.from);
}


  
  function getAbonentSquare(){
    const id = String(getAbonentId());
    const db = window.AbonentsDB || {};

    // 1) Прямо из абонента
    const a = (db.abonents && db.abonents[id]) ? db.abonents[id] : {};
    const candidates = [
      a.square, a.area, a.total_area, a.totalArea, a.sq, a.m2, a["общая_площадь"], a["общая площадь"], a["Общая площадь"]
    ];
    for (const v of candidates){
      const n = toNum(v);
      if (n > 0) return n;
    }

    // 2) Если в links есть premiseId — пробуем взять площадь из premises
    const linksRaw = Array.isArray(db.links) ? db.links : [];
    const link = linksRaw.find(l => String(l?.abonentId ?? l?.abonent_id ?? "") === id);
    const premiseId = link?.premiseId ?? link?.premise_id ?? link?.premise ?? link?.flatId ?? link?.premisesId;
    if (premiseId != null && db.premises){
      const p = db.premises[premiseId] || (Array.isArray(db.premises) ? db.premises.find(x => String(x?.id ?? x?.premiseId) === String(premiseId)) : null);
      if (p){
        const pc = [p.square, p.area, p.total_area, p.totalArea, p.sq, p.m2, p["общая_площадь"], p["общая площадь"], p["Общая площадь"]];
        for (const v of pc){
          const n = toNum(v);
          if (n > 0) return n;
        }
      }
    }

    console.warn("[autoaccrual] не найдена площадь (abonent.square/area/общая_площадь или premises.*)");
    return 0;
  }


  
  function loadTariffTable(){
    // 1) JKHStore — известные ключи (старые/новые версии)
    const keys = [
      "tariffs_content_repair_v1", // legacy read-only / migration only / excluded from upload
      "tariffs_content_repair",
      "tariffs_table_v1",
      "tariffs_table",
      "tariffs_v3",
      "tariffs_v2",
      "tariffs_v1",
      "tariffs",
      "tariff_v2",
      "tariff_v1",
      "tariff"
    ];

    const tryParse = (raw) => {
      if (!raw) return null;
      try{
        const data = JSON.parse(raw);
        if (Array.isArray(data)) return data;
        if (Array.isArray(data?.tariffs)) return data.tariffs;
        if (Array.isArray(data?.rows)) return data.rows;
        if (Array.isArray(data?.items)) return data.items;
        if (Array.isArray(data?.data)) return data.data;
        // иногда хранят как { table: [] }
        if (Array.isArray(data?.table)) return data.table;
      }catch(e){ console.warn("[autoaccrual] tariff parse failed", e); return null; }
      return null;
    };

    for (const k of keys){
      const got = tryParse(storeGetRaw(k));
      if (got) return got;
    }

    // 2) window.* — если тарифы держатся в data.js/глобалах
    const w = window;
    const candidates = [
      w.TariffsDB?.tariffs, w.TariffsDB?.rows, w.TariffsDB?.items, w.TariffsDB?.table,
      w.tariffs, w.tariffTable, w.tariffRows,
      w.AbonentsDB?.tariffs, w.AbonentsDB?.tariffTable
    ];
    for (const c of candidates){
      if (Array.isArray(c)) return c;
    }
    console.warn("[readonly][blocked-write-path]", { page: "payment_table", path: "loadTariffTable", reason: "TARIFFS_NOT_FOUND_NO_DEFAULT_CREATE" });
    return [];
  }



  
  function tariffSumForMonth(month, year){
    const tbl = loadTariffTable();
    if (!tbl) return null;

    const mStr = pad2(month);
    const yStr = String(year);
    const monthStart = `${yStr}-${mStr}-01`;
    const ms = parseDateAnyToDate(monthStart)?.getTime() || 0;

    // нормализуем строки тарифов в {fromMs, content, repair}
    const norm = [];
    for (const r of tbl){
      const fromISO = parseAnyDateToISO(
        r.from ?? r.dateFrom ?? r.start ?? r.begin ?? r.periodFrom ?? r.dt ?? r.date ?? r.startDate ?? r.beginDate ?? r.fromDate
      );
      const fromMs = parseDateAnyToDate(fromISO)?.getTime();
      if (!fromMs) continue;

      let content = null, repair = null;

      // формат A: явные поля
      if (r.content != null || r.repair != null || r.tariff_content != null || r.tariff_repair != null){
        content = toNum(r.content ?? r.tariff_content);
        repair  = toNum(r.repair  ?? r.tariff_repair);
      }

      // формат B: items[]
      if ((content == null && repair == null) && Array.isArray(r.items)){
        for (const it of r.items){
          const name = String(it?.name || it?.code || it?.type || "").toLowerCase();
          if (content == null && (name.includes("содерж") || name.includes("content"))) content = toNum(it.rate ?? it.value ?? it.tariff);
          if (repair  == null && (name.includes("ремонт") || name.includes("repair")))  repair  = toNum(it.rate ?? it.value ?? it.tariff);
        }
      }

      // формат C: одна ставка + тип/наименование
      if ((content == null && repair == null) && (r.rate != null || r.value != null || r.tariff != null)){
        const rate = toNum(r.rate ?? r.value ?? r.tariff);
        const name = String(r.name || r.type || r.service || "").toLowerCase();
        if (name.includes("содерж") || name.includes("content")) content = rate;
        if (name.includes("ремонт") || name.includes("repair")) repair = rate;
      }

      content = content == null ? 0 : content;
      repair  = repair  == null ? 0 : repair;

      norm.push({ fromMs, content, repair });
    }

    if (!norm.length) {
      console.warn("[autoaccrual] тарифы есть, но не распознаны поля (ожидал from/dateFrom + content/repair)");
      return null;
    }

    // берём последнюю по дате начала <= месяцу (последний период распространяется на текущее время)
    norm.sort((a,b)=>a.fromMs-b.fromMs);
    let chosen = null;
    for (const r of norm){
      if (r.fromMs <= ms) chosen = r;
    }
    if (!chosen) return null;

    return r2(chosen.content + chosen.repair);
  }


  function nextPaymentId(arr){
    return arr.length ? Math.max(...arr.map(x => Number(x.id) || 0)) + 1 : 1;
  }

  
  function ensureAutoAccruals(arr){
    const range = getActiveResponsibilityRangeISO();
    if (!range) return false;

    const sq = getAbonentSquare();
    const months = monthIter(range.from, range.to);
    if (!months.length) return false;

    // если нет площади — начисления будут 0, но строки всё равно создадим
    if (!(sq > 0)) {
      console.warn("[autoaccrual] площадь = 0 — начисления будут 0. Проверь поле 'Общая площадь' у абонента/квартиры.");
    }

    // Набор месяцев, в которых разрешены начисления для ЭТОГО абонента
    const allowedYm = new Set(months.map(m => `${m.year}-${m.month}`));

    let changed = false;

    // 🔒 Блокировка ручного/внешнего "впрыска" начислений вне периода.
    // Даже если кто-то вручную подменит хранилище и поставит accrued,
    // мы обнулим начисления в месяцах вне allowedYm.
    for (const r of arr){
      const y = String(r.year || "");
      const m = pad2(r.month || "");
      if (!y || !m) continue;
      const key = `${y}-${m}`;
      if (!allowedYm.has(key) && toNum(r.accrued) > 0){
        r.accrued = 0;
        changed = true;
      }
    }

    // группируем строки по месяцу
    const byYm = new Map();
    for (const r of arr){
      const y = String(r.year || "");
      const m = pad2(r.month || "");
      if (!y || !m) continue;
      const key = `${y}-${m}`;
      if (!byYm.has(key)) byYm.set(key, []);
      byYm.get(key).push(r);
    }

    let idCounter = nextPaymentId(arr);

    for (const mm of months){
      const key = `${mm.year}-${mm.month}`;
      const rows = byYm.get(key) || [];

      // начисление = (тариф(содерж+ремонт) за месяц) × площадь
      const sumRate = tariffSumForMonth(mm.month, mm.year);
const totalAccr = (sumRate != null && sq > 0) ? r2(sumRate * sq) : 0;

// 🔴 CRITICAL: делим начисление по владельцам
const ownershipHistory = getOwnershipHistoryForPremise();
const parts = splitAccrualByOwnership(
  totalAccr,
  Number(mm.year),
  Number(mm.month),
  ownershipHistory
);

// сумма, относящаяся ИМЕННО к текущему абоненту
let accr = 0;
if (parts.length) {
  let matchedOwnerPart = false;
  for (const p of parts) {
    if (String(p.abonentId) === String(getAbonentId())) {
      matchedOwnerPart = true;
      accr = r2(accr + p.amount);
    }
  }
  if (!matchedOwnerPart) accr = prorateAccrualByRange(totalAccr, Number(mm.year), Number(mm.month), range);
} else {
  accr = prorateAccrualByRange(totalAccr, Number(mm.year), Number(mm.month), range);
}


      if (sumRate == null){
        // тарифы не найдены / не распознаны — это главная причина "не происходит начисление"
        console.warn(`[autoaccrual] нет тарифа на ${mm.month}.${mm.year} (проверь таблицу тарифов и ключи JKHStore)`);
      }

      if (!rows.length){
        // создаём строку-начисление
        const row = {
          id: idCounter++,
          month: mm.month,
          year: mm.year,
          accrued: accr,
          paid: 0,
          paid_date: "",
          use_period: false,
          period_from_m: mm.month,
          period_from_y: mm.year,
          period_to_m: mm.month,
          period_to_y: mm.year,
          period_from: `${mm.month}.${mm.year}`,
          period_to: `${mm.month}.${mm.year}`,
          note: "",
          pay_main: 0,
          pay_penalty: 0,
          total_debt: 0
        };
        arr.push(row);
        changed = true;
        continue;
      }

      // есть строки: начисление только в одной (минимальный id), остальные accrued = 0
      rows.sort((a,b)=>(Number(a.id)||0)-(Number(b.id)||0));
      const first = rows[0];

      for (let i=1;i<rows.length;i++){
        const r = rows[i];
        if (toNum(r.accrued) !== 0){
          r.accrued = 0;
          changed = true;
        }
      }

      if (toNum(first.accrued) !== accr){
        first.accrued = accr;
        changed = true;
      }
    }

    return changed;
  }




  // ===== ФИЛЬТР ПО ПЕРИОДУ ДЛЯ "РАСЧЁТ ВЗЫСКИВАЕМОЙ СУММЫ" =====
  let __calcPeriodMetaCache = null;
  function calcPeriodStorageMeta(){
    const id = String(getAbonentId() || "");
    const owner = currentOwnerIdForPaymentCache();
    const cacheKey = id + "|" + owner;
    if (__calcPeriodMetaCache && __calcPeriodMetaCache.cacheKey === cacheKey) return __calcPeriodMetaCache;

    if (!(window.Data && typeof window.Data.resolveCalcPeriodStorageKey === "function" && typeof window.Data.resolveCalcPeriodActiveStorageKey === "function")) {
      logCalcPeriodOnce("[calc-period][save-skipped-no-canonical-key]", { abonentId: id, reason: "DATA_NOT_READY", source: "payment_table" });
      return { cacheKey: cacheKey, storageKey: "", activeStorageKey: "", abonentId: id };
    }

    const abonent = (typeof window.Data.getAbonent === "function") ? window.Data.getAbonent(id) : null;
    const resolverInput = abonent || id;
    const storageKey = String(window.Data.resolveCalcPeriodStorageKey(resolverInput) || "");
    const activeStorageKey = String(window.Data.resolveCalcPeriodActiveStorageKey(resolverInput) || "");
    let resolvedUid = String(abonent && abonent.uid || "");
    if (!resolvedUid && /^calc_period_uid_/.test(storageKey)) resolvedUid = storageKey.replace(/^calc_period_/, "");
    if (!storageKey || !activeStorageKey) {
      logCalcPeriodOnce("[calc-period][save-skipped-no-canonical-key]", { requestedId: id, resolvedUid: resolvedUid, ownerId: owner, reason: "CANONICAL_KEY_NOT_READY", source: "payment_table" });
      return { cacheKey: cacheKey, storageKey: "", activeStorageKey: "", abonentId: id };
    }

    __calcPeriodMetaCache = { cacheKey: cacheKey, storageKey: storageKey, activeStorageKey: activeStorageKey, abonentId: id, resolvedUid: resolvedUid };
    logCalcPeriodOnce("[calc-period][canonical-key-used]", { requestedId: id, resolvedUid: resolvedUid, storageKey: storageKey, activeStorageKey: activeStorageKey, ownerId: owner, source: "payment_table" });
    return __calcPeriodMetaCache;
  }
  function calcPeriodKey() { return calcPeriodStorageMeta().storageKey || ""; }
  function calcPeriodActiveKey() { return calcPeriodStorageMeta().activeStorageKey || ""; }

  function getPeriodFromURL(){
    try {
      const params = new URLSearchParams(window.location.search || "");
      const from = String(params.get("from") || "").trim();
      const to = String(params.get("to") || "").trim();
      if (!from || !to) return null;
      const fromD = parseDateAnyToDate(from);
      const toD = parseDateAnyToDate(to);
      if (!fromD || !toD || startOfDay(fromD) > startOfDay(toD)) return null;
      return { from: from, to: to };
    } catch(e) {
      return null;
    }
  }

  const __periodUrlFallbackLogged = {};
  function logPeriodUrlFallbackOnce(period){
    try {
      const key = String(getAbonentId() || "") + "|" + String(period && period.from || "") + "|" + String(period && period.to || "");
      if (__periodUrlFallbackLogged[key]) return;
      __periodUrlFallbackLogged[key] = true;
      console.log("[payment-table][period-url-fallback]", {
        abonentId: String(getAbonentId() || ""),
        from: period && period.from || "",
        to: period && period.to || "",
        reason: "canonical-active-missing-url-period-present"
      });
    } catch(e) {}
  }

  function lastAddedPaymentKey() { return "last_added_payment_" + getAbonentId(); }
  function setLastAddedPaymentId(id) {
    try { sessionStorage.setItem(lastAddedPaymentKey(), String(id)); } catch(e) { console.warn("setLastAddedPaymentId failed", e); }
  }
  function getLastAddedPaymentId() {
    try { return sessionStorage.getItem(lastAddedPaymentKey()); } catch { return null; }
  }
  function clearLastAddedPaymentId() {
    try { sessionStorage.removeItem(lastAddedPaymentKey()); } catch(e) { console.warn("clearLastAddedPaymentId failed", e); }
  }

  function getCalcPeriod() {
    let urlPeriod = null;
    try {
      const key = calcPeriodKey();
      urlPeriod = getPeriodFromURL();
      if (!key) return urlPeriod;
      const raw = storeGetRaw(key);
      if (!raw) return urlPeriod;
      const p = JSON.parse(raw);
      const from = String(p?.from || "");
      const to   = String(p?.to || "");
      if (!from || !to) return urlPeriod;
      return { from, to };
    } catch {
      return urlPeriod || getPeriodFromURL();
    }
  }

  function isCalcPeriodActive() {
    const urlPeriod = getPeriodFromURL();
    if (urlPeriod) {
      logPeriodUrlFallbackOnce(urlPeriod);
      return true;
    }
    if (window.JKH_CARD_PERIOD_MODE_ACTIVE !== true) return false;
    const key = calcPeriodActiveKey();
    const canonicalActive = !!(key && storeGetRaw(key) === "1");
    if (canonicalActive) return true;
    return false;
  }

  // ✅ ФИЛЬТР: показываем оплаты, у которых "Дата оплаты" попадает в выбранный период
  function applyCalcFilter(arr, activeOverride, periodOverride) {
    const active = (typeof activeOverride === "boolean") ? activeOverride : isCalcPeriodActive();
    if (!active) return arr;

    const p = periodOverride || getCalcPeriod();
    if (!p) return arr;

    const fromD = parseDateAnyToDate(p.from);
    const toD   = parseDateAnyToDate(p.to);
    if (!fromD || !toD) return arr;

    // ✅ фильтр по РАСЧЁТНОМУ ПЕРИОДУ (год/месяц строки), а не по paid_date
    // Включительно по месяцам.
    const fromKey = (fromD.getFullYear() * 12) + (fromD.getMonth() + 1);
    const toKey   = (toD.getFullYear()   * 12) + (toD.getMonth() + 1);

    const lastId = getLastAddedPaymentId();

    return arr.filter(r => {
      // всегда показываем последнюю добавленную строку (чтобы пользователь её увидел)
      if (lastId && String(r.id) === String(lastId)) return true;

      let y = parseInt(r?.year, 10);
      let m = parseInt(r?.month, 10);

      // fallback: если year/month не заполнены — попробуем из paid_date
      if (!(Number.isFinite(y) && Number.isFinite(m) && y > 0 && m >= 1 && m <= 12)) {
        const d = parseDateAnyToDate(r?.paid_date);
        if (d) {
          y = d.getFullYear();
          m = d.getMonth() + 1;
        }
      }

      if (!(Number.isFinite(y) && Number.isFinite(m) && y > 0 && m >= 1 && m <= 12)) return false;

      const key = (y * 12) + m;
      return key >= fromKey && key <= toKey;
    });
  }

  function responsibilityAllowedYmSet(){
    const range = getActiveResponsibilityRangeISO();
    if (!range || !range.from) return null;
    const months = monthIter(range.from, range.to);
    if (!months.length) return null;
    return new Set(months.map(m => `${m.year}-${m.month}`));
  }

  function applyResponsibilityRangeToView(arr){
    if (!Array.isArray(arr) || !arr.length) return arr;

    let range = null;
    let allowedYm = null;
    try {
      range = getActiveResponsibilityRangeISO();
      if (range && range.from) {
        const months = monthIter(range.from, range.to);
        if (months.length) allowedYm = new Set(months.map(m => `${m.year}-${m.month}`));
      }
    } catch(e) {
      console.error(e);
      throw e;
    }
    if (!allowedYm || !allowedYm.size) return arr;

    const abonentId = String(getAbonentId() || "");
    const out = [];
    const loggedHidden = {};

    for (const row of arr){
      const ym = ymKeyOfRow(row);
      const paid = toNum(row && row.paid);
      const paidDateISO = parseAnyDateToISO(row && row.paid_date);
      const paymentBeforeRange = paid > 0.0000001 && paidDateISO && range && range.from && paidDateISO < range.from;
      const outOfRange = (ym && !allowedYm.has(ym)) || paymentBeforeRange;
      if (!outOfRange) {
        out.push(row);
        continue;
      }

      const logKey = ym + ':' + String(row && row.id || '') + ':' + String(row && row.paid_date || '');
      if (!loggedHidden[logKey]) {
        loggedHidden[logKey] = true;
        try {
          console.log('[payment-table][hide-payment-out-of-responsibility]', {
            abonentId: abonentId,
            ym: ym,
            paid: paid,
            paid_date: String(row && row.paid_date || ''),
            reason: 'PAYMENT_OUT_OF_RESPONSIBILITY_RANGE'
          });
        } catch(e) {}
      }
      continue;
    }

    return out;
  }

  function getPayments() {
    const key = paymentsKey();
    if (!key) return [];
    // Read-only path: do not migrate rows, set source defaults, or normalize paid_date while reading.
    return readPaymentLedgerRowsCached(key);
  }

  const __paymentDraftRowsByAbonent = new Map();

  function draftRowsKey(){
    return String(getAbonentId() || "");
  }

  function getPaymentDraftRows(){
    const key = draftRowsKey();
    if (!key) return [];
    const rows = __paymentDraftRowsByAbonent.get(key);
    return Array.isArray(rows) ? rows : [];
  }

  function setPaymentDraftRows(rows){
    const key = draftRowsKey();
    if (!key) return;
    __paymentDraftRowsByAbonent.set(key, Array.isArray(rows) ? rows : []);
  }

  function isPaymentDraftRow(row){
    return !!(row && row.__draft === true);
  }

  function readPaymentRowForEdit(rowId){
    const drafts = getPaymentDraftRows();
    const draft = drafts.find(x => String(x.id) === String(rowId));
    if (draft) return { row: draft, draft: true, arr: getPayments(), drafts: drafts };
    const arr = getPayments();
    return { row: arr.find(x => String(x.id) === String(rowId)) || null, draft: false, arr: arr, drafts: drafts };
  }

  function showRowSoftMessage(tr, message, tone){
    if (!tr) return;
    var cell = qs(".id-cell", tr) || tr.lastElementChild;
    if (!cell) return;
    var box = qs(".payment-row-status", cell);
    if (!box) {
      box = document.createElement("div");
      box.className = "payment-row-status";
      box.style.cssText = "margin-top:4px;font-size:11px;line-height:1.2;";
      cell.appendChild(box);
    }
    box.textContent = String(message || "");
    box.style.color = tone === "ok" ? "#116611" : (tone === "warn" ? "#7a5300" : "#555");
  }

  function normalizeDraftPaymentRowForSave(row){
    if (row && String(row.paid_date || "").trim()) {
      syncYearMonthFromPaidDate(row);
    }
    var copy = Object.assign({}, row || {});
    delete copy.__draft;
    delete copy.__draftStatus;
    delete copy.__draftMessage;
    normalizePaymentRow(copy);
    return copy;
  }

  function markPaymentRuntimeStaleUI(tr){
    const statusBox = qs("#paymentTableStatus") || qs("#paymentStatus") || qs("#paymentsStatus");
    if (statusBox) statusBox.textContent = "Оплата сохранена. Итог устарел — нажмите «Пересчитать».";
    try {
      if (window.JKHSetSummaryStatus) window.JKHSetSummaryStatus((window.JKH_SUMMARY_STATUS && window.JKH_SUMMARY_STATUS.DIRTY) || "dirty", "PAYMENTS_CHANGED");
    } catch(eSummaryDirty) {}
    try { console.log("[summary][dirty]", { abonentId: String(getAbonentId() || ""), reason: "PAYMENTS_CHANGED" }); } catch(eDirtyLog) {}
    try {
      console.log("[payment-save][skip-full-recalc]", {
        abonentId: String(getAbonentId() || ""),
        reason: "ledger_mutation_runtime_cache_invalidated"
      });
    } catch(eLog) {}
    if (tr) {
      qsa(".ro", tr).forEach(function(cell){ cell.textContent = "—"; });
      showRowSoftMessage(tr, "Оплата сохранена. Итог устарел — нажмите Пересчитать.", "ok");
    }
  }

  function reloadPaymentTableReadonlyNoRecalc(reason){
    try {
      requestLoadPaymentTable({
        mode: "readonly_no_recalc",
        reason: reason || "ledger-mutation-no-recalc",
        force: true
      });
    } catch(e) {
      console.error(e);
      throw e;
    }
  }

  function replaceRowWithPersisted(row, oldTr){
    if (!oldTr || !oldTr.parentNode) return null;
    var persistedRows = getPayments();
    var persisted = (Array.isArray(persistedRows) ? persistedRows : []).find(function(x){ return String(x && x.id) === String(row && row.id); }) || row;
    var nextRow = Object.assign({}, persisted || {});
    nextRow.pay_main = "";
    nextRow.pay_penalty = "";
    nextRow.total = "";
    nextRow.total_debt = "";
    var newTr = makeRow(nextRow);
    oldTr.parentNode.replaceChild(newTr, oldTr);
    try { console.log("[payment-table][row-refresh-no-recalc]", { abonentId: String(getAbonentId() || ""), rowId: String(row && row.id || "") }); } catch(eLog) {}
    return newTr;
  }

  function oldTrRemoveNoRecalc(tr){
    var ym = tr && tr.dataset ? String(tr.dataset.ym || "") : "";
    var rowId = tr && tr.dataset ? String(tr.dataset.rowId || "") : "";
    if (tr && tr.parentNode) tr.parentNode.removeChild(tr);
    try {
      console.log("[payment-table][row-delete-no-recalc]", { abonentId: String(getAbonentId() || ""), rowId: rowId });
      console.log("[payment-table][month-refresh-no-recalc]", { abonentId: String(getAbonentId() || ""), ym: ym });
    } catch(eLog) {}
    markPaymentRuntimeStaleUI(null);
  }

  async function trySaveDraftRowIfValid(tr, rowId){
    const edit = readPaymentRowForEdit(rowId);
    const row = edit.row;
    if (!row || !edit.draft) return false;
    try { console.log("[payment-save][draft]", { abonentId: String(getAbonentId() || ""), rowId: String(rowId || ""), paid: row.paid, paid_date: String(row.paid_date || "") }); } catch(eDraftLog) {}
    const paid = r2(Math.max(0, toNum(row.paid)));
    syncYearMonthFromPaidDate(row);
    if (paid <= 0.0000001) {
      showRowSoftMessage(tr, "Черновик: укажите сумму оплаты.", "warn");
      return false;
    }
    if (!parseDateAnyToDate(row.paid_date)) {
      showRowSoftMessage(tr, "Черновик: дата оплаты нужна для сохранения.", "warn");
      return false;
    }

    const persisted = normalizeDraftPaymentRowForSave(row);
    const arr = getPayments();
    const next = arr.filter(x => String(x.id) !== String(persisted.id));
    next.push(persisted);
    try {
      showRowSoftMessage(tr, "Сохранение оплаты...", "warn");
      await savePaymentsAndFlush(next);
      setPaymentDraftRows(getPaymentDraftRows().filter(x => String(x.id) !== String(rowId)));
      setLastAddedPaymentId(persisted.id);
      var newTr = replaceRowWithPersisted(persisted, tr);
      markPaymentRuntimeStaleUI(newTr || tr);
      try { console.log("[payment-save][persisted]", { abonentId: String(getAbonentId() || ""), rowId: String(persisted.id || ""), cacheInvalidated: true, summaryDirty: true }); } catch(ePersistedLog) {}
      return true;
    } catch(e) {
      showRowSoftMessage(tr, "Ошибка сохранения оплаты.", "warn");
      throw e;
    }
  }


  /* =========================================================
     DATA CONTRACT (PaymentRow) — нормализация перед сохранением
     - Числа храним числами (id, accrued, paid, pay_main, pay_penalty, total_debt)
     - paid_date: ISO YYYY-MM-DD или ""
     - month: "01".."12", year: "YYYY"
     - paid не может быть отрицательным
     ========================================================= */

  function makePaymentPeriodError(code, row, details){
    const err = new Error(code === "PAYMENT_DATE_REQUIRED" ? "Укажите дату оплаты перед сохранением строки платежа." : (code === "PAYMENT_YEAR_REQUIRED" ? "Не указан корректный год платежа." : "Не указан корректный период платежа."));
    err.code = code || "PAYMENT_PERIOD_INVALID";
    err.row = row || null;
    err.details = details || {};
    return err;
  }

  function logPaymentPeriodInvalid(err){
    try {
      console.error("[fatal][payment-period-invalid]", {
        code: String(err && err.code || "PAYMENT_PERIOD_INVALID"),
        rowId: err && err.row ? err.row.id : undefined,
        details: err && err.details || {}
      });
    } catch(e) {}
  }

  function throwPaymentPeriodInvalid(code, row, details){
    const err = makePaymentPeriodError(code, row, details);
    logPaymentPeriodInvalid(err);
    throw err;
  }

  function normalizePaymentRow(r){
    if (!r || typeof r !== 'object') return;

    // id
    r.id = Number(r.id) || 0;

    // paid_date: если валидна — расчётный месяц/год синхронизируются из неё.
    // Для строк ручной оплаты с суммой > 0 дата обязательна: без неё нельзя
    // вывести корректные year/month и нельзя отправлять запись на сервер.
    const paidAmount = r2(Math.max(0, toNum(r.paid)));
    const accruedAmount = r2(toNum(r.accrued));
    const paidDateObj = parseDateAnyToDate(r.paid_date);
    if (paidDateObj) {
      r.paid_date = toISODateString(paidDateObj);
      r.year = String(paidDateObj.getFullYear());
      r.month = pad2(paidDateObj.getMonth() + 1);
    } else {
      r.paid_date = '';
      if (paidAmount > 0.0000001 && accruedAmount <= 0.0000001) {
        throwPaymentPeriodInvalid("PAYMENT_DATE_REQUIRED", r, { paid: paidAmount, paid_date: "" });
      }
    }

    // month/year: запрещено молча заменять повреждённый период текущей датой.
    const mmRaw = String(r.month ?? '').trim();
    const mm = mmRaw.length === 1 ? mmRaw.padStart(2,'0') : mmRaw;
    const yy = String(r.year ?? '').trim();
    if (!/^(19|20)\d{2}$/.test(yy)) {
      throwPaymentPeriodInvalid("PAYMENT_YEAR_REQUIRED", r, { month: mmRaw, year: yy, paid_date: r.paid_date || "" });
    }
    if (!/^(0[1-9]|1[0-2])$/.test(mm)) {
      throwPaymentPeriodInvalid("PAYMENT_PERIOD_INVALID", r, { month: mmRaw, year: yy, paid_date: r.paid_date || "" });
    }
    r.month = mm;
    r.year = yy;

    // amounts
    r.accrued = accruedAmount;
    r.paid = paidAmount;

    // period
    r.use_period = !!r.use_period;
    normalizePeriod(r);

    // source (источник поступления)
    r.source = String(r.source || '').trim() || 'Платёж 1';

    // note
    r.note = String(r.note || '');

    // derived cache
    r.pay_main    = r2(toNum(r.pay_main));
    r.pay_penalty = r2(toNum(r.pay_penalty));
    r.total_debt  = r2(toNum(r.total_debt));
  }

  function normalizePaymentRows(arr){
    if (!Array.isArray(arr)) return arr;
    for (const r of arr) {
      syncYearMonthFromPaidDate(r);
      normalizePaymentRow(r);
    }
    return arr;
  }

  function validateEditablePaymentBeforeSave(row, tr){
    if (!row || typeof row !== "object") return true;
    syncYearMonthFromPaidDate(row);
    const paid = r2(Math.max(0, toNum(row.paid)));
    const accrued = r2(toNum(row.accrued));
    if (paid > 0.0000001 && accrued <= 0.0000001 && !parseDateAnyToDate(row.paid_date)) {
      showRowSoftMessage(tr, "Дата оплаты нужна для сохранения.", "warn");
      try {
        console.warn("[payment-save][blocked-invalid-paid-date]", {
          abonentId: String(getAbonentId() || ""),
          rowId: String(row.id || ""),
          paid: paid,
          paid_date: String(row.paid_date || "")
        });
      } catch(eWarn) {}
      return false;
    }
    return true;
  }

  async function savePaymentsAndFlush(arr){
    try {
      normalizePaymentRows(arr);

      // локальная запись через canonical service boundary
      const abonentId = String(getAbonentId() || "");
      if (!(window.Data && typeof window.Data.writePaymentLedger === "function")) throw new Error("Data.writePaymentLedger not available");
      const savedLedger = window.Data.writePaymentLedger(abonentId, arr, { eventType: "PAYMENT_TABLE_WRITE", summaryDirtyReason: "PAYMENTS_CHANGED" });
      if (savedLedger === false) {
        try { console.log("[manual-recalc][ledger-block]", { stage:"savePaymentsAndFlush.writePaymentLedger", subreason:"PAYMENT_LEDGER_WRITE_BLOCKED", existingRows:null, newRows:Array.isArray(arr) ? arr.length : null, proposedRows:arr, blockedBy:"Data.writePaymentLedger", details:window.__JKH_LAST_AUTOACCRUAL_BLOCK || null }); } catch(eLedgerBlockLog) {}
        throw new Error("PAYMENT_LEDGER_WRITE_BLOCKED");
      }
      clearPaymentLedgerReadCache('save-payments');

      // ОБЯЗАТЕЛЬНО: сервер
      if (window.Data && typeof Data.flushDbToServer === "function"){
        await Data.flushDbToServer();
      } else {
        throw new Error("Data.flushDbToServer not available");
      }

    } catch(e){
      console.error("SAVE PAYMENTS FAILED", e);
      if (e && e.code === "PAYMENT_DATE_REQUIRED") {
        alert(e.message || "Укажите дату оплаты перед сохранением строки платежа.");
      } else if (e && (e.code === "PAYMENT_YEAR_REQUIRED" || e.code === "PAYMENT_PERIOD_INVALID")) {
        alert(e.message || "Не указан корректный период платежа.");
      } else {
        alert("Ошибка сохранения оплат. Данные НЕ записаны на сервер.");
      }
      throw e;
    } finally {
      try {
        if (window.JKHBusy && typeof JKHBusy.hide === "function") JKHBusy.hide();
      } catch(eHide) {}
    }
  }

  // =========================================================
// РАСЧЁТ ДОЛГА И ПЕНИ (юридическая логика ЖКХ)
// - Пеня считается ПО ДНЯМ, по каждой "обязательной сумме" отдельно
// - 1–30 день просрочки: 0
// - 31–90 день: 1/300 ключевой ставки
// - с 91 дня: 1/130 ключевой ставки
// - ставка берётся на каждый день (история ставок)
// - исключённые периоды и мораторий учитываются (как в страницах ставок/исключений)
// - оплаты распределяются FIFO: на самый ранний непогашенный долг
// =========================================================

function startOfDay(d){
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function nextMonthYear(y, m){ // m: 1..12
  let yy = y, mm = m + 1;
  if (mm === 13){ mm = 1; yy += 1; }
  return { y: yy, m: mm };
}

function ymKey(y, m){ return `${String(y)}-${pad2(m)}`; }

// Собираем "обязательные начисления" (долги) из строк таблицы:
// берём суммы accrued > 0 и агрегируем по (год/месяц).
// allowedYm: необязательный Set вида {"2026-01", } — если задан,
// то в расчёт попадают ТОЛЬКО месяцы ответственности текущего ЛС.
function buildObligationsFromRows(rows, allowedYm){
  incRecalcCallCount("buildObligations", 1);
  const map = new Map();
  for (const r of rows){
    const acc = toNum(r.accrued);
    const y = parseInt(r.year, 10);
    const m = parseInt(r.month, 10);
    if (!y || !m) continue;
    if (acc <= 0) continue;

    if (allowedYm && allowedYm.size){
      const k = ymKey(y, m);
      if (!allowedYm.has(k)) continue;
    }

    const key = ymKey(y, m);
    map.set(key, (map.get(key) || 0) + acc);
  }

  const obligations = [];
  for (const [key, amount] of map.entries()){
    const [yy, mm] = key.split("-");
    const y = parseInt(yy, 10);
    const m = parseInt(mm, 10);

    // срок оплаты за месяц (y,m) — до 10 числа СЛЕДУЮЩЕГО месяца
    const nm = nextMonthYear(y, m);
    const due = new Date(nm.y, nm.m - 1, 10);

    obligations.push({
      key,
      serviceYear: y,
      serviceMonth: m,
      amount: r2(amount),
      dueDate: startOfDay(due),
      applications: [] // сюда распределим оплаты (FIFO)
    });
  }

  obligations.sort((a,b)=>a.dueDate - b.dueDate);
  return obligations;
}

// Платежи: берём paid > 0 и paid_date (иначе распределять не можем).
function buildPaymentEventsFromRows(rows){
  incRecalcCallCount("buildPaymentEvents", 1);
  const pays = [];
  for (const r of rows){
    const paid = toNum(r.paid);
    if (paid <= 0) continue;

    const d = parseDateAnyToDate(r.paid_date);
    if (!d) continue;

    pays.push({
      date: startOfDay(d),
      amount: r2(paid),
      rowId: r.id
    });
  }
  pays.sort((a,b)=>a.date - b.date || (Number(a.rowId)||0)-(Number(b.rowId)||0));
  return pays;
}

// FIFO-распределение оплат по долгам: на самый ранний непогашенный долг.
function allocatePaymentsFIFO(obligations, payments){
  let oi = 0;
  const advances = []; // переплата (аванс), если оплат больше, чем начислений на дату

  function remaining(ob){
    const applied = ob.applications.reduce((s,x)=>s + x.amount, 0);
    return Math.max(ob.amount - applied, 0);
  }

  for (const p of payments){
    emitActiveFullRecalcHeartbeat("allocate-payments-fifo");
    let left = p.amount;

    while (left > 0.0000001 && oi < obligations.length){
      emitActiveFullRecalcHeartbeat("allocate-payments-fifo");
      const ob = obligations[oi];
      const rem = remaining(ob);
      if (rem <= 0.0000001){
        oi += 1;
        continue;
      }

      const take = Math.min(rem, left);
      ob.applications.push({ date: p.date, amount: r2(take) });
      left = r2(left - take);

      if (remaining(ob) <= 0.0000001) oi += 1;
    }

    // ✅ если оплат больше, чем долга — фиксируем переплату (аванс)
    if (left > 0.0000001){
      advances.push({ date: p.date, amount: r2(left) });
    }
  }

  return advances;
}

function sumAppliedUpTo(ob, day){
  const t = day.getTime();
  let s = 0;
  for (const a of ob.applications){
    if (a.date.getTime() <= t) s += a.amount;
    else break;
  }
  return s;
}

function sortApplications(ob){
  ob.applications.sort((a,b)=>a.date - b.date);
}

// Расчёт пени по ОДНОМУ долгу (обязательству) до даты asOf (включительно)
function calcPenaltyForObligation(ob, asOf, excludes, rates){
  incRecalcCallCount("calculatePenaltyForObligation", 1);
  const asOfDay = startOfDay(asOf);
  if (asOfDay <= ob.dueDate) {
    return 0;
  }

  sortApplications(ob);

  let penalty = 0;
  let overdueIndex = 0;

  // начинаем считать дни просрочки с дня, следующего за dueDate
  let day = addDays(ob.dueDate, 1);

  const hardLimit = addDays(ob.dueDate, 3650);
  const end = (asOfDay < hardLimit) ? asOfDay : hardLimit;
  const loopDays = Math.max(0, Math.floor((startOfDay(end).getTime() - startOfDay(day).getTime()) / 86400000) + 1);
  addRecalcLoopCount("dailyLoopIterationsTotal", loopDays);
  setRecalcLoopMaxDays(loopDays, ob && (ob.rowId || ob.key || ""));

  while (day <= end){
    emitActiveFullRecalcHeartbeat("calc-penalty");
    if (!isExcludedDay(day, excludes)){
      overdueIndex += 1;

      // остаток долга на ЭТОТ день.
      // Важно: считаем, что платёж, датированный day, уменьшает долг "с этого дня".
      const applied = sumAppliedUpTo(ob, day);
      const principal = Math.max(ob.amount - applied, 0);

      if (principal > 0.0000001 && overdueIndex > 30){
        const denom = (overdueIndex <= 90) ? 300 : 130;
        const rawRate = rateOnDate(day, rates);
        if (!Number.isFinite(rawRate)) {
          throwRatesFatal("MISSING_REQUIRED_RATE", "", { date: toISODateString(day), reason: "MISSING_REQUIRED_RATE" });
        }
        const rate = capRateUntil2027(day, rawRate);
        penalty += principal * (rate / 100) / denom;
      }
    }
    day = addDays(day, 1);
  }

  return penalty;
}

function calcTotalsAsOf(rows, asOfDate){
  // ✅ Variant B (единый движок): если подключён calc_engine.js (window.JKHCalcEngine),
  // то считаем через него — чтобы карточка и справка совпадали 1:1.
  try {
    const eng = window.JKHCalcEngine;
    if (eng && typeof eng.calcTotalsAsOfAdjusted === 'function') {
      const t = eng.calcTotalsAsOfAdjusted(rows, asOfDate, { abonentId: getAbonentId(), applyAdvanceOffset: true, allowNegativePrincipal: true });
      // 🔒 CRITICAL-ASSERT (DEV): долги не должны быть отрицательными
      if (typeof CRITICAL_ASSERT === 'function') {
        CRITICAL_ASSERT(Number.isFinite(t.principal), 'Card: principal is not finite', { principal: t.principal, asOfDate });
        CRITICAL_ASSERT(Number.isFinite(t.penaltyDebt), 'Card: penalty is not finite', { penalty: t.penaltyDebt, asOfDate });
      }
      return { principal: t.principal, penalty: t.penaltyDebt, total: t.total };
    }
  } catch (e) {
    if (isRatesFatalError(e)) {
      logRatesFatal(e);
      emitManualRatesDiagnostic(e, "payment_table.calcTotalsAsOf.JKHCalcEngine");
      throw e;
    }
    if (isExcludesFatalError(e)) {
      logExcludesFatal(e);
      throw e;
    }
    /* fallback to local calc */
  }

  const excludes = loadExcludes();
  const rates = loadRates();

  // ⚖️ Разделение долга при смене собственника:
  // в расчёт обязательств попадают ТОЛЬКО месяцы ответственности текущего ЛС.
  // (диапазон берём из AbonentsDB.links, а если задано — ещё и из abonent.calcStartDate/calcEndDate)
  let allowedYm = null;
  try {
    const range = getActiveResponsibilityRangeISO();
    if (range?.from) {
      const ms = monthIter(range.from, range.to);
      allowedYm = new Set(ms.map(m => `${m.year}-${m.month}`));
    }
  } catch(e) { console.error(e); throw e; }

  // ---------------------------------------------------------
  // 🔐 CRITICAL (Нулевой старт + помесячная история):
  // НЕЛЬЗЯ включать в "долг на дату" начисления будущих месяцев.
  // Иначе в самом первом месяце (например, Январь 2025) появится
  // огромная "начальная задолженность" из 2026 и далее.
  //
  // Поэтому для расчёта на дату asOfDate берём обязательства
  // только за месяцы <= месяца asOfDate.
  // ---------------------------------------------------------
  const allObligations = buildObligationsFromRows(rows, allowedYm);
  incRecalcCallCount("buildDebtPeriods", 1);
  const asOfYm = `${asOfDate.getFullYear()}-${pad2(asOfDate.getMonth() + 1)}`;
  const obligations = allObligations.filter(ob => String(ob.key || "") <= asOfYm);

  const payments = buildPaymentEventsFromRows(rows);
  const advances = allocatePaymentsFIFO(obligations, payments);

  // Переплата (аванс) на дату asOfDate уменьшает задолженность по обяз.
  // Если аванс превышает долг — задолженность становится отрицательной.
  const asOfDay = startOfDay(asOfDate);
  const advanceUpTo = r2((advances || []).reduce((sum, a) => {
    if (a && a.date && a.date.getTime() <= asOfDay.getTime()) return sum + toNum(a.amount);
    return sum;
  }, 0));

  let principalTotal = 0;
  let penaltyTotal = 0;

  for (let obIdx = 0; obIdx < obligations.length; obIdx += 1){
    emitActiveFullRecalcHeartbeat("calc-totals");
    const ob = obligations[obIdx];
    sortApplications(ob);

    const applied = sumAppliedUpTo(ob, startOfDay(asOfDate));
    const principal = Math.max(ob.amount - applied, 0);
    principalTotal += principal;

    penaltyTotal += calcPenaltyForObligation(ob, asOfDate, excludes, rates);
  }

    const principalAdj = r2(principalTotal - advanceUpTo);

  return {
    principal: principalAdj,
    penalty: r2(penaltyTotal),
    total: r2(principalAdj + penaltyTotal)
  };
}

// Совместимость: раньше были "базовые" расчёты по строке.
// Теперь базовое значение не нужно, но оставляем функцию, чтобы не ломать код.
function calcRowBase(r) {
  r.__base_pay_main = 0;
  r.__base_pay_penalty = 0;
  r.__base_total_debt = 0;
}

const __paymentTotalsMemo = new Map();
window.__calcTotalsMemoStats = window.__calcTotalsMemoStats || {
  totalCalls: 0,
  memoHits: 0,
  memoMisses: 0,
  calcCalls: 0,
  calcTotalMs: 0,
  calcMaxMs: 0,
  reset: function(){
    this.totalCalls = 0;
    this.memoHits = 0;
    this.memoMisses = 0;
    this.calcCalls = 0;
    this.calcTotalMs = 0;
    this.calcMaxMs = 0;
  }
};
let __paymentTableRenderedSignature = "";
let __paymentTableCalcToken = 0;
let __paymentTableCalcTimerActive = false;

function perfNow(){
  try { return (window.performance && typeof window.performance.now === "function") ? window.performance.now() : Date.now(); } catch(e) { return Date.now(); }
}

function perfLog(stage, startedAt){
  const ms = Math.round(Math.max(0, perfNow() - startedAt));
  try { console.log(`[payment-table][perf] ${stage} ms=${ms}`); } catch(e) {}
  return ms;
}

window.JKH_resetPaymentTablePeriodRuntime = function(reason) {
  try { __paymentTotalsMemo.clear(); } catch(eMemo) {}
  try { __calcPeriodMetaCache = null; } catch(eMeta) {}
  __paymentTableRenderedSignature = "";
  __paymentTableCalcToken++;
  __runtimeCacheState = { valid: false, reason: "period-reset", dataById: {}, periodMatches: false };
  try {
    console.log("[payment-table][period-runtime-reset]", {
      abonentId: String(getAbonentId() || ""),
      reason: String(reason || "period-reset")
    });
  } catch(eLog) {}
};

function ledgerSignatureForRows(rows){
  const abonentId = String(getAbonentId() || "");
  const periodActive = isCalcPeriodActive();
  const period = periodActive ? getCalcPeriod() : null;
  const arr = Array.isArray(rows) ? rows : [];
  let h = 2166136261;
  function addPart(v){
    const str = String(v ?? "");
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= 124;
    h = Math.imul(h, 16777619) >>> 0;
  }
  addPart(abonentId);
  addPart(periodActive ? JSON.stringify(period || {}) : "off");
  addPart(arr.length);
  let ledgerSigIdx = 0;
  for (const r of arr){
    ledgerSigIdx += 1;
    if (ledgerSigIdx % 100 === 0) emitActiveFullRecalcHeartbeat("ledger-signature");
    if (!r || typeof r !== "object") { addPart("null"); continue; }
    addPart(r.id); addPart(r.year); addPart(r.month); addPart(r.accrued); addPart(r.paid); addPart(r.paid_date); addPart(r.source);
    addPart(r.use_period ? 1 : 0); addPart(r.period_from_m); addPart(r.period_from_y); addPart(r.period_to_m); addPart(r.period_to_y);
    addPart(r.note); addPart(r.import_locked || r.locked || r.readonly ? 1 : 0);
  }
  return abonentId + "::" + arr.length + "::" + h.toString(16);
}

function memoKeyForTotals(ledgerSignature, asOfDate){
  const d = parseDateAnyToDate(asOfDate) || new Date();
  return String(getAbonentId() || "") + "::" + String(ledgerSignature || "") + "::" + toISODateString(d);
}

function calcTotalsAsOfMemoized(rows, asOfDate, ledgerSignature, caller){
  const hotspotStartedAt = perfNow();
  const hotspotCaller = String(caller || "unknown");
  const hotspotRowsLength = Array.isArray(rows) ? rows.length : 0;
  const hotspotMonthsLength = countRuntimeMonths(rows);
  incRecalcCallCount("calcTotalsAsOfMemoized", 1);
  const stats = window.__calcTotalsMemoStats;
  try {
    if (stats) stats.totalCalls += 1;
    const key = memoKeyForTotals(ledgerSignature, asOfDate);
    const cached = __paymentTotalsMemo.get(key);
    if (cached) {
      if (stats) stats.memoHits += 1;
      return cached;
    }
    if (stats) stats.memoMisses += 1;
    const calcStartedAt = perfNow();
    const t = calcTotalsAsOf(rows, asOfDate);
    const calcMs = Math.max(0, perfNow() - calcStartedAt);
    if (stats) {
      stats.calcCalls += 1;
      stats.calcTotalMs += calcMs;
      if (calcMs > stats.calcMaxMs) stats.calcMaxMs = calcMs;
    }
    const out = { principal: t.principal, penalty: t.penalty, total: t.total };
    __paymentTotalsMemo.set(key, out);
    if (__paymentTotalsMemo.size > 2000) {
      try { __paymentTotalsMemo.clear(); } catch(e) {}
    }
    return out;
  } finally {
    recordCalcTotalsHotspot(hotspotCaller, Math.max(0, perfNow() - hotspotStartedAt), hotspotRowsLength, hotspotMonthsLength);
  }
}

function runningTotalsBaseRows(allRows){
  let baseRows = Array.isArray(allRows) ? allRows : [];
  const periodActive = isCalcPeriodActive();
  if (periodActive) {
    const p = getCalcPeriod();
    const fromD = p ? parseDateAnyToDate(p.from) : null;
    const toD   = p ? parseDateAnyToDate(p.to)   : null;

    if (fromD && toD) {
      const fromKey = (fromD.getFullYear() * 12) + (fromD.getMonth() + 1);
      const toKey   = (toD.getFullYear()   * 12) + (toD.getMonth() + 1);

      let baseRowsFilterIdx = 0;
      baseRows = baseRows.filter(r => {
        baseRowsFilterIdx += 1;
        if (baseRowsFilterIdx % 100 === 0) emitActiveFullRecalcHeartbeat("running-totals-base-rows");
        let y = parseInt(r?.year, 10);
        let m = parseInt(r?.month, 10);
        if (!(Number.isFinite(y) && Number.isFinite(m) && y > 0 && m >= 1 && m <= 12)) {
          const d = parseDateAnyToDate(r?.paid_date);
          if (d) { y = d.getFullYear(); m = d.getMonth() + 1; }
        }
        if (!(Number.isFinite(y) && Number.isFinite(m) && y > 0 && m >= 1 && m <= 12)) return false;
        const key = (y * 12) + m;
        const keep = key >= fromKey && key <= toKey;
        return keep;
      });
    }
  }
  return baseRows;
}

function nextUiTick(){
  return new Promise(resolve => {
    try {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => resolve());
        return;
      }
    } catch(e) {}
    setTimeout(resolve, 0);
  });
}

function currentFullRecalcRunState(){
  const state = window.__JKH_FULL_RECALC_STATE;
  return state && state.running === true ? state : null;
}

function fullRecalcAbortError(reason, message){
  const err = new Error(String(reason || "FULL_RECALC_ABORTED"));
  err.code = String(reason || "FULL_RECALC_ABORTED");
  err.reason = String(reason || "FULL_RECALC_ABORTED");
  err.summary_reason = err.reason;
  err.abortMessage = String(message || "");
  err.fullRecalcAbort = true;
  err.cancelled = err.reason === "FULL_RECALC_CANCELLED";
  err.timedOut = err.reason === "FULL_RECALC_TIMEOUT";
  return err;
}

function getFullRecalcAbortReason(){
  const state = currentFullRecalcRunState();
  if (!state || state.abortRequested !== true) return "";
  return String(state.abortReason || (state.timedOut ? "FULL_RECALC_TIMEOUT" : "FULL_RECALC_CANCELLED"));
}

function throwIfFullRecalcAborted(stage){
  const state = currentFullRecalcRunState();
  if (!state || state.abortRequested !== true) return;
  const reason = getFullRecalcAbortReason() || "FULL_RECALC_CANCELLED";
  state.currentStage = String(stage || state.currentStage || "abort-check");
  state.cancelled = true;
  throw fullRecalcAbortError(reason, state.abortMessage || "");
}

function fullRecalcAbortResult(error, runId, abonentId){
  const reason = String(error && (error.reason || error.code || error.message) || "FULL_RECALC_ABORTED");
  return {
    ok: false,
    cancelled: reason === "FULL_RECALC_CANCELLED",
    timedOut: reason === "FULL_RECALC_TIMEOUT",
    reason: reason,
    summary_status: "error",
    summary_reason: reason,
    status: "error",
    runId: runId,
    abonentId: abonentId
  };
}

function currentRecalcCallCounts(){
  const state = window.__JKH_RECALC_CALL_COUNTS;
  return state && typeof state === "object" ? state : null;
}

function incRecalcCallCount(name, amount){
  const state = currentRecalcCallCounts();
  if (!state || !state.calls) return;
  const key = String(name || "");
  if (!key) return;
  state.calls[key] = Number(state.calls[key] || 0) + (Number(amount) || 1);
}

function addRecalcLoopCount(name, amount){
  const state = currentRecalcCallCounts();
  if (!state || !state.loops) return;
  const key = String(name || "");
  if (!key) return;
  state.loops[key] = Number(state.loops[key] || 0) + (Number(amount) || 0);
}

function setRecalcLoopMaxDays(days, rowId){
  const state = currentRecalcCallCounts();
  if (!state || !state.loops) return;
  const totalDays = Number(days) || 0;
  if (totalDays > Number(state.loops.maxDailyLoopDays || 0)) {
    state.loops.maxDailyLoopDays = totalDays;
    state.loops.maxDailyLoopRowId = String(rowId || "");
  }
}

function setRecalcStageMs(name, elapsedMs){
  const state = currentRecalcCallCounts();
  if (!state || !state.stages) return;
  const key = String(name || "");
  if (!key) return;
  state.stages[key] = Math.max(0, Math.round(Number(elapsedMs) || 0));
}

function countRuntimeMonths(rows){
  const seen = {};
  (Array.isArray(rows) ? rows : []).forEach(function(row){
    const key = String(row && row.year || "") + "-" + String(row && row.month || "");
    if (key !== "-") seen[key] = true;
  });
  return Object.keys(seen).length;
}

function countRuntimeObligations(rows){
  return (Array.isArray(rows) ? rows : []).filter(function(row){ return Math.abs(toNum(row && row.accrued || 0)) > 0.0000001; }).length;
}

function countRuntimePayments(rows){
  return (Array.isArray(rows) ? rows : []).filter(function(row){ return Math.abs(toNum(row && row.paid || 0)) > 0.0000001; }).length;
}

function resetCalcTotalsHotspotReport(runId, abonentId){
  window.__JKH_CALC_TOTALS_HOTSPOT = {
    runId: String(runId || ""),
    abonentId: String(abonentId || ""),
    printed: false,
    totalCallCount: 0,
    totalElapsedMs: 0,
    maxElapsedMs: 0,
    maxRowsLength: 0,
    maxMonthsLength: 0,
    byCaller: {}
  };
}

function recordCalcTotalsHotspot(caller, elapsedMs, rowsLength, monthsLength){
  const state = window.__JKH_CALC_TOTALS_HOTSPOT;
  if (!state || typeof state !== "object" || state.printed === true) return;
  const name = String(caller || "unknown");
  const ms = Math.max(0, Number(elapsedMs) || 0);
  const rows = Math.max(0, Number(rowsLength) || 0);
  const months = Math.max(0, Number(monthsLength) || 0);
  const item = state.byCaller[name] || {
    caller: name,
    callCount: 0,
    totalElapsedMs: 0,
    avgElapsedMs: 0,
    maxElapsedMs: 0,
    rowsLength: 0,
    monthsLength: 0
  };
  item.callCount += 1;
  item.totalElapsedMs += ms;
  item.maxElapsedMs = Math.max(item.maxElapsedMs, ms);
  item.rowsLength = Math.max(item.rowsLength, rows);
  item.monthsLength = Math.max(item.monthsLength, months);
  item.avgElapsedMs = item.callCount ? item.totalElapsedMs / item.callCount : 0;
  state.byCaller[name] = item;
  state.totalCallCount += 1;
  state.totalElapsedMs += ms;
  state.maxElapsedMs = Math.max(state.maxElapsedMs, ms);
  state.maxRowsLength = Math.max(state.maxRowsLength, rows);
  state.maxMonthsLength = Math.max(state.maxMonthsLength, months);
}

function printCalcTotalsHotspotReport(){
  const state = window.__JKH_CALC_TOTALS_HOTSPOT;
  if (!state || typeof state !== "object" || state.printed === true) return;
  if (!state.totalCallCount) {
    if (window.__JKH_CALC_TOTALS_HOTSPOT === state) window.__JKH_CALC_TOTALS_HOTSPOT = null;
    return;
  }
  state.printed = true;
  const callers = Object.keys(state.byCaller || {}).map(function(key){
    const item = state.byCaller[key] || {};
    return {
      caller: String(item.caller || key),
      callCount: Number(item.callCount || 0),
      totalElapsedMs: Math.round(Number(item.totalElapsedMs || 0)),
      avgElapsedMs: item.callCount ? Math.round((Number(item.totalElapsedMs || 0) / Number(item.callCount || 1)) * 100) / 100 : 0,
      maxElapsedMs: Math.round(Number(item.maxElapsedMs || 0)),
      rowsLength: Number(item.rowsLength || 0),
      monthsLength: Number(item.monthsLength || 0)
    };
  }).sort(function(a, b){ return b.totalElapsedMs - a.totalElapsedMs; });
  try {
    console.log("[calc-totals-hotspot]", {
      caller: "all",
      callCount: Number(state.totalCallCount || 0),
      totalElapsedMs: Math.round(Number(state.totalElapsedMs || 0)),
      avgElapsedMs: state.totalCallCount ? Math.round((Number(state.totalElapsedMs || 0) / Number(state.totalCallCount || 1)) * 100) / 100 : 0,
      maxElapsedMs: Math.round(Number(state.maxElapsedMs || 0)),
      rowsLength: Number(state.maxRowsLength || 0),
      monthsLength: Number(state.maxMonthsLength || 0),
      callers: callers
    });
  } catch(eHotspotLog) {}
  if (window.__JKH_CALC_TOTALS_HOTSPOT === state) window.__JKH_CALC_TOTALS_HOTSPOT = null;
}

async function measureRecalcStage(name, fn){
  const startedAt = perfNow();
  try {
    return await fn();
  } finally {
    setRecalcStageMs(name, perfNow() - startedAt);
  }
}

function fullRecalcRunIdFromOptions(opts){
  return String(opts && (opts.recalcRunId || opts.runId) || currentFullRecalcRunState() && currentFullRecalcRunState().runId || "");
}

function logFullRecalcStep(runId, step, extra){
  try {
    if (window.__JKH_FULL_RECALC_HEARTBEAT) window.__JKH_FULL_RECALC_HEARTBEAT(String(runId || ""), String(step || ""));
  } catch(eHeartbeat) {}
  try {
    console.log("[full-recalc][step]", Object.assign({
      runId: String(runId || ""),
      step: String(step || "")
    }, extra || {}));
  } catch(eLog) {}
}

function logFullRecalcStepDone(runId, step, extra){
  try {
    if (window.__JKH_FULL_RECALC_HEARTBEAT) window.__JKH_FULL_RECALC_HEARTBEAT(String(runId || ""), String(step || "") + "-done");
  } catch(eHeartbeat) {}
  try {
    console.log("[full-recalc][step-done]", Object.assign({
      runId: String(runId || ""),
      step: String(step || "")
    }, extra || {}));
  } catch(eLog) {}
}

function emitFullRecalcHeartbeat(runId, stage){
  try {
    if (window.__fullRecalcHeartbeat) window.__fullRecalcHeartbeat({ runId: String(runId || ""), stage: String(stage || "") });
    else if (window.__JKH_FULL_RECALC_HEARTBEAT) window.__JKH_FULL_RECALC_HEARTBEAT(String(runId || ""), String(stage || ""));
  } catch(eHeartbeat) {}
}

let __fullRecalcSyncHeartbeatLastAt = 0;
function emitActiveFullRecalcHeartbeat(stage, force){
  try {
    const state = window.__JKH_FULL_RECALC_STATE;
    if (!state || state.running !== true) return;
    const now = Date.now();
    if (!force && (now - __fullRecalcSyncHeartbeatLastAt) < 500) return;
    __fullRecalcSyncHeartbeatLastAt = now;
    emitFullRecalcHeartbeat(state.runId || "", stage || state.currentStage || "full-recalc-progress");
  } catch(eHeartbeat) {}
}

async function maybeYieldFullRecalcProgress(progress, runId, stage, index){
  const p = progress && typeof progress === "object" ? progress : {};
  const now = perfNow();
  const rowDue = Number.isFinite(Number(index)) && Number(index) > 0 && Number(index) % 100 === 0;
  const timeDue = !p.lastYieldAt || (now - p.lastYieldAt) >= 500;
  if (!rowDue && !timeDue) return;
  throwIfFullRecalcAborted(stage);
  p.lastYieldAt = now;
  emitFullRecalcHeartbeat(runId, stage);
  await nextUiTick();
  throwIfFullRecalcAborted(stage);
}

async function buildRowsByIdSlowLegacy(rows, baseRows, sig, options){
  const opts = options && typeof options === "object" ? options : {};
  const rowsById = {};
  const runtimeRows = Array.isArray(rows) ? rows : [];
  const progress = { lastYieldAt: perfNow() };
  const startedAt = perfNow();
  for (let idx = 0; idx < runtimeRows.length; idx += 1) {
    await maybeYieldFullRecalcProgress(progress, opts.runId || "", opts.stage || "build-runtime-rows", idx);
    const r = runtimeRows[idx];
    if (idx > 0 && idx % 25 === 0) emitFullRecalcHeartbeat(opts.runId || "", opts.stage || "build-runtime-rows");
    const asOf = asOfForRow(r);
    const t = calcTotalsAsOfMemoized(baseRows, asOf, sig, opts.caller || "fullRecalc.buildRowsByIdSlowLegacy");
    rowsById[String(r.id)] = { pay_main: t.principal, pay_penalty: t.penalty, total: t.total };
    await maybeYieldFullRecalcProgress(progress, opts.runId || "", opts.stage || "build-runtime-rows", idx + 1);
  }
  return { ok: true, usedPath: "slow", rowsById, rowsCount: runtimeRows.length, elapsedMs: Math.round(Math.max(0, perfNow() - startedAt)), calcCalls: runtimeRows.length };
}

function hasStoredTransferOrFreezeForFastRecalc(abonentId){
  try {
    const id = String(abonentId || "");
    if (!id) return false;
    if (String(storeGetRaw("jkh_freeze_to_v1:" + id) || "").trim()) return true;
    if (String(storeGetRaw("jkh_transfer_to_v1:" + id) || "").trim()) return true;
    const abonent = window.AbonentsDB && window.AbonentsDB.abonents && window.AbonentsDB.abonents[id] || null;
    const regnum = String(abonent && (abonent.premiseRegnum || abonent.regnum) || "").trim();
    if (regnum && String(storeGetRaw("jkh_transfer_balance_v1:" + id + ":" + regnum) || "").trim()) return true;
  } catch(e) {}
  return false;
}

function hasPeriodTargetedPaymentsForFastRecalc(rows){
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i += 1) {
    const r = list[i] || {};
    if (toNum(r.paid) <= 0) continue;
    if (r.use_period === true || r.pay_for_period === true || r.usePeriod === true) return true;
    const periodFrom = String(r.pay_period_from || r.for_period_from || r.periodFrom || r.from_period || r.from || "").trim();
    const periodTo = String(r.pay_period_to || r.for_period_to || r.periodTo || r.to_period || r.to || "").trim();
    if (periodFrom || periodTo) return true;
  }
  return false;
}

function fastFullRecalcPreconditionFailure(rows, selectedPeriod, abonentId, options){
  const opts = options && typeof options === "object" ? options : {};
  if (String(opts.recalcMode || "").toUpperCase() !== "FULL_SUMMARY_REBUILD") return "NOT_FULL_RECALC";
  if (opts.periodActive === true || selectedPeriod) return "PERIOD_ACTIVE";
  if (window.JKH_CARD_PERIOD_MODE_ACTIVE === true) return "TEMPORARY_PERIOD_MODE_ACTIVE";
  try { if (typeof isCalcPeriodActive === "function" && isCalcPeriodActive()) return "GLOBAL_PERIOD_ACTIVE"; } catch(ePeriodActive) {}
  if (!Array.isArray(rows)) return "ROWS_NOT_ARRAY";
  if (hasStoredTransferOrFreezeForFastRecalc(abonentId)) return "TRANSFER_OR_FREEZE_ACTIVE";
  if (hasPeriodTargetedPaymentsForFastRecalc(rows)) return "PERIOD_TARGETED_PAYMENTS";
  const required = [buildObligationsFromRows, buildPaymentEventsFromRows, allocatePaymentsFIFO, calcPenaltyForObligation, loadExcludes, loadRates, runningTotalsBaseRows];
  if (required.some(function(fn){ return typeof fn !== "function"; })) return "HELPER_UNAVAILABLE";
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i] || {};
    if (String(r.id || "").trim() === "") return "ROW_ID_MISSING";
    const asOf = asOfForRow(r);
    if (!asOf || asOf.toString() === "Invalid Date") return "ROW_ASOF_INVALID";
    const y = parseInt(r.year, 10);
    const m = parseInt(r.month, 10);
    if (!(Number.isFinite(y) && y > 0 && Number.isFinite(m) && m >= 1 && m <= 12)) return "ROW_MONTH_INVALID";
  }
  return "";
}

function cloneFastObligation(ob){
  return {
    key: ob.key,
    serviceYear: ob.serviceYear,
    serviceMonth: ob.serviceMonth,
    amount: ob.amount,
    dueDate: ob.dueDate,
    applications: []
  };
}

function fastResponsibilityAllowedYm(){
  try {
    const range = getActiveResponsibilityRangeISO();
    if (range && range.from) {
      const ms = monthIter(range.from, range.to);
      return new Set(ms.map(function(m){ return `${m.year}-${m.month}`; }));
    }
  } catch(e) {
    throw e;
  }
  return null;
}

function fastMonthKeyFromISO(iso){
  if (!iso || typeof iso !== "string") return null;
  const m = iso.match(/^(\d{4})-(\d{2})/);
  return m ? (m[1] + "-" + m[2]) : null;
}

function fastPaymentRowPeriod(row){
  const r = row || {};
  const pf = r.period_from || r.pay_period_from || r.for_period_from || r.periodFrom || r.from_period || r.from || "";
  const pt = r.period_to || r.pay_period_to || r.for_period_to || r.periodTo || r.to_period || r.to || "";
  const mkFrom = fastMonthKeyFromISO(pf);
  const mkTo = fastMonthKeyFromISO(pt);
  if (mkFrom || mkTo) return { mkFrom: mkFrom || mkTo, mkTo: mkTo || mkFrom };
  return null;
}

function buildFastPaymentEventsFromRows(rows){
  try {
    const eng = window.JKHCalcEngine;
    if (eng && typeof eng.buildPaymentEventsFromRows === "function") {
      const events = eng.buildPaymentEventsFromRows(rows, getAbonentId());
      if (Array.isArray(events)) return events;
    }
  } catch(eEngineEvents) {
    if (isRatesFatalError(eEngineEvents) || isExcludesFatalError(eEngineEvents)) throw eEngineEvents;
  }
  const pays = [];
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i] || {};
    const paid = toNum(row.paid);
    if (paid <= 0) continue;
    const d = parseDateAnyToDate(row.paid_date);
    if (!d) continue;
    const payMonthKey = d.getFullYear() + "-" + pad2(d.getMonth() + 1);
    let minKey = "0000-00";
    let maxKey = payMonthKey;
    const rp = fastPaymentRowPeriod(row);
    if (rp) {
      minKey = rp.mkFrom || minKey;
      maxKey = rp.mkTo || maxKey;
    }
    pays.push({ date: startOfDay(d), amount: r2(paid), rowId: row.id, minKey, maxKey, payMonthKey });
  }
  pays.sort(function(a,b){ return a.date - b.date || (Number(a.rowId) || 0) - (Number(b.rowId) || 0); });
  return pays;
}

function allocateFastPaymentsFIFO(obligations, payments){
  try {
    const eng = window.JKHCalcEngine;
    if (eng && typeof eng.allocatePaymentsFIFO === "function") {
      const advances = eng.allocatePaymentsFIFO(obligations, payments);
      if (Array.isArray(advances)) return advances;
    }
  } catch(eEngineAllocate) {
    if (isRatesFatalError(eEngineAllocate) || isExcludesFatalError(eEngineAllocate)) throw eEngineAllocate;
  }
  const advances = [];
  function remaining(ob){
    const applied = ob.applications.reduce(function(sum, x){ return sum + x.amount; }, 0);
    return Math.max(ob.amount - applied, 0);
  }
  for (let pIdx = 0; pIdx < payments.length; pIdx += 1) {
    const p = payments[pIdx];
    let left = p.amount;
    const minKey = String(p.minKey || "0000-00");
    const maxKey = String(p.maxKey || "9999-99");
    for (let i = 0; i < obligations.length && left > 0.0000001; i += 1) {
      const ob = obligations[i];
      const key = String(ob.key || "");
      if (key < minKey || key > maxKey) continue;
      const rem = remaining(ob);
      if (rem <= 0.0000001) continue;
      const take = Math.min(rem, left);
      ob.applications.push({ date: p.date, amount: r2(take) });
      left = r2(left - take);
    }
    if (left > 0.0000001) advances.push({ date: p.date, amount: r2(left) });
  }
  return advances;
}

function buildFastObligationsFromRows(rows, allowedYm){
  try {
    const eng = window.JKHCalcEngine;
    if (eng && typeof eng.buildObligationsFromRows === "function") {
      const obligations = eng.buildObligationsFromRows(rows, allowedYm);
      if (Array.isArray(obligations)) return obligations;
    }
  } catch(eEngineObligations) {
    if (isRatesFatalError(eEngineObligations) || isExcludesFatalError(eEngineObligations)) throw eEngineObligations;
  }
  return buildObligationsFromRows(rows, allowedYm);
}

function compareRowsByIdWithTolerance(expected, actual, rows, tolerance){
  const tol = Number.isFinite(Number(tolerance)) ? Number(tolerance) : 0.01;
  const mismatches = [];
  const list = Array.isArray(rows) ? rows : [];
  const fields = [
    { oldKey: "pay_main", newKey: "pay_main", label: "principal" },
    { oldKey: "pay_penalty", newKey: "pay_penalty", label: "penalty" },
    { oldKey: "total", newKey: "total", label: "total" }
  ];
  for (let i = 0; i < list.length; i += 1) {
    const rowId = String(list[i] && list[i].id || "");
    const oldItem = expected && expected[rowId] || null;
    const newItem = actual && actual[rowId] || null;
    if (!oldItem || !newItem) {
      mismatches.push({ rowId, field: "missing", expected: oldItem || null, actual: newItem || null });
      continue;
    }
    for (let f = 0; f < fields.length; f += 1) {
      const field = fields[f];
      const oldValue = r2(toNum(oldItem[field.oldKey]));
      const newValue = r2(toNum(newItem[field.newKey]));
      if (Math.abs(oldValue - newValue) > tol) {
        mismatches.push({ rowId, field: field.label, expected: oldValue, actual: newValue });
        break;
      }
    }
  }
  return mismatches;
}

function sampleRowsForFastVerify(rows){
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];
  const indexes = [0, Math.floor((list.length - 1) / 2), list.length - 1].filter(function(value, index, arr){
    return value >= 0 && arr.indexOf(value) === index;
  });
  return indexes.map(function(idx){ return list[idx]; });
}

function buildRowsByIdFastCore(rows, selectedPeriod, abonentId, options){
  const opts = options && typeof options === "object" ? options : {};
  const runtimeRows = Array.isArray(rows) ? rows : [];
  const startedAt = perfNow();
  const baseRows = Array.isArray(opts.baseRows) ? opts.baseRows : runningTotalsBaseRows(runtimeRows);
  const id = String(abonentId || getAbonentId() || "");
  const excludes = loadExcludes(id);
  const rates = loadRates(id);
  const allObligations = buildFastObligationsFromRows(baseRows, fastResponsibilityAllowedYm());
  const paymentsAll = buildFastPaymentEventsFromRows(baseRows);
  const advancesAll = allocateFastPaymentsFIFO(allObligations, paymentsAll);
  for (let obSortIdx = 0; obSortIdx < allObligations.length; obSortIdx += 1) sortApplications(allObligations[obSortIdx]);
  advancesAll.sort(function(a,b){ return (a.date && a.date.getTime ? a.date.getTime() : 0) - (b.date && b.date.getTime ? b.date.getTime() : 0); });
  const rowsById = {};
  const byAsOf = new Map();
  for (let i = 0; i < runtimeRows.length; i += 1) {
    const row = runtimeRows[i];
    const asOf = asOfForRow(row);
    const key = `${asOf.getFullYear()}-${pad2(asOf.getMonth() + 1)}-${pad2(asOf.getDate())}`;
    if (!byAsOf.has(key)) byAsOf.set(key, { asOf, rows: [] });
    byAsOf.get(key).rows.push(row);
  }
  const dates = Array.from(byAsOf.keys()).sort();
  const penaltyStates = new Map();
  function stateForObligation(ob){
    const key = String(ob && ob.key || "");
    let state = penaltyStates.get(key);
    if (state) return state;
    const start = startOfDay(addDays(ob.dueDate, 1));
    state = {
      day: start,
      hardEnd: startOfDay(addDays(ob.dueDate, 3650)),
      appIdx: 0,
      applied: 0,
      overdueIndex: 0,
      penalty: 0
    };
    penaltyStates.set(key, state);
    return state;
  }
  function advancePenaltyTo(ob, asOfDay){
    if (asOfDay <= ob.dueDate) return 0;
    const state = stateForObligation(ob);
    const end = asOfDay < state.hardEnd ? asOfDay : state.hardEnd;
    while (state.day <= end) {
      emitActiveFullRecalcHeartbeat(opts.stage || "build-runtime-rows-fast");
      while (state.appIdx < ob.applications.length && ob.applications[state.appIdx].date.getTime() <= state.day.getTime()) {
        state.applied += toNum(ob.applications[state.appIdx].amount);
        state.appIdx += 1;
      }
      if (!isExcludedDay(state.day, excludes)) {
        state.overdueIndex += 1;
        const principal = Math.max(ob.amount - state.applied, 0);
        if (principal > 0.0000001 && state.overdueIndex > 30) {
          const denom = (state.overdueIndex <= 90) ? 300 : 130;
          const rawRate = rateOnDate(state.day, rates);
          if (!Number.isFinite(rawRate)) {
            throwRatesFatal("MISSING_REQUIRED_RATE", "", { date: toISODateString(state.day), reason: "MISSING_REQUIRED_RATE" });
          }
          const rate = capRateUntil2027(state.day, rawRate);
          state.penalty += principal * (rate / 100) / denom;
        }
      }
      state.day = addDays(state.day, 1);
    }
    return state.penalty;
  }
  function appliedUpToSorted(ob, asOfDay){
    return sumAppliedUpTo(ob, asOfDay);
  }
  function advanceUpTo(asOfDay){
    let total = 0;
    const t = asOfDay.getTime();
    for (let i = 0; i < advancesAll.length; i += 1) {
      const a = advancesAll[i];
      if (!a || !a.date || a.date.getTime() > t) break;
      total += toNum(a.amount);
    }
    return r2(total);
  }
  for (let i = 0; i < dates.length; i += 1) {
    throwIfFullRecalcAborted(opts.stage || "build-runtime-rows-fast");
    const item = byAsOf.get(dates[i]);
    const asOfDate = item.asOf;
    const asOfDay = startOfDay(asOfDate);
    const asOfYm = `${asOfDate.getFullYear()}-${pad2(asOfDate.getMonth() + 1)}`;
    let principalTotal = 0;
    let penaltyTotal = 0;
    for (let obIdx = 0; obIdx < allObligations.length; obIdx += 1) {
      const ob = allObligations[obIdx];
      if (String(ob.key || "") > asOfYm) break;
      const applied = appliedUpToSorted(ob, asOfDay);
      principalTotal += Math.max(ob.amount - applied, 0);
      penaltyTotal += advancePenaltyTo(ob, asOfDay);
    }
    let principal = r2(principalTotal - advanceUpTo(asOfDay));
    let penaltyDebt = r2(penaltyTotal);
    if (principal < 0) {
      let extra = r2(-principal);
      const usedOnPenalty = r2(Math.min(extra, penaltyDebt));
      penaltyDebt = r2(Math.max(penaltyDebt - usedOnPenalty, 0));
      extra = r2(extra - usedOnPenalty);
      principal = r2(-extra);
    }
    const total = r2(principal + penaltyDebt);
    for (let rowIdx = 0; rowIdx < item.rows.length; rowIdx += 1) {
      rowsById[String(item.rows[rowIdx].id)] = { pay_main: principal, pay_penalty: penaltyDebt, total: total };
    }
  }
  return {
    ok: true,
    usedPath: "fast",
    rowsById,
    rowsCount: runtimeRows.length,
    uniqueAsOfCount: dates.length,
    oldCallsAvoided: runtimeRows.length,
    elapsedMs: Math.round(Math.max(0, perfNow() - startedAt))
  };
}

async function buildRowsByIdFastVerified(rows, selectedPeriod, abonentId, options){
  const opts = options && typeof options === "object" ? options : {};
  const startedAt = perfNow();
  const runtimeRows = Array.isArray(rows) ? rows : [];
  const verify = window.JKH_VERIFY_FAST_FULL_RECALC === true;
  const fallbackReason = fastFullRecalcPreconditionFailure(runtimeRows, selectedPeriod, abonentId, opts);
  const baseRows = Array.isArray(opts.baseRows) ? opts.baseRows : runningTotalsBaseRows(runtimeRows);
  const sig = String(opts.signature || "");
  const slowOptions = Object.assign({}, opts, { caller: opts.slowCaller || opts.caller || "fullRecalc.buildRowsByIdSlowLegacy" });
  let fast = null;
  let usedPath = "slow";
  let reason = fallbackReason;
  if (!fallbackReason) {
    try {
      fast = buildRowsByIdFastCore(runtimeRows, selectedPeriod, abonentId, Object.assign({}, opts, { baseRows }));
      reason = "";
      if (!verify) {
        const sampleRows = sampleRowsForFastVerify(runtimeRows);
        const expected = {};
        for (let i = 0; i < sampleRows.length; i += 1) {
          const row = sampleRows[i];
          const t = calcTotalsAsOfMemoized(baseRows, asOfForRow(row), sig, "fullRecalc.fastSampleVerify");
          expected[String(row.id)] = { pay_main: t.principal, pay_penalty: t.penalty, total: t.total };
        }
        const sampleMismatches = compareRowsByIdWithTolerance(expected, fast.rowsById, sampleRows, 0.01);
        if (sampleMismatches.length) reason = "SAMPLE_MISMATCH";
      }
    } catch(eFast) {
      if (isRatesFatalError(eFast)) {
        emitManualRatesDiagnostic(eFast, "payment_table.buildRowsByIdFastVerified.fastPath");
      }
      reason = String(eFast && (eFast.reason || eFast.code || eFast.message) || eFast || "FAST_FAILED");
      if (eFast && eFast.fullRecalcAbort === true) throw eFast;
    }
  }
  if (verify) {
    const slow = await buildRowsByIdSlowLegacy(runtimeRows, baseRows, sig, slowOptions);
    const mismatches = fast && !reason ? compareRowsByIdWithTolerance(slow.rowsById, fast.rowsById, runtimeRows, 0.01) : [{ reason: reason || "FAST_NOT_AVAILABLE" }];
    if (opts.suppressSummaryLog !== true) {
      try {
        console.log("[fast-recalc-verify]", {
          rowsCount: runtimeRows.length,
          mismatches: mismatches.length,
          firstMismatch: mismatches[0] || null,
          oldElapsedMs: slow.elapsedMs,
          newElapsedMs: fast ? fast.elapsedMs : 0
        });
      } catch(eVerifyLog) {}
    }
    if (!mismatches.length && fast) {
      usedPath = "fast";
      if (opts.suppressSummaryLog !== true) {
        try {
          console.log("[fast-recalc-summary]", {
            usedPath: "fast",
            fallbackReason: "",
            rowsCount: runtimeRows.length,
            oldCallsAvoided: fast.oldCallsAvoided || runtimeRows.length,
            elapsedMs: Math.round(Math.max(0, perfNow() - startedAt))
          });
        } catch(eSummaryLog) {}
      }
      return fast;
    }
    if (opts.suppressSummaryLog !== true) {
      try {
        console.log("[fast-recalc-summary]", {
          usedPath: "slow",
          fallbackReason: mismatches[0] && (mismatches[0].reason || "VERIFY_MISMATCH") || "VERIFY_MISMATCH",
          rowsCount: runtimeRows.length,
          oldCallsAvoided: 0,
          elapsedMs: Math.round(Math.max(0, perfNow() - startedAt))
        });
      } catch(eSummaryLog) {}
    }
    return slow;
  }
  if (!reason && fast) {
    usedPath = "fast";
    if (opts.suppressSummaryLog !== true) {
      try {
        console.log("[fast-recalc-summary]", {
          usedPath,
          fallbackReason: "",
          rowsCount: runtimeRows.length,
          oldCallsAvoided: fast.oldCallsAvoided || runtimeRows.length,
          elapsedMs: Math.round(Math.max(0, perfNow() - startedAt))
        });
      } catch(eSummaryLog) {}
    }
    return fast;
  }
  const slow = await buildRowsByIdSlowLegacy(runtimeRows, baseRows, sig, slowOptions);
  if (opts.suppressSummaryLog !== true) {
    try {
      console.log("[fast-recalc-summary]", {
        usedPath: "slow",
        fallbackReason: reason || "FAST_PRECONDITION_FAILED",
        rowsCount: runtimeRows.length,
        oldCallsAvoided: 0,
        elapsedMs: Math.round(Math.max(0, perfNow() - startedAt))
      });
    } catch(eSummaryLog) {}
  }
  return slow;
}

function tryReuseFreshFullRecalcRuntimeCache(abonentId, options){
  const opts = options && typeof options === "object" ? options : {};
  const startedAt = perfNow();
  const id = String(abonentId || getAbonentId() || "");
  const out = { ok: false, reason: "NOT_CHECKED" };
  if (!id || !window.Data) { out.reason = "DATA_UNAVAILABLE"; return out; }
  if (String(opts.recalcMode || "").toUpperCase() !== "FULL_SUMMARY_REBUILD") { out.reason = "NOT_FULL_RECALC"; return out; }
  if (opts.periodActive === true || opts.selectedPeriod) { out.reason = "PERIOD_ACTIVE"; return out; }
  if (opts.autoaccrualChanged === true) { out.reason = "AUTOACCRUAL_CHANGED"; return out; }
  if (window.JKH_CARD_PERIOD_MODE_ACTIVE === true) { out.reason = "TEMPORARY_PERIOD_MODE_ACTIVE"; return out; }
  if (typeof Data.computeLedgerRuntimeVersion !== "function" || typeof Data.readLedgerRuntimeCache !== "function" || typeof Data.isLedgerRuntimeCacheValid !== "function") {
    out.reason = "RUNTIME_CACHE_API_UNAVAILABLE";
    return out;
  }
  const rows = Array.isArray(opts.rows) ? opts.rows : getPayments();
  const ledgerVersion = String(Data.computeLedgerRuntimeVersion(id) || "");
  const runtimeSignatureValue = runtimeCacheSignature(ledgerVersion, false, null);
  const validationOptions = {
    rows: rows,
    visibleRows: typeof Data.getVisibleFinancialRowsForCacheValidation === "function"
      ? Data.getVisibleFinancialRowsForCacheValidation(rows, { periodActive: false, selectedPeriod: null })
      : rows,
    periodActive: false,
    selectedPeriod: null,
    runtimeSignature: runtimeSignatureValue
  };
  const cache = Data.readLedgerRuntimeCache(id, validationOptions);
  const validity = Data.isLedgerRuntimeCacheValid(id, cache, validationOptions);
  if (!validity || validity.valid !== true) {
    out.reason = String(validity && validity.reason || "RUNTIME_CACHE_INVALID");
    return out;
  }
  const rowsById = cache && cache.rowsById && typeof cache.rowsById === "object" && !Array.isArray(cache.rowsById) ? cache.rowsById : {};
  if (!Object.keys(rowsById).length) { out.reason = "RUNTIME_CACHE_ROWS_MISSING"; return out; }
  let snapshot = null;
  if (typeof Data.readCardSnapshot === "function") snapshot = Data.readCardSnapshot(id);
  const snapshotStatus = String(snapshot && (snapshot.summary_status || snapshot.status) || "").toLowerCase();
  if (!snapshot || snapshot.dirty === true || snapshotStatus !== "fresh") {
    out.reason = snapshot && snapshot.dirty === true ? String(snapshot.dirtyReason || "CARD_SNAPSHOT_DIRTY") : "FRESH_SUMMARY_SNAPSHOT_MISSING";
    return out;
  }
  if (String(snapshot.ledgerVersion || "") !== ledgerVersion) { out.reason = "CARD_SNAPSHOT_STALE"; return out; }
  if (snapshot.periodActive === true) { out.reason = "CARD_SNAPSHOT_PERIOD_ACTIVE"; return out; }
  capturePaymentTableComputedRowsSnapshot(rows, rowsById, false, null, runtimeSignatureValue, ledgerVersion);
  const summary = {
    status: "fresh",
    reason: "OK",
    summary_status: "fresh",
    summary_reason: "OK",
    totals: snapshot.totals && typeof snapshot.totals === "object" ? Object.assign({}, snapshot.totals) : {}
  };
  try {
    console.log("[full-recalc][already-fresh]", {
      runId: String(opts.runId || ""),
      abonentId: id,
      ledgerVersion: ledgerVersion,
      runtimeSignature: runtimeSignatureValue,
      rowsByIdCount: Object.keys(rowsById).length,
      elapsedMs: Math.round(Math.max(0, perfNow() - startedAt))
    });
    console.log("[fast-recalc-summary]", {
      usedPath: "runtime_cache_already_fresh",
      fallbackReason: "",
      elapsedMs: Math.round(Math.max(0, perfNow() - startedAt)),
      oldCallsAvoided: countRuntimeMonths(rows)
    });
  } catch(eLog) {}
  return {
    ok: true,
    reason: "ALREADY_FRESH",
    usedPath: "runtime_cache_already_fresh",
    rows: rows,
    rowsById: rowsById,
    rowsCount: rows.length,
    ledgerVersion: ledgerVersion,
    runtimeSignature: runtimeSignatureValue,
    summary: summary,
    elapsedMs: Math.round(Math.max(0, perfNow() - startedAt))
  };
}

// Нарастающий итог: теперь это "состояние долга и пени на дату строки"

// --- AS-OF дата для строки (важно для корректной помесячной истории пени)
// Правило:
// - "Дата оплаты" влияет на расчёт ТОЛЬКО если реально была оплата (paid > 0)
// - если оплаты нет, считаем "по состоянию на конец месяца строки", а не "на сегодня"
function endOfMonthDate(y, m) {
  // y=2025, m=1..12 -> последний день месяца
  return new Date(y, m, 0); // day 0 следующего месяца = последний день текущего
}

function asOfForRow(r) {
  const paid = toNum(r?.paid);

  if (paid > 0) {
    const d = parseDateAnyToDate(r?.paid_date);
    if (d) return startOfDay(d);
  }

  const y = parseInt(r?.year, 10);
  const m = parseInt(r?.month, 10);
  if (Number.isFinite(y) && Number.isFinite(m) && y > 0 && m >= 1 && m <= 12) {
    return startOfDay(endOfMonthDate(y, m));
  }

  return startOfDay(new Date());
}

function applyRunningTotals(viewRows, ledgerSignature) {
  const allRows = Array.isArray(viewRows) ? viewRows : getPayments();
  const baseRows = runningTotalsBaseRows(allRows);

  const sortedAsc = viewRows.slice().sort((a, b) => {
    const at = paidDateMsAscKey(a);
    const bt = paidDateMsAscKey(b);
    if (at !== bt) return at - bt;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });

  const sig = ledgerSignature || ledgerSignatureForRows(baseRows);
  for (const r of sortedAsc){
    const asOf = asOfForRow(r);
        const t = calcTotalsAsOfMemoized(baseRows, asOf, sig, "scheduleRunningTotalsUpdate");
    r.pay_main = t.principal;
    r.pay_penalty = t.penalty;
    r.total = t.total;
  }
}

function scheduleRunningTotalsUpdate(viewRows, baseRows, tbody, ledgerSignature){
  const rows = Array.isArray(viewRows) ? viewRows.slice() : [];
  const calcRows = Array.isArray(baseRows) ? baseRows : rows;
  const token = ++__paymentTableCalcToken;
  const startedAt = perfNow();
  resetRenderFinancialFieldsLog();
  resetActualRenderFinancialFieldsLog();
  if (__paymentTableCalcTimerActive) { try { console.timeEnd('[payment-table] calc-totals'); } catch(e) {} }
  __paymentTableCalcTimerActive = true;
  try { console.time('[payment-table] calc-totals'); } catch(e) {}

  rows.sort((a, b) => {
    const at = paidDateMsAscKey(a);
    const bt = paidDateMsAscKey(b);
    if (at !== bt) return at - bt;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });

  let idx = 0;

  function finish(){
    if (__paymentTableCalcTimerActive) { try { console.timeEnd('[payment-table] calc-totals'); } catch(e) {} }
    __paymentTableCalcTimerActive = false;
    perfLog('calc', startedAt);
  }

  function step(){
    if (token !== __paymentTableCalcToken) return;
    const sliceStarted = perfNow();
    try {
      while (idx < rows.length && (perfNow() - sliceStarted) < 24) {
        const r = rows[idx++];
        const asOf = asOfForRow(r);
        const t = calcTotalsAsOfMemoized(calcRows, asOf, ledgerSignature, "scheduleRunningTotalsUpdate.step");
        r.pay_main = t.principal;
        r.pay_penalty = t.penalty;
        r.total = t.total;
        if (tbody) {
          const tr = tbody.querySelector(`tr[data-row-id="${String(r.id)}"]`);
          if (tr) updateComputedCells(tr, r);
        }
      }
    } catch (e) {
      if (__paymentTableCalcTimerActive) { try { console.timeEnd('[payment-table] calc-totals'); } catch(_) {} }
      __paymentTableCalcTimerActive = false;
      if (isRatesFatalError(e)) { renderRatesFatal(tbody); return; }
      if (isExcludesFatalError(e)) { renderExcludesFatal(tbody); return; }
      console.error(e);
      throw e;
    }
    if (idx < rows.length) {
      setTimeout(step, 0);
    } else {
      finish();
    }
  }

  setTimeout(step, 0);
}

  // =============================================================
  // КЛЮЧИ JKHStore для ставок рефинансирования
  // (вынесены в constants.js; здесь — безопасные fallback'и)
  // =============================================================
  const REFI_KEY_NORMAL = (window.JKH_CONST && window.JKH_CONST.REFI_KEY_NORMAL)
    ? window.JKH_CONST.REFI_KEY_NORMAL
    : "refinancing_rates_normal_v1";

  const REFI_KEY_MORA = (window.JKH_CONST && window.JKH_CONST.REFI_KEY_MORA)
    ? window.JKH_CONST.REFI_KEY_MORA
    : "refinancing_rates_moratorium_v1";

  async function ensureGlobalRefinancingRatesHydrated(source){
    const keys = [REFI_KEY_NORMAL, REFI_KEY_MORA];
    const ownerId = currentOwnerIdForPaymentCache();
    const result = {
      ok: true,
      source: String(source || ""),
      ownerId: String(ownerId || ""),
      loaded: [],
      existing: [],
      missing: []
    };
    try {
      console.log("[manual-recalc][rates-hydrate]", {
        reason: "rates_hydrate_before_recalc_start",
        source: result.source,
        ownerId: result.ownerId,
        keys
      });
    } catch(eStartLog) {}
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      let raw = storeGetRaw(key);
      if (raw !== null && raw !== undefined && String(raw) !== "") {
        result.existing.push(key);
        continue;
      }
      if (typeof fetch !== "function") {
        result.ok = false;
        result.missing.push(key);
        continue;
      }
      try {
        const url = "/api/store?key=" + encodeURIComponent(key) + "&client_owner_hint=" + encodeURIComponent(ownerId);
        const res = await fetch(url, { method: "GET", credentials: "include" });
        let data = null;
        try { data = await res.json(); } catch(eJson) {}
        const value = data && data.value;
        if (res.ok && data && data.ok === true && value !== null && value !== undefined && String(value) !== "") {
          if (!(window.JKHStore && typeof JKHStore.hydrateGlobalReadCache === "function")) {
            throw new Error("GLOBAL_READ_CACHE_HELPER_UNAVAILABLE");
          }
          JKHStore.hydrateGlobalReadCache(key, String(value));
          try {
            console.log("[manual-recalc][rates-hydrate]", {
              reason: "rates_hydrate_global_read_cache_written",
              source: result.source,
              ownerId: result.ownerId,
              key: key,
              serverOwner: String(data && data.owner || ""),
              valueLength: String(value || "").length
            });
          } catch(eCacheWrittenLog) {}
          raw = storeGetRaw(key);
          if (raw !== null && raw !== undefined && String(raw) !== "") {
            result.loaded.push(key);
            try {
              console.log("[manual-recalc][rates-hydrate]", {
                reason: "rates_hydrate_global_key_loaded",
                source: result.source,
                ownerId: result.ownerId,
                key: key,
                serverOwner: String(data && data.owner || ""),
                rawLength: String(raw || "").length
              });
            } catch(eLoadedLog) {}
            continue;
          }
        }
        result.ok = false;
        result.missing.push(key);
        try {
          console.warn("[manual-recalc][rates-hydrate]", {
            reason: "rates_hydrate_global_key_missing_after_fetch",
            source: result.source,
            ownerId: result.ownerId,
            key: key,
            serverOk: !!(res.ok && data && data.ok === true),
            serverOwner: String(data && data.owner || ""),
            status: res.status
          });
        } catch(eMissingLog) {}
      } catch(eFetch) {
        result.ok = false;
        result.missing.push(key);
        try {
          console.warn("[manual-recalc][rates-hydrate]", {
            reason: String(eFetch && eFetch.message || "") === "GLOBAL_READ_CACHE_KEY_REJECTED" ? "rates_hydrate_global_read_cache_rejected" : "rates_hydrate_global_key_missing_after_fetch",
            source: result.source,
            ownerId: result.ownerId,
            key: key,
            error: String(eFetch && eFetch.message || eFetch)
          });
        } catch(eFetchLog) {}
      }
    }
    try {
      console.log("[manual-recalc][rates-hydrate]", {
        reason: "rates_hydrate_before_recalc_done",
        source: result.source,
        ownerId: result.ownerId,
        ok: result.ok,
        existing: result.existing,
        loaded: result.loaded,
        missing: result.missing
      });
    } catch(eDoneLog) {}
    return result;
  }

  function directGlobalRateReadState(source){
    const keys = [REFI_KEY_NORMAL, REFI_KEY_MORA];
    const readable = serverFirstReadableState();
    diagnoseReadableConsumer(readable, "directGlobalRateReadState");
    const hydrated = manualRecalcHydratedDatabaseState();
    const out = {
      source: String(source || ""),
      envType: "",
      uiStatus: readable.uiStatus,
      uiSource: readable.uiSource,
      legacyDataReady: readable.legacyDataReady === true,
      jkhDataReady: window.JKH_DATA_READY === true,
      acceptedStateReason: readable.acceptedReason,
      hydratedDatabaseState: hydrated,
      envPrefixStable: true,
      hasNormal: false,
      hasMoratorium: false,
      normalRateReadable: false,
      moratoriumRateReadable: false,
      normalLength: 0,
      moratoriumLength: 0
    };
    try {
      out.envType = window.JKHStore && typeof JKHStore.getEnvType === "function" ? String(JKHStore.getEnvType() || "") : "";
    } catch(eEnv) {}
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      let raw = null;
      try {
        raw = window.JKHStore && typeof JKHStore.getRaw === "function" ? JKHStore.getRaw(key) : null;
      } catch(eRaw) {}
      const exists = raw !== null && raw !== undefined && String(raw) !== "";
      if (key === REFI_KEY_NORMAL) {
        out.hasNormal = exists;
        out.normalRateReadable = exists;
        out.normalLength = exists ? String(raw).length : 0;
      } else if (key === REFI_KEY_MORA) {
        out.hasMoratorium = exists;
        out.moratoriumRateReadable = exists;
        out.moratoriumLength = exists ? String(raw).length : 0;
      }
    }
    return out;
  }

  function manualRecalcHydratedDatabaseState(){
    const counts = getHydratedDbCountsForPaymentTable();
    return {
      hydrated: counts.abonentsCount > 0,
      abonentsCount: counts.abonentsCount,
      premisesCount: counts.premisesCount,
      linksCount: counts.linksCount
    };
  }

  let __readinessRegressionPassiveRestoreState = null;

  function startReadinessWriteSequence(runId){
    window.__JKH_READINESS_WRITE_SEQUENCE = {
      active: true,
      runId: String(runId || ""),
      startedAt: Date.now(),
      writes: []
    };
  }

  window.__recordReadinessWrite = function(meta){
    const sequence = window.__JKH_READINESS_WRITE_SEQUENCE;
    if (!sequence || sequence.active !== true) return;
    const input = meta && typeof meta === "object" ? meta : {};
    const previousUiStatus = String(input.previousUiStatus || "");
    const newUiStatus = String(input.newUiStatus || "");
    const previousServerStatus = String(input.previousServerStatus || "");
    const newServerStatus = String(input.newServerStatus || "");
    if (previousUiStatus === newUiStatus && previousServerStatus === newServerStatus) return;
    const entry = {
      previousUiStatus: previousUiStatus,
      newUiStatus: newUiStatus,
      previousServerStatus: previousServerStatus,
      newServerStatus: newServerStatus,
      caller: String(input.caller || ""),
      function: String(input.function || ""),
      line: String(input.line || ""),
      reason: String(input.reason || ""),
      stack: Array.isArray(input.stack) ? input.stack.slice(0, 5) : [],
      runId: String(sequence.runId || "")
    };
    sequence.writes.push(entry);
    try { console.log("[readiness-write]", entry); } catch(e) {}
  };

  function finishReadinessWriteSequence(){
    const sequence = window.__JKH_READINESS_WRITE_SEQUENCE;
    if (!sequence) return;
    sequence.active = false;
    try {
      console.log("[readiness-write-sequence]", {
        runId: String(sequence.runId || ""),
        writes: Array.isArray(sequence.writes) ? sequence.writes.slice() : []
      });
    } catch(e) {}
  }

  function readinessRegressionState(restoredRowsCount){
    const rates = directGlobalRateReadState("readiness-regression");
    const hydrated = rates.hydratedDatabaseState || manualRecalcHydratedDatabaseState();
    const uiState = window.JKH_UI_STATE && typeof window.JKH_UI_STATE === "object" ? window.JKH_UI_STATE : {};
    const serverState = uiState.server && typeof uiState.server === "object" ? uiState.server : {};
    return {
      uiStatus: String(rates.uiStatus || ""),
      uiSource: String(rates.uiSource || ""),
      serverStatus: String(serverState.status || ""),
      runtimeHydrated: hydrated.hydrated === true,
      restoredRowsCount: Number(restoredRowsCount || 0),
      normalRateReadable: rates.normalRateReadable === true,
      moratoriumRateReadable: rates.moratoriumRateReadable === true,
      envType: String(rates.envType || "")
    };
  }

  function readinessRegressionReadable(state){
    const value = state && typeof state === "object" ? state : {};
    const uiReadable = value.uiStatus === "ready" || (value.uiStatus === "empty" && value.uiSource === "server");
    return uiReadable
      && value.runtimeHydrated === true
      && value.normalRateReadable === true
      && value.moratoriumRateReadable === true;
  }

  function logReadinessRegressionAfterPassiveRestore(restoredRowsCount){
    const state = readinessRegressionState(restoredRowsCount);
    __readinessRegressionPassiveRestoreState = state;
    try { console.log("[readiness-regression][after-passive-restore]", state); } catch(e) {}
    return state;
  }

  function logReadinessRegressionBeforeManualRecalc(transitionCaller, transitionReason){
    const passive = __readinessRegressionPassiveRestoreState;
    const restoredRowsCount = passive ? passive.restoredRowsCount : 0;
    const current = readinessRegressionState(restoredRowsCount);
    try { console.log("[readiness-regression][before-manual-recalc]", current); } catch(e) {}
    const changedFields = [];
    if (passive) {
      Object.keys(current).forEach(function(key){
        if (passive[key] !== current[key]) changedFields.push(key);
      });
    }
    const passiveRestoreReadable = readinessRegressionReadable(passive);
    const manualRecalcReadable = readinessRegressionReadable(current);
    const divergenceStage = !passive
      ? "PASSIVE_RESTORE_BASELINE_MISSING"
      : (passiveRestoreReadable && !manualRecalcReadable
        ? "BEFORE_MANUAL_RECALC_READINESS"
        : (changedFields.length ? "STATE_CHANGED_WITHOUT_READABILITY_DIVERGENCE" : "NO_DIVERGENCE_BEFORE_READINESS"));
    try {
      console.log("[readiness-regression][state-delta]", {
        changedFields: changedFields,
        transitionCaller: String(transitionCaller || ""),
        transitionReason: String(transitionReason || ""),
        passiveRestoreReadable: passiveRestoreReadable,
        manualRecalcReadable: manualRecalcReadable,
        divergenceStage: divergenceStage
      });
    } catch(e) {}
    return current;
  }

  try {
    if (window.__JKH_PAYMENT_TABLE_TEST_HOOKS === true) {
      window.__paymentTableTestHooks = Object.assign(window.__paymentTableTestHooks || {}, {
        readinessRegressionState: readinessRegressionState,
        readinessRegressionReadable: readinessRegressionReadable,
        logReadinessRegressionAfterPassiveRestore: logReadinessRegressionAfterPassiveRestore,
        logReadinessRegressionBeforeManualRecalc: logReadinessRegressionBeforeManualRecalc,
        startReadinessWriteSequence: startReadinessWriteSequence,
        finishReadinessWriteSequence: finishReadinessWriteSequence,
        manualRecalcReadinessEvaluation: manualRecalcReadinessEvaluation,
        serverFirstReadableState: serverFirstReadableState,
        beginReadableDiagnostic: beginReadableDiagnostic,
        finishReadableDiagnostic: finishReadableDiagnostic
      });
    }
  } catch(e) {}

  function manualRecalcDataReadyBlockerReason(gate){
    const blockers = [];
    if (!gate || gate.readable !== true) blockers.push("READABLE");
    if (!gate || gate.hasNormal !== true) blockers.push("NORMAL_RATE");
    if (!gate || gate.hasMoratorium !== true) blockers.push("MORATORIUM_RATE");
    if (!gate || gate.hydrated !== true) blockers.push("DB_HYDRATION");
    if (!gate || gate.envStable !== true) blockers.push("ENV_UNSTABLE");
    if (!blockers.length) return "OK";
    return blockers.length === 1 ? ("DATA_READY_TIMEOUT_" + blockers[0]) : "DATA_READY_TIMEOUT_MULTIPLE";
  }

  function compactManualRecalcDataReadyGate(gate, elapsedMs, attempts){
    const out = gate && typeof gate === "object" ? gate : {};
    return {
      readableOk: out.readable === true,
      readableReason: String(out.readableReason || ""),
      uiStatus: String(out.uiStatus || ""),
      uiSource: String(out.uiSource || ""),
      legacyDataReady: out.legacyDataReady === true,
      hasNormal: out.hasNormal === true,
      hasMoratorium: out.hasMoratorium === true,
      hydrated: out.hydrated === true,
      hydratedReason: String(out.hydratedReason || ""),
      envStable: out.envStable === true,
      envBefore: String(out.envBefore || ""),
      envAfter: String(out.envAfter || ""),
      normalKey: String(out.normalKey || REFI_KEY_NORMAL),
      moratoriumKey: String(out.moratoriumKey || REFI_KEY_MORA),
      elapsedMs: Number(elapsedMs || 0),
      attempts: Number(attempts || 0),
      blockerReason: manualRecalcDataReadyBlockerReason(out)
    };
  }

  function manualRecalcDataReadyForSync(state, expectedEnvType){
    try {
      const readable = serverFirstReadableState();
      diagnoseReadableConsumer(readable, "manualRecalcDataReadyForSync");
      const observed = state || directGlobalRateReadState("manualRecalcDataReadyForSync");
      const hydrated = observed.hydratedDatabaseState || manualRecalcHydratedDatabaseState();
      const expectedEnv = String(expectedEnvType || "");
      const currentEnv = String(observed.envType || "");
      const envStable = !expectedEnv || !currentEnv || currentEnv === expectedEnv;
      const gate = {
        ok: false,
        readable: readable.ok === true,
        readableReason: String(readable.acceptedReason || "SERVER_FIRST_STATE_NOT_READABLE"),
        hasNormal: observed.hasNormal === true,
        hasMoratorium: observed.hasMoratorium === true,
        hydrated: hydrated.hydrated === true,
        hydratedReason: hydrated.hydrated === true ? "OK" : "DB_NOT_HYDRATED",
        envStable: envStable === true,
        envBefore: expectedEnv,
        envAfter: currentEnv,
        uiStatus: String(readable.uiStatus || observed.uiStatus || ""),
        uiSource: String(readable.uiSource || observed.uiSource || ""),
        legacyDataReady: readable.legacyDataReady === true,
        normalKey: REFI_KEY_NORMAL,
        moratoriumKey: REFI_KEY_MORA
      };
      diagnoseReadableWrapper(readable, gate);
      gate.ok = !!(
        readable.ok === true
        && observed.hasNormal === true
        && observed.hasMoratorium === true
        && hydrated.hydrated === true
        && envStable === true
      );
      gate.reason = gate.ok ? "OK" : manualRecalcDataReadyBlockerReason(gate);
      return gate;
    } catch(e) {
      return {
        ok: false,
        readable: false,
        readableReason: "DATA_READY_GATE_EXCEPTION",
        hasNormal: false,
        hasMoratorium: false,
        hydrated: false,
        hydratedReason: "DATA_READY_GATE_EXCEPTION",
        envStable: false,
        envBefore: String(expectedEnvType || ""),
        envAfter: "",
        uiStatus: "",
        uiSource: "",
        legacyDataReady: false,
        normalKey: REFI_KEY_NORMAL,
        moratoriumKey: REFI_KEY_MORA,
        reason: "DATA_READY_TIMEOUT_MULTIPLE"
      };
    }
  }

  function manualRecalcReadinessEvaluation(iteration, elapsedMs, state, gate){
    const observed = state && typeof state === "object" ? state : {};
    const evaluated = gate && typeof gate === "object" ? gate : {};
    const uiState = window.JKH_UI_STATE && typeof window.JKH_UI_STATE === "object" ? window.JKH_UI_STATE : {};
    const serverState = uiState.server && typeof uiState.server === "object" ? uiState.server : {};
    const passive = __readinessRegressionPassiveRestoreState;
    const failedConditions = [];
    if (evaluated.readable !== true) failedConditions.push("readable.ok === true");
    if (evaluated.hasNormal !== true) failedConditions.push("observed.hasNormal === true");
    if (evaluated.hasMoratorium !== true) failedConditions.push("observed.hasMoratorium === true");
    if (evaluated.hydrated !== true) failedConditions.push("hydrated.hydrated === true");
    if (evaluated.envStable !== true) failedConditions.push("envStable === true");
    return {
      iteration: Number(iteration || 0),
      elapsedMs: Number(elapsedMs || 0),
      uiStatus: String(evaluated.uiStatus || observed.uiStatus || ""),
      serverStatus: String(serverState.status || ""),
      runtimeHydrated: evaluated.hydrated === true,
      normalRateReadable: evaluated.hasNormal === true,
      moratoriumRateReadable: evaluated.hasMoratorium === true,
      restoredRowsCount: Number(passive && passive.restoredRowsCount || 0),
      dataReady: window.JKH_DATA_READY === true,
      failedCondition: failedConditions.length ? failedConditions.join(" && ") : "",
      readyExpressionResult: evaluated.ok === true
    };
  }

  async function waitForManualRecalcDataReady(source){
    const timeoutMs = 5000;
    const startedAt = Date.now();
    const readableRun = currentFullRecalcRunState();
    beginReadableDiagnostic(readableRun && readableRun.runId || "");
    let attempts = 0;
    let latestGate = null;
    let lastEvaluation = null;
    const failedConditionsSeen = [];
    const firstFailureIterationByCondition = {};
    let startState = null;
    try {
      startState = directGlobalRateReadState(source);
      console.log("[manual-recalc][data-ready]", Object.assign({}, startState, { reason: "manual_recalc_data_ready_wait_start" }));
      console.log("[manual-recalc][data-ready]", Object.assign({}, startState, { reason: "manual_recalc_direct_rate_read_after_hydrate" }));
      console.log("[manual-recalc][data-ready]", Object.assign({}, startState, { reason: "manual_recalc_env_prefix_check" }));
    } catch(eStartLog) {}
    const expectedEnvType = String(directGlobalRateReadState(source).envType || "");
    try {
      const enterState = startState || directGlobalRateReadState(source);
      enterState.envPrefixStable = !expectedEnvType || !enterState.envType || String(enterState.envType || "") === expectedEnvType;
      const enterGate = manualRecalcDataReadyForSync(enterState, expectedEnvType);
      console.log("[readiness-enter]", manualRecalcReadinessEvaluation(0, Date.now() - startedAt, enterState, enterGate));
    } catch(eEnterLog) {}
    while ((Date.now() - startedAt) <= timeoutMs) {
      attempts += 1;
      const state = directGlobalRateReadState(source);
      state.envPrefixStable = !expectedEnvType || !state.envType || String(state.envType || "") === expectedEnvType;
      const gate = manualRecalcDataReadyForSync(state, expectedEnvType);
      latestGate = gate;
      const evaluation = manualRecalcReadinessEvaluation(attempts, Date.now() - startedAt, state, gate);
      lastEvaluation = evaluation;
      const iterationFailures = evaluation.failedCondition ? evaluation.failedCondition.split(" && ") : [];
      iterationFailures.forEach(function(condition){
        if (failedConditionsSeen.indexOf(condition) < 0) failedConditionsSeen.push(condition);
        if (!Object.prototype.hasOwnProperty.call(firstFailureIterationByCondition, condition)) {
          firstFailureIterationByCondition[condition] = attempts;
        }
      });
      try { console.log("[readiness-eval]", evaluation); } catch(eEvalLog) {}
      if (gate && gate.ok === true) {
        try {
          console.log("[readiness-success]", evaluation);
          if (state.acceptedStateReason) {
            console.log("[manual-recalc][data-ready]", Object.assign({}, state, {
              reason: state.acceptedStateReason,
              elapsedMs: Date.now() - startedAt
            }));
          }
          console.log("[manual-recalc][data-ready]", Object.assign(compactManualRecalcDataReadyGate(gate, Date.now() - startedAt, attempts), {
            reason: "manual_recalc_data_ready_gate_passed"
          }));
          console.log("[manual-recalc][data-ready]", Object.assign({}, state, {
            reason: "manual_recalc_data_ready_wait_done",
            elapsedMs: Date.now() - startedAt
          }));
        } catch(eDoneLog) {}
        finishReadableDiagnostic();
        return { ok: true, state, gate: gate };
      }
      try {
        if (window.Data && typeof Data.waitForServerFirstDataReady === "function") {
          await Data.waitForServerFirstDataReady({ timeoutMs: 500 });
        } else if (window.JKHDataLoader && typeof window.JKHDataLoader.loadFromServer === "function") {
          await window.JKHDataLoader.loadFromServer({ force: false, reason: "manual_recalc_data_ready_wait" });
        }
      } catch(eWait) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const finalState = directGlobalRateReadState(source);
    finalState.envPrefixStable = !expectedEnvType || !finalState.envType || String(finalState.envType || "") === expectedEnvType;
    const finalGate = manualRecalcDataReadyForSync(finalState, expectedEnvType);
    latestGate = finalGate || latestGate;
    const finalEvaluation = manualRecalcReadinessEvaluation(attempts, Date.now() - startedAt, finalState, latestGate);
    lastEvaluation = finalEvaluation;
    const finalFailures = finalEvaluation.failedCondition ? finalEvaluation.failedCondition.split(" && ") : [];
    finalFailures.forEach(function(condition){
      if (failedConditionsSeen.indexOf(condition) < 0) failedConditionsSeen.push(condition);
      if (!Object.prototype.hasOwnProperty.call(firstFailureIterationByCondition, condition)) {
        firstFailureIterationByCondition[condition] = attempts;
      }
    });
    const blockerReason = manualRecalcDataReadyBlockerReason(latestGate);
    try {
      console.warn("[readiness-timeout-summary]", {
        totalIterations: attempts,
        lastEvaluation: lastEvaluation,
        everyFailedCondition: failedConditionsSeen,
        exactBooleanExpressionPreventingReadiness: "readable.ok === true && observed.hasNormal === true && observed.hasMoratorium === true && hydrated.hydrated === true && envStable === true",
        firstIterationWhereFailureAppeared: Object.keys(firstFailureIterationByCondition).length
          ? Math.min.apply(null, Object.keys(firstFailureIterationByCondition).map(function(condition){ return firstFailureIterationByCondition[condition]; }))
          : null,
        firstFailureIterationByCondition: firstFailureIterationByCondition
      });
      console.warn("[manual-recalc][data-ready]", Object.assign(compactManualRecalcDataReadyGate(latestGate, Date.now() - startedAt, attempts), {
        reason: "manual_recalc_data_ready_blockers"
      }));
      console.warn("[manual-recalc][data-ready]", Object.assign({}, finalState, {
        reason: "manual_recalc_data_ready_timeout",
        elapsedMs: Date.now() - startedAt
      }));
    } catch(eTimeoutLog) {}
    finishReadableDiagnostic();
    return { ok: false, reason: "DATA_READY_TIMEOUT", preciseReason: blockerReason, state: finalState, gate: latestGate };
  }

  function excludePeriodsKey() { return "exclude_periods_" + getAbonentTechnicalId(); }
  function moratoriumKey() { return "moratorium_" + getAbonentTechnicalId(); }

  function isMoratoriumActive(){
    return storeGetRaw(moratoriumKey()) === "1";
  }

  function parseDMY(dmy){
    // Поддержка и "ДД.ММ.ГГГГ", и ISO "YYYY-MM-DD"
    // (раньше исключённые периоды не работали, если дата была в ISO)
    return parseDateAnyToDate(dmy);
  }

  function loadExcludes(){
    const key = excludePeriodsKey();
    const raw = storeGetRaw(key);
    if (raw === null || raw === undefined) return [];

    let arr;
    try{
      arr = JSON.parse(raw);
    }catch(e){
      throwExcludesFatal("EXCLUDES_JSON_INVALID", key, { reason: "JSON_PARSE_FAILED" }, e);
    }

    if (!Array.isArray(arr)) {
      throwExcludesFatal("EXCLUDES_JSON_INVALID", key, { reason: "EXCLUDES_NOT_ARRAY" });
    }

    // Нормализуем даты исключения: from = начало дня, to = конец дня (включительно)
    const startDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0,0);
    const endDay   = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23,59,59,999);

    return arr.map((x, index) => {
      if (!x || typeof x !== "object") {
        throwExcludesFatal("EXCLUDES_INVALID", key, { index: index, reason: "EXCLUDE_NOT_OBJECT" });
      }

      const fromRaw = x.from ?? x.dateFrom ?? x.start ?? x.fromISO ?? x.from_iso;
      const toRaw   = x.to   ?? x.dateTo   ?? x.end   ?? x.toISO   ?? x.to_iso;

      const from = parseDateAnyToDate(fromRaw);
      const to   = parseDateAnyToDate(toRaw);

      if (!from || !to || endDay(to) < startDay(from)) {
        throwExcludesFatal("EXCLUDES_INVALID", key, { index: index, reason: "EXCLUDE_DATE_INVALID", from: fromRaw, to: toRaw });
      }

      return {
        from: startDay(from),
        to:   endDay(to),
        reason: String(x.reason || x.note || x.comment || "")
      };
    });
  }

  function isExcludedDay(d, excludes){
    const t = d.getTime();
    for (const p of excludes){
      if (t >= p.from.getTime() && t <= p.to.getTime()) return true;
    }
    return false;
  }

  function loadRates(){
    const key = isMoratoriumActive() ? REFI_KEY_MORA : REFI_KEY_NORMAL;
    const raw = storeGetRaw(key);
    if (raw === null || raw === undefined){
      throwRatesFatal("RATES_MISSING", key, { reason: "RATES_KEY_MISSING" });
    }

    let arr;
    try{
      arr = JSON.parse(raw);
    }catch(e){
      throwRatesFatal("RATES_JSON_INVALID", key, { reason: "RATES_JSON_PARSE_FAILED", error: e && e.message ? e.message : String(e) });
    }

    if (!Array.isArray(arr)){
      throwRatesFatal("RATES_JSON_INVALID", key, { reason: "RATES_JSON_NOT_ARRAY" });
    }

    const parsed = arr
      .map(x => ({
        from: parseDMY(x.from),
        rate: Number(String(x.rate ?? "").replace(",", "."))
      }))
      .filter(x => x.from && Number.isFinite(x.rate))
      .sort((a,b)=>a.from-b.from);
    return parsed;
  }

  function rateOnDate(d, rates){
    const t = d && d.getTime ? d.getTime() : NaN;
    if (!Number.isFinite(t)) return null;
    if (!Array.isArray(rates) || rates.length === 0) return null;

    const first = rates.find(function(r){
      return r && r.from && r.from.getTime && Number.isFinite(r.rate);
    });
    if (!first) return null;
    if (t < first.from.getTime()) return null;

    let cur = null;
    for (const r of rates){
      if (!r || !r.from || !r.from.getTime) continue;
      if (r.from.getTime() <= t) cur = r.rate;
      else break;
    }
    return cur;
  }

  function capRateUntil2027(dateObj, rate){
    const cutoff = new Date("2027-01-01");
    if (dateObj < cutoff) return Math.min(9.5, rate);
    return rate;
  }

  // ✅ FIX #1: month index (в JS месяцы 0..11)
  function dueDateForRow(r){
    const y = parseInt(r.year, 10);
    const m = parseInt(r.month, 10);
    if (!y || !m) return null;
    return new Date(y, (m - 1), 10); // было: new Date(y, m, 10)
  }

  // ✅ FIX #2: если долг НЕ закрыт полностью — пеня считается до сегодняшнего дня,
  // даже если paid_date заполнена (частичная оплата / дата первой оплаты)
  function endDateForRow(r){
    const acc = toNum(r.accrued);
    const paid = toNum(r.paid);
    const hasDebt = (acc - paid) > 0.0000001;

    if (hasDebt) return new Date();

    const d = parseDateAnyToDate(r.paid_date);
    return d ? d : new Date();
  }

  function addDays(d, n){
    const x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }

  function calcPenaltyForRow(r){
    const debt = toNum(r.pay_main);
    if (debt <= 0) return 0;

    const due = dueDateForRow(r);
    if (!due) return 0;

    const end = endDateForRow(r);
    if (end <= due) return 0;

    const excludes = loadExcludes();
    const rates = loadRates();

    let penalty = 0;
    let day = addDays(due, 1);
    let overdueIndex = 0;

    const hardLimit = addDays(due, 3650);

    while (day <= end && day <= hardLimit){
      if (!isExcludedDay(day, excludes)){
        overdueIndex += 1;

        if (overdueIndex > 30){
          const denom = (overdueIndex <= 90) ? 300 : 130;
          const rawRate = rateOnDate(day, rates);
          if (!Number.isFinite(rawRate)) {
            throwRatesFatal("MISSING_REQUIRED_RATE", "", { date: toISODateString(day), reason: "MISSING_REQUIRED_RATE" });
          }
          const rate = capRateUntil2027(day, rawRate);

          penalty += debt * (rate / 100) / denom;
        }
      }
      day = addDays(day, 1);
    }

    return penalty;
  }

  // ===== МЕСЯЦА ДЛЯ СЕЛЕКТОВ периода (01-12) =====
  const PERIOD_MONTHS = Array.from({ length: 12 }, (_, i) => pad2(i + 1));

  function yearsOptions(selected) {
    let out = "";
    for (let y = 2010; y <= 2035; y++) {
      out += `<option value="${y}" ${String(y) === String(selected) ? "selected" : ""}>${y}</option>`;
    }
    return out;
  }

  function monthOptionsNums(selected) {
    return PERIOD_MONTHS
      .map(mm => `<option value="${mm}" ${mm === selected ? "selected" : ""}>${mm}</option>`)
      .join("");
  }

  function normalizePeriod(row) {
    if (row.period_from_m && row.period_from_y && row.period_to_m && row.period_to_y) return;

    const defM = (/^(0[1-9]|1[0-2])$/.test(String(row.month || ''))) ? String(row.month) : '';
    const defY = (/^(19|20)\d{2}$/.test(String(row.year || ''))) ? String(row.year) : '';

    if (!defY) throwPaymentPeriodInvalid("PAYMENT_YEAR_REQUIRED", row, { month: row.month || "", year: row.year || "" });
    if (!defM) throwPaymentPeriodInvalid("PAYMENT_PERIOD_INVALID", row, { month: row.month || "", year: row.year || "" });

    row.period_from_m = row.period_from_m || defM;
    row.period_from_y = row.period_from_y || defY;
    row.period_to_m   = row.period_to_m   || defM;
    row.period_to_y   = row.period_to_y   || defY;

    row.period_from = `${row.period_from_m}.${row.period_from_y}`;
    row.period_to   = `${row.period_to_m}.${row.period_to_y}`;
  }

  function updatePeriodStrings(row) {
    row.period_from = `${row.period_from_m}.${row.period_from_y}`;
    row.period_to   = `${row.period_to_m}.${row.period_to_y}`;
  }
  function enforcePeriodSameAsYm(row){
    // 🔴 CRITICAL: 'Оплата за период' — ручной режим.
    // Период задаётся ТОЛЬКО оператором. Авто-подмена period_* запрещена,
    // потому что платёж может закрывать другой расчётный месяц.
    if (!row || !row.use_period) return;
    const empty = !(row.period_from_m && row.period_from_y && row.period_to_m && row.period_to_y);
    if (!empty) { updatePeriodStrings(row); return; }
    // дефолт показываем как (год/месяц строки) только при первом включении
    row.period_from_m = row.month;
    row.period_from_y = row.year;
    row.period_to_m   = row.month;
    row.period_to_y   = row.year;
    updatePeriodStrings(row);
  }

  // ✅ Год/месяц всегда = месяцу даты оплаты
  function syncYearMonthFromPaidDate(row){
    const d = parseDateAnyToDate(row?.paid_date);
    if (!d) return;

    row.paid_date = toISODateString(d);
    row.year  = String(d.getFullYear());
    row.month = pad2(d.getMonth() + 1);
  }

  function formatRuntimeCell(v){
    return (v === null || v === undefined || v === "") ? "—" : fmtMoney(v);
  }

  function selectComputedFinancialField(rowObj, candidates){
    const row = rowObj && typeof rowObj === "object" ? rowObj : {};
    let fallback = null;
    for (const name of candidates) {
      if (!Object.prototype.hasOwnProperty.call(row, name)) continue;
      const raw = row[name];
      if (raw === null || raw === undefined || raw === "") continue;
      const value = toNum(raw);
      const selected = { field: name, value: value, present: true };
      if (Math.abs(value) > 0.0000001) return selected;
      if (!fallback) fallback = selected;
    }
    return fallback || { field: "", value: 0, present: false };
  }

  function computedFieldCandidates(rowObj, candidates){
    const row = rowObj && typeof rowObj === "object" ? rowObj : {};
    const out = {};
    for (const name of candidates) {
      if (!Object.prototype.hasOwnProperty.call(row, name)) continue;
      const raw = row[name];
      out[name] = {
        raw: raw,
        value: (raw === null || raw === undefined || raw === "") ? null : toNum(raw)
      };
    }
    return out;
  }

  function computedFinancialFields(rowObj){
    const debtNames = ["pay_main", "debt", "principalDebt", "principal", "runningDebt", "balance", "total_debt"];
    const penaltyNames = ["pay_penalty", "penalty", "penaltyDebt", "runningPenalty", "total_penalty"];
    const totalNames = ["total", "runningTotal", "computedTotal", "totalDebt", "debt_total"];
    const debt = selectComputedFinancialField(rowObj, debtNames);
    const penalty = selectComputedFinancialField(rowObj, penaltyNames);
    const explicitTotal = selectComputedFinancialField(rowObj, totalNames);
    const derivedTotal = r2(debt.value + penalty.value);
    const total = explicitTotal.present && (Math.abs(explicitTotal.value) > 0.0000001 || Math.abs(derivedTotal) <= 0.0000001)
      ? explicitTotal
      : { field: "debt+penalty", value: derivedTotal, present: debt.present || penalty.present };
    return {
      debt: debt.value,
      penalty: penalty.value,
      total: total.value,
      selectedDebtField: debt.field,
      selectedPenaltyField: penalty.field,
      selectedTotalField: total.field,
      debtCandidates: computedFieldCandidates(rowObj, debtNames),
      penaltyCandidates: computedFieldCandidates(rowObj, penaltyNames),
      totalCandidates: computedFieldCandidates(rowObj, totalNames),
      hasDebt: debt.present,
      hasPenalty: penalty.present,
      hasTotal: total.present
    };
  }

  function logRenderFinancialFields(rowObj, fields){
    try {
      window.__PAYMENT_TABLE_RENDER_FINANCIAL_LOG_COUNT = Number(window.__PAYMENT_TABLE_RENDER_FINANCIAL_LOG_COUNT || 0);
      if (window.__PAYMENT_TABLE_RENDER_FINANCIAL_LOG_COUNT >= 3) return;
      window.__PAYMENT_TABLE_RENDER_FINANCIAL_LOG_COUNT += 1;
      console.log("[payment-table][render-financial-fields]", {
        rowId: String(rowObj && rowObj.id || ""),
        accrued: rowObj && rowObj.accrued,
        paid: rowObj && rowObj.paid,
        debt: fields.debt,
        penalty: fields.penalty,
        total: fields.total,
        selectedDebtField: fields.selectedDebtField,
        selectedPenaltyField: fields.selectedPenaltyField,
        selectedTotalField: fields.selectedTotalField
      });
    } catch(e) {}
  }

  function resetRenderFinancialFieldsLog(){
    try { window.__PAYMENT_TABLE_RENDER_FINANCIAL_LOG_COUNT = 0; } catch(e) {}
  }

  function logActualRenderFinancialFields(rowObj, fields){
    try {
      window.__PAYMENT_TABLE_ACTUAL_RENDER_LOG_COUNT = Number(window.__PAYMENT_TABLE_ACTUAL_RENDER_LOG_COUNT || 0);
      if (window.__PAYMENT_TABLE_ACTUAL_RENDER_LOG_COUNT >= 3) return;
      window.__PAYMENT_TABLE_ACTUAL_RENDER_LOG_COUNT += 1;
      console.log("[payment-table][actual-render]", {
        rowId: String(rowObj && rowObj.id || ""),
        month: String(rowObj && rowObj.month || ""),
        year: String(rowObj && rowObj.year || ""),
        debtCandidates: fields.debtCandidates,
        penaltyCandidates: fields.penaltyCandidates,
        totalCandidates: fields.totalCandidates,
        selectedDebt: {
          field: fields.selectedDebtField,
          value: fields.debt
        },
        selectedPenalty: {
          field: fields.selectedPenaltyField,
          value: fields.penalty
        },
        selectedTotal: {
          field: fields.selectedTotalField,
          value: fields.total
        }
      });
    } catch(e) {}
  }

  function resetActualRenderFinancialFieldsLog(){
    try { window.__PAYMENT_TABLE_ACTUAL_RENDER_LOG_COUNT = 0; } catch(e) {}
  }

  function updateComputedCells(tr, rowObj){
  const ro = qsa("td.ro", tr);
  if (ro.length >= 3){
    const fields = computedFinancialFields(rowObj);
    const pm = fields.debt;
    const pp = fields.penalty;

    ro[0].textContent = (isReadonlyNoRecalcMode() && !__runtimeCacheState.valid && !fields.hasDebt) ? "—" : fmtMoney(pm);
    ro[0].style.color = (pm < -0.0000001) ? "#8B0000" : "";
    ro[0].style.fontWeight = (pm < -0.0000001) ? "700" : "";

    if (isReadonlyNoRecalcMode() && !__runtimeCacheState.valid && !fields.hasPenalty) ro[1].textContent = "—";
    else ro[1].textContent = fmtMoney(pp);

    ro[2].textContent = (isReadonlyNoRecalcMode() && !__runtimeCacheState.valid && !fields.hasTotal) ? "—" : fmtMoney(fields.total);
    logRenderFinancialFields(rowObj, fields);
    logActualRenderFinancialFields(rowObj, fields);
  }
}

  // ✅ Главное: обновляем нарастающий итог в DOM БЕЗ перерисовки таблицы (фокус не теряется)
  async function refreshRunningTotalsInDOM() {
    const tbody = qs("#paymentTableBody");
    if (!tbody) return;

    // UI: обработчик сворачивания/разворачивания месяцев (делегирование)
    if (!tbody.dataset.collapseBound) {
      tbody.dataset.collapseBound = "1";
      tbody.addEventListener("click", (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest(".ym-toggle") : null;
        if (!btn) return;
        ev.preventDefault();
        const ym = btn.getAttribute("data-ym");
        if (!ym) return;

        __collapsedMonths = __collapsedMonths || loadCollapsedMap();
        const next = !__collapsedMonths[ym];
        __collapsedMonths[ym] = next;
        saveCollapsedMap(__collapsedMonths);

        // обновляем кнопку
        btn.textContent = next ? "▸" : "▾";

        // прячем/показываем строки оплат этого месяца
        qsa(`#paymentTableBody tr.row-payment[data-ym="${ym}"]`).forEach(tr => {
          tr.classList.toggle("ym-hidden", next);
        });
      });
    }

    if (!tbody.querySelector("tr[data-row-id]")) return;

    let arr = getPayments();
 
    // Read-only render path: autoaccrual is not applied during view rendering.

    // то же приведение, что и в loadPaymentTable
    arr.forEach(r => {
      normalizePaidDateISO(r);
      if (String(r?.paid_date || "").trim()) syncYearMonthFromPaidDate(r);
      normalizePeriod(r);
      calcRowBase(r);
    });

    const periodActive = isCalcPeriodActive();
    const selectedPeriod = periodActive ? getCalcPeriod() : null;
    const view = applyResponsibilityRangeToView(applyCalcFilter(arr, periodActive, selectedPeriod)).slice();
    const signature = ledgerSignatureForRows(arr);
    scheduleRunningTotalsUpdate(view, runningTotalsBaseRows(view), tbody, signature);

    // на рендере НЕ сохраняем и НЕ flush-им
  }

  async function renderRowsChunked(tbody, view, chunkSize){
    tbody.innerHTML = "";
    resetRenderFinancialFieldsLog();
    resetActualRenderFinancialFieldsLog();
    const size = Math.max(1, Number(chunkSize) || 50);
    for (let i = 0; i < view.length; i += size) {
      const frag = document.createDocumentFragment();
      const end = Math.min(i + size, view.length);
      for (let j = i; j < end; j++) {
        frag.appendChild(makeRow(view[j]));
      }
      tbody.appendChild(frag);
      if (end < view.length) await nextUiTick();
    }
  }

  async function renderCalculatedRowsDirect(reason){
    const state = __paymentTableCalculatedRenderState;
    const tbody = qs("#paymentTableBody");
    if (!tbody || !state || typeof state !== "object") return false;
    const rowsById = state.rowsById && typeof state.rowsById === "object" && !Array.isArray(state.rowsById) ? state.rowsById : {};
    const rows = mergeComputedRowsIntoViewRows(state.rows, rowsById);
    if (!rows.length || !Object.keys(rowsById).length) return false;
    const stats = computedRowsStats(rows, null);
    if (!(stats.hasDebtTotals && stats.hasPenaltyTotals && stats.hasTotalTotals)) return false;

    __collapsedMonths = __collapsedMonths || loadCollapsedMap();
    __monthHasPayments = {};
    __monthPaidSum = {};
    rows.forEach(function(r){
      const YM = ymKeyOfRow(r);
      if (!__monthHasPayments[YM]) __monthHasPayments[YM] = { hasPayments: false };
      if (toNum(r && r.paid || 0) > 0.0000001) {
        __monthHasPayments[YM].hasPayments = true;
        __monthPaidSum[YM] = r2((__monthPaidSum[YM] || 0) + toNum(r && r.paid || 0));
      }
    });
    rows.sort(function(a, b){
      const ay = Number(a && a.year) || 0;
      const by = Number(b && b.year) || 0;
      if (ay !== by) return by - ay;
      const am = Number(String(a && a.month || "").padStart(2, "0")) || 0;
      const bm = Number(String(b && b.month || "").padStart(2, "0")) || 0;
      if (am !== bm) return bm - am;
      const aa = toNum(a && a.accrued || 0) > 0.0000001;
      const ba = toNum(b && b.accrued || 0) > 0.0000001;
      if (aa !== ba) return aa ? -1 : 1;
      return (Number(b && b.id) || 0) - (Number(a && a.id) || 0);
    });
    __runtimeCacheState = { valid: true, reason: "", dataById: rowsById, periodMatches: true, builtForPeriod: !!state.periodActive, calculatedRows: true };
    logPaymentTableRenderSource("calculated_rows", rows, rowsById);
    try {
      console.log("[payment-table][calculated-rows-direct-render]", {
        reason: String(reason || ""),
        rowsCount: rows.length,
        rowsByIdCount: Object.keys(rowsById).length
      });
    } catch(e) {}
    recordPaymentRenderRegression("render", {
      reason: String(reason || ""),
      renderSource: "calculated_rows_direct",
      rowCount: rows.length,
      ledgerRowsCount: 0,
      snapshotRowsCount: Object.keys(rowsById).length,
      stack: (new Error()).stack || ""
    });
    await renderRowsChunked(tbody, rows, 50);
    return true;
  }

  window.JKH_restoreCanonicalSnapshotRowsForPassiveDisplay = async function(snapshot){
    let ledgerRows = [];
    try { ledgerRows = getPayments(); } catch(eLedger) {
      try { console.warn("[card-reload][card_rows_materialization_failed]", { uid: String(getAbonentId() || ""), snapshotRowsCount: snapshot && snapshot.rowsById && typeof snapshot.rowsById === "object" ? Object.keys(snapshot.rowsById).length : 0, ledgerRowsCount: 0, renderedRowsCount: 0, source: "canonical_backend_snapshot", reason: String(eLedger && (eLedger.code || eLedger.message) || eLedger || "LEDGER_READ_FAILED") }); } catch(_) {}
      return { ok: false, reason: "LEDGER_READ_FAILED", rows: [] };
    }
    recordPaymentRenderRegression("snapshot-restore-start", {
      reason: "canonical_backend_snapshot",
      snapshotRowsCount: snapshot && snapshot.rowsById && typeof snapshot.rowsById === "object" ? Object.keys(snapshot.rowsById).length : 0,
      ledgerRowsCount: ledgerRows.length,
      stack: (new Error()).stack || ""
    });
    const materialized = materializeCanonicalSnapshotRowsForEmptyLedger(snapshot, ledgerRows);
    if (!materialized.ok) {
      const eventName = materialized.reason === "EXISTING_LEDGER_USED" ? "card_rows_materialization_skipped" : "card_rows_materialization_failed";
      try { console.warn("[card-reload][" + eventName + "]", { uid: String(snapshot && snapshot.uid || getAbonentId() || ""), snapshotRowsCount: materialized.snapshotRowsCount, ledgerRowsCount: materialized.ledgerRowsCount, renderedRowsCount: 0, source: "canonical_backend_snapshot", reason: materialized.reason }); } catch(eSkippedLog) {}
      return materialized;
    }
    setPaymentTableCalculatedRenderState(materialized.rows, materialized.rowsById, {
      uid: String(snapshot && snapshot.uid || getAbonentId() || ""),
      ledgerVersion: String(snapshot && (snapshot.ledgerVersion || snapshot.ledger_version) || ""),
      runtimeSignature: String(snapshot && snapshot.runtimeSignature || ""),
      periodActive: false,
      source: "canonical_backend_snapshot",
      passiveSnapshotRestore: true
    });
    const rendered = await renderCalculatedRowsDirect("canonical-snapshot-empty-ledger");
    const result = Object.assign({}, materialized, { ok: rendered === true, renderedRowsCount: rendered === true ? materialized.rows.length : 0, reason: rendered === true ? "OK" : "CARD_ROWS_NOT_RESTORED" });
    recordPaymentRenderRegression("snapshot-restore-rendered", {
      reason: result.reason,
      renderSource: "canonical_backend_snapshot",
      rowCount: result.renderedRowsCount,
      ledgerRowsCount: materialized.ledgerRowsCount,
      snapshotRowsCount: materialized.snapshotRowsCount,
      stack: (new Error()).stack || ""
    });
    if (result.ok) logReadinessRegressionAfterPassiveRestore(result.renderedRowsCount);
    try {
      const eventName = result.ok ? "card_rows_materialized_from_snapshot" : "card_rows_materialization_failed";
      console.log("[card-reload][" + eventName + "]", { uid: String(snapshot && snapshot.uid || getAbonentId() || ""), snapshotRowsCount: materialized.snapshotRowsCount, ledgerRowsCount: materialized.ledgerRowsCount, renderedRowsCount: result.renderedRowsCount, source: "canonical_backend_snapshot", reason: result.reason });
    } catch(eMaterializedLog) {}
    return result;
  };

  async function loadPaymentTableImpl() {
    const totalStartedAt = perfNow();
    try { console.time('[payment-table] init-total'); } catch(e) {}
    try {
      if (!await waitPaymentTableHydratedDatabase("PAYMENT_TABLE_LOAD")) {
        if (await renderCalculatedRowsDirect("hydrate-not-ready")) return;
        const tbodyBlocked = qs("#paymentTableBody");
        if (tbodyBlocked) tbodyBlocked.innerHTML = '<tr><td colspan="20" style="color:#7a5300;font-weight:700;">База данных ещё загружается. Повторите через несколько секунд.</td></tr>';
        const statusBlocked = qs("#paymentTableStatus") || qs("#paymentStatus") || qs("#paymentsStatus");
        if (statusBlocked) statusBlocked.textContent = "База данных ещё загружается. Повторите через несколько секунд.";
        return;
      }
      if (!isDataReady()) {
        if (await renderCalculatedRowsDirect("data-not-ready")) return;
        try { console.warn('[payment-table] load skipped: DATA_NOT_READY'); } catch(e) {}
        return;
      }
      const keyForReadiness = paymentsKey();
      if (!keyForReadiness) {
        if (await renderCalculatedRowsDirect("payment-key-not-ready")) return;
        try { console.warn('[payment-table] load skipped: PAYMENT_KEY_NOT_READY'); } catch(e) {}
        return;
      }

      const tbody = qs("#paymentTableBody");

      // UI: группировка ledger внутри месяца (начисление сверху, оплаты ниже)
      // и скрытие "по пени" на строках оплат делаем визуально понятным.
      (function ensureLedgerStyles(){
        if (document.getElementById("ledger-style-v151")) return;
        const st = document.createElement("style");
        st.id = "ledger-style-v151";
        st.textContent = `
          /* Ledger UI (v1.5.1) */
          #paymentTableBody tr.row-accrual td { background: #f6f7f9; }
          #paymentTableBody tr.row-accrual td:first-child { font-weight: 700; }
          #paymentTableBody tr.row-accrual { border-top: 2px solid #d9dde3; }
          #paymentTableBody tr.row-payment td { background: #ffffff; }
          #paymentTableBody tr.row-payment td:first-child { padding-left: 16px; opacity: 0.95; }
          #paymentTableBody tr.row-payment td:first-child .ym-title { font-weight: 500; }
          #paymentTableBody tr.row-payment td:first-child .ym-sub { font-size: 11px; opacity: 0.75; }
          #paymentTableBody tr.row-accrual td:first-child .ym-sub { font-size: 11px; opacity: 0.75; }
          #paymentTableBody tr.row-payment td { border-top: 1px dashed #e3e6eb; }
          #paymentTableBody tr.row-payment td { }
          #paymentTableBody tr.ym-hidden { display: none; }
          #paymentTableBody .ym-wrap .ym-title { display:flex; align-items:center; gap:6px; }
          #paymentTableBody .ym-toggle { border:0; background:transparent; cursor:pointer; font-size:14px; line-height:1; padding:0 4px; }
          #paymentTableBody .ym-toggle[disabled] { opacity:0.35; cursor:default; }
          #paymentTableBody .ym-indent { display:inline-block; width:18px; }

        `;
        document.head.appendChild(st);
      })();
      if (!tbody) return;

      let arr;
      let draftRows = [];
      const loadStartedAt = perfNow();
      try { console.time('[payment-table] load-ledger'); } catch(e) {}
      try {
        arr = getPayments();
        draftRows = getPaymentDraftRows();
        try {
          const runtimeDb = window.AbonentsDB && typeof window.AbonentsDB === "object" ? window.AbonentsDB : {};
          console.log("[reload-chain][runtime-after-reload]", {
            abonentId: String(getAbonentId() || ""),
            abonentsCount: runtimeDb.abonents && typeof runtimeDb.abonents === "object" ? Object.keys(runtimeDb.abonents).length : 0,
            premisesCount: runtimeDb.premises && typeof runtimeDb.premises === "object" ? Object.keys(runtimeDb.premises).length : 0,
            linksCount: Array.isArray(runtimeDb.links) ? runtimeDb.links.length : 0,
            ledgerRowsCount: Array.isArray(arr) ? arr.length : 0,
            rowsWithComputedFields: Array.isArray(arr) ? arr.filter(ledgerRowHasComputedFields).length : 0,
            hydrationSource: "getPayments",
            hydrationReason: Array.isArray(arr) && arr.length ? "LEDGER_AVAILABLE" : "LEDGER_EMPTY"
          });
        } catch(eReloadRuntimeLog) {}
      } catch (e) {
        if (e && e.code === "LEDGER_JSON_INVALID") {
          tbody.innerHTML = '<tr><td colspan="20" style="color:#b00020;font-weight:700;">' + LEDGER_FATAL_MESSAGE + '</td></tr>';
          try { alert(LEDGER_FATAL_MESSAGE); } catch (_) {}
          return;
        }
        throw e;
      } finally {
        try { console.timeEnd('[payment-table] load-ledger'); } catch(e) {}
        perfLog('load-ledger', loadStartedAt);
      }

      if (Array.isArray(arr) && arr.length === 0 && getPassiveSnapshotCalculatedRenderStateForEmptyLedger()) {
        try {
          console.log("[reload-chain][rows-apply-result]", {
            uid: String(getAbonentId() || ""),
            source: "canonical_backend_snapshot",
            snapshotAttemptReason: "PASSIVE_SNAPSHOT_RENDER_STATE",
            rowsBeforeRender: 0,
            rowsAfterFilter: __paymentTableCalculatedRenderState.rows.length,
            rowsByIdApplied: Object.keys(__paymentTableCalculatedRenderState.rowsById || {}).length,
            rowsWithComputedFields: __paymentTableCalculatedRenderState.rows.filter(ledgerRowHasComputedFields).length,
            reason: "late-empty-ledger-preserve-snapshot"
          });
        } catch(ePassiveSnapshotLog) {}
        if (await renderCalculatedRowsDirect("late-empty-ledger-preserve-snapshot")) return;
      }

      const periodActive = isCalcPeriodActive();
      const selectedPeriod = periodActive ? getCalcPeriod() : null;

      // Read-only load path: autoaccrual is not applied during page opening.

      const normalizeStartedAt = perfNow();
      try { console.time('[payment-table] normalize-rows'); } catch(e) {}
      try {
        // нормализуем даты + синхронизируем год/месяц
        arr.forEach(r => {
          normalizePaidDateISO(r);
          if (String(r?.paid_date || "").trim()) syncYearMonthFromPaidDate(r);
          normalizePeriod(r);
          calcRowBase(r);
        });
        draftRows.forEach(r => {
          normalizePaidDateISO(r);
          if (String(r?.paid_date || "").trim()) syncYearMonthFromPaidDate(r);
          normalizePeriod(r);
        });
      } finally {
        try { console.timeEnd('[payment-table] normalize-rows'); } catch(e) {}
        perfLog('normalize', normalizeStartedAt);
      }

      const displayRows = arr.concat(draftRows);
      const view = applyResponsibilityRangeToView(applyCalcFilter(displayRows, periodActive, selectedPeriod)).slice();
      if (periodActive && selectedPeriod) {
        try {
          console.log("[payment-table][period-filter-applied-on-load]", {
            abonentId: String(getAbonentId() || ""),
            from: selectedPeriod.from || "",
            to: selectedPeriod.to || "",
            rowsBefore: Array.isArray(arr) ? arr.length : 0,
            rowsAfter: Array.isArray(view) ? view.length : 0,
            reason: "active_calc_period"
          });
        } catch(ePeriodLog) {}
      }
      const baseRows = runningTotalsBaseRows(view.filter(function(r){ return !isPaymentDraftRow(r); }));
      const runtimeLedgerVersion = (window.Data && Data.computeLedgerRuntimeVersion) ? String(Data.computeLedgerRuntimeVersion(getAbonentId()) || "") : "";
      const draftSignature = ledgerSignatureForRows(draftRows);
      const effectiveSignature = periodActive && selectedPeriod
        ? (ledgerSignatureForRows(baseRows) + "|period:" + String(selectedPeriod.from || "") + ":" + String(selectedPeriod.to || "") + "|draft:" + draftSignature)
        : (ledgerSignatureForRows(arr) + "|draft:" + draftSignature);
      const signature = effectiveSignature + "::" + runtimeCacheSignature(runtimeLedgerVersion, periodActive, selectedPeriod);
      if (__paymentTableRenderedSignature && __paymentTableRenderedSignature === signature) {
        try { console.log("[payment-table][init-skipped-same-signature]", { abonentId: String(getAbonentId() || ""), periodActive: !!periodActive, selectedPeriod: selectedPeriod || null }); } catch(e) {}
        return;
      }

      // сортировка отображения — год/месяц (новые сверху),
      // внутри месяца: сначала строка начисления, ниже — оплаты (Excel и ручные)
      const isAccrualRow = (r) => toNum(r?.accrued ?? 0) > 0.0000001;

      // --- UI: сворачиваемые блоки месяца ---
      __collapsedMonths = __collapsedMonths || loadCollapsedMap();
      __monthHasPayments = {};
      __monthPaidSum = {};
      view.forEach(r => {
        const YM = ymKeyOfRow(r);
        if (!__monthHasPayments[YM]) __monthHasPayments[YM] = { hasPayments: false };
        if (toNum(r?.paid ?? 0) > 0.0000001) {
          __monthHasPayments[YM].hasPayments = true;
          __monthPaidSum[YM] = r2((__monthPaidSum[YM] || 0) + toNum(r?.paid ?? 0));
        }
      });
      let runtimeCacheUsed = false;
      let runtimeCachePeriodMatches = false;
      let baseRowsSource = periodActive && selectedPeriod ? "filtered" : "runtime_cache";
      let skipRunningTotalsUpdate = false;
      let restoredFromCardSnapshot = false;
      let renderSource = "raw_ledger";
      let renderRowsById = {};
      let normalSnapshotState = { valid: false, reason: "NOT_ATTEMPTED" };
      const expectedRuntimeSignature = runtimeCacheSignature(runtimeLedgerVersion, periodActive, selectedPeriod);
      const calculatedRowsMatch = applyFreshCalculatedRowsForRender(view, {
        ledgerVersion: runtimeLedgerVersion,
        runtimeSignature: expectedRuntimeSignature,
        periodActive: periodActive,
        selectedPeriod: selectedPeriod
      });
      if (calculatedRowsMatch && calculatedRowsMatch.applied === true) {
        const calculatedRowsById = calculatedRowsMatch.dataById || {};
        __runtimeCacheState = { valid: true, reason: "", dataById: calculatedRowsById, periodMatches: true, builtForPeriod: !!periodActive, temporary: false, calculatedRows: true };
        runtimeCacheUsed = true;
        runtimeCachePeriodMatches = true;
        baseRowsSource = "calculated_rows";
        renderSource = "calculated_rows";
        renderRowsById = calculatedRowsById;
        restoredFromCardSnapshot = true;
        skipRunningTotalsUpdate = true;
        capturePaymentTableComputedRowsSnapshot(
          view,
          calculatedRowsById,
          periodActive,
          selectedPeriod,
          expectedRuntimeSignature,
          runtimeLedgerVersion
        );
      } else if (isTemporaryCourtPeriodMode() && periodActive && selectedPeriod) {
        const temporaryRows = buildTemporaryPeriodRowsById(displayRows, view, selectedPeriod);
        __runtimeCacheState = { valid: true, reason: "", dataById: temporaryRows.rowsById || {}, periodMatches: true, builtForPeriod: true, temporary: true, totals: temporaryRows.totals || null };
        runtimeCacheUsed = true;
        runtimeCachePeriodMatches = true;
        baseRowsSource = "temporary_court_period";
        renderSource = "calculated_rows";
        renderRowsById = temporaryRows.rowsById || {};
        skipRunningTotalsUpdate = true;
        capturePaymentTableComputedRowsSnapshot(
          view,
          temporaryRows.rowsById || {},
          periodActive,
          selectedPeriod,
          expectedRuntimeSignature,
          runtimeLedgerVersion
        );
      } else if (!isReadonlyNoRecalcMode()) {
        try {
          console.log("[card-snapshot][normal-load-restore-attempt]", {
            abonentId: String(getAbonentId() || ""),
            periodActive: !!periodActive,
            selectedPeriod: selectedPeriod || null,
            ledgerVersion: runtimeLedgerVersion,
            runtimeSignature: runtimeCacheSignature(runtimeLedgerVersion, periodActive, selectedPeriod)
          });
        } catch(eSnapshotAttemptLog) {}
        normalSnapshotState = tryApplyCardSnapshotToRows(view, runtimeLedgerVersion, periodActive, selectedPeriod, expectedRuntimeSignature);
        if (normalSnapshotState && normalSnapshotState.valid === true) {
          __runtimeCacheState = normalSnapshotState;
          runtimeCacheUsed = true;
          runtimeCachePeriodMatches = true;
          baseRowsSource = "card_snapshot";
          renderSource = "card_snapshot";
          renderRowsById = normalSnapshotState.dataById || {};
          restoredFromCardSnapshot = true;
          skipRunningTotalsUpdate = true;
          capturePaymentTableComputedRowsSnapshot(
            view,
            normalSnapshotState.dataById || {},
            periodActive,
            selectedPeriod,
            expectedRuntimeSignature,
            runtimeLedgerVersion
          );
          try {
            console.log("[card-snapshot][normal-load-restored]", {
              abonentId: String(getAbonentId() || ""),
              rowsByIdCount: normalSnapshotState.dataById && typeof normalSnapshotState.dataById === "object" ? Object.keys(normalSnapshotState.dataById).length : 0,
              periodActive: !!periodActive,
              selectedPeriod: selectedPeriod || null
            });
          } catch(eSnapshotRestoredLog) {}
          logReadinessRegressionAfterPassiveRestore(Array.isArray(view) ? view.length : Object.keys(normalSnapshotState.dataById || {}).length);
        } else {
          const displayOnlySnapshotState = tryApplyDisplayOnlyCardSnapshotRows(view, normalSnapshotState && normalSnapshotState.reason || "CARD_SNAPSHOT_DISPLAY_ONLY", periodActive, selectedPeriod, runtimeLedgerVersion, expectedRuntimeSignature);
          if (displayOnlySnapshotState && displayOnlySnapshotState.dataById && Object.keys(displayOnlySnapshotState.dataById).length) {
            __runtimeCacheState = displayOnlySnapshotState;
            runtimeCacheUsed = false;
            runtimeCachePeriodMatches = false;
            baseRowsSource = "dirty_card_snapshot_display_only";
            renderSource = "card_snapshot";
            renderRowsById = displayOnlySnapshotState.dataById || {};
            restoredFromCardSnapshot = true;
            skipRunningTotalsUpdate = true;
            notifyRuntimeCacheSummaryState(__runtimeCacheState, periodActive, selectedPeriod);
          }
        }
      }
      if (!restoredFromCardSnapshot && periodActive && selectedPeriod && !isReadonlyNoRecalcMode()) {
        runtimeCachePeriodMatches = inspectRuntimeCachePeriodMatch(true, selectedPeriod);
        const periodRowsById = runtimeRowsByIdFromRows(view, baseRows, effectiveSignature);
        applyRuntimeRowsById(view, periodRowsById);
        __runtimeCacheState = { valid: true, reason: "", dataById: periodRowsById, periodMatches: runtimeCachePeriodMatches, builtForPeriod: true };
        renderSource = "calculated_rows";
        renderRowsById = periodRowsById;
      } else if (!restoredFromCardSnapshot) {
        __runtimeCacheState = applyRuntimeCacheToRows(view, periodActive, selectedPeriod);
        runtimeCacheUsed = !!__runtimeCacheState.valid;
        runtimeCachePeriodMatches = !!__runtimeCacheState.periodMatches;
        baseRowsSource = runtimeCacheUsed ? "runtime_cache" : "stale_no_recalc";
        if (runtimeCacheUsed) {
          renderSource = "runtime_cache";
          renderRowsById = __runtimeCacheState.dataById || {};
        }
      }
      if (__runtimeCacheState && __runtimeCacheState.valid === true) {
        capturePaymentTableComputedRowsSnapshot(
          view,
          __runtimeCacheState.dataById || {},
          periodActive,
          selectedPeriod,
          expectedRuntimeSignature,
          runtimeLedgerVersion
        );
      }
      if (!restoredFromCardSnapshot) notifyRuntimeCacheSummaryState(__runtimeCacheState, periodActive, selectedPeriod);
      let viewTotalsStats = computedRowsStats(view, null);
      logLedgerFields(view, __runtimeCacheState && __runtimeCacheState.valid === true ? (__runtimeCacheState.dataById || {}) : null, "after-runtime-cache-restore");
      if (Array.isArray(view) && view.length && viewTotalsStats.rowsWithTotals <= 0 && renderSource === "raw_ledger") {
        const inMemoryCalculatedRowsById = getCalculatedRenderRowsForView(view);
        if (inMemoryCalculatedRowsById) {
          applyRuntimeRowsById(view, inMemoryCalculatedRowsById);
          __runtimeCacheState = { valid: true, reason: "", dataById: inMemoryCalculatedRowsById, periodMatches: true, builtForPeriod: !!periodActive, temporary: false, calculatedRows: true };
          runtimeCacheUsed = true;
          runtimeCachePeriodMatches = true;
          baseRowsSource = "calculated_rows";
          renderSource = "calculated_rows";
          renderRowsById = inMemoryCalculatedRowsById;
          restoredFromCardSnapshot = true;
          skipRunningTotalsUpdate = true;
          viewTotalsStats = computedRowsStats(view, null);
          capturePaymentTableComputedRowsSnapshot(
            view,
            inMemoryCalculatedRowsById,
            periodActive,
            selectedPeriod,
            expectedRuntimeSignature,
            runtimeLedgerVersion
          );
        }
      }
      if (Array.isArray(view) && view.length && viewTotalsStats.rowsWithTotals <= 0 && applyComputedSnapshotRowsToLedgerRows(view, "raw-ledger-no-totals")) {
        viewTotalsStats = computedRowsStats(view, null);
        logLedgerFields(view, null, "after-snapshot-ledger-restore");
        renderSource = "calculated_rows";
        renderRowsById = {};
      }
      if (Array.isArray(view) && view.length && viewTotalsStats.rowsWithTotals <= 0) {
        try {
          console.warn("[card-reload][raw-ledger-no-totals]", {
            uid: String(getAbonentId() || ""),
            source: "raw_payments_ledger",
            rowsCount: view.length,
            rowsByIdCount: __runtimeCacheState && __runtimeCacheState.dataById && typeof __runtimeCacheState.dataById === "object" ? Object.keys(__runtimeCacheState.dataById).length : 0,
            periodActive: !!periodActive,
            selectedPeriod: selectedPeriod || null,
            runtimeCacheReason: String(__runtimeCacheState && __runtimeCacheState.reason || "")
          });
        } catch(eRawLedgerNoTotalsLog) {}
      }
      if (renderSource === "raw_ledger" && viewTotalsStats.rowsWithTotals > 0) {
        renderSource = "calculated_rows";
      }
      if (renderSource === "raw_ledger") renderSource = "raw_payments_ledger";
      logPaymentTableRenderSource(renderSource, view, renderRowsById);
      try {
        console.log("[reload-chain][rows-apply-result]", {
          uid: String(getAbonentId() || ""),
          source: renderSource,
          snapshotAttemptReason: String(normalSnapshotState && normalSnapshotState.reason || ""),
          rowsBeforeRender: Array.isArray(arr) ? arr.length : 0,
          rowsAfterFilter: Array.isArray(view) ? view.length : 0,
          rowsByIdApplied: renderRowsById && typeof renderRowsById === "object" ? Object.keys(renderRowsById).length : 0,
          rowsWithComputedFields: Array.isArray(view) ? view.filter(ledgerRowHasComputedFields).length : 0,
          reason: Array.isArray(view) && !view.length ? "RUNTIME_HYDRATION_EMPTY" : (restoredFromCardSnapshot ? "SNAPSHOT_ROWS_APPLIED" : String(__runtimeCacheState && __runtimeCacheState.reason || "ROWS_NOT_APPLIED"))
        });
        try {
          const comparisonSnapshot = window.Data && typeof Data.readCardSnapshot === "function" ? Data.readCardSnapshot(getAbonentId()) : null;
          const comparisonUid = String(comparisonSnapshot && comparisonSnapshot.uid || getAbonentId() || "");
          const comparisonKey = "jkh_reload_chain_diag:" + comparisonUid;
          const comparisonRaw = sessionStorage.getItem(comparisonKey);
          const comparisonState = comparisonRaw ? JSON.parse(comparisonRaw) : { uid: comparisonUid };
          comparisonState.renderedRows = Array.isArray(view) ? view.length : 0;
          comparisonState.cardStatus = window.__lastCardSummaryForDebug && (window.__lastCardSummaryForDebug.summary_status || window.__lastCardSummaryForDebug.status) || "";
          comparisonState.divergenceStage = !Array.isArray(arr) || !arr.length ? "RUNTIME_HYDRATION_EMPTY" : (!restoredFromCardSnapshot && !Object.keys(renderRowsById || {}).length ? "CARD_ROWS_NOT_APPLIED" : "UNKNOWN");
          sessionStorage.setItem(comparisonKey, JSON.stringify(comparisonState));
          console.log("[reload-chain][comparison]", comparisonState);
        } catch(eReloadComparisonLog) {}
      } catch(eReloadApplyLog) {}
      try {
        if (isReadonlyNoRecalcMode()) {
          console.log("[payment-table][readonly-no-recalc]", {
            abonentId: String(getAbonentId() || ""),
            cacheValid: !!__runtimeCacheState.valid,
            reason: String(__runtimeCacheState.reason || ""),
            periodActive: !!periodActive,
            rowsView: Array.isArray(view) ? view.length : 0
          });
        }
        console.log("[payment-table][period-runtime-source]", {
          abonentId: String(getAbonentId() || ""),
          periodActive: !!periodActive,
          selectedPeriod: selectedPeriod || null,
          rowsFull: Array.isArray(arr) ? arr.length : 0,
          rowsView: Array.isArray(view) ? view.length : 0,
          runtimeCacheUsed: runtimeCacheUsed,
          runtimeCachePeriodMatches: runtimeCachePeriodMatches,
          restoredFromCardSnapshot: restoredFromCardSnapshot,
          baseRowsSource: baseRowsSource,
          effectiveSignature: effectiveSignature
        });
      } catch(eRuntimeSourceLog) {}
      if (!periodActive || !selectedPeriod) {
        try {
          console.log("[payment-table][full-view-after-period-reset]", {
            abonentId: String(getAbonentId() || ""),
            periodActive: !!periodActive,
            rowsFull: Array.isArray(arr) ? arr.length : 0,
            rowsView: Array.isArray(view) ? view.length : 0
          });
        } catch(eFullViewLog) {}
      }
      const statusBox = qs("#paymentTableStatus") || qs("#paymentStatus") || qs("#paymentsStatus");
      if (isReadonlyNoRecalcMode() && statusBox) {
        statusBox.textContent = __runtimeCacheState.valid ? "" : "Для актуальных сумм нажмите Пересчитать";
      }
      if (isReadonlyNoRecalcMode() && statusBox && !__runtimeCacheState.valid) {
        statusBox.textContent = __runtimeCacheState.reason === "RUNTIME_CACHE_PERIOD_MISMATCH"
          ? "Требуется пересчёт таблицы для выбранного периода"
          : "Требуется пересчёт: runtime cache отсутствует или устарел";
      }
      view.sort((a, b) => {
        const ay = Number(a.year) || 0;
        const by = Number(b.year) || 0;
        if (ay !== by) return by - ay;

        const am = Number(String(a.month || "").padStart(2, "0")) || 0;
        const bm = Number(String(b.month || "").padStart(2, "0")) || 0;
        if (am !== bm) return bm - am;

        const aa = isAccrualRow(a);
        const ba = isAccrualRow(b);
        if (aa !== ba) return aa ? -1 : 1; // начисление всегда выше оплат

        // оплаты сортируем по дате оплаты (новые сверху)
        const d = paidDateMs(b) - paidDateMs(a);
        if (d !== 0) return d;

        return (Number(a.id) || 0) - (Number(b.id) || 0);
      });

      const renderStartedAt = perfNow();
      recordPaymentRenderRegression("render", {
        reason: __paymentTableCurrentLoadMeta && __paymentTableCurrentLoadMeta.reason || "",
        renderSource: renderSource,
        rowCount: Array.isArray(view) ? view.length : 0,
        ledgerRowsCount: Array.isArray(arr) ? arr.length : 0,
        snapshotRowsCount: renderRowsById && typeof renderRowsById === "object" ? Object.keys(renderRowsById).length : 0,
        caller: __paymentTableCurrentLoadMeta && __paymentTableCurrentLoadMeta.caller || "",
        stackFrames: __paymentTableCurrentLoadMeta && __paymentTableCurrentLoadMeta.stack || []
      });
      try { console.time('[payment-table] render'); } catch(e) {}
      try {
        await renderRowsChunked(tbody, view, 50);
      } finally {
        try { console.timeEnd('[payment-table] render'); } catch(e) {}
        perfLog('render', renderStartedAt);
      }

      __paymentTableRenderedSignature = signature;
      // Тяжёлый расчёт пени/долга не блокирует открытие карточки: строки сначала
      // рисуются с уже сохранёнными значениями, затем ro-ячейки обновляются чанками.
      if (skipRunningTotalsUpdate) {
        try {
          console.log("[card-snapshot][normal-load-skip-running-totals]", {
            abonentId: String(getAbonentId() || ""),
            periodActive: !!periodActive,
            selectedPeriod: selectedPeriod || null
          });
        } catch(eSkipSnapshotLog) {}
      }
      if (!skipRunningTotalsUpdate && !isReadonlyNoRecalcMode()) {
        scheduleRunningTotalsUpdate(view, baseRows, tbody, effectiveSignature);
      }
      clearLastAddedPaymentId();
    } finally {
      try { console.timeEnd('[payment-table] init-total'); } catch(e) {}
      perfLog('total', totalStartedAt);
    }
  }

  let __paymentTableLoadRunning = false;
  let __paymentTableLoadScheduled = false;
  let __paymentTableSettledCallbacks = [];
  function requestLoadPaymentTable(options){
    const opts = (options && typeof options === "object") ? options : { reason: options };
    const onSettled = typeof opts.onSettled === "function" ? opts.onSettled : null;
    if (onSettled) __paymentTableSettledCallbacks.push(onSettled);
    if (opts.mode) __paymentTableMode = String(opts.mode);
    if (opts.force) __paymentTableRenderedSignature = "";
    const reason = String(opts.reason || opts.mode || "scheduled");
    const requestTrace = paymentRenderCaller((new Error()).stack || "");
    const requestMeta = { reason: reason, caller: requestTrace.caller, stack: requestTrace.stack };
    recordPaymentRenderRegression("load-request", requestMeta);
    const runningFullRecalc = currentFullRecalcRunState();
    const allowDuringFullRecalc = reason === "full_recalc_completed" || reason === "manual-full-recalc" || reason === "temporary_court_period";
    if (runningFullRecalc && !allowDuringFullRecalc) {
      try {
        console.log("[full-recalc][event-ignored-during-run]", {
          runId: runningFullRecalc.runId || "",
          event: "requestLoadPaymentTable",
          reason: reason,
          abonentId: String(getAbonentId() || "")
        });
      } catch(eFullRunIgnoreLog) {}
      return;
    }
    if (reason.toLowerCase().indexOf("import") >= 0) {
      __paymentTableRenderedSignature = "";
      try { console.log("[payment-table][import-render-no-recalc]", { reason: reason, mode: __paymentTableMode }); } catch(eImportLog) {}
    }
    if (__paymentTableLoadScheduled) {
      try { console.log("[payment-table][init-skipped-inflight]", { reason: String(reason || "scheduled"), phase: "scheduled" }); } catch(e) {}
      return;
    }
    if (__paymentTableLoadRunning) {
      try { console.log("[payment-table][init-skipped-inflight]", { reason: String(reason || "scheduled"), phase: "running" }); } catch(e) {}
      return;
    }
    __paymentTableLoadScheduled = true;
    setTimeout(async function(){
      __paymentTableLoadScheduled = false;
      let settledError = null;
      try {
        await loadPaymentTable(reason || 'scheduled', requestMeta);
      } catch(e) {
        settledError = e;
        console.error(e);
      } finally {
        const settledCallbacks = __paymentTableSettledCallbacks.splice(0);
        for (let i = 0; i < settledCallbacks.length; i += 1) {
          try { settledCallbacks[i]({ ok: !settledError, reason: reason, error: settledError }); } catch(eSettled) { console.error(eSettled); }
        }
      }
    }, 0);
  }

  async function loadPaymentTable(reason, requestMeta) {
    if (__paymentTableLoadRunning) {
      try { console.log("[payment-table][init-skipped-inflight]", { reason: String(reason || ""), phase: "running" }); } catch(e) {}
      return;
    }
    __paymentTableLoadRunning = true;
    const directTrace = requestMeta || paymentRenderCaller((new Error()).stack || "");
    __paymentTableCurrentLoadMeta = {
      reason: String(reason || ""),
      caller: String(directTrace && directTrace.caller || ""),
      stack: directTrace && directTrace.stack || []
    };
    recordPaymentRenderRegression("load-start", __paymentTableCurrentLoadMeta);
    try {
      console.log("[payment-table][init-start]", { reason: String(reason || "") });
      await loadPaymentTableImpl();
      console.log("[payment-table][init-done]", { reason: String(reason || "") });
    } finally {
      __paymentTableLoadRunning = false;
      __paymentTableCurrentLoadMeta = null;
    }
  }

  window.runTemporaryPeriodCalculation = async function runTemporaryPeriodCalculation(options){
    const opts = options && typeof options === "object" ? options : {};
    const id = String(opts.abonentId || getAbonentId() || "").trim();
    const period = opts.period && typeof opts.period === "object" ? opts.period : null;
    const selectedPeriod = period ? { from: String(period.from || "").trim(), to: String(period.to || "").trim() } : null;
    try {
      console.log("[period-recalc][start]", {
        abonentId: id,
        period: selectedPeriod,
        mode: "temporary_court_period"
      });
    } catch(eStartLog) {}

    if (!id) return { ok:false, reason:"ABONENT_REQUIRED", mode:"temporary_court_period" };
    if (!selectedPeriod || !isManualRecalcPeriodValid(selectedPeriod)) {
      return { ok:false, reason:"PERIOD_INVALID", mode:"temporary_court_period" };
    }
    if (!await waitPaymentTableHydratedDatabase("TEMPORARY_PERIOD_RECALC")) {
      return { ok:false, reason:"DB_NOT_HYDRATED", mode:"temporary_court_period" };
    }

    try {
      console.log("[period-recalc][temporary-mode]", {
        abonentId: id,
        from: selectedPeriod.from,
        to: selectedPeriod.to,
        mode: "temporary_court_period"
      });
      console.warn("[period-recalc][blocked-full-write]", {
        abonentId: id,
        blocked: [
          "Data.writePaymentLedger",
          "Data.recalculateAbonentCard",
          "Data.recalcAbonentSummaryExplicit",
          "JKHAutoAccrual AUTOACCRUAL_WRITE",
          "card_snapshot save"
        ],
        reason: "temporary-period-mode"
      });
    } catch(eModeLog) {}

    window.JKH_CARD_PERIOD_MODE_ACTIVE = true;
    __paymentTableMode = "temporary_court_period";
    __paymentTableRenderedSignature = "";
    await loadPaymentTable("temporary_court_period");

    let renderedRowsCount = 0;
    let renderedTotals = { debt: 0, penalty: 0, total: 0 };
    try {
      const snapshot = typeof window.__getPaymentTableComputedRowsSnapshot === "function" ? window.__getPaymentTableComputedRowsSnapshot() : null;
      const rows = snapshot && Array.isArray(snapshot.rows) ? snapshot.rows : [];
      const rowsById = snapshot && snapshot.rowsById && typeof snapshot.rowsById === "object" ? snapshot.rowsById : {};
      const totals = summarizeRowsById(rows, rowsById);
      renderedRowsCount = rows.length;
      renderedTotals = totals;
      console.log("[period-recalc][done]", {
        abonentId: id,
        from: selectedPeriod.from,
        to: selectedPeriod.to,
        mode: "temporary_court_period"
      });
      console.log("[period-recalc][no-write-confirmed]", {
        abonentId: id,
        mode: "temporary_court_period",
        rowsCount: renderedRowsCount,
        debt: totals.debt,
        penalty: totals.penalty,
        total: totals.total
      });
    } catch(eDoneLog) {}

    return {
      ok:true,
      reason:"OK",
      mode:"temporary_court_period",
      period:selectedPeriod,
      renderedPeriodRows: renderedRowsCount,
      totals: renderedTotals,
      autoaccrual_changed:false,
      summary_status:"skipped",
      summary_reason:"TEMPORARY_PERIOD_NOT_SAVED"
    };
  };


  function isPaymentLocked(r){
    // 🔒 Excel-импорт: такие оплаты запрещено менять в таблице программы
    return !!(r && (r.import_locked || r.locked || r.readonly));
  }

  function makeRow(r) {
    const tr = document.createElement("tr");
    tr.dataset.rowId = String(r.id);

    const _hasAccrued = toNum(r?.accrued ?? 0) > 0.0000001;
    const _hasPaid = toNum(r?.paid ?? 0) > 0.0000001;
    tr.classList.add(_hasAccrued ? "row-accrual" : (_hasPaid ? "row-payment" : "row-other"));
    if (isPaymentDraftRow(r)) tr.classList.add("row-draft");

    const usePeriod = !!r.use_period;
    const lockPeriod = false; // period selects must stay editable in manual mode
    const locked = isPaymentLocked(r);

    const _mKey = String(Number(r.month)).padStart(2, "0");
    const ymTitle = `${(RU_MONTHS_UP[_mKey] || _mKey)} ${r.year}`;
    const ymSub = _hasAccrued ? "начисление" : (_hasPaid ? "оплата" : "");
    const icon = locked ? ' <span title="Импорт (Excel) — редактирование запрещено" style="font-weight:400; font-size:11px; opacity:0.8;">📥</span>' : "";
    const ymKey = ymKeyOfRow(r);
    tr.dataset.ym = ymKey;
    const financialFields = computedFinancialFields(r);
    const debtCellValue = financialFields.debt;
    const penaltyCellValue = financialFields.penalty;
    const totalCellValue = financialFields.total;
    logRenderFinancialFields(r, financialFields);
    logActualRenderFinancialFields(r, financialFields);

    const hasChildren = !!(__monthHasPayments && __monthHasPayments[ymKey] && __monthHasPayments[ymKey].hasPayments);
    const collapsed = !!(__collapsedMonths && __collapsedMonths[ymKey]);

    // если месяц свернут — прячем строки оплат
    if (_hasPaid && collapsed) {
      tr.classList.add("ym-hidden");
    }

    const toggleBtn = _hasAccrued
      ? `<button class="ym-toggle" type="button" data-ym="${ymKey}" ${hasChildren ? "" : "disabled"} title="Свернуть/развернуть оплаты месяца">${collapsed ? "▸" : "▾"}</button>`
      : `<span class="ym-indent"></span>`;

    const yearMonthCell = `<div class="ym-wrap"><div class="ym-title">${toggleBtn} ${_hasPaid && !_hasAccrued ? "↳ " : ""}${ymTitle}${icon}</div><div class="ym-sub">${ymSub}</div></div>`;
    const periodCell = !usePeriod
      ? `<button class="btn-mini toggle-period" type="button">указать за период</button>`
      : `
        <div class="period-wrap">
          <label class="period-flag">
            <input class="toggle-period" type="checkbox" checked>
            <span>за период</span>
          </label>

          <div class="period-selects">
            <select class="f" data-field="period_from_m" ${lockPeriod ? "disabled" : ""}>${monthOptionsNums(r.period_from_m)}</select>
            <select class="f" data-field="period_from_y" ${lockPeriod ? "disabled" : ""}>${yearsOptions(r.period_from_y)}</select>
            <span class="dash">—</span>
            <select class="f" data-field="period_to_m" ${lockPeriod ? "disabled" : ""}>${monthOptionsNums(r.period_to_m)}</select>
            <select class="f" data-field="period_to_y" ${lockPeriod ? "disabled" : ""}>${yearsOptions(r.period_to_y)}</select>
          </div>
          <div class="ym-sub" style="margin-top:4px;">автосохранение</div>
        </div>
      `;

    tr.innerHTML = `
      <td>${yearMonthCell}</td>
      <td><input class="f" data-field="accrued" type="number" step="0.01" value="${r.accrued ?? 0}" readonly></td>
      <td><input class="f" data-field="paid" type="text" inputmode="decimal" value="${_hasAccrued ? fmtMoneyHuman((__monthPaidSum && __monthPaidSum[ymKey]) ? __monthPaidSum[ymKey] : 0) : fmtMoneyHuman(r.paid ?? 0)}" ${(_hasAccrued || locked) ? "readonly" : ""}></td>
      <td><input class="f" data-field="paid_date" type="date" value="${_hasAccrued ? "" : (r.paid_date || "")}" ${(_hasAccrued || locked) ? "disabled" : ""}></td>
      <td><select class="f" data-field="source" ${(_hasAccrued || locked) ? "disabled" : ""}>${_hasAccrued ? '<option value="">—</option>' : sourceOptionsHtml(r.source)}</select></td>

      <td>${periodCell}</td>

      <td class="ro" style="${debtCellValue < -0.0000001 ? 'color:#8B0000; font-weight:700;' : ''}">${(isReadonlyNoRecalcMode() && !__runtimeCacheState.valid && !financialFields.hasDebt) ? "—" : fmtMoney(debtCellValue)}</td>
      <td class="ro">${(isReadonlyNoRecalcMode() && !__runtimeCacheState.valid && !financialFields.hasPenalty) ? "—" : fmtMoney(penaltyCellValue)}</td>
      <td class="ro">${(isReadonlyNoRecalcMode() && !__runtimeCacheState.valid && !financialFields.hasTotal) ? "—" : fmtMoney(totalCellValue)}</td>

      <td>
        <textarea class="note-inline" placeholder="" style="width:100%; min-height:34px; resize:vertical;" ${locked ? "readonly" : ""}>${escapeHtml(r.note || "")}</textarea>
      </td>

      <td class="id-cell">
        <div style="display:flex; gap:6px; align-items:center; justify-content:space-between;">
          <span>${isPaymentDraftRow(r) ? "draft" : r.id}</span>
          <button class="row-del" type="button" title="Удалить" style="${(locked || _hasAccrued) ? "display:none" : ""}">✖</button>
        </div>
        ${isPaymentDraftRow(r) ? '<div class="payment-row-status" style="margin-top:4px;font-size:11px;line-height:1.2;color:#7a5300;">Черновик не сохранён</div>' : ''}
      </td>
    `;

    bindRowEvents(tr, r.id, r);
    return tr;
  }

  const noteTimers = new Map();
  function saveNoteDebounced(rowId, value) {
    if (noteTimers.has(rowId)) clearTimeout(noteTimers.get(rowId));
    const t = setTimeout(async () => {
      const arr = getPayments();
      const row = arr.find(x => String(x.id) === String(rowId));
      if (!row) return;
      row.note = value || "";
      await savePaymentsAndFlush(arr);
      markPaymentRuntimeStaleUI(null);
    }, 250);
    noteTimers.set(rowId, t);
  }

  function bindRowEvents(tr, rowId, rowSnapshot) {
    // Если строка импортирована из Excel и заблокирована — запрещаем любые изменения/удаление.
    // UI уже ставит readonly/disabled, но дополнительно блокируем обработчики, чтобы нельзя было обойти через DevTools.
    try {
      if (isPaymentLocked(rowSnapshot) || isAccrualRowGlobal(rowSnapshot)) {
        return;
      }
    } catch(e) { console.error(e); throw e; }

    function editableRow(){
      return readPaymentRowForEdit(rowId);
    }

    async function saveEditable(arr, edit){
      if (edit && edit.draft) return trySaveDraftRowIfValid(tr, rowId);
      if (edit && edit.row && !validateEditablePaymentBeforeSave(edit.row, tr)) return false;
      await savePaymentsAndFlush(arr);
      markPaymentRuntimeStaleUI(tr);
      return true;
    }

    const toggle = qs(".toggle-period", tr);
    if (toggle) {
      toggle.addEventListener("click", async () => {
        const edit = editableRow();
        const arr = edit.arr;
        const row = edit.row;
        if (!row) return;

        if (toggle.tagName === "BUTTON") {
          row.use_period = true;
          // default period = month/year строки (но НЕ блокируем редактирование)
          enforcePeriodSameAsYm(row);
          normalizePeriod(row);
          await saveEditable(arr, edit);
          if (!edit.draft) reloadPaymentTableReadonlyNoRecalc("toggle-period-no-recalc");
          return;
        }

        if (toggle.type === "checkbox") {
          row.use_period = !!toggle.checked;
          if (row.use_period) {
            // default period = month/year строки, дальше оператор правит сам
            enforcePeriodSameAsYm(row);
            normalizePeriod(row);
          }
          await saveEditable(arr, edit);
          if (!edit.draft) reloadPaymentTableReadonlyNoRecalc("toggle-period-no-recalc");
        }
      });
    }

    qsa(".f", tr).forEach(el => {
      const field = el.dataset.field;
      const needFullRerender = (field.startsWith("period_"));

      if (needFullRerender) {
        el.addEventListener("change", async () => {
          const edit = editableRow();
          const arr = edit.arr;
          const row = edit.row;
          if (!row) return;

          row[field] = el.value;

          // period strings (period_from/period_to) должны обновиться
          normalizePeriod(row);

          await saveEditable(arr, edit);
          if (!edit.draft) reloadPaymentTableReadonlyNoRecalc("period-edit-no-recalc");
        });
        return;
      }


      // CRITICAL: type=date — никаких перерисовок на input (иначе календарь сбивается).
      if (field === "paid_date") {
        el.addEventListener("change", async () => {
          const edit = editableRow();
          const arr = edit.arr;
          const row = edit.row;
          if (!row) return;

          row[field] = el.value;
          syncYearMonthFromPaidDate(row);
          await saveEditable(arr, edit);

          // Перерисовываем ТОЛЬКО после выбора даты
          if (!edit.draft) reloadPaymentTableReadonlyNoRecalc("payment-date-no-recalc");
        });
        return;
      }

      el.addEventListener("input", async () => {
        const edit = editableRow();
        const arr = edit.arr;
        const row = edit.row;
        if (!row) return;

        row[field] = el.value;

        if (field === "accrued" || field === "paid") {
          // Data Contract: paid не может быть отрицательным
          if (field === "paid") {
  // запятая -> точка (на лету)
  const raw = String(el.value ?? "").replace(/,/g, ".");
  if (raw !== el.value) el.value = raw;

  // paid не может быть отрицательным
  const v = Math.max(0, toNum(raw));
  row[field] = v;

  // НЕ форматируем до 0.00 на каждый символ (только на blur)
}
// ✅ ВОТ ТУТ ИСПРАВЛЕНИЕ: больше НЕ loadPaymentTable() на каждый символ
          if (edit.draft) {
            if (toNum(row.paid) > 0.0000001 && !parseDateAnyToDate(row.paid_date)) {
              showRowSoftMessage(tr, "Черновик: дата оплаты нужна для сохранения.", "warn");
            } else {
              showRowSoftMessage(tr, "Черновик не сохранён", "warn");
            }
          } else {
            if (!validateEditablePaymentBeforeSave(row, tr)) return;
            await savePaymentsAndFlush(arr);
            markPaymentRuntimeStaleUI(tr);
          }
          return;
        }

        await saveEditable(arr, edit);
      });
    });


  // paid: blur -> формат 0.00, Enter -> фокус на paid_date
  const paidEl = qs('input[data-field="paid"]', tr);
  const dateEl = qs('input[data-field="paid_date"]', tr);

  const srcSel = qs('select[data-field="source"]', tr);

  if (paidEl) {
    paidEl.addEventListener("focus", () => {
      try { paidEl.select(); } catch(e) {}
    });
    paidEl.addEventListener("blur", async () => {
      const edit = editableRow();
      const arr = edit.arr;
      const row = edit.row;
      if (!row) return;
      paidEl.value = fmtMoneyHuman(row.paid);
      if (edit.draft) {
        await trySaveDraftRowIfValid(tr, rowId);
      } else {
        await saveEditable(arr, edit);
        if (!edit.draft) markPaymentRuntimeStaleUI(tr);
      }
    });

    paidEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (dateEl) dateEl.focus();
      }
    });
  }


  // source select
  if (srcSel) {
    srcSel.addEventListener('change', async () => {
      let val = String(srcSel.value || '').trim();
      const edit = editableRow();
      const arr = edit.arr;
      const row = edit.row;
      if (!row) return;

      if (val === '__new__') {
        const name = prompt('Новый источник поступления (название):', '');
        const n = String(name || '').trim();
        if (!n) {
          // вернуть текущее значение
          srcSel.value = String(row.source || ensurePaymentSources()[0] || '');
          return;
        }
        const sources = ensurePaymentSources();
        if (!sources.includes(n)) {
          sources.push(n);
          savePaymentSources(sources);
        }
        row.source = n;
        await saveEditable(arr, edit);
        if (!edit.draft) reloadPaymentTableReadonlyNoRecalc("payment-source-no-recalc");
        return;
      }

      row.source = val || (ensurePaymentSources()[0] || '');
      await saveEditable(arr, edit);
    });
  }



    const noteArea = qs(".note-inline", tr);
    if (noteArea) {
      noteArea.addEventListener("input", () => {
        const edit = editableRow();
        if (edit.draft && edit.row) {
          edit.row.note = noteArea.value || "";
          showRowSoftMessage(tr, "Черновик не сохранён", "warn");
          return;
        }
        saveNoteDebounced(rowId, noteArea.value);
      });
      noteArea.addEventListener("blur", async () => {
        const edit = editableRow();
        const arr = edit.arr;
        const row = edit.row;
        if (!row) return;
        row.note = noteArea.value || "";
        await saveEditable(arr, edit);
      });
    }

    const delBtn = qs(".row-del", tr);
    if (delBtn) {
      delBtn.addEventListener("click", async () => {
        if (!confirm("Удалить оплату?")) return;
        if (isPaymentDraftRow(rowSnapshot)) {
          setPaymentDraftRows(getPaymentDraftRows().filter(x => String(x.id) !== String(rowId)));
          if (tr && tr.parentNode) tr.parentNode.removeChild(tr);
          return;
        }
        let arr = getPayments();
        arr = arr.filter(x => String(x.id) !== String(rowId));
        await savePaymentsAndFlush(arr);
        oldTrRemoveNoRecalc(tr);
      });
    }
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }


  // =============================================================
  // 🧮 ИТОГ КАРТОЧКИ АБОНЕНТА — ВСЕГО ЗАДОЛЖЕННОСТЬ
  // CRITICAL (ПАПАЖКХ):
  // Всего задолженность = Σ(Долг) + Σ(Пени) по всем строкам,
  // не зависит от выбранного периода.
  // =============================================================
  function JKH_RecalcAbonentTotalDebtCard() {
    try {
      const rows = getPayments() || [];
      let sumDebt = 0;
      let sumPenalty = 0;

      for (const r of rows) {
        sumDebt += toNum(r?.pay_main ?? 0);
        sumPenalty += toNum(r?.pay_penalty ?? 0);
      }

      const total = r2(sumDebt + sumPenalty);

      // Куда выводить итог (поддержка разных разметок карточки):
      const totalEl =
        document.getElementById('abonent_total_debt') ||
        document.getElementById('total_debt') ||
        document.querySelector('[data-field="total_debt"]') ||
        document.querySelector('[data-total="debt"]');

      const debtEl =
        document.getElementById('abonent_total_main_debt') ||
        document.getElementById('total_main_debt') ||
        document.querySelector('[data-field="total_main_debt"]');

      const penEl =
        document.getElementById('abonent_total_penalty_debt') ||
        document.getElementById('total_penalty_debt') ||
        document.querySelector('[data-field="total_penalty_debt"]');

      if (totalEl) totalEl.textContent = total.toFixed(2);
      if (debtEl)  debtEl.textContent  = r2(sumDebt).toFixed(2);
      if (penEl)   penEl.textContent   = r2(sumPenalty).toFixed(2);
    } catch (e) {
      if (e && e.code === "LEDGER_JSON_INVALID") {
        try { alert(LEDGER_FATAL_MESSAGE); } catch (_) {}
        return;
      }
      console.warn('JKH_RecalcAbonentTotalDebtCard failed', e);
    }
  }

  // =============================================================
  // 🏷 Переименование колонок: "по обяз." -> "Долг", "по пени" -> "Пени"
  // (без правки HTML — безопасно)
  // =============================================================
  function JKH_RenameDebtPenaltyHeaders() {
    try {
      document.querySelectorAll('th').forEach(th => {
        const t = String(th.textContent || '').trim();
        if (t === 'по обяз.' || t === 'по обяз') th.textContent = 'Долг';
        if (t === 'по пени' || t === 'по пени.' ) th.textContent = 'Пени';
      });
    } catch (e) {}
  }



  function normalizeManualRecalcReason(reason){
    const r = String(reason || "").trim();
    if (r === "NO_RANGE" || r === "NO_MONTHS" || r === "RESPONSIBILITY_DATE_MISSING" || r === "START_DATE_MISSING") return "RESPONSIBILITY_PERIOD_MISSING";
    if (r === "EMPTY_ID" || r === "EMPTY_OWNER") return "UID_REQUIRED";
    return r || "CALC_FAILED";
  }

  function getManualRecalcAbonentRecord(abonentId){
    const db = window.AbonentsDB || {};
    const id = String(abonentId || "");
    return (db.abonents && db.abonents[id] && typeof db.abonents[id] === "object") ? db.abonents[id] : null;
  }

  function getManualRecalcCalcStartISO(abonentId){
    const a = getManualRecalcAbonentRecord(abonentId);
    if (!a) return "";
    return parseAnyDateToISO(
      a.calcStartDate ??
      a.calc_start_date ??
      a.calcStart ??
      a.calc_start ??
      a.startCalc ??
      a.start_calc ??
      a.dateStartCalc ??
      a.date_start_calc ??
      a.calcDateStart ??
      a.calc_date_start ??
      a.calcDate ??
      a.calc_date
    );
  }

  function hasManualRecalcActiveLink(abonentId){
    const db = window.AbonentsDB || {};
    const linksRaw = Array.isArray(db.links) ? db.links : (Array.isArray(db.abonentPremiseLinks) ? db.abonentPremiseLinks : []);
    const id = String(abonentId || "");
    return (linksRaw || []).some(function(l){
      const aId = l && (l.abonentId ?? l.abonent_id ?? l.abonent ?? l.accountId ?? l.ls ?? l.personalAccount);
      if (String(aId ?? "") !== id) return false;
      return !!parseAnyDateToISO(l.dateFrom ?? l.from ?? l.start ?? l.startDate ?? l.date_start ?? l.respFrom) && !parseAnyDateToISO(l.dateTo ?? l.to ?? l.end ?? l.endDate ?? l.date_end ?? l.respTo);
    });
  }

  function repairResponsibilityStartFromPaymentsForManualRecalc(abonentId){
    const id = String(abonentId || "");
    const a = getManualRecalcAbonentRecord(id);
    if (!id || !a) return { ok:false, reason:"UID_REQUIRED" };
    if (hasManualRecalcActiveLink(id) || getManualRecalcCalcStartISO(id)) return { ok:false, reason:"RESPONSIBILITY_REPAIR_NOT_ALLOWED" };
    const suggestion = suggestResponsibilityStartFromPayments(id);
    if (!suggestion || !suggestion.suggestedStartDate) return { ok:false, reason:"RESPONSIBILITY_PERIOD_MISSING", suggestion:suggestion || null };
    a.calcStartDate = suggestion.suggestedStartDate;
    if (a.calcEndDate == null) a.calcEndDate = "";
    if (typeof window.saveAbonentsDB === "function") {
      window.saveAbonentsDB();
    } else if (window.JKHStore && typeof JKHStore.setRaw === "function") {
      JKHStore.setRaw("abonents_db_v1", JSON.stringify(window.AbonentsDB || {}));
    } else {
      return { ok:false, reason:"RESPONSIBILITY_REPAIR_SAVE_UNAVAILABLE", suggestion:suggestion };
    }
    console.warn("[responsibility][repair-from-payments]", {
      abonentId: id,
      calcStartDate: suggestion.suggestedStartDate,
      source: suggestion.source
    });
    return {
      ok:true,
      repaired:true,
      reason:"RESPONSIBILITY_REPAIRED_FROM_PAYMENTS",
      range:{ from:suggestion.suggestedStartDate, to:"" },
      suggestion:suggestion
    };
  }

  function validateResponsibilityRangeForManualRecalc(abonentId, options){
    const range = getActiveResponsibilityRangeISO();
    if (range && range.from) return { ok:true, range:range, repaired:false };
    const suggestion = suggestResponsibilityStartFromPayments(abonentId);
    if (options && options.allowResponsibilityStartRepair === true) {
      const repaired = repairResponsibilityStartFromPaymentsForManualRecalc(abonentId);
      if (repaired && repaired.ok === true) return repaired;
      return { ok:false, reason:normalizeManualRecalcReason(repaired && repaired.reason || "RESPONSIBILITY_PERIOD_MISSING"), suggestion:(repaired && repaired.suggestion) || suggestion || null };
    }
    return { ok:false, reason:"RESPONSIBILITY_PERIOD_MISSING", suggestion:suggestion || null };
  }

  function firstPeriodMonthForAutoAccrual(period){
    const from = String(period && period.from || "").trim();
    const m = from.match(/^(\d{4})-(\d{2})/);
    if (!m) return null;
    return { year: m[1], month: m[2] };
  }

  function detectManualRecalcTariffsMissing(abonentId, period){
    try {
      if (!window.JKHAutoAccrual || typeof window.JKHAutoAccrual.debugMonth !== "function") return false;
      const firstMonth = firstPeriodMonthForAutoAccrual(period);
      if (!firstMonth) return false;
      const dbg = window.JKHAutoAccrual.debugMonth(abonentId, firstMonth.year, firstMonth.month);
      const tariffs = Array.isArray(dbg && dbg.tariffs) ? dbg.tariffs : [];
      if (!tariffs.length) {
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  function hasAccrualInManualRecalcPeriod(rows, period){
    const fromMonth = String(period && period.from || "").slice(0, 7);
    const toMonth = String(period && period.to || "").slice(0, 7);
    if (!fromMonth || !toMonth) return true;
    const list = Array.isArray(rows) ? rows : [];
    for (let i = 0; i < list.length; i++) {
      const row = list[i] || {};
      const ym = ymKeyOfRow(row);
      if (ym >= fromMonth && ym <= toMonth && toNum(row.accrued) > 0.0000001) return true;
    }
    return false;
  }

  function isManualRecalcPeriodValid(period){
    const fromD = parseDateAnyToDate(period && period.from);
    const toD = parseDateAnyToDate(period && period.to);
    return !!(fromD && toD && startOfDay(fromD) <= startOfDay(toD));
  }

  function getHydratedDbCountsForPaymentTable(){
    const db = window.AbonentsDB && typeof window.AbonentsDB === "object" ? window.AbonentsDB : {};
    return {
      abonentsCount: db && db.abonents && typeof db.abonents === "object" ? Object.keys(db.abonents).length : 0,
      premisesCount: db && db.premises && typeof db.premises === "object" ? Object.keys(db.premises).length : 0,
      linksCount: db && Array.isArray(db.links) ? db.links.length : 0
    };
  }

  function logPaymentTableBlockedBeforeHydrate(reason){
    const counts = getHydratedDbCountsForPaymentTable();
    const ownerId = (window.JKHStore && typeof JKHStore.getOwnerId === "function") ? String(JKHStore.getOwnerId() || "") : "";
    const payload = {
      abonentId: String(getAbonentId() || ""),
      abonentsCount: counts.abonentsCount,
      linksCount: counts.linksCount,
      premisesCount: counts.premisesCount,
      ownerId: ownerId,
      reason: String(reason || "DB_NOT_HYDRATED")
    };
    try { console.warn("[card][blocked-before-hydrate]", payload); } catch(e) {}
    return payload;
  }

  async function waitPaymentTableHydratedDatabase(reason){
    if (window.waitForHydratedDatabase && typeof window.waitForHydratedDatabase === "function") {
      const ready = await window.waitForHydratedDatabase({ timeoutMs: 10000, reason: reason || "payment_table" });
      if (ready && ready.ok === true) return true;
      logPaymentTableBlockedBeforeHydrate(reason || "WAIT_TIMEOUT");
      return false;
    }
    if (window.Data && typeof Data.waitForHydratedDatabase === "function") {
      const ready = await Data.waitForHydratedDatabase({ timeoutMs: 10000, reason: reason || "payment_table" });
      if (ready && ready.ok === true) return true;
      logPaymentTableBlockedBeforeHydrate(reason || "DATA_WAIT_TIMEOUT");
      return false;
    }
    const counts = getHydratedDbCountsForPaymentTable();
    if (counts.abonentsCount > 0) return true;
    logPaymentTableBlockedBeforeHydrate(reason || "NO_GLOBAL_WAIT");
    return false;
  }

  async function applyControlledAutoAccrualForManualRecalc(abonentId, options){
    const opts = options || {};
    if (opts.applyAutoAccrual !== true) return { ok:true, changed:false, reason:"SKIPPED" };
    if (!await waitPaymentTableHydratedDatabase("AUTOACCRUAL_WRITE")) {
      try { console.log("[manual-recalc][autoaccrual]", { stage:"waitPaymentTableHydratedDatabase", reason:"DB_NOT_HYDRATED", error:null, result:false }); } catch(eManualRecalcAutoLog) {}
      return { ok:false, changed:false, reason:"DB_NOT_HYDRATED" };
    }
    if (!window.JKHAutoAccrual || typeof window.JKHAutoAccrual.dryRunForAbonent !== "function") {
      try { console.log("[manual-recalc][autoaccrual]", { stage:"JKHAutoAccrual.dryRunForAbonent.unavailable", reason:"AUTOACCRUAL_UNAVAILABLE", error:null, result:null }); } catch(eManualRecalcAutoLog) {}
      return { ok:false, changed:false, reason:"AUTOACCRUAL_UNAVAILABLE" };
    }
    const responsibility = validateResponsibilityRangeForManualRecalc(abonentId, opts);
    if (!responsibility || responsibility.ok !== true) {
      try { console.log("[manual-recalc][autoaccrual]", { stage:"validateResponsibilityRangeForManualRecalc", reason:normalizeManualRecalcReason(responsibility && responsibility.reason || "RESPONSIBILITY_PERIOD_MISSING"), error:null, result:responsibility || null }); } catch(eManualRecalcAutoLog) {}
      return {
        ok:false,
        changed:false,
        reason:normalizeManualRecalcReason(responsibility && responsibility.reason || "RESPONSIBILITY_PERIOD_MISSING"),
        responsibility:responsibility || null,
        suggestion:responsibility && responsibility.suggestion || null
      };
    }
    if (detectManualRecalcTariffsMissing(abonentId, opts.period)) {
      try { console.log("[manual-recalc][autoaccrual]", { stage:"detectManualRecalcTariffsMissing", reason:"TARIFFS_NOT_FOUND", error:null, result:true }); } catch(eManualRecalcAutoLog) {}
      return { ok:false, changed:false, reason:"TARIFFS_NOT_FOUND", responsibility:responsibility };
    }

    let result = null;
    try {
      result = await window.JKHAutoAccrual.dryRunForAbonent(abonentId);
    } catch (e) {
      const reason = normalizeManualRecalcReason(e && (e.code || e.reason || e.message) || e);
      try { console.log("[manual-recalc][autoaccrual]", { stage:"JKHAutoAccrual.dryRunForAbonent.catch", reason:reason, error:e, result:null }); } catch(eManualRecalcAutoLog) {}
      try { console.log("[manual-recalc][autoaccrual]", { stage:"JKHAutoAccrual.dryRunForAbonent.return", reason:reason, error:e, result:{ ok:false, changed:false, reason:reason, responsibility:responsibility } }); } catch(eManualRecalcAutoReturnLog) {}
      return { ok:false, changed:false, reason:reason, responsibility:responsibility };
    }

    const reason = normalizeManualRecalcReason(result && result.reason);
    if (!result || result.ok !== true) {
      try { console.log("[manual-recalc][autoaccrual]", { stage:"JKHAutoAccrual.dryRunForAbonent.result", reason:reason, error:null, result:result || null }); } catch(eManualRecalcAutoLog) {}
      return { ok:false, changed:false, reason:reason, responsibility:responsibility };
    }
    if (reason === "RESPONSIBILITY_PERIOD_MISSING" || reason === "TARIFFS_NOT_FOUND" || reason === "LEDGER_JSON_INVALID") {
      try { console.log("[manual-recalc][autoaccrual]", { stage:"JKHAutoAccrual.dryRunForAbonent.reason", reason:reason, error:null, result:result }); } catch(eManualRecalcAutoLog) {}
      return { ok:false, changed:false, reason:reason, responsibility:responsibility };
    }

    if (result.changed === true) {
      const proposedRows = Array.isArray(result.proposedRows) ? result.proposedRows : null;
      if (!proposedRows) {
        try { console.log("[manual-recalc][autoaccrual]", { stage:"proposedRows", reason:"AUTOACCRUAL_ROWS_MISSING", error:null, result:result }); } catch(eManualRecalcAutoLog) {}
        return { ok:false, changed:true, reason:"AUTOACCRUAL_ROWS_MISSING", autoaccrual:result };
      }
      const explicitCompletedEmptyLedger = proposedRows.length === 0 && result.completed === true && result.finalLedgerEmpty === true;
      if (proposedRows.length === 0 && !explicitCompletedEmptyLedger) {
        try { console.log("[manual-recalc][autoaccrual]", { stage:"proposedRows", reason:"AUTOACCRUAL_EMPTY_FINAL_NOT_CONFIRMED", error:null, result:result }); } catch(eManualRecalcAutoLog) {}
        return { ok:false, changed:true, reason:"AUTOACCRUAL_EMPTY_FINAL_NOT_CONFIRMED", autoaccrual:result };
      }
      if (!explicitCompletedEmptyLedger && !hasAccrualInManualRecalcPeriod(proposedRows, opts.period)) {
        try { console.log("[manual-recalc][autoaccrual]", { stage:"hasAccrualInManualRecalcPeriod.proposedRows", reason:"ACCRUALS_NOT_CREATED", error:null, result:false }); } catch(eManualRecalcAutoLog) {}
        return { ok:false, changed:true, reason:"ACCRUALS_NOT_CREATED", autoaccrual:result };
      }
      if (!(window.Data && (typeof Data.writePaymentLedgerServerBacked === "function" || typeof Data.writePaymentLedger === "function"))) {
        try { console.log("[manual-recalc][autoaccrual]", { stage:"Data.writePaymentLedger.unavailable", reason:"LEDGER_WRITE_UNAVAILABLE", error:null, result:null }); } catch(eManualRecalcAutoLog) {}
        return { ok:false, changed:true, reason:"LEDGER_WRITE_UNAVAILABLE", autoaccrual:result };
      }
      let savedLedger = null;
      let serverBackedLedger = false;
      if (window.Data && typeof Data.writePaymentLedgerServerBacked === "function") {
        serverBackedLedger = true;
        savedLedger = await Data.writePaymentLedgerServerBacked(abonentId, proposedRows, { eventType:"AUTOACCRUAL_WRITE", summaryDirtyReason:false, source:"manual_full_recalc" });
      } else {
        savedLedger = window.Data.writePaymentLedger(abonentId, proposedRows, { eventType:"AUTOACCRUAL_WRITE", summaryDirtyReason:false });
      }
      const ledgerWriteOk = serverBackedLedger ? !!(savedLedger && savedLedger.ok === true) : savedLedger !== false;
      if (!ledgerWriteOk) {
        const block = window.__JKH_LAST_AUTOACCRUAL_BLOCK || null;
        const savedLedgerReason = serverBackedLedger ? String(savedLedger && savedLedger.reason || "") : "";
        if ((block && block.reason === "ZERO_ACCRUAL_OVERWRITE_BLOCKED") || savedLedgerReason === "ZERO_ACCRUAL_OVERWRITE_BLOCKED") {
          try {
            console.warn("[full-recalc][autoaccrual-write-skipped]", {
              abonentId: String(abonentId || ""),
              reason: "ZERO_ACCRUAL_OVERWRITE_BLOCKED",
              rowsOld: block.rowsOld,
              rowsNew: block.rowsNew,
              oldAccruedCount: block.oldAccruedCount,
              newAccruedCount: block.newAccruedCount
            });
          } catch(eSkipLog) {}
          result.changed = false;
          result.writeBlocked = true;
          result.writeBlockReason = "ZERO_ACCRUAL_OVERWRITE_BLOCKED";
          result.reason = "ZERO_ACCRUAL_OVERWRITE_BLOCKED";
        } else if (savedLedgerReason === "SERVER_PERSIST_REQUIRED") {
          try { console.log("[manual-recalc][ledger-block]", { stage:"applyControlledAutoAccrualForManualRecalc.writePaymentLedgerServerBacked", subreason:"SERVER_PERSIST_REQUIRED", existingRows:null, newRows:Array.isArray(proposedRows) ? proposedRows.length : null, proposedRows:proposedRows, blockedBy:"Data.writePaymentLedgerServerBacked", details:savedLedger || null }); } catch(eLedgerBlockLog) {}
          try { console.log("[manual-recalc][autoaccrual]", { stage:"Data.writePaymentLedgerServerBacked", reason:"SERVER_PERSIST_REQUIRED", error:null, result:savedLedger || null }); } catch(eManualRecalcAutoLog) {}
          return { ok:false, changed:true, reason:"SERVER_PERSIST_REQUIRED", autoaccrual:result, persist:savedLedger || null };
        } else {
          try { console.log("[manual-recalc][ledger-block]", { stage:"applyControlledAutoAccrualForManualRecalc.writePaymentLedger", subreason:"PAYMENT_LEDGER_WRITE_BLOCKED", existingRows:null, newRows:Array.isArray(proposedRows) ? proposedRows.length : null, proposedRows:proposedRows, blockedBy:"Data.writePaymentLedger", details:block || null }); } catch(eLedgerBlockLog) {}
          try { console.log("[manual-recalc][autoaccrual]", { stage:"Data.writePaymentLedger", reason:"PAYMENT_LEDGER_WRITE_BLOCKED", error:null, result:savedLedger }); } catch(eManualRecalcAutoLog) {}
          return { ok:false, changed:true, reason:"PAYMENT_LEDGER_WRITE_BLOCKED", autoaccrual:result };
        }
      }
      if (ledgerWriteOk) {
        if (serverBackedLedger && savedLedger && savedLedger.localOk === false) {
          try { console.warn("[manual-recalc][autoaccrual]", { stage:"Data.writePaymentLedgerServerBacked.localCache", reason:"LOCAL_CACHE_WRITE_FAILED", error:null, result:savedLedger }); } catch(eLocalCacheWarnLog) {}
        }
        try {
          console.log("[full-recalc][save-ledger]", {
            abonentId: String(abonentId || ""),
            rows: proposedRows.length,
            changed: true,
            eventType: "AUTOACCRUAL_WRITE"
          });
        } catch(eSaveLedgerLog) {}
        clearPaymentLedgerReadCache("manual-recalc-autoaccrual");
        try {
          if (window.Data && typeof Data.invalidateLedgerRuntimeCache === "function") Data.invalidateLedgerRuntimeCache(abonentId);
        } catch (e0) {}
        if (serverBackedLedger) {
          try { console.log("[manual-recalc][autoaccrual]", { stage:"Data.writePaymentLedgerServerBacked", reason:savedLedger && savedLedger.reason || "OK", error:null, result:savedLedger }); } catch(eServerBackedLog) {}
        } else if (window.Data && typeof Data.flushDbToServer === "function") {
          await Data.flushDbToServer();
        } else {
          try { console.log("[manual-recalc][autoaccrual]", { stage:"Data.flushDbToServer.unavailable", reason:"SERVER_FLUSH_UNAVAILABLE", error:null, result:null }); } catch(eManualRecalcAutoLog) {}
          return { ok:false, changed:true, reason:"SERVER_FLUSH_UNAVAILABLE", autoaccrual:result };
        }
      }
    }

    if (result.changed !== true && !hasAccrualInManualRecalcPeriod(getPayments(), opts.period)) {
      try { console.log("[manual-recalc][autoaccrual]", { stage:"hasAccrualInManualRecalcPeriod.currentPayments", reason:"ACCRUALS_NOT_CREATED", error:null, result:false }); } catch(eManualRecalcAutoLog) {}
      return { ok:false, changed:false, reason:"ACCRUALS_NOT_CREATED", autoaccrual:result };
    }

    return { ok:true, changed:!!result.changed, reason:(responsibility.repaired ? "RESPONSIBILITY_REPAIRED_FROM_PAYMENTS" : (reason || "OK")), responsibility:responsibility, autoaccrual:result };
  }

  window.fullRecalcForCurrentAbonent = async function fullRecalcForCurrentAbonent(options){
    try { console.log("[manual-recalc] entering fullRecalcForCurrentAbonent"); } catch(eManualRecalcEnterLog) {}
    console.time("[recalc] total");
    if (window.__calcTotalsMemoStats) window.__calcTotalsMemoStats.reset();
    let recalcTotalTimerEnded = false;
    function endRecalcTotalTimer(){
      if (recalcTotalTimerEnded) return;
      recalcTotalTimerEnded = true;
      try { console.timeEnd("[recalc] total"); } catch(eTimer) {}
    }
    const opts = options && typeof options === "object" ? options : {};
    const id = String(getAbonentId() || "");
    const runId = fullRecalcRunIdFromOptions(opts);
    startReadinessWriteSequence(runId);
    const runningFullRecalc = currentFullRecalcRunState();
    if (runningFullRecalc && runningFullRecalc.paymentTableFullActive === true) {
      try {
        console.log("[full-recalc][duplicate-call-ignored]", {
          runId: runningFullRecalc.runId || runId,
          abonentId: id,
          source: "payment_table.fullRecalcForCurrentAbonent",
          reason: "same-tab-full-path-active"
        });
      } catch(eDupSameRunLog) {}
      endRecalcTotalTimer();
      finishReadinessWriteSequence();
      try { console.log("[manual-recalc][return] ALREADY_RUNNING"); } catch(eManualRecalcReturnLog) {}
      return { ok:false, reason:"RECALC_ALREADY_RUNNING", summary_status:"already_running", summary_reason:"RECALC_ALREADY_RUNNING", status:"already_running", duplicateIgnored:true, runId:runningFullRecalc.runId || runId };
    }
    if (runningFullRecalc && runningFullRecalc.abonentId && String(runningFullRecalc.abonentId) !== id) {
      try {
        console.log("[full-recalc][duplicate-call-ignored]", {
          runId: runningFullRecalc.runId || runId,
          abonentId: id,
          activeAbonentId: String(runningFullRecalc.abonentId || ""),
          source: "payment_table.fullRecalcForCurrentAbonent"
        });
      } catch(eDupLog) {}
      endRecalcTotalTimer();
      finishReadinessWriteSequence();
      try { console.log("[manual-recalc][return] ALREADY_RUNNING"); } catch(eManualRecalcReturnLog) {}
      return { ok:false, reason:"RECALC_ALREADY_RUNNING", summary_status:"already_running", summary_reason:"RECALC_ALREADY_RUNNING", status:"already_running", duplicateIgnored:true, runId:runningFullRecalc.runId || runId };
    }
    if (!id) {
      endRecalcTotalTimer();
      finishReadinessWriteSequence();
      try { console.log("[manual-recalc][return] ABONENT_REQUIRED"); } catch(eManualRecalcReturnLog) {}
      return { ok:false, reason:"ABONENT_REQUIRED" };
    }
    if (!await waitPaymentTableHydratedDatabase("FULL_SUMMARY_REBUILD")) {
      endRecalcTotalTimer();
      finishReadinessWriteSequence();
      try { console.log("[manual-recalc][return] DB_NOT_HYDRATED"); } catch(eManualRecalcReturnLog) {}
      return { ok:false, reason:"DB_NOT_HYDRATED", summary_status:"error", summary_reason:"DB_NOT_HYDRATED" };
    }
    await ensureGlobalRefinancingRatesHydrated("payment_table.fullRecalcForCurrentAbonent.before-sync-calc");
    logReadinessRegressionBeforeManualRecalc(
      "payment_table.fullRecalcForCurrentAbonent",
      "before_waitForManualRecalcDataReady"
    );
    finishReadinessWriteSequence();
    const dataReady = await waitForManualRecalcDataReady("payment_table.fullRecalcForCurrentAbonent.before-sync-calc");
    if (!dataReady || dataReady.ok !== true) {
      endRecalcTotalTimer();
      try { console.log("[manual-recalc][return] DATA_READY_TIMEOUT"); } catch(eManualRecalcReadyReturnLog) {}
      return { ok:false, reason:"DATA_READY_TIMEOUT", summary_status:"error", summary_reason:"DATA_READY_TIMEOUT", readiness:dataReady || null };
    }
    const mode = String(opts.recalcMode || opts.mode || "").trim().toUpperCase();
    const explicitReportPeriod = (mode === "REPORT_PERIOD_CALCULATION" || mode === "REPORT" || mode === "PERIOD" || String(opts.summaryScope || opts.summary_scope || "").toLowerCase() === "period")
      && opts.period && isManualRecalcPeriodValid(opts.period);
    const recalcMode = explicitReportPeriod ? "REPORT_PERIOD_CALCULATION" : "FULL_SUMMARY_REBUILD";
    const explicitRuntimePeriod = opts.runtimePeriod && isManualRecalcPeriodValid(opts.runtimePeriod)
      ? { from: String(opts.runtimePeriod.from || ""), to: String(opts.runtimePeriod.to || "") }
      : null;
    let recalcLock = null;
    if (runningFullRecalc) runningFullRecalc.paymentTableFullActive = true;
    try { console.log("[full-recalc][start]", { runId: runId, abonentId: id, recalcMode: "FULL_SUMMARY_REBUILD", requestedMode: mode || "" }); } catch(eFullStartLog) {}
    try { console.log("[payment-table][recalc-explicit]", { runId: runId, abonentId: id, stage: "start", recalcMode: recalcMode }); } catch(eLogStart) {}
    try {
      if (!window.Data || typeof Data.beginRecalcUidLock !== "function" || typeof Data.finishRecalcUidLock !== "function") {
        endRecalcTotalTimer();
        try { console.log("[manual-recalc][return] LOCK_UNAVAILABLE"); } catch(eManualRecalcReturnLog) {}
        return { ok:false, reason:"RECALC_LOCK_UNAVAILABLE", summary_status:"error", summary_reason:"RECALC_LOCK_UNAVAILABLE" };
      }
      logFullRecalcStep(runId, "begin-lock", { abonentId: id });
      console.time("[recalc-step] begin lock");
      recalcLock = await Data.beginRecalcUidLock(id, { runId: runId, abonentId: id });
      console.timeEnd("[recalc-step] begin lock");
      if (runningFullRecalc && recalcLock) {
        runningFullRecalc.uid = String(recalcLock.account_uid || runningFullRecalc.uid || "");
        runningFullRecalc.recalcLockToken = String(recalcLock.lock_token || "");
      }
      logFullRecalcStepDone(runId, "begin-lock", { abonentId: id, status: recalcLock && recalcLock.status || "" });
      if (recalcLock && recalcLock.status === "already_running") {
        try { console.log("[payment-table][recalc-explicit]", { runId: runId, abonentId: id, stage: "already_running", recalcMode: recalcMode }); } catch(eLogLock) {}
        try { console.log("[full-recalc][duplicate-call-ignored]", { runId: runId, abonentId: id, source: "recalc-lock", reason: "RECALC_ALREADY_RUNNING" }); } catch(eFullAlreadyLog) {}
        endRecalcTotalTimer();
        try { console.log("[manual-recalc][return] ALREADY_RUNNING"); } catch(eManualRecalcReturnLog) {}
        return { ok:false, reason:"RECALC_ALREADY_RUNNING", summary_status:"already_running", summary_reason:"RECALC_ALREADY_RUNNING", status:"already_running", recalc_lock:recalcLock };
      }
      if (!recalcLock || recalcLock.ok !== true || recalcLock.status !== "started") {
        try { console.log("[full-recalc][result]", { abonentId: id, ok: false, summaryStatus: "error", summaryReason: "RECALC_LOCK_FAILED" }); } catch(eFullLockFailedLog) {}
        endRecalcTotalTimer();
        try { console.log("[manual-recalc][return] LOCK_FAILED"); } catch(eManualRecalcReturnLog) {}
        return { ok:false, reason:(recalcLock && (recalcLock.reason || recalcLock.error)) || "RECALC_LOCK_FAILED", summary_status:"error", summary_reason:"RECALC_LOCK_FAILED", recalc_lock:recalcLock };
      }
      resetCalcTotalsHotspotReport(runId, id);
      throwIfFullRecalcAborted("autoaccrual");
      logFullRecalcStep(runId, "autoaccrual", { abonentId: id });
      console.time("[recalc-step] autoaccrual");
      const autoResult = await measureRecalcStage("autoaccrualMs", async function(){
        return await applyControlledAutoAccrualForManualRecalc(id, opts);
      });
      console.timeEnd("[recalc-step] autoaccrual");
      logFullRecalcStepDone(runId, "autoaccrual", { abonentId: id, ok: !!(autoResult && autoResult.ok === true), changed: !!(autoResult && autoResult.changed), reason: autoResult && autoResult.reason || "" });
      await nextUiTick();
      throwIfFullRecalcAborted("build-runtime-rows-before-summary");
      if (!autoResult || autoResult.ok !== true) {
        try { console.log("[payment-table][recalc-explicit]", { abonentId: id, stage: "autoaccrual_failed", reason: normalizeManualRecalcReason(autoResult && autoResult.reason) }); } catch(eLogAuto) {}
        try { console.log("[full-recalc][result]", { abonentId: id, ok: false, summaryStatus: "error", summaryReason: normalizeManualRecalcReason(autoResult && autoResult.reason), autoaccrualChanged: !!(autoResult && autoResult.changed) }); } catch(eFullAutoFailLog) {}
        endRecalcTotalTimer();
        try { console.log("[manual-recalc][autoaccrual]", { stage:"fullRecalcForCurrentAbonent.autoResult", reason:normalizeManualRecalcReason(autoResult && autoResult.reason), error:null, result:autoResult || null }); } catch(eManualRecalcAutoLog) {}
        try { console.log("[manual-recalc][return] AUTOACCRUAL_FAILED"); } catch(eManualRecalcReturnLog) {}
        return { ok:false, reason:normalizeManualRecalcReason(autoResult && autoResult.reason), autoaccrual:autoResult, autoaccrual_changed:!!(autoResult && autoResult.changed) };
      }
      const alreadyFresh = tryReuseFreshFullRecalcRuntimeCache(id, {
        runId: runId,
        recalcMode: recalcMode,
        periodActive: !!(explicitReportPeriod || explicitRuntimePeriod),
        selectedPeriod: explicitReportPeriod ? { from: String(opts.period.from || ""), to: String(opts.period.to || "") } : explicitRuntimePeriod,
        autoaccrualChanged: !!(autoResult && autoResult.changed)
      });
      if (alreadyFresh && alreadyFresh.ok === true) {
        try { console.log("[payment-table][recalc-explicit]", { runId: runId, abonentId: id, stage: "already_fresh", recalcMode: recalcMode }); } catch(eAlreadyFreshLog) {}
        try {
          console.log("[full-recalc][result]", {
            runId: runId,
            abonentId: id,
            ok: true,
            summaryStatus: "fresh",
            summaryReason: "ALREADY_FRESH",
            autoaccrualChanged: !!autoResult.changed,
            usedPath: alreadyFresh.usedPath || "runtime_cache_already_fresh"
          });
        } catch(eAlreadyFreshResultLog) {}
        endRecalcTotalTimer();
        try { console.log("[manual-recalc][return] ALREADY_FRESH"); } catch(eManualRecalcReturnLog) {}
        return {
          ok: true,
          reason: "ALREADY_FRESH",
          autoaccrual_changed: !!autoResult.changed,
          autoaccrual: autoResult,
          summary_status: "fresh",
          summary_reason: "OK",
          summary: alreadyFresh.summary,
          rowsById: alreadyFresh.rowsById,
          ledgerVersion: alreadyFresh.ledgerVersion,
          runtimeCacheHit: true,
          rowsByIdSource: alreadyFresh.usedPath || "runtime_cache_already_fresh",
          runId: runId
        };
      } else {
        try {
          console.log("[full-recalc][already-fresh-skip]", {
            runId: runId,
            abonentId: id,
            reason: alreadyFresh && alreadyFresh.reason || "NOT_AVAILABLE"
          });
        } catch(eAlreadyFreshSkipLog) {}
      }
      logFullRecalcStep(runId, "build-runtime-rows-before-summary", { abonentId: id });
      console.time("[recalc-step] build runtime rows before summary");
      let arr = [];
      let periodActive = false;
      let selectedPeriod = null;
      let runtimeRows = [];
      let baseRows = [];
      let ledgerVersion = "";
      let sig = "";
      let rowsById = {};
      let rowsCount = 0;
      let rowsByIdBuildResult = null;
      await measureRecalcStage("buildRuntimeRowsBeforeSummaryMs", async function(){
        incRecalcCallCount("buildRuntimeRows", 1);
        console.time("[recalc-detail] get ledger");
        arr = getPayments();
        console.timeEnd("[recalc-detail] get ledger");
        console.time("[recalc-detail] period selection");
        periodActive = !!(explicitReportPeriod || explicitRuntimePeriod);
        selectedPeriod = explicitReportPeriod ? { from: String(opts.period.from || ""), to: String(opts.period.to || "") } : explicitRuntimePeriod;
        console.timeEnd("[recalc-detail] period selection");
        console.time("[recalc-detail] build runtimeRows");
        if (periodActive && selectedPeriod) {
          console.time("[recalc-detail] applyCalcFilter row/month loop");
          const filteredRows = applyCalcFilter(arr, true, selectedPeriod);
          console.timeEnd("[recalc-detail] applyCalcFilter row/month loop");
          console.time("[recalc-detail] responsibility month/row loops");
          const responsibilityRows = applyResponsibilityRangeToView(filteredRows);
          console.timeEnd("[recalc-detail] responsibility month/row loops");
          console.time("[recalc-detail] clone/copy rows");
          runtimeRows = responsibilityRows.slice();
          console.timeEnd("[recalc-detail] clone/copy rows");
        } else {
          console.time("[recalc-detail] clone/copy rows");
          runtimeRows = arr;
          console.timeEnd("[recalc-detail] clone/copy rows");
        }
        console.timeEnd("[recalc-detail] build runtimeRows");
        console.time("[recalc-detail] build baseRows row/month loop");
        emitFullRecalcHeartbeat(runId, "build-runtime-rows-before-summary");
        baseRows = runningTotalsBaseRows(runtimeRows);
        emitFullRecalcHeartbeat(runId, "build-runtime-rows-before-summary");
        console.timeEnd("[recalc-detail] build baseRows row/month loop");
        console.time("[recalc-detail] build maps/indexes");
        ledgerVersion = (window.Data && Data.computeLedgerRuntimeVersion) ? String(Data.computeLedgerRuntimeVersion(id) || "") : "";
        console.time("[recalc-detail] ledgerSignature row loop");
        emitFullRecalcHeartbeat(runId, "build-runtime-rows-before-summary");
        sig = ledgerSignatureForRows(arr) + "::" + runtimeCacheSignature(ledgerVersion, periodActive, selectedPeriod);
        emitFullRecalcHeartbeat(runId, "build-runtime-rows-before-summary");
        console.timeEnd("[recalc-detail] ledgerSignature row loop");
        console.timeEnd("[recalc-detail] build maps/indexes");
        console.time("[recalc-detail] build rowsById row loop");
        console.time("[recalc-detail] rowsById row loop");
        rowsByIdBuildResult = await buildRowsByIdFastVerified(runtimeRows, selectedPeriod, id, {
          runId: runId,
          stage: "build-runtime-rows-before-summary",
          recalcMode: recalcMode,
          periodActive: periodActive,
          baseRows: baseRows,
          signature: sig,
          caller: "fullRecalc.buildRuntimeRowsBeforeSummary",
          slowCaller: "fullRecalc.buildRuntimeRowsBeforeSummary"
        });
        rowsById = rowsByIdBuildResult.rowsById || {};
        rowsCount = rowsByIdBuildResult.rowsCount || runtimeRows.length;
        console.timeEnd("[recalc-detail] rowsById row loop");
        console.timeEnd("[recalc-detail] build rowsById row loop");
      });
      console.timeEnd("[recalc-step] build runtime rows before summary");
      throwIfFullRecalcAborted("save-runtime-cache-before-summary");
      addRecalcLoopCount("rowsCount", rowsCount);
      addRecalcLoopCount("monthsCount", countRuntimeMonths(runtimeRows));
      addRecalcLoopCount("obligationsCount", countRuntimeObligations(baseRows));
      addRecalcLoopCount("paymentsCount", countRuntimePayments(baseRows));
      logFullRecalcStepDone(runId, "build-runtime-rows-before-summary", { abonentId: id, rowsCount: rowsCount, rowsByIdCount: Object.keys(rowsById).length });
      await nextUiTick();
      const payload = { ledgerVersion: ledgerVersion, runtimeSignature: runtimeCacheSignature(ledgerVersion, periodActive, selectedPeriod), periodActive: !!periodActive, period: periodActive && selectedPeriod ? { from: selectedPeriod.from || "", to: selectedPeriod.to || "" } : null, rowsById: rowsById, updatedAt: (new Date()).toISOString() };
      throwIfFullRecalcAborted("save-runtime-cache-before-summary");
      logFullRecalcStep(runId, "save-runtime-cache-before-summary", { abonentId: id });
      console.time("[recalc] save runtime cache");
      if (window.Data && typeof Data.writeLedgerRuntimeCache === "function") Data.writeLedgerRuntimeCache(id, payload);
      try {
        console.log("[full-recalc][save-snapshot]", {
          abonentId: id,
          target: "ledger_runtime_cache",
          ledgerVersion: ledgerVersion,
          rowsByIdCount: Object.keys(rowsById).length,
          periodActive: !!periodActive
        });
      } catch(eRuntimeSaveLog) {}
      console.timeEnd("[recalc] save runtime cache");
      logFullRecalcStepDone(runId, "save-runtime-cache-before-summary", { abonentId: id, rowsByIdCount: Object.keys(rowsById).length });
      await nextUiTick();
      try {
        console.log("[full-recalc][stage-skip]", {
          runId: runId,
          abonentId: id,
          stage: "table-render-before-summary",
          reason: "summary-save-first"
        });
      } catch(eSkipPreSummaryRenderLog) {}
      throwIfFullRecalcAborted("summary-save");
      if (!window.Data || typeof Data.recalculateAbonentCard !== "function") {
        endRecalcTotalTimer();
        try { console.log("[manual-recalc][return] SUMMARY_RECALC_UNAVAILABLE"); } catch(eManualRecalcReturnLog) {}
        return { ok:false, reason:"SUMMARY_RECALC_UNAVAILABLE", autoaccrual_changed:!!autoResult.changed, summary_status:"error", summary_reason:"SUMMARY_RECALC_UNAVAILABLE", summary:null, summary_save:{ ok:false, reason:"SUMMARY_RECALC_UNAVAILABLE" } };
      }
      logFullRecalcStep(runId, "summary-save", { abonentId: id });
      console.time("[recalc] Data.recalculateAbonentCard");
      try { console.log("[manual-recalc] calling Data.recalculateAbonentCard"); } catch(eManualRecalcCallDataLog) {}
      const summaryResult = await measureRecalcStage("summarySaveMs", async function(){
        throwIfFullRecalcAborted("summary-save");
        const financialVersions = (window.Data && typeof Data.computeFinancialInputVersions === "function") ? Data.computeFinancialInputVersions(id) : {};
        return await Data.recalculateAbonentCard(id, {
          period: periodActive && selectedPeriod ? selectedPeriod : undefined,
          saveSummary: !explicitReportPeriod,
          summaryScope: explicitReportPeriod ? "period" : "full",
          periodActive: !!explicitReportPeriod,
          recalcMode: recalcMode,
          finalRows: runtimeRows,
          uid: String((typeof window.getAbonentTechId === "function" && window.getAbonentTechId(id)) || ""),
          ledgerVersion: ledgerVersion,
          inputHash: String(financialVersions && financialVersions.input_hash || ""),
          recalcRunId: runId,
          recalcLockHeld: true,
          recalcLockToken: recalcLock.lock_token || ""
        });
      });
      console.timeEnd("[recalc] Data.recalculateAbonentCard");
      logFullRecalcStepDone(runId, "summary-save", { abonentId: id, ok: !!(summaryResult && summaryResult.ok === true), status: summaryResult && (summaryResult.summary_status || summaryResult.status) || "", reason: summaryResult && (summaryResult.summary_reason || summaryResult.reason) || "" });
      await nextUiTick();
      throwIfFullRecalcAborted("build-fresh-runtime-rows-after-summary");
      logFullRecalcStep(runId, "build-fresh-runtime-rows-after-summary", { abonentId: id });
      console.time("[recalc-step] build fresh runtime rows after summary");
      const freshPeriodActive = periodActive;
      const freshSelectedPeriod = selectedPeriod;
      let freshRuntimeRows = runtimeRows;
      let freshBaseRows = baseRows;
      let freshLedgerVersion = ledgerVersion;
      let freshSig = sig;
      let freshRowsById = rowsById;
      await measureRecalcStage("buildRuntimeRowsAfterSummaryMs", async function(){
        emitFullRecalcHeartbeat(runId, "build-fresh-runtime-rows-after-summary");
        try {
          console.log("[full-recalc][stage-reuse]", {
            runId: runId,
            abonentId: id,
            stage: "build-fresh-runtime-rows-after-summary",
            reason: "summary-save-does-not-change-ledger",
            rowsByIdCount: Object.keys(freshRowsById || {}).length
          });
        } catch(eReuseRowsLog) {}
      });
      console.timeEnd("[recalc-step] build fresh runtime rows after summary");
      throwIfFullRecalcAborted("save-runtime-cache-after-summary");
      addRecalcLoopCount("rowsCount", Array.isArray(freshRuntimeRows) ? freshRuntimeRows.length : 0);
      addRecalcLoopCount("monthsCount", countRuntimeMonths(freshRuntimeRows));
      addRecalcLoopCount("obligationsCount", countRuntimeObligations(freshBaseRows));
      addRecalcLoopCount("paymentsCount", countRuntimePayments(freshBaseRows));
      logFullRecalcStepDone(runId, "build-fresh-runtime-rows-after-summary", { abonentId: id, rowsByIdCount: Object.keys(freshRowsById).length });
      await nextUiTick();
      const freshPayload = { ledgerVersion: freshLedgerVersion, runtimeSignature: runtimeCacheSignature(freshLedgerVersion, freshPeriodActive, freshSelectedPeriod), periodActive: !!freshPeriodActive, period: freshPeriodActive && freshSelectedPeriod ? { from: freshSelectedPeriod.from || "", to: freshSelectedPeriod.to || "" } : null, rowsById: freshRowsById, updatedAt: (new Date()).toISOString() };
      throwIfFullRecalcAborted("snapshot-save");
      setPaymentTableCalculatedRenderState(freshRuntimeRows, freshRowsById, freshPayload);
      capturePaymentTableComputedRowsSnapshot(freshRuntimeRows, freshRowsById, freshPeriodActive, freshSelectedPeriod, freshPayload.runtimeSignature, freshLedgerVersion);
      logFullRecalcStep(runId, "save-runtime-cache-after-summary", { abonentId: id });
      console.time("[recalc] save runtime cache");
      if (window.Data && typeof Data.writeLedgerRuntimeCache === "function") Data.writeLedgerRuntimeCache(id, freshPayload);
      try {
        console.log("[full-recalc][save-snapshot]", {
          abonentId: id,
          target: "ledger_runtime_cache_after_summary",
          ledgerVersion: freshLedgerVersion,
          rowsByIdCount: Object.keys(freshRowsById).length,
          periodActive: !!freshPeriodActive
        });
      } catch(eFreshRuntimeSaveLog) {}
      console.timeEnd("[recalc] save runtime cache");
      logFullRecalcStepDone(runId, "save-runtime-cache-after-summary", { abonentId: id, rowsByIdCount: Object.keys(freshRowsById).length });
      await nextUiTick();
      if (Object.keys(freshRowsById).length) {
        throwIfFullRecalcAborted("table-render-after-summary");
        __paymentTableRenderedSignature = "";
        __paymentTableMode = "readonly_no_recalc";
        logFullRecalcStep(runId, "table-render-after-summary", { abonentId: id, reason: "fresh_runtime_cache_after_summary" });
        console.time("[recalc-step] loadPaymentTable after summary");
        await loadPaymentTable("full_recalc_completed");
        console.timeEnd("[recalc-step] loadPaymentTable after summary");
        logFullRecalcStepDone(runId, "table-render-after-summary", { abonentId: id, rowsByIdCount: Object.keys(freshRowsById).length });
        await nextUiTick();
      }
      const summary = summaryResult && summaryResult.summary && typeof summaryResult.summary === "object" ? summaryResult.summary : null;
      try {
        console.log("[full-recalc][save-summary]", {
          abonentId: id,
          ok: !!(summaryResult && summaryResult.ok === true),
          summaryStatus: summaryResult && (summaryResult.summary_status || summaryResult.status) || "error",
          summaryReason: summaryResult && (summaryResult.summary_reason || summaryResult.reason) || ""
        });
      } catch(eSaveSummaryLog) {}
      try { console.log("[payment-table][recalc-explicit]", { runId: runId, abonentId: id, stage: "done", recalcMode: recalcMode, ok: !!(summaryResult && summaryResult.ok === true), summary_status: summaryResult && (summaryResult.summary_status || summaryResult.status) || "error" }); } catch(eLogDone) {}
      try {
        console.log("[full-recalc][result]", {
          runId: runId,
          abonentId: id,
          ok: !!(summaryResult && summaryResult.ok === true),
          summaryStatus: summaryResult && (summaryResult.summary_status || summaryResult.status) || "error",
          summaryReason: summaryResult && (summaryResult.summary_reason || summaryResult.reason) || "",
          autoaccrualChanged: !!autoResult.changed
        });
      } catch(eFullResultLog) {}
      try {
        const memoStats = window.__calcTotalsMemoStats || {};
        const calcCalls = Number(memoStats.calcCalls) || 0;
        const calcTotalMs = Number(memoStats.calcTotalMs) || 0;
        console.log("[calcTotalsAsOfMemoized][summary]", {
          totalCalls: Number(memoStats.totalCalls) || 0,
          memoHits: Number(memoStats.memoHits) || 0,
          memoMisses: Number(memoStats.memoMisses) || 0,
          calcCalls: calcCalls,
          calcTotalMs: Math.round(calcTotalMs),
          calcAvgMs: calcCalls ? Math.round((calcTotalMs / calcCalls) * 100) / 100 : 0,
          calcMaxMs: Math.round(Number(memoStats.calcMaxMs) || 0)
        });
      } catch(eMemoSummary) {}
      endRecalcTotalTimer();
      try { console.log("[manual-recalc][return] SUCCESS"); } catch(eManualRecalcReturnLog) {}
      return {
        ok:!!(summaryResult && summaryResult.ok === true),
        reason: summaryResult && (summaryResult.summary_reason || summaryResult.reason) || "",
        autoaccrual_changed:!!autoResult.changed,
        autoaccrual:autoResult,
        summary_status: summaryResult && (summaryResult.summary_status || summaryResult.status) || "error",
        summary_reason: summaryResult && (summaryResult.summary_reason || summaryResult.reason) || "",
        summary: summary,
        summary_save: summaryResult,
        finalRows: freshRuntimeRows,
        rowsById: freshRowsById,
        ledgerVersion: freshLedgerVersion,
        inputHash: String(summaryResult && summaryResult.inputHash || summary && summary.input_hash || ""),
        runId: runId
      };
    } catch(eFullRecalcAbort) {
      if (eFullRecalcAbort && eFullRecalcAbort.fullRecalcAbort === true) {
        endRecalcTotalTimer();
        try { console.log("[manual-recalc][return] ABORTED"); } catch(eManualRecalcReturnLog) {}
        return fullRecalcAbortResult(eFullRecalcAbort, runId, id);
      }
      throw eFullRecalcAbort;
    } finally {
      if (runningFullRecalc && runningFullRecalc.runId === runId) runningFullRecalc.paymentTableFullActive = false;
      printCalcTotalsHotspotReport();
      if (recalcLock && recalcLock.status === "started" && window.Data && typeof Data.finishRecalcUidLock === "function") {
        logFullRecalcStep(runId, "finish-lock", { abonentId: id });
        console.time("[recalc-step] finish lock");
        try {
          await Data.finishRecalcUidLock(recalcLock.account_uid || id, recalcLock.lock_token || "", { runId: runId, abonentId: id, reason: "payment-table-finally" });
        } finally {
          try { console.log("[recalc-lock][release-finally]", { runId: runId, uid: String(recalcLock.account_uid || id || ""), status: recalcLock.status || "" }); } catch(eReleaseFinallyLog) {}
          console.timeEnd("[recalc-step] finish lock");
          logFullRecalcStepDone(runId, "finish-lock", { abonentId: id });
        }
      }
      endRecalcTotalTimer();
    }
  };

  window.__loadPaymentTable = requestLoadPaymentTable;

  window.addPaymentRow = async function addPaymentRow() {
    const arr = getPayments();
    const drafts = getPaymentDraftRows();
    const allKnownRows = arr.concat(drafts);
    const nextId = allKnownRows.length ? Math.max(...allKnownRows.map(x => Number(x.id) || 0)) + 1 : 1;

    const d = new Date();
    const defM = pad2(d.getMonth() + 1);
    const defY = String(d.getFullYear());

    const row = {
      id: nextId,
      month: defM,
      year: defY,

      accrued: 0,
      paid: 0,
      paid_date: "",
      source: (ensurePaymentSources()[0] || ''),

      use_period: false,
      period_from_m: defM,
      period_from_y: defY,
      period_to_m: defM,
      period_to_y: defY,

      period_from: `${defM}.${defY}`,
      period_to: `${defM}.${defY}`,

      note: "",
      pay_main: 0,
      pay_penalty: 0,
      total_debt: 0,
      __draft: true,
      __draftStatus: "local"
    };

    drafts.push(row);
    setPaymentDraftRows(drafts);

    // ✅ Итог карточки (Всего задолженность = Долг + Пени)
    JKH_RecalcAbonentTotalDebtCard();
    // ✅ Заголовки колонок
    JKH_RenameDebtPenaltyHeaders();
    setLastAddedPaymentId(nextId);
    loadPaymentTable("add-payment-draft");
  };

  document.addEventListener("DOMContentLoaded", async () => {
    JKH_RenameDebtPenaltyHeaders();
// ✅ важно: повесить обработчик сворачивания месяцев сразу, не дожидаясь редактирования полей
    try { console.log("[payment-table][readonly-no-recalc]", { reason: "DOMContentLoaded-skip-runtime-refresh" }); } catch(e) {}
  });
// =========================
  // Модалка «Справочник источников»
  // (вёрстка модалки лежит в abonent_card.html; если её нет — функции просто ничего не делают)
  // =========================
  function renderSourcesModalList(){
    const modal = document.getElementById('sourcesModal');
    if (!modal) return;
    const list = modal.querySelector('#sourcesList');
    if (!list) return;

    const sources = ensurePaymentSources();
    list.innerHTML = '';

    sources.forEach((name, idx) => {
      const row = document.createElement('div');
      row.className = 'src-row';
      row.style.display = 'flex';
      row.style.gap = '8px';
      row.style.alignItems = 'center';
      row.style.margin = '6px 0';

      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = String(name||'');
      inp.style.flex = '1';

      const btnSave = document.createElement('button');
      btnSave.textContent = 'Сохранить';

      const btnDel = document.createElement('button');
      btnDel.textContent = 'Удалить';

      btnSave.onclick = async () => {
        const v = String(inp.value||'').trim();
        if (!v) return alert('Название не может быть пустым');
        const arr = ensurePaymentSources();
        const oldName = String(arr[idx]||'').trim();
        arr[idx] = v;
        const uniq=[];
        for (const s of arr){
          const ss=String(s||'').trim();
          if (!ss) continue;
          if (!uniq.includes(ss)) uniq.push(ss);
        }
        savePaymentSources(uniq);

        // синхронизируем платежи текущего абонента
        try {
          if (oldName && oldName !== v && typeof getPayments === 'function' && typeof savePaymentsAndFlush === 'function') {
            const pays = getPayments() || [];
            let ch = false;
            for (const p of pays) {
              if (String(p?.source || '').trim() === oldName) { p.source = v; ch = true; }
            }
            if (ch) await savePaymentsAndFlush(pays);
          }
        } catch(e) { console.error(e); throw e; }

        renderSourcesModalList();
        reloadPaymentTableReadonlyNoRecalc("payment-source-modal-no-recalc");
      };

      btnDel.onclick = async () => {
        const sourcesNow = ensurePaymentSources();
        const oldName = String(sourcesNow[idx]||'').trim();
        if (!oldName) return;

        const payments = (typeof getPayments === 'function') ? (getPayments() || []) : [];
        const usedCount = payments.filter(p => String(p?.source||'').trim() === oldName).length;

        // Мягкое удаление: если используется — предложить замену и переназначить
        if (usedCount > 0){
          const others = sourcesNow.filter((_,i)=>i!==idx).map(x=>String(x||'').trim()).filter(Boolean);
          if (!others.length){
            alert('Нельзя удалить этот источник: он используется и он последний в справочнике.');
            return;
          }

          const tip = others.map(s=>`- ${s}`).join('\n');
          const repRaw = prompt(
            `Источник «${oldName}» используется в платежах: ${usedCount}.\n` +
            `Выбери/введи источник-замену (можно вписать новый):\n${tip}\n\n` +
            `Заменить на:`,
            others[0]
          );
          const rep = String(repRaw||'').trim();
          if (!rep) return;

          if (!sourcesNow.includes(rep)) sourcesNow.push(rep);

          let changed = false;
          for (const p of payments){
            if (String(p?.source||'').trim() === oldName){
              p.source = rep;
              changed = true;
            }
          }
          if (changed && typeof savePaymentsAndFlush === 'function') await savePaymentsAndFlush(payments);

          const next = sourcesNow.filter((_,i)=>i!==idx);
          if (!next.length){
            alert('Нельзя удалить все источники. Останется минимум один.');
            return;
          }
          savePaymentSources(next);

          renderSourcesModalList();
          reloadPaymentTableReadonlyNoRecalc("payment-source-modal-no-recalc");
          return;
        }

        // Не используется — обычное удаление
        if (!confirm('Удалить источник?')) return;
        const next = sourcesNow.filter((_,i)=>i!==idx);
        if (!next.length){
          alert('Нельзя удалить все источники. Останется минимум один.');
          return;
        }
        savePaymentSources(next);
        renderSourcesModalList();
        reloadPaymentTableReadonlyNoRecalc("payment-source-modal-no-recalc");
      };

      row.appendChild(inp);
      row.appendChild(btnSave);
      row.appendChild(btnDel);
      list.appendChild(row);
    });
  }

  window.openPaymentSourcesModal = function(){
    const modal = document.getElementById('sourcesModal');
    if (!modal) return;
    renderSourcesModalList();
    modal.style.display = 'flex';
  };

  window.closePaymentSourcesModal = function(){
    const modal = document.getElementById('sourcesModal');
    if (!modal) return;
    modal.style.display = 'none';
  };

  window.addPaymentSourceFromModal = async function(){
    const modal = document.getElementById('sourcesModal');
    if (!modal) return;
    const inp = modal.querySelector('#sourceNewInput');
    const v = String(inp?.value||'').trim();
    if (!v) return;
    const cur = ensurePaymentSources();
    if (!cur.includes(v)) {
      cur.push(v);
      savePaymentSources(cur);
    }
    if (inp) inp.value = '';
    renderSourcesModalList();
    reloadPaymentTableReadonlyNoRecalc("payment-source-modal-no-recalc");
  };


(function initPaymentTableServerFirst(){
  let started = false;

  function tryStart(){
    if (started) {
      try { console.log("[payment-table][init-skipped-inflight]", { reason: "already-started" }); } catch(e) {}
      return;
    }

    if (isDataReady()) {
      started = true;
      try { window.removeEventListener("JKH_UI_STATE_CHANGED", tryStart); } catch(e) {}
      requestLoadPaymentTable('data-ready');
    }
  }

  tryStart();
  if (!started) window.addEventListener("JKH_UI_STATE_CHANGED", tryStart);
})();


})();
