/* ============================================================
   🔒 CRITICAL — НЕ ТРОГАТЬ (ПАПАЖКХ)
   Doc: docs/LOGIC_SPEC_v1.5.3.md  |  Date: 2026-01-27
   Эталон архива: jkh_site_full_v01.27.3.zip
   SHA256: 6b4254a9b3b74327fe2d2c48c34e3e446ba9ae4e3369c6c554a683bde7b6ceec

   1) Карточка абонента (UI) = ИСТОЧНИК ИСТИНЫ (source of truth).
      Любые отчёты/справки — производные и НЕ имеют права менять логику карточки.

   2) payments_<LS> — помесячный ledger (НЕ журнал событий).
      В одном месяце допускается несколько строк (начисление + оплаты).

   3) "Оплата за период" (use_period/pay_for_period) влияет ТОЛЬКО на пеню.
      Запрещена ретро-перезапись: дата фактической оплаты не меняется.

   4) Исключённые периоды отключают ТОЛЬКО пеню, основной долг не трогают.

   5) ES-modules (type="module", import/export) в v1.5.x ЗАПРЕЩЕНЫ:
      проект должен работать в режиме file:// без сервера.

   Любая правка этого блока/связанных расчётов → только через новую версию SPEC.
   ============================================================ */

// spravka_sud.js
// ✅ CRITICAL v1.6 CANON (ПАПАЖКХ):
// Дата начала расчёта справки для суда = "Дата начала расчёта абонента"
// ("с какого дня месяца начать начислять").
// Источник: abonent.calcStartDate (приоритет) → activeLink.dateFrom → fallback.
// Если выбранный период начинается раньше — period.from режем снизу.
//
// ✅ FIX for namespaced storage:
// В некоторых версиях проекта window.AbonentsDB НЕ создаётся на странице,
// а база лежит в localStorage по ключам вида:
//   jkhdb::u_xxx::abonents_db_v1
// Поэтому здесь есть детектор, который находит базу, содержащую abonentId.
//
// Требует: calc_engine.js (window.JKHCalcEngine)

