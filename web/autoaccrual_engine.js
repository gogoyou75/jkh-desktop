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

/* ============================================================
   autoaccrual_engine.js
   Variant A (логика): единый движок авто-начислений, который
   можно вызывать из import_xls.html / new_abonent.html / tariffs.html

   Хранение:
   - payments_<uid> (основной формат; строки помесячно: accrued/paid/paid_date...)
   - payments_<LS>   (legacy: устаревший формат, только для совместимости)
   - tariffs_{owner}
       server-first канон:
       [
         {
           id,
           code,
           title,
           type: "per_m2" | "fixed_month",
           active: boolean,
           rates: [{ from:"YYYY-MM-DD", value:number }]
         }
       ]

   Правила (CRITICAL):
   - начислять с даты начала (включительно)
   - начислять до конца периода ответственности (если dateTo задан), иначе до текущего месяца
   - 1 начисление на месяц: если в месяце несколько строк оплат, начисление только у строки с минимальным id
   - при смене ответственного в середине месяца: делим начисление пропорционально дням по AbonentsDB.links
       ✅ FIX: деление идёт от кол-ва дней в месяце (а не от totalDaysUsed),
              поэтому если право началось/закончилось не с 1-го числа — начисление корректно пропорционально.
   - при изменении тарифов:
       ✅ FIX: если ставка меняется ВНУТРИ месяца — начисление делится пропорционально дням.
   - несколько активных тарифов одновременно суммируются
   ============================================================ */

