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

// ===============================
// DEV MODE + CRITICAL ASSERT (dev only)
// Включение: добавь ?dev=1 к URL или работай на localhost.
// ===============================
(function(){
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
// Использует localStorage + AbonentsDB (если есть) для периода ответственности.
// Платёж гасит: сначала ОСНОВНОЙ ДОЛГ (FIFO), потом ПЕНИ (если есть переплата).
(function () {
  if (window.JKHCalcEngine) return; // не переопределяем

  function pad2(n){ return String(n).padStart(2,"0"); }
  function r2(x){ return Math.round(x * 100) / 100; }
  function toNum(v){ const n = parseFloat(String(v ?? "").replace(/\s+/g,"").replace(",", ".")); return Number.isFinite(n) ? n : 0; }

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
  const REFI_KEY_NORMAL = (window.JKH_CONST && window.JKH_CONST.REFI_KEY_NORMAL) ? window.JKH_CONST.REFI_KEY_NORMAL : "refinancing_rates_normal_v1";
  const REFI_KEY_MORA   = (window.JKH_CONST && window.JKH_CONST.REFI_KEY_MORA)   ? window.JKH_CONST.REFI_KEY_MORA   : "refinancing_rates_moratorium_v1";

  function excludePeriodsKey(abonentId){ return "exclude_periods_" + String(abonentId || getAbonentIdFromUrl()); }
  function moratoriumKey(abonentId){ return "moratorium_" + String(abonentId || getAbonentIdFromUrl()); }
  function isMoratoriumActive(abonentId){ return localStorage.getItem(moratoriumKey(abonentId)) === "1"; }

  function loadExcludes(abonentId){
    try{
      const raw = localStorage.getItem(excludePeriodsKey(abonentId));
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      const startDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0,0);
      const endDay   = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23,59,59,999);
      return arr.map(x => {
        const fromRaw = x.from ?? x.dateFrom ?? x.start ?? x.fromISO ?? x.from_iso;
        const toRaw   = x.to   ?? x.dateTo   ?? x.end   ?? x.toISO   ?? x.to_iso;
        const from = parseDateAnyToDate(fromRaw);
        const to   = parseDateAnyToDate(toRaw);
        return { from: from ? startDay(from) : null, to: to ? endDay(to) : null };
      }).filter(x => x.from && x.to && x.to >= x.from);
    }catch(e){ return []; }
  }

  function isExcludedDay(d, excludes){
    const t = d.getTime();
    for (const p of excludes){
      if (t >= p.from.getTime() && t <= p.to.getTime()) return true;
    }
    return false;
  }

  function loadRates(abonentId){
    const key = isMoratoriumActive(abonentId) ? REFI_KEY_MORA : REFI_KEY_NORMAL;
    try{
      const raw = localStorage.getItem(key);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return arr.map(x => ({
        from: parseDateAnyToDate(x.from),
        rate: Number(String(x.rate ?? "").replace(",", "."))
      })).filter(x => x.from && Number.isFinite(x.rate))
        .sort((a,b)=>a.from-b.from);
    }catch(e){ return []; }
  }

  function rateOnDate(d, rates){
    const t = d.getTime();
    let cur = null;
    for (const r of rates){
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

  function buildPaymentEventsFromRows(rows, abonentId){
    const pays = [];
    const id = abonentId || getAbonentIdFromUrl();

    // Global "за период" toggle (если используется)
    let globalPeriod = null;
    try{
      const active = String(localStorage.getItem('calc_period_active_' + id) || '0') === '1';
      if (active){
        const raw = localStorage.getItem('calc_period_' + id);
        if (raw){
          const obj = JSON.parse(raw);
          if (obj && (obj.from || obj.to)){
            globalPeriod = { from: obj.from || '', to: obj.to || '' };
          }
        }
      }
    }catch(e){ /* ignore */ }

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

  function calcPenaltyForObligation(ob, asOf, excludes, rates){
    const asOfDay = startOfDay(asOf);
    if (asOfDay <= ob.dueDate) return 0;

    sortApplications(ob);

    let penalty = 0;
    let overdueIndex = 0;

    let day = addDays(ob.dueDate, 1);
    const hardLimit = addDays(ob.dueDate, 3650);
    const end = (asOfDay < hardLimit) ? asOfDay : hardLimit;

    while (day <= end){
      if (!isExcludedDay(day, excludes)){
        overdueIndex += 1;
        const applied = sumAppliedUpTo(ob, day);
        const principal = Math.max(ob.amount - applied, 0);

        if (principal > 0.0000001 && overdueIndex > 30){
          const denom = (overdueIndex <= 90) ? 300 : 130;
          const rawRate = rateOnDate(day, rates);
          const rate = Number.isFinite(rawRate) ? capRateUntil2027(day, rawRate) : 0;
          penalty += principal * (rate/100) / denom;
        }
      }
      day = addDays(day, 1);
    }
    return penalty;
  }

  // --------- CORE TOTALS ----------
  function calcTotalsAsOfCore(rows, asOfDate, opts){
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

      penaltyTotal += calcPenaltyForObligation(ob, asOfDate, excludes, rates);
    }

    const applyAdvanceOffset = !!(opts && opts.applyAdvanceOffset);
    const principalAdj = applyAdvanceOffset ? r2(principalTotal - advanceUpTo) : r2(principalTotal);

    return { principalAdj, penaltyAccruedTotal: r2(penaltyTotal), advanceUpTo: r2(advanceUpTo) };
  }

  // правило: переплата сначала гасит основной, потом пени
  function calcTotalsAsOfAdjusted(rows, asOfDate, opts){
    const core = calcTotalsAsOfCore(rows, asOfDate, opts);
    let principal = core.principalAdj;              // может быть отрицательным (аванс)
    let penaltyDebt = core.penaltyAccruedTotal;

    const allowNeg = !!(opts && opts.allowNegativePrincipal);

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


  window.JKHCalcEngine = {
    pad2, r2, toNum,
    parseDateAnyToDate,
    startOfDay,
    endOfMonth,
    endOfMonthDate,
    toISODateString,
    getAbonentIdFromUrl,
    getActiveResponsibilityRangeISO,
    loadExcludes,
    loadRates,
    calcTotalsAsOfAdjusted,
    calcTotalsAsOfCore,
    buildCourtViewRows,
    calcPenaltyBreakdownBySourceMonth
  };
})();