(function () {
  if (window.__SPRAVKA_SUD_JS_LOADED__) return;
  window.__SPRAVKA_SUD_JS_LOADED__ = true;

  function $(id){ return document.getElementById(id); }

  function safeJSONParse(raw, def){
    try{ return JSON.parse(raw); }catch(e){ return def; }
  }

  function safeJSON(key, def){
    try{
      const raw = localStorage.getItem(key);
      if (!raw) return def;
      return JSON.parse(raw);
    }catch(e){ return def; }
  }

  function setText(id, txt){
    const el = $(id);
    if (el) el.textContent = txt;
  }

  function moneyDot(x){
    const v = (Math.round((Number(x)||0)*100)/100).toFixed(2);
    return v;
  }

  function monthNameRU(m){
    return ["","январь","февраль","март","апрель","май","июнь","июль","август","сентябрь","октябрь","ноябрь","декабрь"][m] || "";
  }

  function fmtDateRuAny(any){
    const eng = window.JKHCalcEngine;
    const d = eng?.parseDateAnyToDate(any);
    if (!d) return "";
    const months = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} года`;
  }

  function loadSelectedPeriod(ls){
    function parsePeriod(raw){
      try{
        const o = JSON.parse(raw);
        if (!o || !o.from || !o.to) return null;
        return { from:String(o.from), to:String(o.to) };
      }catch(e){ return null; }
    }
    const rp = localStorage.getItem("report_period_" + ls);
    const cp = localStorage.getItem("calc_period_" + ls);
    return parsePeriod(rp) || parsePeriod(cp);
  }

  // ------------------------------------------------------------
  // ✅ DETECTOR: find AbonentsDB in namespaced localStorage
  // ------------------------------------------------------------
  function loadAbonentsDbCandidateKeys(){
    const out = [];
    try{
      const keys = Object.keys(localStorage);
      for (const k of keys){
        const lk = String(k).toLowerCase();
        // поддержим и старый формат "abonents_db_v1", и namespaced "::abonents_db_v1"
        if (lk === "abonents_db_v1" || lk.endsWith("::abonents_db_v1")) out.push(k);
      }
    }catch(e){}
    return out;
  }

  function normalizeDbRoot(obj){
    if (!obj || typeof obj !== "object") return null;
    // ожидаем {abonents:{}, premises:{}, links:[]}
    const abonents = (obj.abonents && typeof obj.abonents === "object") ? obj.abonents : null;
    if (!abonents) return null;
    if (!obj.links) obj.links = [];
    if (!obj.premises) obj.premises = {};
    return obj;
  }

  function getDbRootForAbonent(abonentId){
    // 1) если window.AbonentsDB есть — используем
    if (window.AbonentsDB && window.AbonentsDB.abonents){
      const db = normalizeDbRoot(window.AbonentsDB);
      if (db && db.abonents && db.abonents[String(abonentId)]) return db;
    }

    // 2) иначе ищем в localStorage по ключам *abonents_db_v1*
    const keys = loadAbonentsDbCandidateKeys();
    let firstValid = null;

    for (const k of keys){
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const data = safeJSONParse(raw, null);
      const db = normalizeDbRoot(data);
      if (!db) continue;

      if (!firstValid) firstValid = db;
      if (db.abonents && db.abonents[String(abonentId)]) return db; // ✅ нашли нужную базу
    }

    // 3) fallback: хоть какая-то валидная база
    return firstValid;
  }

  // активная связь абонент↔квартира (dateFrom/dateTo)
  function getActiveLinkForAbonent(dbRoot, abonentId){
    try{
      const links = Array.isArray(dbRoot?.links) ? dbRoot.links : [];
      const id = String(abonentId || "");
      const mine = links.filter(l => String(l?.abonentId || "") === id);

      if (!mine.length) return null;
      // активная = без dateTo
      const active = mine.find(l => !String(l?.dateTo || "").trim());
      return active || mine[0] || null;
    }catch(e){ return null; }
  }

  function renderRow(tbody, cells){
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${cells.period}</td>
      <td class="align-right">${cells.accrued}</td>
      <td class="align-right">${cells.paid}</td>
      <td>${cells.paidDate}</td>
      <td class="align-right">${cells.monthDebtMain}</td>
      <td class="align-right">${cells.monthDebtPenalty}</td>
      <td class="align-right">${cells.monthDebtTotal}</td>
    `;
    tbody.appendChild(tr);
  }

  function monthKey(y,m){ return `${y}-${String(m).padStart(2,"0")}`; }

  document.addEventListener("DOMContentLoaded", function () {
    const eng = window.JKHCalcEngine;
    if (!eng){
      console.error("JKHCalcEngine not found. calc_engine.js is not loaded.");
      alert("Не найден calc_engine.js. Проверь, что он подключён ПЕРЕД spravka_sud.js");
      return;
    }

    const ls = (function(){
      try{
        const p = new URLSearchParams(location.search);
        return p.get("abonent") || "";
      }catch(e){ return ""; }
    })();
    if (!ls) return;

    // ✅ получаем правильную БД (в т.ч. namespaced)
    const dbRoot = getDbRootForAbonent(ls);

    // реквизиты
    const req = safeJSON("organization_requisites_v1", {}) || {};
    function setReqRow(rowId, spanId, value) {
      const v = (value == null ? "" : String(value)).trim();
      const row = document.getElementById(rowId);
      if (row) row.style.display = v ? "" : "none";
      setText(spanId, v);
      return !!v;
    }
    const has1 = setReqRow("orgRowName", "orgName", req.full_name);
    const has2 = setReqRow("orgRowInn", "orgInn", req.inn);
    const has3 = setReqRow("orgRowLegal", "orgLegal", req.legal_address);
    const has4 = setReqRow("orgRowPostal", "orgPostal", req.postal_address);
    const has5 = setReqRow("orgRowPhone", "orgPhone", req.phone);
    const has6 = setReqRow("orgRowEmail", "orgEmail", req.email);
    const orgHeader = document.getElementById("orgHeader");
    if (orgHeader && !(has1 || has2 || has3 || has4 || has5 || has6)) orgHeader.style.display = "none";

    // подписант
    const signers = safeJSON("organization_signers_v1", []) || [];
    const activeS = Array.isArray(signers) ? signers.filter(s => s && s.active !== false) : [];
    const signer = activeS.find(s => s.is_default) || activeS[0] || null;
    if (signer) {
      setText("signerPosition", (signer.position || "Председатель правления").trim());
      setText("chairmanName", (signer.fio || "").trim());
      const basis = (signer.basis || "").trim();
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

    // абонент
    const abonent = (dbRoot && dbRoot.abonents && dbRoot.abonents[String(ls)]) ? dbRoot.abonents[String(ls)] : null;

    if (abonent){
      setText("fio", abonent.fio || "");
      setText("address", [abonent.city, abonent.street, abonent.house, abonent.flat].filter(Boolean).join(", "));
      setText("square", abonent.square || "");
      setText("rooms", abonent.rooms || "");
      setText("share", abonent.share || "");
    }

    // ===== CRITICAL: определяем дату начала расчёта абонента =====
    let abonentStart = null;

    // 1) abonent.calcStartDate (главный источник)
    const calcStartRaw = String(abonent?.calcStartDate || "").trim();
    if (calcStartRaw) {
      const d = eng.parseDateAnyToDate(calcStartRaw);
      if (d) abonentStart = eng.startOfDay(d);
    }

    // 2) если нет calcStartDate — берём activeLink.dateFrom (fallback)
    if (!abonentStart) {
      const link = getActiveLinkForAbonent(dbRoot, ls);
      const linkFrom = String(link?.dateFrom || "").trim();
      if (linkFrom) {
        const d = eng.parseDateAnyToDate(linkFrom);
        if (d) abonentStart = eng.startOfDay(d);
      }
    }

    // 3) период (выбранный/авто) + нижняя отсечка от abonentStart
    let period = loadSelectedPeriod(ls);

    if (!period){
      let fromISO = null;

      if (abonentStart){
        fromISO = eng.toISODateString(abonentStart);
      } else {
        // самый последний fallback (старые базы)
        const r = eng.getActiveResponsibilityRangeISO(ls);
        fromISO = r?.from || "2000-01-01";
      }

      const now = new Date();
      period = { from: String(fromISO), to: eng.toISODateString(now) };
    } else if (abonentStart) {
      const pFrom = eng.parseDateAnyToDate(period.from);
      if (pFrom && eng.startOfDay(pFrom) < abonentStart) {
        period.from = eng.toISODateString(abonentStart);
      }
    }

    setText("period_from", fmtDateRuAny(period.from));
    setText("period_to", fmtDateRuAny(period.to));

    // итоговая дата — конец месяца period.to (как карточка)
    const toD = eng.parseDateAnyToDate(period.to) || new Date();
    const asOfFinal = eng.endOfMonth(toD);

    setText("stateDate", fmtDateRuAny(asOfFinal));
    setText("docDate", fmtDateRuAny(new Date()));

    // данные оплат/начислений
    const allRowsRaw = safeJSON("payments_" + ls, []);
    const allRows = Array.isArray(allRowsRaw) ? allRowsRaw : [];

    // фильтр по месяцам периода
    const fromD = eng.parseDateAnyToDate(period.from);
    const toD2  = eng.parseDateAnyToDate(period.to);
    let baseRows = allRows;

    if (fromD && toD2){
      const fromKey = (fromD.getFullYear()*12)+(fromD.getMonth()+1);
      const toKey = (toD2.getFullYear()*12)+(toD2.getMonth()+1);
      baseRows = allRows.filter(r => {
        const y = parseInt(r?.year,10);
        const m = parseInt(r?.month,10);
        if (!(Number.isFinite(y) && Number.isFinite(m) && y>0 && m>=1 && m<=12)) return false;
        const k = (y*12)+m;
        return k>=fromKey && k<=toKey;
      });
    }

    const viewRows = eng.buildCourtViewRows(baseRows, period);

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
          { abonentId: ls, applyAdvanceOffset: true, allowNegativePrincipal: true }
        ) || {};
      }
    } catch (e) {
      penaltyBySourceMonth = {};
    }

    function isFirstRowOfMonth(mk){ return curMonthKey !== mk; }

    for (const r of viewRows){
      const y = parseInt(r.year,10);
      const m = parseInt(r.month,10);
      const mk = monthKey(y,m);
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
        CRITICAL_ASSERT(Number.isFinite(monthDebtMain), "Court: monthDebtMain not finite", { mk, monthDebtMain, r });
        CRITICAL_ASSERT(monthDebtPenalty >= -0.01, "Court: penalty negative", { mk, monthDebtPenalty, r });
      }

      renderRow(tbody, {
        period: `${y} ${monthNameRU(m)}`,
        accrued: moneyDot(acc),
        paid: moneyDot(paid),
        paidDate: (paid > 0) ? (r.paid_date || "") : "",
        monthDebtMain: moneyDot(monthDebtMain),
        monthDebtPenalty: moneyDot(monthDebtPenalty),
        monthDebtTotal: moneyDot(monthDebtTotal)
      });
    }

    const finalTotals = eng.calcTotalsAsOfAdjusted(baseRows, asOfFinal, {
      abonentId: ls, applyAdvanceOffset: true, allowNegativePrincipal: true
    });

    setText("sumAccrued", moneyDot(sumAccrued));
    setText("sumPaid", moneyDot(sumPaid));
    setText("sumPenalty", moneyDot(sumPenaltyAccrued));

    setText("sumMainDebt", moneyDot(finalTotals.principal));
    setText("sumDebtPenalty", moneyDot(finalTotals.penaltyDebt));
    setText("sumTotalDebt", moneyDot(finalTotals.total));

    setText("mainDebt", moneyDot(finalTotals.principal));
    setText("peniDebt", moneyDot(finalTotals.penaltyDebt));
    setText("totalDebt", moneyDot(finalTotals.total));

    // notes
    const notesEl = $("notes");
    if (notesEl){
      const keyNotes = "notes_" + ls;
      const stored = localStorage.getItem(keyNotes);
      if (stored !== null) notesEl.value = stored;
      notesEl.addEventListener("input", function(){
        localStorage.setItem(keyNotes, notesEl.value);
      });
    }
  });
})();
