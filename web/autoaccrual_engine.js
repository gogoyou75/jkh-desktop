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

/* ============================================================
   autoaccrual_engine.js
   Variant A (логика): единый движок авто-начислений, который
   можно вызывать из import_xls.html / new_abonent.html / tariffs.html

   Хранение:
   - payments_<LS>  (строки помесячно: accrued/paid/paid_date...)
   - tariffs_content_repair_v1
       ✅ поддерживаются ОБА формата:
       A) { tariffs:[{from:'YYYY-MM-DD', content, repair}] }
       B) { content:[{date:'YYYY-MM-DD', rate}], repair:[{date:'YYYY-MM-DD', rate}] }  (как в tariffs.html)

   Правила (CRITICAL):
   - начислять с даты начала (включительно)
   - начислять до конца периода ответственности (если dateTo задан), иначе до текущего месяца
   - 1 начисление на месяц: если в месяце несколько строк оплат, начисление только у строки с минимальным id
   - при смене ответственного в середине месяца: делим начисление пропорционально дням по AbonentsDB.links
       ✅ FIX: деление идёт от кол-ва дней в месяце (а не от totalDaysUsed),
              поэтому если право началось/закончилась не с 1-го числа — начисление корректно пропорционально.
   - при изменении тарифов:
       ✅ FIX: если тариф меняется ВНУТРИ месяца (например 15.08) — начисление делится пропорционально дням.
   ============================================================ */

