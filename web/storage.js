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

  if (typeof window.JKH_DATA_READY !== "boolean") window.JKH_DATA_READY = false;

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

  function _lsGetDirect(fullKey) {
    return Storage.prototype.getItem.call(localStorage, fullKey);
  }
  function _lsSetDirect(fullKey, value) {
    return Storage.prototype.setItem.call(localStorage, fullKey, value);
  }
  function _lsRemoveDirect(fullKey) {
    return Storage.prototype.removeItem.call(localStorage, fullKey);
  }

  function getItem(key, ownerId) {
    if (_isProjectDataKey(key)) return _cacheGet(key, ownerId);
    return _lsGetDirect(k(key, ownerId));
  }

  function setItem(key, value, ownerId) {
    if (isGuestMode()) throw new Error("GUEST_READONLY");
    if (isAllMode()) throw new Error("ALLMODE_READONLY");
    if (isGlobalProjectKey(key) && !_isAdmin()) throw new Error("GLOBAL_ADMIN_ONLY");
    if (_isProjectDataKey(key)) { _cacheSet(key, value, ownerId); return; }
    _lsSetDirect(k(key, ownerId), value);
  }

  function removeItem(key, ownerId) {
    if (isGuestMode()) throw new Error("GUEST_READONLY");
    if (isAllMode()) throw new Error("ALLMODE_READONLY");
    if (isGlobalProjectKey(key) && !_isAdmin()) throw new Error("GLOBAL_ADMIN_ONLY");
    if (_isProjectDataKey(key)) { _cacheRemove(key, ownerId); return; }
    _lsRemoveDirect(k(key, ownerId));
  }

  function keysForOwner(ownerId) {
    return _cacheKeysForOwner(ownerId);
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

  // canonical registry exported for other closures in this file (and diagnostics)
  window.JKH_SYNC_CANON = {
    exact: SYNC_CANON_EXACT.slice(),
    prefix: SYNC_CANON_PREFIX.slice()
  };

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
        var baseKey = String(key || "");
        if (_isProjectDataKey(baseKey)) return getItem(baseKey);
        var realKey = _toScopedProjectKeyMaybe(baseKey);
        return origGet(realKey);
      };

      localStorage.setItem = function (key, value) {
        var baseKey = String(key || "");
        if (_isProjectDataKey(baseKey)) {
          setItem(baseKey, value);
          return;
        }
        var realKey = _toScopedProjectKeyMaybe(baseKey);
        return origSet(realKey, value);
      };

      localStorage.removeItem = function (key) {
        var baseKey = String(key || "");
        if (_isProjectDataKey(baseKey)) {
          removeItem(baseKey);
          return;
        }
        var realKey = _toScopedProjectKeyMaybe(baseKey);
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

  function _cacheGet(baseKey, ownerId) {
    return _lsGetDirect(k(baseKey, ownerId));
  }

  function _cacheSet(baseKey, value, ownerId) {
    _lsSetDirect(k(baseKey, ownerId), String(value));
  }

  function _cacheRemove(baseKey, ownerId) {
    _lsRemoveDirect(k(baseKey, ownerId));
  }

  function _cacheKeysForOwner(ownerId) {
    var out = [];
    var pref = scopePrefixFor(ownerId || getActiveOwnerId());
    for (var i = 0; i < localStorage.length; i++) {
      var kk = localStorage.key(i) || "";
      if (kk.indexOf(pref) === 0) out.push(kk);
    }
    return out;
  }

  function _adminGetItemForOwner(ownerId, baseKey) {
    var u = _getSessionUser();
    if (!u || u.role !== "admin") throw new Error("ADMIN_ONLY");
    var oid = String(ownerId || "");
    if (!oid) throw new Error("OWNER_REQUIRED");
    return _lsGetDirect(k(baseKey, oid));
  }

  function _adminSetItemForOwner(ownerId, baseKey, value) {
    var u = _getSessionUser();
    if (!u || u.role !== "admin") throw new Error("ADMIN_ONLY");
    var oid = String(ownerId || "");
    if (!oid) throw new Error("OWNER_REQUIRED");
    _lsSetDirect(k(baseKey, oid), String(value));
  }

  window.JKHStore = {
    // identity/scope
    getOwnerId: function () { return getActiveOwnerId(); },
    isGuestMode: isGuestMode,
    isAllMode: isAllMode,
    scopePrefixFor: scopePrefixFor,

    // raw scoped
    getRaw: function (baseKey, ownerId) { return getItem(baseKey, ownerId); },
    setRaw: function (baseKey, value, ownerId) { return setItem(baseKey, value, ownerId); },
    removeRaw: function (baseKey, ownerId) { return removeItem(baseKey, ownerId); },

    // JSON helpers
    getJSON: function (baseKey, fallback, ownerId) {
      var raw = getItem(baseKey, ownerId);
      if (raw === null || raw === undefined || raw === "") return fallback;
      return _safeJsonParse(raw, fallback);
    },
    setJSON: function (baseKey, obj, ownerId) {
      setItem(baseKey, _safeJsonStringify(obj), ownerId);
    },

    // keys
    keysForOwner: keysForOwner,

    // admin-only cross-owner access
    admin: {
      getRawForOwner: function (ownerId, baseKey) { return _adminGetItemForOwner(ownerId, baseKey); },
      setRawForOwner: function (ownerId, baseKey, value) { return _adminSetItemForOwner(ownerId, baseKey, value); }
    }
  };

  // ============================================================
  // Strict mode guard for direct localStorage usage (dev assist)
  // ============================================================
  (function installStrictLocalStorageGuard() {
    try {
      if (window.__JKH_STRICT_GUARD_INSTALLED) return;
      window.__JKH_STRICT_GUARD_INSTALLED = true;

      var allow = {
        "storage.js": true,
        "auth.js": true
      };

      function _isAllowedStack(stack) {
        if (!stack) return true;
        var s = String(stack);
        for (var k in allow) {
          if (Object.prototype.hasOwnProperty.call(allow, k) && s.indexOf(k) !== -1) return true;
        }
        return false;
      }

      var origGet = Storage.prototype.getItem;
      var origSet = Storage.prototype.setItem;
      var origRem = Storage.prototype.removeItem;

      Storage.prototype.getItem = function (key) {
        try {
          var st = (new Error()).stack || "";
          if (!_isAllowedStack(st)) {
            console.warn(
              "[JKH strict] direct localStorage.getItem outside storage/auth is discouraged. key=%s\n" +
              "Используй JKHStore / JKHStorage.",
              String(key || "")
            );
          }
        } catch (e) {}
        return origGet.apply(this, arguments);
      };

      Storage.prototype.setItem = function (key, val) {
        try {
          var st = (new Error()).stack || "";
          if (!_isAllowedStack(st)) {
            console.warn(
              "[JKH strict] direct localStorage.setItem outside storage/auth is discouraged. key=%s\n" +
              "Используй JKHStore / JKHStorage.",
              String(key || "")
            );
          }
        } catch (e) {}
        return origSet.apply(this, arguments);
      };

      Storage.prototype.removeItem = function (key) {
        try {
          var st = (new Error()).stack || "";
          if (!_isAllowedStack(st)) {
            console.warn(
              "[JKH strict] direct localStorage.removeItem outside storage/auth is discouraged. key=%s\n" +
              "Используй JKHStore / JKHStorage.",
              String(key || "")
            );
          }
        } catch (e) {}
        return origRem.apply(this, arguments);
      };
    } catch (e) {}
  })();

  // ============================================================
  // Sync module
  // ============================================================
  var KEY_DB = "abonents_db_v1";
  var K_MODE = "jkh_sync_mode_v1";            // online/offline
  var K_AS_ENABLED = "jkh_sync_as_enabled_v1";
  var K_AS_MINUTES = "jkh_sync_as_minutes_v1";
  var K_AS_SCOPE = "jkh_sync_as_scope_v1";    // db/all
  var K_AS_ONLY_CHANGED = "jkh_sync_as_onlychg_v1";
  var K_STATUS = "jkh_sync_status_v1";
  var K_LAST_SIG_DB = "jkh_sync_last_sig_db_v1";
  var K_LAST_SIG_ALL = "jkh_sync_last_sig_all_v1";

  var SYNC_STATIC_KEYS = [
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

  // keep compatibility alias if old code reads SYNC_CANON
  var SYNC_CANON = {
    exact: SYNC_CANON_EXACT,
    prefix: SYNC_CANON_PREFIX
  };

  function _nowISO() {
    try { return new Date().toISOString(); } catch (e) { return ""; }
  }

  function _ownerId() {
    if (!window.JKHStore) return "guest";
    return window.JKHStore.getOwnerId();
  }

  function _isGuestOrAll() {
    if (!window.JKHStore) return true;
    return window.JKHStore.isGuestMode() || window.JKHStore.isAllMode();
  }

  function _lsGet(key, def) {
    try {
      var v = Storage.prototype.getItem.call(localStorage, key);
      return (v === null || v === undefined) ? def : v;
    } catch (e) {
      return def;
    }
  }

  function _lsSet(key, val) {
    try { Storage.prototype.setItem.call(localStorage, key, String(val)); } catch (e) {}
  }

  function _getMode() {
    return _lsGet(K_MODE, "online") === "offline" ? "offline" : "online";
  }

  function _setMode(mode) {
    _lsSet(K_MODE, mode === "offline" ? "offline" : "online");
    refreshStatusUI();
  }

  function isOnlineMode() {
    return _getMode() === "online";
  }

  function getStatus() {
    var raw = _lsGet(K_STATUS, "");
    var st = _safeJsonParse(raw, null);
    if (!st || typeof st !== "object") {
      st = {
        server: "не проверен",
        lastAction: "",
        lastError: "",
        lastSaveAt: "",
        lastReadAt: "",
        autosaveState: "не настроено",
        ownerId: _ownerId(),
        loadSource: ""
      };
    }
    return st;
  }

  function _setStatus(patch) {
    var st = getStatus();
    for (var kx in patch) if (Object.prototype.hasOwnProperty.call(patch, kx)) st[kx] = patch[kx];
    _lsSet(K_STATUS, _safeJsonStringify(st));
    refreshStatusUI();
  }

  function refreshStatusUI() {
    var box = document.getElementById("syncStatus");
    if (!box) return;
    var s = getStatus();
    var mode = isOnlineMode() ? "🟢 ONLINE (MySQL)" : "🟡 OFFLINE (local)";
    box.innerHTML =
      '<div style="font-size:12px;line-height:1.45;">' +
      "<div><b>Режим:</b> " + mode + "</div>" +
      "<div><b>Сервер:</b> " + String(s.server || "") + "</div>" +
      "<div><b>База:</b> " + String(s.ownerId || "") + "</div>" +
      "<div><b>Последнее действие:</b> " + String(s.lastAction || "") + "</div>" +
      "<div><b>Последнее чтение:</b> " + String(s.lastReadAt || "") + "</div>" +
      "<div><b>Последнее сохранение:</b> " + String(s.lastSaveAt || "") + "</div>" +
      "<div><b>Авто-сохранение:</b> " + String(s.autosaveState || "") + "</div>" +
      (s.lastError ? ('<div style="color:#b00000;"><b>Ошибка:</b> ' + String(s.lastError) + "</div>") : "") +
      "</div>";
  }

  function _isProjectDataKeyLocal(baseKey) {
    var kx = String(baseKey || "");
    for (var i = 0; i < SYNC_CANON.exact.length; i++) if (kx === SYNC_CANON.exact[i]) return true;
    for (var j = 0; j < SYNC_CANON.prefix.length; j++) if (kx.indexOf(SYNC_CANON.prefix[j]) === 0) return true;
    return false;
  }

  function _sigForDB(ownerId) {
    var obj = window.JKHStore ? window.JKHStore.getJSON(KEY_DB, null, ownerId) : null;
    var ab = (obj && obj.abonents) ? Object.keys(obj.abonents).length : 0;
    var pr = (obj && obj.premises) ? Object.keys(obj.premises).length : 0;
    return String(ab) + ":" + String(pr);
  }

  function _sigForALL(ownerId) {
    if (!window.JKHStore) return "0:0";
    var scopedKeys = window.JKHStore.keysForOwner(ownerId) || [];
    var pref = window.JKHStore.scopePrefixFor(ownerId) || "";
    var cnt = 0;
    var sum = 0;
    for (var i = 0; i < scopedKeys.length; i++) {
      var sk = String(scopedKeys[i] || "");
      if (!sk) continue;
      var baseKey = sk.indexOf(pref) === 0 ? sk.slice(pref.length) : sk;
      if (!_isProjectDataKeyLocal(baseKey)) continue;
      var raw = window.JKHStore.getRaw(baseKey, ownerId) || "";
      cnt++;
      sum += String(raw).length;
    }
    return String(cnt) + ":" + String(sum);
  }

  function _getLastSigKey(scopeNorm) {
    return scopeNorm === "all" ? K_LAST_SIG_ALL : K_LAST_SIG_DB;
  }

  function _uniq(arr) {
    var out = [];
    var m = {};
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
        if (_isProjectDataKeyLocal(baseKey)) keys.push(baseKey);
      }
    }
    return _uniq(keys);
  }

  function _readLocalCompat(baseKey, ownerId) {
    var v = window.JKHStore ? window.JKHStore.getRaw(baseKey, ownerId) : null;
    return (v === null || v === undefined) ? "" : String(v);
  }

  function _writeLocalCompat(baseKey, value, ownerId) {
    var v = (value === null || value === undefined) ? "" : String(value);
    if (window.JKHStore) window.JKHStore.setRaw(baseKey, v, ownerId);
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
    // ✅ ПИНГ через store_dump (единый канон)
    var res = await _apiGet("/api/store_dump");

    if (res.okHttp && res.data && res.data.ok === true) {
      _setStatus({ server: "🟢 подключён", lastError: null });
      return true;
    }

    _setStatus({
      server: "🟡 нет ответа",
      lastError: (res.data && res.data.error)
        ? res.data.error
        : ("HTTP " + res.status)
    });

    return false;

  } catch (e) {
    _setStatus({
      server: "🔴 ошибка сети",
      lastError: String(e && e.message ? e.message : e)
    });
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
      _setStatus({ lastSaveAt: _nowISO(), lastAction: "✅ Сохранено на сервер", lastError: null, ownerId: ownerId, loadSource: "server" });
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
    // ✅ ЕДИНСТВЕННЫЙ источник — store_dump
    var resDump = await _apiGet("/api/store_dump");

    if (!(resDump.okHttp && resDump.data && resDump.data.ok === true)) {
      _setStatus({
        lastAction: "Ошибка загрузки",
        lastError: (resDump.data && resDump.data.error)
          ? resDump.data.error
          : ("HTTP " + resDump.status)
      });
      return false;
    }

    var data = resDump.data.data || {};
    var keys = Object.keys(data);

    for (var i = 0; i < keys.length; i++) {
      var baseKey = keys[i];

      // только проектные ключи
      if (!_isProjectDataKeyLocal(baseKey)) continue;

      var val = data[baseKey] || "";

      try {
        _writeLocalCompat(baseKey, val, ownerId);

        console.info(
          "[JKH sync][load] owner=%s key=%s size=%s status=ok",
          ownerId,
          baseKey,
          String(val || "").length
        );

      } catch (eWrite) {
        var code = String((eWrite && eWrite.message) || eWrite || "");

        if (code === "GLOBAL_ADMIN_ONLY") {
          console.info(
            "[JKH sync][load] owner=%s key=%s status=skip_global_readonly",
            ownerId,
            baseKey
          );
          continue;
        }

        throw eWrite;
      }
    }

    // пересчёт сигнатуры
    var sig = _sigForALL(ownerId);
    _lsSet(_getLastSigKey("all"), sig);

    _setStatus({
      lastAction: "✅ Загружено с сервера",
      lastError: null,
      ownerId: ownerId,
      loadSource: "server",
      lastReadAt: _nowISO()
    });

    return true;

  } catch (e) {
    _setStatus({
      lastAction: "Ошибка загрузки",
      lastError: String(e && e.message ? e.message : e)
    });
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

  async function migrateLegacyLocalOnce(ownerId) {
    return true;
  }

  async function autoLoadAfterLogin() {
    if (window.__JKH_AUTOLOAD_IN_PROGRESS === true && window.__JKH_AUTOLOAD_PROMISE) {
      return window.__JKH_AUTOLOAD_PROMISE;
    }
    // 🔒 HARD GUARD: защита от двойного запуска (усиленная)
    if (window.__JKH_AUTOLOAD_LOCK === true) {
      if (window.__JKH_AUTOLOAD_PROMISE) {
        return window.__JKH_AUTOLOAD_PROMISE;
      }
      // stale lock: сбрасываем и продолжаем, чтобы не блокировать init
      console.warn("[JKH] autoload stale lock detected, reset");
      window.__JKH_AUTOLOAD_LOCK = false;
    }
    window.__JKH_AUTOLOAD_LOCK = true;
    window.__JKH_AUTOLOAD_PROMISE = (async function () {
      window.__JKH_AUTOLOAD_IN_PROGRESS = true;
      try {
        if (!window.Auth || typeof Auth.getCurrentUser !== "function") return false;
        var user = Auth.getCurrentUser();
        if (!user || !user.id) return false;
        if (_isGuestOrAll()) return false;
        if (!isOnlineMode()) return false;

        var markerKey = "jkh_sync_autoload_done_v1";
        var expected = user.id + "|ok";
        var pageGateKey = "__JKH_AUTOLOAD_DONE::" + expected;
        if (window[pageGateKey] === true || window.__JKH_AUTOLOAD_DONE_FOR_USER === expected) {
          window.JKH_DATA_READY = true;
          _setStatus({ lastAction: "✅ Автозагрузка уже выполнена", lastError: null, ownerId: user.id, loadSource: "server:auto", lastReadAt: _nowISO() });
          return true;
        }

        var markerVal = "";
        try { markerVal = sessionStorage.getItem(markerKey) || ""; } catch (e0) { markerVal = ""; }
        if (markerVal === expected) {
          window[pageGateKey] = true;
          window.__JKH_AUTOLOAD_DONE_FOR_USER = expected;
          window.JKH_DATA_READY = true;
          _setStatus({ lastAction: "✅ Автозагрузка уже выполнена", lastError: null, ownerId: user.id, loadSource: "server:auto", lastReadAt: _nowISO() });
          return true;
        }

        console.info("[JKH sync][login] userId=%s email=%s action=auto_load_start", user.id, String(user.email || ""));
        var resDump = await _apiGet("/api/store_dump");
        if (!(resDump.okHttp && resDump.data && resDump.data.ok === true)) {
          window.JKH_DATA_READY = false;
          _setStatus({ lastAction: "Автозагрузка не выполнена", lastError: (resDump.data && resDump.data.error) ? resDump.data.error : ("HTTP " + resDump.status) });
          return false;
        }

        var data = resDump.data.data || {};
        var keys = _uniq(Object.keys(data).concat(_projectKeysForScope("db", user.id)));
        for (var i = 0; i < keys.length; i++) {
          var bk = keys[i];
          if (!_isProjectDataKeyLocal(bk)) continue;
          var val = Object.prototype.hasOwnProperty.call(data, bk) ? data[bk] : "";
          try {
            _writeLocalCompat(bk, val || "", user.id);
            console.info("[JKH sync][load] owner=%s key=%s size=%s status=ok", user.id, bk, String(val || "").length);
          } catch (eWrite) {
            var code = String((eWrite && eWrite.message) || eWrite || "");
            if (code === "GLOBAL_ADMIN_ONLY") {
              console.info("[JKH sync][load] owner=%s key=%s status=skip_global_readonly", user.id, bk);
              continue;
            }
            throw eWrite;
          }
        }

        try { sessionStorage.setItem(markerKey, expected); } catch (e1) { _lsSet(markerKey, expected); }
        window[pageGateKey] = true;
        window.__JKH_AUTOLOAD_DONE_FOR_USER = expected;
        window.JKH_DATA_READY = true;
        _setStatus({ lastAction: "✅ Автозагрузка после входа завершена", lastError: null, ownerId: user.id, loadSource: "server:auto", lastReadAt: _nowISO() });
        console.info("[JKH sync][login] userId=%s email=%s action=auto_load_done keys=%s", user.id, String(user.email || ""), keys.length);
        return true;
      } catch (e) {
        window.JKH_DATA_READY = false;
        _setStatus({ lastAction: "Ошибка автозагрузки", lastError: String(e && e.message ? e.message : e) });
        return false;
      } finally {
        window.__JKH_AUTOLOAD_IN_PROGRESS = false;
        window.__JKH_AUTOLOAD_PROMISE = null;
        // 🔓 снимаем lock сразу после завершения, чтобы init не зависал в ложном блоке
        window.__JKH_AUTOLOAD_LOCK = false;
      }
    })();

    return window.__JKH_AUTOLOAD_PROMISE;
  }

  // стартуем таймер при загрузке страницы (если включён)
  try { _setStatus({ ownerId: _ownerId() }); _startTimer(); } catch (e) { }

  window.JKHRemoteSync = {
    // public
    pingServer: pingServer,
    uploadNow: uploadNow,
    downloadNow: downloadNow,
    applySettingsFromUI: applySettingsFromUI,
    getSettings: getSettings,
    refreshStatusUI: refreshStatusUI,
    autoLoadAfterLogin: autoLoadAfterLogin,
    projectKeyCanon: function () { return { exact: SYNC_CANON.exact.slice(), prefix: SYNC_CANON.prefix.slice() }; }
  };
     // 🔧 MANUAL RESET (для отладки и logout)
window.resetAutoLoadGate = function () {
  try {
    window.__JKH_AUTOLOAD_IN_PROGRESS = false;
    window.__JKH_AUTOLOAD_PROMISE = null;
    window.__JKH_AUTOLOAD_DONE_FOR_USER = null;
    window.__JKH_AUTOLOAD_LOCK = false;
    console.info("[JKH] autoload gate reset");
  } catch (e) {}
};
})();