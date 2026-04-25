/* premises_admin.js
   Страница управления квартирами/адресами (premises)
   Не ломает существующий проект: работает поверх window.AbonentsDB
*/

window.PremisesAdmin = (function () {
    function q(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#039;'}[m]));
    }

    function normStr(s) { return String(s ?? '').trim(); }
    function normRegnum(s) { return normStr(s).replace(/\s+/g, ''); }

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
        return "jkhdb::" + String(ownerId || getActiveOwnerId()) + "::" + key;
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

    const BUSY_NAVIGATION_MESSAGE = 'Сохранение на сервер… не переходите на другую страницу.';
    let state = { editingRegnum: null, busy: false };
    let navigationGuardsBound = false;

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
        if (!(window.JKHAutoAccrual && typeof window.JKHAutoAccrual.recalcForMany === 'function')) {
            return { ok: false, reason: 'NO_RECALC_ENGINE', message: 'Не загружен движок автопересчёта autoaccrual_engine.js' };
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

    async function flushDbToServerStrict() {
        if (window.JKHStore && window.AbonentsDB) {
            try {
                window.JKHStore.setJSON('abonents_db_v1', window.AbonentsDB);
            } catch (e) {
                throw new Error('Не удалось записать DB в storage: ' + (e?.message || e));
            }
        }

        if (window.Data && typeof window.Data.flushDbToServer === 'function') {
            const ok = await window.Data.flushDbToServer();
            if (!ok) throw new Error('Не удалось сохранить базу перед upload.');
            return true;
        }

        const saved = !!(window.saveAbonentsDB && window.saveAbonentsDB());
        if (!saved) throw new Error('Не удалось сохранить базу.');

        if (window.JKHRemoteSync && typeof window.JKHRemoteSync.uploadNow === 'function') {
            await window.JKHRemoteSync.uploadNow();
            return true;
        }

        throw new Error('JKHRemoteSync.uploadNow недоступен.');
    }

    async function persistPremiseTransaction(opts) {
        if (state.busy) return;
        setBusyUI(true);
        const snapshot = makeTxSnapshot();
        try {
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

            await flushDbToServerStrict();

            setWarn((opts && opts.successMessage) || 'Сохранено.', true);
            renderTable();
            refreshAddressDatalists();
            if (opts && typeof opts.onSuccess === 'function') opts.onSuccess(tx);
        } catch (e) {
            console.warn('[premises] transaction failed', e);
            restoreFromTxSnapshot(snapshot);
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

    function readForm() {
        const regnum = normRegnum(q('p_regnum').value);
        const regnumUnknown = !!q('p_regnum_unknown')?.checked;
        const createdAt = toISODateFromInput(q('p_created').value);
        const city = normStr(q('p_city').value);
        const street = normStr(q('p_street').value);
        const house = normStr(q('p_house').value);
        const flat = normStr(q('p_flat').value);
        const square = q('p_square').value;

        return { regnum, regnumUnknown, createdAt, city, street, house, flat, square: square === '' ? '' : numOrEmpty(square) };
    }

    function setWarn(msg, isOk) {
        const el = q('premFormWarn');
        if (!el) return;
        el.textContent = msg || '';
        el.style.display = msg ? 'block' : 'none';
        el.style.borderColor = isOk ? '#0a0' : '#000';
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
        const cb = q('btnCreateAbonentFromPremise');
        if (cb) cb.style.display = 'none';
        setWarn('', true);
        renderDupHints();
        refreshAddressDatalists(); // ✅ обновим подсказки
    }

    function fillForm(p) {
        q('p_regnum').value = p?.regnum || '';
        q('p_created').value = p?.createdAt || '';
        q('p_city').value = p?.city || '';
        q('p_street').value = p?.street || '';
        q('p_house').value = p?.house || '';
        q('p_flat').value = p?.flat || '';
        q('p_square').value = (p?.square ?? '') === '' ? '' : String(p.square);
        refreshStreetDatalist(); // ✅ улицы зависят от города
        applyRegnumUIState(p || null);
    }

    function setFormModeEdit(regnum) {
        const db = window.AbonentsDB;
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
        const cb = q('btnCreateAbonentFromPremise');
        if (cb) cb.style.display = '';
        setWarn('', true);
        renderDupHints();
        refreshAddressDatalists(); // ✅ обновим подсказки
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function clearForm() {
        fillForm({ regnum:'', createdAt:'', city:'', street:'', house:'', flat:'', square:'' });
        setFormModeAdd();
    }

    function renderTable() {
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
                    const hay = [p?.regnum, p?.city, p?.street, p?.house, p?.flat].join(' ').toLowerCase();
                    if (filter && !hay.includes(filter)) return;
                    list.push(p);
                });

                // если фильтр активен и в группе нет совпадений — не показываем группу
                if (filter && list.length === 0) return;

                const color = GROUP_COLORS[gi % GROUP_COLORS.length];

                // header group row
                const trH = document.createElement('tr');
                trH.style.background = color;
                trH.style.fontWeight = 'bold';
                trH.innerHTML = `
                    <td colspan="9">
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
            return;
        }

        // ============================================================
        // NORMAL MODE: текущая выбранная база (админ или конкретный юзер)
        // ============================================================
        const db = window.AbonentsDB;
        const premises = db?.premises || {};
        const rows = Object.keys(premises).sort().map(regnum => premises[regnum]);

        let shown = 0;
        rows.forEach(p => {
            const hay = [p.regnum, p.city, p.street, p.house, p.flat].join(' ').toLowerCase();
            if (filter && !hay.includes(filter)) return;

            const link = activeLinkForRegnum(db, p.regnum);
            const fio = link ? fioById(db, link.abonentId) : '';
            const fioText = fio ? fio : '—';

            const tr = document.createElement('tr');
            const regLabel = isTempRegnum(p.regnum) ? `${esc(p.regnum)} <span class="small" style="background:#fff3bf; padding:0 4px; border:1px solid #000; margin-left:6px;">временный</span>` : esc(p.regnum);
            tr.innerHTML = `
                <td class="mono">${regLabel}</td>
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
                        <button type="button" data-act="create" data-regnum="${esc(p.regnum)}">абонент+</button>
                        <button type="button" data-act="del" data-regnum="${esc(p.regnum)}">удал.</button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
            shown++;
        });

        q('premCount').textContent = `Показано: ${shown} / ${Object.keys(premises).length}`;

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

        // regnum может быть неизвестен только на этапе создания (ставим галочку)
        const isUnknown = !!f.regnumUnknown;
        if (!state.editingRegnum) {
            if (!isUnknown && !f.regnum) { setWarn('Укажите regnum (регистрационный номер квартиры) или отметьте "regnum неизвестен".', false); return; }
        }
        if (!f.city || !f.street || !f.house || !f.flat) { setWarn('Заполните адрес: город, улица, дом, квартира.', false); return; }

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

        const isEdit = !!state.editingRegnum;
        if (isEdit) {
            const reg = state.editingRegnum;
            const existing = db.premises?.[reg];
            if (!existing) { setWarn('Ошибка: объект не найден в базе.', false); return; }

            const allowRegEdit = isTempRegnum(existing?.regnum) && !existing?.regnumLocked;

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
                                square: f.square, createdAt: f.createdAt
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
                    db.premises[reg] = {
                        ...existing,
                        city: f.city, street: f.street, house: f.house, flat: f.flat,
                        square: f.square, createdAt: f.createdAt
                    };
                    syncLegacyFieldsForRegnum(db, reg);
                    return { ok: true, affectedAbonentIds: collectAffectedAbonentIdsByRegnums(db, [reg]) };
                }
            });
            return;
        }

        // добавление нового объекта
        const regKey = isUnknown ? genTempRegnum(db) : f.regnum;

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
                    regnumLocked: isUnknown ? false : true
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
        q('btnPremSave')?.addEventListener('click', (e) => { e.preventDefault(); onSave(); });
        q('btnPremReset')?.addEventListener('click', (e) => { e.preventDefault(); clearForm(); });
        q('premSearch')?.addEventListener('input', () => renderTable());

        // контроль дублей в форме
        ['p_city','p_street','p_house','p_flat'].forEach(id => {
            q(id)?.addEventListener('input', () => renderDupHints());
        });

        // ✅ при изменении города — обновляем улицы (чтобы улицы были по этому городу)
        q('p_city')?.addEventListener('input', () => refreshStreetDatalist());

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

    function init() {
        window.AbonentsDB = window.AbonentsDB || { abonents: {}, premises: {}, links: [] };
        window.AbonentsDB.premises = window.AbonentsDB.premises || {};
        window.AbonentsDB.links = window.AbonentsDB.links || [];

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
                ['p_regnum','p_created','p_city','p_street','p_house','p_flat','p_square','p_regnum_unknown'].forEach(id=>{
                    const el = q(id);
                    if (el) { el.disabled = true; el.style.opacity = '0.7'; }
                });
            } catch (e) {}
        }

        bind();
        setFormModeAdd();
        renderTable();

        // ✅ первичная загрузка подсказок
        refreshAddressDatalists();
    }

    return { init };
})();
