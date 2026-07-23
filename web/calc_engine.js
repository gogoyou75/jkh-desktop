/* ============================================================
   🔒 CRITICAL — НЕ ТРОГАТЬ (ПАПАЖКХ)
   Doc: docs/LOGIC_SPEC_v1.5.3.md  |  Date: 2026-01-27
   Эталон архива: jkh_site_full_v01.27.3.zip
   SHA256: 6b4254a9b3b74327fe2d2c48c34e3e446ba9ae4e3369c6c554a683bde7b6ceec

   1) Карточка абонента (UI) = ИСТОЧНИК ИСТИНЫ (source of truth).
      Любые отчёты/справки — производные и НЕ имеют права менять логику карточки.

   2) payments_<uid> — помесячный ledger (НЕ журнал событий).
      В одном месяце допускается несколько строк (начисление + оплаты).

   // CRITICAL:
   // payments_<uid> — основной формат хранения ledger
   // payments_<LS> — legacy (устаревший, только для совместимости)
   // новые записи должны использовать только UID

   3) "Оплата за период" (use_period/pay_for_period) влияет ТОЛЬКО на пеню.
      Запрещена ретро‑перезапись: дата фактической оплаты не меняется.

   4) Исключённые периоды отключают ТОЛЬКО пеню, основной долг не трогают.

   5) ES-modules (type="module", import/export) в v1.5.x ЗАПРЕЩЕНЫ:
      проект должен работать в режиме file:// без сервера.

   Любая правка этого блока/связанных расчётов → только через новую версию SPEC.
   ============================================================ */

// ===============================
// DEV MODE + CRITICAL ASSERT (dev only)
// Включение: добавь ?dev=1 к URL или работай на localhost.
// ===============================
(function(){
  if (typeof window === "undefined") return;
  if (typeof window.__DEV__ === "undefined") {
    window.__DEV__ = (
      (location && (location.hostname === "localhost" || location.hostname === "127.0.0.1")) ||
      (location && typeof location.search === "string" && location.search.includes("dev=1"))
    );
  }
  if (typeof window.CRITICAL_ASSERT !== "function") {
    window.CRITICAL_ASSERT = function(condition, message, context){
      if (!window.__DEV__) return;
      if (condition) return;
      console.error("🔒 CRITICAL ASSERT FAILED: " + message, context || {});
    };
  }
})();

