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

/* =====================================================================
   PAYMENT_TABLE.JS — ТАБЛИЦА ОПЛАТ
   ===================================================================== */

(function () {
  function qs(sel, root = document) { return root.querySelector(sel); }
  function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
  function pad2(n) { return String(n).padStart(2, "0"); }
  // ===========================
  // UI: сворачиваемые блоки месяца (ledger)
  // хранение состояния: localStorage key `payments_ui_collapsed_<LS>` -> {"YYYY-MM": true/false}
  function collapseStoreKey() {
    return `payments_ui_collapsed_${getAbonentId()}`;
  }
  function loadCollapsedMap() {
    try { return JSON.parse(localStorage.getItem(collapseStoreKey()) || "{}") || {}; } catch { return {}; }
  }
  function saveCollapsedMap(map) {
    try { localStorage.setItem(collapseStoreKey(), JSON.stringify(map || {})); } catch {}
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
  // Справочник источников хранится глобально (на будущее может быть больше 3).
  // По умолчанию: «Платёж 1/2/3».
  const PAYMENT_SOURCES_KEY = 'payment_sources_v1';

  function defaultPaymentSources(){
    return ['Платёж 1','Платёж 2','Платёж 3'];
  }

  function loadPaymentSources(){
    try {
      const raw = localStorage.getItem(PAYMENT_SOURCES_KEY);
      if (!raw) return defaultPaymentSources();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return defaultPaymentSources();
      const cleaned = arr.map(x => String(x||'').trim()).filter(Boolean);
      return cleaned.length ? cleaned : defaultPaymentSources();
    } catch {
      return defaultPaymentSources();
    }
  }

  function savePaymentSources(arr){
    const cleaned = (arr||[]).map(x => String(x||'').trim()).filter(Boolean);
    localStorage.setItem(PAYMENT_SOURCES_KEY, JSON.stringify(cleaned.length ? cleaned : defaultPaymentSources()));
  }

  function ensurePaymentSources(){
    let cur = null;
    try { cur = loadPaymentSources(); } catch { cur = defaultPaymentSources(); }
    if (!cur || !cur.length){
      savePaymentSources(defaultPaymentSources());
      return defaultPaymentSources();
    }
    try {
      if (!localStorage.getItem(PAYMENT_SOURCES_KEY)) savePaymentSources(cur);
    } catch {}
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
    return [{ abonentId: null, amount: accr }];
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

  // компенсация копеек
  const sum = r2(parts.reduce((s,p)=>s+p.amount,0));
  const diff = r2(accr - sum);
  if (diff !== 0 && parts.length) {
    parts[0].amount = r2(parts[0].amount + diff);
  }

  return parts;
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

  function getAbonentId() {
    const p = new URLSearchParams(window.location.search);
    const fromUrl = p.get("abonent");
    if (fromUrl) return fromUrl;

    const db = window.AbonentsDB?.abonents || {};
    const first = Object.keys(db)[0];
    return first || "27";
  }

  function paymentsKey() {
    return "payments_" + getAbonentId();
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
      a.dateFrom ?? a.date_from ?? a.calcFrom ?? a.calc_from ?? a.startCalc ?? a.start_calc ??
      a.dateStartCalc ?? a.date_start_calc ?? a.responsibilityFrom ?? a.respFrom
    );
    const toISO = parseAnyDateToISO(
      a.dateTo ?? a.date_to ?? a.calcTo ?? a.calc_to ?? a.endCalc ?? a.end_calc ??
      a.dateEndCalc ?? a.date_end_calc ?? a.responsibilityTo ?? a.respTo
    );

    if (fromISO) return clamp({ from: fromISO, to: toISO || "" });

    // fallback #2: если у абонента ещё нет привязки/периода (частый кейс после импорта
    // и создания нового абонента), но уже есть строки в payments_<LS>, берём самый ранний
    // (год, месяц) из таблицы оплат и считаем это датой начала расчёта.
    // Это даёт автоперерасчёт начислений сразу после импорта.
    try {
      const raw = localStorage.getItem("payments_" + id);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) {
          let minY = null, minM = null;
          for (const r of arr) {
            const y = parseInt(String(r?.year || ""), 10);
            const m = parseInt(String(r?.month || ""), 10);
            if (!y || !m) continue;
            if (minY == null || y < minY || (y === minY && m < minM)) {
              minY = y; minM = m;
            }
          }

          if (minY != null && minM != null) {
            const fromISO2 = `${minY}-${pad2(minM)}-01`;

            // Если у абонента ещё не выставлен calcStartDate — зафиксируем,
            // чтобы следующие страницы тоже понимали период начислений.
            if (aStrict && !strictFrom) {
              aStrict.calcStartDate = fromISO2;
              try {
                if (typeof window.saveAbonentsDB === "function") window.saveAbonentsDB();
                else localStorage.setItem("abonents_db_v1", JSON.stringify(window.AbonentsDB));
              } catch (e) {}
            }

            return clamp({ from: fromISO2, to: "" });
          }
        }
      }
    } catch (e) {}

    console.warn("[autoaccrual] не найден период ответственности/расчёта (AbonentsDB.links или abonent.startCalc)");
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
    // 1) localStorage — известные ключи (старые/новые версии)
    const keys = [
      "tariffs_content_repair_v1",
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
      }catch{}
      return null;
    };

    for (const k of keys){
      const got = tryParse(localStorage.getItem(k));
      if (got) return got;
    }

    // 1b) локальное сканирование: если ключ другой (напр. "tariffs_tszh_" или "tariffRates")
    // Берём первый подходящий массив.
    try{
      const foundKeys = [];
      for (let i=0; i<localStorage.length; i++){
        const k = localStorage.key(i);
        if (!k) continue;
        if (/tarif|тариф/i.test(k)){
          foundKeys.push(k);
          const got = tryParse(localStorage.getItem(k));
          if (got) return got;
        }
      }
      if (foundKeys.length){
        console.warn("[autoaccrual] найдены ключи с 'tarif/тариф' в localStorage, но не распознаны как таблица:", foundKeys);
      }
    }catch{}

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
    // финальный лог: покажем какие ключи вообще есть (первые 30) — помогает сразу понять имя ключа
    try{
      const ks = [];
      for (let i=0; i<Math.min(localStorage.length, 30); i++) ks.push(localStorage.key(i));
      console.warn("[autoaccrual] не найдены тарифы. Примеры ключей localStorage:", ks);
    }catch{
      console.warn("[autoaccrual] не найдены тарифы: localStorage или window.*");
    }

    // ✅ FALLBACK (чтобы начисления не были нулевыми на чистой базе):
    // Если тарифы ещё нигде не сохранены (tariffs.html пока статическая),
    // создаём минимальную таблицу по умолчанию.
    // ВАЖНО: как только появится реальный CRUD тарифов — этот fallback просто не будет использоваться.
    const defaults = [
      { from: "2023-01-01", content: 35,   repair: 10 },
      { from: "2024-01-01", content: 38.5, repair: 12 }
    ];
    try{
      localStorage.setItem("tariffs_content_repair_v1", JSON.stringify(defaults));
      console.warn("[autoaccrual] тарифы не найдены — создал tariffs_content_repair_v1 (defaults)");
    }catch{}
    return defaults;
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
    // Даже если кто-то вручную подменит localStorage и поставит accrued,
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
for (const p of parts) {
  if (String(p.abonentId) === String(getAbonentId())) {
    accr = r2(accr + p.amount);
  }
}


      if (sumRate == null){
        // тарифы не найдены / не распознаны — это главная причина "не происходит начисление"
        console.warn(`[autoaccrual] нет тарифа на ${mm.month}.${mm.year} (проверь таблицу тарифов и ключи localStorage)`);
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
  function calcPeriodKey() { return "calc_period_" + getAbonentId(); }
  function calcPeriodActiveKey() { return "calc_period_active_" + getAbonentId(); }

  function lastAddedPaymentKey() { return "last_added_payment_" + getAbonentId(); }
  function setLastAddedPaymentId(id) {
    try { sessionStorage.setItem(lastAddedPaymentKey(), String(id)); } catch {}
  }
  function getLastAddedPaymentId() {
    try { return sessionStorage.getItem(lastAddedPaymentKey()); } catch { return null; }
  }
  function clearLastAddedPaymentId() {
    try { sessionStorage.removeItem(lastAddedPaymentKey()); } catch {}
  }

  function getCalcPeriod() {
    try {
      const raw = localStorage.getItem(calcPeriodKey());
      if (!raw) return null;
      const p = JSON.parse(raw);
      const from = String(p?.from || "");
      const to   = String(p?.to || "");
      if (!from || !to) return null;
      return { from, to };
    } catch {
      return null;
    }
  }

  function isCalcPeriodActive() {
    return localStorage.getItem(calcPeriodActiveKey()) === "1";
  }

  // ✅ ФИЛЬТР: показываем оплаты, у которых "Дата оплаты" попадает в выбранный период
  function applyCalcFilter(arr) {
    if (!isCalcPeriodActive()) return arr;

    const p = getCalcPeriod();
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

  function getPayments() {
    try {
      const key = paymentsKey();
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];

      // Авто-миграция старых записей:
      // - paid_date мог быть Excel serial (number/"45234") → конвертируем в ISO
      // - source мог отсутствовать → ставим "Платёж 1" по умолчанию
      let changed = false;
      for (const r of arr) {
        if (!r || typeof r !== 'object') continue;

        // source default
        if (!('source' in r) || String(r.source || '').trim() === '') {
          r.source = 'Платёж 1';
          changed = true;
        }

        // normalize paid_date to ISO if possible
        const before = r.paid_date;
        if (before !== null && before !== undefined && String(before).trim() !== '') {
          const dt = parseDateAnyToDate(before);
          if (dt) {
            const iso = toISODateString(dt);
            if (String(before) !== iso) {
              r.paid_date = iso;
              changed = true;
            }
          }
        }
      }

      if (changed) {
        try { normalizePaymentRows(arr); } catch {}
        localStorage.setItem(key, JSON.stringify(arr));
      }

      return arr;
    } catch {
      return [];
    }
  }


  /* =========================================================
     DATA CONTRACT (PaymentRow) — нормализация перед сохранением
     - Числа храним числами (id, accrued, paid, pay_main, pay_penalty, total_debt)
     - paid_date: ISO YYYY-MM-DD или ""
     - month: "01".."12", year: "YYYY"
     - paid не может быть отрицательным
     ========================================================= */

  function normalizePaymentRow(r){
    if (!r || typeof r !== 'object') return;

    // id
    r.id = Number(r.id) || 0;

    // month/year
    const mm = String(r.month ?? '').padStart(2,'0');
    r.month = (/^(0[1-9]|1[0-2])$/.test(mm)) ? mm : String(new Date().getMonth()+1).padStart(2,'0');
    const yy = String(r.year ?? '');
    r.year = (/^(19|20)\d{2}$/.test(yy)) ? yy : String(new Date().getFullYear());

    // amounts
    r.accrued = r2(toNum(r.accrued));
    r.paid = r2(Math.max(0, toNum(r.paid)));

    // paid_date
    if (String(r.paid_date || '').trim()) {
      normalizePaidDateISO(r);
      // sync month/year from paid_date to obey P2
      syncYearMonthFromPaidDate(r);
    } else {
      r.paid_date = '';
    }

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
    for (const r of arr) normalizePaymentRow(r);
    return arr;
  }

  function savePayments(arr) {
    try { normalizePaymentRows(arr); } catch {}
    localStorage.setItem(paymentsKey(), JSON.stringify(arr));
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
        const rate = Number.isFinite(rawRate) ? capRateUntil2027(day, rawRate) : 0;
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
  } catch (e) { /* fallback to local calc */ }

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
  } catch {}

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

function applyRunningTotals(viewRows) {
  const allRows = getPayments();

// ✅ Если активен расчёт "взыскиваемой суммы за период",
  // то считаем долги/остатки ТОЛЬКО внутри выбранного периода,
  // и стартуем с нуля на начале периода (т.е. игнорируем долг до периода).
  let baseRows = allRows;
  if (isCalcPeriodActive()) {
    const p = getCalcPeriod();
    const fromD = p ? parseDateAnyToDate(p.from) : null;
    const toD   = p ? parseDateAnyToDate(p.to)   : null;

    if (fromD && toD) {
      const fromKey = (fromD.getFullYear() * 12) + (fromD.getMonth() + 1);
      const toKey   = (toD.getFullYear()   * 12) + (toD.getMonth() + 1);

      baseRows = allRows.filter(r => {
        let y = parseInt(r?.year, 10);
        let m = parseInt(r?.month, 10);
        if (!(Number.isFinite(y) && Number.isFinite(m) && y > 0 && m >= 1 && m <= 12)) {
          const d = parseDateAnyToDate(r?.paid_date);
          if (d) { y = d.getFullYear(); m = d.getMonth() + 1; }
        }
        if (!(Number.isFinite(y) && Number.isFinite(m) && y > 0 && m >= 1 && m <= 12)) return false;
        const key = (y * 12) + m;
        return key >= fromKey && key <= toKey;
      });
    }
  }

  const sortedAsc = viewRows.slice().sort((a, b) => {
    const at = paidDateMsAscKey(a);
    const bt = paidDateMsAscKey(b);
    if (at !== bt) return at - bt;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });

  for (const r of sortedAsc){
    const asOf = asOfForRow(r);
    const t = calcTotalsAsOf(baseRows, asOf);
    r.pay_main = t.principal;
    r.pay_penalty = t.penalty;
    r.total = t.total;
  }
}

  // =============================================================
  // КЛЮЧИ localStorage для ставок рефинансирования
  // (вынесены в constants.js; здесь — безопасные fallback'и)
  // =============================================================
  const REFI_KEY_NORMAL = (window.JKH_CONST && window.JKH_CONST.REFI_KEY_NORMAL)
    ? window.JKH_CONST.REFI_KEY_NORMAL
    : "refinancing_rates_normal_v1";

  const REFI_KEY_MORA = (window.JKH_CONST && window.JKH_CONST.REFI_KEY_MORA)
    ? window.JKH_CONST.REFI_KEY_MORA
    : "refinancing_rates_moratorium_v1";
  function excludePeriodsKey() { return "exclude_periods_" + getAbonentId(); }
  function moratoriumKey() { return "moratorium_" + getAbonentId(); }

  function isMoratoriumActive(){
    return localStorage.getItem(moratoriumKey()) === "1";
  }

  function parseDMY(dmy){
    // Поддержка и "ДД.ММ.ГГГГ", и ISO "YYYY-MM-DD"
    // (раньше исключённые периоды не работали, если дата была в ISO)
    return parseDateAnyToDate(dmy);
  }

  function loadExcludes(){
    try{
      const raw = localStorage.getItem(excludePeriodsKey());
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];

      // Нормализуем даты исключения: from = начало дня, to = конец дня (включительно)
      const startDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0,0);
      const endDay   = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23,59,59,999);

      return arr
        .map(x => {
          const fromRaw = x.from ?? x.dateFrom ?? x.start ?? x.fromISO ?? x.from_iso;
          const toRaw   = x.to   ?? x.dateTo   ?? x.end   ?? x.toISO   ?? x.to_iso;

          const from = parseDateAnyToDate(fromRaw);
          const to   = parseDateAnyToDate(toRaw);

          return {
            from: from ? startDay(from) : null,
            to:   to   ? endDay(to)     : null,
            reason: String(x.reason || x.note || x.comment || "")
          };
        })
        .filter(x => x.from && x.to && x.to >= x.from);
    }catch{
      return [];
    }
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
    try{
      const raw = localStorage.getItem(key);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      const parsed = arr
        .map(x => ({
          from: parseDMY(x.from),
          rate: Number(String(x.rate ?? "").replace(",", "."))
        }))
        .filter(x => x.from && Number.isFinite(x.rate))
        .sort((a,b)=>a.from-b.from);
      return parsed;
    }catch{
      return [];
    }
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
          const rate = Number.isFinite(rawRate) ? capRateUntil2027(day, rawRate) : 0;

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

    const d = new Date();
    const defM = pad2(d.getMonth() + 1);
    const defY = String(d.getFullYear());

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

  function updateComputedCells(tr, rowObj){
  const ro = qsa("td.ro", tr);
  if (ro.length >= 3){
    const pm = toNum(rowObj.pay_main ?? 0);
    const pp = toNum(rowObj.pay_penalty ?? 0);

    ro[0].textContent = fmtMoney(pm);
    ro[0].style.color = (pm < -0.0000001) ? "#8B0000" : "";
    ro[0].style.fontWeight = (pm < -0.0000001) ? "700" : "";

    ro[1].textContent = (toNum(rowObj.paid ?? 0) > 0.0000001) ? "" : fmtMoney(pp);

    // ✅ CRITICAL: "Всего" в таблице = Долг + Пени (derived field, не хранится отдельно)
    const total = pm + pp;
    ro[2].textContent = fmtMoney(total);
  }
}

  // ✅ Главное: обновляем нарастающий итог в DOM БЕЗ перерисовки таблицы (фокус не теряется)
  function refreshRunningTotalsInDOM() {
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

    let arr = getPayments();
 
    // автоначисление по тарифам/площади в рамках периода ответственности
    // CRITICAL: если подключен внешний движок JKHAutoAccrual (autoaccrual_engine.js),
    // используем ЕГО, чтобы работало пропорциональное начисление при смене тарифа внутри месяца.
    try {
      if (window.JKHAutoAccrual && typeof window.JKHAutoAccrual.recalcForAbonent === 'function') {
        window.JKHAutoAccrual.recalcForAbonent(getAbonentId());
        // движок сам пишет в localStorage -> перечитываем
        arr = getPayments();
      } else {
        if (ensureAutoAccruals(arr)) {
          savePayments(arr);

    // ✅ Итог карточки (Всего задолженность = Долг + Пени)
    JKH_RecalcAbonentTotalDebtCard();
        }
      }
    } catch(e) { console.error("autoaccrual failed", e); }


    // то же приведение, что и в loadPaymentTable
    arr.forEach(r => {
      normalizePaidDateISO(r);
      if (String(r?.paid_date || "").trim()) syncYearMonthFromPaidDate(r);
      normalizePeriod(r);
      calcRowBase(r);
    });

    const view = applyCalcFilter(arr).slice();
    applyRunningTotals(view);

    // сопоставление id -> rowObj
    const byId = new Map(view.map(r => [String(r.id), r]));

    // обновляем только ro-ячейки у уже нарисованных строк
    qsa("tr", tbody).forEach(tr => {
      const id = String(tr.dataset.rowId || "");
      const row = byId.get(id);
      if (row) updateComputedCells(tr, row);
    });

    // сохраняем нормализованные данные (без перерисовки)
    savePayments(arr);
  }

  function loadPaymentTable() {
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

    let arr = getPayments();

    // автоначисление по тарифам/площади в рамках периода ответственности (ЗАКОН НАЧИСЛЕНИЙ)
    // CRITICAL: если подключен внешний движок JKHAutoAccrual (autoaccrual_engine.js),
    // используем ЕГО, чтобы работало пропорциональное начисление при смене тарифа внутри месяца.
    try {
      if (window.JKHAutoAccrual && typeof window.JKHAutoAccrual.recalcForAbonent === 'function') {
        window.JKHAutoAccrual.recalcForAbonent(getAbonentId());
        // движок сам пишет в localStorage -> перечитываем
        arr = getPayments();
      } else {
        if (ensureAutoAccruals(arr)) {
          savePayments(arr);
        }
      }
    } catch (e) {
      console.error('autoaccrual failed', e);
    }


    // нормализуем даты + синхронизируем год/месяц
    arr.forEach(r => {
      normalizePaidDateISO(r);
      if (String(r?.paid_date || "").trim()) syncYearMonthFromPaidDate(r);
      normalizePeriod(r);
      calcRowBase(r);
    });

    const view = applyCalcFilter(arr).slice();
    applyRunningTotals(view);

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
tbody.innerHTML = "";
    view.forEach(r => {
      tbody.appendChild(makeRow(r));
    });

    clearLastAddedPaymentId();
    savePayments(arr);
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

      <td class="ro" style="${toNum(r.pay_main ?? 0) < -0.0000001 ? 'color:#8B0000; font-weight:700;' : ''}">${fmtMoney(r.pay_main ?? 0)}</td>
      <td class="ro">${(toNum(r.paid ?? 0) > 0.0000001) ? "" : fmtMoney(r.pay_penalty ?? 0)}</td>
      <td class="ro">${fmtMoney(toNum(r.pay_main ?? 0) + toNum(r.pay_penalty ?? 0))}</td>

      <td>
        <textarea class="note-inline" placeholder="" style="width:100%; min-height:34px; resize:vertical;" ${locked ? "readonly" : ""}>${escapeHtml(r.note || "")}</textarea>
      </td>

      <td class="id-cell">
        <div style="display:flex; gap:6px; align-items:center; justify-content:space-between;">
          <span>${r.id}</span>
          <button class="row-del" type="button" title="Удалить" style="${(locked || _hasAccrued) ? "display:none" : ""}">✖</button>
        </div>
      </td>
    `;

    bindRowEvents(tr, r.id);
    return tr;
  }

  const noteTimers = new Map();
  function saveNoteDebounced(rowId, value) {
    if (noteTimers.has(rowId)) clearTimeout(noteTimers.get(rowId));
    const t = setTimeout(() => {
      const arr = getPayments();
      const row = arr.find(x => String(x.id) === String(rowId));
      if (!row) return;
      row.note = value || "";
      savePayments(arr);
    }, 250);
    noteTimers.set(rowId, t);
  }

  function bindRowEvents(tr, rowId) {
    // Если строка импортирована из Excel и заблокирована — запрещаем любые изменения/удаление.
    // UI уже ставит readonly/disabled, но дополнительно блокируем обработчики, чтобы нельзя было обойти через DevTools.
    try {
      const arr0 = getPayments();
      const row0 = arr0.find(x => String(x.id) === String(rowId));
      if (isPaymentLocked(row0) || isAccrualRowGlobal(row0)) {
        return;
      }
    } catch {}

    const toggle = qs(".toggle-period", tr);
    if (toggle) {
      toggle.addEventListener("click", () => {
        const arr = getPayments();
        const row = arr.find(x => String(x.id) === String(rowId));
        if (!row) return;

        if (toggle.tagName === "BUTTON") {
          row.use_period = true;
          // default period = month/year строки (но НЕ блокируем редактирование)
          enforcePeriodSameAsYm(row);
          normalizePeriod(row);
          savePayments(arr);
          loadPaymentTable();
          return;
        }

        if (toggle.type === "checkbox") {
          row.use_period = !!toggle.checked;
          if (row.use_period) {
            // default period = month/year строки, дальше оператор правит сам
            enforcePeriodSameAsYm(row);
            normalizePeriod(row);
          }
          savePayments(arr);
          loadPaymentTable();
        }
      });
    }

    qsa(".f", tr).forEach(el => {
      const field = el.dataset.field;
      const needFullRerender = (field.startsWith("period_"));

      if (needFullRerender) {
        el.addEventListener("change", () => {
          const arr = getPayments();
          const row = arr.find(x => String(x.id) === String(rowId));
          if (!row) return;

          row[field] = el.value;

          // period strings (period_from/period_to) должны обновиться
          normalizePeriod(row);

          savePayments(arr);
          loadPaymentTable();
        });
        return;
      }


      // CRITICAL: type=date — никаких перерисовок на input (иначе календарь сбивается).
      if (field === "paid_date") {
        el.addEventListener("change", () => {
          const arr = getPayments();
          const row = arr.find(x => String(x.id) === String(rowId));
          if (!row) return;

          row[field] = el.value;
          syncYearMonthFromPaidDate(row);
          savePayments(arr);

          // Перерисовываем ТОЛЬКО после выбора даты
          loadPaymentTable();
        });
        return;
      }

      el.addEventListener("input", () => {
        const arr = getPayments();
        const row = arr.find(x => String(x.id) === String(rowId));
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
          savePayments(arr);
          refreshRunningTotalsInDOM();
          return;
        }

        savePayments(arr);
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
    paidEl.addEventListener("blur", () => {
      const arr = getPayments();
      const row = arr.find(x => String(x.id) === String(rowId));
      if (!row) return;
      paidEl.value = fmtMoneyHuman(row.paid);
      savePayments(arr);
      refreshRunningTotalsInDOM();
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
    srcSel.addEventListener('change', () => {
      let val = String(srcSel.value || '').trim();
      const arr = getPayments();
      const row = arr.find(x => String(x.id) === String(rowId));
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
        savePayments(arr);
        loadPaymentTable();
        return;
      }

      row.source = val || (ensurePaymentSources()[0] || '');
      savePayments(arr);
    });
  }



    const noteArea = qs(".note-inline", tr);
    if (noteArea) {
      noteArea.addEventListener("input", () => saveNoteDebounced(rowId, noteArea.value));
      noteArea.addEventListener("blur", () => {
        const arr = getPayments();
        const row = arr.find(x => String(x.id) === String(rowId));
        if (!row) return;
        row.note = noteArea.value || "";
        savePayments(arr);
      });
    }

    const delBtn = qs(".row-del", tr);
    if (delBtn) {
      delBtn.addEventListener("click", () => {
        if (!confirm("Удалить оплату?")) return;
        let arr = getPayments();
        arr = arr.filter(x => String(x.id) !== String(rowId));
        savePayments(arr);
        loadPaymentTable();
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


  window.__loadPaymentTable = loadPaymentTable;

  window.addPaymentRow = function addPaymentRow() {
    const arr = getPayments();
    const nextId = arr.length ? Math.max(...arr.map(x => Number(x.id) || 0)) + 1 : 1;

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
      total_debt: 0
    };

    arr.push(row);
    savePayments(arr);

    // ✅ Итог карточки (Всего задолженность = Долг + Пени)
    JKH_RecalcAbonentTotalDebtCard();
    // ✅ Заголовки колонок
    JKH_RenameDebtPenaltyHeaders();
    setLastAddedPaymentId(nextId);
    loadPaymentTable();
  };

  document.addEventListener("DOMContentLoaded", () => {
    loadPaymentTable();
        JKH_RenameDebtPenaltyHeaders();
    JKH_RecalcAbonentTotalDebtCard();
// ✅ важно: повесить обработчик сворачивания месяцев сразу, не дожидаясь редактирования полей
    try { refreshRunningTotalsInDOM(); } catch(e) {}
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

      btnSave.onclick = () => {
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
          if (oldName && oldName !== v && typeof getPayments === 'function' && typeof savePayments === 'function') {
            const pays = getPayments() || [];
            let ch = false;
            for (const p of pays) {
              if (String(p?.source || '').trim() === oldName) { p.source = v; ch = true; }
            }
            if (ch) savePayments(pays);
          }
        } catch {}

        renderSourcesModalList();
        try { loadPaymentTable(); } catch {}
      };

      btnDel.onclick = () => {
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
          if (changed && typeof savePayments === 'function') savePayments(payments);

          const next = sourcesNow.filter((_,i)=>i!==idx);
          if (!next.length){
            alert('Нельзя удалить все источники. Останется минимум один.');
            return;
          }
          savePaymentSources(next);

          renderSourcesModalList();
          try { loadPaymentTable(); } catch {}
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
        try { loadPaymentTable(); } catch {}
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

  window.addPaymentSourceFromModal = function(){
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
    try { loadPaymentTable(); } catch {}
  };


})();
