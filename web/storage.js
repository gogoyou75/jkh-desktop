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

  var GLOBAL_PROJECT_EXACT = [
    "refinancing_rates_normal_v1",
    "refinancing_rates_moratorium_v1"
  ];

  function isGlobalProjectKey(baseKey) {
    var kx = String(baseKey || "");
    for (var i = 0; i < GLOBAL_PROJECT_EXACT.length; i++) {
      if (kx === GLOBAL_PROJECT_EXACT[i]) return true;
    }
    return false;
  }

  function resolveOwnerForKey(baseKey, ownerId) {
    if (isGlobalProjectKey(baseKey)) return "GLOBAL";
    return ownerId || getActiveOwnerId();
  }

  function k(key, ownerId) {
    return scopePrefixFor(resolveOwnerForKey(key, ownerId)) + key;
  }

  function getItem(key, ownerId) {
    return localStorage.getItem(k(key, ownerId));
  }

  function setItem(key, value, ownerId) {
    // гость не пишет данные базы (только просмотр)
    if (isGuestMode()) throw new Error("GUEST_READONLY");
    if (isAllMode()) throw new Error("ALLMODE_READONLY");
    if (isGlobalProjectKey(key) && !_isAdmin()) throw new Error("GLOBAL_ADMIN_ONLY");
    localStorage.setItem(k(key, ownerId), value);
  }

  function removeItem(key, ownerId) {
    if (isGuestMode()) throw new Error("GUEST_READONLY");
    if (isAllMode()) throw new Error("ALLMODE_READONLY");
    if (isGlobalProjectKey(key) && !_isAdmin()) throw new Error("GLOBAL_ADMIN_ONLY");
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
  // Project key registry (единый канон sync/storage)
  // ============================================================
  var SYNC_CANON_EXACT = [
    "abonents_db_v1",
    "abonent_notes_v1",
    "exclude_periods_v1",
    "tariffs_dynamic_v1",
    "tariffs_content_repair_v1",
    "tariffs_content_repair_v1_backup",
    "refinancing_rates_normal_v1",
    "refinancing_rates_moratorium_v1",
    "organization_requisites_v1",
    "organization_signers_v1",
    "payment_sources_v1",
    "last_abonent_id",
    "import_preview_v1",
    "draft_new_abonent_v1",
    "jkh_excel_date_debug"
  ];
  var SYNC_CANON_PREFIX = [
    "payments_",
    "exclude_periods_",
    "note_",
    "calc_period_",
    "calc_period_active_",
    "report_period_",
    "payments_ui_collapsed_",
    "jkh_transfer_to_v1:",
    "jkh_transfer_balance_v1:",
    "jkh_freeze_to_v1:",
    "jkh_frozen_debt_v1:",
    "moratorium_"
  ];

  function _isScopedKeyName(x) {
    return String(x || "").indexOf("jkhdb::") === 0;
  }
  function _isProjectDataKey(baseKey) {
    var kx = String(baseKey || "");
    if (!kx || _isScopedKeyName(kx)) return false;
    for (var i = 0; i < SYNC_CANON_EXACT.length; i++) if (kx === SYNC_CANON_EXACT[i]) return true;
    for (var j = 0; j < SYNC_CANON_PREFIX.length; j++) if (kx.indexOf(SYNC_CANON_PREFIX[j]) === 0) return true;
    return false;
  }
  function _toScopedProjectKeyMaybe(rawKey) {
    var key = String(rawKey || "");
    if (!key || _isScopedKeyName(key)) return key;
    if (!_isProjectDataKey(key)) return key;
    return k(key);
  }

  // ============================================================
  // Bridge: прямой localStorage.* на страницах -> scoped ключи
  // ============================================================
  (function installProjectScopedLocalStorageBridge() {
    try {
      if (window.__JKH_PROJECT_SCOPE_BRIDGE_INSTALLED) return;
      window.__JKH_PROJECT_SCOPE_BRIDGE_INSTALLED = true;

      var origGet = localStorage.getItem.bind(localStorage);
      var origSet = localStorage.setItem.bind(localStorage);
      var origRem = localStorage.removeItem.bind(localStorage);

      localStorage.getItem = function (key) {
        var realKey = _toScopedProjectKeyMaybe(key);
        return origGet(realKey);
      };

      localStorage.setItem = function (key, value) {
        var baseKey = String(key || "");
        var realKey = _toScopedProjectKeyMaybe(baseKey);
        if (_isProjectDataKey(baseKey)) {
          if (isGuestMode()) throw new Error("GUEST_READONLY");
          if (isAllMode()) throw new Error("ALLMODE_READONLY");
          if (isGlobalProjectKey(baseKey) && !_isAdmin()) throw new Error("GLOBAL_ADMIN_ONLY");
        }
        return origSet(realKey, value);
      };

      localStorage.removeItem = function (key) {
        var baseKey = String(key || "");
        var realKey = _toScopedProjectKeyMaybe(baseKey);
        if (_isProjectDataKey(baseKey)) {
          if (isGuestMode()) throw new Error("GUEST_READONLY");
          if (isAllMode()) throw new Error("ALLMODE_READONLY");
          if (isGlobalProjectKey(baseKey) && !_isAdmin()) throw new Error("GLOBAL_ADMIN_ONLY");
        }
        return origRem(realKey);
      };
    } catch (e) {
      try { console.warn("[JKH storage] failed to install localStorage bridge:", e); } catch (_) {}
    }
  })();

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


/* ============================================================
   ✅ JKH_REMOTE_SYNC_STATUS_V1 (2026-02-10)
   Вариант 2 (ONLINE): MySQL = главный источник (через API), localStorage = кэш.
   Добавлено:
   - Кнопки "Загрузить/Сохранить" (работают через index.html)
   - Авто-сохранение раз в N минут
   - Режим "сохранять только если были изменения"
   - Статус-строка (видно без F12)
   ============================================================ */

(function () {
  "use strict";

  // ---- settings keys ----
  var K_MODE = "jkh_remote_mode_v1"; // "1" online, "0" offline
  var K_AS_ENABLED = "jkh_autosave_enabled_v1";
  var K_AS_MINUTES = "jkh_autosave_minutes_v1";
  var K_AS_SCOPE = "jkh_autosave_scope_v1"; // "db" | "all"
  var K_AS_ONLY_CHANGED = "jkh_autosave_only_changed_v1";
  var K_LAST_SIG_DB = "jkh_last_sig_db_v1";
  var K_LAST_SIG_ALL = "jkh_last_sig_all_v1";

  function _nowISO() {
    try { return new Date().toISOString(); } catch (e) { return ""; }
  }

  function _fmtTime(tsIso) {
    if (!tsIso) return "—";
    try {
      var d = new Date(tsIso);
      var hh = String(d.getHours()).padStart(2, "0");
      var mm = String(d.getMinutes()).padStart(2, "0");
      var ss = String(d.getSeconds()).padStart(2, "0");
      return hh + ":" + mm + ":" + ss;
    } catch (e) { return String(tsIso); }
  }

  function _lsGet(k, fallback) {
    try {
      var v = localStorage.getItem(k);
      return (v === null || v === undefined) ? fallback : v;
    } catch (e) { return fallback; }
  }
  function _lsSet(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { }
  }

  function isOnlineMode() {
    // по умолчанию online=1 (серверный режим для тестировщика)
    var v = _lsGet(K_MODE, "1");
    return v === "1";
  }

  function _ownerId() {
    if (!window.JKHStore) return "guest";
    return window.JKHStore.getOwnerId();
  }

  function _isGuestOrAll() {
    if (!window.JKHStore) return true;
    return window.JKHStore.isGuestMode() || window.JKHStore.isAllMode();
  }

  // ---- status state ----
  var status = {
    server: "…",         // ok | offline | error | …
    lastSaveAt: null,    // ISO
    autosaveState: "—",
    lastAction: "—",
    lastError: null
  };

  function _setStatus(patch) {
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) status[k] = patch[k];
    }
    refreshStatusUI();
  }

  function refreshStatusUI() {
    // безопасно: если блока нет — молча.
    try {
      var elServer = document.getElementById("syncServerState");
      var elSave = document.getElementById("syncLastSave");
      var elAS = document.getElementById("syncAutosaveState");
      var elAct = document.getElementById("syncLastAction");
      var elErr = document.getElementById("syncLastError");

      if (elServer) elServer.textContent = status.server || "—";
      if (elSave) elSave.textContent = status.lastSaveAt ? _fmtTime(status.lastSaveAt) : "—";
      if (elAS) elAS.textContent = status.autosaveState || "—";
      if (elAct) elAct.textContent = status.lastAction || "—";
      if (elErr) elErr.textContent = status.lastError ? String(status.lastError) : "—";
    } catch (e) { }
  }

  // ---- small hash (djb2) for "only if changed" ----
  function _hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) + h) + s.charCodeAt(i);
      h = h >>> 0;
    }
    return h.toString(16);
  }

  function _sigForDB(ownerId) {
    var KEY_DB = "abonents_db_v1";
    var obj = window.JKHStore ? window.JKHStore.getJSON(KEY_DB, null, ownerId) : null;
    var s = "";
    try { s = JSON.stringify(obj || {}); } catch (e) { s = String(obj); }
    return _hashStr(s) + ":" + String(s.length);
  }

  function _sigForALL(ownerId) {
    if (!window.JKHStore) return "0:0";
    var scopedKeys = window.JKHStore.keysForOwner(ownerId) || [];
    var pref = window.JKHStore.scopePrefixFor(ownerId) || "";
    // сортируем, чтобы подпись была стабильной
    scopedKeys.sort();
    var out = [];
    for (var i = 0; i < scopedKeys.length; i++) {
      var sk = scopedKeys[i];
      var baseKey = sk.indexOf(pref) === 0 ? sk.slice(pref.length) : sk;
      var raw = window.JKHStore.getRaw(baseKey, ownerId) || "";
      out.push(baseKey + "=" + raw);
    }
    var joined = out.join("\n");
    return _hashStr(joined) + ":" + String(joined.length);
  }

  function _getLastSigKey(scope) {
    return (scope === "all") ? K_LAST_SIG_ALL : K_LAST_SIG_DB;
  }

  // ---- canonical sync keys ----
  var KEY_DB = "abonents_db_v1";
  var SYNC_STATIC_KEYS = SYNC_CANON_EXACT.slice();

  function _uniq(arr) {
    var m = {};
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var x = String(arr[i] || "");
      if (!x || m[x]) continue;
      m[x] = true;
      out.push(x);
    }
    return out;
  }

  function _parseDb(ownerId) {
    try {
      var raw = window.JKHStore ? window.JKHStore.getRaw(KEY_DB, ownerId) : null;
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function _dynamicKeysFromDb(ownerId) {
    var out = [];
    var db = _parseDb(ownerId);
    var abonents = (db && db.abonents) ? db.abonents : {};
    var ids = Object.keys(abonents || {});
    for (var i = 0; i < ids.length; i++) {
      var id = String(ids[i] || "").trim();
      if (!id) continue;
      out.push("payments_" + id);
      out.push("exclude_periods_" + id);
      out.push("note_" + id);
      out.push("calc_period_" + id);
      out.push("calc_period_active_" + id);
      out.push("report_period_" + id);
      out.push("payments_ui_collapsed_" + id);
      out.push("jkh_transfer_to_v1:" + id);
      out.push("jkh_freeze_to_v1:" + id);
      out.push("moratorium_" + id);
    }
    return out;
  }

  function _projectKeysForScope(scope, ownerId) {
    var keys = [];
    // db/all: всегда используем единый канонический список + динамика
    keys = SYNC_STATIC_KEYS.concat(_dynamicKeysFromDb(ownerId));
    if (window.JKHStore) {
      var pref = window.JKHStore.scopePrefixFor(ownerId) || "";
      var scoped = window.JKHStore.keysForOwner(ownerId) || [];
      for (var i = 0; i < scoped.length; i++) {
        var sk = String(scoped[i] || "");
        if (!sk) continue;
        var baseKey = sk.indexOf(pref) === 0 ? sk.slice(pref.length) : sk;
        if (_isProjectDataKey(baseKey)) keys.push(baseKey);
      }
    }
    return _uniq(keys);
  }

  function _readLocalCompat(baseKey, ownerId) {
    // 1) scoped (новый канон)
    var v = window.JKHStore ? window.JKHStore.getRaw(baseKey, ownerId) : null;
    if (v !== null && v !== undefined && v !== "") return v;
    // 2) legacy plain localStorage (старые страницы)
    try { return localStorage.getItem(baseKey) || ""; } catch (e) { return ""; }
  }

  function _writeLocalCompat(baseKey, value, ownerId) {
    var v = (value === null || value === undefined) ? "" : String(value);
    if (window.JKHStore) window.JKHStore.setRaw(baseKey, v, ownerId);
    // Переходная совместимость: страницы, которые ещё читают прямой localStorage.
    try { localStorage.setItem(baseKey, v); } catch (e) { }
  }

  function _isDbEffectivelyEmpty(rawDb) {
    if (!rawDb || !String(rawDb).trim()) return true;
    try {
      var db = JSON.parse(rawDb);
      if (!db || typeof db !== "object") return true;
      var ab = db.abonents && typeof db.abonents === "object" ? Object.keys(db.abonents).length : 0;
      var pr = db.premises && typeof db.premises === "object" ? Object.keys(db.premises).length : 0;
      var ln = Array.isArray(db.links) ? db.links.length : 0;
      return (ab + pr + ln) === 0;
    } catch (e) { return true; }
  }

  // ---- API calls ----
  async function _apiGet(url) {
    var r = await fetch(url, { method: "GET", credentials: "include" });
    var txt = await r.text();
    var data;
    try { data = JSON.parse(txt); } catch (e) { data = null; }
    return { okHttp: r.ok, status: r.status, data: data, text: txt };
  }

  async function _apiPost(url, bodyObj) {
    var r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyObj),
      credentials: "include"
    });
    var txt = await r.text();
    var data;
    try { data = JSON.parse(txt); } catch (e) { data = null; }
    return { okHttp: r.ok, status: r.status, data: data, text: txt };
  }

  async function pingServer() {
    if (!isOnlineMode()) {
      _setStatus({ server: "OFFLINE (локально)", lastError: null });
      return false;
    }
    try {
      var res = await _apiGet("/api/store_keys");
      if (res.okHttp && res.data && res.data.ok === true) {
        _setStatus({ server: "🟢 подключён", lastError: null });
        return true;
      }
      _setStatus({ server: "🟡 нет ответа", lastError: (res.data && res.data.error) ? res.data.error : ("HTTP " + res.status) });
      return false;
    } catch (e) {
      _setStatus({ server: "🔴 ошибка сети", lastError: String(e && e.message ? e.message : e) });
      return false;
    }
  }

  async function upload(scope) {
    if (!isOnlineMode()) {
      _setStatus({ lastAction: "Сохранение пропущено: OFFLINE режим", lastError: null });
      return false;
    }
    if (_isGuestOrAll()) {
      _setStatus({ lastAction: "Сохранение запрещено: Гость/ALL", lastError: "GUEST_OR_ALL_READONLY" });
      return false;
    }

    var ownerId = _ownerId();
    var onlyIfChanged = (_lsGet(K_AS_ONLY_CHANGED, "0") === "1");
    var scopeNorm = (scope === "all") ? "all" : "db";
    var sig = (scopeNorm === "all") ? _sigForALL(ownerId) : _sigForDB(ownerId);
    var lastSig = _lsGet(_getLastSigKey(scopeNorm), "");
    if (onlyIfChanged && lastSig && sig === lastSig) {
      _setStatus({ lastAction: "Изменений нет — сохранение пропущено", lastError: null });
      return true;
    }

    try {
      var keysToSave = _projectKeysForScope(scopeNorm, ownerId);
      for (var i = 0; i < keysToSave.length; i++) {
        var baseKey = keysToSave[i];
        var raw = _readLocalCompat(baseKey, ownerId);

        // safeguard: не перезаписываем непустую базу на сервере пустой локальной базой
        if (baseKey === KEY_DB && _isDbEffectivelyEmpty(raw)) {
          var resCur = await _apiGet("/api/store?key=" + encodeURIComponent(KEY_DB));
          var srv = (resCur.okHttp && resCur.data && resCur.data.ok) ? (resCur.data.value || "") : "";
          if (_isDbEffectivelyEmpty(raw) && !_isDbEffectivelyEmpty(srv)) {
            _setStatus({ lastAction: "Сохранение остановлено", lastError: "EMPTY_DB_OVERWRITE_BLOCKED" });
            console.warn("[JKH sync][save] owner=%s key=%s size=%s status=blocked_empty_overwrite", ownerId, baseKey, String(raw || "").length);
            return false;
          }
        }

        var resSet = await _apiPost("/api/store", { key: baseKey, value: raw });
        if (!(resSet.okHttp && resSet.data && resSet.data.ok === true)) {
          _setStatus({ lastAction: "Ошибка сохранения ключа " + baseKey, lastError: (resSet.data && resSet.data.error) ? resSet.data.error : ("HTTP " + resSet.status) });
          console.warn("[JKH sync][save] owner=%s key=%s size=%s status=error", ownerId, baseKey, String(raw || "").length);
          return false;
        }
        console.info("[JKH sync][save] owner=%s key=%s size=%s status=ok", ownerId, baseKey, String(raw || "").length);
      }

      _lsSet(_getLastSigKey(scopeNorm), sig);
      _setStatus({ lastSaveAt: _nowISO(), lastAction: "✅ Сохранено на сервер", lastError: null });
      return true;
    } catch (e) {
      _setStatus({ lastAction: "Ошибка сохранения", lastError: String(e && e.message ? e.message : e) });
      return false;
    }
  }

  async function download(scope) {
    if (!isOnlineMode()) {
      _setStatus({ lastAction: "Загрузка пропущена: OFFLINE режим", lastError: null });
      return false;
    }
    if (_isGuestOrAll()) {
      _setStatus({ lastAction: "Загрузка запрещена: Гость/ALL", lastError: "GUEST_OR_ALL_READONLY" });
      return false;
    }

    var ownerId = _ownerId();

    try {
      var scopeNorm = (scope === "all") ? "all" : "db";
      var keysToLoad = [];
      if (scopeNorm === "all") {
        var resKeys = await _apiGet("/api/store_keys");
        if (!(resKeys.okHttp && resKeys.data && resKeys.data.ok === true)) {
          _setStatus({ lastAction: "Ошибка чтения ключей", lastError: (resKeys.data && resKeys.data.error) ? resKeys.data.error : ("HTTP " + resKeys.status) });
          return false;
        }
        keysToLoad = _uniq((resKeys.data.keys || []).concat(_projectKeysForScope(scopeNorm, ownerId)));
      } else {
        keysToLoad = _projectKeysForScope(scopeNorm, ownerId);
      }

      for (var i = 0; i < keysToLoad.length; i++) {
        var baseKey = keysToLoad[i];
        var resGet = await _apiGet("/api/store?key=" + encodeURIComponent(baseKey));
        if (!(resGet.okHttp && resGet.data && resGet.data.ok === true)) {
          // для части ключей отсутствие на сервере допустимо (например новый клиент)
          if (resGet.status === 404) {
            console.info("[JKH sync][load] owner=%s key=%s status=not_found", ownerId, baseKey);
            continue;
          }
          _setStatus({ lastAction: "Ошибка загрузки ключа " + baseKey, lastError: (resGet.data && resGet.data.error) ? resGet.data.error : ("HTTP " + resGet.status) });
          console.warn("[JKH sync][load] owner=%s key=%s status=error", ownerId, baseKey);
          return false;
        }
        _writeLocalCompat(baseKey, resGet.data.value || "", ownerId);
        console.info("[JKH sync][load] owner=%s key=%s size=%s status=ok", ownerId, baseKey, String(resGet.data.value || "").length);
      }

      // пересчёт сигнатуры после загрузки
      var sig = (scopeNorm === "all") ? _sigForALL(ownerId) : _sigForDB(ownerId);
      _lsSet(_getLastSigKey(scopeNorm), sig);

      _setStatus({ lastAction: "✅ Загружено с сервера", lastError: null });
      return true;
    } catch (e) {
      _setStatus({ lastAction: "Ошибка загрузки", lastError: String(e && e.message ? e.message : e) });
      return false;
    }
  }

  // ---- UI helpers ----
  function getSettings() {
    return {
      enabled: _lsGet(K_AS_ENABLED, "0") === "1",
      minutes: parseInt(_lsGet(K_AS_MINUTES, "5"), 10) || 5,
      scope: _lsGet(K_AS_SCOPE, "db") || "db",
      onlyIfChanged: _lsGet(K_AS_ONLY_CHANGED, "0") === "1"
    };
  }

  var _timer = null;

  function _stopTimer() {
    if (_timer) {
      try { clearInterval(_timer); } catch (e) { }
      _timer = null;
    }
  }

  function _startTimer() {
    _stopTimer();

    var s = getSettings();
    if (!s.enabled) {
      _setStatus({ autosaveState: "выключено" });
      return;
    }

    var mins = Math.max(1, Math.min(120, s.minutes || 5));
    _setStatus({ autosaveState: "включено (" + mins + " мин), режим: " + (s.scope === "all" ? "вся база" : "только база") + (s.onlyIfChanged ? ", только при изменениях" : "") });

    _timer = setInterval(function () {
      upload(s.scope === "all" ? "all" : "db");
    }, mins * 60 * 1000);
  }

  function applySettingsFromUI(s) {
    var enabled = !!s.enabled;
    var minutes = Math.max(1, Math.min(120, parseInt(s.minutes, 10) || 5));
    var scope = (s.scope === "all") ? "all" : "db";
    var onlyIfChanged = !!s.onlyIfChanged;

    _lsSet(K_AS_ENABLED, enabled ? "1" : "0");
    _lsSet(K_AS_MINUTES, String(minutes));
    _lsSet(K_AS_SCOPE, scope);
    _lsSet(K_AS_ONLY_CHANGED, onlyIfChanged ? "1" : "0");

    _setStatus({ lastAction: "Настройки авто-сохранения применены", lastError: null });
    _startTimer();
  }

  async function uploadNow() {
    if (_isGuestOrAll()) {
      alert("Сохранение запрещено: режим 'Гость' или 'ALL'.\n\nПояснение:\n- Гость (Guest) = только просмотр\n- ALL = сводный просмотр админом");
      return;
    }
    var s = getSettings();
    var scope = (s.scope === "all") ? "all" : "db";
    await upload(scope);
  }

  async function downloadNow() {
    if (_isGuestOrAll()) {
      alert("Загрузка запрещена: режим 'Гость' или 'ALL'.");
      return;
    }
    var ok = confirm("Загрузить данные с сервера (MySQL) и заменить локальные?\n\nВНИМАНИЕ: локальные несохранённые изменения будут перезаписаны.");
    if (!ok) return;
    var s = getSettings();
    var scope = (s.scope === "all") ? "all" : "db";
    await download(scope);
    try { location.reload(); } catch (e) { }
  }

  async function autoLoadAfterLogin() {
    try {
      if (!window.Auth || typeof Auth.getCurrentUser !== "function") return false;
      var user = Auth.getCurrentUser();
      if (!user || !user.id) return false;
      if (_isGuestOrAll()) return false;
      if (!isOnlineMode()) return false;

      var markerKey = "jkh_sync_autoload_done_v1";
      var markerVal = "";
      try { markerVal = sessionStorage.getItem(markerKey) || ""; } catch (e0) { markerVal = ""; }
      var expected = user.id + "|ok";
      if (markerVal === expected) return true;

      console.info("[JKH sync][login] userId=%s email=%s action=auto_load_start", user.id, String(user.email || ""));

      var resDump = await _apiGet("/api/store_dump");
      if (!(resDump.okHttp && resDump.data && resDump.data.ok === true)) {
        _setStatus({ lastAction: "Автозагрузка не выполнена", lastError: (resDump.data && resDump.data.error) ? resDump.data.error : ("HTTP " + resDump.status) });
        return false;
      }

      var data = resDump.data.data || {};
      var keys = _uniq(Object.keys(data).concat(_projectKeysForScope("db", user.id)));
      for (var i = 0; i < keys.length; i++) {
        var bk = keys[i];
        if (!_isProjectDataKey(bk)) continue;
        var val = Object.prototype.hasOwnProperty.call(data, bk) ? data[bk] : "";
        _writeLocalCompat(bk, val || "", user.id);
        console.info("[JKH sync][load] owner=%s key=%s size=%s status=ok", user.id, bk, String(val || "").length);
      }

      try { sessionStorage.setItem(markerKey, expected); } catch (e1) { _lsSet(markerKey, expected); }
      _setStatus({ lastAction: "✅ Автозагрузка после входа завершена", lastError: null });
      console.info("[JKH sync][login] userId=%s email=%s action=auto_load_done keys=%s", user.id, String(user.email || ""), keys.length);
      return true;
    } catch (e) {
      _setStatus({ lastAction: "Ошибка автозагрузки", lastError: String(e && e.message ? e.message : e) });
      return false;
    }
  }

  // стартуем таймер при загрузке страницы (если включён)
  try { _startTimer(); } catch (e) { }

  window.JKHRemoteSync = {
    // public
    pingServer: pingServer,
    uploadNow: uploadNow,
    downloadNow: downloadNow,
    applySettingsFromUI: applySettingsFromUI,
    getSettings: getSettings,
    refreshStatusUI: refreshStatusUI,
    autoLoadAfterLogin: autoLoadAfterLogin,
    projectKeyCanon: function () { return { exact: SYNC_CANON_EXACT.slice(), prefix: SYNC_CANON_PREFIX.slice() }; }
  };
})();