(function(){
  const ENGINE_KEY = 'JKH_AUTOACCRUAL_ENGINE_v2_OWNER_TARIFFS';
  if (window[ENGINE_KEY]) return;

  const DAY_MS = 24*3600*1000;

  function pad2(n){ return String(n).padStart(2,'0'); }
  function r2(x){ return Math.round((Number(x)||0)*100)/100; }
  function toNum(v){
    const n = parseFloat(String(v ?? '').replace(/\s+/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  function isDataReady(){ return window.JKH_DATA_READY === true; }
  function storeGetRaw(key, ownerId){
    if (!isDataReady()) return null;
    if (!(window.JKHStore && typeof window.JKHStore.getRaw === 'function')) return null;
    try{ return JKHStore.getRaw(String(key), ownerId); } catch { return null; }
  }
  function storeSetRaw(key, value, ownerId){
    if (!(window.JKHStore && typeof window.JKHStore.setRaw === 'function')) return;
    try{ JKHStore.setRaw(String(key), value, ownerId); } catch {}
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

  const RU_MONTHS = {
    'ЯНВАРЬ':1,'ФЕВРАЛЬ':2,'МАРТ':3,'АПРЕЛЬ':4,'МАЙ':5,'ИЮНЬ':6,
    'ИЮЛЬ':7,'АВГУСТ':8,'СЕНТЯБРЬ':9,'ОКТЯБРЬ':10,'НОЯБРЬ':11,'ДЕКАБРЬ':12
  };

  function rowToYM(row){
    if (!row) return '';

    const y1 = parseInt(String(row.year ?? row.y ?? ''), 10);
    const m1 = parseInt(String(row.month ?? row.m ?? ''), 10);
    if (y1 && m1 && m1 >= 1 && m1 <= 12) return `${y1}-${pad2(m1)}`;

    const ym = String(row.ym ?? row.yearMonth ?? row.y_m ?? '').trim();
    if (/^\d{4}-\d{2}$/.test(ym)) return ym;

    const p = String(row.period ?? row.period_from ?? row.period_to ?? '').trim();
    const mmY = p.match(/^(\d{1,2})\.(\d{4})$/);
    if (mmY){
      const m = parseInt(mmY[1],10); const y = parseInt(mmY[2],10);
      if (y && m>=1 && m<=12) return `${y}-${pad2(m)}`;
    }

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

  function resolvePaymentsKeyForAbonent(abonentId){
    const id = String(abonentId || '').trim();
    if (!id) {
      console.warn('[autoaccrual][payment-key] blocked', { abonentId: id, reason: 'EMPTY_ABONENT_ID' });
      return '';
    }

    if (typeof window.getPaymentsKeyForAbonent === 'function') {
      const key = String(window.getPaymentsKeyForAbonent(id) || '').trim();
      if (key) return key;
      console.warn('[autoaccrual][payment-key] blocked', { abonentId: id, reason: 'EMPTY_KEY_FROM_RESOLVER' });
      return '';
    }

    const dbAbonent = (window.Data && typeof window.Data.getDb === 'function')
      ? ((window.Data.getDb() || {}).abonents || {})[id]
      : null;
    const fallbackAbonent = (window.AbonentsDB && window.AbonentsDB.abonents)
      ? window.AbonentsDB.abonents[id]
      : null;
    const a = dbAbonent || fallbackAbonent || null;
    const uid = String(a && a.uid || '').trim();
    if (uid) return 'payments_' + uid;

    console.warn('[autoaccrual][payment-key] blocked', { abonentId: id, reason: 'UID_REQUIRED' });
    return '';
  }

  function loadPayments(abonentId, ownerId){
    const key = resolvePaymentsKeyForAbonent(abonentId);
    if (!key) return [];
    try{
      const raw = storeGetRaw(key, ownerId);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function savePayments(abonentId, arr, ownerId){
    const key = resolvePaymentsKeyForAbonent(abonentId);
    if (!key) return;
    storeSetRaw(key, JSON.stringify(arr||[]), ownerId);
  }

  // ----------------------------
  // Owner-bound tariffs only
  // ----------------------------
  function getOwnerId(){
    try{
      if (window.JKHStorage && typeof window.JKHStorage.getActiveOwnerId === 'function'){
        const v = String(window.JKHStorage.getActiveOwnerId() || '').trim();
        if (v) return v;
      }
    }catch(e){}

    try{
      if (window.Auth && typeof window.Auth.getActiveDbOwnerId === 'function'){
        const v = String(window.Auth.getActiveDbOwnerId() || '').trim();
        if (v) return v;
      }
    }catch(e){}

    try{
      const st = window.JKH_UI_STATE || null;
      const v = String(st?.auth?.ownerId || st?.auth?.activeOwnerId || '').trim();
      if (v) return v;
    }catch(e){}

    try{
      const u = window.Auth && typeof window.Auth.getCurrentUser === 'function'
        ? window.Auth.getCurrentUser()
        : null;
      const v = String(u?.ownerId || u?.userId || u?.id || u?.email || '').trim();
      if (v) return v;
    }catch(e){}

    return '';
  }

  function ownerTariffsKey(){
    const owner = getOwnerId();
    return owner ? ('tariffs_' + owner) : '';
  }

  function loadOwnerTariffsRaw(){
    try{
      const key = ownerTariffsKey();
      if (!key) return [];
      const raw = storeGetRaw(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }catch(e){
      console.warn('[JKHAutoAccrual] loadOwnerTariffsRaw failed', e);
      return [];
    }
  }

  function normalizeOwnerTariffs(list){
    const out = [];
    (Array.isArray(list) ? list : []).forEach((t, idx) => {
      if (!t || typeof t !== 'object') return;
      if (!t.active) return;

      const typeRaw = String(t.type || '').trim().toLowerCase();
      const type = (typeRaw === 'fixed_month') ? 'fixed_month' : ((typeRaw === 'per_m2') ? 'per_m2' : '');
      if (!type) return;

      const ratesRaw = Array.isArray(t.rates) ? t.rates : [];
      const rates = [];
      for (const r of ratesRaw){
        const from = parseAnyToISO(r?.from || r?.dateFrom || r?.date || r?.start || r?.begin);
        if (!from) continue;
        const d = parseISOToDate(from);
        if (!d) continue;
        rates.push({
          from,
          fromMs: d.getTime(),
          value: toNum(r?.value ?? r?.rate ?? r?.tariff ?? r?.sum ?? r?.amount)
        });
      }
      rates.sort((a,b)=>a.fromMs-b.fromMs);
      if (!rates.length) return;

      out.push({
        id: String(t.id || t.code || t.title || ('tariff_' + (idx+1))),
        code: String(t.code || ''),
        title: String(t.title || ''),
        type,
        active: true,
        rates
      });
    });
    return out;
  }

  function loadNormalizedOwnerTariffs(){
    return normalizeOwnerTariffs(loadOwnerTariffsRaw());
  }

  function rateForMs(rates, ms){
    let chosen = null;
    for (const r of rates){
      if (r.fromMs <= ms) chosen = r;
      else break;
    }
    return chosen;
  }

  function sumPerM2ForMonthProRated(month, year, sq){
    const tariffs = loadNormalizedOwnerTariffs().filter(t => t.type === 'per_m2');
    if (!tariffs.length || !(sq > 0)) return 0;

    const y = Number(year);
    const m = Number(month);
    const dim = daysInMonth(y, m);

    const monthStart = new Date(y, m-1, 1, 12,0,0,0);
    const monthEndExcl = new Date(y, m-1, dim+1, 12,0,0,0);
    const startMs = monthStart.getTime();
    const endMs = monthEndExcl.getTime();

    let total = 0;

    for (const t of tariffs){
      const cuts = [startMs];
      for (const r of t.rates){
        if (r.fromMs > startMs && r.fromMs < endMs) cuts.push(r.fromMs);
      }
      cuts.push(endMs);
      cuts.sort((a,b)=>a-b);

      for (let i=0; i<cuts.length-1; i++){
        const segStart = cuts[i];
        const segEnd = cuts[i+1];
        if (segEnd <= segStart) continue;

        const chosen = rateForMs(t.rates, segStart);
        if (!chosen) continue;

        const days = Math.round((segEnd - segStart) / DAY_MS);
        if (days <= 0) continue;

        total = r2(total + (toNum(chosen.value) * sq * (days / dim)));
      }
    }

    return r2(total);
  }

  function fixedSumForMonthProRated(month, year){
    const tariffs = loadNormalizedOwnerTariffs().filter(t => t.type === 'fixed_month');
    if (!tariffs.length) return 0;

    const y = Number(year);
    const m = Number(month);
    const dim = daysInMonth(y, m);

    const monthStart = new Date(y, m-1, 1, 12,0,0,0);
    const monthEndExcl = new Date(y, m-1, dim+1, 12,0,0,0);
    const startMs = monthStart.getTime();
    const endMs = monthEndExcl.getTime();

    let total = 0;

    for (const t of tariffs){
      const cuts = [startMs];
      for (const r of t.rates){
        if (r.fromMs > startMs && r.fromMs < endMs) cuts.push(r.fromMs);
      }
      cuts.push(endMs);
      cuts.sort((a,b)=>a-b);

      for (let i=0; i<cuts.length-1; i++){
        const segStart = cuts[i];
        const segEnd = cuts[i+1];
        if (segEnd <= segStart) continue;

        const chosen = rateForMs(t.rates, segStart);
        if (!chosen) continue;

        const days = Math.round((segEnd - segStart) / DAY_MS);
        if (days <= 0) continue;

        total = r2(total + (toNum(chosen.value) * (days / dim)));
      }
    }

    return r2(total);
  }

  // backward-compat method name used by debugMonth in some flows
  function detectTariffTable(){
    return loadNormalizedOwnerTariffs().map(t => ({
      id: t.id,
      code: t.code,
      title: t.title,
      type: t.type,
      active: t.active,
      rates: t.rates.map(r => ({ from: r.from, value: r.value }))
    }));
  }

  function saveTariffsV1(){
    throw new Error('LEGACY_TARIFF_SAVE_DISABLED_USE_tariffs_owner');
  }

  function getDb(){
    return window.AbonentsDB || { abonents:{}, premises:{}, links:[] };
  }

  function getActiveRangeISOForAbonent(ls){
    const db = getDb();
    const a = db?.abonents?.[String(ls)] || {};

    const links = Array.isArray(db?.links) ? db.links : [];
    const link = links
      .filter(l => String(l?.abonentId) === String(ls))
      .slice()
      .sort((x,y) => String(x?.dateFrom||'').localeCompare(String(y?.dateFrom||''), 'ru'))
      .slice(-1)[0] || null;

    const from = parseAnyToISO(link?.dateFrom || a.calcStartDate || a.startCalc || a.calcDate || '');
    if (!from) return null;

    const hasLink = !!link;
    const hasDateToField = hasLink && Object.prototype.hasOwnProperty.call(link, 'dateTo');
    let toRaw;
    if (hasDateToField && !String(link.dateTo || '').trim()) {
      toRaw = '';
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

  function splitAccrualByOwnership(total, year, month, ownershipHistory){
    const y = Number(year);
    const m = Number(month);
    const dim = daysInMonth(y, m);
    const monthStart = new Date(y, m-1, 1, 12,0,0,0);
    const monthEndExcl = new Date(y, m-1, dim+1, 12,0,0,0);

    if (!Array.isArray(ownershipHistory) || !ownershipHistory.length) return [];

    const daysByAbonent = new Map();

    for (const l of ownershipHistory){
      const fromD = parseISOToDate(l.from);
      if (!fromD) continue;
      const toD0 = l.to ? parseISOToDate(l.to) : null;
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

    const target = r2(out.reduce((acc,x)=>acc + x.amount, 0));
    const diff = r2(target - sum);
    if (out.length && Math.abs(diff) >= 0.01){
      out[out.length-1].amount = r2(out[out.length-1].amount + diff);
    }

    return out;
  }

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

    for (const r of arr){
      const key = rowToYM(r);
      if (!key) continue;
      if (!allowedYm.has(key) && toNum(r.accrued) > 0){
        r.accrued = 0;
        changed = true;
      }
    }

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

      const sqmPart = (sq > 0) ? sumPerM2ForMonthProRated(mm.month, mm.year, sq) : 0;
      const fixedPart = fixedSumForMonthProRated(mm.month, mm.year);
      const totalAccr = r2(sqmPart + fixedPart);

      let accr = 0;
      if (totalAccr > 0 && ownershipHistory.length){
        const parts = splitAccrualByOwnership(totalAccr, Number(mm.year), Number(mm.month), ownershipHistory);
        for (const p of parts){
          if (String(p.abonentId) === String(ls)) accr = r2(accr + p.amount);
        }
      } else {
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

    const ownerId = (window.JKHStore && typeof window.JKHStore.getOwnerId === 'function')
      ? String(window.JKHStore.getOwnerId() || '').trim()
      : '';
    if (!ownerId) return { ok:false, reason:'EMPTY_OWNER', ls:id };

    const arr = loadPayments(id, ownerId);
    const res = ensureAutoAccrualsForAbonent(id, arr);
    const rows = arr;

    if (!rows.length && res.changed) return { ok:true, changed:false, reason:'EMPTY_ROWS', ls:id };

    if (res.changed){
      savePayments(id, rows, ownerId);
      const lenSaved = rows.length;
      const existsSaved = lenSaved > 0;
      console.log('[autoaccrual][save]', { id, len: lenSaved, exists: existsSaved });

      const key = resolvePaymentsKeyForAbonent(id);
      const check = key ? storeGetRaw(key, ownerId) : null;
      let checkLen = 0;
      if (check) {
        try { checkLen = JSON.parse(check).length || 0; } catch (_) { checkLen = 0; }
      }
      const len = checkLen;
      const exists = !!check;
      console.log('[autoaccrual][after-save]', { id, len, exists });
    }

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
    version: '2026-04-15-owner-tariffs-v2',
    recalcForAbonent,
    recalcForMany,
    recalcAll,
    saveTariffsV1,
    debugMonth: function(ls, year, month){
      const sq = getSquareForAbonent(ls);
      const sqmPart = (sq > 0) ? sumPerM2ForMonthProRated(month, year, sq) : 0;
      const fixedPart = fixedSumForMonthProRated(month, year);
      const total = r2(sqmPart + fixedPart);
      return {
        ls: String(ls),
        year: String(year),
        month: String(month),
        ownerId: getOwnerId(),
        tariffsKey: ownerTariffsKey(),
        square: sq,
        perM2Part: sqmPart,
        fixedPart,
        totalAccrued: total,
        tariffs: detectTariffTable()
      };
    }
  };
  window.JKHBoot?.markReady?.('autoaccrual');
  try{ console.log('[JKHAutoAccrual] engine loaded', window.JKHAutoAccrual.version); }catch(e){}
})();