(function(){
  const ENGINE_KEY = 'JKH_AUTOACCRUAL_ENGINE_v1';
  if (window[ENGINE_KEY]) return; // не подключать дважды

  const DAY_MS = 24*3600*1000;

  function pad2(n){ return String(n).padStart(2,'0'); }
  function r2(x){ return Math.round((Number(x)||0)*100)/100; }
  function toNum(v){
    const n = parseFloat(String(v ?? '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }

  function iso(y,m,d){ return `${y}-${pad2(m)}-${pad2(d)}`; }
  function isISODate(s){ return /^\d{4}-\d{2}-\d{2}$/.test(String(s||'')); }

  function parseAnyToISO(s){
    const v = String(s||'').trim();
    if (!v) return '';
    if (isISODate(v)) return v;
    const m = v.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
    return '';
  }

  function parseISOToDate(isoStr){
    const s = parseAnyToISO(isoStr);
    if (!s) return null;
    const [y,m,d] = s.split('-').map(x=>parseInt(x,10));
    if (!y || !m || !d) return null;
    return new Date(y, m-1, d, 12, 0, 0, 0);
  }

  function daysInMonth(y,m){
    return new Date(y, m, 0).getDate();
  }

  function monthIter(fromISO, toISO){
    const a = parseISOToDate(fromISO);
    const b = parseISOToDate(toISO) || new Date();
    if (!a || !b) return [];
    const start = new Date(a.getFullYear(), a.getMonth(), 1);
    const end = new Date(b.getFullYear(), b.getMonth(), 1);
    const out = [];
    let cur = new Date(start.getTime());
    while (cur <= end){
      out.push({ year: String(cur.getFullYear()), month: pad2(cur.getMonth()+1) });
      cur.setMonth(cur.getMonth()+1);
    }
    return out;
  }

  // ----------------------------
  // Period helpers (robust row -> YYYY-MM)
  // Some project versions store (year,month) numbers, others store strings like
  // "08.2025" or "АВГУСТ 2025". We normalize all of them.
  // ----------------------------
  const RU_MONTHS = {
    'ЯНВАРЬ':1,'ФЕВРАЛЬ':2,'МАРТ':3,'АПРЕЛЬ':4,'МАЙ':5,'ИЮНЬ':6,
    'ИЮЛЬ':7,'АВГУСТ':8,'СЕНТЯБРЬ':9,'ОКТЯБРЬ':10,'НОЯБРЬ':11,'ДЕКАБРЬ':12
  };

  function rowToYM(row){
    if (!row) return '';

    // 1) canonical numeric fields
    const y1 = parseInt(String(row.year ?? row.y ?? ''), 10);
    const m1 = parseInt(String(row.month ?? row.m ?? ''), 10);
    if (y1 && m1 && m1 >= 1 && m1 <= 12) return `${y1}-${pad2(m1)}`;

    // 2) ym: YYYY-MM
    const ym = String(row.ym ?? row.yearMonth ?? row.y_m ?? '').trim();
    if (/^\d{4}-\d{2}$/.test(ym)) return ym;

    // 3) period: MM.YYYY
    const p = String(row.period ?? row.period_from ?? row.period_to ?? '').trim();
    const mmY = p.match(/^(\d{1,2})\.(\d{4})$/);
    if (mmY){
      const m = parseInt(mmY[1],10); const y = parseInt(mmY[2],10);
      if (y && m>=1 && m<=12) return `${y}-${pad2(m)}`;
    }

    // 4) month name: "АВГУСТ 2025"
    const mn = String(row.month_name ?? row.monthName ?? row.monthTitle ?? row.title ?? '').trim();
    if (mn){
      const up = mn.toUpperCase().replace(/\s+/g,' ').trim();
      const m = up.match(/^(ЯНВАРЬ|ФЕВРАЛЬ|МАРТ|АПРЕЛЬ|МАЙ|ИЮНЬ|ИЮЛЬ|АВГУСТ|СЕНТЯБРЬ|ОКТЯБРЬ|НОЯБРЬ|ДЕКАБРЬ)\s+(\d{4})$/);
      if (m){
        const mo = RU_MONTHS[m[1]]; const y = parseInt(m[2],10);
        if (y && mo) return `${y}-${pad2(mo)}`;
      }
    }

    return '';
  }

  // ----------------------------
  // localStorage helpers
  // ----------------------------
  function paymentsKey(ls){ return `payments_${ls}`; }

  function loadPayments(ls){
    try{
      const raw = localStorage.getItem(paymentsKey(ls));
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function savePayments(ls, arr){
    try{ localStorage.setItem(paymentsKey(ls), JSON.stringify(arr||[])); } catch {}
  }

  // ----------------------------
  // Tariffs
  // ----------------------------
  const KNOWN_TARIFF_KEYS = [
    'tariffs_content_repair_v1',
    'tariffs_content_repair',
    'tariffs_table_v1',
    'tariffs_table',
    'tariffs_v3',
    'tariffs_v2',
    'tariffs_v1',
    'tariffs'
  ];

  // ✅ читает оба формата тарифов
  // A) {tariffs:[{from,content,repair}]}
  // B) {content:[{date,rate}], repair:[{date,rate}]}
  function extractTariffRowsFromParsed(data){
    if (!data || typeof data !== 'object') return null;

    if (Array.isArray(data?.tariffs)) return data.tariffs;
    if (Array.isArray(data)) return data;

    // format from tariffs.html
    if (Array.isArray(data?.content) || Array.isArray(data?.repair)){
      const m = new Map(); // from -> {from, content, repair}

      const put = (from, patch) => {
        if (!from) return;
        const cur = m.get(from) || { from, content: 0, repair: 0 };
        if ('content' in patch) cur.content = patch.content;
        if ('repair' in patch) cur.repair = patch.repair;
        m.set(from, cur);
      };

      (Array.isArray(data.content) ? data.content : []).forEach(x => {
        const from = parseAnyToISO(x?.date ?? x?.from ?? x?.start ?? x?.dateFrom);
        if (!from) return;
        put(from, { content: toNum(x?.rate) });
      });

      (Array.isArray(data.repair) ? data.repair : []).forEach(x => {
        const from = parseAnyToISO(x?.date ?? x?.from ?? x?.start ?? x?.dateFrom);
        if (!from) return;
        put(from, { repair: toNum(x?.rate) });
      });

      const rows = Array.from(m.values());
      rows.sort((a,b)=>String(a.from||'').localeCompare(String(b.from||'')));
      return rows;
    }

    return null;
  }

  function detectTariffTable(){
    // 1) known keys
    for (const k of KNOWN_TARIFF_KEYS){
      try{
        const raw = localStorage.getItem(k);
        if (!raw) continue;
        const data = JSON.parse(raw);
        const rows = extractTariffRowsFromParsed(data);
        if (Array.isArray(rows) && rows.length) return rows;
      } catch {}
    }
    // 2) scan localStorage for anything that looks like tariffs
    try{
      const ks = Object.keys(localStorage);
      for (const k of ks){
        if (!/tarif|тариф/i.test(k)) continue;
        const raw = localStorage.getItem(k);
        if (!raw) continue;
        try{
          const data = JSON.parse(raw);
          const rows = extractTariffRowsFromParsed(data);
          if (Array.isArray(rows) && rows.length) return rows;
        } catch {}
      }
    } catch {}
    return null;
  }

  function normalizeTariffs(rows){
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const r of rows){
      const from = parseAnyToISO(r?.from || r?.dateFrom || r?.start || r?.date || r?.Дата || r?.начало);
      if (!from) continue;
      const d = parseISOToDate(from);
      if (!d) continue;

      const content = toNum(r?.content ?? r?.soderzhanie ?? r?.Содержание ?? r?.content_rate ?? r?.rateContent ?? r?.tariffContent);
      const repair  = toNum(r?.repair  ?? r?.remont     ?? r?.Ремонт      ?? r?.repair_rate  ?? r?.rateRepair  ?? r?.tariffRepair);
      out.push({ from, content, repair, fromMs: d.getTime() });
    }
    out.sort((a,b)=>a.fromMs-b.fromMs);
    return out;
  }

  function tariffForMs(tariffsNorm, ms){
    let chosen = null;
    for (const r of tariffsNorm){
      if (r.fromMs <= ms) chosen = r;
      else break;
    }
    return chosen;
  }

  // ✅ FIX: сумма тарифа за месяц с учётом смены тарифа ВНУТРИ месяца
  function tariffSumForMonthProRated(month, year, sq){
    const rows = normalizeTariffs(detectTariffTable() || []);
    if (!rows.length || !(sq > 0)) return 0;

    const y = Number(year);
    const m = Number(month);
    const dim = daysInMonth(y, m);

    const monthStart = new Date(y, m-1, 1, 12,0,0,0);
    const monthEndExcl = new Date(y, m-1, dim+1, 12,0,0,0);
    const startMs = monthStart.getTime();
    const endMs = monthEndExcl.getTime();

    // точки смены тарифа внутри месяца
    const cuts = [startMs];
    for (const r of rows){
      if (r.fromMs > startMs && r.fromMs < endMs) cuts.push(r.fromMs);
    }
    cuts.push(endMs);
    cuts.sort((a,b)=>a-b);

    let total = 0;
    for (let i=0; i<cuts.length-1; i++){
      const segStart = cuts[i];
      const segEnd = cuts[i+1];
      if (segEnd <= segStart) continue;

      const chosen = tariffForMs(rows, segStart);
      if (!chosen) continue; // нет тарифа до начала сегмента

      const days = Math.round((segEnd - segStart) / DAY_MS);
      if (days <= 0) continue;

      const sumRate = (chosen.content + chosen.repair);
      total = r2(total + (sumRate * sq * (days / dim)));
    }

    return r2(total);
  }


  // ----------------------------
  // Dynamic tariffs (v1): supports BOTH
  // - type: "sqm"   (руб/м²)  -> рассчитывается через legacy tariffs_content_repair_v1, чтобы не было двойного счёта
  // - type: "fixed" (фикс/мес) -> рассчитывается здесь и добавляется к начислению
  //
  // Storage key: tariffs_dynamic_v1  (Array)
  // Item: { id, title, type:"sqm"|"fixed", active:true/false, rates:[{from:"YYYY-MM-DD", value:number}] }
  // ----------------------------
  const DYNAMIC_TARIFFS_KEY = 'tariffs_dynamic_v1';

  function loadDynamicTariffs(){
    try{
      const raw = localStorage.getItem(DYNAMIC_TARIFFS_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  function normalizeDynamicFixedTariffs(list){
    const out = [];
    (Array.isArray(list) ? list : []).forEach(t => {
      const active = !!(t && (t.active === true || t.enabled === true || t.isActive === true));
      const type = String(t?.type || t?.unit || '').trim().toLowerCase();
      if (!active) return;
      if (!(type === 'fixed' || type === 'month' || type === 'per_month' || type === 'permonth' || type === 'fixed_month')) return;

      const ratesRaw = Array.isArray(t?.rates) ? t.rates : (Array.isArray(t?.history) ? t.history : []);
      const rates = [];
      for (const r of ratesRaw){
        const from = parseAnyToISO(r?.from || r?.dateFrom || r?.date || r?.start || r?.begin);
        if (!from) continue;
        const d = parseISOToDate(from);
        if (!d) continue;
        const value = toNum(r?.value ?? r?.rate ?? r?.tariff ?? r?.sum ?? r?.amount);
        rates.push({ from, fromMs: d.getTime(), value });
      }
      rates.sort((a,b)=>a.fromMs-b.fromMs);
      if (!rates.length) return;

      out.push({
        id: String(t?.id || t?.code || t?.name || t?.title || '').trim() || ('fixed_' + (out.length+1)),
        title: String(t?.title || t?.name || '').trim(),
        rates
      });
    });
    return out;
  }

  function fixedRateForMs(rates, ms){
    let chosen = null;
    for (const r of rates){
      if (r.fromMs <= ms) chosen = r;
      else break;
    }
    return chosen ? toNum(chosen.value) : 0;
  }

  // ✅ FIXED: фикс/мес с учётом смены ставки ВНУТРИ месяца (пропорционально дням)
  function fixedSumForMonthProRated(month, year){
    const fixed = normalizeDynamicFixedTariffs(loadDynamicTariffs());
    if (!fixed.length) return 0;

    const y = Number(year);
    const m = Number(month);
    const dim = daysInMonth(y, m);

    const monthStart = new Date(y, m-1, 1, 12,0,0,0);
    const monthEndExcl = new Date(y, m-1, dim+1, 12,0,0,0);
    const startMs = monthStart.getTime();
    const endMs = monthEndExcl.getTime();

    let total = 0;

    for (const t of fixed){
      const rates = t.rates || [];
      if (!rates.length) continue;

      // точки смены ставки внутри месяца для этого тарифа
      const cuts = [startMs];
      for (const r of rates){
        if (r.fromMs > startMs && r.fromMs < endMs) cuts.push(r.fromMs);
      }
      cuts.push(endMs);
      cuts.sort((a,b)=>a-b);

      for (let i=0; i<cuts.length-1; i++){
        const segStart = cuts[i];
        const segEnd = cuts[i+1];
        if (segEnd <= segStart) continue;

        const days = Math.round((segEnd - segStart) / DAY_MS);
        if (days <= 0) continue;

        const rate = fixedRateForMs(rates, segStart);
        if (!(rate > 0)) continue;

        total = r2(total + (rate * (days / dim)));
      }
    }

    return r2(total);
  }

  function saveTariffsV1(rows){
    const norm = normalizeTariffs(rows);
    localStorage.setItem('tariffs_content_repair_v1', JSON.stringify({ tariffs: norm.map(x => ({ from: x.from, content: x.content, repair: x.repair })) }));
    return norm;
  }

  // ----------------------------
  // Responsibility / ownership
  // ----------------------------
  function getDb(){
    return window.AbonentsDB || { abonents:{}, premises:{}, links:[] };
  }

  function getActiveRangeISOForAbonent(ls){
    const db = getDb();
    const a = db?.abonents?.[String(ls)] || {};

    // 1) основной источник — links (период ответственности)
    const links = Array.isArray(db?.links) ? db.links : [];
    const link = links
      .filter(l => String(l?.abonentId) === String(ls))
      .slice()
      .sort((x,y) => String(x?.dateFrom||'').localeCompare(String(y?.dateFrom||''), 'ru'))
      .slice(-1)[0] || null;

    const from = parseAnyToISO(link?.dateFrom || a.calcStartDate || a.startCalc || a.calcDate || '');
    if (!from) return null;

    const hasLink = !!link;
    const hasDateToField = hasLink && Object.prototype.hasOwnProperty.call(link, "dateTo");
    // CRITICAL: если dateTo задано, но пустое => это "по настоящее время".
    // В этом случае НЕ подставляем a.calcEndDate (часто 2025-12-31), иначе обрежем будущие месяцы.
    let toRaw;
    if (hasDateToField && !String(link.dateTo || "").trim()) {
      toRaw = "";
    } else {
      toRaw = parseAnyToISO(link?.dateTo || a.calcEndDate || a.endCalc || '');
    }
    const to = toRaw || parseAnyToISO(new Date().toISOString().slice(0,10));

    return { from, to };
  }

  function getPremiseRegnumForAbonent(ls){
    const db = getDb();
    const a = db?.abonents?.[String(ls)] || {};
    return String(a.regnum || a.premiseRegnum || '').trim();
  }

  function getSquareForAbonent(ls){
    const db = getDb();
    const a = db?.abonents?.[String(ls)] || {};
    let sq = toNum(a.square ?? a.area ?? a.totalArea ?? a['общая_площадь']);
    if (sq > 0) return sq;
    const reg = getPremiseRegnumForAbonent(ls);
    if (reg){
      const p = db?.premises?.[reg];
      sq = toNum(p?.square ?? p?.area ?? p?.totalArea);
      if (sq > 0) return sq;
    }
    return 0;
  }

  function getOwnershipHistoryForRegnum(regnum){
    const db = getDb();
    const links = Array.isArray(db?.links) ? db.links : [];
    return links
      .filter(l => String(l?.regnum||'').trim() === String(regnum||'').trim())
      .map(l => ({
        abonentId: String(l?.abonentId||''),
        from: parseAnyToISO(l?.dateFrom||''),
        to: parseAnyToISO(l?.dateTo||'')
      }))
      .filter(x => x.abonentId && x.from)
      .sort((a,b) => a.from.localeCompare(b.from));
  }

  // ✅ FIX: Делим сумму по дням месяца между abonentId согласно ownershipHistory
  // Важно: делим от ДНЕЙ В МЕСЯЦЕ, а не от totalDaysUsed.
  // Если есть "дыры" (нет ответственного) — эти дни не начисляются никому.
  function splitAccrualByOwnership(total, year, month, ownershipHistory){
    const y = Number(year);
    const m = Number(month);
    const dim = daysInMonth(y, m);
    const monthStart = new Date(y, m-1, 1, 12,0,0,0);
    const monthEndExcl = new Date(y, m-1, dim+1, 12,0,0,0); // exclusive

    if (!Array.isArray(ownershipHistory) || !ownershipHistory.length) return [];

    const daysByAbonent = new Map();

    for (const l of ownershipHistory){
      const fromD = parseISOToDate(l.from);
      if (!fromD) continue;
      const toD0 = l.to ? parseISOToDate(l.to) : null;
      // dateTo считаем включительно => exclusive = dateTo + 1 день
      const toExcl = toD0 ? new Date(toD0.getFullYear(), toD0.getMonth(), toD0.getDate()+1, 12,0,0,0) : null;

      const start = (fromD > monthStart) ? fromD : monthStart;
      const endExcl = toExcl ? ((toExcl < monthEndExcl) ? toExcl : monthEndExcl) : monthEndExcl;
      if (endExcl <= start) continue;

      const days = Math.round((endExcl - start) / DAY_MS);
      if (days <= 0) continue;

      const id = String(l.abonentId);
      daysByAbonent.set(id, (daysByAbonent.get(id) || 0) + days);
    }

    if (!daysByAbonent.size) return [];

    const out = [];
    let sum = 0;

    for (const [abonentId, days] of daysByAbonent.entries()){
      const amt = r2(total * (days / dim));
      sum = r2(sum + amt);
      out.push({ abonentId, amount: amt, days });
    }

    // корректировка копеек: добиваем до суммы "за покрытые дни" (а не до total)
    // Но здесь total уже "за весь месяц". Мы НЕ должны добивать до total,
    // иначе при неполном покрытии дней получится завышение.
    // Поэтому коррекция делается только на округление внутри уже рассчитанной суммы.
    const target = r2(out.reduce((acc,x)=>acc + x.amount, 0));
    const diff = r2(target - sum);
    if (out.length && Math.abs(diff) >= 0.01){
      out[out.length-1].amount = r2(out[out.length-1].amount + diff);
    }

    return out;
  }

  // ----------------------------
  // Core ensure
  // ----------------------------
  function nextPaymentId(arr){
    return arr.length ? Math.max(...arr.map(x => Number(x.id) || 0)) + 1 : 1;
  }

  function ensureAutoAccrualsForAbonent(ls, arr){
    const range = getActiveRangeISOForAbonent(ls);
    if (!range) return { changed:false, reason:'NO_RANGE' };

    const months = monthIter(range.from, range.to);
    if (!months.length) return { changed:false, reason:'NO_MONTHS' };

    const sq = getSquareForAbonent(ls);
    const regnum = getPremiseRegnumForAbonent(ls);
    const ownershipHistory = regnum ? getOwnershipHistoryForRegnum(regnum) : [];

    const allowedYm = new Set(months.map(m => `${m.year}-${m.month}`));
    let changed = false;

    // обнуляем начисления вне периода
    for (const r of arr){
      const key = rowToYM(r);
      if (!key) continue;
      if (!allowedYm.has(key) && toNum(r.accrued) > 0){
        r.accrued = 0;
        changed = true;
      }
    }

    // by month
    const byYm = new Map();
    for (const r of arr){
      const key = rowToYM(r);
      if (!key) continue;
      if (!byYm.has(key)) byYm.set(key, []);
      byYm.get(key).push(r);
    }

    let idCounter = nextPaymentId(arr);

    for (const mm of months){
      const key = `${mm.year}-${mm.month}`;
      const rows = byYm.get(key) || [];

      // ✅ FIX: тариф с учётом смены тарифа внутри месяца
      const sqmPart = (sq > 0) ? tariffSumForMonthProRated(mm.month, mm.year, sq) : 0;
      const fixedPart = fixedSumForMonthProRated(mm.month, mm.year);
      const totalAccr = r2(sqmPart + fixedPart);

      let accr = 0;
      if (totalAccr > 0 && ownershipHistory.length){
        const parts = splitAccrualByOwnership(totalAccr, Number(mm.year), Number(mm.month), ownershipHistory);
        for (const p of parts){
          if (String(p.abonentId) === String(ls)) accr = r2(accr + p.amount);
        }
      } else {
        // если нет ownershipHistory, то начисление целиком относится к текущему абоненту
        // (иначе не будет начислений в старых базах без links)
        accr = totalAccr;
      }

      if (!rows.length){
        arr.push({
          id: idCounter++,
          month: mm.month,
          year: mm.year,
          accrued: accr,
          paid: 0,
          paid_date: '',
          use_period: false,
          period_from_m: mm.month,
          period_from_y: mm.year,
          period_to_m: mm.month,
          period_to_y: mm.year,
          period_from: `${mm.month}.${mm.year}`,
          period_to: `${mm.month}.${mm.year}`,
          note: '',
          pay_main: 0,
          pay_penalty: 0,
          total_debt: 0
        });
        changed = true;
        continue;
      }

      rows.sort((a,b)=>(Number(a.id)||0)-(Number(b.id)||0));
      const first = rows[0];
      for (let i=1;i<rows.length;i++){
        if (toNum(rows[i].accrued) !== 0){
          rows[i].accrued = 0;
          changed = true;
        }
      }
      if (toNum(first.accrued) !== accr){
        first.accrued = accr;
        changed = true;
      }
    }

    return { changed, reason:'OK' };
  }

  function recalcForAbonent(ls){
    const id = String(ls||'').trim();
    if (!id) return { ok:false, reason:'EMPTY_ID' };
    const arr = loadPayments(id);
    const res = ensureAutoAccrualsForAbonent(id, arr);
    if (res.changed) savePayments(id, arr);
    return { ok:true, ...res, ls:id };
  }

  function recalcForMany(list){
    const ids = Array.from(new Set((list||[]).map(x=>String(x||'').trim()).filter(Boolean)));
    const out = [];
    for (const id of ids){
      out.push(recalcForAbonent(id));
    }
    return out;
  }

  function recalcAll(){
    const db = getDb();
    const ids = Object.keys(db?.abonents || {});
    return recalcForMany(ids);
  }

  window[ENGINE_KEY] = true;
  window.JKHAutoAccrual = {
    version: "2026-01-28-fixed-month-v1",
    recalcForAbonent,
    recalcForMany,
    recalcAll,
    saveTariffsV1,
    debugMonth: function(ls, year, month){
      const sq = getSquareForAbonent(ls);
      const sqmPart = (sq>0) ? tariffSumForMonthProRated(month, year, sq) : 0;
      const fixedPart = fixedSumForMonthProRated(month, year);
      const total = r2(sqmPart + fixedPart);
      return { ls: String(ls), year: String(year), month: String(month), square: sq, totalAccrued: total, tariffs: normalizeTariffs(detectTariffTable()||[]).map(t=>({from:t.from, content:t.content, repair:t.repair})) };
    }
  };
  try{ console.log("[JKHAutoAccrual] engine loaded", window.JKHAutoAccrual.version); }catch(e){};
})();
