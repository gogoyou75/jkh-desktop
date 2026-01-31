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

// ------------------------
//     STORAGE MODULE
//     Classic script + защита от двойной загрузки
//     + совместимость: getNotes() и StorageAPI.getNotes()
// ------------------------

(function () {
    // ✅ если уже загружен — выходим (чтобы не было "already declared")
    if (window.StorageAPI && window.StorageAPI.__loaded_v2) return;

    const NOTES_KEY = 'abonent_notes_v1';
    const PERIODS_KEY = 'exclude_periods_v1';

    function getNotes() {
        try {
            let obj = JSON.parse(localStorage.getItem(NOTES_KEY) || '{}');
            return Object.assign({ general: "", exclude_period: "", payments: "" }, obj);
        } catch (e) {
            console.error("Ошибка чтения заметок:", e);
            return { general: "", exclude_period: "", payments: "" };
        }
    }

    function saveNotes(notesObj) {
        localStorage.setItem(NOTES_KEY, JSON.stringify(notesObj));
        try {
            fetch('/api/abonent-notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(notesObj)
            }).catch(() => {});
        } catch (e) {}
    }

    function getPeriods() {
        try {
            const raw = JSON.parse(localStorage.getItem(PERIODS_KEY) || "[]");
            return raw.filter(p =>
                (p.from && p.from.trim() !== "") ||
                (p.to && p.to.trim() !== "") ||
                (p.reason && p.reason.trim() !== "")
            );
        } catch {
            return [];
        }
    }

    function savePeriods(periodsArray) {
        const cleaned = (Array.isArray(periodsArray) ? periodsArray : []).filter(p =>
            (p?.from && String(p.from).trim() !== "") ||
            (p?.to && String(p.to).trim() !== "") ||
            (p?.reason && String(p.reason).trim() !== "")
        );
        localStorage.setItem(PERIODS_KEY, JSON.stringify(cleaned));
    }

    function excludesKey(abonentId) {
        return "exclude_periods_" + String(abonentId || "").trim();
    }

    function normalizeExcludes(excludes) {
        return (Array.isArray(excludes) ? excludes : [])
            .map(p => ({
                from: String(p?.from || "").trim(),
                to: String(p?.to || "").trim(),
                reason: String(p?.reason || "").trim()
            }));
    }

    function cleanExcludes(excludes) {
        return normalizeExcludes(excludes).filter(p => p.from || p.to || p.reason);
    }

    function getAbonentById(abonentId) {
        try {
            return window.AbonentsDB?.abonents?.[String(abonentId)] || null;
        } catch {
            return null;
        }
    }

    function loadExcludes(abonentId) {
        const abonent = getAbonentById(abonentId);
        if (!abonent) return [];

        try {
            const raw = localStorage.getItem(excludesKey(abonentId));
            if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) {
                    const cleaned = cleanExcludes(arr);
                    abonent.defaultExcludes = cleaned;
                    return cleaned;
                }
            }
        } catch (e) {}

        if (Array.isArray(abonent.defaultExcludes)) {
            const cleaned = cleanExcludes(abonent.defaultExcludes);
            abonent.defaultExcludes = cleaned;
            return cleaned;
        }

        abonent.defaultExcludes = [];
        return [];
    }

    function saveExcludes(abonentId, excludes) {
        const abonent = getAbonentById(abonentId);
        if (!abonent) return;

        const cleaned = cleanExcludes(excludes);
        abonent.defaultExcludes = cleaned;

        try {
            localStorage.setItem(excludesKey(abonentId), JSON.stringify(cleaned));
        } catch (e) {}
    }

    // ✅ Новый API
    window.StorageAPI = {
        __loaded_v2: true,
        getNotes,
        saveNotes,
        getPeriods,
        savePeriods,
        loadExcludes,
        saveExcludes
    };

    // ✅ Обратная совместимость (старый код мог вызывать так)
    window.getNotes = getNotes;
    window.saveNotes = saveNotes;
    window.getPeriods = getPeriods;
    window.savePeriods = savePeriods;
    window.loadExcludes = loadExcludes;
    window.saveExcludes = saveExcludes;
})();
