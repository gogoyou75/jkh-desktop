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

  function safeJSON(key, def, ownerId){
    try {
      const raw = storeGet(key, ownerId);
      if (!raw) return def;
      return JSON.parse(raw);
    } catch (e) { return def; }
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

  function loadSelectedPeriod(ls, ownerId){
    function parsePeriod(raw){
      try {
        const o = JSON.parse(raw);
        if (!o || !o.from || !o.to) return null;
        return { from: String(o.from), to: String(o.to) };
      } catch (e) { return null; }
    }
    const rp = storeGet("report_period_" + ls, ownerId);
    const cp = storeGet("calc_period_" + ls, ownerId);
    return parsePeriod(rp) || parsePeriod(cp);
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
    const dbKey = getDbKeyFromURL();
    const forcedOwner = extractOwnerFromScopedDbKey(dbKey);
    let currentOwner = "";
    try { currentOwner = String(window.JKHStore && JKHStore.getOwnerId ? (JKHStore.getOwnerId() || "") : ""); } catch (e) {}
    const readOwner = forcedOwner || currentOwner || "";
    return {
      abonentId: abonentId,
      dbKey: dbKey,
      forcedOwner: forcedOwner,
      currentOwner: currentOwner,
      readOwner: readOwner
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
      console.warn("[spravka_sud][payment-key] blocked", { abonentId: abonentId, reason: "UID_REQUIRED" });
      return "";
    }

    try {
      if (typeof window.getPaymentsKeyForAbonent === "function") {
        const key = String(window.getPaymentsKeyForAbonent(abonentId) || "").trim();
        if (key) {
          console.log("[spravka_sud][payment-key] uid", { abonentId: abonentId, key: key });
          return key;
        }
      }
    } catch (e) {}

    const dbRoot = getDbRootForContext(ctx);
    const abonent = dbRoot && dbRoot.abonents ? dbRoot.abonents[abonentId] : null;
    const uid = String((abonent && abonent.uid) || "").trim();
    if (uid) {
      const key = "payments_" + uid;
      console.log("[spravka_sud][payment-key] uid", { abonentId: abonentId, key: key });
      return key;
    }

    console.warn("[spravka_sud][payment-key] blocked", { abonentId: abonentId, reason: "UID_REQUIRED" });
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

  function firstValidDate(eng, values){
    for (let i = 0; i < values.length; i++) {
      const raw = String(values[i] || "").trim();
      if (!raw) continue;
      const d = eng.parseDateAnyToDate(raw);
      if (d) return d;
    }
    return null;
  }

  function resolveAbonentStartDate(eng, abonent, activeLink, abonentId){
    const result = { date: null, source: "" };

    const d1 = firstValidDate(eng, [abonent && abonent.calcStartDate]);
    if (d1) return { date: eng.startOfDay(d1), source: "abonent.calcStartDate" };

    const d2 = firstValidDate(eng, [activeLink && activeLink.dateFrom]);
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
    ]);
    if (d3) return { date: eng.startOfDay(d3), source: "abonent.compat.startDateField" };

    try {
      const r = eng.getActiveResponsibilityRangeISO(abonentId);
      const d4 = firstValidDate(eng, [r && r.from]);
      if (d4) return { date: eng.startOfDay(d4), source: "calcEngine.getActiveResponsibilityRangeISO" };
    } catch (e) {}

    const fallback = eng.startOfDay(new Date(2000, 0, 1));
    console.warn("[spravka_sud] fallback start date applied", {
      reason: "no abonent start date sources",
      abonentId: String(abonentId || "")
    });
    result.date = fallback;
    result.source = "fallback:2000-01-01";
    return result;
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

  function showFatal(msg, details){
    console.error("[spravka_sud] " + msg, details || {});
    alert(msg);
    const tbody = $("debtRows");
    if (tbody) {
      tbody.innerHTML = "<tr><td colspan=\"7\" style=\"color:#b00000;font-weight:bold;\">" + msg + "</td></tr>";
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    (async function () {
      const eng = window.JKHCalcEngine;
      const devMode = isDevMode();

      if (!eng){
        showFatal("Не найден calc_engine.js. Проверь, что он подключён ПЕРЕД spravka_sud.js");
        return;
      }

      window.JKHCalcEngine.onMissingRate = function(info){
        console.error("[spravka_sud] missing rate detected", info);

        showFatal(
          "Невозможно построить справку: отсутствует ставка рефинансирования для части периода. " +
          "Проверьте даты начислений и таблицу ставок."
        );

        throw new Error("MISSING_REQUIRED_RATE");
      };

      const ctx = getContext();
      if (!ctx.abonentId) {
        showFatal("Не передан параметр abonent в URL.");
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

      let period = loadSelectedPeriod(ctx.abonentId, ctx.readOwner);
      let periodSource = period ? "stored report/calc period" : "auto from start date";
      if (!period) {
        period = { from: eng.toISODateString(abonentStart), to: eng.toISODateString(new Date()) };
      } else {
        const pFrom = eng.parseDateAnyToDate(period.from);
        if (pFrom && eng.startOfDay(pFrom) < abonentStart) {
          period.from = eng.toISODateString(abonentStart);
          periodSource += " + clampedToAbonentStart";
        }
      }

      setText("period_from", fmtDateRuAny(period.from));
      setText("period_to", fmtDateRuAny(period.to));

      const toD = eng.parseDateAnyToDate(period.to) || new Date();
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
      let allRowsRaw = safeJSON(paymentsKey, [], ctx.readOwner);
      let allRows = Array.isArray(allRowsRaw) ? allRowsRaw : [];
      const hasLedger = hasUsableLedgerRows(allRows);
      console.log('[spravka_sud][ledger-check] id=' + ctx.abonentId + ' len=' + allRows.length);
      if (!hasLedger) {
        let recalcResult = { changed: false, reason: 'autoaccrual-unavailable' };
        if (window.JKHAutoAccrual && typeof window.JKHAutoAccrual.recalcForAbonent === 'function') {
          recalcResult = await window.JKHAutoAccrual.recalcForAbonent(ctx.abonentId);
        }
        console.log('[spravka_sud][autoaccrual] recalc result=', recalcResult);
        if (recalcResult && recalcResult.changed === true && window.Data && typeof Data.flushDbToServer === 'function') {
          try {
            await Data.flushDbToServer();
            console.log('[spravka_sud][autoaccrual] flush ok');
          } catch (e) {
            console.warn('[spravka_sud][autoaccrual] flush failed but continue', e);
          }
        }

        allRowsRaw = safeJSON(paymentsKey, [], ctx.readOwner);
        allRows = Array.isArray(allRowsRaw) ? allRowsRaw : [];

        console.log('[spravka_sud][ledger-after-recalc] id=' + ctx.abonentId + ' len=' + allRows.length);
      } else {
        console.log('[spravka_sud][autoaccrual] skipped existing ledger');
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

      setText("mainDebt", moneyDot(finalTotals.principal));
      setText("peniDebt", moneyDot(finalTotals.penaltyDebt));
      setText("totalDebt", moneyDot(finalTotals.total));

      const notesEl = $("notes");
      if (notesEl){
        const keyNotes = "notes_" + ctx.abonentId;
        const stored = storeGet(keyNotes, ctx.readOwner);
        if (stored !== null) notesEl.value = stored;
        notesEl.addEventListener("input", function(){
          if (window.JKHStore && typeof JKHStore.setRaw === "function") {
            JKHStore.setRaw(keyNotes, notesEl.value, ctx.readOwner);
          }
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
    })();
  });
})();
