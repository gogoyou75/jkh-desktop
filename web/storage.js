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

  // ============================================================
  // 🔑 Scoped localStorage keys (per-user базы)
  // ============================================================
  function _getSessionUser() {
    try { return (window.Auth && typeof Auth.getCurrentUser === "function") ? Auth.getCurrentUser() : null; } catch (e) { return null; }
  }

  function _getAdminViewScope() {
    // keep same key as auth.js
    var k = "jkh_admin_view_scope_v1";
    try {
      var u = _getSessionUser();
      if (!u || u.role !== "admin") return null;
      var v = localStorage.getItem(k);
      return v || u.id;
    } catch (e) { return null; }
  }

  function getActiveOwnerId() {
    var u = _getSessionUser();
    if (!u) return "guest";
    if (u.role === "admin") return _getAdminViewScope() || u.id;
    return u.id;
  }

  function isAllMode() {
    return getActiveOwnerId() === "ALL";
  }

  function isGuestMode() {
    return getActiveOwnerId() === "guest";
  }

  function scopePrefixFor(ownerId) {
    return "jkhdb::" + String(ownerId || "guest") + "::";
  }

  function k(key, ownerId) {
    return scopePrefixFor(ownerId || getActiveOwnerId()) + key;
  }

  function getItem(key, ownerId) {
    return localStorage.getItem(k(key, ownerId));
  }

  function setItem(key, value, ownerId) {
    // гость не пишет данные базы (только просмотр)
    if (isGuestMode()) {
      throw new Error("GUEST_READONLY");
    }
    if (isAllMode()) {
      throw new Error("ALLMODE_READONLY");
    }
    localStorage.setItem(k(key, ownerId), value);
  }

  function removeItem(key, ownerId) {
    if (isGuestMode()) throw new Error("GUEST_READONLY");
    if (isAllMode()) throw new Error("ALLMODE_READONLY");
    localStorage.removeItem(k(key, ownerId));
  }

  function keysForOwner(ownerId) {
    var pref = scopePrefixFor(ownerId);
    var out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var kk = localStorage.key(i);
      if (kk && kk.indexOf(pref) === 0) out.push(kk);
    }
    return out;
  }

  // global helper (used by data.js / pages)
  window.JKHStorage = {
    getActiveOwnerId: getActiveOwnerId,
    isAllMode: isAllMode,
    isGuestMode: isGuestMode,
    k: k,
    getItem: getItem,
    setItem: setItem,
    removeItem: removeItem,
    keysForOwner: keysForOwner,
    scopePrefixFor: scopePrefixFor
  };

  // ============================================================
  // Legacy StorageAPI below used unscoped keys ранее.
  // Теперь делаем их scoped через JKHStorage.k(...)
  // ============================================================
  function _sk(key) {
    try { return (window.JKHStorage && typeof JKHStorage.k === 'function') ? JKHStorage.k(key) : key; } catch (e) { return key; }
  }


    // ✅ если уже загружен — выходим (чтобы не было "already declared")
    if (window.StorageAPI && window.StorageAPI.__loaded_v2) return;

    const NOTES_KEY = 'abonent_notes_v1';
    const PERIODS_KEY = 'exclude_periods_v1';

    // ✅ scoped keys (per-user базы)
    function SKEY(baseKey) {
        try {
            if (window.JKHStorage && typeof JKHStorage.k === 'function') return JKHStorage.k(baseKey);
        } catch (e) {}
        return baseKey;
    }


    function getNotes() {
        try {
            let obj = JSON.parse(localStorage.getItem(_sk(NOTES_KEY)) || '{}');
            return Object.assign({ general: "", exclude_period: "", payments: "" }, obj);
        } catch (e) {
            console.error("Ошибка чтения заметок:", e);
            return { general: "", exclude_period: "", payments: "" };
        }
    }

    function saveNotes(notesObj) {
        localStorage.setItem(_sk(NOTES_KEY), JSON.stringify(notesObj));
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
            const raw = JSON.parse(localStorage.getItem(_sk(PERIODS_KEY)) || "[]");
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
        localStorage.setItem(_sk(PERIODS_KEY), JSON.stringify(cleaned));
    }

    function excludesKey(abonentId) {
        return _sk("exclude_periods_" + String(abonentId || "").trim());
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
