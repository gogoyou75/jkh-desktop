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
      Запрещена ретро‑перезапись: дата фактической оплаты не меняется.

   4) Исключённые периоды отключают ТОЛЬКО пеню, основной долг не трогают.

   5) ES-modules (type="module", import/export) в v1.5.x ЗАПРЕЩЕНЫ:
      проект должен работать в режиме file:// без сервера.

   Любая правка этого блока/связанных расчётов → только через новую версию SPEC.
   ============================================================ */

// spravka_sud.js
// Variant B (court view):
// - каждый платёж отдельной строкой
// - первый платёж месяца совмещаем с начислением
// - "МЕсячная задолженность" (3 колонки) = строго за МЕСЯЦ, НЕ нарастающим итогом
// - итоговый блок внизу ("по состоянию") = на конец месяца period.to и должен совпадать с карточкой
//
// ✅ NEW (CRITICAL): "Пеня за месяц" в справке группируется по МЕСЯЦУ-ИСТОЧНИКУ ДОЛГА,
// т.е. по месяцу начисления основного обязательства (year/month строки), а НЕ по месяцу
// фактического начисления пени.
// Пример: пеня, начисленная в октябре за августовский долг, показывается в строке "Август".
//
// Требует: calc_engine.js (window.JKHCalcEngine)