// calc_engine.js
// ЕДИНЫЙ ДВИЖОК РАСЧЁТОВ (вариант B: "как карточка")
// Без ES-модулей (никаких export/import) — только window.JKHCalcEngine.
// Использует JKHStore + AbonentsDB (если есть) для периода ответственности.
// Платёж гасит: сначала ОСНОВНОЙ ДОЛГ (FIFO), потом ПЕНИ (если есть переплата).
(function () {
  const hasBrowserWindow = typeof window !== "undefined";
  if (hasBrowserWindow && window.JKHCalcEngine) return; // не переопределяем

  function pad2(n){ return String(n).padStart(2,"0"); }
  function r2(x){ return Math.round(x * 100) / 100; }
  function toNum(v){ const n = parseFloat(String(v ?? "").replace(/\s+/g,"").replace(",", ".")); return Number.isFinite(n) ? n : 0; }
  function isDataReady(){
    const legacyReady = (window.JKH_DATA_READY === true);
    const uiStatus = String((window.JKH_UI_STATE && window.JKH_UI_STATE.data && window.JKH_UI_STATE.data.status) || "");
    const uiReady = (uiStatus === "ready" || uiStatus === "empty");
    return legacyReady || uiReady;
  }
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

  function makeExcludesFatalError(code, key, details, cause){
    const err = new Error(EXCLUDES_FATAL_MESSAGE);
    err.code = code || "EXCLUDES_INVALID";
    err.key = key || "";
    err.details = details || {};
    err.cause = cause;
    return err;
  }

  function isExcludesFatalError(e){
    const code = String(e && e.code || "");
    return code === "EXCLUDES_JSON_INVALID" || code === "EXCLUDES_INVALID";
  }

  function logExcludesFatal(err){
    const code = String(err && err.code || "");
    console.error("[fatal][excludes-json-invalid]", { code: code, key: err && err.key || "", details: err && err.details || {}, error: err && err.cause });
  }

  function throwExcludesFatal(code, key, details, cause){
    const err = makeExcludesFatalError(code, key, details, cause);
    logExcludesFatal(err);
    throw err;
  }

  const RATES_FATAL_MESSAGE = "Ставки рефинансирования отсутствуют или повреждены. Расчёт пени остановлен.";

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


  const TRANSFER_FATAL_MESSAGE = "Перенос долга остановлен: не удалось надёжно рассчитать долг старого абонента.";

  function makeTransferFatalError(code, key, details, cause){
    const err = new Error(TRANSFER_FATAL_MESSAGE);
    err.code = code || "DEBT_TRANSFER_ABORTED";
    err.key = key || "";
    err.details = details || {};
    err.cause = cause;
    return err;
  }

  function isTransferFatalError(e){
    const code = String(e && e.code || "");
    return code === "FROZEN_DEBT_CALC_FAILED" ||
      code === "FROZEN_DEBT_JSON_INVALID" ||
      code === "TRANSFER_BALANCE_JSON_INVALID" ||
      code === "TRANSFER_BALANCE_MISSING" ||
      code === "DEBT_TRANSFER_ABORTED";
  }

  function logTransferFatal(err){
    const code = String(err && err.code || "");
    const tag = (code === "FROZEN_DEBT_CALC_FAILED") ? "[fatal][frozen-debt-calc-failed]" :
      "[fatal][transfer-balance-invalid]";
    console.error(tag, {
      code: code,
      key: err && err.key || "",
      details: err && err.details || {},
      error: err && err.cause
    });
  }

  function throwTransferFatal(code, key, details, cause){
    const err = makeTransferFatalError(code, key, details, cause);
    logTransferFatal(err);
    throw err;
  }

  function parseTransferJson(raw, code, key){
    try{
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        throw new Error("transfer payload is not an object");
      }
      return obj;
    }catch(e){
      throwTransferFatal(code, key, { reason: "JSON_INVALID" }, e);
    }
  }

  function validateDebtAmounts(obj, code, key){
    const p = Number(obj && obj.principal);
    const pen = Number(obj && obj.penalty);
    if (!Number.isFinite(p) || !Number.isFinite(pen)) {
      throwTransferFatal(code, key, { reason: "DEBT_AMOUNTS_INVALID" });
    }
    if (r2(p) === 0 && r2(pen) === 0 && obj.success !== true) {
      throwTransferFatal(code, key, { reason: "ZERO_DEBT_NOT_PROVEN" });
    }
    return { principal: r2(p), penalty: r2(pen) };
  }

  function storeGetRaw(key){
    if (!isDataReady()) return null;
    if (!(window.JKHStore && typeof window.JKHStore.getRaw === "function")) return null;
    try{ return JKHStore.getRaw(String(key)); }catch(e){ return null; }
  }

  // ---------- ДАТЫ (без timezone-сдвигов) ----------
  function parseDateAnyToDate(value) {
    if (value === null || value === undefined) return null;

    // Excel serial
    const tryExcelSerial = (v) => {
      const n = (typeof v === "number")
        ? v
        : (typeof v === "string" && v.trim() && /^[0-9]+(\.[0-9]+)?$/.test(v.trim()) ? Number(v.trim()) : NaN);
      if (!Number.isFinite(n)) return null;
      if (n < 20000 || n > 90000) return null;
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

    // ISO YYYY-MM-DD (НЕ new Date(iso)!)
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const y = +m[1], mm = +m[2], dd = +m[3];
      const out = new Date(y, mm - 1, dd, 12, 0, 0);
      return isNaN(out) ? null : out;
    }
    // DD.MM.YYYY
    m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) {
      const dd = +m[1], mm = +m[2], y = +m[3];
      const out = new Date(y, mm - 1, dd, 12, 0, 0);
      return isNaN(out) ? null : out;
    }

    // fallback
    const d = new Date(s);
    return isNaN(d) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0);
  }

  function startOfDay(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0,0); }
  function addDays(d,n){ const x=new Date(d.getTime()); x.setDate(x.getDate()+n); return x; }
  function endOfMonthDate(y,m){ return new Date(y, m, 0); } // m=1..12
  function endOfMonth(d){ return startOfDay(endOfMonthDate(d.getFullYear(), d.getMonth()+1)); }
  function toISODateString(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }

  // ---------- ABONENT / RESPONSIBILITY RANGE ----------
  function getAbonentIdFromUrl(){
    try{
      const p = new URLSearchParams(window.location.search);
      const fromUrl = p.get("abonent");
      if (fromUrl) return String(fromUrl);
    }catch(e){}
    const db = window.AbonentsDB?.abonents || {};
    const first = Object.keys(db)[0];
    return first ? String(first) : "27";
  }

  function parseAnyDateToISO(d){
    const s = String(d || "").trim();
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
    return "";
  }

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

  // максимально "живучее" извлечение периода ответственности
  function getActiveResponsibilityRangeISO(abonentId){
    const id = String(abonentId || getAbonentIdFromUrl());
    const db = window.AbonentsDB || {};
    const linksRaw = Array.isArray(db.links) ? db.links : (Array.isArray(db.abonentPremiseLinks) ? db.abonentPremiseLinks : []);

    const linkForId = (l) => {
      const aId = l?.abonentId ?? l?.abonent_id ?? l?.abonent ?? l?.accountId ?? l?.ls ?? l?.personalAccount;
      return String(aId ?? "") === id;
    };

    const links = (linksRaw || []).filter(linkForId);

    const parseLink = (l) => ({
      ...l,
      dateFromISO: parseAnyDateToISO(l.dateFrom ?? l.from ?? l.start ?? l.startDate ?? l.date_start ?? l.respFrom),
      dateToISO:   parseAnyDateToISO(l.dateTo   ?? l.to   ?? l.end   ?? l.endDate   ?? l.date_end   ?? l.respTo),
    });

    const norm = links.map(parseLink).filter(l => l.dateFromISO);

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
      aStrict?.calcDate ??
      aStrict?.calc_date
    );
    const strictTo = parseAnyDateToISO(
      aStrict?.calcEndDate ??
      aStrict?.calc_end_date ??
      aStrict?.calcEnd ??
      aStrict?.calc_end
    );

    const clamp = (range) => {
      if (!range || !range.from) return range;
      let from = range.from;
      let to   = range.to || "";
      if (strictFrom && strictFrom > from) from = strictFrom;
      if (strictTo) {
        if (!to || strictTo < to) to = strictTo;
      }
      return { from, to };
    };

    if (norm.length){
      const active = norm.filter(l => !l.dateToISO);
      const pick = (arr) => arr.sort((a,b)=> (a.dateFromISO < b.dateFromISO ? 1 : -1))[0];
      const chosen = active.length ? pick(active) : pick(norm);
      return clamp({ from: chosen.dateFromISO, to: chosen.dateToISO || "" });
    }

    const a = (db.abonents && db.abonents[id]) ? db.abonents[id] : {};
    const fromISO = parseAnyDateToISO(
      a.dateFrom ?? a.date_from ?? a.calcFrom ?? a.calc_from ?? a.startCalc ?? a.start_calc ??
      a.dateStartCalc ?? a.date_start_calc ?? a.responsibilityFrom ?? a.respFrom
    );
    const toISO = parseAnyDateToISO(
      a.dateTo ?? a.date_to ?? a.calcTo ?? a.calc_to ?? a.endCalc ?? a.end_calc ??
      a.dateEndCalc ?? a.date_end_calc ?? a.responsibilityTo ?? a.respTo
    );
    return clamp({ from: fromISO || "", to: toISO || "" });
  }

  // ---------- EXCLUDES + RATES ----------
  const REFI_KEY_NORMAL = (hasBrowserWindow && window.JKH_CONST && window.JKH_CONST.REFI_KEY_NORMAL) ? window.JKH_CONST.REFI_KEY_NORMAL : "refinancing_rates_normal_v1";
  const REFI_KEY_MORA   = (hasBrowserWindow && window.JKH_CONST && window.JKH_CONST.REFI_KEY_MORA)   ? window.JKH_CONST.REFI_KEY_MORA   : "refinancing_rates_moratorium_v1";

  function excludePeriodsKey(abonentId){ return "exclude_periods_" + String(abonentId || getAbonentIdFromUrl()); }
  function moratoriumKey(abonentId){ return "moratorium_" + String(abonentId || getAbonentIdFromUrl()); }
  function isMoratoriumActive(abonentId){ return storeGetRaw(moratoriumKey(abonentId)) === "1"; }

  function loadExcludes(abonentId){
    const key = excludePeriodsKey(abonentId);
    const raw = storeGetRaw(key);
    if (raw === null || raw === undefined) return [];

    let arr;
    try{
      arr = JSON.parse(raw);
    }catch(e){
      const details = {
        abonentId: String(abonentId || getAbonentIdFromUrl() || ""),
        key: key,
        rawPreview: String(raw || "").slice(0, 120),
        reason: "JSON_PARSE_FAILED"
      };
      console.error("[calc][excludes-json-invalid]", details);
      throwExcludesFatal("EXCLUDES_JSON_INVALID", key, details, e);
    }

    if (!Array.isArray(arr)) {
      const details = {
        abonentId: String(abonentId || getAbonentIdFromUrl() || ""),
        key: key,
        rawPreview: String(raw || "").slice(0, 120),
        reason: "EXCLUDES_NOT_ARRAY"
      };
      console.error("[calc][excludes-json-invalid]", details);
      throwExcludesFatal("EXCLUDES_JSON_INVALID", key, details);
    }

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

      return { from: startDay(from), to: endDay(to) };
    });
  }

  function isExcludedDay(d, excludes){
    const t = d.getTime();
    if (!Array.isArray(excludes) || excludes.length === 0) return false;
    for (const p of excludes){
      if (!p || !p.from || !p.to) continue;
      const f = p.from.getTime ? p.from.getTime() : NaN;
      const to = p.to.getTime ? p.to.getTime() : NaN;
      if (!Number.isFinite(f) || !Number.isFinite(to)) continue;
      if (t >= f && t <= to) return true;
    }
    return false;
  }


  function loadRates(abonentId){
    const key = isMoratoriumActive(abonentId) ? REFI_KEY_MORA : REFI_KEY_NORMAL;
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

    if (arr.length === 0){
      // CRITICAL: ставки рефинансирования = GLOBAL-справочник с сервера.
      // Запрещено подставлять fallback-ставку: это может дать юридически неверный расчёт пени.
      console.warn("[calc_engine][ref_rates] empty GLOBAL rates key=", key);
      return [];
    }

    return arr.map(x => ({
      from: parseDateAnyToDate(x.from ?? x.dateFrom ?? x.start ?? x.fromISO ?? x.from_iso),
      rate: Number(String((x.rate ?? x.value ?? "")).replace(",", "."))
    }))
      .filter(x => x.from && x.from.getTime && Number.isFinite(x.rate))
      .sort((a,b)=>a.from.getTime()-b.from.getTime());
  }


  function rateOnDate(d, rates){
  const t = d && d.getTime ? d.getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  if (!Array.isArray(rates) || rates.length === 0) return null;

  const first = rates.find(function(r){
    return r && r.from && r.from.getTime && Number.isFinite(r.rate);
  });

  if (!first) return null;

  if (t < first.from.getTime()){
    console.error("[calc_engine][ref_rates] date before first available rate", {
      date: toISODateString(d),
      firstRateDate: toISODateString(first.from),
      reason: "DATE_BEFORE_FIRST_RATE"
    });
    return null;
  }

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

  // ---------- TRANSFER / FREEZE (debt+penalty handover) ----------
  // ---------- TRANSFER HELPERS (compat v1: transfer_to_v1 + frozen_debt_v1) ----------
  // Эти функции добавлены для совместимости с "инструкцией" переноса долга.
  // Основной канон v1.6 в проекте уже использует jkh_transfer_balance_v1:<to>:<regnum> + jkh_freeze_to_v1:<from>.
  // Здесь мы умеем читать альтернативную схему:
  //   jkh_transfer_to_v1:<to>  +  jkh_frozen_debt_v1:<from>:<freezeISO>
  // и преобразуем её в формат transfer_balance (на лету).
  function resolvePaymentKeyForAbonent(abonentId){
    if (window.getPaymentsKeyForAbonent) {
      const k = window.getPaymentsKeyForAbonent(abonentId);
      if (k){
        console.info('[calc_engine][payment-key] uid', { abonentId: String(abonentId), key: k });
        return k;
      }
    }

    const db = window.AbonentsDB || {};
    const a = db.abonents && db.abonents[String(abonentId)];
    const uid = String(a && a.uid || '').trim();

    if (uid){
      const key = 'payments_' + uid;
      console.info('[calc_engine][payment-key] uid', { abonentId: String(abonentId), uid: uid, key: key });
      return key;
    }

    console.warn('[calc_engine][payment-key] blocked', {
      abonentId: String(abonentId),
      reason: 'UID_REQUIRED'
    });
    return '';
  }

  function loadPaymentsForAbonent(abonentId){
    const key = resolvePaymentKeyForAbonent(abonentId);
    if (!key) return [];
    const raw = (window.JKHStore && JKHStore.getRaw) ? JKHStore.getRaw(key) : null;
    if (raw === null || raw === undefined) return [];
    try{
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
      logLedgerJsonInvalid(key, "parsed value is not an array");
      throw makeLedgerJsonInvalidError(key, "parsed value is not an array");
    }catch(e){
      if (e && e.code === "LEDGER_JSON_INVALID") throw e;
      logLedgerJsonInvalid(key, e);
      throw makeLedgerJsonInvalidError(key, e);
    }
  }

  function calculateFrozenDebt(abonentId, freezeISO){
    const d = parseDateAnyToDate(String(freezeISO||"").trim());
    if (!d) {
      throwTransferFatal("FROZEN_DEBT_CALC_FAILED", "", { abonentId: String(abonentId || ""), freezeISO: String(freezeISO || ""), reason: "FREEZE_DATE_INVALID" });
    }

    try{
      const rows = loadPaymentsForAbonent(String(abonentId));
      const tot = calcTotalsAsOfAdjusted(rows, d, {
        abonentId: String(abonentId),
        applyAdvanceOffset: true,
        allowNegativePrincipal: false
      });
      const principal = Number(tot && tot.principal);
      const penalty = Number(tot && tot.penaltyDebt);
      if (!Number.isFinite(principal) || !Number.isFinite(penalty)) {
        throw new Error("calculated totals are invalid");
      }
      return {
        success: true,
        principal: r2(principal),
        penalty: r2(penalty),
        calculatedAt: toISODateString(d)
      };
    }catch(e){
      if (isTransferFatalError(e)) throw e;
      throwTransferFatal("FROZEN_DEBT_CALC_FAILED", "", { abonentId: String(abonentId || ""), freezeISO: toISODateString(d), causeCode: String(e && e.code || "") }, e);
    }
  }

  function getTransferredDebtOnDate(abonentId, asOfDate){
    const id = String(abonentId || getAbonentIdFromUrl());
    const asOfISO = toISODateString(startOfDay(asOfDate));

    // 1) Канон: transfer_balance_v1 (обрабатывается в calcTotalsAsOfAdjusted через getTransferBalance)
    // Здесь только альтернативная схема:

    const transferKey = "jkh_transfer_to_v1:" + id;
    const transferRaw = storeGetRaw(transferKey);
    if (!transferRaw) return null;
    const tr = parseTransferJson(transferRaw, "TRANSFER_BALANCE_JSON_INVALID", transferKey);
    if (!tr.fromAbonentId) return null;

    const transferDate = String(tr.transferDate || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(transferDate)) return null;
    if (asOfISO < transferDate) return null;

    const fromId = String(tr.fromAbonentId || "").trim();
    if (!fromId) return null;

    const freezeISO = String(storeGetRaw("jkh_freeze_to_v1:" + fromId) || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(freezeISO)) {
      throwTransferFatal("TRANSFER_BALANCE_MISSING", transferKey, { reason: "FREEZE_DATE_MISSING", fromAbonentId: fromId });
    }

    const debtKey = "jkh_frozen_debt_v1:" + fromId + ":" + freezeISO;
    const debtRaw = storeGetRaw(debtKey);
    if (!debtRaw) throwTransferFatal("TRANSFER_BALANCE_MISSING", debtKey, { reason: "FROZEN_DEBT_MISSING", fromAbonentId: fromId, freezeISO: freezeISO });
    const debt = parseTransferJson(debtRaw, "FROZEN_DEBT_JSON_INVALID", debtKey);
    const amounts = validateDebtAmounts(debt, "FROZEN_DEBT_JSON_INVALID", debtKey);

    return {
      principal: amounts.principal,
      penalty: amounts.penalty,
      transferDate: transferDate,
      fromAbonentId: fromId,
      freezeDate: freezeISO,
      regnum: String(tr.regnum || "").trim(),
      mode: String(tr.transferMode || tr.mode || "WITH_DEBT")
    };
  }

  function freezeKey(abonentId){
    return "jkh_freeze_to_v1:" + String(abonentId || getAbonentIdFromUrl());
  }

  function getFreezeToISO(abonentId){
    try{
      const v = String(storeGetRaw(freezeKey(abonentId)) || "").trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "";
    }catch(e){ return ""; }
  }

  function getTransferBalance(abonentId){
    const id = String(abonentId || getAbonentIdFromUrl());
    const a = window.AbonentsDB?.abonents?.[id] || null;
    const regnum = String(a?.premiseRegnum || a?.regnum || "").trim();
    // regnum может отсутствовать (например, при открытии карточки до привязки) — тогда перенос по канону не найдём.
    // Но альтернативная схема transfer_to_v1 может вернуть regnum внутри объекта — попробуем и её.
    let keyRegnum = regnum;

    // ---- 1) Канон: jkh_transfer_balance_v1:<to>:<regnum>
    if (keyRegnum){
      const key = "jkh_transfer_balance_v1:" + id + ":" + keyRegnum;
      const raw = storeGetRaw(key);
      if (raw){
        const obj = parseTransferJson(raw, "TRANSFER_BALANCE_JSON_INVALID", key);
        const startDate = String(obj.startDate || "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
          throwTransferFatal("TRANSFER_BALANCE_JSON_INVALID", key, { reason: "START_DATE_INVALID" });
        }
        const amounts = validateDebtAmounts(obj, "TRANSFER_BALANCE_JSON_INVALID", key);
        return {
          startDate,
          principal: amounts.principal,
          penalty: amounts.penalty,
          regnum: String(obj.regnum || keyRegnum),
          fromAbonentId: String(obj.fromAbonentId || ""),
          mode: String(obj.mode || "")
        };
      }
    }

    // ---- 2) Совместимость: jkh_transfer_to_v1:<to> + jkh_frozen_debt_v1:<from>:<freezeISO>
    const transferKey = "jkh_transfer_to_v1:" + id;
    const trRaw = storeGetRaw(transferKey);
    if (!trRaw) return null;
    const tr = parseTransferJson(trRaw, "TRANSFER_BALANCE_JSON_INVALID", transferKey);

    const startDate = String(tr.transferDate || tr.startDate || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return null;

    const fromId = String(tr.fromAbonentId || "").trim();
    if (!fromId) return null;

    const mode = String(tr.transferMode || tr.mode || "WITH_DEBT");
    if (mode === "WITH_DEBT" && keyRegnum) {
      throwTransferFatal("TRANSFER_BALANCE_MISSING", "jkh_transfer_balance_v1:" + id + ":" + keyRegnum, { reason: "CANON_TRANSFER_BALANCE_MISSING", abonentId: id, regnum: keyRegnum });
    }

    const freezeISO = String(storeGetRaw("jkh_freeze_to_v1:" + fromId) || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(freezeISO)) {
      throwTransferFatal("TRANSFER_BALANCE_MISSING", transferKey, { reason: "FREEZE_DATE_MISSING", fromAbonentId: fromId });
    }

    const debtKey = "jkh_frozen_debt_v1:" + fromId + ":" + freezeISO;
    const debtRaw = storeGetRaw(debtKey);
    if (!debtRaw) throwTransferFatal("TRANSFER_BALANCE_MISSING", debtKey, { reason: "FROZEN_DEBT_MISSING", fromAbonentId: fromId, freezeISO: freezeISO });

    const debt = parseTransferJson(debtRaw, "FROZEN_DEBT_JSON_INVALID", debtKey);
    const amounts = validateDebtAmounts(debt, "FROZEN_DEBT_JSON_INVALID", debtKey);

    const regFromTr = String(tr.regnum || "").trim();
    if (!keyRegnum && regFromTr) keyRegnum = regFromTr;

    return {
      startDate,
      principal: amounts.principal,
      penalty: amounts.penalty,
      regnum: keyRegnum,
      fromAbonentId: fromId,
      mode: mode
    };
  }

  function minDateObj(a,b){
    if (!a) return b;
    if (!b) return a;
    return (a.getTime() <= b.getTime()) ? a : b;
  }

  // ---------- FIFO obligations / payments ----------
  function ymKey(y,m){ return `${String(y)}-${pad2(m)}`; }
  function nextMonthYear(y,m){ let yy=y, mm=m+1; if (mm===13){ mm=1; yy+=1; } return { y:yy, m:mm }; }

  function buildObligationsFromRows(rows, allowedYmSet){
    const map = new Map();
    for (const r of rows){
      const acc = toNum(r.accrued);
      if (acc <= 0) continue;
      const y = parseInt(r.year,10);
      const m = parseInt(r.month,10);
      if (!y || !m) continue;
      const k = ymKey(y,m);
      if (allowedYmSet && !allowedYmSet.has(k)) continue;
      map.set(k, (map.get(k)||0) + acc);
    }

    const obligations = [];
    for (const [k, amount] of map.entries()){
      const [yy, mm] = k.split("-");
      const y = parseInt(yy,10);
      const m = parseInt(mm,10);
      const nm = nextMonthYear(y,m);
      const due = new Date(nm.y, nm.m-1, 10);
      obligations.push({ key:k, amount:r2(amount), dueDate:startOfDay(due), applications:[] });
    }
    obligations.sort((a,b)=>a.dueDate-b.dueDate);
    return obligations;
  }

  function buildPaymentEventsFromRows(rows, abonentId, explicitPaymentPeriod){
    const pays = [];
    const id = abonentId || getAbonentIdFromUrl();

    // Global "за период" toggle (если используется)
    let globalPeriod = explicitPaymentPeriod;
    if (arguments.length < 3) {
      try{
        const active = String(storeGetRaw('calc_period_active_' + id) || '0') === '1';
        if (active){
          const raw = storeGetRaw('calc_period_' + id);
          if (raw){
            const obj = JSON.parse(raw);
            if (obj && (obj.from || obj.to)) globalPeriod = { from: obj.from || '', to: obj.to || '' };
          }
        }
      }catch(e){ /* ignore */ }
    }

    function toMonthKeyISO(iso){
      // iso: YYYY-MM-DD
      if (!iso || typeof iso !== 'string') return null;
      const m = iso.match(/^(\d{4})-(\d{2})/);
      return m ? (m[1] + '-' + m[2]) : null;
    }

    function pickRowPeriod(r){
      // поддерживаем разные имена полей
      const pf = r.period_from || r.pay_period_from || r.for_period_from || r.periodFrom || r.from_period || r.from || '';
      const pt = r.period_to   || r.pay_period_to   || r.for_period_to   || r.periodTo   || r.to_period   || r.to   || '';
      const mkFrom = toMonthKeyISO(pf);
      const mkTo   = toMonthKeyISO(pt);
      if (mkFrom || mkTo) return { mkFrom: mkFrom || mkTo, mkTo: mkTo || mkFrom };
      return null;
    }

    for (const r of rows){
      const paid = toNum(r.paid);
      if (paid <= 0) continue;
      const d = parseDateAnyToDate(r.paid_date);
      if (!d) continue;

      const payMonthKey = d.getFullYear() + '-' + pad2(d.getMonth()+1);

      // По ТЗ: если платеж НЕ "за период" — не имеет права уходить в будущие месяцы.
      // Поэтому default maxKey = месяц самого платежа.
      let minKey = '0000-00';
      let maxKey = payMonthKey;

      const rp = pickRowPeriod(r);
      if (rp){
        minKey = rp.mkFrom || minKey;
        maxKey = rp.mkTo   || maxKey;
      }else if (globalPeriod){
        const gFrom = toMonthKeyISO(globalPeriod.from);
        const gTo   = toMonthKeyISO(globalPeriod.to);
        if (gFrom || gTo){
          minKey = gFrom || minKey;
          maxKey = gTo   || maxKey;
        }
      }

      pays.push({
        date: startOfDay(d),
        amount: r2(paid),
        rowId: r.id,
        minKey,
        maxKey,
        payMonthKey
      });
    }

    pays.sort((a,b)=>a.date-b.date || (Number(a.rowId)||0)-(Number(b.rowId)||0));
    return pays;
  }

  function allocatePaymentsFIFO(obligations, payments){
    const advances = [];
    function remaining(ob){
      const applied = ob.applications.reduce((s,x)=>s + x.amount, 0);
      return Math.max(ob.amount - applied, 0);
    }

    for (const p of payments){
      let left = p.amount;

      const minKey = String(p.minKey || '0000-00');
      const maxKey = String(p.maxKey || '9999-99');

      for (let i=0; i<obligations.length && left>0.0000001; i++){
        const ob = obligations[i];
        const k = String(ob.key || '');
        if (k < minKey || k > maxKey) continue;

        const rem = remaining(ob);
        if (rem <= 0.0000001) continue;

        const take = Math.min(rem, left);
        ob.applications.push({ date:p.date, amount:r2(take), rowId:p.rowId });
        left = r2(left - take);
      }

      if (left > 0.0000001){
        advances.push({ date:p.date, amount:r2(left), rowId:p.rowId });
      }
    }
    return advances;
  }

  function sortApplications(ob){ ob.applications.sort((a,b)=>a.date-b.date); }
  function sumAppliedUpTo(ob, day){
    const t = day.getTime();
    let s = 0;
    for (const a of ob.applications){
      if (a.date.getTime() <= t) s += a.amount;
      else break;
    }
    return s;
  }

  function penaltyNowMs(){
    return (typeof window !== "undefined" && window.performance && performance.now) ? performance.now() : Date.now();
  }

  function ensurePenaltyProfiler(){
    if (typeof window === "undefined") return null;
    if (!window.__penaltyProfiler) {
      window.__penaltyProfiler = {
        reset: function() {
          this.calls = 0;
          this.totalMs = 0;
          this.breakdown = {
            dayLoop: 0,
            rateLookup: 0,
            excludedCheck: 0,
            sumApplied: 0,
            penaltyCalc: 0,
            other: 0
          };
          this.top10 = [];
        },
        record: function(obKey, asOfISO, totalMs, breakdown) {
          if (!this.breakdown) this.reset();
          this.calls += 1;
          this.totalMs += Number(totalMs || 0);
          this.breakdown.dayLoop += Number(breakdown.dayLoop || 0);
          this.breakdown.rateLookup += Number(breakdown.rateLookup || 0);
          this.breakdown.excludedCheck += Number(breakdown.excludedCheck || 0);
          this.breakdown.sumApplied += Number(breakdown.sumApplied || 0);
          this.breakdown.penaltyCalc += Number(breakdown.penaltyCalc || 0);
          this.breakdown.other += Number(breakdown.other || 0);
          this.top10.push({
            obKey: String(obKey || ""),
            asOf: String(asOfISO || ""),
            totalMs: Math.round(Number(totalMs || 0)),
            dayLoop: Math.round(Number(breakdown.dayLoop || 0)),
            rateLookup: Math.round(Number(breakdown.rateLookup || 0)),
            excludedCheck: Math.round(Number(breakdown.excludedCheck || 0)),
            sumApplied: Math.round(Number(breakdown.sumApplied || 0)),
            penaltyCalc: Math.round(Number(breakdown.penaltyCalc || 0)),
            other: Math.round(Number(breakdown.other || 0)),
            days: Number(breakdown.days || 0)
          });
          this.top10.sort(function(a, b){ return b.totalMs - a.totalMs; });
          if (this.top10.length > 10) this.top10.length = 10;
        },
        report: function(extra) {
          if (!this.breakdown) this.reset();
          var avg = this.calls ? Math.round(this.totalMs / this.calls) : 0;
          var payload = Object.assign({}, extra || {}, {
            calls: this.calls,
            totalMs: Math.round(this.totalMs),
            avgMs: avg,
            breakdown: {
              dayLoop: Math.round(this.breakdown.dayLoop || 0),
              rateLookup: Math.round(this.breakdown.rateLookup || 0),
              excludedCheck: Math.round(this.breakdown.excludedCheck || 0),
              sumApplied: Math.round(this.breakdown.sumApplied || 0),
              penaltyCalc: Math.round(this.breakdown.penaltyCalc || 0),
              other: Math.round(this.breakdown.other || 0)
            }
          });
          try { console.log("[penalty-profiler] summary", payload); } catch(e) {}
          try { console.table(this.top10); } catch(e) {}
          return payload;
        }
      };
      window.__penaltyProfiler.reset();
    }
    return window.__penaltyProfiler;
  }

  function calcPenaltyForObligation(ob, asOf, excludes, rates, runtime){
    const pureRuntime = runtime && runtime.pure === true;
    const now = pureRuntime ? Date.now : penaltyNowMs;
    const profiler = pureRuntime ? null : ensurePenaltyProfiler();
    const tTotal = now();
    let dayLoopMs = 0;
    let excludedCheckMs = 0;
    let sumAppliedMs = 0;
    let rateLookupMs = 0;
    let penaltyCalcMs = 0;
    let loopDays = 0;
    const asOfDay = startOfDay(asOf);
    if (asOfDay <= ob.dueDate) {
      if (profiler && typeof profiler.record === "function") {
        const totalMsEarly = now() - tTotal;
        profiler.record(ob && ob.key, toISODateString(asOfDay), totalMsEarly, { dayLoop: 0, rateLookup: 0, excludedCheck: 0, sumApplied: 0, penaltyCalc: 0, other: totalMsEarly, days: 0 });
      }
      return 0;
    }

    sortApplications(ob);

    let penalty = 0;
    let overdueIndex = 0;

    let day = addDays(ob.dueDate, 1);
    const hardLimit = addDays(ob.dueDate, 3650);
    const end = (asOfDay < hardLimit) ? asOfDay : hardLimit;

    while (day <= end){
      const tLoop = now();
      const tExcl = now();
      const excluded = isExcludedDay(day, excludes);
      excludedCheckMs += now() - tExcl;
      if (!excluded){
        overdueIndex += 1;
        const tApplied = now();
        const applied = sumAppliedUpTo(ob, day);
        sumAppliedMs += now() - tApplied;
        const principal = Math.max(ob.amount - applied, 0);

        if (principal > 0.0000001 && overdueIndex > 30){
          const denom = (overdueIndex <= 90) ? 300 : 130;
          const tRate = now();
          const rawRate = rateOnDate(day, rates);
          rateLookupMs += now() - tRate;
          if (!Number.isFinite(rawRate)) {
            const err = makeRatesFatalError("MISSING_REQUIRED_RATE", "", {
              date: toISODateString(day),
              reason: "MISSING_REQUIRED_RATE"
            });
            logRatesFatal(err);

            if (!pureRuntime && hasBrowserWindow && window.JKHCalcEngine && typeof window.JKHCalcEngine.onMissingRate === "function"){
              window.JKHCalcEngine.onMissingRate({
                date: toISODateString(day),
                reason: "MISSING_REQUIRED_RATE"
              });
            }

            throw err;
          }

          // CRITICAL: применяем ограничение ставки до 01.01.2027 перед расчётом пени.
          const rate = capRateUntil2027(day, rawRate);
          const tPen = now();
          penalty += principal * (rate / 100) / denom;
          penaltyCalcMs += now() - tPen;
        }
      }
      day = addDays(day, 1);
      loopDays += 1;
      dayLoopMs += now() - tLoop;
    }
    if (profiler && typeof profiler.record === "function") {
      const totalMs = now() - tTotal;
      const measured = excludedCheckMs + sumAppliedMs + rateLookupMs + penaltyCalcMs;
      profiler.record(ob && ob.key, toISODateString(asOfDay), totalMs, {
        dayLoop: dayLoopMs,
        rateLookup: rateLookupMs,
        excludedCheck: excludedCheckMs,
        sumApplied: sumAppliedMs,
        penaltyCalc: penaltyCalcMs,
        other: Math.max(totalMs - measured, 0),
        days: loopDays
      });
    }
    return penalty;
  }

  function _isoOrEmpty(value){
    const date = parseDateAnyToDate(value);
    return date ? toISODateString(date) : "";
  }

  function buildBrowserFinancialInputs(abonentId){
    const id = String(abonentId || getAbonentIdFromUrl());
    const responsibility = getActiveResponsibilityRangeISO(id) || {};
    const rates = loadRates(id).map(function(rate){ return { date: toISODateString(rate.from), value: rate.rate }; });
    const exclusions = loadExcludes(id).map(function(item){ return { from: toISODateString(item.from), to: toISODateString(item.to) }; });
    const freezeTo = getFreezeToISO(id);
    const transfer = getTransferBalance(id);
    let paymentPeriod = null;
    try{
      const active = String(storeGetRaw('calc_period_active_' + id) || '0') === '1';
      if (active) {
        const raw = storeGetRaw('calc_period_' + id);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && (parsed.from || parsed.to)) paymentPeriod = { from: parsed.from || '', to: parsed.to || '' };
      }
    }catch(e){}
    return {
      responsibility: { from: String(responsibility.from || ''), to: String(responsibility.to || '') },
      rates: rates,
      exclusions: exclusions,
      freeze: freezeTo ? { to: freezeTo } : null,
      transfer: transfer ? Object.assign({}, transfer) : null,
      paymentPeriod: paymentPeriod
    };
  }

  function normalizeFinancialInputs(financialInputs){
    const source = financialInputs && typeof financialInputs === "object" ? financialInputs : {};
    const responsibility = source.responsibility && typeof source.responsibility === "object" ? source.responsibility : {};
    const rates = Array.isArray(source.rates) ? source.rates.map(function(rate){
      return { from: parseDateAnyToDate(rate && (rate.date || rate.from)), rate: Number(String(rate && (rate.value ?? rate.rate ?? '')).replace(',', '.')) };
    }).filter(function(rate){ return rate.from && Number.isFinite(rate.rate); }).sort(function(a,b){ return a.from - b.from; }) : [];
    const exclusions = Array.isArray(source.exclusions) ? source.exclusions.map(function(item){
      const from = parseDateAnyToDate(item && item.from);
      const to = parseDateAnyToDate(item && item.to);
      return from && to ? { from: startOfDay(from), to: new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23,59,59,999) } : null;
    }).filter(Boolean) : [];
    const freezeTo = _isoOrEmpty(source.freeze && source.freeze.to);
    const transfer = source.transfer && typeof source.transfer === "object" ? Object.assign({}, source.transfer) : null;
    const paymentPeriod = source.paymentPeriod && typeof source.paymentPeriod === "object" ? { from: source.paymentPeriod.from || '', to: source.paymentPeriod.to || '' } : null;
    return { responsibility: { from: String(responsibility.from || ''), to: String(responsibility.to || '') }, rates: rates, exclusions: exclusions, freezeTo: freezeTo, transfer: transfer, paymentPeriod: paymentPeriod };
  }

  // --------- CORE TOTALS ----------
  function calcTotalsAsOfCore(rows, asOfDate, opts){
    let effectiveOpts = opts || {};
    let explicit = Object.prototype.hasOwnProperty.call(effectiveOpts, 'financialInputs');
    const abonentId = effectiveOpts.abonentId || (explicit ? '' : getAbonentIdFromUrl());
    if (!explicit) {
      effectiveOpts = Object.assign({}, effectiveOpts, { financialInputs: buildBrowserFinancialInputs(abonentId) });
      explicit = true;
    }
    const financial = normalizeFinancialInputs(effectiveOpts.financialInputs);
    const excludes = financial.exclusions;
    const rates = financial.rates;

    // ✅ FREEZE: если абонент "закрыт", пеня и итоги считаются только до freezeTo
    let asOfEff = asOfDate;
    const freezeISO = financial.freezeTo;
    if (freezeISO){
      const fd = parseDateAnyToDate(freezeISO);
      if (fd) asOfEff = minDateObj(asOfEff, fd);
    }

    const asOfDay = startOfDay(asOfEff);

    let allowedYm = null;
    try{
      const range = financial.responsibility;
      if (range?.from){
        const ms = monthIter(range.from, range.to);
        allowedYm = new Set(ms.map(m => `${m.year}-${m.month}`));
      }
    }catch(e){}

    const allObligations = buildObligationsFromRows(rows, allowedYm);
    const asOfYm = `${asOfEff.getFullYear()}-${pad2(asOfEff.getMonth()+1)}`;
    const obligations = allObligations.filter(ob => String(ob.key || "") <= asOfYm);

    const paymentsAll = explicit ? buildPaymentEventsFromRows(rows, abonentId, financial.paymentPeriod) : buildPaymentEventsFromRows(rows, abonentId);
    // asOfDay computed above
    const payments = paymentsAll.filter(p => p && p.date && p.date.getTime() <= asOfDay.getTime());
    const advances = allocatePaymentsFIFO(obligations, payments);
    const advanceUpTo = r2((advances || []).reduce((sum, a) => {
      if (a && a.date && a.date.getTime() <= asOfDay.getTime()) return sum + toNum(a.amount);
      return sum;
    }, 0));

    let principalTotal = 0;
    let penaltyTotal = 0;

    for (const ob of obligations){
      sortApplications(ob);

      const applied = sumAppliedUpTo(ob, asOfDay);
      const principal = Math.max(ob.amount - applied, 0);
      principalTotal += principal;

      penaltyTotal += calcPenaltyForObligation(ob, asOfEff, excludes, rates, explicit ? { pure:true } : null);
    }

    const applyAdvanceOffset = !!effectiveOpts.applyAdvanceOffset;
    const principalAdj = applyAdvanceOffset ? r2(principalTotal - advanceUpTo) : r2(principalTotal);

    return { principalAdj, penaltyAccruedTotal: r2(penaltyTotal), advanceUpTo: r2(advanceUpTo) };
  }

  // правило: переплата сначала гасит основной, потом пени
  function calcTotalsAsOfAdjusted(rows, asOfDate, opts){
    let effectiveOpts = opts || {};
    if (!Object.prototype.hasOwnProperty.call(effectiveOpts, 'financialInputs')) {
      const browserAbonentId = effectiveOpts.abonentId || getAbonentIdFromUrl();
      effectiveOpts = Object.assign({}, effectiveOpts, { financialInputs: buildBrowserFinancialInputs(browserAbonentId) });
    }
    const core = calcTotalsAsOfCore(rows, asOfDate, effectiveOpts);
    let principal = core.principalAdj;              // может быть отрицательным (аванс)
    let penaltyDebt = core.penaltyAccruedTotal;

    // ✅ TRANSFER BALANCE: стартовый долг + стартовая пеня у нового владельца
    const tb = normalizeFinancialInputs(effectiveOpts.financialInputs).transfer;
    if (tb){
      const asOfISO = `${asOfDate.getFullYear()}-${pad2(asOfDate.getMonth()+1)}-${pad2(asOfDate.getDate())}`;
      if (asOfISO >= tb.startDate){
        principal = r2(principal + toNum(tb.principal));
        penaltyDebt = r2(penaltyDebt + toNum(tb.penalty));
      }
    }

    const allowNeg = !!effectiveOpts.allowNegativePrincipal;

    // CRITICAL: если образовался аванс (principal < 0), этот аванс должен сначала погасить пеню,
    // и только остаток остаётся авансом (отрицательным основным долгом).
    // Это гарантирует: "если начислено меньше чем оплачено" — пени быть не должно,
    // потому что переплата покрывает и основной долг, и пеню.
    if (principal < 0){
      let extra = r2(-principal); // сумма аванса
      const usedOnPenalty = r2(Math.min(extra, penaltyDebt));
      penaltyDebt = r2(Math.max(penaltyDebt - usedOnPenalty, 0));
      extra = r2(extra - usedOnPenalty);

      if (allowNeg){
        principal = r2(-extra);   // остаток аванса показываем минусом
      } else {
        principal = 0;            // в режиме без минуса основной долг не уходит в отрицательные
      }
    }

    return {
      principal: r2(principal),
      penaltyDebt: r2(penaltyDebt),
      total: r2(principal + penaltyDebt),
      penaltyAccruedTotal: core.penaltyAccruedTotal,
      advanceUpTo: r2(core.advanceUpTo || 0)
    };
  }

  // --- helper for court view: first payment merged with accrued
  function buildCourtViewRows(baseRows, period){
    const fromD = parseDateAnyToDate(period?.from);
    const toD = parseDateAnyToDate(period?.to);
    if (!fromD || !toD) return [];

    // months list inclusive
    const res = [];
    const months = [];
    let y = fromD.getFullYear();
    let m = fromD.getMonth()+1;
    const ey = toD.getFullYear();
    const em = toD.getMonth()+1;
    while (y < ey || (y===ey && m<=em)){
      months.push({ year:y, month:m });
      m++; if (m===13){ m=1; y++; }
    }

    const byYm = new Map();
    for (const r of baseRows){
      const yy = parseInt(r.year,10);
      const mm = parseInt(r.month,10);
      if (!yy || !mm) continue;
      const k = ymKey(yy,mm);
      if (!byYm.has(k)) byYm.set(k, []);
      byYm.get(k).push(r);
    }

    for (const mm of months){
      const k = ymKey(mm.year, mm.month);
      const rows = (byYm.get(k) || []).slice();
      const monthAccrued = r2(rows.reduce((s,x)=>s + toNum(x.accrued), 0));

      const pays = rows.map(x => ({
        id: Number(x.id)||0,
        amount: r2(toNum(x.paid)),
        paid_date: String(x.paid_date||"").trim(),
        dt: parseDateAnyToDate(x.paid_date)
      })).filter(p => p.amount > 0.0000001 && p.dt)
        .sort((a,b)=>a.dt-b.dt || a.id-b.id);

      if (pays.length){
        res.push({ year:String(mm.year), month:pad2(mm.month), accrued:monthAccrued, paid:pays[0].amount, paid_date:pays[0].paid_date });
        for (let i=1;i<pays.length;i++){
          res.push({ year:String(mm.year), month:pad2(mm.month), accrued:0, paid:pays[i].amount, paid_date:pays[i].paid_date });
        }
      } else {
        res.push({ year:String(mm.year), month:pad2(mm.month), accrued:monthAccrued, paid:0, paid_date:"" });
      }
    }
    return res;
  }

  
  // --- court/report helper: penalty breakdown by source month (обязательство месяца)
  // Возвращает объект { "YYYY-MM": penaltyAccruedAsOf } по тем же правилам, что и карточка (с льготными 30 днями),
  // с учетом ставок/исключений и распределения оплат FIFO.
  function calcPenaltyBreakdownBySourceMonth(rows, asOfDate, opts){
    const abonentId = opts?.abonentId || getAbonentIdFromUrl();
    const excludes = loadExcludes(abonentId);
    const rates = loadRates(abonentId);

    const asOfDay = startOfDay(asOfDate);

    let allowedYm = null;
    try{
      const range = getActiveResponsibilityRangeISO(abonentId);
      if (range?.from){
        const ms = monthIter(range.from, range.to);
        allowedYm = new Set(ms.map(m => `${m.year}-${m.month}`));
      }
    }catch(e){}

    const allObligations = buildObligationsFromRows(rows, allowedYm);
    const asOfYm = `${asOfDate.getFullYear()}-${pad2(asOfDate.getMonth()+1)}`;
    const obligations = allObligations.filter(ob => String(ob.key || "") <= asOfYm);

    const paymentsAll = buildPaymentEventsFromRows(rows, abonentId);
    const payments = paymentsAll.filter(p => p && p.date && p.date.getTime() <= asOfDay.getTime());
    allocatePaymentsFIFO(obligations, payments);

    const out = Object.create(null);
    for (const ob of obligations){
      const pen = r2(calcPenaltyForObligation(ob, asOfDate, excludes, rates));
      out[String(ob.key)] = pen;
    }
    return out;
  }

  function computeRowsStateIncremental(ledgerRows, options) {
    const opts = options || {};
    const t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    const steps = [];
    const deepCounters = {
      asOfCount: 0,
      obligationsCount: 0,
      paymentsCount: 0,
      allocatePaymentsFIFOCalls: 0,
      calcPenaltyForObligationCalls: 0
    };
    const deepMs = {
      filterObligations: 0,
      cloneObligations: 0,
      filterPayments: 0,
      allocatePaymentsFIFO: 0,
      sumAppliedUpTo: 0,
      calcPenaltyForObligation: 0,
      finalRowsByIdWrite: 0
    };
    function now(){ return (window.performance && performance.now) ? performance.now() : Date.now(); }
    function addMs(bucket, startedAt){ deepMs[bucket] += Math.round(now() - startedAt); }
    const penaltyProfiler = ensurePenaltyProfiler();
    if (penaltyProfiler && typeof penaltyProfiler.reset === "function") penaltyProfiler.reset();
    function step(name, fn){
      const s0 = now();
      try{
        const value = fn();
        steps.push({ name, ms: Math.round(now() - s0), ok: true });
        return value;
      }catch(e){
        steps.push({ name, ms: Math.round(now() - s0), ok: false, error: String(e && e.message || e) });
        throw e;
      }
    }
    function rowAsOfDate(row){
      const paid = parseDateAnyToDate(row && row.paid_date);
      if (paid) return startOfDay(paid);
      const y = parseInt(row && row.year, 10);
      const m = parseInt(row && row.month, 10);
      if (Number.isFinite(y) && Number.isFinite(m) && y > 0 && m >= 1 && m <= 12) return endOfMonthDate(y, m);
      return parseDateAnyToDate(opts.period && opts.period.to);
    }
    function toMonthKeyISO(iso){
      if (!iso || typeof iso !== "string") return null;
      const m = iso.match(/^(\d{4})-(\d{2})/);
      return m ? (m[1] + "-" + m[2]) : null;
    }
    function pickRowPeriod(row){
      const pf = row.period_from || row.pay_period_from || row.for_period_from || row.periodFrom || row.from_period || row.from || "";
      const pt = row.period_to   || row.pay_period_to   || row.for_period_to   || row.periodTo   || row.to_period   || row.to   || "";
      const mkFrom = toMonthKeyISO(pf);
      const mkTo = toMonthKeyISO(pt);
      if (mkFrom || mkTo) return { mkFrom: mkFrom || mkTo, mkTo: mkTo || mkFrom };
      return null;
    }
    function buildPaymentEventsPure(rows){
      const pays = [];
      const globalPeriod = opts.globalPeriod && typeof opts.globalPeriod === "object" ? opts.globalPeriod : null;
      for (const row of rows){
        const paid = toNum(row && row.paid);
        if (paid <= 0) continue;
        const d = parseDateAnyToDate(row && row.paid_date);
        if (!d) continue;
        const payMonthKey = d.getFullYear() + "-" + pad2(d.getMonth() + 1);
        let minKey = "0000-00";
        let maxKey = payMonthKey;
        const rp = pickRowPeriod(row || {});
        if (rp){
          minKey = rp.mkFrom || minKey;
          maxKey = rp.mkTo || maxKey;
        }else if (globalPeriod){
          const gFrom = toMonthKeyISO(globalPeriod.from);
          const gTo = toMonthKeyISO(globalPeriod.to);
          if (gFrom || gTo){
            minKey = gFrom || minKey;
            maxKey = gTo || maxKey;
          }
        }
        pays.push({ date: startOfDay(d), amount: r2(paid), rowId: row && row.id, minKey, maxKey, payMonthKey });
      }
      pays.sort((a,b)=>a.date-b.date || (Number(a.rowId)||0)-(Number(b.rowId)||0));
      return pays;
    }
    function cloneObligation(ob){
      return { key: ob.key, amount: ob.amount, dueDate: ob.dueDate, applications: [] };
    }
    function adjustedFromCore(core, asOfDate){
      let principal = core.principalAdj;
      let penaltyDebt = core.penaltyAccruedTotal;
      const tb = opts.transferBalance || null;
      if (tb){
        const asOfISO = `${asOfDate.getFullYear()}-${pad2(asOfDate.getMonth()+1)}-${pad2(asOfDate.getDate())}`;
        if (asOfISO >= String(tb.startDate || "")){
          principal = r2(principal + toNum(tb.principal));
          penaltyDebt = r2(penaltyDebt + toNum(tb.penalty));
        }
      }
      if (principal < 0){
        let extra = r2(-principal);
        const usedOnPenalty = r2(Math.min(extra, penaltyDebt));
        penaltyDebt = r2(Math.max(penaltyDebt - usedOnPenalty, 0));
        extra = r2(extra - usedOnPenalty);
        principal = opts.allowNegativePrincipal ? r2(-extra) : 0;
      }
      return { principal: r2(principal), penaltyDebt: r2(penaltyDebt), total: r2(principal + penaltyDebt) };
    }

    try{
      const rows = step("normalize rows", function(){
        return Array.isArray(ledgerRows) ? ledgerRows.slice() : [];
      });
      const rowEvents = step("resolve asOf events", function(){
        return rows.map(function(row, index){
          const asOf = rowAsOfDate(row);
          return { row, index, rowId: String(row && row.id || "").trim(), asOf };
        }).filter(function(ev){ return ev.rowId && ev.asOf && ev.asOf.toString() !== "Invalid Date"; });
      });
      const byAsOf = step("group by exact asOf", function(){
        const map = new Map();
        for (const ev of rowEvents){
          const key = `${ev.asOf.getFullYear()}-${pad2(ev.asOf.getMonth()+1)}-${pad2(ev.asOf.getDate())}`;
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(ev);
        }
        return map;
      });
      const allowedYm = step("resolve responsibility months", function(){
        const range = opts.responsibilityRange && typeof opts.responsibilityRange === "object" ? opts.responsibilityRange : null;
        if (!range || !range.from) return null;
        const ms = monthIter(range.from, range.to);
        return new Set(ms.map(m => `${m.year}-${m.month}`));
      });
      const allObligations = step("build obligations", function(){
        // Obligation is created once per ledger month with accrued amount and due date.
        return buildObligationsFromRows(rows, allowedYm);
      });
      const paymentsAll = step("build payments", function(){
        // Payment events keep exact paid_date and use_period/pay_for_period limits.
        return buildPaymentEventsPure(rows);
      });
      const excludes = Array.isArray(opts.excludes) ? opts.excludes : [];
      const rates = Array.isArray(opts.rates) ? opts.rates : [];
      const freezeDate = opts.freezeTo ? parseDateAnyToDate(opts.freezeTo) : null;
      const rowsById = {};
      const state = {
        currentDate: null,
        // Experimental state model for Stage 19.4E. The current implementation
        // recomputes per unique asOf from prebuilt obligations/payments; Stage 19.4F
        // can replace this with true rolling obligation state after compare parity.
        obligations: new Map(),
        currentPrincipal: 0,
        currentPenalty: 0,
        remainingAdvance: 0
      };
      step("compute rowsById by asOf", function(){
        const dates = Array.from(byAsOf.keys()).sort();
        deepCounters.asOfCount = dates.length;
        deepCounters.obligationsCount = allObligations.length;
        deepCounters.paymentsCount = paymentsAll.length;
        for (const key of dates){
          const events = byAsOf.get(key) || [];
          const asOfRaw = events[0] && events[0].asOf;
          const asOfEff = freezeDate ? minDateObj(asOfRaw, freezeDate) : asOfRaw;
          const asOfDay = startOfDay(asOfEff);
          const asOfYm = `${asOfEff.getFullYear()}-${pad2(asOfEff.getMonth()+1)}`;
          let tm = now();
          const filteredObligations = allObligations.filter(ob => String(ob.key || "") <= asOfYm);
          addMs("filterObligations", tm);
          tm = now();
          const obligations = filteredObligations.map(cloneObligation);
          addMs("cloneObligations", tm);
          tm = now();
          const payments = paymentsAll.filter(p => p && p.date && p.date.getTime() <= asOfDay.getTime());
          addMs("filterPayments", tm);
          // Payments are applied FIFO to principal with the same use_period month limits.
          tm = now();
          const advances = allocatePaymentsFIFO(obligations, payments);
          deepCounters.allocatePaymentsFIFOCalls += 1;
          addMs("allocatePaymentsFIFO", tm);
          const advanceUpTo = r2((advances || []).reduce((sum, a) => {
            if (a && a.date && a.date.getTime() <= asOfDay.getTime()) return sum + toNum(a.amount);
            return sum;
          }, 0));
          let principalTotal = 0;
          let penaltyTotal = 0;
          for (const ob of obligations){
            sortApplications(ob);
            tm = now();
            const applied = sumAppliedUpTo(ob, asOfDay);
            addMs("sumAppliedUpTo", tm);
            principalTotal += Math.max(ob.amount - applied, 0);
            // Penalty accrual uses exact day iteration, excludes, moratorium rates,
            // and the 30/90 day denominator rules from calcPenaltyForObligation.
            tm = now();
            penaltyTotal += calcPenaltyForObligation(ob, asOfEff, excludes, rates);
            deepCounters.calcPenaltyForObligationCalls += 1;
            addMs("calcPenaltyForObligation", tm);
            state.obligations.set(ob.key, {
              monthKey: ob.key,
              amount: ob.amount,
              dueDate: ob.dueDate,
              remainingPrincipal: r2(Math.max(ob.amount - applied, 0)),
              penaltyAccrued: r2(penaltyTotal),
              lastPenaltyDate: asOfDay
            });
          }
          const principalAdj = opts.applyAdvanceOffset ? r2(principalTotal - advanceUpTo) : r2(principalTotal);
          const adjusted = adjustedFromCore({ principalAdj, penaltyAccruedTotal: r2(penaltyTotal), advanceUpTo }, asOfEff);
          state.currentDate = asOfDay;
          state.currentPrincipal = adjusted.principal;
          state.currentPenalty = adjusted.penaltyDebt;
          state.remainingAdvance = r2(advanceUpTo || 0);
          tm = now();
          for (const ev of events){
            rowsById[ev.rowId] = {
              pay_main: adjusted.principal,
              pay_penalty: adjusted.penaltyDebt,
              total: adjusted.total
            };
          }
          addMs("finalRowsByIdWrite", tm);
        }
        return rowsById;
      });
      const totalMs = Math.round(now() - t0);
      let penaltyProfile = null;
      if (penaltyProfiler && typeof penaltyProfiler.report === "function") {
        penaltyProfile = penaltyProfiler.report({
          uid: String(opts.uid || ""),
          ledgerRowsCount: rows.length,
          rowsByIdCount: Object.keys(rowsById || {}).length
        });
      }
      const deepSteps = [
        { name: "filter obligations", ms: deepMs.filterObligations, ok: true },
        { name: "clone obligations", ms: deepMs.cloneObligations, ok: true },
        { name: "filter payments", ms: deepMs.filterPayments, ok: true },
        { name: "allocatePaymentsFIFO", ms: deepMs.allocatePaymentsFIFO, ok: true, calls: deepCounters.allocatePaymentsFIFOCalls },
        { name: "sumAppliedUpTo", ms: deepMs.sumAppliedUpTo, ok: true },
        { name: "calcPenaltyForObligation", ms: deepMs.calcPenaltyForObligation, ok: true, calls: deepCounters.calcPenaltyForObligationCalls },
        { name: "final rowsById write", ms: deepMs.finalRowsByIdWrite, ok: true }
      ];
      for (const item of deepSteps) steps.push(item);
      try {
        console.log("[snapshot][incremental-deep-profile]", {
          uid: String(opts.uid || ""),
          totalMs,
          steps,
          counters: deepCounters
        });
      } catch(eDeepLog) {}
      try { console.table(steps); } catch(eDeepTable) {}
      return {
        ok: true,
        rowsById,
        rowsCount: rows.length,
        reason: "OK",
        profile: { totalMs, steps, counters: deepCounters },
        diagnostics: {
          ledgerRowsCount: rows.length,
          uniqueAsOfCount: byAsOf.size,
          obligationsCount: allObligations.length,
          paymentsCount: paymentsAll.length,
          allocatePaymentsFIFOCalls: deepCounters.allocatePaymentsFIFOCalls,
          calcPenaltyForObligationCalls: deepCounters.calcPenaltyForObligationCalls,
          penaltyProfile: penaltyProfile
        }
      };
    }catch(e){
      return {
        ok: false,
        rowsById: {},
        rowsCount: Array.isArray(ledgerRows) ? ledgerRows.length : 0,
        reason: String(e && (e.code || e.message) || e || "INCREMENTAL_ROWS_BUILD_FAILED"),
        profile: { totalMs: Math.round(now() - t0), steps },
        diagnostics: { ledgerRowsCount: Array.isArray(ledgerRows) ? ledgerRows.length : 0, uniqueAsOfCount: 0, obligationsCount: 0, paymentsCount: 0 }
      };
    }
  }

  function computeRowsStateIncrementalV2(ledgerRows, options) {
    const opts = options || {};
    const t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    const steps = [];
    function now(){ return (window.performance && performance.now) ? performance.now() : Date.now(); }
    function step(name, fn){
      const s0 = now();
      try{
        const value = fn();
        steps.push({ name, ms: Math.round(now() - s0), ok: true });
        return value;
      }catch(e){
        steps.push({ name, ms: Math.round(now() - s0), ok: false, error: String(e && e.message || e) });
        throw e;
      }
    }
    function rowAsOfDate(row){
      const paid = parseDateAnyToDate(row && row.paid_date);
      if (paid) return startOfDay(paid);
      const y = parseInt(row && row.year, 10);
      const m = parseInt(row && row.month, 10);
      if (Number.isFinite(y) && Number.isFinite(m) && y > 0 && m >= 1 && m <= 12) return endOfMonthDate(y, m);
      return parseDateAnyToDate(opts.period && opts.period.to);
    }
    function monthKeyFromRow(row){
      const y = parseInt(row && row.year, 10);
      const m = parseInt(row && row.month, 10);
      if (!Number.isFinite(y) || !Number.isFinite(m) || y <= 0 || m < 1 || m > 12) return "";
      return y + "-" + pad2(m);
    }
    function eventDateKey(date){
      if (!date || date.toString() === "Invalid Date") return "";
      return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
    }
    function emptyResult(reason){
      return {
        ok: false,
        rowsById: {},
        rowsCount: Array.isArray(ledgerRows) ? ledgerRows.length : 0,
        rowsByIdCount: 0,
        reason: String(reason || "INCREMENTAL_V2_ROWS_BUILD_FAILED"),
        profile: { totalMs: Math.round(now() - t0), steps: steps },
        diagnostics: {
          algorithm: "rolling_state_v2_skeleton",
          ledgerRowsCount: Array.isArray(ledgerRows) ? ledgerRows.length : 0,
          asOfCount: 0,
          obligationsCount: 0,
          paymentsCount: 0,
          penaltyMode: "legacy_per_obligation",
          penaltyCalls: 0,
          optimizationReady: false,
          note: "V2 skeleton uses legacy penalty calculation; speedup is not expected in this stage."
        }
      };
    }

    try{
      const rows = step("normalize rows", function(){
        return Array.isArray(ledgerRows) ? ledgerRows.slice() : [];
      });
      const events = step("build event model", function(){
        const out = [];
        for (let i = 0; i < rows.length; i++){
          const row = rows[i] || {};
          const rowId = String(row.id || "").trim();
          const monthKey = monthKeyFromRow(row);
          const accrued = r2(toNum(row.accrued));
          const paid = r2(toNum(row.paid));
          if (monthKey){
            const parts = monthKey.split("-");
            out.push({
              type: "accrual",
              date: endOfMonthDate(parseInt(parts[0], 10), parseInt(parts[1], 10)),
              rowId: rowId,
              monthKey: monthKey,
              amount: accrued,
              sourceRow: row,
              index: i
            });
          }
          const paidDate = parseDateAnyToDate(row.paid_date);
          if (paid > 0 && paidDate){
            out.push({
              type: "payment",
              date: startOfDay(paidDate),
              rowId: rowId,
              monthKey: monthKey,
              amount: paid,
              sourceRow: row,
              index: i
            });
          }
          const snapshotDate = rowAsOfDate(row);
          if (rowId && snapshotDate && snapshotDate.toString() !== "Invalid Date"){
            out.push({
              type: "snapshot",
              date: startOfDay(snapshotDate),
              rowId: rowId,
              monthKey: monthKey,
              amount: 0,
              sourceRow: row,
              index: i
            });
          }
        }
        const typeOrder = { accrual: 1, payment: 2, snapshot: 3 };
        out.sort(function(a, b){
          return a.date - b.date ||
            (typeOrder[a.type] || 99) - (typeOrder[b.type] || 99) ||
            String(a.monthKey || "").localeCompare(String(b.monthKey || "")) ||
            (Number(a.index) || 0) - (Number(b.index) || 0) ||
            String(a.rowId || "").localeCompare(String(b.rowId || ""));
        });
        return out;
      });
      const state = step("initialize rolling state skeleton", function(){
        return {
          currentDate: null,
          obligations: new Map(),
          totalPrincipal: 0,
          totalPenalty: 0,
          advance: 0
        };
      });
      step("walk event model skeleton", function(){
        for (const ev of events){
          state.currentDate = ev.date || state.currentDate;
          if (ev.type === "accrual" && ev.monthKey && !state.obligations.has(ev.monthKey)){
            state.obligations.set(ev.monthKey, {
              monthKey: ev.monthKey,
              amount: r2(toNum(ev.amount)),
              dueDate: ev.date,
              remainingPrincipal: r2(toNum(ev.amount)),
              penaltyAccrued: 0,
              lastPenaltyDate: ev.date,
              overdueIndex: 0,
              applications: []
            });
            state.totalPrincipal = r2(state.totalPrincipal + toNum(ev.amount));
          } else if (ev.type === "payment"){
            state.advance = r2(state.advance + toNum(ev.amount));
          }
        }
        return state;
      });
      const legacyResult = step("legacy rowsById compatibility path", function(){
        return computeRowsStateIncremental(rows, opts);
      }) || {};
      const rowsById = legacyResult.rowsById && typeof legacyResult.rowsById === "object" && !Array.isArray(legacyResult.rowsById) ? legacyResult.rowsById : {};
      const uniqueEventDates = {};
      let accrualEventsCount = 0;
      let paymentEventsCount = 0;
      let snapshotEventsCount = 0;
      for (const ev of events){
        if (ev.type === "accrual") accrualEventsCount += 1;
        else if (ev.type === "payment") paymentEventsCount += 1;
        else if (ev.type === "snapshot") snapshotEventsCount += 1;
        const key = eventDateKey(ev.date);
        if (key) uniqueEventDates[key] = true;
      }
      const legacyDiagnostics = legacyResult && legacyResult.diagnostics || {};
      const penaltyCalls = Number(legacyDiagnostics.calcPenaltyForObligationCalls || legacyDiagnostics.penaltyCalls || 0);
      const totalMs = Math.round(now() - t0);
      return {
        ok: legacyResult && legacyResult.ok === true,
        rowsById: rowsById,
        rowsCount: rows.length,
        rowsByIdCount: Object.keys(rowsById).length,
        reason: String(legacyResult && legacyResult.reason || "OK"),
        profile: {
          totalMs: totalMs,
          steps: steps.concat(legacyResult && legacyResult.profile && Array.isArray(legacyResult.profile.steps) ? [{
            name: "legacy profile",
            ms: Number(legacyResult.profile.totalMs || 0),
            ok: legacyResult.ok === true,
            steps: legacyResult.profile.steps
          }] : []),
          legacyTotalMs: Number(legacyResult && legacyResult.profile && legacyResult.profile.totalMs || 0)
        },
        diagnostics: {
          algorithm: "rolling_state_v2_skeleton",
          ledgerRowsCount: rows.length,
          asOfCount: Number(legacyDiagnostics.uniqueAsOfCount || snapshotEventsCount || 0),
          obligationsCount: Number(state.obligations.size || legacyDiagnostics.obligationsCount || 0),
          paymentsCount: paymentEventsCount,
          penaltyMode: "legacy_per_obligation",
          penaltyCalls: penaltyCalls,
          optimizationReady: false,
          note: "V2 skeleton uses legacy penalty calculation; speedup is not expected in this stage.",
          accrualEventsCount: accrualEventsCount,
          paymentEventsCount: paymentEventsCount,
          snapshotEventsCount: snapshotEventsCount,
          uniqueEventDatesCount: Object.keys(uniqueEventDates).length,
          legacyDiagnostics: legacyDiagnostics
        }
      };
    }catch(e){
      return emptyResult(String(e && (e.code || e.message) || e || "INCREMENTAL_V2_ROWS_BUILD_FAILED"));
    }
  }


  const api = {
    pad2, r2, toNum,
    parseDateAnyToDate,
    startOfDay,
    endOfMonth,
    endOfMonthDate,
    toISODateString,
    getAbonentIdFromUrl,
    getActiveResponsibilityRangeISO,
    loadExcludes,
    isExcludesFatalError,
    logExcludesFatal,
    loadRates,
    buildBrowserFinancialInputs,
    normalizeFinancialInputs,
    buildObligationsFromRows,
    buildPaymentEventsFromRows,
    allocatePaymentsFIFO,
    sortApplications,
    sumAppliedUpTo,
    calcPenaltyForObligation,
    calcTotalsAsOfAdjusted,
    calcTotalsAsOfCore,
    computeRowsStateIncremental,
    computeRowsStateIncrementalV2,
    buildCourtViewRows,
    calcPenaltyBreakdownBySourceMonth,
    // TRANSFER API
    loadPaymentsForAbonent,
    calculateFrozenDebt,
    getTransferredDebtOnDate,
  };
  if (hasBrowserWindow) window.JKHCalcEngine = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();
