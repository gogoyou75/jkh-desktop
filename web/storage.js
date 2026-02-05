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
      Запрещена ретро-перезапись: дата фактической оплаты не меняется.

   4) Исключённые периоды отключают ТОЛЬКО пеню, основной долг не трогают.

   5) ES-modules (type="module", import/export) в v1.5.x ЗАПРЕЩЕНЫ:
      проект должен работать в режиме file:// без сервера.

   Любая правка этого блока/связанных расчётов → только через новую версию SPEC.
   ============================================================ */

/*
  STORAGE MODULE
  Classic script + защита от двойной загрузки

  ✅ ВАЖНОЕ ДОБАВЛЕНИЕ (2026-02-05):
  Введён канонический StorageAdapter (window.JKHStore).
  Правило проекта: прямой localStorage.* вне storage.js запрещён.
  UI/данные используют JKHStore / JKHStorage.
*/

(function () {
  "use strict";

  // ============================================================
  // 🔑 Scoped localStorage keys (per-user базы)
  // ============================================================
  function _getSessionUser() {
    try {
      return (window.Auth && typeof Auth.getCurrentUser === "function") ? Auth.getCurrentUser() : null;
    } catch (e) { return null; }
  }

  function _isAdmin() {
    var u = _getSessionUser();
    return !!(u && u.role === "admin");
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
    if (isGuestMode()) throw new Error("GUEST_READONLY");
    if (isAllMode()) throw new Error("ALLMODE_READONLY");
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
  // ✅ StorageAdapter (канон)
  // UI/скрипты должны работать через JKHStore, а НЕ через localStorage.*
  // ============================================================
  function _safeJsonParse(raw, fallback) {
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }
  function _safeJsonStringify(v) {
    try { return JSON.stringify(v); } catch (e) { return ""; }
  }

  function canWriteNow() {
    // канон: guest и ALL-mode не пишут
    if (isGuestMode()) return false;
    if (isAllMode()) return false;
    return true;
  }

  // Админская "техоперация": разрешаем работать по другим ownerId даже когда admin в ALL-mode
  function _adminMaintenanceAllowed() {
    return _isAdmin(); // достаточно на офлайн-прототипе
  }

  function _adminGetItemForOwner(ownerId, key) {
    return localStorage.getItem(k(key, ownerId));
  }
  function _adminSetItemForOwner(ownerId, key, value) {
    if (!_adminMaintenanceAllowed()) throw new Error("ADMIN_REQUIRED");
    localStorage.setItem(k(key, ownerId), value);
  }
  function _adminRemoveItemForOwner(ownerId, key) {
    if (!_adminMaintenanceAllowed()) throw new Error("ADMIN_REQUIRED");
    localStorage.removeItem(k(key, ownerId));
  }
  function _adminKeysForOwner(ownerId) {
    if (!_adminMaintenanceAllowed()) throw new Error("ADMIN_REQUIRED");
    return keysForOwner(ownerId);
  }

  window.JKHStore = {
    // режимы/контекст
    getOwnerId: getActiveOwnerId,
    isAllMode: isAllMode,
    isGuestMode: isGuestMode,
    canWriteNow: canWriteNow,

    // ключи
    key: function (baseKey, ownerId) { return k(baseKey, ownerId); },
    scopePrefixFor: scopePrefixFor,

    // raw (scoped) — ОСНОВНАЯ ДВЕРЬ
    getRaw: function (baseKey, ownerId) { return getItem(baseKey, ownerId); },
    setRaw: function (baseKey, value, ownerId) { return setItem(baseKey, value, ownerId); },
    removeRaw: function (baseKey, ownerId) { return removeItem(baseKey, ownerId); },

    // json (scoped)
    getJSON: function (baseKey, fallback, ownerId) {
      var raw = getItem(baseKey, ownerId);
      if (!raw) return fallback;
      return _safeJsonParse(raw, fallback);
    },
    setJSON: function (baseKey, obj, ownerId) {
      return setItem(baseKey, _safeJsonStringify(obj), ownerId);
    },

    // keys listing (scoped)
    keysForOwner: function (ownerId) { return keysForOwner(ownerId); },

    // admin maintenance
    admin: {
      allowed: _adminMaintenanceAllowed,
      getRawForOwner: function (ownerId, baseKey) { return _adminGetItemForOwner(ownerId, baseKey); },
      setRawForOwner: function (ownerId, baseKey, value) { return _adminSetItemForOwner(ownerId, baseKey, value); },
      removeRawForOwner: function (ownerId, baseKey) { return _adminRemoveItemForOwner(ownerId, baseKey); },
      keysForOwner: function (ownerId) { return _adminKeysForOwner(ownerId); },
      setJSONForOwner: function (ownerId, baseKey, obj) { return _adminSetItemForOwner(ownerId, baseKey, _safeJsonStringify(obj)); }
    }
  };

  // ============================================================
  // DEV GUARD: предупреждаем о localStorage.* вне storage.js
  // (мягко: только console.warn, без поломки)
  // Включение: ?dev=1 или window.JKH_DEV_GUARD = true
  // ============================================================
  (function installDevGuard() {
    try {
      if (window.__JKH_LS_GUARD_INSTALLED) return;
      window.__JKH_LS_GUARD_INSTALLED = true;

      var enabled = false;
      try {
        if (window.JKH_DEV_GUARD === true) enabled = true;
        if (String(location.search || "").indexOf("dev=1") !== -1) enabled = true;
      } catch (e) {}

      if (!enabled) return;

      var origGet = localStorage.getItem.bind(localStorage);
      var origSet = localStorage.setItem.bind(localStorage);
      var origRem = localStorage.removeItem.bind(localStorage);

      function warn(op) {
        try {
          var st = (new Error()).stack || "";
          // если стека нет — просто молчим
          if (!st) return;
          // если вызов из storage.js — не предупреждаем
          if (st.indexOf("storage.js") !== -1) return;

          // ограничиваем спам: один раз на страницу
          if (!window.__JKH_LS_GUARD_WARNED) window.__JKH_LS_GUARD_WARNED = {};
          if (window.__JKH_LS_GUARD_WARNED[op]) return;
          window.__JKH_LS_GUARD_WARNED[op] = true;

          console.warn(
            "⚠️ ПАПАЖКХ: прямой localStorage." + op + " вне storage.js запрещён. " +
            "Используй JKHStore / JKHStorage."
          );
        } catch (e) {}
      }

      localStorage.getItem = function () { warn("getItem"); return origGet.apply(null, arguments); };
      localStorage.setItem = function () { warn("setItem"); return origSet.apply(null, arguments); };
      localStorage.removeItem = function () { warn("removeItem"); return origRem.apply(null, arguments); };
    } catch (e) {}
  })();

  // ============================================================
  // Legacy StorageAPI below used unscoped keys ранее.
  // Теперь делаем их scoped через JKHStorage.k(...)
  // ============================================================
  function _sk(key) {
    try { return (window.JKHStorage && typeof JKHStorage.k === 'function') ? JKHStorage.k(key) : key; }
    catch (e) { return key; }
  }

  // ✅ если уже загружен — выходим (чтобы не было "already declared")
  if (window.StorageAPI && window.StorageAPI.__loaded_v2) return;

  const NOTES_KEY = 'abonent_notes_v1';
  const PERIODS_KEY = 'exclude_periods_v1';

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
      }).catch(() => { });
    } catch (e) { }
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
    } catch (e) { }

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
    } catch (e) { }
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
