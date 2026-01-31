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

    let state = { editingRegnum: null };

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
        const db = window.AbonentsDB;
        const tbody = q('premisesTable')?.querySelector('tbody');
        if (!tbody) return;

        const filter = normStr(q('premSearch')?.value).toLowerCase();
        const premises = db?.premises || {};
        const rows = Object.keys(premises).sort().map(regnum => premises[regnum]);

        let shown = 0;
        tbody.innerHTML = '';

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
        const db = window.AbonentsDB;
        const f = readForm();

        // regnum может быть неизвестен только на этапе создания (ставим галочку)
        const isUnknown = !!f.regnumUnknown;
        if (!state.editingRegnum) {
            if (!isUnknown && !f.regnum) { setWarn('Укажите regnum (регистрационный номер квартиры) или отметьте "regnum неизвестен".', false); return; }
        }
        if (!f.city || !f.street || !f.house || !f.flat) { setWarn('Заполните адрес: город, улица, дом, квартира.', false); return; }

        const isEdit = !!state.editingRegnum;
        if (isEdit) {
            const reg = state.editingRegnum;
            const existing = db.premises?.[reg];
            if (!existing) { setWarn('Ошибка: объект не найден в базе.', false); return; }

            const allowRegEdit = isTempRegnum(existing?.regnum) && !existing?.regnumLocked;

            // 🔒 Шаг 1: если это TEMP-* и пользователь ввёл настоящий regnum -> ПЕРЕИМЕНОВЫВАЕМ ключ один раз
            if (allowRegEdit && !isUnknown && f.regnum && String(f.regnum) !== String(reg)) {
                const res = renamePremiseRegnumOnce(db, reg, f.regnum);
                if (!res.ok) { setWarn(res.message || 'Ошибка фиксации regnum.', false); return; }
                // после переименования продолжаем сохранять адрес в новом ключе
                const newKey = res.newRegnum;
                const p2 = db.premises?.[newKey];
                if (p2) {
                    db.premises[newKey] = {
                        ...p2,
                        city: f.city, street: f.street, house: f.house, flat: f.flat,
                        square: f.square, createdAt: f.createdAt
                    };
                }

                window.saveAbonentsDB();
                setWarn('regnum зафиксирован и сохранён.', true);
                renderTable();
                refreshAddressDatalists();
                // перерисуем форму в режиме edit уже по новому regnum
                setFormModeEdit(newKey);
                return;
            }

            // обычное сохранение адреса (regnum не меняется)
            db.premises[reg] = {
                ...existing,
                city: f.city, street: f.street, house: f.house, flat: f.flat,
                square: f.square, createdAt: f.createdAt
            };

            syncLegacyFieldsForRegnum(db, reg);

            window.saveAbonentsDB();
            setWarn('Сохранено.', true);
            renderTable();
            refreshAddressDatalists(); // ✅
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

        window.saveAbonentsDB();
        setWarn('Объект добавлен.', true);
        clearForm();
        renderTable();
        refreshAddressDatalists(); // ✅
    }

    function onDelete(regnum) {
        const db = window.AbonentsDB;
        const reg = String(regnum);
        if (!db?.premises?.[reg]) return;

        if (hasAnyLinks(db, reg)) {
            alert('Нельзя удалить объект: по нему есть связи с абонентами (история собственников/проживающих).\n\nСначала удалите/закройте связи, либо оставьте объект в базе.');
            return;
        }

        const ok = confirm('Удалить объект (квартиру)\nregnum: ' + reg + '\n\nДействие необратимо.');
        if (!ok) return;

        delete db.premises[reg];
        window.saveAbonentsDB();

        if (state.editingRegnum === reg) clearForm();

        renderTable();
        refreshAddressDatalists(); // ✅
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

        bind();
        setFormModeAdd();
        renderTable();

        // ✅ первичная загрузка подсказок
        refreshAddressDatalists();
    }

    return { init };
})();
