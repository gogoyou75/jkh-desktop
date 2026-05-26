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
      Запрещена ретро-перезапись: дата фактической оплаты не меняется.

   4) Исключённые периоды отключают ТОЛЬКО пеню, основной долг не трогают.

   5) ES-modules (type="module", import/export) в v1.5.x ЗАПРЕЩЕНЫ:
      проект должен работать в режиме file:// без сервера.

   Любая правка этого блока/связанных расчётов → только через новую версию SPEC.
   ============================================================ */

(function () {
  if (window.__SPRAVKA_SUD_JS_LOADED__) return;
  window.__SPRAVKA_SUD_JS_LOADED__ = true;
  window.JKH_REPORT_MODE = "derived_calculation";
  let __spravkaReturnCardPeriodContext = null;

  function $(id){ return document.getElementById(id); }

  function safeJSONParse(raw, def){
    try { return JSON.parse(raw); } catch (e) { return def; }
  }

  function storeGet(key, ownerId){
    try {
      if (window.JKHStore && typeof window.JKHStore.getRaw === "function") {
        return JKHStore.getRaw(key, ownerId);
      }
    } catch (e) {}
    return null;
  }

  function storeSet(key, value, ownerId){
    try { console.warn("[reports][write-blocked-readonly]", { page: "spravka_sud", key: String(key || ""), ownerId: String(ownerId || "") }); } catch (e) {}
    return false;
  }

  const __spravkaLedgerReadCache = new Map();
  const __spravkaPaymentKeyLogOnce = new Set();

  function safeJSON(key, def, ownerId){
    try {
      const raw = storeGet(key, ownerId);
      if (!raw) return def;
      return JSON.parse(raw);
    } catch (e) { return def; }
  }

  function safeLedgerJSON(key, def, ownerId){
    try {
      key = String(key || "");
      const owner = String(ownerId || "");
      const raw = storeGet(key, ownerId);
      if (!raw) return def;
      const cacheKey = owner + "::" + key;
      const cached = __spravkaLedgerReadCache.get(cacheKey);
      if (cached && cached.raw === raw) return cached.rows;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return def;
      __spravkaLedgerReadCache.set(cacheKey, { raw: raw, rows: arr });
      return arr;
    } catch (e) {
      return def;
    }
  }

  function logSpravkaPaymentKeyOnce(payload){
    try {
      if (!window.JKH_DEBUG_PAYMENT_KEY) return;
      const onceKey = String(payload && payload.abonentId || '') + ':' + String(payload && (payload.key || payload.reason) || '');
      if (__spravkaPaymentKeyLogOnce.has(onceKey)) return;
      __spravkaPaymentKeyLogOnce.add(onceKey);
      console.debug("[spravka_sud][payment-key]", payload);
    } catch(e) {}
  }

  function setText(id, txt){
    const el = $(id);
    if (el) el.textContent = txt;
  }

  function moneyDot(x){
    return (Math.round((Number(x) || 0) * 100) / 100).toFixed(2);
  }

  function monthNameRU(m){
    return ["","январь","февраль","март","апрель","май","июнь","июль","август","сентябрь","октябрь","ноябрь","декабрь"][m] || "";
  }

  function fmtDateRuAny(any){
    const eng = window.JKHCalcEngine;
    const d = eng && typeof eng.parseDateAnyToDate === "function" ? eng.parseDateAnyToDate(any) : null;
    if (!d) return "";
    const months = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
    return d.getDate() + " " + months[d.getMonth()] + " " + d.getFullYear() + " года";
  }

  function loadSelectedPeriod(ctx, abonent){
    function parsePeriod(raw){
      try {
        const o = JSON.parse(raw);
        if (!o || !o.from || !o.to) return null;
        return { from: String(o.from), to: String(o.to) };
      } catch (e) { return null; }
    }
    function validPeriod(from, to){
      const eng = window.JKHCalcEngine;
      const fromD = eng && typeof eng.parseDateAnyToDate === "function" ? eng.parseDateAnyToDate(from) : new Date(from);
      const toD = eng && typeof eng.parseDateAnyToDate === "function" ? eng.parseDateAnyToDate(to) : new Date(to);
      return !!(from && to && fromD && toD && fromD.toString() !== "Invalid Date" && toD.toString() !== "Invalid Date" && fromD <= toD);
    }

    const requestedId = String(ctx && ctx.abonentId || '').trim();
    const readOwner = String(ctx && ctx.readOwner || '').trim();
    const urlFrom = String(ctx && ctx.from || "").trim();
    const urlTo = String(ctx && ctx.to || "").trim();
    const storageKey = (window.Data && typeof window.Data.resolveCalcPeriodStorageKey === "function")
      ? String(window.Data.resolveCalcPeriodStorageKey(abonent || requestedId) || '').trim()
      : '';
    const activeStorageKey = (window.Data && typeof window.Data.resolveCalcPeriodActiveStorageKey === "function")
      ? String(window.Data.resolveCalcPeriodActiveStorageKey(abonent || requestedId) || '').trim()
      : '';
    const uid = String(abonent && abonent.uid || '').trim();
    const reportStorageKey = uid ? ('report_period_' + uid) : '';
    const reportRaw = /^report_period_uid_/.test(reportStorageKey) ? storeGet(reportStorageKey, readOwner) : null;
    const reportPeriod = reportRaw ? parsePeriod(reportRaw) : null;
    const activeRaw = activeStorageKey ? storeGet(activeStorageKey, readOwner) : null;
    const raw = storageKey ? storeGet(storageKey, readOwner) : null;
    const calcPeriod = raw ? parsePeriod(raw) : null;
    const urlPeriod = validPeriod(urlFrom, urlTo) ? { from: urlFrom, to: urlTo } : null;
    const selectedPeriod = urlPeriod || reportPeriod || (activeRaw === "1" ? calcPeriod : null);
    const selectedSource = urlPeriod ? "url" : (reportPeriod ? "report_period_uid" : (activeRaw === "1" && calcPeriod ? "calc_period_uid" : ""));
    if (selectedPeriod) selectedPeriod.__source = selectedSource;
    try {
      console.log("[spravka][bootstrap-period]", {
        abonentId: requestedId,
        uid: uid,
        readOwner: readOwner,
        reportKey: reportStorageKey,
        periodKey: storageKey,
        activeKey: activeStorageKey,
        source: selectedSource || "missing",
        from: selectedPeriod ? selectedPeriod.from : "",
        to: selectedPeriod ? selectedPeriod.to : "",
        ok: !!selectedPeriod
      });
      console.log("[spravka][period-source]", {
        source: selectedSource || "missing",
        abonentId: requestedId,
        uid: uid,
        from: selectedPeriod ? selectedPeriod.from : "",
        to: selectedPeriod ? selectedPeriod.to : ""
      });
      if (urlPeriod) {
        console.log("[spravka][url-period-accepted]", {
          abonentId: requestedId,
          uid: uid,
          from: urlPeriod.from,
          to: urlPeriod.to
        });
      }
    } catch (eBootstrapLog) {}

    try {
      console.log("[spravka][calc-period-read]", {
        abonentId: requestedId,
        readOwner: readOwner,
        currentOwner: String(ctx && ctx.currentOwner || ''),
        forcedOwner: String(ctx && ctx.forcedOwner || ''),
        reportKey: reportStorageKey,
        reportRawExists: reportRaw !== null && reportRaw !== undefined && reportRaw !== "",
        key: storageKey,
        activeKey: activeStorageKey,
        rawExists: raw !== null && raw !== undefined && raw !== "",
        activeRaw: activeRaw,
        source: selectedSource,
        from: selectedPeriod ? selectedPeriod.from : "",
        to: selectedPeriod ? selectedPeriod.to : ""
      });
    } catch (e) {}

    if (!urlPeriod && !reportStorageKey && !storageKey) {
      console.warn("[spravka][calc-period-read][missing-canonical-key]", {
        abonentId: requestedId,
        readOwner: readOwner,
        reportKey: reportStorageKey,
        key: storageKey,
        activeKey: activeStorageKey
      });
      return null;
    }

    if (!selectedPeriod) {
      console.warn("[spravka][calc-period-read][missing-canonical-period]", {
        abonentId: requestedId,
        readOwner: readOwner,
        reportKey: reportStorageKey,
        key: storageKey,
        activeKey: activeStorageKey
      });
      return null;
    }

    return selectedPeriod;
  }


  function getUrlParams(){
    try { return new URLSearchParams(location.search); } catch (e) { return new URLSearchParams(); }
  }

  function isDevMode(){
    const p = getUrlParams();
    return String(p.get("dev") || "") === "1";
  }

  function devLog(devMode, tag, payload){
    if (!devMode) return;
    try { console.log("[spravka_sud][dev] " + tag, payload || {}); } catch (e) {}
  }

  function getDbKeyFromURL(){
    const p = getUrlParams();
    return String(p.get("db") || "").trim();
  }

  function extractOwnerFromScopedDbKey(scoped){
    const m = String(scoped || "").match(/^jkhdb::(.+?)::abonents_db_v1$/);
    return m ? String(m[1] || "") : "";
  }

  function getContext(){
    const p = getUrlParams();
    const abonentId = String(p.get("abonent") || "").trim();
    const from = String(p.get("from") || "").trim();
    const to = String(p.get("to") || "").trim();
    const dbKey = getDbKeyFromURL();
    const ownerParam = String(p.get("owner") || "").trim();
    const forcedOwner = extractOwnerFromScopedDbKey(dbKey) || ownerParam;
    let currentOwner = "";
    try { currentOwner = String(window.JKHStore && JKHStore.getOwnerId ? (JKHStore.getOwnerId() || "") : "").trim(); } catch (e) {}
    const readOwner = forcedOwner || currentOwner || "";
    return {
      abonentId: abonentId,
      dbKey: dbKey,
      ownerParam: ownerParam,
      forcedOwner: forcedOwner,
      currentOwner: currentOwner,
      readOwner: readOwner,
      from: from,
      to: to
    };
  }

  function normalizeDbRoot(obj){
    if (!obj || typeof obj !== "object") return null;
    const abonents = (obj.abonents && typeof obj.abonents === "object") ? obj.abonents : null;
    if (!abonents) return null;
    if (!obj.links) obj.links = [];
    if (!obj.premises) obj.premises = {};
    return obj;
  }

  function hasAbonentInDbRoot(dbRoot, abonentId){
    try {
      if (!dbRoot || !dbRoot.abonents) return false;
      return !!dbRoot.abonents[String(abonentId || "")];
    } catch (e) { return false; }
  }

  function getDbRootForContext(ctx){
    if (!ctx) return null;

    const cachedRoot = normalizeDbRoot(window.AbonentsDB);
    if (cachedRoot && hasAbonentInDbRoot(cachedRoot, ctx.abonentId)) {
      return cachedRoot;
    }

    if (!ctx.forcedOwner && cachedRoot) {
      return cachedRoot;
    }

    const raw = ctx.readOwner
      ? storeGet("abonents_db_v1", ctx.readOwner)
      : storeGet("abonents_db_v1");
    const parsed = safeJSONParse(raw, null);
    return normalizeDbRoot(parsed);
  }

  function resolvePaymentsKeyForSpravka(ctx){
    const abonentId = String((ctx && ctx.abonentId) || "").trim();
    if (!abonentId) {
      logSpravkaPaymentKeyOnce({ abonentId: abonentId, reason: "UID_REQUIRED" });
      return "";
    }

    try {
      if (window.Data && typeof window.Data.resolvePaymentLedgerKey === "function") {
        const key = String(window.Data.resolvePaymentLedgerKey(abonentId) || "").trim();
        if (key) {
          logSpravkaPaymentKeyOnce({ abonentId: abonentId, key: key });
          return key;
        }
      }
    } catch (e) {}

    logSpravkaPaymentKeyOnce({ abonentId: abonentId, reason: "UID_REQUIRED" });
    return "";
  }


  function getActiveLinkForAbonent(dbRoot, abonentId){
    try {
      const links = Array.isArray(dbRoot && dbRoot.links) ? dbRoot.links : [];
      const id = String(abonentId || "");
      const mine = links.filter(function (l) { return String((l && l.abonentId) || "") === id; });
      if (!mine.length) return null;
      const active = mine.find(function (l) { return !String((l && l.dateTo) || "").trim(); });
      return active || mine[0] || null;
    } catch (e) { return null; }
  }

  const START_DATE_FATAL_MESSAGE = "Дата начала ответственности/расчёта не указана. Расчёт остановлен, чтобы не использовать фиктивную дату.";

  function isDefault2000Date(d){
    return !!(d && d.getFullYear && d.getFullYear() === 2000 && d.getMonth() === 0 && d.getDate() === 1);
  }

  function makeStartDateError(code, details){
    const err = new Error(START_DATE_FATAL_MESSAGE);
    err.code = code;
    err.details = details || {};
    return err;
  }

  function logStartDateFatal(err){
    const code = String(err && err.code || "");
    const tag = (code === "DEFAULT_2000_DATE_FORBIDDEN")
      ? "[fatal][default-2000-date-forbidden]"
      : "[fatal][responsibility-date-missing]";
    console.error(tag, { code: code, details: err && err.details || {} });
  }

  function isStartDateFatalError(e){
    const code = String(e && e.code || "");
    return code === "START_DATE_MISSING" || code === "RESPONSIBILITY_DATE_MISSING" || code === "DEFAULT_2000_DATE_FORBIDDEN";
  }

  function firstValidDate(eng, values, source){
    for (let i = 0; i < values.length; i++) {
      const raw = String(values[i] || "").trim();
      if (!raw) continue;
      const d = eng.parseDateAnyToDate(raw);
      if (!d) continue;
      if (isDefault2000Date(d)) {
        throw makeStartDateError("DEFAULT_2000_DATE_FORBIDDEN", { source: source || "", raw: raw });
      }
      return d;
    }
    return null;
  }

  function resolveAbonentStartDate(eng, abonent, activeLink, abonentId){
    const result = { date: null, source: "" };

    const d1 = firstValidDate(eng, [abonent && abonent.calcStartDate], "abonent.calcStartDate");
    if (d1) return { date: eng.startOfDay(d1), source: "abonent.calcStartDate" };

    const d2 = firstValidDate(eng, [activeLink && activeLink.dateFrom], "activeLink.dateFrom");
    if (d2) return { date: eng.startOfDay(d2), source: "activeLink.dateFrom" };

    const d3 = firstValidDate(eng, [
      abonent && abonent.calc_start_date,
      abonent && abonent.calcStart,
      abonent && abonent.calc_start,
      abonent && abonent.startCalc,
      abonent && abonent.start_calc,
      abonent && abonent.dateStartCalc,
      abonent && abonent.date_start_calc,
      abonent && abonent.calcDateStart,
      abonent && abonent.calc_date_start,
      abonent && abonent.calcDate,
      abonent && abonent.calc_date,
      abonent && abonent.dateFrom,
      abonent && abonent.date_from,
      abonent && abonent.regDate,
      abonent && abonent.registrationDate,
      abonent && abonent.date_reg,
      abonent && abonent.dateRegistration
    ], "abonent.compat.startDateField");
    if (d3) return { date: eng.startOfDay(d3), source: "abonent.compat.startDateField" };

    try {
      const r = eng.getActiveResponsibilityRangeISO(abonentId);
      const d4 = firstValidDate(eng, [r && r.from], "calcEngine.getActiveResponsibilityRangeISO");
      if (d4) return { date: eng.startOfDay(d4), source: "calcEngine.getActiveResponsibilityRangeISO" };
    } catch (e) {
      if (isStartDateFatalError(e)) throw e;
    }

    throw makeStartDateError("RESPONSIBILITY_DATE_MISSING", {
      codeAlias: "START_DATE_MISSING",
      reason: "no abonent start date sources",
      abonentId: String(abonentId || "")
    });
  }

  function renderRow(tbody, cells){
    const tr = document.createElement("tr");
    tr.innerHTML = ""
      + "<td>" + cells.period + "</td>"
      + "<td class=\"align-right\">" + cells.accrued + "</td>"
      + "<td class=\"align-right\">" + cells.paid + "</td>"
      + "<td>" + cells.paidDate + "</td>"
      + "<td class=\"align-right\">" + cells.monthDebtMain + "</td>"
      + "<td class=\"align-right\">" + cells.monthDebtPenalty + "</td>"
      + "<td class=\"align-right\">" + cells.monthDebtTotal + "</td>";
    tbody.appendChild(tr);
  }

  function monthKey(y,m){ return y + "-" + String(m).padStart(2, "0"); }

  async function waitForInit(ctx, timeoutMs){
    const started = Date.now();
    const stepMs = 100;

    while ((Date.now() - started) < timeoutMs) {
      const hasStore = !!(window.JKHStore && typeof JKHStore.getRaw === "function");
      const uiStatus = String((window.JKH_UI_STATE && window.JKH_UI_STATE.data && window.JKH_UI_STATE.data.status) || "");
      const readyByUI = (uiStatus === "ready" || uiStatus === "empty");
      const readyByLegacy = (window.JKH_DATA_READY === true);
      const dataReady = readyByUI || readyByLegacy;
      const dbRaw = hasStore
        ? (ctx.readOwner ? storeGet("abonents_db_v1", ctx.readOwner) : storeGet("abonents_db_v1"))
        : null;
      const hasDbValue = (dbRaw !== null) || hasAbonentInDbRoot(window.AbonentsDB, ctx.abonentId);

      if (hasStore && dataReady && hasDbValue) {
        return { ok: true, uiStatus: uiStatus };
      }

      await new Promise(function(resolve){ setTimeout(resolve, stepMs); });
    }

    return {
      ok: false,
      reason: "INIT_TIMEOUT",
      uiStatus: String((window.JKH_UI_STATE && window.JKH_UI_STATE.data && window.JKH_UI_STATE.data.status) || ""),
      hasStore: !!(window.JKHStore && typeof JKHStore.getRaw === "function")
    };
  }


  const EXCLUDES_FATAL_MESSAGE = "Исключённые периоды повреждены. Расчёт пени остановлен.";

  function isExcludesFatalError(e){
    const code = String(e && e.code || "");
    return code === "EXCLUDES_JSON_INVALID" || code === "EXCLUDES_INVALID";
  }

  function logExcludesFatal(e){
    if (window.JKHCalcEngine && typeof window.JKHCalcEngine.logExcludesFatal === "function") {
      window.JKHCalcEngine.logExcludesFatal(e);
      return;
    }
    const code = String(e && e.code || "");
    console.error("[fatal][excludes-json-invalid]", { code: code, details: e && e.details || {} });
  }

  const RATES_FATAL_MESSAGE = "Ставки рефинансирования отсутствуют или повреждены. Расчёт пени остановлен.";

  function isRatesFatalError(e){
    const code = String(e && e.code || "");
    return code === "RATES_MISSING" || code === "RATES_JSON_INVALID" || code === "MISSING_REQUIRED_RATE";
  }

  function logRatesFatal(e){
    const code = String(e && e.code || "");
    const tag = (code === "RATES_JSON_INVALID") ? "[fatal][rates-json-invalid]" :
      (code === "MISSING_REQUIRED_RATE" ? "[fatal][missing-required-rate]" :
      (code === "RATES_MISSING" ? "[fatal][rates-missing]" : "[fatal][rates-error]"));
    console.error(tag, { code: code, details: e && e.details || {} });
  }

  function showFatal(msg, details){
    console.error("[spravka_sud] " + msg, details || {});
    alert(msg);
    const tbody = $("debtRows");
    if (tbody) {
      tbody.innerHTML = "<tr><td colspan=\"7\" style=\"color:#b00000;font-weight:bold;\">" + msg + "</td></tr>";
    }
  }

  const LEDGER_FATAL_MESSAGE = "Данные платежей повреждены. Расчёт/импорт остановлен, чтобы не потерять историю платежей.";

  function isLedgerJsonInvalidResult(res){
    return String(res && res.reason || "") === "LEDGER_JSON_INVALID";
  }

  function isLedgerJsonInvalidError(e){
    return String(e && e.code || "") === "LEDGER_JSON_INVALID";
  }

  function cardUrlForAbonent(abonentId){
    const id = String(abonentId || "").trim();
    return id ? ("abonent_card.html?abonent=" + encodeURIComponent(id)) : "#";
  }

  function buildCardReturnUrl(ctx, abonent, period){
    const id = String(ctx && ctx.abonentId || "").trim();
    if (!id) return "#";
    const uid = String(abonent && abonent.uid || "").trim();
    let href = "abonent_card.html?abonent=" + encodeURIComponent(id) + "&account=" + encodeURIComponent(id);
    if (uid) href += "&uid=" + encodeURIComponent(uid);
    if (period && period.from && period.to) href += "&from=" + encodeURIComponent(period.from) + "&to=" + encodeURIComponent(period.to);
    if (ctx && ctx.dbKey) href += "&db=" + encodeURIComponent(ctx.dbKey);
    else if (ctx && ctx.ownerParam) href += "&owner=" + encodeURIComponent(ctx.ownerParam);
    return href;
  }

  function saveReturnCardPeriod(ctx, abonent, period){
    const id = String(ctx && ctx.abonentId || "").trim();
    const uid = String(abonent && abonent.uid || "").trim();
    const ownerId = String(ctx && ctx.readOwner || "").trim();
    const payload = { from: String(period && period.from || "").trim(), to: String(period && period.to || "").trim() };
    const reportKey = uid ? ("report_period_" + uid) : "";
    const periodKey = (window.Data && typeof window.Data.resolveCalcPeriodStorageKey === "function")
      ? String(window.Data.resolveCalcPeriodStorageKey(abonent || id) || "").trim()
      : "";
    const activeKey = (window.Data && typeof window.Data.resolveCalcPeriodActiveStorageKey === "function")
      ? String(window.Data.resolveCalcPeriodActiveStorageKey(abonent || id) || "").trim()
      : "";
    const result = {
      ok: false,
      abonentId: id,
      uid: uid,
      ownerId: ownerId,
      reportKey: reportKey,
      periodKey: periodKey,
      activeKey: activeKey,
      period: payload,
      reason: ""
    };
    if (!uid || !/^report_period_uid_/.test(reportKey) || !periodKey || !activeKey || !payload.from || !payload.to) {
      result.reason = "RETURN_CARD_PERIOD_CONTEXT_MISSING";
      try { console.warn("[spravka][return-card-period-save]", result); } catch(eWarn) {}
      return result;
    }

    const raw = JSON.stringify(payload);
    let reportReadback = null;
    let periodReadback = null;
    let activeReadback = null;
    reportReadback = raw;
    periodReadback = raw;
    activeReadback = "1";
    result.reportReadback = reportReadback;
    result.periodReadback = periodReadback;
    result.activeReadback = activeReadback;
    result.ok = reportReadback === raw && periodReadback === raw && activeReadback === "1";
    result.reason = result.ok ? "" : "RETURN_CARD_PERIOD_READBACK_FAILED";
    result.readonly = true;
    try { console.log("[reports][readonly-open]", { page: "spravka_sud", source: "return-card-period", writes: false, abonentId: id, uid: uid }); } catch(eLog) {}
    return result;
  }

  function showDerivedProgress(text){
    let el = document.getElementById("spravkaDerivedProgress");
    if (!el) {
      el = document.createElement("div");
      el.id = "spravkaDerivedProgress";
      el.style.cssText = "width:960px;margin:8px auto;padding:8px 10px;border:1px solid #d9e2ef;background:#f7fbff;color:#345;";
      const anchor = document.querySelector(".spravka-actions") || document.body.firstChild;
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(el, anchor.nextSibling);
      else document.body.appendChild(el);
    }
    el.textContent = String(text || "");
    el.style.display = text ? "block" : "none";
  }

  function configureBackToCardPeriod(ctx, abonent, period){
    const back = $("backToCard");
    const href = buildCardReturnUrl(ctx, abonent, period);
    const saveResult = { ok: true, readonly: true };
    __spravkaReturnCardPeriodContext = { ctx: ctx, abonent: abonent, period: period };
    if (back) back.href = href;
    try {
      console.log("[spravka][return-card-url]", {
        href: href,
        abonentId: String(ctx && ctx.abonentId || ""),
        uid: String(abonent && abonent.uid || ""),
        from: period && period.from || "",
        to: period && period.to || "",
        saveOk: !!(saveResult && saveResult.ok),
        readonly: true
      });
    } catch(eLog) {}
    return href;
  }

  function setupBackToCard(ctx){
    const back = $("backToCard");
    if (!back) return;
    const id = String(ctx && ctx.abonentId || "").trim();
    back.href = cardUrlForAbonent(id);
    back.addEventListener("click", function(ev){
      if (__spravkaReturnCardPeriodContext) {
        const c = __spravkaReturnCardPeriodContext;
        const saveResult = { ok: true, readonly: true };
        const href = buildCardReturnUrl(c.ctx, c.abonent, c.period);
        back.href = href;
        try {
          console.log("[spravka][return-card-url]", {
            href: href,
            abonentId: String(c.ctx && c.ctx.abonentId || ""),
            uid: String(c.abonent && c.abonent.uid || ""),
            from: c.period && c.period.from || "",
            to: c.period && c.period.to || "",
            saveOk: !!(saveResult && saveResult.ok),
            readonly: true,
            source: "click"
          });
        } catch(eClickLog) {}
      }
      if (!id) {
        ev.preventDefault();
        showFatal("Не передан параметр abonent в URL. Возврат к карточке невозможен.");
      }
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    (async function () {
      const eng = window.JKHCalcEngine;
      const devMode = isDevMode();

      if (!eng){
        showFatal("Не найден calc_engine.js. Проверь, что он подключён ПЕРЕД spravka_sud.js");
        return;
      }

      const previousMissingRateHandler = window.JKHCalcEngine.onMissingRate;
      window.JKHCalcEngine.onMissingRate = function(info){
        const err = new Error(RATES_FATAL_MESSAGE);
        err.code = "MISSING_REQUIRED_RATE";
        err.details = info || {};
        logRatesFatal(err);
        throw err;
      };

      try {
      const ctx = getContext();
      showDerivedProgress("Формирование справки...");
      try { console.log("[reports][readonly-open]", { page: "spravka_sud", source: "url", abonentId: ctx.abonentId, uid: ctx.uid || "", from: ctx.from || "", to: ctx.to || "", writes: false }); } catch(eReadonlyLog) {}
      try { console.log("[reports][derived-calc-start]", { page: "spravka_sud", abonentId: ctx.abonentId }); } catch(eDerivedStart) {}
      setupBackToCard(ctx);
      if (!ctx.abonentId) {
        showFatal("Не передан параметр abonent в URL.");
        return;
      }
      if (!ctx.readOwner) {
        showFatal("Не определён owner-контекст для справки.");
        return;
      }

      const gate = await waitForInit(ctx, 8000);
      if (!gate.ok) {
        showFatal("Данные ещё не готовы (JKHStore/server-first). Попробуйте открыть справку повторно через 1–2 секунды.", {
          abonentId: ctx.abonentId,
          ownerContext: ctx,
          gate: gate
        });
        return;
      }

      const dbRoot = getDbRootForContext(ctx);
      const abonent = (dbRoot && dbRoot.abonents && dbRoot.abonents[String(ctx.abonentId)]) ? dbRoot.abonents[String(ctx.abonentId)] : null;
      if (!abonent) {
        showFatal("Абонент не найден в текущем owner/db контексте. Справка не построена.", {
          abonentId: ctx.abonentId,
          ownerContext: ctx
        });
        return;
      }

      const req = safeJSON("organization_requisites_v1", {}, ctx.readOwner) || {};
      function setReqRow(rowId, spanId, value) {
        const v = (value == null ? "" : String(value)).trim();
        const row = document.getElementById(rowId);
        if (row) row.style.display = v ? "" : "none";
        setText(spanId, v);
        return !!v;
      }
      const has1 = setReqRow("orgRowName", "orgName", req.full_name);
      const has2 = setReqRow("orgRowInn", "orgInn", req.inn);
      const hasOgrn = setReqRow("orgRowOgrn", "orgOgrn", req.ogrn);
      const has3 = setReqRow("orgRowLegal", "orgLegal", req.legal_address);
      const has4 = setReqRow("orgRowPostal", "orgPostal", req.postal_address);
      const has5 = setReqRow("orgRowPhone", "orgPhone", req.phone);
      const has6 = setReqRow("orgRowEmail", "orgEmail", req.email);
      const orgHeader = document.getElementById("orgHeader");
      if (orgHeader && !(has1 || has2 || hasOgrn || has3 || has4 || has5 || has6)) orgHeader.style.display = "none";

      const signers = safeJSON("organization_signers_v1", [], ctx.readOwner) || [];
      const activeS = Array.isArray(signers) ? signers.filter(function (s) { return s && s.active !== false; }) : [];
      const signer = activeS.find(function (s) { return s && s.is_default === true; }) || activeS[0] || null;
      if (signer) {
        setText("signerPosition", String(signer.position || "Председатель правления").trim());
        setText("chairmanName", String(signer.fio || "").trim());
        const basis = String(signer.basis || "").trim();
        const basisLine = document.getElementById("basisLine");
        if (basisLine) basisLine.style.display = basis ? "" : "none";
        setText("signerBasisText", basis);
      } else {
        setText("signerPosition", "Председатель правления");
        setText("chairmanName", "");
        const basisLine = document.getElementById("basisLine");
        if (basisLine) basisLine.style.display = "none";
        setText("signerBasisText", "");
      }

      setText("fio", abonent.fio || "");
      setText("address", [abonent.city, abonent.street, abonent.house, abonent.flat].filter(Boolean).join(", "));
      setText("square", abonent.square || "");
      setText("rooms", abonent.rooms || "");
      setText("share", abonent.share || "");

      const activeLink = getActiveLinkForAbonent(dbRoot, ctx.abonentId);
      const startResolved = resolveAbonentStartDate(eng, abonent, activeLink, ctx.abonentId);
      const abonentStart = startResolved.date;
      if (!abonentStart) {
        const err = makeStartDateError("RESPONSIBILITY_DATE_MISSING", { abonentId: ctx.abonentId });
        logStartDateFatal(err);
        showFatal(START_DATE_FATAL_MESSAGE);
        return;
      }

      let period = loadSelectedPeriod(ctx, abonent);
      let periodSource = period ? String(period.__source || "stored canonical calc period") : "missing period";
      if (!period) {
        try { console.warn("[spravka][blocked-empty-period]", { abonentId: ctx.abonentId, from: ctx.from || "", to: ctx.to || "" }); } catch(eBlockedPeriod) {}
        showFatal("Выберите период в карточке или на странице справок.");
        return;
      }
      try { console.log("[spravka][readonly-derived-calc]", { abonentId: ctx.abonentId, source: periodSource, writes: false }); } catch(eReadonlyDerived) {}

      const pFrom = eng.parseDateAnyToDate(period.from);
      if (pFrom && eng.startOfDay(pFrom) < abonentStart) {
        period.from = eng.toISODateString(abonentStart);
        periodSource += " + clampedToAbonentStart";
      }

      const periodFromD = eng.parseDateAnyToDate(period.from);
      const periodToD = eng.parseDateAnyToDate(period.to);
      if (!periodFromD || !periodToD) {
        showFatal("Некорректный период расчёта.");
        return;
      }
      if (eng.startOfDay(periodFromD) > eng.startOfDay(periodToD)) {
        showFatal("Такой период невозможен: дата начала не может быть позже даты окончания.");
        return;
      }

      configureBackToCardPeriod(ctx, abonent, period);
      setText("period_from", fmtDateRuAny(period.from));
      setText("period_to", fmtDateRuAny(period.to));

      const toD = periodToD;
      const asOfFinal = eng.endOfMonth(toD);

      setText("stateDate", fmtDateRuAny(asOfFinal));
      setText("docDate", fmtDateRuAny(new Date()));

      const paymentsKey = resolvePaymentsKeyForSpravka(ctx);
      if (!paymentsKey) {
        showFatal("Не удалось определить UID-ключ оплат для справки. Проверьте UID абонента.");
        return;
      }
      function hasUsableLedgerRows(rows){
        if (!Array.isArray(rows)) return false;
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i] || {};
          if ((Number(row.accrued) || 0) > 0 || (Number(row.paid) || 0) > 0) return true;
        }
        return false;
      }

      try { console.log("[reports][readonly-open]", { page: "spravka_sud", source: "skip-autoaccrual", abonentId: ctx.abonentId, writes: false }); } catch(eReadonlyOpen) {}

      let allRowsRaw;
      try {
        allRowsRaw = (window.Data && typeof window.Data.readPaymentLedger === "function")
          ? window.Data.readPaymentLedger(ctx.abonentId)
          : safeLedgerJSON(paymentsKey, [], ctx.readOwner);
      } catch (e) {
        if (isLedgerJsonInvalidError(e)) {
          showFatal(LEDGER_FATAL_MESSAGE, { abonentId: ctx.abonentId, error: e });
          return;
        }
        throw e;
      }
      let allRows = Array.isArray(allRowsRaw) ? allRowsRaw : [];
      const hasLedger = hasUsableLedgerRows(allRows);
      console.log('[spravka_sud][ledger-check] id=' + ctx.abonentId + ' len=' + allRows.length);
      if (!hasLedger) {
        console.warn('[readonly][blocked-write-path]', { page: 'spravka_sud', abonentId: ctx.abonentId, reason: 'LEDGER_NOT_PREPARED' });
        showFatal("Начисления не подготовлены. Сначала выполните пересчёт начислений.");
        return;
      }

      if (!allRows.length) {
        devLog(devMode, "payments-empty", {
          abonentId: ctx.abonentId,
          abonentFound: !!abonent,
          paymentsKey: paymentsKey,
          dataStatus: String((window.JKH_UI_STATE && window.JKH_UI_STATE.data && window.JKH_UI_STATE.data.status) || ""),
          ownerContext: ctx
        });
      }

      const fromD = eng.parseDateAnyToDate(period.from);
      const toD2 = eng.parseDateAnyToDate(period.to);
      let baseRows = allRows;
      if (fromD && toD2){
        const fromKey = (fromD.getFullYear() * 12) + (fromD.getMonth() + 1);
        const toKey = (toD2.getFullYear() * 12) + (toD2.getMonth() + 1);
        baseRows = allRows.filter(function (r) {
          const y = parseInt(r && r.year, 10);
          const m = parseInt(r && r.month, 10);
          if (!(Number.isFinite(y) && Number.isFinite(m) && y > 0 && m >= 1 && m <= 12)) return false;
          const k = (y * 12) + m;
          return k >= fromKey && k <= toKey;
        });
      }

      let viewRows;
      try {
        viewRows = eng.buildCourtViewRows(baseRows, period);
      } catch (e) {
        console.error("[spravka_sud] buildCourtViewRows failed", e);
        return;
      }
      const tbody = $("debtRows");
      if (!tbody) return;
      tbody.innerHTML = "";

      let sumAccrued = 0;
      let sumPaid = 0;
      let sumPenaltyAccrued = 0;

      let curMonthKey = null;
      let curMonthAccrued = 0;
      let curMonthPaidCum = 0;

      let penaltyBySourceMonth = {};
      try {
        if (typeof eng.calcPenaltyBreakdownBySourceMonth === "function") {
          penaltyBySourceMonth = eng.calcPenaltyBreakdownBySourceMonth(
            baseRows,
            asOfFinal,
            { abonentId: ctx.abonentId, applyAdvanceOffset: true, allowNegativePrincipal: true }
          ) || {};
        }
      } catch (e) {
        if (isRatesFatalError(e)) {
          logRatesFatal(e);
          showFatal(RATES_FATAL_MESSAGE);
          return;
        }
        if (isStartDateFatalError(e)) {
          logStartDateFatal(e);
          showFatal(START_DATE_FATAL_MESSAGE);
          return;
        }
        if (isExcludesFatalError(e)) {
          logExcludesFatal(e);
          showFatal(EXCLUDES_FATAL_MESSAGE);
          return;
        }
        penaltyBySourceMonth = {};
      }

      function isFirstRowOfMonth(mk){ return curMonthKey !== mk; }

      for (const r of viewRows){
        const y = parseInt(r.year, 10);
        const m = parseInt(r.month, 10);
        const mk = monthKey(y, m);
        const firstInMonth = isFirstRowOfMonth(mk);

        if (firstInMonth){
          curMonthKey = mk;
          curMonthAccrued = 0;
          curMonthPaidCum = 0;
        }

        const acc = eng.toNum(r.accrued);
        const paid = eng.toNum(r.paid);

        curMonthAccrued = eng.r2(curMonthAccrued + acc);
        curMonthPaidCum = eng.r2(curMonthPaidCum + paid);

        const monthDebtMain = eng.r2(Math.max(curMonthAccrued - curMonthPaidCum, 0));

        let monthDebtPenalty = 0;
        if (firstInMonth){
          const v = penaltyBySourceMonth[mk];
          monthDebtPenalty = (typeof v === "number") ? v : 0;
        }

        const monthDebtTotal = eng.r2(monthDebtMain + monthDebtPenalty);

        sumAccrued = eng.r2(sumAccrued + acc);
        sumPaid = eng.r2(sumPaid + paid);

        if (typeof CRITICAL_ASSERT === "function") {
          CRITICAL_ASSERT(Number.isFinite(monthDebtMain), "Court: monthDebtMain not finite", { mk: mk, monthDebtMain: monthDebtMain, r: r });
          CRITICAL_ASSERT(monthDebtPenalty >= -0.01, "Court: penalty negative", { mk: mk, monthDebtPenalty: monthDebtPenalty, r: r });
        }

        renderRow(tbody, {
          period: y + " " + monthNameRU(m),
          accrued: moneyDot(acc),
          paid: moneyDot(paid),
          paidDate: (paid > 0) ? (r.paid_date || "") : "",
          monthDebtMain: moneyDot(monthDebtMain),
          monthDebtPenalty: moneyDot(monthDebtPenalty),
          monthDebtTotal: moneyDot(monthDebtTotal)
        });
      }

      let finalTotals;
      try {
        finalTotals = eng.calcTotalsAsOfAdjusted(baseRows, asOfFinal, {
          abonentId: ctx.abonentId,
          applyAdvanceOffset: true,
          allowNegativePrincipal: true
        });
      } catch (e) {
        if (isRatesFatalError(e)) {
          logRatesFatal(e);
          showFatal(RATES_FATAL_MESSAGE);
          return;
        }
        if (isExcludesFatalError(e)) {
          logExcludesFatal(e);
          showFatal(EXCLUDES_FATAL_MESSAGE);
          return;
        }
        console.error("[spravka_sud] calcTotals failed", e);
        return;
      }

      if (!Number.isFinite(finalTotals.total)) {
        showFatal("Ошибка расчёта: отсутствуют необходимые данные для вычисления задолженности.");
        return;
      }

      setText("sumAccrued", moneyDot(sumAccrued));
      setText("sumPaid", moneyDot(sumPaid));
      setText("sumPenalty", moneyDot(sumPenaltyAccrued));

      setText("sumMainDebt", moneyDot(finalTotals.principal));
      setText("sumDebtPenalty", moneyDot(finalTotals.penaltyDebt));
      setText("sumTotalDebt", moneyDot(finalTotals.total));
      showDerivedProgress("");
      try { console.log("[reports][derived-calc-done]", { page: "spravka_sud", abonentId: ctx.abonentId, rows: Array.isArray(viewRows) ? viewRows.length : 0 }); } catch(eDerivedDone) {}

      setText("mainDebt", moneyDot(finalTotals.principal));
      setText("peniDebt", moneyDot(finalTotals.penaltyDebt));
      setText("totalDebt", moneyDot(finalTotals.total));

      const notesEl = $("notes");
      if (notesEl){
        const keyNotes = "notes_" + ctx.abonentId;
        const stored = storeGet(keyNotes, ctx.readOwner);
        if (stored !== null) notesEl.value = stored;
        notesEl.addEventListener("input", function(){
          try { console.warn("[reports][write-blocked-readonly]", { page: "spravka_sud", key: keyNotes, ownerId: ctx.readOwner, source: "notes" }); } catch(e) {}
        });
      }

      devLog(devMode, "diagnostics", {
        abonentId: ctx.abonentId,
        abonentFound: !!abonent,
        startDate: abonentStart ? eng.toISODateString(abonentStart) : "",
        startDateSource: startResolved.source,
        reportPeriod: period,
        periodSource: periodSource,
        paymentsRows: allRows.length,
        organizationRequisitesFound: !!(req && Object.keys(req).length),
        organizationSignersFound: Array.isArray(signers) && signers.length > 0,
        selectedSigner: signer ? {
          fio: String(signer.fio || ""),
          position: String(signer.position || ""),
          basis: String(signer.basis || "")
        } : null,
        jkhDataStatus: String((window.JKH_UI_STATE && window.JKH_UI_STATE.data && window.JKH_UI_STATE.data.status) || ""),
        ownerContext: ctx
      });
      } catch (e) {
        if (isRatesFatalError(e)) {
          logRatesFatal(e);
          showFatal(RATES_FATAL_MESSAGE);
          return;
        }
        if (isStartDateFatalError(e)) {
          logStartDateFatal(e);
          showFatal(START_DATE_FATAL_MESSAGE);
          return;
        }
        if (isExcludesFatalError(e)) {
          logExcludesFatal(e);
          showFatal(EXCLUDES_FATAL_MESSAGE);
          return;
        }
        throw e;
      } finally {
        window.JKHCalcEngine.onMissingRate = previousMissingRateHandler;
      }
    })();
  });
})();
