/* ============================================================
   🔒 CRITICAL — НЕ ТРОГАТЬ (ПАПАЖКХ)
   Doc: docs/LOGIC_SPEC_v1.5.3.md  |  Date: 2026-01-27
   Эталон архива: jkh_site_full_v01.27.3.zip
   SHA256: 6b4254a9b3b74327fe2d2c48c34e3e446ba9ae4e3369c6c554a683bde7b6ceec

   1) Карточка абонента (UI) = ИСТОЧНИК ИСТИНЫ (source of truth).
      Любые отчёты/справки — производные и НЕ имеют права менять логику карточки.

   2) payments_<uid> — помесячный ledger (НЕ журнал событий).
      В одном месяце допускается несколько строк (начисление + оплаты).

   // CRITICAL:
   // payments_<uid> — основной формат хранения ledger
   // payments_<LS> — legacy (устаревший, только для совместимости)
   // новые записи должны использовать только UID

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
  var ENV_UNBOUND = "UNBOUND";

  function _normalizeEnvType(value) {
    var env = String(value || "").trim().toUpperCase();
    return (env === "LAB" || env === "PROD") ? env : "";
  }

  function setEnvType(value) {
    var env = _normalizeEnvType(value);
    if (!env) return false;
    window.JKH_ENV_TYPE = env;
    try { window.JKHBoot?.markReady?.("env"); } catch (e) {}
    return true;
  }

  function getEnvType() {
    return _normalizeEnvType(window.JKH_ENV_TYPE || "");
  }

  function normalizeOwnerId(owner) {
    var value = String(owner || "").trim();
    var upper = value.toUpperCase();
    if (upper.indexOf("LAB:") === 0) return value.slice(4).trim();
    if (upper.indexOf("PROD:") === 0) return value.slice(5).trim();
    return value;
  }

  window.unwrapRuntimeDb = window.unwrapRuntimeDb || function unwrapRuntimeDb(raw) {
    if (!raw) return null;
    try {
      var parsed = (typeof raw === "string") ? JSON.parse(raw) : raw;
      if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "value") && parsed.value) {
        return (typeof parsed.value === "string") ? JSON.parse(parsed.value) : parsed.value;
      }
      return parsed;
    } catch (e) {
      return null;
    }
  };

  function hasServerEnvType() {
    return !!getEnvType();
  }

  async function fetchEnvType() {
    if (hasServerEnvType()) return getEnvType();
    try {
      var r = await fetch("/api/env", { method: "GET", credentials: "include" });
      var data = await r.json();
      if (data && setEnvType(data.env_type || data.env || data.environment)) return getEnvType();
    } catch (e) {}
    return "";
  }

  function isHostedMode() {
    try {
      var p = String(window.location && window.location.protocol || "");
      return p === "http:" || p === "https:";
    } catch (e) {
      return true;
    }
  }

  function isExplicitOfflineMode() {
    try {
      return Storage.prototype.getItem.call(localStorage, "jkh_sync_mode_v1") === "offline";
    } catch (e) {
      return false;
    }
  }

  function allowLocalCacheReadBeforeServer() {
    return !isHostedMode() || isExplicitOfflineMode();
  }

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
      return normalizeOwnerId(v || u.id);
    } catch (e) { return null; }
  }

  function getActiveOwnerId() {
    var u = _getSessionUser();
    if (!u) return "guest";
    if (u.role === "admin") return _getAdminViewScope() || normalizeOwnerId(u.id);
    return normalizeOwnerId(u.id);
  }

  function isAllMode() {
    return getActiveOwnerId() === "ALL";
  }

  function isGuestMode() {
    return getActiveOwnerId() === "guest";
  }

  function scopePrefixFor(ownerId) {
    var env = getEnvType() || ENV_UNBOUND;
    return "jkhdb::" + env + "::" + normalizeOwnerId(ownerId || "guest") + "::";
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

  function hydrateGlobalReadCache(baseKey, value) {
    var key = String(baseKey || "");
    if (!isGlobalProjectKey(key)) {
      throw new Error("GLOBAL_READ_CACHE_KEY_REJECTED");
    }
    var v = (value === null || value === undefined) ? "" : String(value);
    _lsSetDirect(k(key, "GLOBAL"), v);
    return true;
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
    try {
      return Storage.prototype.setItem.call(localStorage, fullKey, value);
    } catch (e) {
      try { if (e && typeof e === "object" && !e.jkhStorageKey) e.jkhStorageKey = String(fullKey || ""); } catch (_) {}
      try { if (typeof window.__offlineOriginMarkLocalStorageError === "function") window.__offlineOriginMarkLocalStorageError(e, "storage._lsSetDirect"); } catch (_) {}
      throw e;
    }
  }
  function _lsRemoveDirect(fullKey) {
    return Storage.prototype.removeItem.call(localStorage, fullKey);
  }

  var __tariffServerReadDiagSeen = {};

  function _projectRawDiagnosticUid(baseKey) {
    var m = String(baseKey || "").match(/^payments_(uid_[a-z0-9][a-z0-9_-]*)$/i);
    return m ? m[1] : "";
  }

  function _logManualRecalcProjectRaw(payload) {
    try {
      console.log("[manual-recalc][project-raw]", Object.assign({
        stage: "",
        httpStatus: null,
        responseBody: null,
        exception: null,
        requestUrl: null,
        requestPayloadSize: null,
        storageKey: "",
        owner: normalizeOwnerId(payload && payload.owner || getActiveOwnerId()),
        uid: ""
      }, payload || {}));
    } catch (eProjectRawLog) {}
  }

  function _diagnoseTariffServerRead(baseKey, ownerId, localRaw) {
    try {
      var key = String(baseKey || "");
      var isRateKey = key === "refinancing_rates_normal_v1" || key === "refinancing_rates_moratorium_v1";
      if (key.indexOf("tariffs_") !== 0 && !isRateKey) return;
      var owner = normalizeOwnerId(ownerId || getActiveOwnerId());
      if (!owner || owner === "guest" || owner === "ALL") return;
      if (typeof fetch !== "function") return;
      var sig = owner + "|" + key;
      var now = Date.now ? Date.now() : (new Date()).getTime();
      if (__tariffServerReadDiagSeen[sig] && now - __tariffServerReadDiagSeen[sig] < 2000) return;
      __tariffServerReadDiagSeen[sig] = now;
      var localValue = (localRaw === null || localRaw === undefined) ? "" : String(localRaw);
      fetch("/api/store?key=" + encodeURIComponent(key) + "&client_owner_hint=" + encodeURIComponent(owner), { credentials: "include" })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (data) {
          var serverValue = data && Object.prototype.hasOwnProperty.call(data, "value") && data.value !== null && data.value !== undefined
            ? String(data.value)
            : "";
          var localExists = localValue !== "";
          var serverExists = !!(data && data.ok === true && serverValue !== "");
          console.log("[diagnose][tariff-server-read]", {
            source: "JKHStore.getRaw",
            ownerId: owner,
            key: key,
            requestedKey: key,
            localExists: localExists,
            serverExists: serverExists,
            serverOk: !!(data && data.ok === true),
            serverOwner: String(data && data.owner || ""),
            returnedKeysCount: serverValue !== "" ? 1 : 0,
            serverLength: serverValue.length,
            localLength: localValue.length,
            hasRefinancingRatesNormalV1: key === "refinancing_rates_normal_v1" && serverExists,
            hasRefinancingRatesMoratoriumV1: key === "refinancing_rates_moratorium_v1" && serverExists,
            localExistsFalseExpected: isRateKey && !localExists && serverExists,
            reason: isRateKey && !localExists && serverExists ? "diagnose_rates_server_ok_local_false_expected" : (isRateKey && !serverExists ? "diagnose_rates_backend_missing" : "diagnose_rates_backend_exists")
          });
        })
        .catch(function (e) {
          console.warn("[diagnose][tariff-server-read]", {
            source: "JKHStore.getRaw",
            ownerId: owner,
            key: key,
            requestedKey: key,
            localExists: localValue !== "",
            serverExists: null,
            serverOk: false,
            returnedKeysCount: 0,
            serverLength: 0,
            localLength: localValue.length,
            hasRefinancingRatesNormalV1: false,
            hasRefinancingRatesMoratoriumV1: false,
            localExistsFalseExpected: false,
            reason: isRateKey ? "diagnose_rates_backend_missing" : "SERVER_READ_EXCEPTION",
            error: String(e && e.message || e)
          });
        });
    } catch (eDiagTariffServerRead) {}
  }

  function getItem(key, ownerId) {
    var raw = _isProjectDataKey(key) ? _cacheGet(key, ownerId) : _lsGetDirect(k(key, ownerId));
    _diagnoseTariffServerRead(key, ownerId, raw);
    return raw;
  }

  function setItem(key, value, ownerId) {
    if (!_guardCalcPeriodWrite(key, ownerId, "setItem")) {
      _logManualRecalcProjectRaw({ stage:"storage.setItem.calcPeriodGuard", requestPayloadSize:String(value == null ? "" : value).length, storageKey:String(key || ""), owner:ownerId || getActiveOwnerId(), uid:_projectRawDiagnosticUid(key), exception:null });
      return false;
    }
    if (isGuestMode()) {
      _logManualRecalcProjectRaw({ stage:"storage.setItem.guestReadonly", requestPayloadSize:String(value == null ? "" : value).length, storageKey:String(key || ""), owner:ownerId || getActiveOwnerId(), uid:_projectRawDiagnosticUid(key), exception:"GUEST_READONLY" });
      throw new Error("GUEST_READONLY");
    }
    if (isAllMode()) {
      _logManualRecalcProjectRaw({ stage:"storage.setItem.allModeReadonly", requestPayloadSize:String(value == null ? "" : value).length, storageKey:String(key || ""), owner:ownerId || getActiveOwnerId(), uid:_projectRawDiagnosticUid(key), exception:"ALLMODE_READONLY" });
      throw new Error("ALLMODE_READONLY");
    }
    if (isGlobalProjectKey(key) && !_isAdmin()) {
      _logManualRecalcProjectRaw({ stage:"storage.setItem.globalAdminOnly", requestPayloadSize:String(value == null ? "" : value).length, storageKey:String(key || ""), owner:ownerId || getActiveOwnerId(), uid:_projectRawDiagnosticUid(key), exception:"GLOBAL_ADMIN_ONLY" });
      throw new Error("GLOBAL_ADMIN_ONLY");
    }
    if (_isProjectDataKey(key)) {
      try {
        _cacheSet(key, value, ownerId);
      } catch (eCacheSet) {
        _logManualRecalcProjectRaw({ stage:"storage._cacheSet.exception", requestPayloadSize:String(value == null ? "" : value).length, storageKey:String(key || ""), owner:ownerId || getActiveOwnerId(), uid:_projectRawDiagnosticUid(key), exception:eCacheSet });
        throw eCacheSet;
      }
      return;
    }
    try {
      _lsSetDirect(k(key, ownerId), value);
    } catch (eLsSet) {
      _logManualRecalcProjectRaw({ stage:"storage._lsSetDirect.exception", requestPayloadSize:String(value == null ? "" : value).length, storageKey:String(key || ""), owner:ownerId || getActiveOwnerId(), uid:_projectRawDiagnosticUid(key), exception:eLsSet });
      throw eLsSet;
    }
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
    getEnvType: getEnvType,
    normalizeOwnerId: normalizeOwnerId,
    hasServerEnvType: hasServerEnvType,
    setEnvType: setEnvType,
    fetchEnvType: fetchEnvType,
    allowLocalCacheReadBeforeServer: allowLocalCacheReadBeforeServer,
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
  var READ_LEGACY_KEYS = [
    "tariffs_dynamic_v1", // legacy read-only / migration only / excluded from upload
    "tariffs_content_repair_v1", // legacy read-only / migration only / excluded from upload
    "tariffs_content_repair_v1_backup" // legacy read-only / migration only / excluded from upload
  ];

  var SYNC_CANON_EXACT = [
    "abonents_db_v1",
    "abonent_notes_v1",
    "exclude_periods_v1",
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
    "card_snapshot_",
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



  function _isValidUid(uid) {
    var s = String(uid === null || uid === undefined ? "" : uid).trim();
    if (!s) return false;
    var low = s.toLowerCase();
    if (s === "..." || s === "-" || s === "0" || low === "null" || low === "undefined") return false;
    return /^uid_[a-z0-9][a-z0-9_-]*$/i.test(s);
  }

  var __invalidUidCanonicalBlockedSeen = {};
  var __invalidUidCanonicalBlockedSummary = { count: 0, keys: {}, scheduled: false };

  function _flushInvalidUidCanonicalBlockedSummary() {
    __invalidUidCanonicalBlockedSummary.scheduled = false;
    if (!__invalidUidCanonicalBlockedSummary.count) return;
    var keys = Object.keys(__invalidUidCanonicalBlockedSummary.keys);
    var payload = { count: __invalidUidCanonicalBlockedSummary.count, sampleKeys: keys.slice(0, 10) };
    __invalidUidCanonicalBlockedSummary.count = 0;
    __invalidUidCanonicalBlockedSummary.keys = {};
    try { console.warn("[uid][canonical-blocked-invalid-summary]", payload); } catch (e) {}
  }

  function _warnInvalidUidCanonicalBlocked(payload) {
    payload = payload || {};
    var key = String(payload.key || "");
    var source = String(payload.source || "");
    var isCalcPeriod = key.indexOf("calc_period_") === 0 || source.indexOf("calc-period") >= 0 || source === "upload" || source === "server-dump";
    var sig = [key, String(payload.suffix || ""), String(payload.uid || ""), String(payload.abonentId || ""), source].join("|");
    if (__invalidUidCanonicalBlockedSeen[sig]) {
      __invalidUidCanonicalBlockedSummary.count++;
      if (key) __invalidUidCanonicalBlockedSummary.keys[key] = true;
      if (!__invalidUidCanonicalBlockedSummary.scheduled) {
        __invalidUidCanonicalBlockedSummary.scheduled = true;
        try { setTimeout(_flushInvalidUidCanonicalBlockedSummary, 0); } catch (eTimer) { _flushInvalidUidCanonicalBlockedSummary(); }
      }
      return;
    }
    __invalidUidCanonicalBlockedSeen[sig] = true;
    if (isCalcPeriod) {
      __invalidUidCanonicalBlockedSummary.count++;
      if (key) __invalidUidCanonicalBlockedSummary.keys[key] = true;
      if (!__invalidUidCanonicalBlockedSummary.scheduled) {
        __invalidUidCanonicalBlockedSummary.scheduled = true;
        try { setTimeout(_flushInvalidUidCanonicalBlockedSummary, 0); } catch (eCalcTimer) { _flushInvalidUidCanonicalBlockedSummary(); }
      }
      return;
    }
    try { console.warn("[uid][canonical-blocked-invalid]", payload || {}); } catch (e) {}
  }

  function _calcPeriodKeyInfo(baseKey) {
    var key = String(baseKey || "");
    if (key.indexOf("calc_period_active_") === 0) {
      return { prefix: "calc_period_active_", suffix: String(key.slice("calc_period_active_".length) || "").trim() };
    }
    if (key.indexOf("calc_period_") === 0) {
      return { prefix: "calc_period_", suffix: String(key.slice("calc_period_".length) || "").trim() };
    }
    return null;
  }

  function _calcPeriodUidSet(ownerId) {
    var out = {};
    try {
      var raw = _lsGetDirect(k("abonents_db_v1", ownerId));
      if (!raw) return out;
      var db = JSON.parse(raw);
      var abonents = (db && db.abonents && typeof db.abonents === "object") ? db.abonents : {};
      var ids = Object.keys(abonents);
      for (var i = 0; i < ids.length; i++) {
        var uid = String(abonents[ids[i]] && abonents[ids[i]].uid || "").trim();
        if (_isValidUid(uid)) out[uid] = true;
      }
    } catch (e) {}
    return out;
  }

  function _calcPeriodKeyAllowed(baseKey, ownerId) {
    var info = _calcPeriodKeyInfo(baseKey);
    if (!info) return true;
    var suffix = info.suffix;
    if (!suffix) return false;

    var uidSet = _calcPeriodUidSet(ownerId);
    var uidKeys = Object.keys(uidSet);
    if (uidKeys.length > 0) return !!uidSet[suffix];

    if (!_isValidUid(suffix)) {
      _warnInvalidUidCanonicalBlocked({ key: String(baseKey || ""), suffix: suffix, ownerId: String(ownerId || getActiveOwnerId()), source: "calc-period-write-guard" });
      return false;
    }

    return true;
  }

  function _guardCalcPeriodWrite(baseKey, ownerId, source) {
    var info = _calcPeriodKeyInfo(baseKey);
    if (!info) return true;
    if (_calcPeriodKeyAllowed(baseKey, ownerId)) return true;
    _warnInvalidUidCanonicalBlocked({
      key: String(baseKey || ""),
      suffix: info.suffix,
      ownerId: String(ownerId || getActiveOwnerId()),
      source: String(source || "storage")
    });
    return false;
  }

  function _isScopedKeyName(x) {
    return String(x || "").indexOf("jkhdb::") === 0;
  }
  function _isProjectDataKey(baseKey) {
  var kx = String(baseKey || "");
  if (!kx || _isScopedKeyName(kx)) return false;

  if (kx.indexOf("tariffs_") === 0) return true;
  if (kx.indexOf("ref_rates_") === 0) return true;

  for (var i = 0; i < SYNC_CANON_EXACT.length; i++) {
    if (kx === SYNC_CANON_EXACT[i]) return true;
  }
  for (var j = 0; j < SYNC_CANON_PREFIX.length; j++) {
    if (kx.indexOf(SYNC_CANON_PREFIX[j]) === 0) return true;
  }
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

  function _defaultUIState() {
    return {
      auth: {
        status: "unknown",
        userId: null,
        email: "",
        role: "guest"
      },
      server: {
        status: "unknown",
        checkedAt: "",
        message: ""
      },
      data: {
        status: "idle",
        loadedAt: "",
        source: "none",
        message: ""
      }
    };
  }

  function _ensureUIState() {
    var def = _defaultUIState();
    var st = window.JKH_UI_STATE;
    if (!st || typeof st !== "object") {
      window.JKH_UI_STATE = def;
      return window.JKH_UI_STATE;
    }
    st.auth = Object.assign({}, def.auth, (st.auth && typeof st.auth === "object") ? st.auth : {});
    st.server = Object.assign({}, def.server, (st.server && typeof st.server === "object") ? st.server : {});
    st.data = Object.assign({}, def.data, (st.data && typeof st.data === "object") ? st.data : {});
    window.JKH_UI_STATE = st;
    return st;
  }

  function _emitUIStateChanged(st) {
    try {
      if (typeof window.CustomEvent === "function") {
        window.dispatchEvent(new CustomEvent("JKH_UI_STATE_CHANGED", { detail: st }));
      } else {
        var ev = document.createEvent("Event");
        ev.initEvent("JKH_UI_STATE_CHANGED", false, false);
        ev.detail = st;
        window.dispatchEvent(ev);
      }
    } catch (e) {}
  }

  function _uiStateTraceFrame(stack) {
    var lines = String(stack || "").split("\n");
    for (var i = 1; i < lines.length; i++) {
      var line = String(lines[i] || "").trim();
      if (!line) continue;
      if (line.indexOf("_uiStateTraceFrame") >= 0) continue;
      if (line.indexOf("_traceUIStateChange") >= 0) continue;
      if (line.indexOf("_setUIState") >= 0) continue;
      return line;
    }
    return "";
  }

  function _traceUIStateChange(moduleName, before, after, patch, stack) {
    try {
      before = before || {};
      after = after || {};
      var beforeServer = before.server || {};
      var beforeData = before.data || {};
      var afterServer = after.server || {};
      var afterData = after.data || {};
      var patchServer = patch && patch.server && typeof patch.server === "object" ? patch.server : {};
      var patchData = patch && patch.data && typeof patch.data === "object" ? patch.data : {};
      var serverChanged = String(beforeServer.status || "") !== String(afterServer.status || "");
      var dataChanged = String(beforeData.status || "") !== String(afterData.status || "");
      var sourceChanged = String(beforeData.source || "") !== String(afterData.source || "");
      var messageChanged = String(beforeData.message || "") !== String(afterData.message || "");
      var setsOffline = String(afterServer.status || "") === "offline" || String(afterData.status || "") === "offline";
      if (!serverChanged && !dataChanged && !sourceChanged && !messageChanged && !setsOffline) return;
      var stackLines = String(stack || "").split("\n").slice(1, 9).map(function(line) { return String(line || "").trim(); }).filter(Boolean);
      console.log("[ui-state][transition]", {
        reason: setsOffline ? "ui_state_offline_transition" : "ui_state_transition",
        module: moduleName,
        caller: _uiStateTraceFrame(stack),
        serverBefore: String(beforeServer.status || ""),
        serverAfter: String(afterServer.status || ""),
        dataBefore: String(beforeData.status || ""),
        dataAfter: String(afterData.status || ""),
        sourceBefore: String(beforeData.source || ""),
        sourceAfter: String(afterData.source || ""),
        patchServerStatus: String(patchServer.status || ""),
        patchDataStatus: String(patchData.status || ""),
        patchDataSource: String(patchData.source || ""),
        message: String((patchData.message || patchServer.message || afterData.message || afterServer.message || "")).slice(0, 240),
        stack: stackLines
      });
    } catch (eTrace) {}
  }

  function _isPreservedServerDataState(dataState) {
    var status = String(dataState && dataState.status || "");
    var source = String(dataState && dataState.source || "");
    return source === "server" && (status === "ready" || status === "empty");
  }

  function _serverDataStateSnapshotIfPreserved() {
    var st = _ensureUIState();
    return _isPreservedServerDataState(st && st.data) ? Object.assign({}, st.data) : null;
  }

  function _serverConnectivityFailureUIStatePatch(serverPatch, offlineDataPatch, preservedDataState, diagnosticReason) {
    var preserved = preservedDataState && _isPreservedServerDataState(preservedDataState) ? Object.assign({}, preservedDataState) : _serverDataStateSnapshotIfPreserved();
    if (preserved) {
      try {
        console.warn("[ui-state][data-preserved]", {
          reason: diagnosticReason || "server_offline_data_state_preserved",
          serverStatus: String(serverPatch && serverPatch.status || ""),
          dataStatus: String(preserved.status || ""),
          dataSource: String(preserved.source || ""),
          message: String(serverPatch && serverPatch.message || "")
        });
      } catch (ePreserveLog) {}
      return { server: serverPatch, data: preserved };
    }
    try {
      console.warn("[ui-state][data-preserved]", {
        reason: "initial_server_load_failed_no_hydrated_data",
        serverStatus: String(serverPatch && serverPatch.status || ""),
        dataStatus: String(offlineDataPatch && offlineDataPatch.status || ""),
        dataSource: String(offlineDataPatch && offlineDataPatch.source || ""),
        message: String(serverPatch && serverPatch.message || "")
      });
    } catch (eInitialFailLog) {}
    return { server: serverPatch, data: offlineDataPatch };
  }

  function _setUIState(patch) {
    patch = patch || {};
    var st = _ensureUIState();
    var before = {
      server: Object.assign({}, st.server || {}),
      data: Object.assign({}, st.data || {})
    };
    var stack = "";
    try { stack = (new Error()).stack || ""; } catch (eStack) {}
    if (patch.auth && typeof patch.auth === "object") st.auth = Object.assign({}, st.auth, patch.auth);
    if (patch.server && typeof patch.server === "object") st.server = Object.assign({}, st.server, patch.server);
    if (patch.data && typeof patch.data === "object") st.data = Object.assign({}, st.data, patch.data);
    try {
      if (typeof window.__offlineOriginRecordTransition === "function") {
        window.__offlineOriginRecordTransition({
          module: "storage",
          setter: "storage._setUIState",
          stack: stack,
          reason: String(patch.reason || patch.data && patch.data.message || patch.server && patch.server.message || ""),
          previousDataStatus: String(before.data && before.data.status || ""),
          newDataStatus: String(st.data && st.data.status || ""),
          previousDataSource: String(before.data && before.data.source || ""),
          newDataSource: String(st.data && st.data.source || ""),
          previousServerStatus: String(before.server && before.server.status || ""),
          newServerStatus: String(st.server && st.server.status || "")
        });
      }
    } catch(eOfflineOrigin) {}
    try {
      if (typeof window.__recordReadinessWrite === "function") {
        var readinessStack = String(stack || "").split("\n").slice(1, 6).map(function(line){ return String(line || "").trim(); });
        var readinessCallerFrame = readinessStack.filter(function(line){ return line.indexOf("_setUIState") < 0; })[0] || "";
        var readinessLocation = readinessCallerFrame.match(/(?:\(|@)([^()]+:\d+:\d+)\)?$/) || readinessCallerFrame.match(/([^ ]+:\d+:\d+)$/);
        var readinessCaller = readinessCallerFrame.replace(/^at\s+/, "").split(/\s+\(|@/)[0] || "";
        window.__recordReadinessWrite({
          previousUiStatus: String(before.data && before.data.status || ""),
          newUiStatus: String(st.data && st.data.status || ""),
          previousServerStatus: String(before.server && before.server.status || ""),
          newServerStatus: String(st.server && st.server.status || ""),
          caller: readinessCaller,
          function: "storage._setUIState",
          line: readinessLocation ? String(readinessLocation[1] || "") : "",
          reason: String(patch.reason || patch.data && patch.data.message || patch.server && patch.server.message || (
            "ui:" + String(before.data && before.data.status || "") + "->" + String(st.data && st.data.status || "")
            + ";server:" + String(before.server && before.server.status || "") + "->" + String(st.server && st.server.status || "")
          )),
          stack: readinessStack
        });
      }
    } catch(eReadinessWrite) {}
    _traceUIStateChange("storage", before, st, patch, stack);
    _emitUIStateChanged(st);
    return st;
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

  function _baseKeyFromScopedForOwner(scopedKey, ownerId) {
    var full = String(scopedKey || "");
    var pref = scopePrefixFor(ownerId || getActiveOwnerId());
    if (pref && full.indexOf(pref) === 0) return full.slice(pref.length);
    return "";
  }

  function _adminGetItemForOwner(ownerId, baseKey) {
    var u = _getSessionUser();
    if (!u || u.role !== "admin") throw new Error("ADMIN_ONLY");
    var oid = String(ownerId || "");
    if (!oid) throw new Error("OWNER_REQUIRED");
    return _lsGetDirect(k(baseKey, oid));
  }

  function _adminSetItemForOwner(ownerId, baseKey, value) {
    if (!_guardCalcPeriodWrite(baseKey, ownerId, "admin.setRawForOwner")) return false;
    var u = _getSessionUser();
    if (!u || u.role !== "admin") throw new Error("ADMIN_ONLY");
    var oid = String(ownerId || "");
    if (!oid) throw new Error("OWNER_REQUIRED");
    _lsSetDirect(k(baseKey, oid), String(value));
  }

  window.JKHStore = {
    // identity/scope
    getOwnerId: function () { return getActiveOwnerId(); },
    getEnvType: getEnvType,
    normalizeOwnerId: normalizeOwnerId,
    hasServerEnvType: hasServerEnvType,
    setEnvType: setEnvType,
    fetchEnvType: fetchEnvType,
    allowLocalCacheReadBeforeServer: allowLocalCacheReadBeforeServer,
    key: k,
    isGuestMode: isGuestMode,
    isAllMode: isAllMode,
    scopePrefixFor: scopePrefixFor,

    // raw scoped
    getRaw: function (baseKey, ownerId) { return getItem(baseKey, ownerId); },
    setRaw: function (baseKey, value, ownerId) { return setItem(baseKey, value, ownerId); },
    removeRaw: function (baseKey, ownerId) { return removeItem(baseKey, ownerId); },
    hydrateGlobalReadCache: hydrateGlobalReadCache,

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

  try {
    window.__JKHSTORE_INSTANCE_ID = window.__JKHSTORE_INSTANCE_ID || (
      window.crypto && typeof window.crypto.randomUUID === "function"
        ? window.crypto.randomUUID()
        : ("jkhstore_" + Date.now() + "_" + Math.random().toString(36).slice(2))
    );
    console.log("[diagnose][store-instance]", {
      instanceId: window.__JKHSTORE_INSTANCE_ID,
      sameObject: window.JKHStore === JKHStore
    });
  } catch (eStoreInstanceDiag) {}

  window.JKHBoot?.markReady?.('storage');

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
          var strictBaseKey = String(key || "");
          var strictOwnerId;
          if (_isScopedKeyName(strictBaseKey)) {
            var strictParts = strictBaseKey.split("::");
            strictOwnerId = strictParts.length >= 3 ? strictParts[1] : undefined;
            strictBaseKey = strictParts.length >= 3 ? strictParts.slice(2).join("::") : strictBaseKey;
          } else {
            var strictPrefix = scopePrefixFor(getActiveOwnerId());
            if (strictBaseKey.indexOf(strictPrefix) === 0) strictBaseKey = strictBaseKey.slice(strictPrefix.length);
          }
          if (_isProjectDataKey(strictBaseKey) && !_guardCalcPeriodWrite(strictBaseKey, strictOwnerId, "Storage.prototype.setItem")) return undefined;
        } catch (e0) {}
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
  function _isDevMode() {
    try {
      if (window && window.__JKH_DEV_MODE) return true;
      var h = String(window.location && window.location.hostname || "");
      var p = String(window.location && window.location.protocol || "");
      return p === "file:" || h === "localhost" || h === "127.0.0.1";
    } catch (e) { return false; }
  }

  function _ownerId() {
    if (!window.JKHStore) return "guest";
    return normalizeOwnerId(window.JKHStore.getOwnerId());
  }

  function _isGuestOrAll() {
    if (!window.JKHStore) return true;
    return window.JKHStore.isGuestMode() || window.JKHStore.isAllMode();
  }
    function _isGuestUser() {
    try {
      return !!(window.Auth && typeof Auth.isGuest === "function" && Auth.isGuest());
    } catch (e) {
      return true;
    }
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
    try { Storage.prototype.setItem.call(localStorage, key, String(val)); } catch (e) {
      try { if (typeof window.__offlineOriginMarkLocalStorageError === "function") window.__offlineOriginMarkLocalStorageError(e, "storage._lsSet"); } catch (_) {}
    }
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

  if (kx.indexOf("tariffs_") === 0) return true;
  if (kx.indexOf("ref_rates_") === 0) return true;

  for (var i = 0; i < SYNC_CANON.exact.length; i++) {
    if (kx === SYNC_CANON.exact[i]) return true;
  }
  for (var j = 0; j < SYNC_CANON.prefix.length; j++) {
    if (kx.indexOf(SYNC_CANON.prefix[j]) === 0) return true;
  }
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
      var uid = String(abonents[id] && abonents[id].uid || "").trim();
      if (_isValidUid(uid)) {
        out.push("calc_period_" + uid);
        out.push("calc_period_active_" + uid);
      }
      out.push("report_period_" + id);
      out.push("payments_ui_collapsed_" + id);
      out.push("jkh_transfer_to_v1:" + id);
      out.push("jkh_freeze_to_v1:" + id);
      out.push("moratorium_" + id);
    }
    return out;
  }

  function _isLegacyUploadBlockedKey(baseKey) {
    return READ_LEGACY_KEYS.indexOf(String(baseKey || "")) >= 0;
  }



  function _isUploadAllowedKey(baseKey, ownerId) {
    var key = String(baseKey || "");
    var oid = String(ownerId || "").trim();

    var exact = [
      "abonents_db_v1",
      "abonent_notes_v1",
      "exclude_periods_v1",
      "organization_requisites_v1",
      "organization_signers_v1",
      "payment_sources_v1",
      "last_abonent_id",
      "import_preview_v1",
      "draft_new_abonent_v1",
      "jkh_excel_date_debug"
    ];

    if (exact.indexOf(key) >= 0) return true;

    if (_calcPeriodKeyInfo(key)) return _guardCalcPeriodWrite(key, ownerId, "upload");

    var prefixes = [
      "payments_",
      "exclude_periods_",
      "note_",
      "calc_period_",
      "calc_period_active_",
      "report_period_",
      "card_snapshot_",
      "payments_ui_collapsed_",
      "jkh_transfer_to_v1:",
      "jkh_transfer_balance_v1:",
      "jkh_freeze_to_v1:",
      "jkh_frozen_debt_v1:",
      "moratorium_"
    ];

    for (var i = 0; i < prefixes.length; i++) {
      if (key.indexOf(prefixes[i]) === 0) return true;
    }

    if (oid && key === ("tariffs_" + oid)) return true;

    return false;
  }
  function _isAdminUploadBlockedKey(baseKey) {
    var key = String(baseKey || "");
    return key === "refinancing_rates_normal_v1" || key === "refinancing_rates_moratorium_v1";
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
    var uniq = _uniq(keys);
    var filtered = [];
    for (var j = 0; j < uniq.length; j++) {
      var key = String(uniq[j] || "");
      if (_isLegacyUploadBlockedKey(key)) {
        console.warn("[JKH sync][skip-legacy-upload]", key);
        continue;
      }
      if (_isAdminUploadBlockedKey(key)) {
        console.warn("[JKH sync][skip-admin-upload]", key);
        continue;
      }
      filtered.push(key);
    }

    var skippedCalcPeriodUpload = 0;
    filtered = filtered.filter(function (key) {
      if (_isUploadAllowedKey(key, ownerId)) return true;
      if (_calcPeriodKeyInfo(key)) {
        skippedCalcPeriodUpload++;
        return false;
      }
      console.warn("[JKH sync][skip-upload-not-allowed]", key);
      return false;
    });
    if (skippedCalcPeriodUpload > 0) {
      try { console.warn("[JKH sync][skip-upload-not-allowed-summary]", { calcPeriodLegacy: skippedCalcPeriodUpload, ownerId: String(ownerId || "") }); } catch (eSkipSummary) {}
    }

    return filtered;
  }

  function _readLocalCompat(baseKey, ownerId) {
    var v = window.JKHStore ? window.JKHStore.getRaw(baseKey, ownerId) : null;
    return (v === null || v === undefined) ? "" : String(v);
  }

  function _serializeServerDumpValue(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "object") {
      try { return JSON.stringify(value); } catch (e) {}
    }
    return String(value);
  }

  function _writeLocalCompat(baseKey, value, ownerId) {
    var v = (value === null || value === undefined) ? "" : String(value);
    if (window.JKHStore) window.JKHStore.setRaw(baseKey, v, ownerId);
  }

  // CRITICAL: server dump is trusted read-path.
  // GLOBAL keys (refinancing rates) must be cached locally for every logged-in user,
  // even though users are not allowed to write those keys manually.
  // This bypass is used ONLY while applying data received from /api/store_dump.
  function _writeServerDumpLocalCompat(baseKey, value, ownerId) {
    var kx = String(baseKey || "");
    var v = _serializeServerDumpValue(value);
    if (!window.JKHStore) return;
    if (isGlobalProjectKey(kx)) {
      _lsSetDirect(k(kx, "GLOBAL"), v);
      return;
    }
    _lsSetDirect(k(kx, ownerId), v);
  }

  function _projectKeysFromDump(dumpObj) {
    var out = [];
    if (!dumpObj || typeof dumpObj !== "object" || Array.isArray(dumpObj)) return out;
    var all = Object.keys(dumpObj);
    for (var i = 0; i < all.length; i++) {
      var baseKey = String(all[i] || "");
      if (_isProjectDataKeyLocal(baseKey)) out.push(baseKey);
    }
    return _uniq(out);
  }

  function _clearOwnerProjectScope(ownerId) {
    if (!window.JKHStore) return 0;
    var pref = window.JKHStore.scopePrefixFor(ownerId) || "";
    var scoped = window.JKHStore.keysForOwner(ownerId) || [];
    var removed = 0;
    for (var i = 0; i < scoped.length; i++) {
      var sk = String(scoped[i] || "");
      if (!sk) continue;
      var baseKey = sk.indexOf(pref) === 0 ? sk.slice(pref.length) : sk;
      if (!_isProjectDataKeyLocal(baseKey)) continue;
      try { window.JKHStore.removeRaw(baseKey, ownerId); removed++; } catch (e) {}
    }
    return removed;
  }

  function _clearAllProjectScopes() {
    var removed = 0;
    var envPrefix = "jkhdb::" + (getEnvType() || ENV_UNBOUND) + "::";
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var full = String(localStorage.key(i) || "");
      if (full.indexOf(envPrefix) !== 0) continue;
      var p = full.indexOf("::", envPrefix.length);
      if (p < 0) continue;
      var baseKey = full.slice(p + 2);
      if (!_isProjectDataKeyLocal(baseKey)) continue;
      try { _lsRemoveDirect(full); removed++; } catch (e) {}
    }
    return removed;
  }


  function _currentAbonentIdFromLocation() {
    try {
      var params = new URLSearchParams(window.location && window.location.search || "");
      return String(params.get("abonent") || "").trim();
    } catch (e) {
      return "";
    }
  }

  function _calcPeriodAllowedLegacyAliasesForCurrentAbonent(abonents) {
    var currentId = _currentAbonentIdFromLocation();
    var out = { hasScope: false, aliases: {}, uid: "", abonentId: currentId };
    if (!currentId || !abonents || !abonents[currentId]) return out;
    var a = abonents[currentId] || {};
    var uid = String(a.uid || "").trim();
    out.hasScope = true;
    out.uid = uid;
    [currentId, a.id, a.ls, a.account, a.accountNumber, a.personalAccount, a.regnum, a.premiseRegnum, uid].forEach(function (v) {
      var s = String(v || "").trim();
      if (s) out.aliases[s] = true;
    });
    return out;
  }

  function _normalizeCalcPeriodKeysInDump(dumpObj, ownerId) {
    if (!dumpObj || typeof dumpObj !== "object" || Array.isArray(dumpObj)) return dumpObj;
    var rawDb = Object.prototype.hasOwnProperty.call(dumpObj, KEY_DB) ? dumpObj[KEY_DB] : _readLocalCompat(KEY_DB, ownerId);
    var db = null;
    try { db = rawDb ? JSON.parse(String(rawDb)) : null; } catch (e) { db = null; }
    var abonents = (db && db.abonents && typeof db.abonents === "object") ? db.abonents : {};
    var aliases = {};
    var uidSet = {};
    Object.keys(abonents).forEach(function (id) {
      var a = abonents[id] || {};
      var uid = String(a.uid || "").trim();
      if (!_isValidUid(uid)) {
        if (uid) _warnInvalidUidCanonicalBlocked({ abonentId: String(id || ""), uid: uid, ownerId: String(ownerId || ""), source: "server-dump" });
        return;
      }
      uidSet[uid] = true;
      aliases[String(id || "").trim()] = uid;
      [a.id, a.ls, a.account, a.accountNumber, a.personalAccount, a.regnum, a.premiseRegnum].forEach(function (v) {
        var s = String(v || "").trim();
        if (s) aliases[s] = uid;
      });
    });

    var scoped = _calcPeriodAllowedLegacyAliasesForCurrentAbonent(abonents);
    var summary = { migrated: 0, kept: 0, skippedForeign: 0 };

    Object.keys(dumpObj).forEach(function (key) {
      var info = _calcPeriodKeyInfo(key);
      if (!info) return;
      if (uidSet[info.suffix]) return;

      if (scoped.hasScope && !scoped.aliases[info.suffix]) {
        summary.skippedForeign++;
        return;
      }

      if (!_isValidUid(info.suffix) && !aliases[info.suffix]) {
        summary.kept++;
        return;
      }

      var uid = aliases[info.suffix];
      if (uid && _isValidUid(uid)) {
        var canonicalKey = info.prefix + uid;
        if (!Object.prototype.hasOwnProperty.call(dumpObj, canonicalKey)) dumpObj[canonicalKey] = dumpObj[key];
        var readBackMatches = Object.prototype.hasOwnProperty.call(dumpObj, canonicalKey) && dumpObj[canonicalKey] === dumpObj[key];
        if (readBackMatches) {
          delete dumpObj[key];
          summary.migrated++;
        } else {
          summary.kept++;
        }
      } else {
        summary.kept++;
      }
    });

    try { console.warn("[calc-period][legacy-summary]", summary); } catch (eSummary) {}
    return dumpObj;
  }


  function _replaceOwnerProjectScopeFromDump(ownerId, dumpObj) {
    if (!window.JKHStore) return { removed: 0, written: 0, invalidAbonentsDb: false, serverDbEmpty: true };
    if (dumpObj && typeof dumpObj === "object" && !Array.isArray(dumpObj) && Object.prototype.hasOwnProperty.call(dumpObj, KEY_DB)) {
      dumpObj[KEY_DB] = _serializeServerDumpValue(dumpObj[KEY_DB]);
    }
    dumpObj = _normalizeCalcPeriodKeysInDump(dumpObj, ownerId);
    var dumpKeys = _projectKeysFromDump(dumpObj);
    var hasServerDbKey = Object.prototype.hasOwnProperty.call(dumpObj || {}, KEY_DB);
    var serverRawDb = hasServerDbKey ? _serializeServerDumpValue(dumpObj[KEY_DB]) : "";
    var serverDbValid = hasServerDbKey && _validateAbonentsDbRaw(serverRawDb);
    var serverDbEmpty = !serverDbValid || _isDbEffectivelyEmpty(serverRawDb);
    var keep = {};
    var i;
    for (i = 0; i < dumpKeys.length; i++) keep[dumpKeys[i]] = true;

    var pref = window.JKHStore.scopePrefixFor(ownerId) || "";
    var scoped = window.JKHStore.keysForOwner(ownerId) || [];
    function _cardSnapshotBaseKeysFromScoped(keys) {
      var out = [];
      for (var ci = 0; ci < (keys || []).length; ci++) {
        var csk = String(keys[ci] || "");
        if (!csk) continue;
        var cbase = csk.indexOf(pref) === 0 ? csk.slice(pref.length) : csk;
        if (cbase.indexOf("card_snapshot_") === 0) out.push(cbase);
      }
      return out;
    }
    var dumpCardSnapshotKeys = [];
    for (i = 0; i < dumpKeys.length; i++) {
      if (String(dumpKeys[i] || "").indexOf("card_snapshot_") === 0) dumpCardSnapshotKeys.push(dumpKeys[i]);
    }
    try {
      console.log("[store-dump][card-snapshot-dump-check]", {
        ownerId: ownerId,
        dumpHasCardSnapshots: dumpCardSnapshotKeys.length > 0,
        dumpCardSnapshotKeys: dumpCardSnapshotKeys,
        localCardSnapshotKeysBefore: _cardSnapshotBaseKeysFromScoped(scoped)
      });
    } catch (eDumpCheck) {}
    var removed = 0;
    for (i = 0; i < scoped.length; i++) {
      var sk = String(scoped[i] || "");
      if (!sk) continue;
      var baseKey = sk.indexOf(pref) === 0 ? sk.slice(pref.length) : sk;
      if (!_isProjectDataKeyLocal(baseKey)) continue;
      if (keep[baseKey]) continue;
      if (baseKey.indexOf("tariffs_") === 0) {
        var tariffRawBeforeRemove = _readLocalCompat(baseKey, ownerId);
        if (baseKey === ("tariffs_" + String(ownerId || "").trim()) && tariffRawBeforeRemove !== "") {
          try {
            console.warn("[tariffs][preserve-local-canonical]", {
              ownerId: ownerId,
              key: baseKey,
              localLength: tariffRawBeforeRemove.length,
              reason: "missing-in-server-dump"
            });
          } catch (eTariffPreserveLog) {}
          continue;
        }
        try {
          console.warn("[diagnose][tariffs-storage]", {
            source: "storage:dump-remove-local",
            ownerId: ownerId,
            canonicalKey: baseKey,
            canonicalExists: tariffRawBeforeRemove !== "",
            canonicalLength: tariffRawBeforeRemove.length,
            legacyExists: _readLocalCompat("tariffs_content_repair_v1", ownerId) !== "",
            legacyLength: _readLocalCompat("tariffs_content_repair_v1", ownerId).length,
            serverValueExists: false,
            localValueExists: tariffRawBeforeRemove !== ""
          });
        } catch (eTariffRemoveLog) {}
      }
      if (!serverDbEmpty && baseKey.indexOf("card_snapshot_") === 0) {
        try {
          console.log("[store-dump][preserve-local-card-snapshot]", {
            ownerId: ownerId,
            key: baseKey
          });
        } catch (ePreserve) {}
        continue;
      }
      try {
        window.JKHStore.removeRaw(baseKey, ownerId);
        removed++;
      } catch (eRem) {}
    }
    try {
      console.log("[store-dump][card-snapshot-local-after]", {
        ownerId: ownerId,
        localCardSnapshotKeysAfter: _cardSnapshotBaseKeysFromScoped(window.JKHStore.keysForOwner(ownerId) || [])
      });
    } catch (eAfter) {}

    var written = 0;
    var invalidAbonentsDb = false;
    for (i = 0; i < dumpKeys.length; i++) {
      var kx = dumpKeys[i];
      var val = dumpObj[kx];
      if (kx === KEY_DB) {
        var rawDb = _serializeServerDumpValue(val);
        if (!_validateAbonentsDbRaw(rawDb)) {
          invalidAbonentsDb = true;
          try { window.JKHStore.removeRaw(KEY_DB, ownerId); } catch (eDbRemove) {}
          console.error("[JKH sync][load] owner=%s key=%s status=invalid_schema_from_server raw_preview=%s", ownerId, kx, _rawPreview(rawDb, 500));
          continue;
        }
      }
      try {
        _writeServerDumpLocalCompat(kx, (val === null || val === undefined) ? "" : String(val), ownerId);
        written++;
        if (String(kx || "").indexOf("tariffs_") === 0) {
          try {
            console.log("[diagnose][tariffs-storage]", {
              source: "storage:dump-write-local",
              ownerId: ownerId,
              canonicalKey: kx,
              canonicalExists: val !== null && val !== undefined && String(val) !== "",
              canonicalLength: val ? String(val).length : 0,
              legacyExists: _readLocalCompat("tariffs_content_repair_v1", ownerId) !== "",
              legacyLength: _readLocalCompat("tariffs_content_repair_v1", ownerId).length,
              serverValueExists: val !== null && val !== undefined && String(val) !== "",
              localValueExists: _readLocalCompat(kx, ownerId) !== ""
            });
          } catch (eTariffWriteLog) {}
        }
      } catch (eWrite) {
        return {
          removed: removed,
          written: written,
          invalidAbonentsDb: invalidAbonentsDb,
          serverDbEmpty: serverDbEmpty,
          cacheError: eWrite,
          failedStorageKey: String(eWrite && eWrite.jkhStorageKey || kx || "")
        };
      }
    }
    return { removed: removed, written: written, invalidAbonentsDb: invalidAbonentsDb, serverDbEmpty: serverDbEmpty };
  }

  function _isQuotaExceededError(error) {
    var name = String(error && error.name || "");
    var message = String(error && error.message || error || "");
    var code = Number(error && error.code || 0);
    return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || code === 22 || code === 1014 || /quota/i.test(message);
  }

  function _serverLoadCacheWarning(error, details) {
    var input = details && typeof details === "object" ? details : {};
    return {
      status: "error",
      errorName: String(error && error.name || "Error"),
      errorMessage: String(error && error.message || error || "LOCAL_CACHE_WRITE_FAILED"),
      quotaExceeded: _isQuotaExceededError(error),
      ownerId: String(input.ownerId || ""),
      envType: String(input.envType || ""),
      dumpLoaded: input.dumpLoaded === true,
      dumpItemCount: Number(input.dumpItemCount || 0),
      failedStorageKey: String(input.failedStorageKey || error && error.jkhStorageKey || "")
    };
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

  function _isDbObjectEffectivelyEmpty(db) {
    if (!db || typeof db !== "object") return true;
    var ab = db.abonents && typeof db.abonents === "object" ? Object.keys(db.abonents).length : 0;
    var pr = db.premises && typeof db.premises === "object" ? Object.keys(db.premises).length : 0;
    var ln = Array.isArray(db.links) ? db.links.length : 0;
    return (ab + pr + ln) === 0;
  }

  function _validateAbonentsDbRaw(rawDb) {
    if (!rawDb || !String(rawDb).trim()) return false;
    try {
      var obj = JSON.parse(String(rawDb));
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
      if (!obj.abonents || typeof obj.abonents !== "object" || Array.isArray(obj.abonents)) return false;
      if (!obj.premises || typeof obj.premises !== "object" || Array.isArray(obj.premises)) return false;
      if (!Array.isArray(obj.links)) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function _rawPreview(raw, maxLen) {
    var s = (raw === null || raw === undefined) ? "" : String(raw);
    var lim = (typeof maxLen === "number" && maxLen > 0) ? maxLen : 400;
    if (s.length <= lim) return s;
    return s.slice(0, lim) + "...";
  }

  function _runtimeDbAbonentCount(db) {
    return db && db.abonents && typeof db.abonents === "object" ? Object.keys(db.abonents).length : 0;
  }

  function _copyRuntimeDbExtras(target, source) {
    if (!target || !source || typeof source !== "object" || Array.isArray(source)) return;
    Object.keys(source).forEach(function (key) {
      if (key === "abonents" || key === "premises" || key === "links" || key === "premiseEvents") return;
      if (source[key] !== undefined && source[key] !== null) target[key] = source[key];
    });
  }

  function _normalizeRuntimeDbHydrateShape(parsedDb, runtimeBefore) {
    var normalized = {};
    var before = runtimeBefore && typeof runtimeBefore === "object" && !Array.isArray(runtimeBefore) ? runtimeBefore : null;
    var parsed = parsedDb && typeof parsedDb === "object" && !Array.isArray(parsedDb) ? parsedDb : null;
    _copyRuntimeDbExtras(normalized, before);
    _copyRuntimeDbExtras(normalized, parsed);
    normalized.abonents = parsed && parsed.abonents && typeof parsed.abonents === "object" && !Array.isArray(parsed.abonents)
      ? parsed.abonents
      : (before && before.abonents && typeof before.abonents === "object" && !Array.isArray(before.abonents) ? before.abonents : {});
    normalized.premises = parsed && parsed.premises && typeof parsed.premises === "object" && !Array.isArray(parsed.premises)
      ? parsed.premises
      : (before && before.premises && typeof before.premises === "object" && !Array.isArray(before.premises) ? before.premises : {});
    normalized.links = Array.isArray(parsed && parsed.links)
      ? parsed.links
      : (Array.isArray(before && before.links) ? before.links : []);
    normalized.premiseEvents = Array.isArray(parsed && parsed.premiseEvents)
      ? parsed.premiseEvents
      : (Array.isArray(before && before.premiseEvents) ? before.premiseEvents : []);
    return normalized;
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
  var checkedAt = _nowISO();
  if (!isOnlineMode()) {
    _setStatus({ server: "OFFLINE (локально)", lastError: null });
    _setUIState({ server: { status: "offline", checkedAt: checkedAt, message: "OFFLINE mode" } });
    return false;
  }

  // ✅ Гость = нормальный режим, а не ошибка сервера
  if (_isGuestUser()) {
    _setStatus({
      server: "гость (без серверной сессии)",
      lastError: null,
      lastAction: "Гостевой режим: проверка серверной базы не требуется"
    });
    _setUIState({ server: { status: "unauthorized", checkedAt: checkedAt, message: "" } });
    return true;
  }

  try {
    // ✅ ПИНГ через store_dump (единый канон)
    var pingOwner = _ownerId();
    var res = await _apiGet("/api/store_dump?client_owner_hint=" + encodeURIComponent(pingOwner));

    if (res.okHttp && res.data && res.data.ok === true) {
      _setStatus({ server: "🟢 подключён", lastError: null });
      _setUIState({ server: { status: "online", checkedAt: checkedAt, message: "" } });
      return true;
    }

    // ✅ 401 для гостя не считаем ошибкой
    if (res.status === 401 || _isGuestUser()) {
      _setStatus({
        server: "гость (без серверной сессии)",
        lastError: null,
        lastAction: "Гостевой режим: серверная авторизация отсутствует"
      });
      _setUIState({ server: { status: "unauthorized", checkedAt: checkedAt, message: "" } });
      return true;
    }

    var msg = (res.data && res.data.error)
      ? res.data.error
      : ("HTTP " + res.status);

    _setStatus({
      server: "🟡 нет ответа",
      lastError: msg
    });
    _setUIState({ server: { status: "offline", checkedAt: checkedAt, message: msg } });

    return false;

  } catch (e) {
    var err = String(e && e.message ? e.message : e);
    _setStatus({
      server: "🔴 ошибка сети",
      lastError: err
    });
    _setUIState({ server: { status: "offline", checkedAt: checkedAt, message: err } });
    return false;
  }
  }

  async function upload(scope) {
    if (!isOnlineMode()) {
      _setStatus({ lastAction: "Сохранение пропущено: OFFLINE режим", lastError: null });
      return false;
    }
      if (_isGuestOrAll()) {
    if (_isGuestUser()) {
      _setStatus({
        lastAction: "Гостевой режим: серверная загрузка не требуется",
        lastError: null
      });
      _setUIState({ data: { status: "idle", source: "none", message: "" } });
      return true;
    }

    _setStatus({
      lastAction: "Загрузка запрещена: режим ALL",
      lastError: "ALLMODE_READONLY"
    });
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
        if (String(baseKey || "").indexOf("tariffs_") === 0) {
          try {
            console.log("[diagnose][tariffs-storage]", {
              source: "storage:upload-read-local",
              ownerId: ownerId,
              canonicalKey: baseKey,
              canonicalExists: raw !== "",
              canonicalLength: raw.length,
              legacyExists: _readLocalCompat("tariffs_content_repair_v1", ownerId) !== "",
              legacyLength: _readLocalCompat("tariffs_content_repair_v1", ownerId).length,
              serverValueExists: null,
              localValueExists: raw !== ""
            });
          } catch (eTariffUploadLog) {}
        }

        // safeguard: не перезаписываем непустую базу на сервере пустой локальной базой
        if (baseKey === KEY_DB && _isDbEffectivelyEmpty(raw)) {
          var resCur = await _apiGet("/api/store?key=" + encodeURIComponent(KEY_DB) + "&client_owner_hint=" + encodeURIComponent(ownerId));
          var srv = (resCur.okHttp && resCur.data && resCur.data.ok) ? (resCur.data.value || "") : "";
          if (_isDbEffectivelyEmpty(raw) && !_isDbEffectivelyEmpty(srv)) {
            _setStatus({ lastAction: "Сохранение остановлено", lastError: "EMPTY_DB_OVERWRITE_BLOCKED" });
            console.warn("[JKH sync][save] owner=%s key=%s size=%s status=blocked_empty_overwrite", ownerId, baseKey, String(raw || "").length);
            return false;
          }
        }
        if (baseKey === KEY_DB && !_validateAbonentsDbRaw(raw)) {
          _setStatus({ lastAction: "Сохранение остановлено", lastError: "INVALID_ABONENTS_DB_SCHEMA" });
          console.error("[JKH sync][save] owner=%s key=%s status=invalid_schema raw_preview=%s", ownerId, baseKey, _rawPreview(raw, 500));
          return false;
        }

        var resSet = await _apiPost("/api/store", { client_owner_hint: ownerId, key: baseKey, value: raw });
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
    if (_isDevMode()) {
      console.warn("[JKH sync][deprecated] JKHRemoteSync.downloadNow/download используют канонический JKHDataLoader.loadFromServer");
    }
    var res = await _loadFromServerServerFirst({ reason: "legacy_download_wrapper", force: true, scope: scope });
    return !!(res && res.ok);
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
      return false;
    }
    var s = getSettings();
    var scope = (s.scope === "all") ? "all" : "db";
    return await upload(scope);
  }

  async function downloadNow() {
    if (_isGuestOrAll()) {
      alert("Загрузка запрещена: режим 'Гость' или 'ALL'.");
      return false;
    }
    var ok = confirm("Загрузить данные с сервера (MySQL) и заменить локальные?\n\nВНИМАНИЕ: локальные несохранённые изменения будут перезаписаны.");
    if (!ok) return false;
    var s = getSettings();
    var scope = (s.scope === "all") ? "all" : "db";
    return await download(scope);
  }

  async function migrateLegacyLocalOnce(ownerId) {
    return true;
  }

  async function autoLoadAfterLogin() {
    if (_isDevMode()) {
      console.warn("[JKH sync][deprecated] JKHRemoteSync.autoLoadAfterLogin больше не основной сценарий, используется JKHDataLoader.loadFromServer");
    }
    if (!window.JKHDataLoader || typeof window.JKHDataLoader.loadFromServer !== "function") return false;
    var res = await window.JKHDataLoader.loadFromServer({ reason: "legacy_autoload", force: true });
    return !!(res && res.ok);
  }


  async function _loadFromServerServerFirst(options) {
    options = options || {};
    if (window.__JKH_DATA_LOADER_IN_FLIGHT) return window.__JKH_DATA_LOADER_IN_FLIGHT;

    window.__JKH_DATA_LOADER_IN_FLIGHT = (async function () {
      var ownerId = _ownerId();
      var checkedAt = _nowISO();
      var preservedDataStateBeforeLoad = _serverDataStateSnapshotIfPreserved();

      if (!isOnlineMode()) {
        _setUIState(_serverConnectivityFailureUIStatePatch(
          { status: "offline", checkedAt: checkedAt, message: "OFFLINE mode" },
          { status: "offline", source: "server", message: "OFFLINE mode" },
          preservedDataStateBeforeLoad,
          "connectivity_offline_without_data_downgrade"
        ));
        return { ok: false, status: "offline", serverStatus: "offline", message: "OFFLINE mode" };
      }

      if (_isGuestUser()) {
        _setUIState({
          server: { status: "unauthorized", checkedAt: checkedAt, message: "" },
          data: { status: "unauthorized", source: "none", message: "Требуется вход" }
        });
        return { ok: false, status: "unauthorized", serverStatus: "unauthorized", message: "Требуется вход" };
      }

      if (window.JKHStore && window.JKHStore.isAllMode && window.JKHStore.isAllMode()) {
        _setUIState({
          server: { status: "forbidden", checkedAt: checkedAt, message: "ALLMODE_READONLY" },
          data: { status: "forbidden", source: "server", message: "Режим ALL не поддерживает загрузку project-scope" }
        });
        return { ok: false, status: "forbidden", serverStatus: "forbidden", message: "ALLMODE_READONLY" };
      }

      _setUIState({
        server: { status: "online", checkedAt: checkedAt, message: "" },
        data: { status: "loading", source: "server", message: "" }
      });

      try {
        var resDump = await _apiGet("/api/store_dump?client_owner_hint=" + encodeURIComponent(ownerId));
        if (!(resDump.okHttp && resDump.data && resDump.data.ok === true)) {
          var httpErr = (resDump.data && resDump.data.error) ? resDump.data.error : ("HTTP " + resDump.status);
          var serverStatus = (resDump.status === 401) ? "unauthorized" : ((resDump.status === 403) ? "forbidden" : "offline");
          var dataStatus = (resDump.status === 401) ? "unauthorized" : ((resDump.status === 403) ? "forbidden" : "offline");
          if (serverStatus === "offline") {
            _setUIState(_serverConnectivityFailureUIStatePatch(
              { status: serverStatus, checkedAt: _nowISO(), message: httpErr },
              { status: dataStatus, source: "server", message: httpErr },
              preservedDataStateBeforeLoad,
              "server_offline_data_state_preserved"
            ));
          } else {
            _setUIState({
              server: { status: serverStatus, checkedAt: _nowISO(), message: "" },
              data: { status: dataStatus, source: "server", message: (dataStatus === "unauthorized" ? "Требуется вход" : httpErr) }
            });
          }
          return { ok: false, status: dataStatus, serverStatus: serverStatus, message: httpErr };
        }

        var responseOwner = String((resDump.data && resDump.data.owner) || "");
        var responseEnv = String((resDump.data && (resDump.data.env_type || resDump.data.env || resDump.data.environment)) || "");
        if (!setEnvType(responseEnv) && isHostedMode()) {
          _setUIState({
            server: { status: "online", checkedAt: _nowISO(), message: "" },
            data: { status: "invalid", source: "server", message: "ENV_TYPE missing from /api/store_dump" }
          });
          _setStatus({ lastAction: "Ошибка загрузки", lastError: "ENV_TYPE_MISSING_STORE_DUMP" });
          return { ok: false, status: "invalid", serverStatus: "online", message: "ENV_TYPE_MISSING_STORE_DUMP" };
        }
        console.info("[JKH sync][load] requested_owner=%s response_owner=%s", ownerId, responseOwner);
        if (responseOwner !== String(ownerId)) {
          console.warn("[JKH sync][load] server_owner differs from client_owner_hint", {
            server_owner: responseOwner,
            client_owner_hint: String(ownerId)
          });
        }

        var data = (resDump.data && Object.prototype.hasOwnProperty.call(resDump.data, "data")) ? resDump.data.data : null;
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          _setUIState({
            server: { status: "online", checkedAt: _nowISO(), message: "" },
            data: { status: "invalid", source: "server", message: "Некорректный payload /api/store_dump" }
          });
          _setStatus({ lastAction: "Ошибка загрузки", lastError: "INVALID_PAYLOAD_STORE_DUMP" });
          return { ok: false, status: "invalid", serverStatus: "online", message: "INVALID_PAYLOAD_STORE_DUMP" };
        }

        var dumpItemCount = Object.keys(data).length;
        var hasServerRuntimeDb = Object.prototype.hasOwnProperty.call(data, KEY_DB);
        var serverRuntimeRaw = hasServerRuntimeDb ? _serializeServerDumpValue(data[KEY_DB]) : "";
        if (hasServerRuntimeDb && !_validateAbonentsDbRaw(serverRuntimeRaw)) {
          _setUIState({
            server: { status: "online", checkedAt: _nowISO(), message: "" },
            data: { status: "invalid", source: "server", message: "Некорректная структура abonents_db_v1 в dump" }
          });
          _setStatus({ lastAction: "Ошибка загрузки", lastError: "INVALID_ABONENTS_DB_SCHEMA_FROM_SERVER" });
          return { ok: false, status: "invalid", serverStatus: "online", message: "INVALID_ABONENTS_DB_SCHEMA_FROM_SERVER" };
        }
        var serverRuntimeDb = null;
        try { serverRuntimeDb = serverRuntimeRaw ? JSON.parse(serverRuntimeRaw) : null; } catch (eServerRuntimeParse) { serverRuntimeDb = null; }
        var replaced = _replaceOwnerProjectScopeFromDump(ownerId, data);
        if (replaced.invalidAbonentsDb) {
          _setUIState({
            server: { status: "online", checkedAt: _nowISO(), message: "" },
            data: { status: "invalid", source: "server", message: "Некорректная структура abonents_db_v1 в dump" }
          });
          _setStatus({ lastAction: "Ошибка загрузки", lastError: "INVALID_ABONENTS_DB_SCHEMA_FROM_SERVER" });
          return { ok: false, status: "invalid", serverStatus: "online", message: "INVALID_ABONENTS_DB_SCHEMA_FROM_SERVER" };
        }
        var cacheWarning = replaced.cacheError ? _serverLoadCacheWarning(replaced.cacheError, {
          ownerId: ownerId,
          envType: responseEnv,
          dumpLoaded: true,
          dumpItemCount: dumpItemCount,
          failedStorageKey: replaced.failedStorageKey
        }) : null;

        var applied = replaced.written;
        var runtimeBefore = window.AbonentsDB || null;
        var rawRuntimeDb = _readLocalCompat(KEY_DB, ownerId);
        var parsedRuntimeDb = cacheWarning
          ? serverRuntimeDb
          : (window.unwrapRuntimeDb ? window.unwrapRuntimeDb(rawRuntimeDb) : safeJsonParse(rawRuntimeDb, null));
        var runtimeCounts = {
          abonents: runtimeBefore && runtimeBefore.abonents && typeof runtimeBefore.abonents === "object" ? Object.keys(runtimeBefore.abonents).length : 0,
          premises: runtimeBefore && runtimeBefore.premises && typeof runtimeBefore.premises === "object" ? Object.keys(runtimeBefore.premises).length : 0,
          links: runtimeBefore && Array.isArray(runtimeBefore.links) ? runtimeBefore.links.length : 0
        };
        var runtimeHadContent = !_isDbObjectEffectivelyEmpty(runtimeBefore);
        var parsedHasContent = !!(parsedRuntimeDb && typeof parsedRuntimeDb === "object" && !Array.isArray(parsedRuntimeDb) && !_isDbObjectEffectivelyEmpty(parsedRuntimeDb));
        if (!replaced.serverDbEmpty && parsedHasContent) {
          window.AbonentsDB = _normalizeRuntimeDbHydrateShape(parsedRuntimeDb, runtimeBefore);
          try {
            console.info("[runtime-hydrate]", {
              source: "store_dump.abonents_db_v1",
              beforeCount: runtimeCounts.abonents,
              parsedCount: _runtimeDbAbonentCount(parsedRuntimeDb),
              afterCount: _runtimeDbAbonentCount(window.AbonentsDB)
            });
          } catch (hydrateCountsErr) {}
          try {
            console.log("[runtime-db-keys]", Object.keys(window.AbonentsDB || {}));
            console.log(
              "[runtime-abonents-count]",
              window.AbonentsDB && window.AbonentsDB.abonents
                ? Object.keys(window.AbonentsDB.abonents).length
                : "missing"
            );
          } catch (shapeLogErr) {}
          try {
            console.info("[data][runtime-hydrate-ok]", {
              ownerId: ownerId,
              reason: String(options && options.reason || "server-first"),
              hydratedFrom: "storage.raw",
              dbCount: Object.keys(parsedRuntimeDb.abonents || {}).length,
              premiseCount: Object.keys(parsedRuntimeDb.premises || {}).length,
              linkCount: Array.isArray(parsedRuntimeDb.links) ? parsedRuntimeDb.links.length : 0
            });
          } catch (hydrateLogErr) {}
        } else if (replaced.serverDbEmpty && (parsedHasContent || runtimeHadContent)) {
          try {
            console.warn("[data][runtime-hydrate-empty-blocked]", {
              status: "empty",
              rawLen: String(rawRuntimeDb || "").length,
              runtimeCounts: runtimeCounts
            });
          } catch (emptyBlockedLogErr) {}
          if (parsedHasContent && !runtimeHadContent) {
            window.AbonentsDB = _normalizeRuntimeDbHydrateShape(parsedRuntimeDb, runtimeBefore);
            try {
              console.info("[runtime-hydrate]", {
                source: "store_dump.abonents_db_v1",
                beforeCount: runtimeCounts.abonents,
                parsedCount: _runtimeDbAbonentCount(parsedRuntimeDb),
                afterCount: _runtimeDbAbonentCount(window.AbonentsDB)
              });
            } catch (hydrateCountsErr2) {}
            try {
              console.log("[runtime-db-keys]", Object.keys(window.AbonentsDB || {}));
              console.log(
                "[runtime-abonents-count]",
                window.AbonentsDB && window.AbonentsDB.abonents
                  ? Object.keys(window.AbonentsDB.abonents).length
                  : "missing"
              );
            } catch (shapeLogErr2) {}
          }
        }
        var status = (!replaced.serverDbEmpty || runtimeHadContent || parsedHasContent) ? "ready" : "empty";
        var loadedAt = _nowISO();
        var cacheWarningMessage = cacheWarning ? ("Данные загружены с сервера; локальный cache не сохранён: " + cacheWarning.errorMessage) : "";
        _setUIState({
          server: { status: "online", checkedAt: _nowISO(), message: "" },
          data: {
            status: status,
            loadedAt: loadedAt,
            source: "server",
            message: cacheWarningMessage || (status === "empty" ? "Серверный dump пуст" : ""),
            cacheWarning: cacheWarning
          }
        });

        if (cacheWarning) {
          try {
            console.warn("[server-load][local-cache-failed]", Object.assign({}, cacheWarning, {
              serverStatus: "online",
              dataStatus: status,
              preservedReadableState: status === "ready" || status === "empty"
            }));
            console.warn("[server-load][ready-with-cache-warning]", {
              ownerId: ownerId,
              envType: responseEnv,
              serverStatus: "online",
              dataStatus: status,
              dataSource: "server",
              cacheWarning: cacheWarning
            });
          } catch (eCacheWarningLog) {}
        }

        _setStatus({
          lastAction: "✅ Загружено с сервера",
          lastError: null,
          ownerId: ownerId,
          loadSource: "server:first",
          lastReadAt: loadedAt
        });

        return {
          ok: true,
          status: status,
          loadedAt: loadedAt,
          serverStatus: "online",
          message: cacheWarningMessage,
          cacheWarning: cacheWarning,
          warning: cacheWarning ? "LOCAL_CACHE_WRITE_FAILED" : ""
        };
      } catch (e) {
        var msg = String(e && e.message ? e.message : e);
        _setUIState(_serverConnectivityFailureUIStatePatch(
          { status: "offline", checkedAt: _nowISO(), message: msg },
          { status: "offline", source: "server", message: "Ошибка сети: " + msg },
          preservedDataStateBeforeLoad,
          "server_offline_data_state_preserved"
        ));
        _setStatus({ lastAction: "Ошибка загрузки", lastError: msg });
        return { ok: false, status: "offline", serverStatus: "offline", message: msg };
      } finally {
        window.__JKH_DATA_LOADER_IN_FLIGHT = null;
      }
    })();

    return window.__JKH_DATA_LOADER_IN_FLIGHT;
  }

  window.JKHDataLoader = {
    loadFromServer: _loadFromServerServerFirst,
    __testHooks: {
      isQuotaExceededError: _isQuotaExceededError,
      serverLoadCacheWarning: _serverLoadCacheWarning,
      replaceOwnerProjectScopeFromDump: _replaceOwnerProjectScopeFromDump
    },
    resetLocalProjectScope: function (ownerId) {
      var targetOwner = String(ownerId || _ownerId());
      var removed = _clearOwnerProjectScope(targetOwner);
      return { ok: true, ownerId: targetOwner, removed: removed };
    },
    resetAllLocalProjectScopes: function () {
      return { ok: true, removed: _clearAllProjectScopes() };
    }
  };


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