(function () {
  if (window.__SPRAVKA_SUD_JS_LOADED__) return;
  window.__SPRAVKA_SUD_JS_LOADED__ = true;
  function $(id){ return document.getElementById(id); }

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

  function uniq(arr){
    const s = new Set();
    const out = [];
    for (const x of arr){
      if (!s.has(x)){ s.add(x); out.push(x); }
    }
    return out;
  }

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

    // реквизиты (страница "Реквизиты организации" сохраняет в localStorage)
    const req = safeJSON("organization_requisites_v1", {}) || {};

    // показываем строку ТОЛЬКО если заполнено значение
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
    if (orgHeader && !(has1 || has2 || has3 || has4 || has5 || has6)) {
      orgHeader.style.display = "none";
    }

    // подписант (Председатель) — берём из localStorage, не "из воздуха"
    const signers = safeJSON("organization_signers_v1", []) || [];
    const active = Array.isArray(signers) ? signers.filter(s => s && s.active !== false) : [];
    let signer = active.find(s => s.is_default) || active[0] || null;

    if (signer) {
      setText("signerPosition", (signer.position || "Председатель правления").trim());
      setText("chairmanName", (signer.fio || "").trim());
      const basis = (signer.basis || "").trim();
      const basisLine = document.getElementById("basisLine");
      if (basisLine) basisLine.style.display = basis ? "" : "none";
      setText("signerBasisText", basis);
    } else {
      // если подписанты не заведены — оставляем типовой шаблон, но без "подтягиваний" из других мест
      setText("signerPosition", "Председатель правления");
      setText("chairmanName", "");
      const basisLine = document.getElementById("basisLine");
      if (basisLine) basisLine.style.display = "none";
      setText("signerBasisText", "");
    }

    // абонент

    const abonent = (window.AbonentsDB && window.AbonentsDB.abonents && window.AbonentsDB.abonents[String(ls)]) || null;
    if (abonent){
      setText("fio", abonent.fio || "");
      setText("address", [abonent.city, abonent.street, abonent.house, abonent.flat].filter(Boolean).join(", "));
      setText("square", abonent.square || "");
      setText("rooms", abonent.rooms || "");
      setText("share", abonent.share || "");
    }

    // период
    let period = loadSelectedPeriod(ls);
    if (!period){
      const r = eng.getActiveResponsibilityRangeISO(ls);
      const from = r?.from || "2000-01-01";
      const now = new Date();
      period = { from, to: eng.toISODateString(now) };
    }

    setText("period_from", fmtDateRuAny(period.from));
    setText("period_to", fmtDateRuAny(period.to));

    // итоговая дата — конец месяца period.to (как карточка)
    const toD = eng.parseDateAnyToDate(period.to) || new Date();
    const asOfFinal = eng.endOfMonth(toD);

    setText("stateDate", fmtDateRuAny(asOfFinal));
    setText("docDate", fmtDateRuAny(new Date()));

    // ✅ начало периода для "пени за период справки"
    const fromD = eng.parseDateAnyToDate(period.from);
    const reportStart = fromD ? eng.startOfDay(fromD) : eng.startOfDay(new Date(2000,0,1));

    // данные оплат/начислений
    const allRowsRaw = safeJSON("payments_" + ls, []);
    const allRows = Array.isArray(allRowsRaw) ? allRowsRaw : [];

    // фильтр по месяцам периода
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

    // viewRows: первый платёж объединён с начислением, остальные платежи отдельными строками
    const viewRows = eng.buildCourtViewRows(baseRows, period);

    const tbody = $("debtRows");
    if (!tbody) return;
    tbody.innerHTML = "";

    // totals for footer
    let sumAccrued = 0;
    let sumPaid = 0;
    let sumPenaltyAccrued = 0; // ✅ теперь суммируем ПО МЕСЯЦАМ (один раз на месяц)

    // Для "месячной задолженности" считаем ВНУТРИ МЕСЯЦА:
    // monthDebtMain = max(monthAccrued - monthPaidCumulative, 0)
    let curMonthKey = null;
    let curMonthAccrued = 0;
    let curMonthPaidCum = 0;
    // ----------------------------------------------------------------------
    // 🔒 CRITICAL (Справка для суда):
    // Колонка "по пени" в строке месяца = ВСЯ пеня, начисленная на ДОЛГ этого месяца-источника
    // за весь период до даты справки (asOfFinal).
    //
    // Карточку абонента НЕ трогаем (она эталон).
    // Справка берёт только "разбивку по месяцу-источнику" из движка, чтобы модули не ломали друг друга.
    // ----------------------------------------------------------------------
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

    // helpers
    function isFirstRowOfMonth(mk){
      return curMonthKey !== mk;
    }

    
    for (const r of viewRows){
      const y = parseInt(r.year,10);
      const m = parseInt(r.month,10);
      const mk = monthKey(y,m);

      const firstInMonth = isFirstRowOfMonth(mk);

      // смена месяца: сбрасываем внутрь-месяца накопления
      if (firstInMonth){
        curMonthKey = mk;
        curMonthAccrued = 0;
        curMonthPaidCum = 0;
      }

      // обновляем начисление/оплату внутри месяца
      const acc = eng.toNum(r.accrued);
      const paid = eng.toNum(r.paid);
      curMonthAccrued = eng.r2(curMonthAccrued + acc);
      curMonthPaidCum = eng.r2(curMonthPaidCum + paid);

      // месячная задолженность по платежу = остаток по этому МЕСЯЦУ
      let monthDebtMain = eng.r2(Math.max(curMonthAccrued - curMonthPaidCum, 0));

      // 🔒 CRITICAL: "по пени" в справке = вся пеня по месяцу-источнику долга на дату справки (asOfFinal).
      let monthDebtPenalty = 0;
      if (firstInMonth){
        const v = penaltyBySourceMonth[mk];
        monthDebtPenalty = (typeof v === "number") ? v : 0;
      }

      const monthDebtTotal = eng.r2(monthDebtMain + monthDebtPenalty);

      // footer accumulators
      sumAccrued = eng.r2(sumAccrued + acc);
      sumPaid = eng.r2(sumPaid + paid);
      // (Variant B) sumPenaltyAccrued не используется (колонка 'начислено пени' убрана)
      // 🔒 CRITICAL ASSERTS (DEV)
      if (typeof CRITICAL_ASSERT === "function") {
        CRITICAL_ASSERT(
          monthDebtMain <= curMonthAccrued + 0.001,
          "Court: monthly main debt became cumulative / invalid",
          { month: mk, curMonthAccrued, curMonthPaidCum, monthDebtMain, row: r }
        );
        CRITICAL_ASSERT(Number.isFinite(monthDebtMain), "Court: monthly main debt is not finite", { month: mk, monthDebtMain, row: r });
        CRITICAL_ASSERT(
          monthDebtPenalty >= -0.01,
          "Court: monthly penalty negative",
          { month: mk, monthDebtPenalty, row: r }
        );
        }

      renderRow(tbody, {
        period: `${y} ${monthNameRU(m)}`,
        accrued: moneyDot(acc),
        paid: moneyDot(paid),
        paidDate: (paid > 0) ? (r.paid_date || "") : "",
        penaltyAccrued: "",
        monthDebtMain: moneyDot(monthDebtMain),
        monthDebtPenalty: moneyDot(monthDebtPenalty),
        monthDebtTotal: moneyDot(monthDebtTotal)
      });
    }

    // 🔒 CRITICAL (COURT REPORT FINAL TOTAL)
    // Итоговые суммы внизу справки = нарастающий итог на asOfFinal, и должны совпадать с карточкой.
    const finalTotals = eng.calcTotalsAsOfAdjusted(baseRows, asOfFinal, { abonentId: ls, applyAdvanceOffset: true, allowNegativePrincipal: true });

    setText("sumAccrued", moneyDot(sumAccrued));
    setText("sumPaid", moneyDot(sumPaid));
    setText("sumPenalty", moneyDot(sumPenaltyAccrued)); // ✅ сумма "пени за период" по месяцам-источникам

    // В footer по "задолженности" показываем ИТОГОВЫЙ ДОЛГ (как карточка), а не сумму месячных строк.
    setText("sumMainDebt", moneyDot(finalTotals.principal));
    setText("sumDebtPenalty", moneyDot(finalTotals.penaltyDebt));
    setText("sumTotalDebt", moneyDot(finalTotals.total));

    setText("mainDebt", moneyDot(finalTotals.principal));
    setText("peniDebt", moneyDot(finalTotals.penaltyDebt));
    setText("totalDebt", moneyDot(finalTotals.total));

    if (typeof CRITICAL_ASSERT === "function") {
      CRITICAL_ASSERT(Number.isFinite(finalTotals.principal), "Court final: principal not finite", finalTotals);
      CRITICAL_ASSERT(Number.isFinite(finalTotals.penaltyDebt), "Court final: penalty not finite", finalTotals);
    }

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
