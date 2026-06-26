/* premises_admin.js
   Страница управления квартирами/адресами (premises)
   Не ломает существующий проект: работает поверх window.AbonentsDB
*/

const PREMISES_ADMIN_VERSION = '20260626-runtime-db';
window.PREMISES_FILE_VERSION = '20260626-A';
console.log('PREMISES FILE EXECUTED');
console.log('[premises][script-loaded]', {
    file: 'premises_admin.js',
    version: PREMISES_ADMIN_VERSION,
    src: document.currentScript && document.currentScript.src ? document.currentScript.src : null
});

window.PremisesAdmin = (function () {
    function q(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#039;'}[m]));
    }

    function normStr(s) { return String(s ?? '').trim(); }
    function normalizePersonText(v) {
        return String(v || '')
            .toLowerCase()
            .replace(/ё/g, 'е')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    function splitPersonParts(v) {
        return normalizePersonText(v).split(' ').filter(Boolean);
    }
    function softFioMatch(excelRow, abonent) {
        const excelParts = splitPersonParts([
            excelRow && excelRow.fam,
            excelRow && excelRow.name,
            excelRow && excelRow.otch,
            excelRow && excelRow.fio
        ].filter(Boolean).join(' '));
        const dbParts = splitPersonParts([
            abonent && abonent.fam,
            abonent && abonent.name,
            abonent && abonent.otch,
            abonent && abonent.fio
        ].filter(Boolean).join(' '));
        if (!excelParts.length || !dbParts.length) return true;
        const excelSurname = excelParts[0] || '';
        const dbSurname = dbParts[0] || '';
        if (excelSurname && dbSurname && excelSurname !== dbSurname) return false;
        const dbSet = new Set(dbParts);
        let hits = 0;
        for (const part of excelParts) {
            if (dbSet.has(part)) hits++;
        }
        return hits >= 1;
    }
    function normRegnum(s) { return normStr(s).replace(/\s+/g, ''); }
    function normalizeOfficialRegnum(s) { return normStr(s).replace(/\s+/g, ' '); }
    function findOfficialRegnumDuplicate(db, officialRegnum, selfRegnum) {
        const target = normalizeOfficialRegnum(officialRegnum);
        if (!target) return null;
        const premises = db?.premises || {};
        return Object.keys(premises).find(reg =>
            String(reg) !== String(selfRegnum || '') &&
            normalizeOfficialRegnum(premises[reg]?.officialRegnum) === target
        ) || null;
    }

    // -----------------------------
    // ✅ MULTI-DB SCOPE (admin can view user базы / ALL)
    // -----------------------------
    const KEY_DB = "abonents_db_v1";

    function getActiveOwnerId() {
        try {
            if (window.Auth && typeof Auth.getActiveDbOwnerId === "function") return Auth.getActiveDbOwnerId();
            if (window.JKHStorage && typeof JKHStorage.getActiveOwnerId === "function") return JKHStorage.getActiveOwnerId();
        } catch (e) {}
        return "guest";
    }

    function isAllMode() { return getActiveOwnerId() === "ALL"; }
    function isGuest() {
        try { if (window.Auth && typeof Auth.isGuest === "function") return Auth.isGuest(); } catch (e) {}
        return getActiveOwnerId() === "guest";
    }

    function canWriteOrExplainLocal() {
        try {
            if (typeof window.canWriteOrExplain === "function") return window.canWriteOrExplain();
        } catch (e) {}
        if (isGuest()) { alert('Гость: только просмотр.'); return false; }
        if (isAllMode()) { alert('Режим "все базы" — только просмотр. Выберите конкретную базу (админ/юзер), чтобы сохранять.'); return false; }
        return true;
    }

    function kScoped(key, ownerId) {
        try { if (window.JKHStorage && typeof JKHStorage.k === "function") return JKHStorage.k(key, ownerId); } catch (e) {}
        return "jkhdb::UNBOUND::" + String(ownerId || getActiveOwnerId()) + "::" + key;
    }

    function safeParse(raw, fallback) {
        try { return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
    }

    var ownersCache = [];
    var ownersLoading = false;
    function normalizeOwners(users) {
        users = Array.isArray(users) ? users : [];

        // sort: admin(s) first, then users by email
        users.sort(function(a, b){
            var ra = (a && a.role === "admin") ? 0 : 1;
            var rb = (b && b.role === "admin") ? 0 : 1;
            if (ra !== rb) return ra - rb;
            var ea = String((a && a.email) || "").toLowerCase();
            var eb = String((b && b.email) || "").toLowerCase();
            return ea.localeCompare(eb, "ru");
        });

        return users
            .map(function(u){ return ({ id: u.id, email: (u.email || ""), role: (u.role || "user") }); })
            .filter(function(u){ return !!u.id; });
    }
    function refreshOwnersCache() {
        if (ownersLoading) return;
        if (!(window.Auth && typeof Auth.adminListUsers === "function")) return;
        ownersLoading = true;
        Auth.adminListUsers()
            .then(function(list){
                ownersCache = normalizeOwners(list);
            })
            .catch(function(){})
            .finally(function(){
                ownersLoading = false;
                try { renderTable(); } catch (e) {}
            });
    }
    function listAllOwnersSorted() {
        refreshOwnersCache();
        return ownersCache.slice();
    }

    function loadDbForOwner(ownerId) {
        const raw = (window.JKHStore && typeof JKHStore.getRaw === "function")
            ? JKHStore.getRaw(KEY_DB, ownerId)
            : null;
        const parsed = safeParse(raw, null);
        if (parsed && typeof parsed === "object") return parsed;
        return { premises: {}, links: [], abonents: {} };
    }

    function countDb(db) {
        return {
            abonentsCount: db && db.abonents && typeof db.abonents === 'object' ? Object.keys(db.abonents).length : 0,
            premisesCount: db && db.premises && typeof db.premises === 'object' ? Object.keys(db.premises).length : 0,
            linksCount: db && Array.isArray(db.links) ? db.links.length : 0
        };
    }

    function hasDbContent(db) {
        const c = countDb(db);
        return !!(c.abonentsCount || c.premisesCount || c.linksCount);
    }

    async function hydrateRuntimeDbFromStore(reason) {
        const current = window.AbonentsDB;
        if (hasDbContent(current)) {
            return countDb(current);
        }

        const raw = (window.JKHStore && typeof JKHStore.getRaw === "function")
            ? JKHStore.getRaw(KEY_DB, getActiveOwnerId())
            : null;
        const parsed = safeParse(raw, null);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && hasDbContent(parsed)) {
            window.AbonentsDB = parsed;
        } else if (!hasDbContent(current)) {
            window.AbonentsDB = current && typeof current === 'object'
                ? current
                : { abonents: {}, premises: {}, links: [] };
        }

        const ready = countDb(window.AbonentsDB);
        console.log('[premises][db-ready]', ready);
        return ready;
    }

    async function ensureRuntimeHydration(reason) {
        try {
            if (window.Data && typeof Data.waitForServerFirstDataReady === 'function') {
                await Data.waitForServerFirstDataReady({ timeoutMs: 8000 });
            } else if (window.JKHDataLoader && typeof window.JKHDataLoader.loadFromServer === 'function') {
                await window.JKHDataLoader.loadFromServer({ force: false, reason: reason || 'premises_init' });
            }
        } catch (e) {}
        return await hydrateRuntimeDbFromStore(reason);
    }

    const GROUP_COLORS = [
        "#EAF3FF", // light blue
        "#EAFBEA", // light green
        "#FFF6E5", // light orange
        "#F3E8FF", // light purple
        "#FFEAF1", // light pink
        "#E9FBFF", // light cyan
        "#F4F4F4"  // light gray
    ];


    // -----------------------------
    // regnum может быть неизвестен при создании (двухэтапная фиксация)
    // TEMP-* допускается как временный ключ. Настоящий regnum фиксируется 1 раз.
    // -----------------------------
    function isTempRegnum(regnum) {
        const r = String(regnum || '');
        return r.startsWith('TEMP-');
    }

    function todayCompact() {
        const d = new Date();
        const y = String(d.getFullYear());
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}${m}${day}`;
    }

    function genTempRegnum(db) {
        // TEMP-YYYYMMDD-XXXX (где XXXX случайное) + гарантируем уникальность в db.premises
        const premises = db?.premises || {};
        for (let i = 0; i < 50; i++) {
            const rnd = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
            const candidate = `TEMP-${todayCompact()}-${rnd}`;
            if (!premises[candidate]) return candidate;
        }
        // fallback
        return `TEMP-${todayCompact()}-${Date.now()}`;
    }

    function setRegnumHint(text) {
        const el = q('p_regnum_hint');
        if (!el) return;
        el.textContent = text || '';
    }

    function applyRegnumUIState(premise) {
        const inp = q('p_regnum');
        const chk = q('p_regnum_unknown');
        if (!inp || !chk) return;

        const locked = !!premise?.regnumLocked || (!isTempRegnum(premise?.regnum) && !!premise?.regnum);
        // temp определяется по данным; если данных нет (режим добавления) — temp берём из текущего чекбокса
        const temp = isTempRegnum(premise?.regnum) || (!premise?.regnum && chk.checked === true);

        // состояние checkbox: если premise прямо говорит что temp/locked — подчиняемся данным, иначе оставляем как выбрал пользователь
        if (isTempRegnum(premise?.regnum)) chk.checked = true;
        if (locked) chk.checked = false;

        if (locked) {
            // обычный regnum или уже зафиксирован
            chk.disabled = true;
            inp.disabled = true;
            setRegnumHint('Зафиксирован. Изменение запрещено.');
            return;
        }

        // временный/неизвестный: можно снять галочку и ввести настоящий regnum
        chk.disabled = false;
        if (chk.checked) {
            inp.disabled = true;
            setRegnumHint('regnum неизвестен: будет создан временный. Позже сними галочку, введи настоящий номер и нажми “Сохранить”.');
        } else {
            inp.disabled = false;
            setRegnumHint('После ввода настоящего regnum он будет зафиксирован и больше не изменится.');
        }
    }

    function renamePremiseRegnumOnce(db, oldRegnum, newRegnum) {
        const oldKey = String(oldRegnum);
        const newKey = String(newRegnum);
        if (!db?.premises?.[oldKey]) {
            return { ok: false, reason: 'NOT_FOUND', message: 'Ошибка: исходный объект не найден.' };
        }
        if (!newKey) {
            return { ok: false, reason: 'EMPTY', message: 'Нельзя зафиксировать пустой regnum.' };
        }
        if (db.premises[newKey] && newKey !== oldKey) {
            // если такой regnum уже есть — запрещаем
            return { ok: false, reason: 'DUP', message: 'Такой regnum уже существует. Нельзя зафиксировать.' };
        }

        const p = db.premises[oldKey];
        const lockedAlready = !!p?.regnumLocked;
        if (lockedAlready && oldKey !== newKey) {
            return { ok: false, reason: 'LOCKED', message: 'regnum уже зафиксирован и не может быть изменён.' };
        }

        // 1) перенос premise под новый ключ
        const next = { ...p, regnum: newKey, regnumLocked: true, regnumTemp: false };
        delete db.premises[oldKey];
        db.premises[newKey] = next;

        // 2) обновляем связи
        (db.links || []).forEach(l => {
            if (String(l?.regnum) === oldKey) l.regnum = newKey;
        });

        // 3) синхроним legacy-поля абонентов
        syncLegacyFieldsForRegnum(db, newKey);

        // 4) если сейчас редактируем — обновим указатель
        if (state.editingRegnum === oldKey) state.editingRegnum = newKey;

        return { ok: true, newRegnum: newKey };
    }

    // -----------------------------
    // ✅ AUTOCOMPLETE (datalist)
    // -----------------------------
    function baseKey(s) {
        // ключ для уникализации (без лишних пробелов, регистр вниз)
        return normStr(s).toLowerCase().replace(/\s+/g, ' ');
    }

    function collectCitiesAndStreets(db) {
        const citiesMap = new Map();  // key -> original
        const streetsByCity = new Map(); // cityKey -> Map(streetKey->streetOriginal)
        const allStreetsMap = new Map(); // key -> original

        const add = (city, street) => {
            const c = normStr(city);
            const s = normStr(street);

            if (c) {
                const ck = baseKey(c);
                if (!citiesMap.has(ck)) citiesMap.set(ck, c);
                if (!streetsByCity.has(ck)) streetsByCity.set(ck, new Map());
            }
            if (s) {
                const sk = baseKey(s);
                if (!allStreetsMap.has(sk)) allStreetsMap.set(sk, s);

                if (c) {
                    const ck = baseKey(c);
                    const m = streetsByCity.get(ck);
                    if (m && !m.has(sk)) m.set(sk, s);
                }
            }
        };

        // 1) premises (основной источник)
        const premises = db?.premises || {};
        Object.keys(premises).forEach(r => {
            const p = premises[r];
            add(p?.city, p?.street);
        });

        // 2) abonents (на случай старых данных без premises)
        const abonents = db?.abonents || {};
        Object.keys(abonents).forEach(id => {
            const a = abonents[id];
            add(a?.city, a?.street);
        });

        return { citiesMap, streetsByCity, allStreetsMap };
    }

    function renderDatalistOptions(datalistEl, valuesArray) {
        if (!datalistEl) return;
        const uniq = (valuesArray || []).filter(Boolean);
        datalistEl.innerHTML = uniq.map(v => `<option value="${esc(v)}"></option>`).join('');
    }

    function refreshCityDatalist() {
        const db = window.AbonentsDB;
        const { citiesMap } = collectCitiesAndStreets(db);
        const list = Array.from(citiesMap.values()).sort((a,b) => a.localeCompare(b, 'ru'));
        renderDatalistOptions(q('cityList'), list);
    }

    function refreshStreetDatalist() {
        const db = window.AbonentsDB;
        const { streetsByCity, allStreetsMap } = collectCitiesAndStreets(db);

        const cityVal = normStr(q('p_city')?.value);
        const cityKey = cityVal ? baseKey(cityVal) : '';

        let streets = [];
        if (cityKey && streetsByCity.has(cityKey)) {
            streets = Array.from(streetsByCity.get(cityKey).values());
        } else {
            streets = Array.from(allStreetsMap.values());
        }

        streets.sort((a,b) => a.localeCompare(b, 'ru'));
        renderDatalistOptions(q('streetList'), streets);
    }

    function refreshAddressDatalists() {
        refreshCityDatalist();
        refreshStreetDatalist();
    }

    function collectHousesForCityStreet(db, city, street) {
        const out = new Map();
        const cityKey = baseKey(city);
        const streetKey = baseKey(street);
        if (!cityKey || !streetKey) return [];

        const add = (c, s, h) => {
            const cc = baseKey(c);
            const ss = baseKey(s);
            const hh = normStr(h);
            if (!hh) return;
            if (cc !== cityKey || ss !== streetKey) return;
            const hk = baseKey(hh);
            if (!out.has(hk)) out.set(hk, hh);
        };

        const premises = db?.premises || {};
        Object.keys(premises).forEach(r => {
            const p = premises[r];
            add(p?.city, p?.street, p?.house);
        });

        const abonents = db?.abonents || {};
        Object.keys(abonents).forEach(id => {
            const a = abonents[id];
            add(a?.city, a?.street, a?.house);
        });

        return Array.from(out.values()).sort((a, b) => a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' }));
    }

    const HOUSE_NEW_VALUE = '__HOUSE_NEW__';

    function ensureHouseSelectorUI() {
        const original = q('p_house');
        if (!original || q('p_house_select')) return;

        original.style.display = 'none';

        const holder = document.createElement('div');
        holder.id = 'p_house_selector_wrap';
        holder.style.display = 'grid';
        holder.style.gap = '6px';

        const select = document.createElement('select');
        select.id = 'p_house_select';
        select.innerHTML = `<option value="${HOUSE_NEW_VALUE}">+ новый дом</option>`;

        const input = document.createElement('input');
        input.id = 'p_house_new';
        input.placeholder = 'например: дом 50';
        input.style.display = '';

        holder.appendChild(select);
        holder.appendChild(input);
        original.insertAdjacentElement('afterend', holder);
    }

    function syncHouseModelFromUi() {
        const original = q('p_house');
        const select = q('p_house_select');
        const input = q('p_house_new');
        if (!original || !select || !input) return;
        const isNew = select.value === HOUSE_NEW_VALUE;
        input.style.display = isNew ? '' : 'none';
        original.value = isNew ? normStr(input.value) : normStr(select.value);
    }

    function refreshHouseChoices() {
        const select = q('p_house_select');
        const input = q('p_house_new');
        const original = q('p_house');
        if (!select || !input || !original) return;

        const current = normStr(original.value);
        const city = normStr(q('p_city')?.value);
        const street = normStr(q('p_street')?.value);
        const houses = collectHousesForCityStreet(window.AbonentsDB, city, street);

        const options = houses.map(h => `<option value="${esc(h)}">${esc(h)}</option>`).join('');
        select.innerHTML = `${options}<option value="${HOUSE_NEW_VALUE}">+ новый дом</option>`;

        if (current && houses.some(h => baseKey(h) === baseKey(current))) {
            const matched = houses.find(h => baseKey(h) === baseKey(current)) || current;
            select.value = matched;
            input.value = '';
            input.style.display = 'none';
        } else {
            select.value = HOUSE_NEW_VALUE;
            input.value = current;
            input.style.display = '';
        }
    }

    // -----------------------------
    // Нормализация частей адреса для сравнения (контроль дублей)
    // -----------------------------
    function baseNorm(s) {
        return String(s ?? '')
            .replace(/[“”«»"]/g, '')
            .replace(/ё/g, 'е')
            .trim()
            .replace(/\s+/g, ' ');
    }
    function stripPunct(s) {
        return baseNorm(s).replace(/[.,;:()]/g, ' ').replace(/\s+/g, ' ').trim();
    }
    function normalizeCityPart(city) {
        let s = stripPunct(city).toLowerCase();
        s = s.replace(/\bгород\b/g, ' ').replace(/\bг\b\.?/g, ' ');
        s = s.replace(/\s+/g, ' ').trim();
        if (s === 'спб' || s === 'cпб' || s === 'санкт петербург' || s === 'санкт-петербург') return 'санкт-петербург';
        if (s === 'мск' || s === 'москва') return 'москва';
        return s;
    }
    function normalizeStreetPart(street) {
        let s = stripPunct(street).toLowerCase();
        s = s
            .replace(/\bулица\b/g, ' ')
            .replace(/\bул\b\.?/g, ' ')
            .replace(/\bпроспект\b/g, ' ')
            .replace(/\bпр\b\.?/g, ' ')
            .replace(/\bпр-т\b/g, ' ')
            .replace(/\bпереулок\b/g, ' ')
            .replace(/\bпер\b\.?/g, ' ')
            .replace(/\bбульвар\b/g, ' ')
            .replace(/\bбул\b\.?/g, ' ')
            .replace(/\bнабережная\b/g, ' ')
            .replace(/\bнаб\b\.?/g, ' ')
            .replace(/\bшоссе\b/g, ' ')
            .replace(/\bш\b\.?/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        s = s.replace(/\bимени\b/g, ' ').replace(/\bим\b\.?/g, ' ').replace(/\s+/g, ' ').trim();
        return s;
    }
    function normalizeHousePart(house) {
        let s = stripPunct(house).toLowerCase();
        s = s.replace(/\bдом\b/g, ' ').replace(/\bд\b\.?/g, ' ');
        s = s.replace(/\s+/g, ' ').trim();
        s = s.replace(/\bкорпус\b/g, 'к').replace(/\bк\b\.?/g, 'к');
        s = s.replace(/\bстроение\b/g, 'с').replace(/\bстр\b\.?/g, 'с');
        s = s.replace(/\s*к\s*/g, 'к').replace(/\s*с\s*/g, 'с');
        s = s.replace(/\s+/g, '').trim();
        return s;
    }
    function normalizeFlatPart(flat) {
        let s = stripPunct(flat).toLowerCase();
        s = s.replace(/\bквартира\b/g, ' ').replace(/\bкв\b\.?/g, ' ');
        s = s.replace(/\s+/g, ' ').trim();
        s = s.replace(/\s+/g, '').trim();
        return s;
    }

    // ============================================================
    // 🔒 CRITICAL: запрет одинаковых адресов при пересечении по времени
    // Разрешено иметь 2 premises с одинаковым адресом ТОЛЬКО если интервалы ответственности (links)
    // НЕ пересекаются (стык допускается).
    function addrKeyNormalized(p) {
        return [
            normalizeCityPart(p.city),
            normalizeStreetPart(p.street),
            normalizeHousePart(p.house),
            normalizeFlatPart(p.flat),
        ].join('|');
    }
    function toEndIso(d) {
        const s = baseNorm(d);
        return s ? s : '9999-12-31';
    }
    function toStartIso(d) {
        const s = baseNorm(d);
        return s ? s : '1900-01-01';
    }
    function intervalsOverlap(aFrom, aTo, bFrom, bTo) {
        const A1 = toStartIso(aFrom);
        const A2 = toEndIso(aTo);
        const B1 = toStartIso(bFrom);
        const B2 = toEndIso(bTo);
        return (A1 <= B2) && (B1 <= A2);
    }
    function getIntervalsForRegnum(db, regnum) {
        const res = [];
        const links = Array.isArray(db.links) ? db.links : [];
        for (let i = 0; i < links.length; i++) {
            const l = links[i];
            if (!l) continue;
            if (String(l.regnum || '') !== String(regnum || '')) continue;
            res.push({ from: l.dateFrom || '1900-01-01', to: l.dateTo || '' });
        }
        if (res.length) return res;

        // fallback: если links ещё нет — считаем, что объект активен с createdAt (или 1900-01-01)
        const p = db.premises && db.premises[regnum];
        const createdAt = p && p.createdAt ? String(p.createdAt) : '1900-01-01';
        return [{ from: createdAt, to: '' }];
    }
    function getIntervalsForNewPremise(form) {
        const today = new Date().toISOString().slice(0, 10);
        const createdAt = form && form.createdAt ? String(form.createdAt).trim() : '';
        return [{ from: createdAt || today, to: '' }];
    }
    function checkAddressTimeConflict(db, addrKey, candidateIntervals, excludeRegnum) {
        if (!db || !db.premises) return null;
        const keys = Object.keys(db.premises || {});
        for (let i = 0; i < keys.length; i++) {
            const reg = keys[i];
            if (excludeRegnum && String(reg) === String(excludeRegnum)) continue;

            const p = db.premises[reg];
            if (!p) continue;
            if (addrKeyNormalized(p) !== addrKey) continue;

            const intervalsB = getIntervalsForRegnum(db, reg);
            for (let a = 0; a < candidateIntervals.length; a++) {
                const ia = candidateIntervals[a];
                for (let b = 0; b < intervalsB.length; b++) {
                    const ib = intervalsB[b];
                    if (intervalsOverlap(ia.from, ia.to, ib.from, ib.to)) {
                        return { regnum: reg, a: ia, b: ib };
                    }
                }
            }
        }
        return null;
    }


    function addrScore(input, existing) {
        // score 0..12
        const ic = normalizeCityPart(input.city);
        const is = normalizeStreetPart(input.street);
        const ih = normalizeHousePart(input.house);
        const ifl = normalizeFlatPart(input.flat);

        const ec = normalizeCityPart(existing.city);
        const es = normalizeStreetPart(existing.street);
        const eh = normalizeHousePart(existing.house);
        const efl = normalizeFlatPart(existing.flat);

        function scorePart(a, b) {
            if (!a || !b) return { s: 0, kind: '' };
            if (a === b) return { s: 3, kind: 'hit' };
            if (a.startsWith(b) || b.startsWith(a)) return { s: 2, kind: 'near' };
            if (a.includes(b) || b.includes(a)) return { s: 1, kind: 'near' };
            return { s: 0, kind: '' };
        }

        const r1 = scorePart(ic, ec);
        const r2 = scorePart(is, es);
        const r3 = scorePart(ih, eh);
        const r4 = scorePart(ifl, efl);

        return {
            score: r1.s + r2.s + r3.s + r4.s,
            hits: { city: r1.kind, street: r2.kind, house: r3.kind, flat: r4.kind }
        };
    }

    function toISODateFromInput(v) {
        // input type=date уже ISO yyyy-mm-dd
        return normStr(v);
    }

    function numOrEmpty(v) {
        if (v === '' || v === null || v === undefined) return '';
        const n = Number(v);
        return Number.isFinite(n) ? n : '';
    }

    function activeLinkForRegnum(db, regnum) {
        const r = String(regnum);
        // активная = dateTo пусто
        return (db.links || []).find(l => String(l?.regnum) === r && (!l?.dateTo || String(l.dateTo).trim() === '')) || null;
    }

    function fioById(db, abonentId) {
        const a = db.abonents?.[String(abonentId)];
        return a?.fio || '';
    }

    function hasAnyLinks(db, regnum) {
        const r = String(regnum);
        return (db.links || []).some(l => String(l?.regnum) === r);
    }

    function sameAddress(p, city, street, house, flat) {
        const norm = (x) => normStr(x).toLowerCase();
        return norm(p?.city) === norm(city) && norm(p?.street) === norm(street) && norm(p?.house) === norm(house) && norm(p?.flat) === norm(flat);
    }

    function parseFlatSortParts(flat) {
        const raw = normStr(flat);
        const m = raw.match(/^(\d+)\s*([^\d].*)?$/u);
        if (m) {
            return {
                hasNum: true,
                num: Number(m[1]),
                suffix: normStr(m[2] || '').toLowerCase(),
                raw: raw.toLowerCase()
            };
        }
        return { hasNum: false, num: -1, suffix: '', raw: raw.toLowerCase() };
    }

    function comparePremisesByFlatDesc(a, b) {
        const pa = parseFlatSortParts(a?.flat);
        const pb = parseFlatSortParts(b?.flat);

        if (pa.hasNum && pb.hasNum && pa.num !== pb.num) return pb.num - pa.num;
        if (pa.hasNum !== pb.hasNum) return pa.hasNum ? -1 : 1;

        const suffixCmp = pb.suffix.localeCompare(pa.suffix, 'ru', { numeric: true, sensitivity: 'base' });
        if (suffixCmp !== 0) return suffixCmp;

        return String(b?.flat || '').localeCompare(String(a?.flat || ''), 'ru', { numeric: true, sensitivity: 'base' });
    }

    const BUSY_NAVIGATION_MESSAGE = 'Сохранение на сервер… не переходите на другую страницу.';
    let state = { editingRegnum: null, busy: false };
    let navigationGuardsBound = false;
    let importOpenContext = null;
    let importOpenContextBlocked = false;

    function setBusyUI(isBusy) {
        state.busy = !!isBusy;
        ['btnPremSave','btnPremReset','btnCreateAbonentFromPremise'].forEach(id => {
            const el = q(id);
            if (el) el.disabled = !!isBusy;
        });
        q('premSearch') && (q('premSearch').disabled = !!isBusy);
        const rowBtns = document.querySelectorAll('#premisesTable button[data-act]');
        rowBtns.forEach(btn => { btn.disabled = !!isBusy; });
        if (state.busy) setWarn(BUSY_NAVIGATION_MESSAGE, false);
    }

    function beforeUnloadGuard(e) {
        if (!state.busy) return;
        e.preventDefault();
        e.returnValue = BUSY_NAVIGATION_MESSAGE;
        return BUSY_NAVIGATION_MESSAGE;
    }

    function isModifiedOrNonPrimaryClick(e) {
        return e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
    }

    function resolveAnchorUrl(anchor) {
        const rawHref = String(anchor?.getAttribute('href') || '').trim();
        if (!rawHref || rawHref === '#' || rawHref.toLowerCase().startsWith('javascript:')) return null;
        try {
            return new URL(rawHref, window.location.href);
        } catch (e) {
            return null;
        }
    }

    function isSameDocumentUrl(url) {
        if (!url) return true;
        return (
            url.origin === window.location.origin &&
            url.pathname === window.location.pathname &&
            url.search === window.location.search
        );
    }

    function anchorNavigationGuard(e) {
        if (!state.busy) return;
        if (e.defaultPrevented || isModifiedOrNonPrimaryClick(e)) return;

        const anchor = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!anchor) return;

        const target = String(anchor.getAttribute('target') || '').toLowerCase();
        if (target && target !== '_self') return;

        const url = resolveAnchorUrl(anchor);
        if (!url || isSameDocumentUrl(url)) return;

        e.preventDefault();
        e.stopPropagation();
        setWarn(BUSY_NAVIGATION_MESSAGE, false);
    }

    function bindNavigationGuards() {
        if (navigationGuardsBound) return;
        navigationGuardsBound = true;
        window.addEventListener('beforeunload', beforeUnloadGuard);
        document.addEventListener('click', anchorNavigationGuard, true);
    }

    function collectAffectedAbonentIdsByRegnums(db, regnums) {
        const set = new Set();
        const links = Array.isArray(db?.links) ? db.links : [];
        const regSet = new Set((regnums || []).map(r => String(r || '').trim()).filter(Boolean));
        links.forEach(l => {
            const r = String(l?.regnum || '').trim();
            const a = String(l?.abonentId || '').trim();
            if (!a) return;
            if (regSet.has(r)) set.add(a);
        });
        return Array.from(set);
    }

    function deepCloneRuntimeDb(db) {
        if (typeof structuredClone === 'function') return structuredClone(db);
        return JSON.parse(JSON.stringify(db || { premises: {}, links: [], abonents: {} }));
    }

    function makeTxSnapshot() {
        return {
            db: deepCloneRuntimeDb(window.AbonentsDB || { premises: {}, links: [], abonents: {} }),
            editingRegnum: state.editingRegnum
        };
    }

    function restoreFromTxSnapshot(snapshot) {
        if (!snapshot || !snapshot.db) return;
        window.AbonentsDB = deepCloneRuntimeDb(snapshot.db);
        console.log("[runtime-db-keys]", Object.keys(window.AbonentsDB || {}));
        console.log(
            "[runtime-abonents-count]",
            window.AbonentsDB && window.AbonentsDB.abonents
                ? Object.keys(window.AbonentsDB.abonents).length
                : "missing"
        );
        state.editingRegnum = snapshot.editingRegnum ?? null;
        renderTable();
        refreshAddressDatalists();
        if (state.editingRegnum && window.AbonentsDB?.premises?.[state.editingRegnum]) {
            setFormModeEdit(state.editingRegnum);
        } else {
            setFormModeAdd();
        }
    }

    async function runExistingRecalcForAbonents(abonentIds) {
        const ids = Array.from(new Set((abonentIds || []).map(x => String(x || '').trim()).filter(Boolean)));
        if (!ids.length) return { ok: true, total: 0, changed: 0 };

        if (window.JKHBoot && typeof window.JKHBoot.waitFor === 'function') {
            try { await window.JKHBoot.waitFor(['autoaccrual'], 2000); } catch (e) {}
        }

        if (!(window.JKHAutoAccrual && typeof window.JKHAutoAccrual.recalcForMany === 'function')) {
            return { ok: false, reason: 'NO_RECALC_ENGINE', message: 'Не загружен autoaccrual_engine.js. Сохранение остановлено, чтобы не нарушить начисления.' };
        }
        const rowsOrPromise = window.JKHAutoAccrual.recalcForMany(ids);
        const rows = (rowsOrPromise && typeof rowsOrPromise.then === 'function')
            ? await rowsOrPromise
            : rowsOrPromise;
        const changed = (rows || []).filter(r => r && r.ok && r.changed).length;
        const failed = (rows || []).filter(r => !r || !r.ok);
        if (failed.length) {
            return { ok: false, reason: 'RECALC_FAILED', message: 'Ошибка пересчёта для части абонентов.' };
        }
        return { ok: true, total: ids.length, changed: changed };
    }

    function getPersistOwnerIdOrThrow() {
        const activeOwnerId = String(getActiveOwnerId() || '').trim();
        const storeOwnerId = (window.JKHStore && typeof window.JKHStore.getOwnerId === 'function')
            ? String(window.JKHStore.getOwnerId() || '').trim()
            : '';
        const ownerId = activeOwnerId || storeOwnerId;

        if (!ownerId || ownerId === 'guest' || ownerId === 'ALL') {
            throw new Error('SERVER_UPLOAD_FAILED');
        }

        if (storeOwnerId && activeOwnerId && storeOwnerId !== activeOwnerId) {
            console.error('[premises][save][owner-mismatch] active=' + activeOwnerId + ' store=' + storeOwnerId);
            throw new Error('OWNER_SCOPE_MISMATCH');
        }

        console.log('[premises][save][owner-check] active=' + activeOwnerId + ' owner=' + ownerId + ' ok=' + String(ownerId === activeOwnerId));
        return ownerId;
    }

    async function uploadOnlyAbonentsDbToServer(ownerId) {
        const rawOid = String(ownerId || '').trim();
        const oid = (window.JKHStore && typeof JKHStore.normalizeOwnerId === 'function')
            ? JKHStore.normalizeOwnerId(rawOid)
            : rawOid.replace(/^(LAB|PROD):/i, '');
        if (!oid || oid === 'guest' || oid === 'ALL') throw new Error('SERVER_UPLOAD_FAILED');
        const raw = JSON.stringify(window.AbonentsDB || { premises: {}, links: [], abonents: {} });

        let res = null;
        try {
            res = await fetch('/api/store', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ client_owner_hint: oid, key: KEY_DB, value: String(raw || '') })
            });
        } catch (e) {
            throw new Error('SERVER_UPLOAD_FAILED');
        }
        if (!res || !res.ok) throw new Error('SERVER_UPLOAD_FAILED');

        let data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        if (!(data && data.ok === true)) throw new Error('SERVER_UPLOAD_FAILED');
    }

    async function flushDbToServerStrict(ownerId) {
        const persistOwnerId = String(ownerId || getPersistOwnerIdOrThrow()).trim();

        if (window.JKHStore && window.AbonentsDB) {
            try {
                window.JKHStore.setJSON(KEY_DB, window.AbonentsDB, persistOwnerId);
            } catch (e) {
                throw new Error('Не удалось записать DB в storage: ' + (e?.message || e));
            }
        }

        await uploadOnlyAbonentsDbToServer(persistOwnerId);
        console.log('[premises][save] server flush ok owner=' + persistOwnerId);
        return true;
    }

    async function persistPremiseTransaction(opts) {
        if (state.busy) return;
        setBusyUI(true);
        const snapshot = makeTxSnapshot();
        try {
            const persistOwnerId = getPersistOwnerIdOrThrow();
            const tx = (opts && typeof opts.mutate === 'function') ? (opts.mutate() || {}) : {};
            if (tx && tx.ok === false) {
                restoreFromTxSnapshot(snapshot);
                setWarn(tx.message || 'Операция отменена.', false);
                return;
            }

            const affectedIds = Array.from(new Set([
                ...((opts && Array.isArray(opts.affectedAbonentIds)) ? opts.affectedAbonentIds : []),
                ...((tx && Array.isArray(tx.affectedAbonentIds)) ? tx.affectedAbonentIds : [])
            ].map(x => String(x || '').trim()).filter(Boolean)));

            const recalcRes = await runExistingRecalcForAbonents(affectedIds);
            if (!recalcRes.ok) {
                throw new Error(recalcRes.message || 'Не удалось выполнить пересчёт начислений.');
            }

            await flushDbToServerStrict(persistOwnerId);

            setWarn((opts && opts.successMessage) || 'Сохранено.', true);
            renderTable();
            refreshAddressDatalists();
            if (opts && typeof opts.onSuccess === 'function') opts.onSuccess(tx);
        } catch (e) {
            console.warn('[premises] transaction failed', e);
            restoreFromTxSnapshot(snapshot);
            if (String(e?.message || e) === 'SERVER_UPLOAD_FAILED') {
                console.log('[premises][save] rollback after SERVER_UPLOAD_FAILED');
            }
            setWarn('Ошибка сохранения: ' + (e?.message || e), false);
        } finally {
            setBusyUI(false);
        }
    }

    function renderDupHints() {
        const box = q('premDupBox');
        const body = q('premDupBody');
        if (!box || !body) return;

        const f = readForm();
        if (!f.city && !f.street && !f.house && !f.flat) {
            box.style.display = 'none';
            body.innerHTML = '';
            return;
        }

        const db = window.AbonentsDB;
        const premises = db?.premises || {};
        const excludeReg = state.editingRegnum ? String(state.editingRegnum) : null;

        const input = { city: f.city, street: f.street, house: f.house, flat: f.flat };

        const matches = Object.keys(premises)
            .map(r => premises[r])
            .filter(p => !excludeReg || String(p?.regnum) !== excludeReg)
            .map(p => ({ p, r: addrScore(input, p) }))
            .filter(x => x.r.score >= 6)
            .sort((a, b) => b.r.score - a.r.score)
            .slice(0, 6);

        if (!matches.length) {
            box.style.display = 'none';
            body.innerHTML = '';
            return;
        }

        function cell(val, kind) {
            const safe = esc(val || '');
            if (kind === 'hit') return `<span class="hit">${safe}</span>`;
            if (kind === 'near') return `<span class="near">${safe}</span>`;
            return safe;
        }

        const rows = matches.map(x => {
            const p = x.p;
            const h = x.r.hits;
            return `
                <tr>
                    <td class="mono">${esc(p.regnum)}</td>
                    <td>${cell(p.city, h.city)}</td>
                    <td>${cell(p.street, h.street)}</td>
                    <td>${cell(p.house, h.house)}</td>
                    <td>${cell(p.flat, h.flat)}</td>
                    <td style="width:70px; text-align:center;">${x.r.score}</td>
                </tr>
            `;
        }).join('');

        body.innerHTML = `
            <div class="small">Найдены похожие адреса. Проверь, не создаёшь ли дубль (подсвечены совпадения).</div>
            <table>
                <thead>
                    <tr>
                        <th style="width:210px;">regnum</th>
                        <th>город</th>
                        <th>улица</th>
                        <th style="width:110px;">дом</th>
                        <th style="width:120px;">кв</th>
                        <th style="width:70px;">скор</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
        box.style.display = 'block';
    }

    function goCreateAbonentForRegnum(regnum) {
        const r = String(regnum || '').trim();
        if (!r) return;
        window.location.href = `new_abonent.html?regnum=${encodeURIComponent(r)}`;
    }

    function readImportOpenContext() {
        try {
            const params = new URLSearchParams(window.location.search || '');
            if (String(params.get('from') || '').trim() !== 'import') return null;
            return {
                regnum: String(params.get('regnum') || '').trim(),
                uid: String(params.get('uid') || '').trim(),
                ls: String(params.get('ls') || '').trim(),
                fam: String(params.get('fam') || '').trim(),
                excelSquare: String(params.get('excelSquare') || '').trim(),
                excelRow: String(params.get('excelRow') || '').trim()
            };
        } catch (e) {
            return null;
        }
    }

    function getImportContextBlockedMessage() {
        return 'Открытие квартиры из импорта заблокировано: объект не соответствует UID/active link/regnum строки Excel. Это защита от изменения чужой квартиры.';
    }

    function logPremisesImportContextCheck(ctx, result, reason) {
        try {
            console.log('[premises][import-context-check]', {
                regnum: normStr(ctx && ctx.regnum),
                uid: normStr(ctx && ctx.uid),
                ls: normStr(ctx && ctx.ls),
                fam: normStr(ctx && ctx.fam),
                excelRow: normStr(ctx && ctx.excelRow),
                result: result,
                reason: reason || ''
            });
        } catch (e) {}
    }

    function checkImportOpenContext(ctx) {
        const c = ctx || importOpenContext;
        const db = window.AbonentsDB || {};
        const reg = normStr(c && c.regnum);
        if (!c) return { ok:true, result:'ok', reason:'NO_CONTEXT' };
        if (!reg) return { ok:false, result:'blocked', reason:'NO_REGNUM' };
        if (!normStr(c.uid)) return { ok:false, result:'blocked', reason:'NO_UID' };
        const premise = db.premises && db.premises[reg];
        if (!premise) return { ok:false, result:'blocked', reason:'PREMISE_NOT_FOUND' };
        const link = activeLinkForRegnum(db, reg);
        if (!link) return { ok:false, result:'blocked', reason:'ACTIVE_LINK_NOT_FOUND' };
        const abonentId = normStr(link.abonentId);
        const abonent = db.abonents && db.abonents[abonentId];
        if (!abonent) return { ok:false, result:'blocked', reason:'ABONENT_NOT_FOUND' };
        if (normStr(c.uid) && normStr(abonent.uid).toLowerCase() !== normStr(c.uid).toLowerCase()) return { ok:false, result:'blocked', reason:'UID_MISMATCH' };
        if (normStr(c.ls) && db.abonents && db.abonents[normStr(c.ls)] && db.abonents[normStr(c.ls)] !== abonent) {
            const otherUid = normStr(db.abonents[normStr(c.ls)] && db.abonents[normStr(c.ls)].uid);
            if (otherUid && otherUid.toLowerCase() !== normStr(c.uid).toLowerCase()) return { ok:false, result:'blocked', reason:'LS_OTHER_UID' };
        }
        const lsMatch = !normStr(c.ls) || normStr(abonent.id) === normStr(c.ls) || abonentId === normStr(c.ls);
        const fioMatch = softFioMatch({ fam:normStr(c.fam) }, abonent);
        if (!lsMatch || !fioMatch) return { ok:true, result:'warning', reason:'UID_SOFT_MISMATCH', premise:premise, link:link, abonent:abonent };
        return { ok:true, result:'ok', reason:'OK', premise:premise, link:link, abonent:abonent };
    }

    function renderImportOpenWarning(premise) {
        if (!importOpenContext) return;
        const p = premise || (importOpenContext.regnum ? window.AbonentsDB?.premises?.[importOpenContext.regnum] : null);
        const dbSquare = (p?.square ?? '') === '' ? '—' : String(p.square);
        const excelSquare = importOpenContext.excelSquare || '—';
        setWarn(
            'Открыто обновление площади из импорта Excel. Строка Excel: ' + (importOpenContext.excelRow || '—') +
            '. UID: ' + (importOpenContext.uid || '—') +
            '. ЛС: ' + (importOpenContext.ls || '—') +
            '. Площадь в Excel: ' + excelSquare +
            '. Текущая площадь в базе: ' + dbSquare +
            '. Разрешено изменить только площадь.',
            true
        );
    }


    function isPremiseIdentityFixed(p) {
        if (!p) return false;
        if (normStr(p.officialRegnum)) return true;
        return !!p.regnum && !isTempRegnum(p.regnum);
    }

    function setDisabled(id, disabled) {
        const el = q(id);
        if (el) el.disabled = !!disabled;
    }

    function applyPremiseEditLocks(p) {
        const isEdit = !!state.editingRegnum;
        const onlySquare = isEdit && (importOpenContext || isPremiseIdentityFixed(p));
        ['p_created','p_city','p_street','p_house','p_flat','p_official_regnum'].forEach(id => setDisabled(id, onlySquare));
        if (onlySquare) {
            setDisabled('p_regnum', true);
            setDisabled('p_regnum_unknown', true);
            if (normStr(p && p.officialRegnum)) setRegnumHint('Объект зафиксирован кадастровым номером. Разрешено менять только площадь.');
            else setRegnumHint(importOpenContext ? 'Открыто из импорта Excel. Разрешено менять только площадь.' : 'Объект зафиксирован. Разрешено менять только площадь.');
        } else {
            ['p_created','p_city','p_street','p_house','p_flat','p_official_regnum'].forEach(id => setDisabled(id, false));
        }
        setDisabled('p_square', false);
    }

    function sameIdentityValue(a, b) {
        return normStr(a) === normStr(b);
    }

    function changedIdentityFields(existing, f, reg) {
        const changed = [];
        if (!sameIdentityValue(existing.createdAt, f.createdAt)) changed.push('createdAt');
        if (!sameIdentityValue(existing.city, f.city)) changed.push('city');
        if (!sameIdentityValue(existing.street, f.street)) changed.push('street');
        if (!sameIdentityValue(existing.house, f.house)) changed.push('house');
        if (!sameIdentityValue(existing.flat, f.flat)) changed.push('flat');
        if (!sameIdentityValue(existing.officialRegnum, f.officialRegnum)) changed.push('officialRegnum');
        if (!sameIdentityValue(reg, f.regnum)) changed.push('regnum');
        return changed;
    }

    function logIdentityEditBlocked(tag, regnum, changedFields) {
        try { console.log(tag, { regnum: normStr(regnum), changedFields: changedFields || [] }); } catch (e) {}
    }

    function logImportSaveBlocked(ctx, reason) {
        try {
            console.log('[premises][import-save-blocked]', {
                regnum: normStr(ctx && ctx.regnum),
                uid: normStr(ctx && ctx.uid),
                ls: normStr(ctx && ctx.ls),
                fam: normStr(ctx && ctx.fam),
                excelRow: normStr(ctx && ctx.excelRow),
                reason: reason || ''
            });
        } catch (e) {}
    }

    function readForm() {
        syncHouseModelFromUi();
        const regnum = normRegnum(q('p_regnum').value);
        const regnumUnknown = !!q('p_regnum_unknown')?.checked;
        const createdAt = toISODateFromInput(q('p_created').value);
        const city = normStr(q('p_city').value);
        const street = normStr(q('p_street').value);
        const house = normStr(q('p_house').value);
        const flat = normStr(q('p_flat').value);
        const square = q('p_square').value;

        const officialRegnum = normalizeOfficialRegnum(q('p_official_regnum')?.value);
        return { regnum, regnumUnknown, createdAt, city, street, house, flat, officialRegnum, square: square === '' ? '' : numOrEmpty(square) };
    }

    function setWarn(msg, isOk) {
        const el = q('premFormWarn');
        if (!el) return;
        el.textContent = msg || '';
        el.style.display = msg ? 'block' : 'none';
        el.style.borderColor = isOk ? '#0a0' : '#b00020';
        el.style.color = isOk ? '#0b6b0b' : '#b00020';
    }

    function setFormModeAdd() {
        state.editingRegnum = null;
        q('premFormTitle').textContent = 'Добавить квартиру (объект)';
        q('btnPremSave').textContent = 'Сохранить';
        // по умолчанию regnum вводится, но можно отметить "неизвестен"
        const chk = q('p_regnum_unknown');
        if (chk) { chk.disabled = false; chk.checked = false; }
        q('p_regnum').disabled = false;
        setRegnumHint('Если regnum неизвестен — поставь галочку, создадим временный.');
        applyPremiseEditLocks(null);
        const cb = q('btnCreateAbonentFromPremise');
        if (cb) cb.style.display = 'none';
        if (importOpenContext && importOpenContextBlocked) setWarn(getImportContextBlockedMessage(), false);
        else if (importOpenContext) renderImportOpenWarning(null);
        else setWarn('', true);
        renderDupHints();
        refreshAddressDatalists(); // ✅ обновим подсказки
    }

    function fillForm(p) {
        q('p_regnum').value = p?.regnum || '';
        q('p_official_regnum').value = p?.officialRegnum || '';
        q('p_created').value = p?.createdAt || '';
        q('p_city').value = p?.city || '';
        q('p_street').value = p?.street || '';
        q('p_house').value = p?.house || '';
        q('p_flat').value = p?.flat || '';
        q('p_square').value = (p?.square ?? '') === '' ? '' : String(p.square);
        refreshStreetDatalist(); // ✅ улицы зависят от города
        refreshHouseChoices();
        applyRegnumUIState(p || null);
    }

    function setFormModeEdit(regnum) {
        const db = window.AbonentsDB;
        if (importOpenContext) {
            const ctxCheck = checkImportOpenContext(importOpenContext);
            logPremisesImportContextCheck(importOpenContext, ctxCheck.ok ? (ctxCheck.result || 'ok') : 'blocked', ctxCheck.reason);
            if (!ctxCheck.ok || String(importOpenContext.regnum || '') !== String(regnum || '')) {
                importOpenContextBlocked = true;
                setFormModeAdd();
                setWarn(getImportContextBlockedMessage(), false);
                return;
            }
        }
        const p = db?.premises?.[regnum];
        state.editingRegnum = regnum;
        q('premFormTitle').textContent = 'Редактировать квартиру (объект)';
        q('btnPremSave').textContent = 'Сохранить изменения';
        // regnum редактируем только если это TEMP-* и ещё не зафиксирован
        const allowRegEdit = isTempRegnum(p?.regnum) && !p?.regnumLocked;
        q('p_regnum').disabled = !allowRegEdit;
        const chk = q('p_regnum_unknown');
        if (chk) {
            // для TEMP даём снять галочку и ввести настоящий номер
            chk.disabled = !!p?.regnumLocked || (!isTempRegnum(p?.regnum) && !!p?.regnum);
            chk.checked = isTempRegnum(p?.regnum);
        }
        fillForm(p);
        applyPremiseEditLocks(p);
        const cb = q('btnCreateAbonentFromPremise');
        if (cb) cb.style.display = '';
        if (importOpenContext && (!importOpenContext.regnum || String(importOpenContext.regnum) === String(regnum))) renderImportOpenWarning(p);
        else if (normStr(p && p.officialRegnum)) setWarn('Объект зафиксирован кадастровым номером. Разрешено менять только площадь.', true);
        else setWarn('', true);
        renderDupHints();
        refreshAddressDatalists(); // ✅ обновим подсказки
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function clearForm() {
        fillForm({ regnum:'', officialRegnum:'', createdAt:'', city:'', street:'', house:'', flat:'', square:'' });
        setFormModeAdd();
    }

    function premiseSortWeight(p) {
        var st = String(p?.status || 'active').trim();
        var hasClosed = !!String(p?.closedAt || '').trim();
        if (!hasClosed && (!st || st === 'active')) return 0;
        if (st === 'merged') return 1;
        if (st === 'archived') return 2;
        if (st === 'split') return 3;
        return 4;
    }

    function premiseStatusBadge(p) {
        var st = String(p?.status || 'active').trim();
        var hasClosed = !!String(p?.closedAt || '').trim();
        if (st === 'merged' || hasClosed) return 'объединена / расчёт остановлен';
        return '';
    }

    function isPremiseClosed(p) {
        return premiseSortWeight(p) > 0;
    }

    async function renderTable() {
        await ensureRuntimeHydration('render');
        const tbody = q('premisesTable')?.querySelector('tbody');
        if (!tbody) return;

        const filter = normStr(q('premSearch')?.value).toLowerCase();
        tbody.innerHTML = '';

        // ============================================================
        // ALL MODE (admin): показываем ВСЕ базы, группировка по владельцу
        // ============================================================
        if (isAllMode()) {
            const owners = listAllOwnersSorted();
            let totalAll = 0;
            let totalShown = 0;

            owners.forEach((owner, gi) => {
                const db = loadDbForOwner(owner.id);
                const premises = db?.premises || {};
                const regs = Object.keys(premises).sort();

                totalAll += regs.length;

                // собираем строки по фильтру
                const list = [];
                regs.forEach(regnum => {
                    const p = premises[regnum];
                    const hay = [p?.regnum, p?.officialRegnum, p?.city, p?.street, p?.house, p?.flat].join(' ').toLowerCase();
                    if (filter && !hay.includes(filter)) return;
                    list.push(p);
                });
                list.sort(comparePremisesByFlatDesc);

                // если фильтр активен и в группе нет совпадений — не показываем группу
                if (filter && list.length === 0) return;

                const color = GROUP_COLORS[gi % GROUP_COLORS.length];

                // header group row
                const trH = document.createElement('tr');
                trH.style.background = color;
                trH.style.fontWeight = 'bold';
                trH.innerHTML = `
                    <td colspan="10">
                        База: ${esc(owner.role === 'admin' ? 'АДМИН' : 'ЮЗЕР')} — ${esc(owner.email || owner.id)}
                        <span class="small" style="margin-left:10px; font-weight:normal;">(показано: ${list.length} / ${regs.length})</span>
                    </td>
                `;
                tbody.appendChild(trH);

                // rows
                list.forEach(p => {
                    const link = activeLinkForRegnum(db, p.regnum);
                    const fio = link ? fioById(db, link.abonentId) : '';
                    const fioText = fio ? fio : '—';

                    const tr = document.createElement('tr');
                    tr.style.background = color;

                    const regLabel = isTempRegnum(p.regnum)
                        ? `${esc(p.regnum)} <span class="small" style="background:#fff3bf; padding:0 4px; border:1px solid #000; margin-left:6px;">временный</span>`
                        : esc(p.regnum);

                    tr.innerHTML = `
                        <td class="mono">${regLabel}</td>
                        <td class="mono">${p.officialRegnum ? esc(p.officialRegnum) : "—"}</td>
                        <td>${esc(p.city)}</td>
                        <td>${esc(p.street)}</td>
                        <td>${esc(p.house)}</td>
                        <td>${esc(p.flat)}</td>
                        <td>${p.square === '' || p.square === null || p.square === undefined ? '' : esc(p.square)}</td>
                        <td>${esc(p.createdAt || '')}</td>
                        <td>${esc(fioText)}</td>
                        <td class="small">—</td>
                    `;
                    tbody.appendChild(tr);
                    totalShown++;
                });
            });

            q('premCount').textContent = `Показано: ${totalShown} / ${totalAll} (все базы)`;
            console.log('[premises][render]', { premisesCount: totalAll, visibleCount: totalShown });
            return;
        }

        // ============================================================
        // NORMAL MODE: текущая выбранная база (админ или конкретный юзер)
        // ============================================================
        const db = window.AbonentsDB;
        const premises = db?.premises || {};
        const rows = Object.keys(premises).map(regnum => premises[regnum]).sort((a, b) => {
            const wa = premiseSortWeight(a);
            const wb = premiseSortWeight(b);
            if (wa !== wb) return wa - wb;
            return comparePremisesByFlatDesc(a, b);
        });

        let shown = 0;
        rows.forEach(p => {
            const hay = [p.regnum, p.officialRegnum, p.city, p.street, p.house, p.flat].join(' ').toLowerCase();
            if (filter && !hay.includes(filter)) return;

            const link = activeLinkForRegnum(db, p.regnum);
            const fio = link ? fioById(db, link.abonentId) : '';
            const fioText = fio ? fio : '—';

            const tr = document.createElement('tr');
            const statusBadge = premiseStatusBadge(p);
            const regLabel = isTempRegnum(p.regnum) ? `${esc(p.regnum)} <span class="small" style="background:#fff3bf; padding:0 4px; border:1px solid #000; margin-left:6px;">временный</span>` : esc(p.regnum);
            const regCell = statusBadge ? `${regLabel} <span class="small" style="background:#f0f0f0; color:#555; padding:0 4px; border:1px solid #bbb; margin-left:6px;">${esc(statusBadge)}</span>` : regLabel;
            const closed = isPremiseClosed(p);
            if (closed) tr.style.opacity = '0.6';
            tr.innerHTML = `
                <td class="mono">${regCell}</td>
                <td class="mono">${p.officialRegnum ? esc(p.officialRegnum) : "—"}</td>
                <td>${esc(p.city)}</td>
                <td>${esc(p.street)}</td>
                <td>${esc(p.house)}</td>
                <td>${esc(p.flat)}</td>
                <td>${p.square === '' || p.square === null || p.square === undefined ? '' : esc(p.square)}</td>
                <td>${esc(p.createdAt || '')}</td>
                <td>${esc(fioText)}</td>
                <td>
                    <div class="row-actions">
                        <button type="button" data-act="edit" data-regnum="${esc(p.regnum)}">ред.</button>
                        <button type="button" data-act="create" data-regnum="${esc(p.regnum)}" ${closed ? 'disabled title="Квартира закрыта/объединена. Создание нового активного абонента запрещено."' : ''}>абонент+</button>
                        <button type="button" data-act="del" data-regnum="${esc(p.regnum)}">удал.</button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
            shown++;
        });

        q('premCount').textContent = `Показано: ${shown} / ${Object.keys(premises).length}`;
        console.log('[premises][render]', { premisesCount: Object.keys(premises).length, visibleCount: shown });

        tbody.querySelectorAll('button[data-act]')?.forEach(btn => {
            btn.addEventListener('click', () => {
                const act = btn.getAttribute('data-act');
                const regnum = btn.getAttribute('data-regnum');
                if (act === 'edit') setFormModeEdit(regnum);
                else if (act === 'create') goCreateAbonentForRegnum(regnum);
                else if (act === 'del') onDelete(regnum);
            });
        });

        refreshAddressDatalists(); // ✅ после перерендера тоже обновим
    }

function onSave() {
        // 🔒 запрет записи для гостя и для режима "ВСЕ БАЗЫ"
        if (!canWriteOrExplainLocal()) return;
        if (state.busy) return;

        const db = window.AbonentsDB;
        const f = readForm();

        if (importOpenContext) {
            const ctxCheck = checkImportOpenContext(importOpenContext);
            const editMatches = state.editingRegnum && String(state.editingRegnum) === String(importOpenContext.regnum || '');
            logPremisesImportContextCheck(importOpenContext, (ctxCheck.ok && editMatches) ? (ctxCheck.result || 'ok') : 'blocked', ctxCheck.ok ? (editMatches ? ctxCheck.reason : 'EDIT_REGNUM_MISMATCH') : ctxCheck.reason);
            if (!ctxCheck.ok || !editMatches) {
                importOpenContextBlocked = true;
                logImportSaveBlocked(importOpenContext, ctxCheck.ok ? 'EDIT_REGNUM_MISMATCH' : ctxCheck.reason);
                setWarn('Сохранение заблокировано: квартира больше не соответствует строке импорта. Площадь не изменена.', false);
                return;
            }
        }

        // regnum может быть неизвестен только на этапе создания (ставим галочку)
        const isUnknown = !!f.regnumUnknown;
        if (!state.editingRegnum) {
            if (!isUnknown && !f.regnum) { setWarn('Укажите regnum (регистрационный номер квартиры) или отметьте "regnum неизвестен".', false); return; }
        }
        if (!f.city || !f.street || !f.house || !f.flat) { setWarn('Заполните адрес: город, улица, дом, квартира.', false); return; }

        if (state.editingRegnum) {
            const existingForIdentityCheck = db.premises?.[state.editingRegnum];
            if (!existingForIdentityCheck) { setWarn('Ошибка: объект не найден в базе.', false); return; }
            const identityChanged = changedIdentityFields(existingForIdentityCheck, f, state.editingRegnum);
            if (identityChanged.length && (importOpenContext || isPremiseIdentityFixed(existingForIdentityCheck))) {
                if (normStr(existingForIdentityCheck.officialRegnum)) {
                    logIdentityEditBlocked('[premises][fixed-object-edit-blocked]', state.editingRegnum, identityChanged);
                    setWarn('Объект с кадастровым номером зафиксирован. Для изменения создайте новый объект.', false);
                } else {
                    logIdentityEditBlocked('[premises][identity-edit-blocked]', state.editingRegnum, identityChanged);
                    setWarn('Изменение идентификационных данных квартиры запрещено. Для нового адреса или новой записи нужно закрыть старый объект и создать новый.', false);
                }
                return;
            }
        }

        // 🔒 CRITICAL: запрет одинаковых адресов при пересечении по времени ответственности.
        // Разрешено только если периоды стыкуются без пересечения.
        const __addrKey = addrKeyNormalized(f);
        const __candIntervals = state.editingRegnum ? getIntervalsForRegnum(db, state.editingRegnum) : getIntervalsForNewPremise(f);
        const __conf = checkAddressTimeConflict(db, __addrKey, __candIntervals, state.editingRegnum || '');
        if (__conf) {
            const msg =
                'ОШИБКА: этот адрес уже существует и пересекается по времени ответственности.\n' +
                'Адрес: ' + (f.city + ', ' + f.street + ', ' + f.house + ', ' + f.flat) + '\n' +
                'Конфликтующая квартира (regnum): ' + __conf.regnum + '\n' +
                'Пересечение: [' + __conf.a.from + ' — ' + (__conf.a.to || 'по настоящее время') + '] и ' +
                '[' + __conf.b.from + ' — ' + (__conf.b.to || 'по настоящее время') + ']\n\n' +
                'Допустимо только если периоды стыкуются без пересечения.';
            setWarn(msg, false);
            return;
        }

        const duplicateOfficialReg = findOfficialRegnumDuplicate(db, f.officialRegnum, state.editingRegnum || '');
        if (duplicateOfficialReg) {
            console.log('[premises][official-regnum] duplicate', f.officialRegnum, duplicateOfficialReg);
            setWarn('Такой официальный номер уже указан у другой квартиры: ' + duplicateOfficialReg, false);
            return;
        }

        const isEdit = !!state.editingRegnum;
        if (isEdit) {
            const reg = state.editingRegnum;
            console.log('[premises][save] owner=' + getActiveOwnerId() + ' regnum=' + reg + ' action=update');
            console.log('[premises][official-regnum] save', f.officialRegnum || '');
            const existing = db.premises?.[reg];
            if (!existing) { setWarn('Ошибка: объект не найден в базе.', false); return; }

            const allowRegEdit = isTempRegnum(existing?.regnum) && !existing?.regnumLocked && !importOpenContext && !normStr(existing?.officialRegnum);
            const saveOnlySquare = !!importOpenContext || isPremiseIdentityFixed(existing);

            // 🔒 TEMP-* -> настоящий regnum (одноразовая фиксация)
            if (allowRegEdit && !isUnknown && f.regnum && String(f.regnum) !== String(reg)) {
                const affectedBefore = collectAffectedAbonentIdsByRegnums(db, [reg]);
                persistPremiseTransaction({
                    successMessage: 'regnum зафиксирован и сохранён.',
                    affectedAbonentIds: affectedBefore,
                    mutate: function () {
                        const res = renamePremiseRegnumOnce(db, reg, f.regnum);
                        if (!res.ok) return { ok: false, message: res.message || 'Ошибка фиксации regnum.' };

                        const newKey = res.newRegnum;
                        const p2 = db.premises?.[newKey];
                        if (p2) {
                            db.premises[newKey] = {
                                ...p2,
                                city: f.city, street: f.street, house: f.house, flat: f.flat,
                                square: f.square, createdAt: f.createdAt,
                                officialRegnum: f.officialRegnum,
                                regnumType: f.officialRegnum ? 'official' : 'temp'
                            };
                        }
                        syncLegacyFieldsForRegnum(db, newKey);

                        return {
                            ok: true,
                            newRegnum: newKey,
                            affectedAbonentIds: collectAffectedAbonentIdsByRegnums(db, [newKey])
                        };
                    },
                    onSuccess: function (tx) {
                        const newKey = tx?.newRegnum || f.regnum;
                        setFormModeEdit(newKey);
                    }
                });
                return;
            }

            persistPremiseTransaction({
                successMessage: 'Сохранено.',
                affectedAbonentIds: collectAffectedAbonentIdsByRegnums(db, [reg]),
                mutate: function () {
                    if (saveOnlySquare) {
                        db.premises[reg] = {
                            ...existing,
                            square: f.square
                        };
                    } else {
                        db.premises[reg] = {
                            ...existing,
                            city: f.city, street: f.street, house: f.house, flat: f.flat,
                            square: f.square, createdAt: f.createdAt,
                            officialRegnum: f.officialRegnum,
                            regnumType: f.officialRegnum ? 'official' : 'temp'
                        };
                    }
                    syncLegacyFieldsForRegnum(db, reg);
                    return { ok: true, affectedAbonentIds: collectAffectedAbonentIdsByRegnums(db, [reg]) };
                },
                onSuccess: function () {
                    setFormModeAdd();
                }
            });
            return;
        }

        // добавление нового объекта
        const regKey = isUnknown ? genTempRegnum(db) : f.regnum;
        console.log('[premises][save] owner=' + getActiveOwnerId() + ' regnum=' + regKey + ' action=create');
        console.log('[premises][official-regnum] save', f.officialRegnum || '');

        if (db.premises?.[regKey]) {
            const p = db.premises[regKey];
            if (!sameAddress(p, f.city, f.street, f.house, f.flat)) {
                setWarn('regnum уже существует и привязан к другому адресу. Нельзя создать дубликат.', false);
                return;
            }
            setWarn('regnum уже существует. Откройте его на редактирование через кнопку "ред." в списке.', false);
            return;
        }

        persistPremiseTransaction({
            successMessage: 'Объект добавлен.',
            mutate: function () {
                db.premises[regKey] = {
                    regnum: regKey,
                    city: f.city,
                    street: f.street,
                    house: f.house,
                    flat: f.flat,
                    square: f.square,
                    createdAt: f.createdAt,
                    regnumTemp: isUnknown ? true : false,
                    regnumLocked: isUnknown ? false : true,
                    officialRegnum: f.officialRegnum,
                    regnumType: f.officialRegnum ? 'official' : 'temp'
                };
                syncLegacyFieldsForRegnum(db, regKey);
                return { ok: true, affectedAbonentIds: collectAffectedAbonentIdsByRegnums(db, [regKey]) };
            },
            onSuccess: function () {
                clearForm();
            }
        });
    }

    function onDelete(regnum) {
        if (!canWriteOrExplainLocal()) return;
        if (state.busy) return;

        const db = window.AbonentsDB;
        const reg = String(regnum);
        if (!db?.premises?.[reg]) return;

        if (hasAnyLinks(db, reg)) {
            alert('Нельзя удалить объект: по нему есть связи с абонентами (история собственников/проживающих).\n\nСначала удалите/закройте связи, либо оставьте объект в базе.');
            return;
        }

        const ok = confirm('Удалить объект (квартиру)\nregnum: ' + reg + '\n\nДействие необратимо.');
        if (!ok) return;

        persistPremiseTransaction({
            successMessage: 'Объект удалён.',
            mutate: function () {
                delete db.premises[reg];
                return { ok: true };
            },
            onSuccess: function () {
                if (state.editingRegnum === reg) clearForm();
            }
        });
    }

    function syncLegacyFieldsForRegnum(db, regnum) {
        const p = db.premises?.[regnum];
        if (!p) return;
        (db.links || []).forEach(l => {
            if (String(l?.regnum) !== String(regnum)) return;
            const a = db.abonents?.[String(l.abonentId)];
            if (!a) return;
            a.regnum = regnum;
            a.city = p.city;
            a.street = p.street;
            a.house = p.house;
            a.flat = p.flat;
            a.square = p.square;
            a.premiseCreatedAt = p.createdAt;
        });
    }

    function bind() {
        bindNavigationGuards();
        ensureHouseSelectorUI();
        refreshHouseChoices();
        q('btnPremSave')?.addEventListener('click', (e) => { e.preventDefault(); onSave(); });
        q('btnPremReset')?.addEventListener('click', (e) => { e.preventDefault(); clearForm(); });
        q('premSearch')?.addEventListener('input', () => renderTable());

        // контроль дублей в форме
        ['p_city','p_street','p_house','p_flat'].forEach(id => {
            q(id)?.addEventListener('input', () => renderDupHints());
        });
        q('p_house_new')?.addEventListener('input', () => {
            syncHouseModelFromUi();
            renderDupHints();
        });
        q('p_house_select')?.addEventListener('change', () => {
            syncHouseModelFromUi();
            renderDupHints();
        });

        // ✅ при изменении города — обновляем улицы (чтобы улицы были по этому городу)
        q('p_city')?.addEventListener('input', () => {
            refreshStreetDatalist();
            refreshHouseChoices();
        });
        q('p_street')?.addEventListener('input', () => refreshHouseChoices());

        // regnum неизвестен / временный
        q('p_regnum_unknown')?.addEventListener('change', () => {
            // в режиме добавления/временного объекта разрешаем переключать
            // для обычных зафиксированных — checkbox будет disabled
            applyRegnumUIState({ regnum: q('p_regnum')?.value, regnumLocked: false });
            renderDupHints();
        });

        // кнопка создания абонента из формы
        q('btnCreateAbonentFromPremise')?.addEventListener('click', (e) => {
            e.preventDefault();
            const reg = state.editingRegnum ? state.editingRegnum : normRegnum(q('p_regnum')?.value);
            if (!reg) { alert('Сначала укажите regnum квартиры.'); return; }
            goCreateAbonentForRegnum(reg);
        });
    }

    async function init() {
        try {
            await hydrateRuntimeDbFromStore('init');
            console.log('[premises][init-enter]');
            if (!hasDbContent(window.AbonentsDB)) {
                window.AbonentsDB = { abonents: {}, premises: {}, links: [] };
            } else {
                window.AbonentsDB.abonents = window.AbonentsDB.abonents || {};
                window.AbonentsDB.premises = window.AbonentsDB.premises || {};
                window.AbonentsDB.links = window.AbonentsDB.links || [];
            }
            console.log("[runtime-db-keys]", Object.keys(window.AbonentsDB || {}));
            console.log(
                "[runtime-abonents-count]",
                window.AbonentsDB && window.AbonentsDB.abonents
                    ? Object.keys(window.AbonentsDB.abonents).length
                    : "missing"
            );

            // ALL-mode: только просмотр — блокируем форму добавления/редактирования
            if (isAllMode()) {
                try {
                    const saveBtn = q('btnPremSave');
                    if (saveBtn) { saveBtn.disabled = true; saveBtn.style.opacity = '0.6'; saveBtn.title = 'Режим "все базы" — только просмотр'; }
                    const resetBtn = q('btnPremReset');
                    if (resetBtn) { resetBtn.disabled = true; resetBtn.style.opacity = '0.6'; }
                    const formTitle = q('premFormTitle');
                    if (formTitle) formTitle.textContent = 'Добавить квартиру (объект) — недоступно в режиме "все базы"';
                    const warn = q('premFormWarn');
                    if (warn) { warn.textContent = 'Режим "все базы" — только просмотр. Выберите конкретную базу (админ/юзер), чтобы добавлять/редактировать.'; warn.style.display = 'block'; }
                    // поля формы
                    ['p_regnum','p_official_regnum','p_created','p_city','p_street','p_house','p_flat','p_square','p_regnum_unknown'].forEach(id=>{
                        const el = q(id);
                        if (el) { el.disabled = true; el.style.opacity = '0.7'; }
                    });
                } catch (e) {}
            }

            bind();
            importOpenContext = readImportOpenContext();
            setFormModeAdd();
            await renderTable();
            if (importOpenContext && importOpenContext.regnum) {
                const ctxCheck = checkImportOpenContext(importOpenContext);
                logPremisesImportContextCheck(importOpenContext, ctxCheck.ok ? (ctxCheck.result || 'ok') : 'blocked', ctxCheck.reason);
                if (ctxCheck.ok) {
                    setFormModeEdit(importOpenContext.regnum);
                } else {
                    importOpenContextBlocked = true;
                    setWarn(getImportContextBlockedMessage(), false);
                }
            }

            // ✅ первичная загрузка подсказок
            refreshAddressDatalists();
            refreshHouseChoices();
        } catch (e) {
            console.warn('[premises][init-error]', e);
            throw e;
        }
    }

    const api = { init };
    api.__version = PREMISES_ADMIN_VERSION;
    return api;
})();
