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
  function isDataReady(){
  try {
    return window.JKH_UI_STATE?.data?.status === "ready";
  } catch {
    return false;
  }
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
      const t = calcTotalsAsOfMemoized(calcRows, asOf, sig);
      out[String(r.id)] = { pay_main: t.principal, pay_penalty: t.penalty, total: t.total };
    });
    return out;
  }

  function applyRuntimeRowsById(rows, rowsById){
    const map = rowsById && typeof rowsById === "object" ? rowsById : {};
    (Array.isArray(rows) ? rows : []).forEach(function(r){
      const item = map[String(r.id)] || null;
      if (!item) return;
      r.pay_main = item.pay_main;
      r.pay_penalty = item.pay_penalty;
      r.total = item.total;
    });
  }

  let __paymentTableComputedRowsSnapshot = null;

  function clonePaymentRowsForSnapshot(rows, rowsById){
    const map = rowsById && typeof rowsById === "object" && !Array.isArray(rowsById) ? rowsById : {};
    return (Array.isArray(rows) ? rows : []).map(function(row){
      const copy = Object.assign({}, row || {});
      const item = map[String(copy.id || "")] || null;
      if (item && typeof item === "object") {
        copy.pay_main = item.pay_main;
        copy.pay_penalty = item.pay_penalty;
        copy.total = item.total;
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
      const pm = Number(item.pay_main);
      const pp = Number(item.pay_penalty);
      const total = Number(item.total);
      if (!Number.isFinite(pm) || !Number.isFinite(pp) || !Number.isFinite(total)) return;
      out[id] = { pay_main: pm, pay_penalty: pp, total: total };
    });
    return out;
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
      const snapshotState = tryApplyCardSnapshotToRows(rows, version, periodActive, selectedPeriod, expectedSignature);
      if (snapshotState.valid) return snapshotState;
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
      const snapshotState = tryApplyCardSnapshotToRows(rows, version, periodActive, selectedPeriod, expectedSignature);
      if (snapshotState.valid) return snapshotState;
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
      const snapshotState = tryApplyCardSnapshotToRows(rows, version, periodActive, selectedPeriod, expectedSignature);
      if (snapshotState.valid) return snapshotState;
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
      rowsByIdCount: s.dataById && typeof s.dataById === "object" ? Object.keys(s.dataById).length : 0
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
      return cloneLedgerRows(window.Data.readPaymentLedger(serviceAbonentId));
    }

    const cacheKey = currentOwnerIdForPaymentCache() + '::' + String(key || '');
    const raw = storeGetRaw(key);
    if (raw === null || raw === undefined) return [];

    const cached = __ledgerReadCache.get(cacheKey);
    if (cached && cached.raw === raw && Array.isArray(cached.rows)) {
      return cloneLedgerRows(cached.rows);
    }

    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        __ledgerReadCache.set(cacheKey, { raw: raw, rows: arr });
        return cloneLedgerRows(arr);
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

  function throwRatesFatal(code, key, details){
    const err = makeRatesFatalError(code, key, details);
    logRatesFatal(err);
    throw err;
  }

  function renderRatesFatal(tbody){
    try { alert(RATES_FATAL_MESSAGE); } catch (_) {}
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="20" style="color:#b00020;font-weight:700;">' + RATES_FATAL_MESSAGE + '</td></tr>';
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
    const ownerId = (window.JKHStore && typeof JKHStore.getOwnerId === 'function') ? String(JKHStore.getOwnerId() || '').trim() : '';
    if (!ownerId || ownerId === 'guest' || ownerId === 'ALL') {
      throw new Error('PAYMENT_SOURCES_UPLOAD_FORBIDDEN_OWNER');
    }
    const payload = {
      owner: ownerId,
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
      if (savedLedger === false) throw new Error("PAYMENT_LEDGER_WRITE_BLOCKED");
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
    let left = p.amount;

    while (left > 0.0000001 && oi < obligations.length){
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
  const asOfDay = startOfDay(asOf);
  if (asOfDay <= ob.dueDate) return 0;

  sortApplications(ob);

  let penalty = 0;
  let overdueIndex = 0;

  // начинаем считать дни просрочки с дня, следующего за dueDate
  let day = addDays(ob.dueDate, 1);

  const hardLimit = addDays(ob.dueDate, 3650);
  const end = (asOfDay < hardLimit) ? asOfDay : hardLimit;

  while (day <= end){
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

  for (const ob of obligations){
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
  for (const r of arr){
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

function calcTotalsAsOfMemoized(rows, asOfDate, ledgerSignature){
  const key = memoKeyForTotals(ledgerSignature, asOfDate);
  const cached = __paymentTotalsMemo.get(key);
  if (cached) return cached;
  const t = calcTotalsAsOf(rows, asOfDate);
  const out = { principal: t.principal, penalty: t.penalty, total: t.total };
  __paymentTotalsMemo.set(key, out);
  if (__paymentTotalsMemo.size > 2000) {
    try { __paymentTotalsMemo.clear(); } catch(e) {}
  }
  return out;
}

function runningTotalsBaseRows(allRows){
  console.time("[baseRows] full");
  let baseRows = Array.isArray(allRows) ? allRows : [];
  console.time("[baseRows] isCalcPeriodActive");
  const periodActive = isCalcPeriodActive();
  console.timeEnd("[baseRows] isCalcPeriodActive");
  if (periodActive) {
    console.time("[baseRows] getCalcPeriod");
    const p = getCalcPeriod();
    console.timeEnd("[baseRows] getCalcPeriod");
    console.time("[baseRows] parse period bounds");
    const fromD = p ? parseDateAnyToDate(p.from) : null;
    const toD   = p ? parseDateAnyToDate(p.to)   : null;
    console.timeEnd("[baseRows] parse period bounds");

    if (fromD && toD) {
      console.time("[baseRows] build month bounds");
      const fromKey = (fromD.getFullYear() * 12) + (fromD.getMonth() + 1);
      const toKey   = (toD.getFullYear()   * 12) + (toD.getMonth() + 1);
      console.timeEnd("[baseRows] build month bounds");

      console.time("[baseRows] filter row loop");
      baseRows = baseRows.filter(r => {
        console.time("[baseRows] row parse year/month");
        let y = parseInt(r?.year, 10);
        let m = parseInt(r?.month, 10);
        console.timeEnd("[baseRows] row parse year/month");
        if (!(Number.isFinite(y) && Number.isFinite(m) && y > 0 && m >= 1 && m <= 12)) {
          console.time("[baseRows] paid_date fallback parse");
          const d = parseDateAnyToDate(r?.paid_date);
          console.timeEnd("[baseRows] paid_date fallback parse");
          if (d) { y = d.getFullYear(); m = d.getMonth() + 1; }
        }
        if (!(Number.isFinite(y) && Number.isFinite(m) && y > 0 && m >= 1 && m <= 12)) return false;
        console.time("[baseRows] row month key/check");
        const key = (y * 12) + m;
        const keep = key >= fromKey && key <= toKey;
        console.timeEnd("[baseRows] row month key/check");
        return keep;
      });
      console.timeEnd("[baseRows] filter row loop");
    }
  }
  console.timeEnd("[baseRows] full");
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
    const t = calcTotalsAsOfMemoized(baseRows, asOf, sig);
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
        const t = calcTotalsAsOfMemoized(calcRows, asOf, ledgerSignature);
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

  function updateComputedCells(tr, rowObj){
  const ro = qsa("td.ro", tr);
  if (ro.length >= 3){
    const pm = toNum(rowObj.pay_main ?? 0);
    const pp = toNum(rowObj.pay_penalty ?? 0);

    ro[0].textContent = (isReadonlyNoRecalcMode() && !__runtimeCacheState.valid && !rowObj.pay_main && rowObj.pay_main !== 0) ? "—" : fmtMoney(pm);
    ro[0].style.color = (pm < -0.0000001) ? "#8B0000" : "";
    ro[0].style.fontWeight = (pm < -0.0000001) ? "700" : "";

    if (isReadonlyNoRecalcMode() && !__runtimeCacheState.valid && !rowObj.pay_penalty && rowObj.pay_penalty !== 0) ro[1].textContent = "—";
    else ro[1].textContent = (toNum(rowObj.paid ?? 0) > 0.0000001) ? "" : fmtMoney(pp);

    // ✅ CRITICAL: "Всего" в таблице = Долг + Пени (derived field, не хранится отдельно)
    const total = pm + pp;
    ro[2].textContent = (isReadonlyNoRecalcMode() && !__runtimeCacheState.valid && !rowObj.total && rowObj.total !== 0) ? "—" : fmtMoney(total);
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

  async function loadPaymentTableImpl() {
    const totalStartedAt = perfNow();
    try { console.time('[payment-table] init-total'); } catch(e) {}
    try {
      if (!isDataReady()) {
        try { console.warn('[payment-table] load skipped: DATA_NOT_READY'); } catch(e) {}
        return;
      }
      const keyForReadiness = paymentsKey();
      if (!keyForReadiness) {
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
      let normalSnapshotState = { valid: false, reason: "NOT_ATTEMPTED" };
      if (!isReadonlyNoRecalcMode()) {
        try {
          console.log("[card-snapshot][normal-load-restore-attempt]", {
            abonentId: String(getAbonentId() || ""),
            periodActive: !!periodActive,
            selectedPeriod: selectedPeriod || null,
            ledgerVersion: runtimeLedgerVersion,
            runtimeSignature: runtimeCacheSignature(runtimeLedgerVersion, periodActive, selectedPeriod)
          });
        } catch(eSnapshotAttemptLog) {}
        normalSnapshotState = tryApplyCardSnapshotToRows(view, runtimeLedgerVersion, periodActive, selectedPeriod, runtimeCacheSignature(runtimeLedgerVersion, periodActive, selectedPeriod));
        if (normalSnapshotState && normalSnapshotState.valid === true) {
          __runtimeCacheState = normalSnapshotState;
          runtimeCacheUsed = true;
          runtimeCachePeriodMatches = true;
          baseRowsSource = "card_snapshot";
          restoredFromCardSnapshot = true;
          skipRunningTotalsUpdate = true;
          capturePaymentTableComputedRowsSnapshot(
            view,
            normalSnapshotState.dataById || {},
            periodActive,
            selectedPeriod,
            runtimeCacheSignature(runtimeLedgerVersion, periodActive, selectedPeriod),
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
        }
      }
      if (!restoredFromCardSnapshot && periodActive && selectedPeriod && !isReadonlyNoRecalcMode()) {
        runtimeCachePeriodMatches = inspectRuntimeCachePeriodMatch(true, selectedPeriod);
        const periodRowsById = runtimeRowsByIdFromRows(view, baseRows, effectiveSignature);
        applyRuntimeRowsById(view, periodRowsById);
        __runtimeCacheState = { valid: true, reason: "", dataById: periodRowsById, periodMatches: runtimeCachePeriodMatches, builtForPeriod: true };
      } else if (!restoredFromCardSnapshot) {
        __runtimeCacheState = applyRuntimeCacheToRows(view, periodActive, selectedPeriod);
        runtimeCacheUsed = !!__runtimeCacheState.valid;
        runtimeCachePeriodMatches = !!__runtimeCacheState.periodMatches;
        baseRowsSource = runtimeCacheUsed ? "runtime_cache" : "stale_no_recalc";
      }
      if (__runtimeCacheState && __runtimeCacheState.valid === true) {
        capturePaymentTableComputedRowsSnapshot(
          view,
          __runtimeCacheState.dataById || {},
          periodActive,
          selectedPeriod,
          runtimeCacheSignature(runtimeLedgerVersion, periodActive, selectedPeriod),
          runtimeLedgerVersion
        );
      }
      if (!restoredFromCardSnapshot) notifyRuntimeCacheSummaryState(__runtimeCacheState, periodActive, selectedPeriod);
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
  function requestLoadPaymentTable(options){
    const opts = (options && typeof options === "object") ? options : { reason: options };
    if (opts.mode) __paymentTableMode = String(opts.mode);
    if (opts.force) __paymentTableRenderedSignature = "";
    const reason = String(opts.reason || opts.mode || "scheduled");
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
    setTimeout(function(){
      __paymentTableLoadScheduled = false;
      try { loadPaymentTable(reason || 'scheduled'); } catch(e) { console.error(e); throw e; }
    }, 0);
  }

  async function loadPaymentTable(reason) {
    if (__paymentTableLoadRunning) {
      try { console.log("[payment-table][init-skipped-inflight]", { reason: String(reason || ""), phase: "running" }); } catch(e) {}
      return;
    }
    __paymentTableLoadRunning = true;
    try {
      console.log("[payment-table][init-start]", { reason: String(reason || "") });
      await loadPaymentTableImpl();
      console.log("[payment-table][init-done]", { reason: String(reason || "") });
    } finally {
      __paymentTableLoadRunning = false;
    }
  }


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

      <td class="ro" style="${toNum(r.pay_main ?? 0) < -0.0000001 ? 'color:#8B0000; font-weight:700;' : ''}">${(isReadonlyNoRecalcMode() && !__runtimeCacheState.valid && (r.pay_main === undefined || r.pay_main === null || r.pay_main === "")) ? "—" : fmtMoney(r.pay_main ?? 0)}</td>
      <td class="ro">${(isReadonlyNoRecalcMode() && !__runtimeCacheState.valid && (r.pay_penalty === undefined || r.pay_penalty === null || r.pay_penalty === "")) ? "—" : ((toNum(r.paid ?? 0) > 0.0000001) ? "" : fmtMoney(r.pay_penalty ?? 0))}</td>
      <td class="ro">${(isReadonlyNoRecalcMode() && !__runtimeCacheState.valid && (r.total === undefined || r.total === null || r.total === "")) ? "—" : fmtMoney(toNum(r.pay_main ?? 0) + toNum(r.pay_penalty ?? 0))}</td>

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
      if (!tariffs.length) return true;
      return Number(dbg && dbg.totalAccrued) <= 0 && Number(dbg && dbg.perM2Part) <= 0 && Number(dbg && dbg.fixedPart) <= 0;
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

  async function applyControlledAutoAccrualForManualRecalc(abonentId, options){
    const opts = options || {};
    if (opts.applyAutoAccrual !== true) return { ok:true, changed:false, reason:"SKIPPED" };
    if (!window.JKHAutoAccrual || typeof window.JKHAutoAccrual.dryRunForAbonent !== "function") {
      return { ok:false, changed:false, reason:"AUTOACCRUAL_UNAVAILABLE" };
    }
    const responsibility = validateResponsibilityRangeForManualRecalc(abonentId, opts);
    if (!responsibility || responsibility.ok !== true) {
      return {
        ok:false,
        changed:false,
        reason:normalizeManualRecalcReason(responsibility && responsibility.reason || "RESPONSIBILITY_PERIOD_MISSING"),
        responsibility:responsibility || null,
        suggestion:responsibility && responsibility.suggestion || null
      };
    }
    if (detectManualRecalcTariffsMissing(abonentId, opts.period)) {
      return { ok:false, changed:false, reason:"TARIFFS_NOT_FOUND", responsibility:responsibility };
    }

    let result = null;
    try {
      result = window.JKHAutoAccrual.dryRunForAbonent(abonentId);
    } catch (e) {
      const reason = normalizeManualRecalcReason(e && (e.code || e.reason || e.message) || e);
      return { ok:false, changed:false, reason:reason, responsibility:responsibility };
    }

    const reason = normalizeManualRecalcReason(result && result.reason);
    if (!result || result.ok !== true) {
      return { ok:false, changed:false, reason:reason, responsibility:responsibility };
    }
    if (reason === "RESPONSIBILITY_PERIOD_MISSING" || reason === "TARIFFS_NOT_FOUND" || reason === "LEDGER_JSON_INVALID") {
      return { ok:false, changed:false, reason:reason, responsibility:responsibility };
    }

    if (result.changed === true) {
      const proposedRows = Array.isArray(result.proposedRows) ? result.proposedRows : null;
      if (!proposedRows) return { ok:false, changed:true, reason:"AUTOACCRUAL_ROWS_MISSING", autoaccrual:result };
      if (!hasAccrualInManualRecalcPeriod(proposedRows, opts.period)) return { ok:false, changed:true, reason:"ACCRUALS_NOT_CREATED", autoaccrual:result };
      if (!(window.Data && typeof Data.writePaymentLedger === "function")) return { ok:false, changed:true, reason:"LEDGER_WRITE_UNAVAILABLE", autoaccrual:result };
      const savedLedger = window.Data.writePaymentLedger(abonentId, proposedRows, { eventType:"AUTOACCRUAL_WRITE", summaryDirtyReason:false });
      if (savedLedger === false) return { ok:false, changed:true, reason:"PAYMENT_LEDGER_WRITE_BLOCKED", autoaccrual:result };
      clearPaymentLedgerReadCache("manual-recalc-autoaccrual");
      try {
        if (window.Data && typeof Data.invalidateLedgerRuntimeCache === "function") Data.invalidateLedgerRuntimeCache(abonentId);
      } catch (e0) {}
      if (window.Data && typeof Data.flushDbToServer === "function") {
        await Data.flushDbToServer();
      } else {
        return { ok:false, changed:true, reason:"SERVER_FLUSH_UNAVAILABLE", autoaccrual:result };
      }
    }

    if (result.changed !== true && !hasAccrualInManualRecalcPeriod(getPayments(), opts.period)) {
      return { ok:false, changed:false, reason:"ACCRUALS_NOT_CREATED", autoaccrual:result };
    }

    return { ok:true, changed:!!result.changed, reason:(responsibility.repaired ? "RESPONSIBILITY_REPAIRED_FROM_PAYMENTS" : (reason || "OK")), responsibility:responsibility, autoaccrual:result };
  }

  window.fullRecalcForCurrentAbonent = async function fullRecalcForCurrentAbonent(options){
    console.time("[recalc] total");
    function endRecalcTotalTimer(){
      try { console.timeEnd("[recalc] total"); } catch(eTimer) {}
    }
    const opts = options && typeof options === "object" ? options : {};
    const id = String(getAbonentId() || "");
    if (!id) {
      endRecalcTotalTimer();
      return { ok:false, reason:"ABONENT_REQUIRED" };
    }
    const mode = String(opts.recalcMode || opts.mode || "").trim().toUpperCase();
    const explicitReportPeriod = (mode === "REPORT_PERIOD_CALCULATION" || mode === "REPORT" || mode === "PERIOD" || String(opts.summaryScope || opts.summary_scope || "").toLowerCase() === "period")
      && opts.period && isManualRecalcPeriodValid(opts.period);
    const recalcMode = explicitReportPeriod ? "REPORT_PERIOD_CALCULATION" : "FULL_SUMMARY_REBUILD";
    const explicitRuntimePeriod = opts.runtimePeriod && isManualRecalcPeriodValid(opts.runtimePeriod)
      ? { from: String(opts.runtimePeriod.from || ""), to: String(opts.runtimePeriod.to || "") }
      : null;
    let recalcLock = null;
    try { console.log("[payment-table][recalc-explicit]", { abonentId: id, stage: "start", recalcMode: recalcMode }); } catch(eLogStart) {}
    try {
      if (!window.Data || typeof Data.beginRecalcUidLock !== "function" || typeof Data.finishRecalcUidLock !== "function") {
        endRecalcTotalTimer();
        return { ok:false, reason:"RECALC_LOCK_UNAVAILABLE", summary_status:"error", summary_reason:"RECALC_LOCK_UNAVAILABLE" };
      }
      console.time("[recalc-step] begin lock");
      recalcLock = await Data.beginRecalcUidLock(id);
      console.timeEnd("[recalc-step] begin lock");
      if (recalcLock && recalcLock.status === "already_running") {
        try { console.log("[payment-table][recalc-explicit]", { abonentId: id, stage: "already_running", recalcMode: recalcMode }); } catch(eLogLock) {}
        endRecalcTotalTimer();
        return { ok:false, reason:"RECALC_ALREADY_RUNNING", summary_status:"already_running", summary_reason:"RECALC_ALREADY_RUNNING", status:"already_running", recalc_lock:recalcLock };
      }
      if (!recalcLock || recalcLock.ok !== true || recalcLock.status !== "started") {
        endRecalcTotalTimer();
        return { ok:false, reason:(recalcLock && (recalcLock.reason || recalcLock.error)) || "RECALC_LOCK_FAILED", summary_status:"error", summary_reason:"RECALC_LOCK_FAILED", recalc_lock:recalcLock };
      }
      console.time("[recalc-step] autoaccrual");
      const autoResult = await applyControlledAutoAccrualForManualRecalc(id, opts);
      console.timeEnd("[recalc-step] autoaccrual");
      if (!autoResult || autoResult.ok !== true) {
        try { console.log("[payment-table][recalc-explicit]", { abonentId: id, stage: "autoaccrual_failed", reason: normalizeManualRecalcReason(autoResult && autoResult.reason) }); } catch(eLogAuto) {}
        endRecalcTotalTimer();
        return { ok:false, reason:normalizeManualRecalcReason(autoResult && autoResult.reason), autoaccrual:autoResult, autoaccrual_changed:!!(autoResult && autoResult.changed) };
      }
      console.time("[recalc-step] build runtime rows before summary");
      console.time("[recalc-detail] get ledger");
      const arr = getPayments();
      console.timeEnd("[recalc-detail] get ledger");
      console.time("[recalc-detail] period selection");
      const periodActive = !!(explicitReportPeriod || explicitRuntimePeriod);
      const selectedPeriod = explicitReportPeriod ? { from: String(opts.period.from || ""), to: String(opts.period.to || "") } : explicitRuntimePeriod;
      console.timeEnd("[recalc-detail] period selection");
      console.time("[recalc-detail] build runtimeRows");
      let runtimeRows;
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
      const baseRows = runningTotalsBaseRows(runtimeRows);
      console.timeEnd("[recalc-detail] build baseRows row/month loop");
      console.time("[recalc-detail] build maps/indexes");
      const ledgerVersion = (window.Data && Data.computeLedgerRuntimeVersion) ? String(Data.computeLedgerRuntimeVersion(id) || "") : "";
      console.time("[recalc-detail] ledgerSignature row loop");
      const sig = ledgerSignatureForRows(arr) + "::" + runtimeCacheSignature(ledgerVersion, periodActive, selectedPeriod);
      console.timeEnd("[recalc-detail] ledgerSignature row loop");
      const rowsById = {};
      console.timeEnd("[recalc-detail] build maps/indexes");
      console.time("[recalc-detail] build rowsById row loop");
      runtimeRows.forEach(function(r){
        const asOf = asOfForRow(r);
        const t = calcTotalsAsOfMemoized(baseRows, asOf, sig);
        rowsById[String(r.id)] = { pay_main: t.principal, pay_penalty: t.penalty, total: t.total };
      });
      console.timeEnd("[recalc-detail] build rowsById row loop");
      console.timeEnd("[recalc-step] build runtime rows before summary");
      const payload = { ledgerVersion: ledgerVersion, runtimeSignature: runtimeCacheSignature(ledgerVersion, periodActive, selectedPeriod), periodActive: !!periodActive, period: periodActive && selectedPeriod ? { from: selectedPeriod.from || "", to: selectedPeriod.to || "" } : null, rowsById: rowsById, updatedAt: (new Date()).toISOString() };
      console.time("[recalc] save runtime cache");
      if (window.Data && typeof Data.writeLedgerRuntimeCache === "function") Data.writeLedgerRuntimeCache(id, payload);
      console.timeEnd("[recalc] save runtime cache");
      __paymentTableRenderedSignature = "";
      __paymentTableMode = "readonly_no_recalc";
      console.time("[recalc] loadPaymentTable");
      console.time("[recalc-step] loadPaymentTable before summary");
      await loadPaymentTable("full_recalc_completed");
      console.timeEnd("[recalc-step] loadPaymentTable before summary");
      console.timeEnd("[recalc] loadPaymentTable");
      if (!window.Data || typeof Data.recalculateAbonentCard !== "function") {
        endRecalcTotalTimer();
        return { ok:false, reason:"SUMMARY_RECALC_UNAVAILABLE", autoaccrual_changed:!!autoResult.changed, summary_status:"error", summary_reason:"SUMMARY_RECALC_UNAVAILABLE", summary:null, summary_save:{ ok:false, reason:"SUMMARY_RECALC_UNAVAILABLE" } };
      }
      console.time("[recalc] Data.recalculateAbonentCard");
      const summaryResult = await Data.recalculateAbonentCard(id, {
        period: periodActive && selectedPeriod ? selectedPeriod : undefined,
        saveSummary: !explicitReportPeriod,
        summaryScope: explicitReportPeriod ? "period" : "full",
        periodActive: !!explicitReportPeriod,
        recalcMode: recalcMode,
        recalcLockHeld: true,
        recalcLockToken: recalcLock.lock_token || ""
      });
      console.timeEnd("[recalc] Data.recalculateAbonentCard");
      console.time("[recalc-step] build fresh runtime rows after summary");
      const freshArr = getPayments();
      const freshPeriodActive = periodActive;
      const freshSelectedPeriod = selectedPeriod;
      const freshRuntimeRows = freshPeriodActive && freshSelectedPeriod ? applyResponsibilityRangeToView(applyCalcFilter(freshArr, true, freshSelectedPeriod)).slice() : freshArr;
      const freshBaseRows = runningTotalsBaseRows(freshRuntimeRows);
      const freshLedgerVersion = (window.Data && Data.computeLedgerRuntimeVersion) ? String(Data.computeLedgerRuntimeVersion(id) || "") : "";
      const freshSig = ledgerSignatureForRows(freshArr) + "::" + runtimeCacheSignature(freshLedgerVersion, freshPeriodActive, freshSelectedPeriod);
      const freshRowsById = {};
      freshRuntimeRows.forEach(function(r){
        const asOf = asOfForRow(r);
        const t = calcTotalsAsOfMemoized(freshBaseRows, asOf, freshSig);
        freshRowsById[String(r.id)] = { pay_main: t.principal, pay_penalty: t.penalty, total: t.total };
      });
      console.timeEnd("[recalc-step] build fresh runtime rows after summary");
      const freshPayload = { ledgerVersion: freshLedgerVersion, runtimeSignature: runtimeCacheSignature(freshLedgerVersion, freshPeriodActive, freshSelectedPeriod), periodActive: !!freshPeriodActive, period: freshPeriodActive && freshSelectedPeriod ? { from: freshSelectedPeriod.from || "", to: freshSelectedPeriod.to || "" } : null, rowsById: freshRowsById, updatedAt: (new Date()).toISOString() };
      capturePaymentTableComputedRowsSnapshot(freshRuntimeRows, freshRowsById, freshPeriodActive, freshSelectedPeriod, freshPayload.runtimeSignature, freshLedgerVersion);
      console.time("[recalc] save runtime cache");
      if (window.Data && typeof Data.writeLedgerRuntimeCache === "function") Data.writeLedgerRuntimeCache(id, freshPayload);
      console.timeEnd("[recalc] save runtime cache");
      const summary = summaryResult && summaryResult.summary && typeof summaryResult.summary === "object" ? summaryResult.summary : null;
      try { console.log("[payment-table][recalc-explicit]", { abonentId: id, stage: "done", recalcMode: recalcMode, ok: !!(summaryResult && summaryResult.ok === true), summary_status: summaryResult && (summaryResult.summary_status || summaryResult.status) || "error" }); } catch(eLogDone) {}
      endRecalcTotalTimer();
      return {
        ok:!!(summaryResult && summaryResult.ok === true),
        reason: summaryResult && (summaryResult.summary_reason || summaryResult.reason) || "",
        autoaccrual_changed:!!autoResult.changed,
        autoaccrual:autoResult,
        summary_status: summaryResult && (summaryResult.summary_status || summaryResult.status) || "error",
        summary_reason: summaryResult && (summaryResult.summary_reason || summaryResult.reason) || "",
        summary: summary,
        summary_save: summaryResult
      };
    } finally {
      if (recalcLock && recalcLock.status === "started" && window.Data && typeof Data.finishRecalcUidLock === "function") {
        console.time("[recalc-step] finish lock");
        try {
          await Data.finishRecalcUidLock(recalcLock.account_uid || id, recalcLock.lock_token || "");
        } finally {
          console.timeEnd("[recalc-step] finish lock");
        }
      }
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
