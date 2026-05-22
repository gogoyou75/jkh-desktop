// data.js — база абонентов (пустая по умолчанию) + ДЕМО 1006/1008 по кнопке
// Полная новая версия под "загрузить демо" (регрессионный стенд)

(function () {
  "use strict";

  // ============================================================
  // CONFIG
  // ============================================================
  const KEY_DB = "abonents_db_v1";

  // ============================================================
  // ✅ JKH_REMOTE_DATA_SYNC v1 (2026-02-10)
  // ONLINE (MySQL) режим без ломания синхронного кода:
  // 1) Всегда читаем AbonentsDB из локального кэша (как раньше)
  // 2) В фоне подтягиваем с сервера и, если получили данные — обновляем кэш и перезагружаем страницу 1 раз.
  // Переводы:
  //   sync = синхронизация
  //   cache = кэш (локальная копия)
  // ============================================================
  function _remoteEnabled(){
    try{ return !!(window.JKHRemote && typeof JKHRemote.isEnabled === "function" && JKHRemote.isEnabled()); }catch(e){ return false; }
  }
  function _fireAndForget(p){
    try{ Promise.resolve(p).catch(function(e){ try{ console.warn("[remote] failed", e); }catch(_){ } }); }catch(e){}
  }


  // ============================================================
  // Scoped storage helpers (per-user базы + admin "ALL")
  // ============================================================
  function _ownerId() {
    try {
      if (window.Auth && typeof Auth.getActiveDbOwnerId === "function") return Auth.getActiveDbOwnerId();
      if (window.JKHStore && typeof JKHStore.getOwnerId === "function") return JKHStore.getOwnerId();
      if (window.JKHStorage && typeof JKHStorage.getActiveOwnerId === "function") return JKHStorage.getActiveOwnerId();
    } catch (e) { }
    return "guest";
  }

  function _isAllMode() { return _ownerId() === "ALL"; }

  function _isGuest() {
    try {
      if (window.Auth && typeof Auth.isGuest === "function") return Auth.isGuest();
    } catch (e) { }
    return _ownerId() === "guest";
  }

  function _canWriteStorage() {
    return !_isGuest() && !_isAllMode();
  }

  function _explainWriteBlocked() {
    if (_isGuest()) {
      alert("Гость: только просмотр. Войдите, чтобы сохранять.");
      return;
    }
    if (_isAllMode()) {
      alert("Режим 'все базы' — только просмотр. Выберите конкретную базу в выпадающем списке (админ).");
    }
  }

  function canWriteOrExplain() {
    if (_canWriteStorage()) return true;
    _explainWriteBlocked();
    return false;
  }

  function _k(key, ownerId) {
    try {
      if (window.JKHStore && typeof JKHStore.key === "function") return JKHStore.key(key, ownerId);
      if (window.JKHStorage && typeof JKHStorage.k === "function") return JKHStorage.k(key, ownerId);
    } catch (e) { }
    return "jkhdb::" + String(ownerId || _ownerId()) + "::" + key;
  }

  function _getRawScoped(key, ownerId) {
    try {
      if (window.JKHStore && typeof JKHStore.getRaw === "function") return JKHStore.getRaw(key, ownerId);
    } catch (e) { }
    try {
      if (window.JKHStorage && typeof JKHStorage.getItem === "function") return JKHStorage.getItem(key, ownerId);
    } catch (e2) { }
    return null;
  }

  function _setRawScoped(key, value, ownerId) {
    try {
      if (window.JKHStore && typeof JKHStore.setRaw === "function") return JKHStore.setRaw(key, value, ownerId);
    } catch (e) { }
    try {
      if (window.JKHStorage && typeof JKHStorage.setItem === "function") return JKHStorage.setItem(key, value, ownerId);
    } catch (e2) { }
    return false;
  }

  function _removeRawScoped(key, ownerId) {
    try {
      if (window.JKHStore && typeof JKHStore.removeRaw === "function") return JKHStore.removeRaw(key, ownerId);
    } catch (e) { }
    try {
      if (window.JKHStorage && typeof JKHStorage.removeItem === "function") return JKHStorage.removeItem(key, ownerId);
    } catch (e2) { }
    return false;
  }



  function _getProjectRaw(key) {
    try {
      if (window.JKHStore && typeof JKHStore.getRaw === "function") return JKHStore.getRaw(key);
    } catch (e) { }
    return null;
  }

  function _setProjectRaw(key, value) {
    try {
      if (window.JKHStore && typeof JKHStore.setRaw === "function") return JKHStore.setRaw(key, value);
    } catch (e) { }
    return false;
  }

  function _removeProjectRaw(key) {
    try {
      if (window.JKHStore && typeof JKHStore.removeRaw === "function") return JKHStore.removeRaw(key);
    } catch (e) { }
    return false;
  }

  function _adminRemoveForOwner(ownerId, key) {
    try {
      if (window.JKHStore && JKHStore.admin && typeof JKHStore.admin.removeRawForOwner === "function") {
        return JKHStore.admin.removeRawForOwner(ownerId, key);
      }
    } catch (e) { }
    // fallback (не должен понадобиться)
    _removeRawScoped(key, ownerId);
  }

  function _adminSetForOwner(ownerId, key, value) {
    try {
      if (window.JKHStore && JKHStore.admin && typeof JKHStore.admin.setRawForOwner === "function") {
        return JKHStore.admin.setRawForOwner(ownerId, key, value);
      }
    } catch (e) { }
    _setRawScoped(key, value, ownerId);
  }

  function _adminKeysForOwner(ownerId) {
    try {
      if (window.JKHStore && JKHStore.admin && typeof JKHStore.admin.keysForOwner === "function") {
        return JKHStore.admin.keysForOwner(ownerId);
      }
    } catch (e) { }
    try {
      if (window.JKHStorage && typeof JKHStorage.keysForOwner === "function") {
        return JKHStorage.keysForOwner(ownerId);
      }
    } catch (e2) { }
    return [];
  }

  // Список ключей/префиксов проекта для "сброс базы" и "загрузить демо"
  const PROJECT_KEY_PREFIXES = [
    "payments_",
    "note_",
    "exclude_periods_",
    "calc_period_",
    "calc_period_active_",
    "report_period_",
    "payments_ui_collapsed_",
    "jkh_transfer_v1:",
    "jkh_transfer_to_v1:",
    "jkh_transfer_balance_v1:",
    "jkh_frozen_debt_v1:",
    "jkh_freeze_to_v1:",
    "jkh_financial_events_v1"
  ];

  const PROJECT_KEY_EXACT = [
    KEY_DB,
    "abonent_notes_v1",
    "exclude_periods_v1",
    "tariffs_v1",
    "refinancing_v1",
    "import_preview_v1",
    "draft_new_abonent_v1",
    "payment_sources_v1",
    "tariffs_content_repair_v1", // legacy read-only / migration only / excluded from upload
    "tariffs_content_repair_v1_backup", // legacy read-only / migration only / excluded from upload
    "refinancing_rates_normal_v1",
    "refinancing_rates_moratorium_v1",
    "jkh_excel_date_debug",
    "last_abonent_id"
  ];

  // ============================================================
  // HELPERS
  // ============================================================
  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }
  function isPlainObject(x) {
    return x && typeof x === "object" && !Array.isArray(x);
  }

  function safeJsonParse(raw, fallback) {
    try {
      if (!raw) return fallback;
      const v = JSON.parse(raw);
      return v === undefined ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function excludePeriodsStorageKey(abonentId) {
    return "exclude_periods_" + String(abonentId || "").trim();
  }

  function normalizeExcludePeriodsList(input) {
    try {
      var arr = input;
      if (typeof arr === "string") {
        var raw = String(arr || "").trim();
        if (!raw) return [];
        arr = JSON.parse(raw);
      }
      if (!Array.isArray(arr)) return [];
      var out = [];
      arr.forEach(function (p) {
        if (!p || typeof p !== "object" || Array.isArray(p)) return;
        var from = String(p.from || "").trim();
        var to = String(p.to || "").trim();
        var reason = String(p.reason || "").trim();
        if (!from && !to && !reason) return;
        out.push({ from: from, to: to, reason: reason });
      });
      return out;
    } catch (e) {
      return [];
    }
  }

  function readCanonicalExcludePeriods(abonentId) {
    var id = String(abonentId || "").trim();
    if (!id) return [];
    var key = excludePeriodsStorageKey(id);
    var raw = _getProjectRaw(key);
    if (raw !== null && raw !== undefined) {
      if (raw === "") {
        _setProjectRaw(key, "[]");
        console.warn("[excludes][repair-empty-canonical]", { abonentId: id, key: key });
        return [];
      }
      try {
        var parsed = JSON.parse(String(raw));
        if (Array.isArray(parsed)) return normalizeExcludePeriodsList(parsed);
        console.warn("[excludes][canonical-invalid]", { abonentId: id, key: key, reason: "EXCLUDES_NOT_ARRAY" });
        return [];
      } catch (e) {
        console.warn("[excludes][canonical-invalid]", { abonentId: id, key: key, reason: "JSON_PARSE_FAILED", error: e });
        return [];
      }
    }

    var legacy = [];
    try {
      var db = window.AbonentsDB || {};
      var a = db.abonents && db.abonents[id] ? db.abonents[id] : null;
      legacy = normalizeExcludePeriodsList(a && a.defaultExcludes);
    } catch (e2) {
      legacy = [];
    }
    writeCanonicalExcludePeriods(id, legacy);
    return legacy;
  }

  function writeCanonicalExcludePeriods(abonentId, list) {
    var id = String(abonentId || "").trim();
    if (!id) return false;
    var key = excludePeriodsStorageKey(id);
    var normalized = normalizeExcludePeriodsList(list);
    var payload = normalized.length ? JSON.stringify(normalized) : "[]";
    console.log("[excludes][canonical-write]", { abonentId: id, key: key, count: normalized.length });
    return _setProjectRaw(key, payload);
  }

  function repairEmptyExcludePeriodsKeys() {
    var db = window.AbonentsDB || {};
    var abonents = db && db.abonents ? db.abonents : {};
    var ids = Object.keys(abonents || {});
    var repaired = 0;
    ids.forEach(function (abonentId) {
      var id = String(abonentId || "").trim();
      if (!id) return;
      var key = excludePeriodsStorageKey(id);
      var raw = _getProjectRaw(key);
      if (raw !== "") return;
      _setProjectRaw(key, "[]");
      repaired++;
      console.warn("[excludes][repair-empty-canonical]", { abonentId: id, key: key });
    });
    return repaired;
  }

  function removeLegacyExcludeFields(obj) {
    if (!obj || typeof obj !== "object") return obj;
    delete obj.defaultExcludes;
    delete obj.excludes;
    delete obj.excludePeriods;
    delete obj.specialExcludes;
    return obj;
  }

  const __paymentKeyResolveCache = new Map();
  let __paymentKeyResolveCacheOwner = null;
  let __paymentKeyResolveCacheDb = null;
  let __paymentKeyResolveCacheVersion = 0;
  const __paymentKeyResolveLogOnce = new Set();

  function _paymentKeyDebugEnabled() {
    try { return !!window.JKH_DEBUG_PAYMENT_KEY; } catch (e) { return false; }
  }

  function _resetPaymentKeyResolveCache(reason) {
    __paymentKeyResolveCache.clear();
    __paymentKeyResolveLogOnce.clear();
    __paymentKeyResolveCacheOwner = _ownerId();
    __paymentKeyResolveCacheDb = window.AbonentsDB || null;
    __paymentKeyResolveCacheVersion++;
    try {
      if (_paymentKeyDebugEnabled()) console.debug('[payment-key] cache reset', { reason: String(reason || ''), version: __paymentKeyResolveCacheVersion });
    } catch (e) { }
  }

  function _ensurePaymentKeyResolveCacheFresh() {
    const owner = _ownerId();
    const db = window.AbonentsDB || null;
    if (__paymentKeyResolveCacheOwner !== owner || __paymentKeyResolveCacheDb !== db) {
      _resetPaymentKeyResolveCache('owner-or-db-change');
    }
  }

  function _logPaymentKeyResolve(level, payload) {
    try {
      if (!_paymentKeyDebugEnabled()) return;
      const id = String(payload && payload.abonentId || '');
      const key = String(payload && (payload.key || payload.reason || payload.mode) || '');
      const onceKey = level + ':' + id + ':' + key;
      if (__paymentKeyResolveLogOnce.has(onceKey)) return;
      __paymentKeyResolveLogOnce.add(onceKey);
      const fn = console[level] || console.debug || console.log;
      fn.call(console, '[payment-key] resolve', payload);
    } catch (e) { }
  }

  function getAbonentTechId(abonentId) {
    _ensurePaymentKeyResolveCacheFresh();

    const id = String(abonentId || '').trim();
    if (__paymentKeyResolveCache.has(id)) {
      const cached = __paymentKeyResolveCache.get(id);
      return cached && cached.uid ? cached.uid : null;
    }

    const db = (window.Data && typeof window.Data.getDb === 'function') ? window.Data.getDb() : (window.AbonentsDB || {});
    const abonents = db && db.abonents && typeof db.abonents === 'object' ? db.abonents : {};
    const a = abonents[id] || null;

    if (!a) {
      __paymentKeyResolveCache.set(id, { uid: '', key: '', found: false });
      _logPaymentKeyResolve('debug', {
        abonentId: id,
        found: false,
        uid: '',
        key: '',
        mode: 'not-ready',
        reason: 'ABONENT_NOT_READY'
      });
      return null;
    }

    const uid = String(a.uid || '').trim();
    if (isValidUid(uid)) {
      __paymentKeyResolveCache.set(id, { uid: uid, key: 'payments_' + uid, found: true });
      _logPaymentKeyResolve('debug', {
        abonentId: id,
        found: true,
        uid: uid,
        key: 'payments_' + uid,
        mode: 'uid'
      });
      return uid;
    }

    __paymentKeyResolveCache.set(id, { uid: '', key: '', found: true });
    _logPaymentKeyResolve('debug', {
      abonentId: id,
      found: true,
      uid: '',
      key: '',
      mode: 'blocked',
      reason: 'UID_REQUIRED'
    });
    return null;
  }

  function getPaymentsKeyForAbonent(abonentId) {
    const techId = getAbonentTechId(abonentId);
    if (!techId) return '';
    return 'payments_' + techId;
  }


  function _parseLedgerRows(raw, key) {
    if (raw === null || raw === undefined || raw === "") return [];
    try {
      var parsed = JSON.parse(String(raw));
      if (Array.isArray(parsed)) return parsed;
      throw new Error("payments ledger is not an array");
    } catch (e) {
      var err = new Error("Данные платежей повреждены. Расчёт/импорт остановлен, чтобы не потерять историю платежей.");
      err.code = "LEDGER_JSON_INVALID";
      err.key = key || "";
      err.cause = e;
      throw err;
    }
  }

  function _cloneLedgerRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map(function (r) { return (r && typeof r === "object") ? Object.assign({}, r) : r; });
  }

  function _readLedgerRowsInfo(key) {
    if (!key) return { key: "", exists: false, rowsCount: 0, rows: [] };
    var raw = _getProjectRaw(key);
    if (raw === null || raw === undefined) return { key: key, exists: false, rowsCount: 0, rows: [] };
    var rows = _parseLedgerRows(raw, key);
    return { key: key, exists: true, rowsCount: rows.length, rows: rows };
  }

  function _accountNumberForLedger(abonentId, abonent) {
    return String(abonent && (abonent.account_number || abonent.accountNumber || abonent.ls || abonent.personalAccount) || abonentId || "").trim();
  }

  function _legacyLedgerKeyForAbonent(abonentId, abonent) {
    var accountNumber = _accountNumberForLedger(abonentId, abonent);
    return accountNumber ? ("payments_" + accountNumber) : "";
  }

  function _hasLegacyLedgerRows(abonentId, abonent) {
    var key = _legacyLedgerKeyForAbonent(abonentId, abonent);
    if (!key) return false;
    return _safeLedgerInfoForDiagnostic(key).rowsCount > 0;
  }

  function _logLegacyLedgerReadonlyFallback(payload) {
    try { console.warn("[ledger][legacy-readonly-fallback]", payload || {}); } catch (e) {}
  }

  function _logFreshBlockedLegacyLedger(payload) {
    try { console.warn("[summary][fresh-blocked-legacy-ledger]", payload || {}); } catch (e) {}
  }

  function _logUidGenerationBlockedLegacyLedger(payload) {
    try { console.warn("[uid][generation-blocked-legacy-ledger]", payload || {}); } catch (e) {}
  }


  function isValidUid(uid) {
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

  function _logInvalidUidCanonicalBlocked(payload) {
    payload = payload || {};
    var key = String(payload.key || "");
    var source = String(payload.source || "");
    var isCalcPeriod = key.indexOf("calc_period") === 0 || source.indexOf("calcPeriod") >= 0 || source.indexOf("calc-period") >= 0;
    var sig = [key, String(payload.uid || ""), String(payload.abonentId || ""), source].join("|");
    if (__invalidUidCanonicalBlockedSeen[sig] || isCalcPeriod) {
      __invalidUidCanonicalBlockedSeen[sig] = true;
      __invalidUidCanonicalBlockedSummary.count++;
      if (key) __invalidUidCanonicalBlockedSummary.keys[key] = true;
      if (!__invalidUidCanonicalBlockedSummary.scheduled) {
        __invalidUidCanonicalBlockedSummary.scheduled = true;
        try { setTimeout(_flushInvalidUidCanonicalBlockedSummary, 0); } catch (eTimer) { _flushInvalidUidCanonicalBlockedSummary(); }
      }
      return;
    }
    __invalidUidCanonicalBlockedSeen[sig] = true;
    try { console.warn("[uid][canonical-blocked-invalid]", payload || {}); } catch (e) {}
  }

  function _findAbonentByIdOrUid(abonentOrId) {
    var db = window.AbonentsDB || {};
    var abonents = db && db.abonents && typeof db.abonents === "object" ? db.abonents : {};
    if (abonentOrId && typeof abonentOrId === "object") {
      var objId = String(abonentOrId.id || "").trim();
      if (objId && abonents[objId]) return { id: objId, abonent: abonents[objId] };
      var objUid = String(abonentOrId.uid || "").trim();
      if (isValidUid(objUid)) {
        var byObjUid = Object.keys(abonents).find(function (id) { return String(abonents[id] && abonents[id].uid || "").trim() === objUid; });
        if (byObjUid) return { id: byObjUid, abonent: abonents[byObjUid] };
      }
      return objId || objUid ? { id: objId || "", abonent: abonentOrId } : null;
    }

    var raw = String(abonentOrId || "").trim();
    if (!raw) return null;
    if (abonents[raw]) return { id: raw, abonent: abonents[raw] };
    if (isValidUid(raw)) {
      var byUid = Object.keys(abonents).find(function (id) { return String(abonents[id] && abonents[id].uid || "").trim() === raw; });
      if (byUid) return { id: byUid, abonent: abonents[byUid] };
    }
    return { id: raw, abonent: null };
  }

  function resolveCalcPeriodStorageKey(abonentOrId, options) {
    var opts = options || {};
    var suffix = String(opts && opts.suffix || "").trim();
    var found = _findAbonentByIdOrUid(abonentOrId);
    var abonent = found && found.abonent ? found.abonent : null;
    var uid = String(abonent && abonent.uid || "").trim();
    if (!isValidUid(uid)) {
      _logInvalidUidCanonicalBlocked({ abonentId: String(found && found.id || ""), uid: uid, key: "calc_period" + suffix, source: "resolveCalcPeriodStorageKey" });
      return "";
    }
    return "calc_period" + suffix + "_" + uid;
  }

  function resolveCalcPeriodActiveStorageKey(abonentOrId) {
    return resolveCalcPeriodStorageKey(abonentOrId, { suffix: "_active" });
  }

  function resolvePaymentLedgerKey(abonentOrId, options) {
    var opts = options || {};
    var found = _findAbonentByIdOrUid(abonentOrId);
    var id = String(found && found.id || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
    var abonent = found && found.abonent ? found.abonent : null;
    var uid = String(abonent && abonent.uid || "").trim();
    if (isValidUid(uid)) return "payments_" + uid;
    if (uid) _logInvalidUidCanonicalBlocked({ abonentId: id, uid: uid, key: "payments_", source: "resolvePaymentLedgerKey" });
    if (opts && opts.allowLegacyRead === true && id) return "payments_" + id;
    return "";
  }


  function resolveRuntimeCacheKey(abonentOrId) {
    var found = _findAbonentByIdOrUid(abonentOrId);
    var abonent = found && found.abonent ? found.abonent : null;
    var uid = String(abonent && abonent.uid || "").trim();
    if (!isValidUid(uid)) return "";
    return "ledger_runtime_cache_" + uid;
  }

  function getRuntimeCacheKey(abonentOrId) {
    return resolveRuntimeCacheKey(abonentOrId);
  }

  function computeLedgerRuntimeVersion(abonentOrId) {
    var ledgerKey = resolvePaymentLedgerKey(abonentOrId);
    if (!ledgerKey) return "";
    var raw = _getProjectRaw(ledgerKey);
    return String(raw === null || raw === undefined ? "" : raw);
  }

  function computeLedgerVersion(abonentOrId) {
    return computeLedgerRuntimeVersion(abonentOrId);
  }

  function readLedgerRuntimeCache(abonentOrId) {
    var key = resolveRuntimeCacheKey(abonentOrId);
    if (!key) return null;
    var raw = _getProjectRaw(key);
    if (raw === null || raw === undefined || raw === "") return null;
    try { return JSON.parse(String(raw)); } catch (e) { return null; }
  }

  function getRuntimeCache(abonentOrId) {
    return readLedgerRuntimeCache(abonentOrId);
  }

  function writeLedgerRuntimeCache(abonentOrId, payload) {
    if (!Data.ensureWriteOrExplain()) return false;
    var key = resolveRuntimeCacheKey(abonentOrId);
    if (!key) return false;
    var data = payload && typeof payload === "object" ? payload : {};
    return _setProjectRaw(key, JSON.stringify(data));
  }

  function setRuntimeCache(abonentOrId, payload) {
    return writeLedgerRuntimeCache(abonentOrId, payload);
  }

  function invalidateLedgerRuntimeCache(abonentOrId) {
    var key = resolveRuntimeCacheKey(abonentOrId);
    if (!key) return false;
    return _removeProjectRaw(key);
  }

  function invalidateRuntimeCache(abonentOrId) {
    return invalidateLedgerRuntimeCache(abonentOrId);
  }

  function readPaymentLedger(abonentOrId) {
    var found = _findAbonentByIdOrUid(abonentOrId);
    var id = String(found && found.id || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
    var canonicalKey = resolvePaymentLedgerKey(abonentOrId);
    if (canonicalKey) {
      var raw = _getProjectRaw(canonicalKey);
      if (raw !== null && raw !== undefined) return _cloneLedgerRows(_parseLedgerRows(raw, canonicalKey));
    }

    // Legacy read-only fallback: payments_<LS> may still exist for old localStorage data.
    var legacyKey = _legacyLedgerKeyForAbonent(id, found && found.abonent);
    if (legacyKey && legacyKey !== canonicalKey) {
      var legacyRaw = _getProjectRaw(legacyKey);
      if (legacyRaw !== null && legacyRaw !== undefined) {
        var legacyRows = _parseLedgerRows(legacyRaw, legacyKey);
        _logLegacyLedgerReadonlyFallback({
          abonentId: id,
          uid: String(found && found.abonent && found.abonent.uid || ""),
          legacyKey: legacyKey,
          canonicalKey: canonicalKey || "",
          legacyRowsCount: legacyRows.length,
          source: "readPaymentLedger"
        });
        return _cloneLedgerRows(legacyRows);
      }
    }
    return [];
  }

  function _logLedgerInit(payload) {
    try {
      console.log("[ledger-init]", payload || {});
    } catch (e) { }
  }

  function writePaymentLedger(abonentOrId, rows, options) {
    if (!Data.ensureWriteOrExplain()) return false;
    var opts = options || {};
    var found = _findAbonentByIdOrUid(abonentOrId);
    var id = String(found && found.id || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
    var abonent = found && found.abonent ? found.abonent : null;
    var uid = String(abonent && abonent.uid || "").trim();
    var key = resolvePaymentLedgerKey(abonentOrId);
    if (!key || !isValidUid(uid)) {
      console.warn("[financial][ledger-write-blocked]", { abonentId: id, reason: "UID_REQUIRED" });
      return false;
    }
    if (key !== "payments_" + uid || (id && id !== uid && key === "payments_" + id)) {
      console.warn("[financial][ledger-write-blocked]", { abonentId: id, uid: uid, key: key, reason: "LS_LEDGER_WRITE_FORBIDDEN" });
      return false;
    }
    var currentRaw = _getProjectRaw(key);
    if (currentRaw !== null && currentRaw !== undefined) {
      try {
        _parseLedgerRows(currentRaw, key);
      } catch (e) {
        console.warn("[financial][ledger-write-blocked]", { abonentId: id, uid: uid, key: key, reason: "LEDGER_JSON_INVALID" });
        return false;
      }
    }
    var payload = JSON.stringify(Array.isArray(rows) ? rows : []);
    var ok = _setProjectRaw(key, payload);
    if (ok !== false && opts.event !== false) {
      recordFinancialEvent(Object.assign({
        type: opts.eventType || "LEDGER_WRITE",
        sourceAbonentId: id,
        targetAbonentId: id,
        mode: opts.mode || "",
        date: opts.date || ""
      }, opts.event || {}));
    }
    if (ok !== false) {
      invalidateLedgerRuntimeCache(abonentOrId);
      if (opts.summaryDirtyReason !== false) {
        markAbonentSummaryDirtyLater(abonent || id, opts.summaryDirtyReason || "LEDGER_WRITE");
      }
    }
    return ok;
  }

  function createEmptyPaymentLedger(abonentOrId) {
    if (!Data.ensureWriteOrExplain()) return false;
    var found = _findAbonentByIdOrUid(abonentOrId);
    var id = String(found && found.id || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
    var abonent = found && found.abonent ? found.abonent : null;
    var uid = String(abonent && abonent.uid || "").trim();
    var key = resolvePaymentLedgerKey(abonentOrId);
    var legacyKey = _legacyLedgerKeyForAbonent(id, abonent);
    if (!key || !isValidUid(uid)) {
      _logLedgerInit({ abonentId: id, uid: uid, key: key || "", result: "blocked", reason: "UID_REQUIRED" });
      return false;
    }
    if (key !== "payments_" + uid || (id && id !== uid && key === "payments_" + id)) {
      _logLedgerInit({ abonentId: id, uid: uid, key: key, result: "blocked", reason: "LS_LEDGER_CREATE_FORBIDDEN" });
      return false;
    }
    if (legacyKey && legacyKey !== key && _hasLegacyLedgerRows(id, abonent)) {
      _logLedgerInit({ abonentId: id, uid: uid, key: key, legacyKey: legacyKey, result: "blocked", reason: "UID_MISSING_WITH_LEGACY_LEDGER" });
      _logUidGenerationBlockedLegacyLedger({ abonentId: id, uid: uid, legacyKey: legacyKey, canonicalKey: key, reason: "UID_MISSING_WITH_LEGACY_LEDGER", source: "createEmptyPaymentLedger" });
      return false;
    }

    var raw = _getProjectRaw(key);
    if (raw !== null && raw !== undefined) {
      try {
        _parseLedgerRows(raw, key);
      } catch (e) {
        _logLedgerInit({ abonentId: id, uid: uid, key: key, result: "blocked", reason: "LEDGER_JSON_INVALID" });
        return false;
      }
      _logLedgerInit({ abonentId: id, uid: uid, key: key, result: "exists" });
      return true;
    }

    var ok = _setProjectRaw(key, "[]");
    _logLedgerInit({ abonentId: id, uid: uid, key: key, result: ok === false ? "failed" : "created" });
    if (ok !== false) {
      recordFinancialEvent({
        type: "LEDGER_CREATE_EMPTY",
        sourceAbonentId: id,
        targetAbonentId: id
      });
    }
    return ok;
  }

  function normalizeFinancialMode(mode) {
    var raw = String(mode || "WITH_DEBT").trim().toUpperCase();
    if (raw === "NO_DEBT" || raw === "WITHOUT_DEBT") return "WITHOUT_DEBT";
    if (raw === "SPLIT_PREMISES") return "SPLIT_PREMISES";
    return "WITH_DEBT";
  }

  function recordFinancialEvent(event) {
    try {
      var ev = event && typeof event === "object" ? Object.assign({}, event) : {};
      var now = (new Date()).toISOString();
      var owner = _ownerId();
      var db = window.AbonentsDB || {};
      var sourceId = String(ev.sourceAbonentId || ev.oldAbonentId || "").trim();
      var targetId = String(ev.targetAbonentId || ev.newAbonentId || "").trim();
      var source = sourceId && db.abonents ? db.abonents[sourceId] : null;
      var target = targetId && db.abonents ? db.abonents[targetId] : null;
      ev.type = String(ev.type || "FINANCIAL_EVENT");
      ev.mode = ev.mode ? normalizeFinancialMode(ev.mode) : "";
      ev.sourceAbonentId = sourceId;
      ev.targetAbonentId = targetId;
      ev.premiseId = String(ev.premiseId || ev.regnum || (target && (target.premiseRegnum || target.regnum)) || (source && (source.premiseRegnum || source.regnum)) || "").trim();
      ev.regnum = String(ev.regnum || ev.premiseId || "").trim();
      ev.date = String(ev.date || "").trim();
      ev.ownerId = String(ev.ownerId || owner || "");
      ev.createdAt = String(ev.createdAt || now);
      if (ev.debtAmount !== undefined) ev.debtAmount = Number(ev.debtAmount) || 0;
      if (ev.balanceAmount !== undefined) ev.balanceAmount = Number(ev.balanceAmount) || 0;
      var key = "jkh_financial_events_v1";
      var raw = _getProjectRaw(key);
      var arr = [];
      if (raw) {
        try { arr = JSON.parse(raw); } catch (e) { arr = []; }
      }
      if (!Array.isArray(arr)) arr = [];
      arr.push(ev);
      _setProjectRaw(key, JSON.stringify(arr));
      return ev;
    } catch (e) {
      try { console.warn("[financial][event-log-failed]", e); } catch (e2) {}
      return null;
    }
  }


  window.JKHDebugListLegacyPaymentKeys = function() {
    try {
      return Object.keys(localStorage).filter(function(k){
        return k.includes('payments_') && !k.includes('uid_');
      });
    } catch (e) {
      return [];
    }
  };

  function _safeLedgerInfoForDiagnostic(key) {
    try {
      return _readLedgerRowsInfo(key);
    } catch (e) {
      return {
        key: key || "",
        exists: true,
        rowsCount: 0,
        rows: [],
        error: String(e && (e.code || e.message) || e || "LEDGER_JSON_INVALID")
      };
    }
  }

  window.JKH_diagnoseLedger = function() {
    var db = window.AbonentsDB || {};
    var abonents = db && db.abonents && typeof db.abonents === "object" ? db.abonents : {};
    var report = Object.keys(abonents).sort().map(function(id) {
      var a = abonents[id] || {};
      var accountNumber = _accountNumberForLedger(id, a);
      var uid = String(a.uid || a.account_uid || a.accountUid || "").trim();
      var uidValid = isValidUid(uid);
      var canonicalKey = uidValid ? ("payments_" + uid) : "";
      var legacyKey = _legacyLedgerKeyForAbonent(id, a);
      var canonical = canonicalKey ? _safeLedgerInfoForDiagnostic(canonicalKey) : { exists: false, rowsCount: 0 };
      var legacy = legacyKey ? _safeLedgerInfoForDiagnostic(legacyKey) : { exists: false, rowsCount: 0 };
      var hasCanonical = !!canonical.exists;
      var hasLegacy = !!(legacy.exists && legacyKey !== canonicalKey);
      var state = "EMPTY";

      if (uid && !uidValid) state = "INVALID_UID";
      else if (!uid && hasLegacy && legacy.rowsCount > 0) state = "UID_MISSING_WITH_LEGACY";
      else if (!uid) state = "UID_MISSING_EMPTY";
      else if (hasCanonical && hasLegacy) state = "MIXED_CANONICAL_AND_LEGACY";
      else if (hasCanonical) state = "CANONICAL_OK";
      else if (hasLegacy) state = "LEGACY_ONLY";

      return {
        abonentId: id,
        accountNumber: accountNumber,
        uid: uid,
        uidValid: uidValid,
        canonicalKey: canonicalKey,
        hasCanonical: hasCanonical,
        canonicalRowsCount: Number(canonical.rowsCount || 0),
        legacyKey: legacyKey,
        hasLegacy: hasLegacy,
        legacyRowsCount: Number(legacy.rowsCount || 0),
        state: state
      };
    });
    try { console.table(report); } catch (e) {}
    return report;
  };

  function _summaryItemsForLedgerMigrationVerification(options) {
    var opts = options || {};
    var raw = Array.isArray(opts.summaryItems) ? opts.summaryItems
      : (Array.isArray(opts.summaries) ? opts.summaries
      : (Array.isArray(opts.abonentSummaries) ? opts.abonentSummaries : []));
    return raw.map(function(item) {
      var summary = item && item.summary && typeof item.summary === "object" ? item.summary : item;
      return {
        account_uid: String(item && (item.account_uid || item.uid) || summary && (summary.account_uid || summary.uid) || "").trim(),
        abonent_id: String(item && (item.abonent_id || item.abonentId || item.id) || summary && (summary.abonent_id || summary.id) || "").trim(),
        summary_status: String(item && (item.summary_status || item.status) || summary && (summary.summary_status || summary.status) || "").trim()
      };
    }).filter(function(item) {
      return !!(item.account_uid || item.abonent_id);
    });
  }

  function _runtimeCacheStateForMigrationVerification(abonentId, uid, canonicalKey, canonical) {
    var key = isValidUid(uid) ? ("ledger_runtime_cache_" + uid) : "";
    if (!key) return { runtimeCacheKey: "", hasRuntimeCache: false, runtimeCacheStale: false };
    var raw = _getProjectRaw(key);
    if (raw === null || raw === undefined || raw === "") {
      return { runtimeCacheKey: key, hasRuntimeCache: false, runtimeCacheStale: false };
    }
    var parsed = null;
    try { parsed = JSON.parse(String(raw)); } catch (e) {
      return { runtimeCacheKey: key, hasRuntimeCache: true, runtimeCacheStale: true, runtimeCacheReason: "RUNTIME_CACHE_JSON_INVALID" };
    }
    var expectedVersion = canonicalKey ? String(_getProjectRaw(canonicalKey) === null || _getProjectRaw(canonicalKey) === undefined ? "" : _getProjectRaw(canonicalKey)) : "";
    var actualVersion = String(parsed && parsed.ledgerVersion || "");
    var stale = !!(canonical && canonical.exists && actualVersion !== expectedVersion);
    return {
      runtimeCacheKey: key,
      hasRuntimeCache: true,
      runtimeCacheStale: stale,
      runtimeCacheReason: stale ? "LEDGER_VERSION_MISMATCH" : ""
    };
  }

  function _ledgerRowsChecksum(rows) {
    try {
      var normalized = (Array.isArray(rows) ? rows : []).map(function(row) {
        if (!row || typeof row !== "object") return row;
        var out = {};
        Object.keys(row).sort().forEach(function(k) { out[k] = row[k]; });
        return out;
      });
      return JSON.stringify(normalized);
    } catch (e) {
      return "";
    }
  }

  function _ledgerSimpleTotals(rows) {
    var totalAccrued = 0;
    var totalPaid = 0;
    (Array.isArray(rows) ? rows : []).forEach(function(row) {
      totalAccrued += _summaryNumber(row && row.accrued);
      totalPaid += _summaryNumber(row && row.paid);
    });
    return {
      totalAccrued: Math.round(totalAccrued * 100) / 100,
      totalPaid: Math.round(totalPaid * 100) / 100
    };
  }

  function _mixedLedgerComparison(canonical, legacy) {
    var canonicalRows = Array.isArray(canonical && canonical.rows) ? canonical.rows : [];
    var legacyRows = Array.isArray(legacy && legacy.rows) ? legacy.rows : [];
    var canonicalTotals = _ledgerSimpleTotals(canonicalRows);
    var legacyTotals = _ledgerSimpleTotals(legacyRows);
    return {
      legacyRowsCount: legacyRows.length,
      canonicalRowsCount: canonicalRows.length,
      checksumEqual: _ledgerRowsChecksum(canonicalRows) === _ledgerRowsChecksum(legacyRows),
      totalsEqual: canonicalTotals.totalAccrued === legacyTotals.totalAccrued && canonicalTotals.totalPaid === legacyTotals.totalPaid
    };
  }

  function _migrationVerificationItem(abonentId, abonent, summaryByUid) {
    var id = String(abonentId || "").trim();
    var a = abonent || {};
    var accountNumber = _accountNumberForLedger(id, a);
    var uid = String(a.uid || a.account_uid || a.accountUid || "").trim();
    var uidValid = isValidUid(uid);
    var canonicalKey = uidValid ? ("payments_" + uid) : "";
    var legacyKey = _legacyLedgerKeyForAbonent(id, a);
    var canonical = canonicalKey ? _safeLedgerInfoForDiagnostic(canonicalKey) : { exists: false, rowsCount: 0, error: "" };
    var legacy = legacyKey ? _safeLedgerInfoForDiagnostic(legacyKey) : { exists: false, rowsCount: 0, error: "" };
    var runtime = _runtimeCacheStateForMigrationVerification(id, uid, canonicalKey, canonical);
    var issues = [];
    var canMigrate = false;
    var state = "EMPTY_NO_LEDGER";

    if (canonical.error) issues.push("CANONICAL_LEDGER_INVALID");
    if (legacy.error) issues.push("LEGACY_LEDGER_INVALID");
    if (runtime.runtimeCacheStale) issues.push("STALE_RUNTIME_CACHE");

    if (uid && !uidValid) {
      state = "BLOCKED_INVALID_UID";
      issues.push("INVALID_UID");
    } else if (!uid && legacy.rowsCount > 0) {
      state = "BLOCKED_UID_MISSING_WITH_LEGACY";
      issues.push("UID_MISSING_WITH_LEGACY_LEDGER");
    } else if (!uid) {
      state = "UID_MISSING_EMPTY";
      issues.push("UID_MISSING");
    } else if (canonical.rowsCount > 0 && legacy.rowsCount > 0) {
      state = "BLOCKED_MIXED_LEDGER";
      issues.push("MIXED_CANONICAL_AND_LEGACY");
    } else if (legacy.rowsCount > 0 && canonical.rowsCount <= 0 && !canonical.error && !legacy.error) {
      state = canonical.exists ? "READY_TO_MIGRATE_EMPTY_CANONICAL" : "READY_TO_MIGRATE";
      canMigrate = true;
    } else if (canonical.rowsCount > 0) {
      state = "CANONICAL_OK";
    } else if (legacy.exists) {
      state = "LEGACY_EMPTY";
    } else if (canonical.exists) {
      state = "CANONICAL_EMPTY";
    }

    var summary = uid ? summaryByUid[uid] : null;
    return {
      abonentId: id,
      accountNumber: accountNumber,
      uid: uid,
      uidValid: uidValid,
      canonicalKey: canonicalKey,
      hasCanonical: !!canonical.exists,
      canonicalRowsCount: Number(canonical.rowsCount || 0),
      legacyKey: legacyKey,
      hasLegacy: !!(legacy.exists && legacyKey !== canonicalKey),
      legacyRowsCount: Number(legacy.rowsCount || 0),
      runtimeCacheKey: runtime.runtimeCacheKey || "",
      hasRuntimeCache: !!runtime.hasRuntimeCache,
      runtimeCacheStale: !!runtime.runtimeCacheStale,
      summaryStatus: String(summary && summary.summary_status || ""),
      mixedComparison: canonical.rowsCount > 0 && legacy.rowsCount > 0 ? _mixedLedgerComparison(canonical, legacy) : null,
      canMigrate: canMigrate,
      state: state,
      issues: issues.join(",")
    };
  }

  function _findMigrationVerificationAbonent(abonentId) {
    var db = window.AbonentsDB || {};
    var abonents = db && db.abonents && typeof db.abonents === "object" ? db.abonents : {};
    var found = _findAbonentByIdOrUid(abonentId);
    var id = String(found && found.id || abonentId || "").trim();
    var abonent = found && found.abonent ? found.abonent : (id && abonents[id] ? abonents[id] : null);
    return { id: id, abonent: abonent };
  }

  function _whySummaryFreshBlocked(item) {
    if (!item) return "UNKNOWN";
    if (item.state === "READY_TO_MIGRATE" || item.state === "READY_TO_MIGRATE_EMPTY_CANONICAL") return "LEGACY_LEDGER_MIGRATION_REQUIRED";
    if (item.state === "BLOCKED_UID_MISSING_WITH_LEGACY") return "UID_MISSING_WITH_LEGACY_LEDGER";
    if (item.state === "BLOCKED_MIXED_LEDGER") return "MIXED_LEDGER_DIFFERENCE";
    if (item.state === "BLOCKED_INVALID_UID") return "INVALID_UID";
    if (item.state === "CANONICAL_EMPTY") return "CANONICAL_LEDGER_EMPTY";
    if (item.summaryStatus && item.summaryStatus !== "fresh") return "SUMMARY_NOT_FRESH";
    return "";
  }

  function _whyIndexTotalsEmpty(item, abonent) {
    if (!item) return "UNKNOWN";
    var blocked = _whySummaryFreshBlocked(item);
    if (blocked) return blocked;
    if (item.summaryStatus && item.summaryStatus !== "fresh") return "SUMMARY_NOT_FRESH";
    if (item.state === "CANONICAL_EMPTY" || (item.hasCanonical && item.canonicalRowsCount <= 0)) return "CANONICAL_LEDGER_EMPTY";
    if (item.state === "BLOCKED_MIXED_LEDGER") return "MIXED_LEDGER_DIFFERENCE";
    var hasResponsibilityStart = !!String(abonent && (
      abonent.calcStartDate || abonent.calc_start_date || abonent.dateFrom || abonent.date_from ||
      abonent.responsibilityFrom || abonent.respFrom || abonent.startCalc || abonent.start_calc
    ) || "").trim();
    if (!hasResponsibilityStart) return "RESPONSIBILITY_PERIOD_MISSING";
    if (item.summaryStatus === "fresh") return "TOTALS_EMPTY";
    return "UNKNOWN";
  }

  function _debugAbonentLedgerReport(abonentId) {
    var found = _findMigrationVerificationAbonent(abonentId);
    var abonent = found.abonent || {};
    var item = found.abonent ? _migrationVerificationItem(found.id, found.abonent, {}) : null;
    var blockers = item && item.issues ? String(item.issues).split(",").filter(Boolean) : [];
    var warnings = [];
    if (item && item.runtimeCacheStale) warnings.push("STALE_RUNTIME_CACHE");
    if (item && item.state === "LEGACY_EMPTY") warnings.push("LEGACY_LEDGER_EMPTY");
    return {
      abonentId: found.id,
      fio: String(abonent && (abonent.fio || abonent.full_name || abonent.fullName || abonent.display_name) || "").trim(),
      uid: item ? item.uid : "",
      uidStatus: item ? (item.uidValid ? "valid" : (item.uid ? "invalid" : "missing")) : "missing",
      canonicalKey: item ? item.canonicalKey : "",
      hasCanonical: !!(item && item.hasCanonical),
      canonicalRowsCount: item ? item.canonicalRowsCount : 0,
      legacyKey: item ? item.legacyKey : "",
      hasLegacy: !!(item && item.hasLegacy),
      legacyRowsCount: item ? item.legacyRowsCount : 0,
      state: item ? item.state : "ABONENT_NOT_FOUND",
      safeToMigrate: !!(item && item.canMigrate),
      blockers: blockers,
      warnings: warnings,
      whySummaryFreshBlocked: item ? (_whySummaryFreshBlocked(item) || "") : "UNKNOWN",
      whyIndexTotalsEmpty: item ? _whyIndexTotalsEmpty(item, abonent) : "UNKNOWN",
      mixedComparison: item && item.mixedComparison ? item.mixedComparison : null
    };
  }

  window.JKH_verifyLedgerMigration = function(options) {
    var opts = options || {};
    var db = window.AbonentsDB || {};
    var abonents = db && db.abonents && typeof db.abonents === "object" ? db.abonents : {};
    var summaryByUid = {};
    var orphanSummaries = [];

    Object.keys(abonents).forEach(function(id) {
      var uid = String(abonents[id] && abonents[id].uid || "").trim();
      if (uid) summaryByUid[uid] = null;
    });

    _summaryItemsForLedgerMigrationVerification(opts).forEach(function(item) {
      if (item.account_uid && Object.prototype.hasOwnProperty.call(summaryByUid, item.account_uid)) {
        summaryByUid[item.account_uid] = item;
      } else {
        orphanSummaries.push({
          abonentId: item.abonent_id || "",
          accountNumber: "",
          uid: item.account_uid || "",
          uidValid: item.account_uid ? isValidUid(item.account_uid) : false,
          canonicalKey: item.account_uid ? ("payments_" + item.account_uid) : "",
          hasCanonical: false,
          canonicalRowsCount: 0,
          legacyKey: "",
          hasLegacy: false,
          legacyRowsCount: 0,
          runtimeCacheKey: "",
          hasRuntimeCache: false,
          runtimeCacheStale: false,
          summaryStatus: item.summary_status || "",
          canMigrate: false,
          state: "BLOCKED_ORPHAN_SUMMARY",
          issues: "ORPHAN_SUMMARY"
        });
      }
    });

    var items = Object.keys(abonents).sort().map(function(id) {
      return _migrationVerificationItem(id, abonents[id], summaryByUid);
    }).concat(orphanSummaries);

    var counters = {
      total: items.length,
      readyToMigrate: 0,
      blocked: 0,
      canonicalOk: 0,
      staleRuntimeCache: 0,
      orphanSummary: orphanSummaries.length
    };
    items.forEach(function(item) {
      if (item.canMigrate) counters.readyToMigrate++;
      if (String(item.state || "").indexOf("BLOCKED_") === 0) counters.blocked++;
      if (item.state === "CANONICAL_OK") counters.canonicalOk++;
      if (item.runtimeCacheStale) counters.staleRuntimeCache++;
    });

    var result = {
      ok: counters.blocked === 0,
      readOnly: true,
      mode: "verification-only",
      counters: counters,
      items: items
    };
    try { console.table(items); } catch (e) {}
    try { console.log("[ledger][migration-verification]", { counters: counters, readOnly: true }); } catch (e2) {}
    return result;
  };

  window.JKH_verifyLedgerMigrationForAbonent = function(abonentId) {
    var found = _findMigrationVerificationAbonent(abonentId);
    var report = found.abonent
      ? _migrationVerificationItem(found.id, found.abonent, {})
      : {
        abonentId: String(abonentId || "").trim(),
        accountNumber: "",
        uid: "",
        uidValid: false,
        canonicalKey: "",
        hasCanonical: false,
        canonicalRowsCount: 0,
        legacyKey: "",
        hasLegacy: false,
        legacyRowsCount: 0,
        runtimeCacheKey: "",
        hasRuntimeCache: false,
        runtimeCacheStale: false,
        summaryStatus: "",
        mixedComparison: null,
        canMigrate: false,
        state: "ABONENT_NOT_FOUND",
        issues: "ABONENT_NOT_FOUND"
      };
    try { console.table([report]); } catch (e) {}
    try { console.log("[ledger-migration][abonent-verification]", report); } catch (e2) {}
    return report;
  };

  window.JKH_debugAbonentLedger = function(abonentId) {
    var report = _debugAbonentLedgerReport(abonentId);
    try { console.table([report]); } catch (e) {}
    try { console.log("[ledger-migration][abonent-debug]", report); } catch (e2) {}
    return report;
  };


  window.getPaymentsKeyForAbonent = getPaymentsKeyForAbonent;
  window.getAbonentTechId = getAbonentTechId;
  window.JKHInvalidatePaymentKeyCache = _resetPaymentKeyResolveCache;

  function _todayStamp() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    return String(y) + m + dd;
  }
  function _generateUniqueTempRegnum(db) {
    var stamp = _todayStamp();
    var premises = (db && db.premises && typeof db.premises === "object") ? db.premises : {};
    for (var i = 0; i < 10000; i++) {
      var suffix = String(i).padStart(4, "0");
      var candidate = "TEMP-" + stamp + "-" + suffix;
      if (!premises[candidate]) return candidate;
    }
    throw new Error("MERGE_TEMP_REGNUM_EXHAUSTED");
  }

  function removeProjectKeys() {
    // ВАЖНО: сброс делаем в рамках выбранной базы (scoped).
    // admin в режиме "ALL" — сбрасывает ВСЕ пользовательские базы.
    var owners = [];
    if (_isAllMode()) {
      try {
        var users = (window.Auth && typeof Auth.adminListUsers === "function") ? Auth.adminListUsers() : [];
        if (Array.isArray(users)) {
          for (var i = 0; i < users.length; i++) if (users[i] && users[i].id) owners.push(users[i].id);
        }
      } catch (e) { }
    } else {
      owners = [_ownerId()];
    }

    for (var oi = 0; oi < owners.length; oi++) {
      var owner = owners[oi];

      // exact keys
      for (var ei = 0; ei < PROJECT_KEY_EXACT.length; ei++) {
        var ek = PROJECT_KEY_EXACT[ei];
        try { _adminRemoveForOwner(owner, ek); } catch (e) { }
      }

      // prefixes (scoped)
      var pref = (window.JKHStorage && typeof JKHStorage.scopePrefixFor === "function")
        ? JKHStorage.scopePrefixFor(owner)
        : ("jkhdb::" + String(owner) + "::");

      var ownerKeys = [];
      try { ownerKeys = _adminKeysForOwner(owner); } catch (e2) { ownerKeys = []; }

      for (var ki = 0; ki < ownerKeys.length; ki++) {
        var kk = ownerKeys[ki];
        if (!kk) continue;
        if (kk.indexOf(pref) !== 0) continue;

        var tail = kk.slice(pref.length);
        for (var pi = 0; pi < PROJECT_KEY_PREFIXES.length; pi++) {
          if (tail.indexOf(PROJECT_KEY_PREFIXES[pi]) === 0) {
            // kk — уже full key, но removeRawForOwner ожидает baseKey (не full).
            // Поэтому удаляем по baseKey = tail.
            try { _adminRemoveForOwner(owner, tail); } catch (e3) { }
            break;
          }
        }
      }
    }

    // sessionStorage можно чистить, но НЕ трогаем Auth-сессию намеренно.
    // (логин/выбор базы остаются)
    try { sessionStorage.clear(); } catch (e) { }
  }

  // ============================================================
  // AbonentsDB base (пустая структура)
  // ============================================================
  const BASE_DB = {
    orgName: 'ТСЖ "Карла Маркса 50"',
    orgInn: "4909093352",
    chairman: "В.Б.Тремов",

    // новая структура
    premises: {},   // {regnum: {regnum, city, street, house, flat, square, createdAt}}
    links: [],      // [{abonentId, regnum, dateFrom, dateTo}]
    premiseEvents: [], // [{id,type,date,fromRegnums,toRegnums,...}]

    // абоненты
    abonents: {}    // {id: {...}}
  };

  function mergePreferStored(baseDb, storedDb) {
    const out = deepClone(baseDb);

    if (isPlainObject(storedDb)) {
      ["orgName", "orgInn", "chairman"].forEach((k) => {
        if (storedDb[k] !== undefined && storedDb[k] !== null) out[k] = storedDb[k];
      });

      if (isPlainObject(storedDb.abonents)) {
        out.abonents = out.abonents || {};
        Object.keys(storedDb.abonents).forEach((id) => {
          out.abonents[id] = storedDb.abonents[id];
        });
      }

      if (isPlainObject(storedDb.premises)) {
        out.premises = out.premises || {};
        Object.keys(storedDb.premises).forEach((regnum) => {
          out.premises[regnum] = storedDb.premises[regnum];
        });
      }

      if (Array.isArray(storedDb.links)) out.links = storedDb.links;
      if (Array.isArray(storedDb.premiseEvents)) out.premiseEvents = storedDb.premiseEvents;
    }

    return out;
  }

  function loadFromStorage() {
    // admin ALL-mode: объединённый просмотр всех баз (READONLY)
    if (_isAllMode()) {
      var merged = { version: 1, premises: {}, links: [], abonents: {} };
      try {
        var users = (window.Auth && typeof Auth.adminListUsers === "function") ? Auth.adminListUsers() : [];
        if (Array.isArray(users)) {
          for (var i = 0; i < users.length; i++) {
            var uid = users[i] && users[i].id;
            if (!uid) continue;

            // читать чужую базу можно в ALL-mode (read-only)
            var rawU = null;
            try {
              if (window.JKHStore && JKHStore.admin && typeof JKHStore.admin.getRawForOwner === "function") {
                rawU = JKHStore.admin.getRawForOwner(uid, KEY_DB);
              } else {
                rawU = _getRawScoped(KEY_DB, uid);
              }
            } catch (e0) {
              rawU = _getRawScoped(KEY_DB, uid);
            }

            var parsedU = safeJsonParse(rawU, null);
            if (parsedU && typeof parsedU === "object") {
              // premises
              if (parsedU.premises && typeof parsedU.premises === "object") {
                for (var pr in parsedU.premises) merged.premises[pr] = parsedU.premises[pr];
              }
              // links
              if (Array.isArray(parsedU.links)) {
                for (var j = 0; j < parsedU.links.length; j++) {
                  var L = parsedU.links[j];
                  if (L && typeof L === "object") {
                    var L2 = Object.assign({}, L);
                    L2._ownerId = uid;
                    merged.links.push(L2);
                  }
                }
              }
              // abonents
              if (parsedU.abonents && typeof parsedU.abonents === "object") {
                for (var a in parsedU.abonents) {
                  var A = parsedU.abonents[a];
                  if (!A) continue;
                  var A2 = Object.assign({}, A);
                  A2._ownerId = uid;
                  merged.abonents[a] = A2;
                }
              }
            }
          }
        }
      } catch (e) { }
      window.JKH_DB_READONLY = true;
      return merged;
    }

    window.JKH_DB_READONLY = false;
    const raw = _getRawScoped(KEY_DB);
    const parsed = safeJsonParse(raw, null);
    return parsed && typeof parsed === "object" ? parsed : null;
  }


  function _isCalcPeriodCleanupServerDataReady(db) {
    var st = window.JKH_UI_STATE && window.JKH_UI_STATE.data;
    if (st && (st.status !== "ready" && st.status !== "empty")) return false;
    if (st && Object.prototype.hasOwnProperty.call(st, "source") && st.source && st.source !== "server") return false;
    var rawDb = _getRawScoped(KEY_DB, _ownerId());
    if (rawDb !== null && rawDb !== undefined && rawDb !== "") {
      try { JSON.parse(String(rawDb)); } catch (e) { return false; }
    }
    return !!(db && db.abonents && typeof db.abonents === "object");
  }

  function _currentAbonentIdFromLocation() {
    try {
      var params = new URLSearchParams(window.location && window.location.search || "");
      return String(params.get("abonent") || "").trim();
    } catch (e) {
      return "";
    }
  }

  function _calcPeriodMigrationIdsForDb(db) {
    var abonents = db && db.abonents && typeof db.abonents === "object" ? db.abonents : {};
    var currentId = _currentAbonentIdFromLocation();
    if (currentId && abonents[currentId]) return [currentId];
    return Object.keys(abonents);
  }

  function migrateLegacyCalcPeriodKeysForDb(db) {
    if (!_isCalcPeriodCleanupServerDataReady(db)) return 0;
    var migrated = 0;
    var kept = 0;
    var skippedForeign = 0;
    var ownerId = _ownerId();
    var hasCurrentAbonentScope = !!_currentAbonentIdFromLocation();
    _calcPeriodMigrationIdsForDb(db).forEach(function (abonentId) {
      var a = db.abonents[abonentId] || {};
      var uid = String(a.uid || "").trim();
      if (!isValidUid(uid)) {
        if (uid) _logInvalidUidCanonicalBlocked({ abonentId: String(abonentId || ""), uid: uid, source: "migrateLegacyCalcPeriodKeysForDb" });
        return;
      }
      [
        { prefix: "calc_period_", canonicalKey: resolveCalcPeriodStorageKey(a) },
        { prefix: "calc_period_active_", canonicalKey: resolveCalcPeriodActiveStorageKey(a) }
      ].forEach(function (meta) {
        if (!meta.canonicalKey) return;
        var aliases = [abonentId, a.id, a.ls, a.account, a.accountNumber, a.personalAccount, a.regnum, a.premiseRegnum];
        aliases.forEach(function (alias) {
          var suffix = String(alias || "").trim();
          if (!suffix || suffix === uid) return;
          var legacyKey = meta.prefix + suffix;
          var val = _getRawScoped(legacyKey, ownerId);
          if (val !== null && val !== undefined) {
            if (_getRawScoped(meta.canonicalKey, ownerId) === null) _setRawScoped(meta.canonicalKey, val, ownerId);
            var check = _getRawScoped(meta.canonicalKey, ownerId);
            if (check === val) {
              try { console.warn("[calc-period][canonical-readback-ok]", { from: legacyKey, to: meta.canonicalKey, ownerId: ownerId, abonentId: String(abonentId || ""), uid: uid }); } catch (eOk) {}
              _removeRawScoped(legacyKey, ownerId);
              migrated++;
            } else {
              kept++;
              try { console.warn("[calc-period][cleanup-skipped-readback-failed]", { from: legacyKey, to: meta.canonicalKey, ownerId: ownerId, abonentId: String(abonentId || ""), uid: uid }); } catch (eFail) {}
            }
          }
        });
      });
    });
    if (hasCurrentAbonentScope) {
      var allAbonents = db && db.abonents && typeof db.abonents === "object" ? Object.keys(db.abonents).length : 0;
      skippedForeign = Math.max(0, allAbonents - _calcPeriodMigrationIdsForDb(db).length);
    }
    try { console.warn("[calc-period][legacy-summary]", { migrated: migrated, kept: kept, skippedForeign: skippedForeign }); } catch (eSummary) {}
    return migrated;
  }


  function saveToStorage(db) {
    if (!_canWriteStorage()) return false;
    migrateLegacyCalcPeriodKeysForDb(db);
    try {
      _setRawScoped(KEY_DB, JSON.stringify(db));
      return true;
    } catch (e) {
      return false;
    }
  }

  function generateUniqueAbonentUid(db) {
    var abonents = db && db.abonents && typeof db.abonents === "object" ? db.abonents : {};
    var used = {};
    Object.keys(abonents).forEach(function (id) {
      var uid = String(abonents[id] && abonents[id].uid || "").trim();
      if (uid) used[uid] = true;
    });

    for (var i = 0; i < 50; i++) {
      var candidate = (typeof window.generateUid === "function")
        ? String(window.generateUid()).trim()
        : ("uid_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8));
      if (candidate && !used[candidate]) return candidate;
    }

    return "uid_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 12);
  }

  function ensureAbonentUidOnRecord(db, abonentId, abonent, options) {
    var opts = options || {};
    var id = String(abonentId || "").trim();
    var a = abonent || null;
    var currentUid = String(a && a.uid || "").trim();

    try {
      console.log("[abonent][uid-check]", {
        abonentId: id,
        uid: currentUid,
        source: String(opts.source || "data")
      });
    } catch (e) {}

    if (!a) return { ok: false, uid: "", changed: false, reason: "ABONENT_NOT_FOUND" };
    if (isValidUid(currentUid)) return { ok: true, uid: currentUid, changed: false };
    if (currentUid) {
      _logInvalidUidCanonicalBlocked({ abonentId: id, uid: currentUid, source: String(opts.source || "data") });
      return { ok: false, uid: currentUid, changed: false, reason: "INVALID_UID" };
    }
    if (_hasLegacyLedgerRows(id, a)) {
      var legacyKey = _legacyLedgerKeyForAbonent(id, a);
      _logUidGenerationBlockedLegacyLedger({
        abonentId: id,
        uid: "",
        legacyKey: legacyKey,
        canonicalKey: "",
        legacyRowsCount: _readLedgerRowsInfo(legacyKey).rowsCount,
        source: String(opts.source || "data")
      });
      return { ok: false, uid: "", changed: false, reason: "UID_MISSING_WITH_LEGACY_LEDGER" };
    }

    var uid = generateUniqueAbonentUid(db);
    a.uid = uid;
    try {
      console.log("[abonent][uid-generated]", {
        abonentId: id,
        uid: uid,
        source: String(opts.source || "data")
      });
    } catch (e2) {}
    return { ok: true, uid: uid, changed: true };
  }

  async function ensureAbonentUid(abonentOrId, options) {
    var opts = options || {};
    var db = window.AbonentsDB || null;
    if (!db) return { ok: false, uid: "", changed: false, reason: "DB_NOT_READY" };
    if (!db.abonents || typeof db.abonents !== "object") db.abonents = {};

    var found = _findAbonentByIdOrUid(abonentOrId);
    var id = String(found && found.id || (abonentOrId && typeof abonentOrId === "object" ? abonentOrId.id : abonentOrId) || "").trim();
    var abonent = (found && found.abonent && db.abonents[id] === found.abonent) ? found.abonent : (id ? db.abonents[id] : null);

    if (!abonent && abonentOrId && typeof abonentOrId === "object") {
      var objUid = String(abonentOrId.uid || "").trim();
      if (isValidUid(objUid)) {
        var byUid = Object.keys(db.abonents).find(function (key) { return String(db.abonents[key] && db.abonents[key].uid || "").trim() === objUid; });
        if (byUid) { id = byUid; abonent = db.abonents[byUid]; }
      }
    }

    var result = ensureAbonentUidOnRecord(db, id, abonent, { source: opts.source || "ensureAbonentUid" });
    if (!result.ok) return result;

    var saved = false;
    try {
      normalizeDb(db);
      saved = saveToStorage(db) === true;
      if (saved) {
        _resetPaymentKeyResolveCache("ensure-abonent-uid");
        try { console.log("[abonent][uid-persist-ok]", { abonentId: id, uid: result.uid, storage: "local" }); } catch (eOk) {}
      } else {
        try { console.error("[abonent][uid-persist-failed]", { abonentId: id, uid: result.uid, reason: "LOCAL_SAVE_FAILED" }); } catch (eFail) {}
        return { ok: false, uid: result.uid, changed: true, reason: "LOCAL_SAVE_FAILED" };
      }
    } catch (e3) {
      try { console.error("[abonent][uid-persist-failed]", { abonentId: id, uid: result.uid, reason: String(e3 && e3.message || e3) }); } catch (eFail2) {}
      return { ok: false, uid: result.uid, changed: true, reason: "LOCAL_SAVE_EXCEPTION" };
    }

    try {
      if (window.Data && typeof window.Data.flushDbToServer === "function") {
        await window.Data.flushDbToServer();
        try { console.log("[abonent][uid-persist-ok]", { abonentId: id, uid: result.uid, storage: "server" }); } catch (eSrvOk) {}
      }
    } catch (e4) {
      try { console.warn("[abonent][uid-persist-failed]", { abonentId: id, uid: result.uid, storage: "server", reason: String(e4 && e4.message || e4) }); } catch (eSrvFail) {}
    }

    return result;
  }


  function isForbiddenDefaultDateString(v) {
    var s = String(v || "").trim();
    if (!s) return false;
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return !!(m && Number(m[1]) === 2000 && Number(m[2]) === 1 && Number(m[3]) === 1);
  }

  function safeFinancialDateValue(v) {
    return isForbiddenDefaultDateString(v) ? "" : String(v || "").trim();
  }

  function normalizeDb(db) {
    if (!db) return;

    if (!db.premises || typeof db.premises !== "object") db.premises = {};
    if (!Array.isArray(db.links)) db.links = [];
    if (!Array.isArray(db.premiseEvents)) db.premiseEvents = [];
    if (!db.abonents || typeof db.abonents !== "object") db.abonents = {};

    const hasLink = (abonentId, regnum) =>
      db.links.some(
        (l) =>
          String(l?.abonentId) === String(abonentId) &&
          String(l?.regnum) === String(regnum)
      );

    Object.keys(db.abonents).forEach((abonentId) => {
      const a = db.abonents[abonentId];
      if (!a) return;

      ensureAbonentUidOnRecord(db, abonentId, a, { source: "normalizeDb" });

      const regnum = String(a.regnum || a.premiseRegnum || "").trim();
      if (!regnum) return;

      // premises из абонента
      if (!db.premises[regnum]) {
        db.premises[regnum] = {
          regnum,
          city: a.city || "",
          street: a.street || "",
          house: a.house || "",
          flat: a.flat || "",
          square: a.square ?? a.totalArea ?? "",
          createdAt: safeFinancialDateValue(a.premiseCreatedAt || a.premiseCreated),
          officialRegnum: normalizeOfficialRegnumValue(a.officialRegnum || ""),
          regnumType: a.officialRegnum ? "official" : "temp"
        };
      }

      // links
      if (!hasLink(abonentId, regnum)) {
        db.links.push({
          abonentId: String(abonentId),
          regnum,
          dateFrom: a.calcStartDate || a.startDate || "",
          dateTo: a.calcEndDate || a.endDate || ""
        });
      }

      // нормализуем
      a.premiseRegnum = regnum;
    });

    Object.keys(db.premises).forEach((regKey) => {
      const p = db.premises[regKey];
      if (!p || typeof p !== "object") return;
      const officialRegnum = normalizeOfficialRegnumValue(p.officialRegnum);
      p.officialRegnum = officialRegnum;
      p.createdAt = safeFinancialDateValue(p.createdAt);
      if (officialRegnum) p.regnumType = "official";
      else if (!String(p.regnumType || "").trim()) p.regnumType = "temp";
      console.log("[premises][official-regnum] normalized", String(regKey));
    });

    // чистим битые links
    db.links = db.links.filter((l) => {
      const abonentOk = !!db.abonents?.[String(l?.abonentId)];
      const premiseOk = !!db.premises?.[String(l?.regnum || "").trim()];
      return abonentOk && premiseOk;
    });
  }

  function _uidRepairRelatedKeysExist(id, uid, ownerId) {
    var suffixes = [String(id || "").trim(), String(uid || "").trim()];
    var prefixes = ["payments_", "calc_period_", "calc_period_active_", "report_period_", "moratorium_"];
    for (var i = 0; i < suffixes.length; i++) {
      var s = suffixes[i];
      if (!s) continue;
      for (var p = 0; p < prefixes.length; p++) {
        if (_getRawScoped(prefixes[p] + s, ownerId) !== null) return true;
      }
      if (_getRawScoped("jkh_transfer_to_v1:" + s, ownerId) !== null) return true;
      if (_getRawScoped("jkh_transfer_balance_v1:" + s, ownerId) !== null) return true;
      if (_getRawScoped("jkh_freeze_to_v1:" + s, ownerId) !== null) return true;
      if (_getRawScoped("jkh_frozen_debt_v1:" + s, ownerId) !== null) return true;
    }
    return false;
  }

  function scanAndRepairInvalidUids(db) {
    if (!db || !db.abonents || typeof db.abonents !== "object") return 0;
    var repaired = 0;
    var ownerId = _ownerId();
    Object.keys(db.abonents).forEach(function (id) {
      var a = db.abonents[id];
      if (!a || typeof a !== "object") return;
      var uid = String(a.uid || "").trim();
      if (isValidUid(uid)) return;
      try { console.warn("[uid][invalid-placeholder-detected]", { abonentId: String(id || ""), uid: uid }); } catch (eWarn) {}
      if (_uidRepairRelatedKeysExist(id, uid, ownerId)) {
        try { console.warn("[uid][repair-skipped-related-keys]", { abonentId: String(id || ""), uid: uid }); } catch (eSkip) {}
        return;
      }
      var next = generateUniqueAbonentUid(db);
      if (!isValidUid(next)) return;
      a.uid = next;
      repaired++;
      try { console.warn("[uid][repair-generated]", { abonentId: String(id || ""), uid: next, oldUid: uid }); } catch (eOk) {}
    });
    return repaired;
  }

  // ============================================================
  // INIT global DB
  // ============================================================
  const stored = loadFromStorage();
  if (!_isAllMode()) window.JKH_DATA_READY = !!stored;
  window.AbonentsDB = stored ? mergePreferStored(BASE_DB, stored) : deepClone(BASE_DB);
  normalizeDb(window.AbonentsDB);
  scanAndRepairInvalidUids(window.AbonentsDB);
  migrateLegacyCalcPeriodKeysForDb(window.AbonentsDB);
  if (stored && _canWriteStorage()) saveToStorage(window.AbonentsDB);
  _resetPaymentKeyResolveCache('initial-load');

  window.saveAbonentsDB = function () {
    if (!window.AbonentsDB) return;
    normalizeDb(window.AbonentsDB);
    _resetPaymentKeyResolveCache('save-abonents-db');
    return saveToStorage(window.AbonentsDB);
  };

  window.canWriteOrExplain = canWriteOrExplain;
  window.canWriteToStorage = _canWriteStorage;

  // ============================================================
  // Passive abonent summary API (read-only derived cache)
  // ============================================================
  async function loadAbonentSummaryPage(options) {
    var opts = options || {};
    var page = parseInt(opts.page, 10);
    var perPage = parseInt(opts.per_page || opts.limit, 10);
    if (!page || page < 1) page = 1;
    if (!perPage || perPage < 1) perPage = 20;

    var params = new URLSearchParams();
    params.set("page", String(page));

    var exactSummaryLookup = !!(opts.abonent_id || opts.account_uid || opts.account_number);
    if (exactSummaryLookup) {
      params.set("per_page", String(perPage));
      if (opts.abonent_id) params.set("abonent_id", String(opts.abonent_id));
      if (opts.account_uid) params.set("account_uid", String(opts.account_uid));
      if (opts.account_number) params.set("account_number", String(opts.account_number));
    } else {
      params.set("limit", String(perPage));
      if (opts.query) params.set("query", String(opts.query));
      if (opts.status) params.set("status", String(opts.status));
      if (opts.summary_status) params.set("summary_status", String(opts.summary_status));
    }

    var res = await fetch((exactSummaryLookup ? "/api/abonent_summary?" : "/api/abonents?") + params.toString(), {
      method: "GET",
      credentials: "include"
    });
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || ("HTTP_" + res.status));
    }
    return data;
  }

  async function markAbonentSummaryDirty(abonentOrId, reason) {
    try {
      var reasonCode = String(reason || "UNKNOWN_CHANGE").trim() || "UNKNOWN_CHANGE";
      if (reasonCode === "CALC_PERIOD_CHANGED") {
        return { ok: true, skipped: true, status: "skipped", reason: reasonCode, view_only_reason: reasonCode };
      }
      var found = _findAbonentByIdOrUid(abonentOrId);
      var abonent = found && found.abonent ? found.abonent : null;
      var abonentId = String(found && found.id || (abonent && abonent.id) || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
      var uid = String(abonent && abonent.uid || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.uid : "") || "").trim();

      if (!isValidUid(uid)) {
        try { console.warn("[summary][mark-dirty-failed]", { reason: "INVALID_UID", abonentId: abonentId, uid: uid }); } catch (eWarn) {}
        return { ok: false, skipped: true, reason: "INVALID_UID" };
      }

      var payload = {
        account_uid: uid,
        reason: reasonCode
      };

      var res = await fetch("/api/abonent_summary/mark_dirty", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      var text = await res.text();
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (eParse) { data = null; }
      if (!res.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || ("HTTP_" + res.status));
      }
      return data;
    } catch (e) {
      try { console.warn("[summary][mark-dirty-failed]", { reason: String(e && e.message || e) }); } catch (eLog) {}
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  function markAbonentSummaryDirtyLater(abonentOrId, reason) {
    try {
      var p = markAbonentSummaryDirty(abonentOrId, reason);
      if (p && typeof p.catch === "function") p.catch(function(e){ try { console.warn("[summary][mark-dirty-failed]", e); } catch (_) {} });
    } catch (e) {
      try { console.warn("[summary][mark-dirty-failed]", e); } catch (_) {}
    }
  }

  function _isServerFirstDataReadyForAbonentCard() {
    try {
      var st = window.JKH_UI_STATE && window.JKH_UI_STATE.data;
      if (!st) return false;
      var status = String(st.status || "");
      if (status !== "ready" && status !== "empty") return false;
      if (Object.prototype.hasOwnProperty.call(st, "source") && String(st.source || "") !== "server") return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  async function waitForServerFirstDataReady(options) {
    var opts = options || {};
    var timeoutMs = Number(opts.timeoutMs || opts.timeout || 8000);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) timeoutMs = 8000;

    if (_isServerFirstDataReadyForAbonentCard()) return { ok: true, status: "ready" };

    if (window.__JKH_DATA_LOADER_IN_FLIGHT && typeof window.__JKH_DATA_LOADER_IN_FLIGHT.then === "function") {
      try { await window.__JKH_DATA_LOADER_IN_FLIGHT; } catch (e0) {}
      if (_isServerFirstDataReadyForAbonentCard()) return { ok: true, status: "ready" };
    }

    if (window.JKHDataLoader && typeof window.JKHDataLoader.loadFromServer === "function") {
      var st = window.JKH_UI_STATE && window.JKH_UI_STATE.data;
      var status = String(st && st.status || "");
      if (!st || status === "loading") {
        try { await window.JKHDataLoader.loadFromServer({ reason: "abonent_card_recalc_wait", force: false }); } catch (e1) {}
        if (_isServerFirstDataReadyForAbonentCard()) return { ok: true, status: "ready" };
      }
    }

    return await new Promise(function(resolve) {
      var done = false;
      var startedAt = Date.now();
      var timer = null;

      function finish(payload) {
        if (done) return;
        done = true;
        try { window.removeEventListener("JKH_UI_STATE_CHANGED", onState); } catch (e2) {}
        if (timer) clearTimeout(timer);
        resolve(payload);
      }

      function check() {
        if (_isServerFirstDataReadyForAbonentCard()) {
          finish({ ok: true, status: "ready" });
          return;
        }
        if ((Date.now() - startedAt) >= timeoutMs) {
          var st2 = window.JKH_UI_STATE && window.JKH_UI_STATE.data || {};
          finish({ ok: false, status: String(st2.status || "not_ready"), reason: "SERVER_FIRST_DATA_NOT_READY" });
        }
      }

      function onState() { check(); }
      try { window.addEventListener("JKH_UI_STATE_CHANGED", onState); } catch (e3) {}
      timer = setInterval(check, 100);
      check();
    });
  }

  async function saveAbonentSummaryAfterRecalc(abonentOrId, summary) {
    var saveLogCtx = { uid: "", status: "", reason: "", totalsKeys: [] };
    try {
      var found = _findAbonentByIdOrUid(abonentOrId);
      var abonent = found && found.abonent ? found.abonent : null;
      var abonentId = String(found && found.id || (abonent && abonent.id) || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
      var uid = String(abonent && abonent.uid || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.uid : "") || "").trim();
      var summaryStatus = summary && (summary.summary_status || summary.status) || "";
      var summaryReason = summary && (summary.summary_reason || summary.reason) || "";
      var summaryScope = String(summary && (summary.summary_scope || summary.report_scope) || "").trim().toLowerCase();
      var summaryTotals = summary && summary.totals && typeof summary.totals === "object" ? summary.totals : {};
      var summaryTotalsKeys = Object.keys(summaryTotals);
      saveLogCtx = { uid: uid, status: String(summaryStatus || ""), reason: String(summaryReason || ""), totalsKeys: summaryTotalsKeys };

      if (!isValidUid(uid)) {
        try { console.warn("[summary][save-failed]", { uid: uid, status: summaryStatus, reason: "INVALID_UID", totalsKeys: summaryTotalsKeys, abonentId: abonentId }); } catch (eWarn) {}
        return { ok: false, skipped: true, reason: "INVALID_UID" };
      }
      if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
        try { console.warn("[summary][save-failed]", { uid: uid, status: summaryStatus, reason: "SUMMARY_INVALID", totalsKeys: summaryTotalsKeys, abonentId: abonentId }); } catch (eSummary) {}
        return { ok: false, skipped: true, reason: "SUMMARY_INVALID" };
      }
      if (summaryScope === "period" || summaryScope === "report") {
        try {
          console.log("[summary][skip-save-period-summary]", {
            uid: uid,
            summary_scope: summaryScope,
            reason: summaryReason || "PERIOD_SUMMARY_NOT_SAVED"
          });
        } catch (eSkipLog) {}
        return { ok: true, skipped: true, reason: "PERIOD_SUMMARY_NOT_SAVED", summary_status: summaryStatus || "fresh", summary_reason: summaryReason || "OK", summary_scope: summaryScope };
      }

      var payload = {
        account_uid: uid,
        abonent_id: String(abonentId || abonent && abonent.id || ""),
        account_number: String(abonent && (abonent.account_number || abonent.accountNumber || abonent.ls || abonent.id) || abonentId || ""),
        summary: summary
      };
      try {
        console.log("[summary][build-payload]", {
          uid: uid,
          status: summaryStatus,
          reason: summaryReason,
          totalsKeys: summaryTotalsKeys
        });
      } catch (eBuildLog) {}

      var res = await fetch("/api/abonent_summary/rebuild", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      var text = await res.text();
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (eParse) { data = null; }
      if (!res.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || ("HTTP_" + res.status));
      }
      try {
        console.log("[summary][save-ok]", {
          uid: uid,
          status: String(data.summary_status || summaryStatus || ""),
          reason: String(data.summary_reason || summaryReason || ""),
          totalsKeys: summaryTotalsKeys
        });
      } catch (eOkLog) {}
      return data;
    } catch (e) {
      try { console.warn("[summary][save-failed]", { uid: saveLogCtx.uid, status: saveLogCtx.status, reason: String(e && e.message || e), totalsKeys: saveLogCtx.totalsKeys }); } catch (eLog) {}
      return { ok: false, error: String(e && e.message || e) };
    }
  }


  async function validateAbonentSummaryRecalcBatch(uids) {
    var list = Array.isArray(uids) ? uids : [];
    var payload = { account_uids: list.map(function (x) { return String(x || "").trim(); }).filter(Boolean) };
    if (!payload.account_uids.length) return { ok: false, error: "account_uids_required", allowed_uids: [], items: [] };

    var res = await fetch("/api/abonent_summary/recalc_batch", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (eParse) { data = null; }
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || ("HTTP_" + res.status));
    }
    return data;
  }

  async function createAbonentSummaryRecalcBatchJob(uids, reason) {
    var list = Array.isArray(uids) ? uids : [];
    var payload = { uids: list.map(function(x){ return String(x || "").trim(); }).filter(Boolean), reason: String(reason || "MANUAL_RECALC") };
    var res = await fetch("/api/abonent_summary/recalc_batch_job", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || ("HTTP_" + res.status));
    return data;
  }

  async function runAbonentSummaryRecalcBatchJob(jobId) {
    var res = await fetch("/api/abonent_summary/recalc_batch_job/" + encodeURIComponent(String(jobId)) + "/run", {
      method: "POST",
      credentials: "include"
    });
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || ("HTTP_" + res.status));
    return data;
  }

  async function getAbonentSummaryRecalcBatchJob(jobId) {
    var res = await fetch("/api/abonent_summary/recalc_batch_job/" + encodeURIComponent(String(jobId)), {
      method: "GET",
      credentials: "include"
    });
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || ("HTTP_" + res.status));
    return data;
  }


  async function getAbonentSummaryRecalcBatchJobLatest() {
    var res = await fetch("/api/abonent_summary/recalc_batch_job/latest", {
      method: "GET",
      credentials: "include"
    });
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || ("HTTP_" + res.status));
    return data;
  }

  function _dateFromIsoLocal(value) {
    var s = String(value || "").trim();
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
    return d.toString() === "Invalid Date" ? null : d;
  }

  function _isValidIsoPeriod(from, to) {
    var d1 = _dateFromIsoLocal(from);
    var d2 = _dateFromIsoLocal(to);
    return !!(d1 && d2 && d1.getTime() <= d2.getTime());
  }

  function _summaryNumber(value) {
    if (value === null || value === undefined || value === "") return 0;
    var n = Number(String(value).replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }

  function _summaryMonthKey(row) {
    var y = Number(row && row.year);
    var m = Number(row && row.month);
    if (!Number.isFinite(y) || !Number.isFinite(m) || y < 1 || m < 1 || m > 12) return "";
    return String(Math.trunc(y)).padStart(4, "0") + "-" + String(Math.trunc(m)).padStart(2, "0");
  }

  function _summaryPaidDate(row) {
    var raw = row && row.paid_date;
    if (!raw) return null;
    var d = null;
    if (window.JKHCalcEngine && typeof window.JKHCalcEngine.parseDateAnyToDate === "function") {
      d = window.JKHCalcEngine.parseDateAnyToDate(raw);
    } else {
      d = _dateFromIsoLocal(raw);
    }
    return (d && d.toString() !== "Invalid Date") ? d : null;
  }

  function _summaryPeriodTotals(rows, from, to) {
    var fromMonth = String(from || "").slice(0, 7);
    var toMonth = String(to || "").slice(0, 7);
    var fromDate = _dateFromIsoLocal(from);
    var toDate = _dateFromIsoLocal(to);
    var totalAccrued = 0;
    var totalPaid = 0;

    if (!Array.isArray(rows)) rows = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {};
      var monthKey = _summaryMonthKey(row);
      var inMonthPeriod = !!(monthKey && monthKey >= fromMonth && monthKey <= toMonth);
      if (inMonthPeriod) {
        totalAccrued += _summaryNumber(row.accrued);
      }

      var paid = _summaryNumber(row.paid);
      if (Math.abs(paid) <= 0.0000001) continue;
      var paidDate = _summaryPaidDate(row);
      if (paidDate && fromDate && toDate) {
        if (paidDate.getTime() >= fromDate.getTime() && paidDate.getTime() <= toDate.getTime()) {
          totalPaid += paid;
        }
      } else if (inMonthPeriod) {
        totalPaid += paid;
      }
    }

    return {
      total_accrued: Math.round(totalAccrued * 100) / 100,
      total_paid: Math.round(totalPaid * 100) / 100
    };
  }

  function _summaryCalcErrorCode(e) {
    if (e && e.code) return String(e.code);
    var msg = String(e && e.message || e || "CALC_FAILED");
    if (msg.indexOf("MISSING_REQUIRED_RATE") >= 0) return "MISSING_REQUIRED_RATE";
    if (msg.indexOf("RATES_JSON_INVALID") >= 0) return "RATES_MISSING";
    if (msg.indexOf("RATES_MISSING") >= 0) return "RATES_MISSING";
    if (msg.indexOf("EXCLUDES_JSON_INVALID") >= 0) return "EXCLUDES_INVALID";
    if (msg.indexOf("EXCLUDES_INVALID") >= 0) return "EXCLUDES_INVALID";
    if (msg.indexOf("LEDGER_JSON_INVALID") >= 0) return "LEDGER_JSON_INVALID";
    if (msg.indexOf("START_DATE_MISSING") >= 0) return "START_DATE_MISSING";
    if (msg.indexOf("RESPONSIBILITY_DATE_MISSING") >= 0) return "RESPONSIBILITY_DATE_MISSING";
    if (msg.indexOf("PERIOD_REQUIRED") >= 0) return "START_DATE_MISSING";
    return msg || "CALC_FAILED";
  }

  function _todayIsoLocal() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function _dateAnyToIsoLocal(value) {
    var s = String(value || "").trim();
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    var m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return m[3] + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[1]).padStart(2, "0");
    var d = null;
    if (window.JKHCalcEngine && typeof window.JKHCalcEngine.parseDateAnyToDate === "function") {
      d = window.JKHCalcEngine.parseDateAnyToDate(s);
    }
    if (d && d.toString() !== "Invalid Date") {
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }
    return "";
  }

  function _normalizeSummaryPeriodCandidate(from, to) {
    var f = _dateAnyToIsoLocal(from);
    var t = _dateAnyToIsoLocal(to) || _todayIsoLocal();
    if (!_isValidIsoPeriod(f, t)) return null;
    return { ok: true, from: f, to: t, source: "fallback" };
  }

  function _readAbonentCalcPeriod(abonentOrId) {
    var key = resolveCalcPeriodStorageKey(abonentOrId);
    if (!key) return { ok: false, error: "UID_REQUIRED", from: "", to: "" };
    var raw = _getRawScoped(key);
    if (!raw) return { ok: false, error: "PERIOD_REQUIRED", from: "", to: "", missing: true, storageKey: key };
    var obj = null;
    try { obj = JSON.parse(raw); } catch (e) { obj = null; }
    var from = String(obj && obj.from || "").trim();
    var to = String(obj && obj.to || "").trim();
    if (!_isValidIsoPeriod(from, to)) return { ok: false, error: "PERIOD_INVALID", from: from, to: to, storageKey: key };
    return { ok: true, from: from, to: to, storageKey: key };
  }

  function _extractPeriodFromSummaryObject(summary) {
    if (!summary || typeof summary !== "object") return null;
    var p = summary.period && typeof summary.period === "object" ? summary.period : null;
    return _normalizeSummaryPeriodCandidate(
      p && (p.from || p.period_from || p.date_from || p.start_date) || summary.period_from || summary.period_start || summary.date_from || summary.start_date,
      p && (p.to || p.period_to || p.date_to || p.end_date || p.as_of) || summary.period_to || summary.period_end || summary.date_to || summary.end_date || summary.as_of
    );
  }

  async function _readCurrentAbonentSummaryPeriod(abonentOrId) {
    try {
      var found = _findAbonentByIdOrUid(abonentOrId);
      var abonent = found && found.abonent ? found.abonent : null;
      var uid = String(abonent && abonent.uid || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.uid : "") || "").trim();
      var abonentId = String(found && found.id || (abonent && abonent.id) || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
      var opts = { page: 1, per_page: 1 };
      if (isValidUid(uid)) opts.account_uid = uid;
      else if (abonentId) opts.abonent_id = abonentId;
      else return null;
      var payload = await loadAbonentSummaryPage(opts);
      var items = Array.isArray(payload && payload.items) ? payload.items : [];
      var item = items[0] || null;
      var summary = item && item.summary && typeof item.summary === "object" ? item.summary : null;
      var period = _extractPeriodFromSummaryObject(summary);
      if (period) period.source = "summary";
      return period;
    } catch (e) {
      try { console.warn("[summary][period-fallback-summary-failed]", { reason: String(e && e.message || e) }); } catch (eLog) {}
      return null;
    }
  }

  function _readActiveResponsibilityPeriod(abonentOrId) {
    var found = _findAbonentByIdOrUid(abonentOrId);
    var id = String(found && found.id || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
    if (!id) return null;
    var db = window.AbonentsDB || {};
    var abonent = found && found.abonent ? found.abonent : (db.abonents && db.abonents[id] ? db.abonents[id] : {});
    var linksRaw = Array.isArray(db.links) ? db.links : (Array.isArray(db.abonentPremiseLinks) ? db.abonentPremiseLinks : []);
    var links = linksRaw.filter(function (l) {
      var aId = l && (l.abonentId || l.abonent_id || l.abonent || l.accountId || l.ls || l.personalAccount);
      return String(aId || "") === id;
    }).map(function (l) {
      return {
        from: _dateAnyToIsoLocal(l && (l.dateFrom || l.from || l.start || l.startDate || l.date_start || l.respFrom)),
        to: _dateAnyToIsoLocal(l && (l.dateTo || l.to || l.end || l.endDate || l.date_end || l.respTo))
      };
    }).filter(function (l) { return !!l.from; });

    var strictFrom = _dateAnyToIsoLocal(abonent && (abonent.calcStartDate || abonent.calc_start_date || abonent.calcStart || abonent.calc_start || abonent.startCalc || abonent.start_calc || abonent.dateStartCalc || abonent.date_start_calc || abonent.calcDateStart || abonent.calc_date_start || abonent.calcDate || abonent.calc_date));
    var strictTo = _dateAnyToIsoLocal(abonent && (abonent.calcEndDate || abonent.calc_end_date || abonent.calcEnd || abonent.calc_end));

    function clamp(range, openEnded) {
      if (!range || !range.from) return null;
      var from = range.from;
      var to = range.to || "";
      if (strictFrom && strictFrom > from) from = strictFrom;
      if (strictTo && !openEnded && (!to || strictTo < to)) to = strictTo;
      return _normalizeSummaryPeriodCandidate(from, to);
    }

    if (links.length) {
      var active = links.filter(function (l) { return !l.to; });
      var pick = (active.length ? active : links).sort(function (a, b) { return a.from < b.from ? 1 : -1; })[0];
      var linkPeriod = clamp({ from: pick.from, to: pick.to || "" }, !pick.to);
      if (linkPeriod) { linkPeriod.source = "responsibility"; return linkPeriod; }
    }

    var directPeriod = clamp({
      from: _dateAnyToIsoLocal(abonent && (abonent.calcStartDate || abonent.calc_start_date || abonent.dateFrom || abonent.date_from || abonent.calcFrom || abonent.calc_from || abonent.startCalc || abonent.start_calc || abonent.dateStartCalc || abonent.date_start_calc || abonent.responsibilityFrom || abonent.respFrom)),
      to: _dateAnyToIsoLocal(abonent && (abonent.calcEndDate || abonent.calc_end_date || abonent.dateTo || abonent.date_to || abonent.calcTo || abonent.calc_to || abonent.endCalc || abonent.end_calc || abonent.dateEndCalc || abonent.date_end_calc || abonent.responsibilityTo || abonent.respTo))
    }, !strictTo);
    if (directPeriod) { directPeriod.source = "responsibility"; return directPeriod; }
    return null;
  }

  async function _resolveAbonentSummaryRecalcPeriod(abonentOrId, explicitPeriod) {
    if (explicitPeriod && typeof explicitPeriod === "object") {
      return { ok: _isValidIsoPeriod(explicitPeriod.from, explicitPeriod.to), from: String(explicitPeriod.from || ""), to: String(explicitPeriod.to || ""), error: "PERIOD_INVALID" };
    }
    var period = _readAbonentCalcPeriod(abonentOrId);
    if (period.ok || period.error !== "PERIOD_REQUIRED") return period;

    var summaryPeriod = await _readCurrentAbonentSummaryPeriod(abonentOrId);
    if (summaryPeriod) return summaryPeriod;

    var responsibilityPeriod = _readActiveResponsibilityPeriod(abonentOrId);
    if (responsibilityPeriod) return responsibilityPeriod;

    return period;
  }

  function resolveAbonentRegnumForSummary(abonentId, abonent) {
    function clean(v) { return String(v || "").trim(); }

    var direct = clean(abonent && abonent.regnum) ||
      clean(abonent && abonent.premiseRegnum) ||
      clean(abonent && abonent.premise_regnum) ||
      clean(abonent && abonent.regNumber) ||
      clean(abonent && abonent.reg_no) ||
      clean(abonent && abonent.flatReg);
    if (direct) return direct;

    var id = clean(abonentId);
    var db = window.AbonentsDB || {};
    var links = Array.isArray(db.links) ? db.links.filter(function (l) {
      return clean(l && l.abonentId) === id;
    }) : [];
    if (!id || !links.length) return "";

    function linkRegnum(link) {
      return clean(link && link.regnum);
    }

    for (var i = links.length - 1; i >= 0; i--) {
      if (!clean(links[i] && links[i].dateTo) && linkRegnum(links[i])) return linkRegnum(links[i]);
    }

    for (var j = links.length - 1; j >= 0; j--) {
      if (linkRegnum(links[j])) return linkRegnum(links[j]);
    }
    return "";
  }

  function buildAbonentSummaryAfterExplicitRecalc(abonentOrId, from, to) {
    var found = _findAbonentByIdOrUid(abonentOrId);
    var abonent = found && found.abonent ? found.abonent : (abonentOrId && typeof abonentOrId === "object" ? abonentOrId : null);
    var abonentId = String(found && found.id || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
    if (!abonentId) throw new Error("ABONENT_ID_REQUIRED");
    if (!window.JKHCalcEngine || typeof window.JKHCalcEngine.loadPaymentsForAbonent !== "function" || typeof window.JKHCalcEngine.calcTotalsAsOfAdjusted !== "function") {
      throw new Error("CALC_ENGINE_UNAVAILABLE");
    }
    var asOf = _dateFromIsoLocal(to);
    if (!asOf) throw new Error("PERIOD_INVALID");
    var uid = String(abonent && (abonent.uid || abonent.account_uid || abonent.accountUid) || "").trim();
    if (!isValidUid(uid)) throw new Error("UID_REQUIRED");
    var ledgerKey = resolvePaymentLedgerKey(abonentOrId);
    if (ledgerKey !== ("payments_" + uid)) throw new Error("UID_LEDGER_PATH_REQUIRED");
    var rawLedger = _getProjectRaw(ledgerKey);
    if (rawLedger !== null && rawLedger !== undefined) _parseLedgerRows(rawLedger, ledgerKey);
    var rows = window.JKHCalcEngine.loadPaymentsForAbonent(String(abonentId));
    var totals = window.JKHCalcEngine.calcTotalsAsOfAdjusted(rows, asOf, {
      abonentId: String(abonentId),
      applyAdvanceOffset: true,
      allowNegativePrincipal: true
    });
    var principal = Number(totals && totals.principal);
    var penalty = Number(totals && totals.penaltyDebt);
    var total = Number(totals && totals.total);
    var periodTotals = _summaryPeriodTotals(rows, from, to);
    if (!Number.isFinite(principal) || !Number.isFinite(penalty) || !Number.isFinite(total)) {
      throw new Error("CALC_TOTALS_INVALID");
    }
    var periodFrom = String(from || "");
    var periodTo = String(to || "");
    var accountUid = String(abonent && (abonent.uid || abonent.account_uid || abonent.accountUid) || "").trim();
    var accountNumber = String(abonent && (abonent.account_number || abonent.accountNumber || abonent.ls || abonent.id) || abonentId || "").trim();
    var fio = String(abonent && (abonent.fio || abonent.full_name || abonent.fullName || abonent.name_full || abonent.display_name) || "").trim();
    var fioParts = fio ? fio.split(/\s+/) : [];
    var fam = String(abonent && (abonent.fam || abonent.last_name || abonent.lastName) || fioParts[0] || "").trim();
    var name = String(abonent && (abonent.name || abonent.first_name || abonent.firstName) || fioParts[1] || "").trim();
    var otch = String(abonent && (abonent.otch || abonent.middle_name || abonent.middleName) || fioParts.slice(2).join(" ") || "").trim();
    var regnum = resolveAbonentRegnumForSummary(abonentId, abonent);
    return {
      status: "fresh",
      reason: "OK",
      summary_status: "fresh",
      summary_reason: "OK",
      start_date: periodFrom,
      end_date: periodTo,
      period_start: periodFrom,
      period_end: periodTo,
      regnum: regnum,
      flat_reg: regnum,
      premise_regnum: regnum,
      premiseRegnum: regnum,
      account_uid: accountUid,
      uid: accountUid,
      account_number: accountNumber,
      abonent_id: abonentId,
      id: abonentId,
      fio: fio,
      fam: fam,
      name: name,
      otch: otch,
      abonent: {
        id: abonentId,
        abonent_id: abonentId,
        account_number: accountNumber,
        account_uid: accountUid,
        fio: fio,
        fam: fam,
        name: name,
        otch: otch,
        regnum: regnum,
        premise_regnum: regnum,
        premiseRegnum: regnum
      },
      period: { from: periodFrom, to: periodTo },
      total_debt: total,
      total_penalty: penalty,
      total_accrued: periodTotals.total_accrued,
      total_paid: periodTotals.total_paid,
      penalty: penalty,
      totals: {
        principal: principal,
        debt: total,
        penalty: penalty,
        total: total,
        accrued: periodTotals.total_accrued,
        paid: periodTotals.total_paid,
        balance: total,
        total_debt: total,
        total_penalty: penalty,
        total_accrued: periodTotals.total_accrued,
        total_paid: periodTotals.total_paid
      },
      calc_engine_version: "JKHCalcEngine",
      generated_at: new Date().toISOString()
    };
  }

  function buildAbonentSummaryErrorAfterExplicitRecalc(abonentOrId, period, reason) {
    var found = _findAbonentByIdOrUid(abonentOrId);
    var abonent = found && found.abonent ? found.abonent : (abonentOrId && typeof abonentOrId === "object" ? abonentOrId : null);
    var abonentId = String(found && found.id || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
    var periodFrom = String(period && period.from || "");
    var periodTo = String(period && period.to || "");
    var accountUid = String(abonent && (abonent.uid || abonent.account_uid || abonent.accountUid) || "").trim();
    var accountNumber = String(abonent && (abonent.account_number || abonent.accountNumber || abonent.ls || abonent.id) || abonentId || "").trim();
    var fio = String(abonent && (abonent.fio || abonent.full_name || abonent.fullName || abonent.name_full || abonent.display_name) || "").trim();
    var fioParts = fio ? fio.split(/\s+/) : [];
    var fam = String(abonent && (abonent.fam || abonent.last_name || abonent.lastName) || fioParts[0] || "").trim();
    var name = String(abonent && (abonent.name || abonent.first_name || abonent.firstName) || fioParts[1] || "").trim();
    var otch = String(abonent && (abonent.otch || abonent.middle_name || abonent.middleName) || fioParts.slice(2).join(" ") || "").trim();
    var regnum = resolveAbonentRegnumForSummary(abonentId, abonent);
    return {
      status: "error",
      reason: String(reason || "CALC_FAILED"),
      summary_status: "error",
      summary_reason: String(reason || "CALC_FAILED"),
      start_date: periodFrom,
      end_date: periodTo,
      period_start: periodFrom,
      period_end: periodTo,
      regnum: regnum,
      flat_reg: regnum,
      premise_regnum: regnum,
      premiseRegnum: regnum,
      account_uid: accountUid,
      uid: accountUid,
      account_number: accountNumber,
      abonent_id: abonentId,
      id: abonentId,
      fio: fio,
      fam: fam,
      name: name,
      otch: otch,
      abonent: {
        id: abonentId,
        abonent_id: abonentId,
        account_number: accountNumber,
        account_uid: accountUid,
        fio: fio,
        fam: fam,
        name: name,
        otch: otch,
        regnum: regnum,
        premise_regnum: regnum,
        premiseRegnum: regnum
      },
      period: { from: periodFrom, to: periodTo },
      calc_engine_version: "JKHCalcEngine",
      generated_at: new Date().toISOString()
    };
  }

  function _debugSummaryNumberSum(rows, field) {
    var sum = 0;
    (Array.isArray(rows) ? rows : []).forEach(function(row) {
      sum += _summaryNumber(row && row[field]);
    });
    return Math.round(sum * 100) / 100;
  }

  function _debugSummaryPickValue(summary, keys) {
    for (var i = 0; i < keys.length; i++) {
      var key = String(keys[i] || "");
      var v = summary ? summary[key] : undefined;
      if ((v === null || v === undefined || v === "") && key.indexOf("totals.") === 0 && summary && summary.totals && typeof summary.totals === "object") {
        v = summary.totals[key.slice(7)];
      }
      if (v !== null && v !== undefined && v !== "") return v;
    }
    return "";
  }

  function _debugSummaryHasTotals(summary) {
    if (!summary || typeof summary !== "object") return false;
    var debt = _debugSummaryPickValue(summary, ["total_debt", "totals.total_debt", "totalDebt", "debt_total", "total", "totals.total"]);
    var penalty = _debugSummaryPickValue(summary, ["total_penalty", "totals.total_penalty", "penalty", "pay_penalty", "penalty_debt", "penaltyDebt", "totals.penalty"]);
    return debt !== "" || penalty !== "";
  }

  function _debugSummaryIndexRowHasTotals(row) {
    if (!row || typeof row !== "object") return false;
    return _debugSummaryHasTotals(row.summary && typeof row.summary === "object" ? row.summary : row) ||
      row.totalDebt !== undefined || row.total_debt !== undefined || row.total_penalty !== undefined || row.penalty !== undefined;
  }

  async function _debugFetchJson(url) {
    var res = await fetch(url, { method: "GET", credentials: "include" });
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    return { ok: !!(res.ok && data && data.ok !== false), status: res.status, data: data, error: res.ok ? "" : ("HTTP_" + res.status) };
  }

  function _debugFindAbonentApiRow(payload, abonentId, uid) {
    var items = Array.isArray(payload && payload.items) ? payload.items : [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i] || {};
      if (String(item.account_uid || item.uid || "") === String(uid || "")) return item;
      if (String(item.abonent_id || item.abonentId || item.id || item.account_number || "") === String(abonentId || "")) return item;
    }
    return null;
  }

  function _debugSummaryWhyIndexTotalsEmpty(ctx) {
    var buildReason = String(ctx && ctx.buildReason || "");
    var payloadSummary = ctx && ctx.summaryPayload && ctx.summaryPayload.summary;
    var apiSummary = ctx && ctx.apiSummary;
    var abonentRow = ctx && ctx.abonentApiRow;
    if (buildReason) return buildReason;
    if (!payloadSummary || typeof payloadSummary !== "object") return "SUMMARY_PAYLOAD_INVALID";
    if (!ctx || !ctx.calcTotals) return "TOTALS_BUILD_FAILED";
    if (payloadSummary.summary_status !== "fresh" && payloadSummary.status !== "fresh") return "SUMMARY_NOT_FRESH";
    if (!ctx || ctx.apiSummaryReturned !== true) return "API_SUMMARY_NOT_RETURNED";
    if (!apiSummary || (apiSummary.summary_status !== "fresh" && apiSummary.status !== "fresh")) return "SUMMARY_SAVE_FAILED";
    if (!_debugSummaryHasTotals(apiSummary)) return "TOTALS_EMPTY";
    if (!abonentRow) return "INDEX_MAPPING_MISMATCH";
    if (!_debugSummaryIndexRowHasTotals(abonentRow)) return "INDEX_MAPPING_MISMATCH";
    return "";
  }

  window.JKH_debugSummaryBuild = async function(abonentId) {
    var found = _findMigrationVerificationAbonent(abonentId);
    var abonent = found && found.abonent ? found.abonent : null;
    var id = String(found && found.id || abonentId || "").trim();
    var uid = String(abonent && abonent.uid || "").trim();
    var canonicalKey = isValidUid(uid) ? ("payments_" + uid) : "";
    var ledgerInfo = canonicalKey ? _safeLedgerInfoForDiagnostic(canonicalKey) : { exists: false, rowsCount: 0, rows: [], error: "UID_REQUIRED" };
    var rows = Array.isArray(ledgerInfo.rows) ? ledgerInfo.rows : [];
    var period = null;
    var responsibility = null;
    var calcTotals = null;
    var summaryPayload = null;
    var buildReason = "";
    var summaryApiPayload = null;
    var summaryApiItem = null;
    var summaryFromApi = null;
    var abonentsApiPayload = null;
    var abonentApiRow = null;

    try { period = await _resolveAbonentSummaryRecalcPeriod(abonent || id, null); } catch (ePeriod) { period = { ok: false, error: String(ePeriod && ePeriod.message || ePeriod) }; }
    try { responsibility = _readActiveResponsibilityPeriod(abonent || id); } catch (eResp) { responsibility = { ok: false, error: String(eResp && eResp.message || eResp) }; }

    try {
      if (!abonent || !id) throw new Error("ABONENT_NOT_FOUND");
      if (!isValidUid(uid)) throw new Error("UID_REQUIRED");
      if (!canonicalKey || !ledgerInfo.exists) throw new Error("CANONICAL_LEDGER_EMPTY");
      if (!period || period.ok !== true) throw new Error(period && period.error || "RESPONSIBILITY_PERIOD_MISSING");
      if (!window.JKHCalcEngine || typeof window.JKHCalcEngine.calcTotalsAsOfAdjusted !== "function") throw new Error("CALC_ENGINE_UNAVAILABLE");
      var asOf = _dateFromIsoLocal(period.to);
      if (!asOf) throw new Error("PERIOD_INVALID");
      calcTotals = window.JKHCalcEngine.calcTotalsAsOfAdjusted(rows, asOf, {
        abonentId: id,
        applyAdvanceOffset: true,
        allowNegativePrincipal: true
      });
      summaryPayload = {
        account_uid: uid,
        abonent_id: id,
        account_number: _accountNumberForLedger(id, abonent),
        summary: buildAbonentSummaryAfterExplicitRecalc(abonent || id, period.from, period.to)
      };
    } catch (eBuild) {
      buildReason = _summaryCalcErrorCode(eBuild);
      if (buildReason === "START_DATE_MISSING") buildReason = "RESPONSIBILITY_PERIOD_MISSING";
      if (!calcTotals && buildReason !== "RESPONSIBILITY_PERIOD_MISSING" && buildReason !== "CANONICAL_LEDGER_EMPTY") buildReason = buildReason || "TOTALS_BUILD_FAILED";
    }

    try {
      if (isValidUid(uid)) {
        summaryApiPayload = await loadAbonentSummaryPage({ page: 1, per_page: 1, account_uid: uid });
        summaryApiItem = Array.isArray(summaryApiPayload && summaryApiPayload.items) ? (summaryApiPayload.items[0] || null) : null;
        summaryFromApi = summaryApiItem && summaryApiItem.summary && typeof summaryApiItem.summary === "object" ? summaryApiItem.summary : null;
      }
    } catch (eSummaryApi) {
      summaryApiPayload = { ok: false, error: String(eSummaryApi && eSummaryApi.message || eSummaryApi) };
    }

    try {
      var params = new URLSearchParams();
      params.set("page", "1");
      params.set("limit", "20");
      params.set("query", id || uid);
      var api = await _debugFetchJson("/api/abonents?" + params.toString());
      abonentsApiPayload = api.data || { ok: false, error: api.error || ("HTTP_" + api.status) };
      abonentApiRow = _debugFindAbonentApiRow(abonentsApiPayload, id, uid);
    } catch (eAbonentsApi) {
      abonentsApiPayload = { ok: false, error: String(eAbonentsApi && eAbonentsApi.message || eAbonentsApi) };
    }

    var recalculateResult = {
      ok: false,
      skipped: true,
      reason: "READ_ONLY_DIAGNOSTIC_NOT_EXECUTED",
      note: "Data.recalculateAbonentCard saves abonent_summary, so this helper builds the same payload without calling the write path."
    };
    var why = _debugSummaryWhyIndexTotalsEmpty({
      buildReason: buildReason,
      summaryPayload: summaryPayload,
      calcTotals: calcTotals,
      apiSummaryReturned: !!summaryFromApi,
      apiSummary: summaryFromApi,
      abonentApiRow: abonentApiRow
    }) || "UNKNOWN";

    var report = {
      abonentId: id,
      uid: uid,
      canonicalKey: canonicalKey,
      rowsCount: Number(ledgerInfo.rowsCount || 0),
      accruedSum: _debugSummaryNumberSum(rows, "accrued"),
      paidSum: _debugSummaryNumberSum(rows, "paid"),
      calcPeriod: { from: String(period && period.from || ""), to: String(period && period.to || ""), ok: !!(period && period.ok), reason: String(period && (period.error || period.reason || period.source) || "") },
      responsibilityRange: { from: String(responsibility && responsibility.from || ""), to: String(responsibility && responsibility.to || ""), source: String(responsibility && responsibility.source || "") },
      calcTotalsAsOfAdjusted: calcTotals,
      preparedSummaryPayload: summaryPayload,
      recalculateAbonentCardResult: recalculateResult,
      apiSummary: { payload: summaryApiPayload, item: summaryApiItem, summary: summaryFromApi },
      apiAbonents: { payload: abonentsApiPayload, row: abonentApiRow },
      whyIndexTotalsEmpty: why,
      clearReason: why
    };
    try { console.table([{ abonentId: report.abonentId, uid: report.uid, rowsCount: report.rowsCount, accruedSum: report.accruedSum, paidSum: report.paidSum, whyIndexTotalsEmpty: report.whyIndexTotalsEmpty }]); } catch (eTable) {}
    try { console.log("[summary-build][debug]", report); } catch (eLog) {}
    return report;
  };

  function _debugTotalsField(value) {
    return {
      value: value,
      type: typeof value,
      finite: Number.isFinite(Number(value)),
      missing: value === undefined || value === null || value === "",
      nan: Number.isNaN(Number(value))
    };
  }

  function _debugTotalsValidationMap(calcTotals, summaryPayload) {
    var summary = summaryPayload && summaryPayload.summary && typeof summaryPayload.summary === "object" ? summaryPayload.summary : {};
    return {
      principal: _debugTotalsField(calcTotals && calcTotals.principal),
      debt: _debugTotalsField(summary.total_debt !== undefined ? summary.total_debt : (calcTotals && (calcTotals.debt !== undefined ? calcTotals.debt : calcTotals.principal))),
      penalty: _debugTotalsField(calcTotals && (calcTotals.penaltyDebt !== undefined ? calcTotals.penaltyDebt : calcTotals.penalty)),
      total: _debugTotalsField(calcTotals && calcTotals.total),
      accrued: _debugTotalsField(summary.total_accrued),
      paid: _debugTotalsField(summary.total_paid),
      balance: _debugTotalsField(calcTotals && (calcTotals.balance !== undefined ? calcTotals.balance : calcTotals.total))
    };
  }

  function _debugTotalsValidationResult(fields, summaryPayload) {
    var missing = [];
    var nan = [];
    var nonFinite = [];
    Object.keys(fields || {}).forEach(function(name) {
      var f = fields[name] || {};
      if (f.missing) missing.push(name);
      if (f.nan) nan.push(name);
      if (!f.finite) nonFinite.push(name);
    });
    var payloadSummary = summaryPayload && summaryPayload.summary;
    var payloadInvalid = !summaryPayload || !payloadSummary || typeof payloadSummary !== "object" || Array.isArray(payloadSummary);
    var reason = "";
    if (nan.length) reason = "TOTALS_NAN";
    else if (missing.length) reason = "TOTALS_UNDEFINED";
    else if (nonFinite.length) reason = "TOTALS_VALIDATION_FAILED";
    else if (payloadInvalid) reason = "PAYLOAD_SCHEMA_MISMATCH";
    else if (["principal", "penalty", "total", "accrued", "paid"].some(function(name) { return !fields[name]; })) reason = "TOTALS_MISSING_FIELDS";
    else reason = "";
    return {
      ok: !reason,
      blocker: reason || "",
      whySummaryInvalid: reason || "",
      missingFields: missing,
      nanFields: nan,
      nonFiniteFields: nonFinite,
      payloadSchemaOk: !payloadInvalid
    };
  }

  window.JKH_debugTotalsValidation = async function(abonentId) {
    var summaryReport = await window.JKH_debugSummaryBuild(abonentId);
    var calcTotals = summaryReport && summaryReport.calcTotalsAsOfAdjusted;
    var summaryPayload = summaryReport && summaryReport.preparedSummaryPayload;
    var fields = _debugTotalsValidationMap(calcTotals, summaryPayload);
    var validation = _debugTotalsValidationResult(fields, summaryPayload);
    var exactReason = validation.whySummaryInvalid || summaryReport.clearReason || "UNKNOWN";
    var report = {
      abonentId: summaryReport && summaryReport.abonentId || String(abonentId || "").trim(),
      uid: summaryReport && summaryReport.uid || "",
      rawCalcTotalsAsOfAdjusted: calcTotals,
      totalsFields: fields,
      exactValidationBlocker: validation.blocker || "",
      exactReasonSummaryBecameInvalid: exactReason,
      whySummaryInvalid: exactReason || "UNKNOWN",
      preparedSummaryPayloadBeforeValidation: summaryPayload,
      validationResultAfterValidation: validation,
      missingOrInvalidFields: {
        missing: validation.missingFields,
        nan: validation.nanFields,
        nonFinite: validation.nonFiniteFields
      }
    };
    try {
      console.table(Object.keys(fields).map(function(name) {
        var f = fields[name] || {};
        return { field: name, value: f.value, type: f.type, finite: f.finite, missing: f.missing, nan: f.nan };
      }));
    } catch (eTable) {}
    try { console.log("[summary-build][totals-validation]", report); } catch (eLog) {}
    return report;
  };

  function _debugRenderGuard(name, allow, detail) {
    return {
      guard: name,
      result: allow ? "ALLOW" : "DENY",
      allow: !!allow,
      detail: detail || ""
    };
  }

  function _debugSummaryRenderGuards(summaryReport, totalsReport, indexState) {
    var payloadSummary = summaryReport && summaryReport.preparedSummaryPayload && summaryReport.preparedSummaryPayload.summary;
    var apiSummary = summaryReport && summaryReport.apiSummary && summaryReport.apiSummary.summary;
    var summary = apiSummary || payloadSummary || null;
    var statusBefore = payloadSummary && (payloadSummary.summary_status || payloadSummary.status) || "";
    var statusAfter = apiSummary && (apiSummary.summary_status || apiSummary.status) || "";
    var totalsObj = summary && summary.totals && typeof summary.totals === "object" ? summary.totals : null;
    var fields = totalsReport && totalsReport.totalsFields || {};
    var finiteTotals = !!(fields.principal && fields.principal.finite && fields.penalty && fields.penalty.finite && fields.total && fields.total.finite);
    var runtimeStale = false;
    try {
      var item = summaryReport && summaryReport.abonentId ? _migrationVerificationItem(summaryReport.abonentId, _findMigrationVerificationAbonent(summaryReport.abonentId).abonent, {}) : null;
      runtimeStale = !!(item && item.runtimeCacheStale);
    } catch (e) {}
    return [
      _debugRenderGuard("hasSummary", !!summary, summary ? "summary object present" : "summary missing"),
      _debugRenderGuard("summary_status === fresh", statusAfter === "fresh" || (!statusAfter && statusBefore === "fresh"), "before=" + statusBefore + "; after=" + statusAfter),
      _debugRenderGuard("totals object exists", !!totalsObj, totalsObj ? "summary.totals present" : "summary.totals missing"),
      _debugRenderGuard("totals finite", finiteTotals, "principal/penalty/total finite=" + finiteTotals),
      _debugRenderGuard("stale flag", !runtimeStale, runtimeStale ? "runtime cache stale" : "no stale runtime flag"),
      _debugRenderGuard("runtime cache flag", !(summaryReport && summaryReport.runtimeCacheStale), "summary debug runtime flag=" + !!(summaryReport && summaryReport.runtimeCacheStale)),
      _debugRenderGuard("readonly_no_recalc flag", true, "not an index render guard; unavailable from data.js"),
      _debugRenderGuard("passive summary mode", !!(indexState && indexState.passiveSummaryMode), "passiveSummaryMode=" + !!(indexState && indexState.passiveSummaryMode)),
      _debugRenderGuard("pagination state", !!(indexState && !indexState.loading && !indexState.error), "loading=" + !!(indexState && indexState.loading) + "; error=" + String(indexState && indexState.error || "")),
      _debugRenderGuard("render signature skip", !(indexState && indexState.renderSignatureSkip), "renderSignatureSkip=" + !!(indexState && indexState.renderSignatureSkip))
    ];
  }

  function _debugRenderDenyReason(guards, summaryReport, totalsReport, indexState) {
    var denied = (guards || []).filter(function(g) { return g && g.result === "DENY"; });
    if (denied.length) return denied[0].guard;
    if (summaryReport && summaryReport.whyIndexTotalsEmpty === "TOTALS_EMPTY") return "TOTALS_EMPTY_GUARD";
    if (totalsReport && totalsReport.validationResultAfterValidation && totalsReport.validationResultAfterValidation.ok !== true) return "TOTALS_VALIDATION_GUARD";
    if (!indexState || !indexState.rowFound) return "INDEX_ROW_NOT_FOUND";
    return "";
  }

  window.JKH_debugSummaryRenderState = async function(abonentId) {
    var totalsReport = await window.JKH_debugTotalsValidation(abonentId);
    var summaryReport = await window.JKH_debugSummaryBuild(abonentId);
    var indexState = null;
    try {
      if (typeof window.JKH_getIndexRenderDebugState === "function") {
        indexState = window.JKH_getIndexRenderDebugState(summaryReport.uid || summaryReport.abonentId || abonentId);
      }
    } catch (eIndex) {
      indexState = { error: String(eIndex && eIndex.message || eIndex) };
    }
    var payloadSummary = summaryReport && summaryReport.preparedSummaryPayload && summaryReport.preparedSummaryPayload.summary;
    var apiSummary = summaryReport && summaryReport.apiSummary && summaryReport.apiSummary.summary;
    var guards = _debugSummaryRenderGuards(summaryReport, totalsReport, indexState);
    var exactGuard = _debugRenderDenyReason(guards, summaryReport, totalsReport, indexState);
    var report = {
      abonentId: summaryReport && summaryReport.abonentId || String(abonentId || "").trim(),
      uid: summaryReport && summaryReport.uid || "",
      preparedSummaryPayload: summaryReport && summaryReport.preparedSummaryPayload || null,
      summaryStatusBeforeValidation: payloadSummary && (payloadSummary.summary_status || payloadSummary.status) || "",
      summaryStatusAfterValidation: apiSummary && (apiSummary.summary_status || apiSummary.status) || "",
      exactValidationResult: totalsReport && totalsReport.validationResultAfterValidation || null,
      exactInvalidFieldList: totalsReport && totalsReport.missingOrInvalidFields || null,
      freshnessRuntimeFlags: {
        staleFlag: guards.some(function(g){ return g.guard === "stale flag" && g.result === "DENY"; }),
        runtimeCacheFlag: guards.some(function(g){ return g.guard === "runtime cache flag" && g.result === "DENY"; }),
        readonlyNoRecalcFlag: "not_index_guard",
        passiveSummaryMode: !!(indexState && indexState.passiveSummaryMode),
        pagination: indexState && indexState.pagination || null,
        renderSignatureSkip: !!(indexState && indexState.renderSignatureSkip)
      },
      indexRenderState: indexState,
      renderGatingConditions: guards,
      indexRenderAllowDenyReasons: guards.map(function(g){ return { guard: g.guard, result: g.result, detail: g.detail }; }),
      whyTotalsHiddenDespiteFiniteTotals: exactGuard || summaryReport.whyIndexTotalsEmpty || "UNKNOWN",
      exactGuardThatReturnsTotalsEmpty: summaryReport.whyIndexTotalsEmpty === "TOTALS_EMPTY" ? (exactGuard || "TOTALS_EMPTY_GUARD") : "",
      whyIndexTotalsEmpty: summaryReport.whyIndexTotalsEmpty || "UNKNOWN"
    };
    try { console.table(report.renderGatingConditions); } catch (eTable) {}
    try { console.log("[summary-render][debug]", report); } catch (eLog) {}
    return report;
  };

  async function recalcAbonentSummaryExplicit(abonentOrId, options) {
    var opts = options || {};
    var period = await _resolveAbonentSummaryRecalcPeriod(abonentOrId, opts.period);
    var summary = null;
    var scopeOpt = String(opts.summaryScope || opts.summary_scope || "").toLowerCase();
    var periodActive = opts.saveSummary === false || scopeOpt === "period" || (!!opts.period && opts.saveSummary !== true && scopeOpt !== "full");

    try {
      if (!period.ok) throw new Error(period.error || "PERIOD_INVALID");
      summary = buildAbonentSummaryAfterExplicitRecalc(abonentOrId, period.from, period.to);
      if (periodActive) {
        summary.summary_scope = "period";
        summary.report_scope = "period";
      } else {
        summary.summary_scope = "full";
      }
    } catch (e) {
      var reason = _summaryCalcErrorCode(e);
      summary = buildAbonentSummaryErrorAfterExplicitRecalc(abonentOrId, period, reason);
      if (periodActive) {
        summary.summary_scope = "period";
        summary.report_scope = "period";
      } else {
        summary.summary_scope = "full";
      }
    }

    var saveResult = null;
    if (periodActive) {
      saveResult = { ok: true, skipped: true, reason: "PERIOD_SUMMARY_NOT_SAVED", summary_status: summary.summary_status || summary.status || "fresh", summary_reason: summary.summary_reason || summary.reason || "OK", summary_scope: "period" };
      try {
        console.log("[summary][skip-save-period-summary]", {
          uid: String(summary.account_uid || summary.uid || ""),
          periodActive: true,
          periodFrom: String(period && period.from || ""),
          periodTo: String(period && period.to || "")
        });
      } catch (eSkipLog) {}
    } else {
      try {
        console.log("[summary][save-full-summary]", {
          uid: String(summary.account_uid || summary.uid || ""),
          periodActive: false,
          periodFrom: String(period && period.from || ""),
          periodTo: String(period && period.to || "")
        });
      } catch (eFullLog) {}
      saveResult = await saveAbonentSummaryAfterRecalc(abonentOrId, summary);
    }
    var status = saveResult && (saveResult.summary_status || saveResult.status) || summary.summary_status || summary.status || "error";
    var reasonOut = saveResult && (saveResult.summary_reason || saveResult.reason) || summary.summary_reason || summary.reason || "";
    return {
      ok: !!(saveResult && saveResult.ok === true && status === "fresh"),
      uid: String(summary.account_uid || summary.uid || ""),
      summary_status: status,
      summary_reason: reasonOut,
      summary: summary,
      save: saveResult,
      status: status,
      reason: reasonOut
    };
  }

  async function recalculateAbonentCard(abonentOrId, options) {
    var opts = options || {};
    var ready = await waitForServerFirstDataReady({ timeoutMs: opts.timeoutMs || opts.timeout || 8000 });
    if (!ready || ready.ok !== true) {
      return { ok: false, uid: "", summary_status: "error", summary_reason: "SERVER_FIRST_DATA_NOT_READY", summary: null };
    }

    var found = _findAbonentByIdOrUid(abonentOrId);
    var abonent = found && found.abonent ? found.abonent : null;
    var abonentId = String(found && found.id || (abonent && abonent.id) || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
    var uid = String(abonent && abonent.uid || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.uid : "") || "").trim();

    if (!abonent || !abonentId) {
      return { ok: false, uid: uid, summary_status: "error", summary_reason: "ABONENT_NOT_FOUND", summary: null };
    }
    if (!isValidUid(uid)) {
      return { ok: false, uid: uid, summary_status: "error", summary_reason: "UID_REQUIRED", summary: null };
    }

    var ledgerKey = resolvePaymentLedgerKey(abonentOrId);
    if (ledgerKey !== ("payments_" + uid)) {
      return { ok: false, uid: uid, summary_status: "error", summary_reason: "UID_LEDGER_PATH_REQUIRED", summary: null };
    }

    var canonicalRaw = _getProjectRaw(ledgerKey);
    var legacyKey = _legacyLedgerKeyForAbonent(abonentId, abonent);
    if ((canonicalRaw === null || canonicalRaw === undefined) && legacyKey && legacyKey !== ledgerKey) {
      var legacyInfo = _safeLedgerInfoForDiagnostic(legacyKey);
      if (legacyInfo.rowsCount > 0) {
        _logFreshBlockedLegacyLedger({
          abonentId: abonentId,
          uid: uid,
          legacyKey: legacyKey,
          canonicalKey: ledgerKey,
          legacyRowsCount: legacyInfo.rowsCount,
          reason: "LEGACY_LEDGER_MIGRATION_REQUIRED"
        });
        return {
          ok: false,
          uid: uid,
          summary_status: "error",
          summary_reason: "LEGACY_LEDGER_MIGRATION_REQUIRED",
          summary: null,
          status: "error",
          reason: "LEGACY_LEDGER_MIGRATION_REQUIRED"
        };
      }
    }

    try {
      var raw = canonicalRaw;
      if (raw !== null && raw !== undefined) _parseLedgerRows(raw, ledgerKey);
    } catch (e) {
      var ledgerReason = _summaryCalcErrorCode(e);
      var periodForError = await _resolveAbonentSummaryRecalcPeriod(abonentOrId, opts.period);
      var errorSummary = buildAbonentSummaryErrorAfterExplicitRecalc(abonentOrId, periodForError, ledgerReason);
      var errorScopeOpt = String(opts.summaryScope || opts.summary_scope || "").toLowerCase();
      var periodErrorScope = opts.saveSummary === false || errorScopeOpt === "period" || (!!opts.period && opts.saveSummary !== true && errorScopeOpt !== "full");
      if (periodErrorScope) {
        errorSummary.summary_scope = "period";
        errorSummary.report_scope = "period";
        try {
          console.log("[summary][skip-save-period-summary]", {
            uid: uid,
            periodActive: true,
            periodFrom: String(periodForError && periodForError.from || ""),
            periodTo: String(periodForError && periodForError.to || "")
          });
        } catch (eSkipErrLog) {}
      }
      var errorSave = periodErrorScope
        ? { ok: true, skipped: true, reason: "PERIOD_SUMMARY_NOT_SAVED", summary_status: errorSummary.summary_status || errorSummary.status || "error", summary_reason: errorSummary.summary_reason || errorSummary.reason || ledgerReason, summary_scope: "period" }
        : await saveAbonentSummaryAfterRecalc(abonentOrId, errorSummary);
      return {
        ok: false,
        uid: uid,
        summary_status: "error",
        summary_reason: ledgerReason,
        summary: errorSummary,
        save: errorSave,
        status: "error",
        reason: ledgerReason
      };
    }

    var result = await recalcAbonentSummaryExplicit(abonentOrId, opts);
    return {
      ok: !!(result && result.ok === true),
      uid: uid,
      summary_status: result && (result.summary_status || result.status) || "error",
      summary_reason: result && (result.summary_reason || result.reason) || "",
      summary: result && result.summary || null,
      save: result && result.save,
      status: result && (result.summary_status || result.status) || "error",
      reason: result && (result.summary_reason || result.reason) || ""
    };
  }



  // ============================================================
  // Service layer API (CANON v1.6)
  // ============================================================
  function normalizeRegnumValue(v) {
    return String(v || "").trim();
  }
  function normalizeOfficialRegnumValue(v) {
    return String(v || "").trim().replace(/\s+/g, " ");
  }

  function listByObjectValues(obj) {
    if (!obj || typeof obj !== "object") return [];
    return Object.keys(obj).map(function (k) { return obj[k]; });
  }

  var Data = {
    __canon_v16: true,
    normalizeExcludePeriodsList: normalizeExcludePeriodsList,
    readCanonicalExcludePeriods: readCanonicalExcludePeriods,
    writeCanonicalExcludePeriods: writeCanonicalExcludePeriods,
    repairEmptyExcludePeriodsKeys: repairEmptyExcludePeriodsKeys,
    isValidUid: isValidUid,
    migrateLegacyCalcPeriodKeysForDb: migrateLegacyCalcPeriodKeysForDb,
    ensureAbonentUid: ensureAbonentUid,
    resolveCalcPeriodStorageKey: resolveCalcPeriodStorageKey,
    resolveCalcPeriodActiveStorageKey: resolveCalcPeriodActiveStorageKey,
    resolvePaymentLedgerKey: resolvePaymentLedgerKey,
    getRuntimeCacheKey: getRuntimeCacheKey,
    resolveRuntimeCacheKey: resolveRuntimeCacheKey,
    computeLedgerRuntimeVersion: computeLedgerRuntimeVersion,
    computeLedgerVersion: computeLedgerVersion,
    readLedgerRuntimeCache: readLedgerRuntimeCache,
    getRuntimeCache: getRuntimeCache,
    writeLedgerRuntimeCache: writeLedgerRuntimeCache,
    setRuntimeCache: setRuntimeCache,
    invalidateLedgerRuntimeCache: invalidateLedgerRuntimeCache,
    invalidateRuntimeCache: invalidateRuntimeCache,
    readPaymentLedger: readPaymentLedger,
    loadAbonentSummaryPage: loadAbonentSummaryPage,
    validateAbonentSummaryRecalcBatch: validateAbonentSummaryRecalcBatch,
    createAbonentSummaryRecalcBatchJob: createAbonentSummaryRecalcBatchJob,
    runAbonentSummaryRecalcBatchJob: runAbonentSummaryRecalcBatchJob,
    getAbonentSummaryRecalcBatchJob: getAbonentSummaryRecalcBatchJob,
    getAbonentSummaryRecalcBatchJobLatest: getAbonentSummaryRecalcBatchJobLatest,
    resolveAbonentRegnumForSummary: resolveAbonentRegnumForSummary,
    buildAbonentSummaryAfterExplicitRecalc: buildAbonentSummaryAfterExplicitRecalc,
    recalcAbonentSummaryExplicit: recalcAbonentSummaryExplicit,
    recalculateAbonentCard: recalculateAbonentCard,
    waitForServerFirstDataReady: waitForServerFirstDataReady,
    saveAbonentSummaryAfterRecalc: saveAbonentSummaryAfterRecalc,
    markAbonentSummaryDirty: markAbonentSummaryDirty,
    writePaymentLedger: writePaymentLedger,
    createEmptyPaymentLedger: createEmptyPaymentLedger,
    normalizeFinancialMode: normalizeFinancialMode,
    recordFinancialEvent: recordFinancialEvent,
    financialModes: {
      WITH_DEBT: "WITH_DEBT",
      WITHOUT_DEBT: "WITHOUT_DEBT",
      NO_DEBT: "WITHOUT_DEBT",
      SPLIT_PREMISES: "SPLIT_PREMISES"
    },

    // READ
    getDb: function () {
      return window.AbonentsDB || null;
    },
    listAbonents: function () {
      var db = this.getDb();
      return listByObjectValues(db && db.abonents);
    },
    getAbonent: function (abonentId) {
      var db = this.getDb();
      if (!db || !db.abonents) return null;
      return db.abonents[String(abonentId)] || null;
    },
    listPremises: function () {
      var db = this.getDb();
      return listByObjectValues(db && db.premises);
    },
    getPremise: function (regnum) {
      var db = this.getDb();
      if (!db || !db.premises) return null;
      return db.premises[normalizeRegnumValue(regnum)] || null;
    },
    getLinksForAbonent: function (abonentId) {
      var db = this.getDb();
      if (!db || !Array.isArray(db.links)) return [];
      var id = String(abonentId);
      return db.links.filter(function (l) { return String(l && l.abonentId) === id; });
    },
    getLinksForPremise: function (regnum) {
      var db = this.getDb();
      if (!db || !Array.isArray(db.links)) return [];
      var r = normalizeRegnumValue(regnum);
      return db.links.filter(function (l) { return normalizeRegnumValue(l && l.regnum) === r; });
    },
    getPremiseEventsForRegnum: function (regnum) {
      var db = this.getDb();
      if (!db || !Array.isArray(db.premiseEvents)) return [];
      var r = normalizeRegnumValue(regnum);
      return db.premiseEvents.filter(function (e) {
        var from = Array.isArray(e && e.fromRegnums) ? e.fromRegnums : [];
        var to = Array.isArray(e && e.toRegnums) ? e.toRegnums : [];
        return from.indexOf(r) >= 0 || to.indexOf(r) >= 0;
      });
    },

    // WRITE
    ensureWriteOrExplain: function () {
      return canWriteOrExplain();
    },
    // SERVER-FIRST helper for UI-level async flows:
    // local save -> upload to server. Throws on upload error.
    flushDbToServer: async function () {
      if (!this.ensureWriteOrExplain()) return false;
      var saved = !!(window.saveAbonentsDB && window.saveAbonentsDB());
      if (!saved) throw new Error("LOCAL_SAVE_FAILED");
      if (!(window.JKHRemoteSync && typeof window.JKHRemoteSync.uploadNow === "function")) {
        throw new Error("JKHRemoteSync.uploadNow is not available");
      }
      var ok = await window.JKHRemoteSync.uploadNow();
      if (ok !== true) throw new Error("SERVER_UPLOAD_FAILED");
      return true;
    },
    ensurePremise: function (premiseObj) {
      if (!this.ensureWriteOrExplain()) return false;
      if (!window.AbonentsDB) return false;

      var regnum = normalizeRegnumValue(premiseObj && premiseObj.regnum);
      if (!regnum) return false;

      if (!window.AbonentsDB.premises || typeof window.AbonentsDB.premises !== "object") {
        window.AbonentsDB.premises = {};
      }

      var current = window.AbonentsDB.premises[regnum] || {};
      var merged = Object.assign({}, current, premiseObj || {});
      merged.regnum = regnum;
      merged.officialRegnum = normalizeOfficialRegnumValue(merged.officialRegnum);
      if (merged.officialRegnum) merged.regnumType = "official";
      else if (!String(merged.regnumType || "").trim()) merged.regnumType = "temp";
      merged.createdAt = safeFinancialDateValue(merged.createdAt);
      console.log("[premises][official-regnum] normalized", regnum);

      window.AbonentsDB.premises[regnum] = merged;
      return !!window.saveAbonentsDB && window.saveAbonentsDB();
    },
    linkAbonentToPremise: function (abonentId, regnum, dateFrom, dateTo) {
      if (!this.ensureWriteOrExplain()) return false;
      if (!window.AbonentsDB) return false;

      var id = String(abonentId || "").trim();
      var r = normalizeRegnumValue(regnum);
      if (!id || !r) return false;

      if (!Array.isArray(window.AbonentsDB.links)) window.AbonentsDB.links = [];

      var existing = window.AbonentsDB.links.find(function (l) {
        return String(l && l.abonentId) === id && normalizeRegnumValue(l && l.regnum) === r;
      });

      if (existing) {
        if (dateFrom !== undefined) existing.dateFrom = String(dateFrom || "");
        if (dateTo !== undefined) existing.dateTo = String(dateTo || "");
      } else {
        window.AbonentsDB.links.push({
          abonentId: id,
          regnum: r,
          dateFrom: String(dateFrom || ""),
          dateTo: String(dateTo || "")
        });
      }

      return !!window.saveAbonentsDB && window.saveAbonentsDB();
    },
    unlinkAbonentFromPremise: function (abonentId, regnum) {
      if (!this.ensureWriteOrExplain()) return false;
      if (!window.AbonentsDB || !Array.isArray(window.AbonentsDB.links)) return false;

      var id = String(abonentId || "").trim();
      var r = normalizeRegnumValue(regnum);
      var before = window.AbonentsDB.links.length;
      window.AbonentsDB.links = window.AbonentsDB.links.filter(function (l) {
        return !(String(l && l.abonentId) === id && normalizeRegnumValue(l && l.regnum) === r);
      });

      if (before === window.AbonentsDB.links.length) return true;
      return !!window.saveAbonentsDB && window.saveAbonentsDB();
    },
    // IMPORTANT: local upsert only (does NOT upload to server by itself).
    // Full server-first transaction must be orchestrated in UI async flow.
    upsertAbonent: function (abonentObj) {
      if (!this.ensureWriteOrExplain()) return false;
      if (!window.AbonentsDB) return false;

      var input = Object.assign({}, abonentObj || {});
      var id = String(input.id || "").trim();
      if (!id) return false;

      if (!window.AbonentsDB.abonents || typeof window.AbonentsDB.abonents !== "object") {
        window.AbonentsDB.abonents = {};
      }

      var existedBefore = !!window.AbonentsDB.abonents[id];
      if (!existedBefore) removeLegacyExcludeFields(input);

      ensureAbonentUidOnRecord(window.AbonentsDB, id, input, { source: "upsertAbonent" });

      var regnum = normalizeRegnumValue(input.premiseRegnum || input.regnum);
      if (regnum) {
        input.premiseRegnum = regnum;
        input.regnum = regnum;
      }

      window.AbonentsDB.abonents[id] = input;
      if (!existedBefore) writeCanonicalExcludePeriods(id, []);

      if (regnum) {
        var premiseObj = {
          regnum: regnum,
          city: input.city || "",
          street: input.street || "",
          house: input.house || "",
          flat: input.flat || "",
          square: input.square !== undefined ? input.square : (input.totalArea !== undefined ? input.totalArea : ""),
          createdAt: safeFinancialDateValue(input.premiseCreatedAt || input.premiseCreated),
          officialRegnum: normalizeOfficialRegnumValue(input.officialRegnum || "")
        };
        this.ensurePremise(premiseObj);
        this.linkAbonentToPremise(
          id,
          regnum,
          input.calcStartDate || input.startDate || "",
          input.calcEndDate || input.endDate || ""
        );
      }

      return !!window.saveAbonentsDB && window.saveAbonentsDB();
    },
    deleteAbonent: function (abonentId) {
      if (!this.ensureWriteOrExplain()) return false;
      if (!window.AbonentsDB) return false;
      var id = String(abonentId || "").trim();
      if (!id) return false;

      if (window.AbonentsDB.abonents && window.AbonentsDB.abonents[id]) {
        delete window.AbonentsDB.abonents[id];
      }
      if (Array.isArray(window.AbonentsDB.links)) {
        window.AbonentsDB.links = window.AbonentsDB.links.filter(function (l) {
          return String(l && l.abonentId) !== id;
        });
      }

      return !!window.saveAbonentsDB && window.saveAbonentsDB();
    },
    mergePremises: async function (options) {
      // TODO/CRITICAL: merge changes responsibility links and creates a new abonent;
      // it must be moved under the same canonical responsibility transaction boundary as Data.transferResponsibility.
      if (!this.ensureWriteOrExplain()) return false;
      if (!window.AbonentsDB) throw new Error("DB_NOT_READY");
      console.log("[premise-transform] merge start");

      var db = window.AbonentsDB;
      var snapshot = deepClone(db);
      try {
        if (!db.premises || typeof db.premises !== "object") db.premises = {};
        if (!Array.isArray(db.links)) db.links = [];
        if (!Array.isArray(db.premiseEvents)) db.premiseEvents = [];

        var fromRegnumsRaw = Array.isArray(options && options.fromRegnums) ? options.fromRegnums : [];
        var fromRegnums = fromRegnumsRaw.map(normalizeRegnumValue).filter(Boolean);
        if (fromRegnums.length < 2) throw new Error("MERGE_FROM_MIN_2_REQUIRED");

        var date = String(options && options.date || "").trim();
        if (!date) throw new Error("MERGE_DATE_REQUIRED");

        var toPremise = Object.assign({}, options && options.toPremise || {});
        var officialRegnum = normalizeOfficialRegnumValue(toPremise.officialRegnum || "");
        var newRegnum = normalizeRegnumValue(toPremise.regnum);
        if (!newRegnum) {
          newRegnum = _generateUniqueTempRegnum(db);
          console.log("[premise-transform] generated regnum", newRegnum);
        }
        if (db.premises[newRegnum]) throw new Error("MERGE_TO_REGNUM_EXISTS");
        if (officialRegnum) {
          var duplicateOfficial = Object.keys(db.premises).find(function (rk) {
            return normalizeOfficialRegnumValue(db.premises[rk] && db.premises[rk].officialRegnum) === officialRegnum;
          });
          if (duplicateOfficial) throw new Error("MERGE_TO_OFFICIAL_REGNUM_DUP:" + duplicateOfficial);
        }

        for (var i = 0; i < fromRegnums.length; i++) {
          var rr = fromRegnums[i];
          var oldPremise = db.premises[rr];
          if (!oldPremise) throw new Error("MERGE_FROM_NOT_FOUND:" + rr);
          var st = String(oldPremise.status || "active").trim() || "active";
          if (st !== "active") throw new Error("MERGE_FROM_NOT_ACTIVE:" + rr);
        }
        console.log("[premise-transform] validate ok");

        var dt = new Date(date + "T12:00:00");
        dt.setDate(dt.getDate() - 1);
        var closeY = dt.getFullYear();
        var closeM = String(dt.getMonth() + 1).padStart(2, "0");
        var closeD = String(dt.getDate()).padStart(2, "0");
        var closedAt = closeY + "-" + closeM + "-" + closeD;

        var activeFromLinks = [];
        var activeFromMap = {};
        db.links.forEach(function (l) {
          var rr = normalizeRegnumValue(l && l.regnum);
          if (fromRegnums.indexOf(rr) >= 0 && !String(l && l.dateTo || "").trim()) {
            activeFromLinks.push(l);
            if (!activeFromMap[rr]) activeFromMap[rr] = l;
          }
        });
        var responsibleSet = {};
        for (var af = 0; af < activeFromLinks.length; af++) {
          var rid = String(activeFromLinks[af] && activeFromLinks[af].abonentId || "").trim();
          if (rid) responsibleSet[rid] = true;
        }
        var responsibleIds = Object.keys(responsibleSet);
        if (responsibleIds.length > 1 && typeof window.confirm === "function") {
          var newRespId = String(options && options.newResponsibleAbonentId || "").trim();
          var newRespA = (db.abonents && newRespId) ? db.abonents[newRespId] : null;
          var newRespName = String(newRespA && newRespA.fio || "").trim();
          var newRespText = newRespId ? (newRespName ? (newRespId + " — " + newRespName) : newRespId) : "— не назначен —";
          console.log("[premise-transform] different responsibles confirm");
          var ok = window.confirm(
            "Вы объединяете квартиры с разными ответственными.\n" +
            "Их ответственность по старым квартирам будет закрыта.\n" +
            "Новым ответственным станет: " + newRespText + ".\n" +
            "Продолжить?"
          );
          if (!ok) throw new Error("MERGE_CANCELLED_BY_USER");
        }

        for (var j = 0; j < fromRegnums.length; j++) {
          var fromR = fromRegnums[j];
          var cur = db.premises[fromR] || {};
          db.premises[fromR] = Object.assign({}, cur, {
            status: "merged",
            closedAt: closedAt,
            closedReason: "Объединение квартир",
            mergedIntoRegnum: newRegnum
          });
          console.log("[premise-transform] close old premise", fromR);
        }

        console.log("[premise-transform] create new premise", newRegnum);
        db.premises[newRegnum] = {
          regnum: newRegnum,
          city: String(toPremise.city || ""),
          street: String(toPremise.street || ""),
          house: String(toPremise.house || ""),
          flat: String(toPremise.flat || ""),
          square: toPremise.square !== undefined ? toPremise.square : "",
          createdAt: String(date),
          officialRegnum: officialRegnum,
          regnumType: officialRegnum ? "official" : "temp",
          status: "active",
          createdFromMergeRegnums: fromRegnums.slice(),
          mergedAt: date
        };
        console.log("[premise-transform] merge createdAt forced to date", date);

        db.links.forEach(function (l) {
          var r = normalizeRegnumValue(l && l.regnum);
          if (fromRegnums.indexOf(r) >= 0 && !String(l && l.dateTo || "").trim()) {
            l.dateTo = closedAt;
            console.log("[premise-transform] close responsible", String(l && l.abonentId || ""), r, closedAt);
            var oldId = String(l && l.abonentId || "").trim();
            if (oldId && db.abonents && db.abonents[oldId]) {
              db.abonents[oldId].calcEndDate = closedAt;
              console.log("[premise-transform] old abonent closed", oldId, closedAt);
            }
          }
        });

        var newResp = String(options && options.newResponsibleAbonentId || "").trim();
        if (!newResp) throw new Error("MERGE_RESPONSIBLE_REQUIRED");
        if (!db.abonents || !db.abonents[newResp]) throw new Error("MERGE_RESPONSIBLE_NOT_FOUND");

        function _generateNewLs(abonents, flatValue) {
          var maxNum = -1;
          Object.keys(abonents || {}).forEach(function (k) {
            var id = String(k || "").trim();
            var m = id.match(/^(\d+)(?:-|$)/);
            if (!m) return;
            var n = Number(m[1]);
            if (isFinite(n) && n > maxNum) maxNum = n;
          });
          var flatPart = String(flatValue || "").trim() || "MERGE";
          var base = "";
          if (maxNum >= 0) base = String(maxNum + 1) + "-" + flatPart;
          else base = String(Date.now()) + "-" + flatPart;
          var candidate = base;
          var suffix = 1;
          while (abonents && abonents[candidate]) {
            candidate = base + "-" + String(suffix++);
          }
          return candidate;
        }

        function _generateNewUid() {
          try {
            if (typeof window.generateUid === "function") return String(window.generateUid());
          } catch (e) { }
          return "uid_m" + String(Date.now()) + "_" + String(Math.floor(Math.random() * 1000000));
        }
        var generatedNewId = _generateNewLs(db.abonents, toPremise.flat);
        var generatedNewUid = _generateNewUid();
        console.log("[premise-transform] new LS generated", generatedNewId);
        console.log("[premise-transform] new UID generated", generatedNewUid);

        var sourceAbonent = db.abonents[newResp] || {};
        var newAbonent = Object.assign({}, sourceAbonent, {
          id: generatedNewId,
          uid: generatedNewUid,
          fio: String(sourceAbonent.fio || ""),
          fam: sourceAbonent.fam,
          name: sourceAbonent.name,
          otch: sourceAbonent.otch,
          phone: sourceAbonent.phone,
          share: sourceAbonent.share,
          rooms: sourceAbonent.rooms,
          regnum: newRegnum,
          premiseRegnum: newRegnum,
          city: String(toPremise.city || ""),
          street: String(toPremise.street || ""),
          house: String(toPremise.house || ""),
          flat: String(toPremise.flat || ""),
          square: toPremise.square !== undefined ? toPremise.square : "",
          calcStartDate: date,
          calcEndDate: "",
          premiseCreatedAt: date,
          createdFromMerge: true,
          sourceAbonentId: newResp,
          sourceMergeEventId: ""
        });
        removeLegacyExcludeFields(newAbonent);
        db.abonents[generatedNewId] = newAbonent;
        writeCanonicalExcludePeriods(generatedNewId, []);
        if (createEmptyPaymentLedger(generatedNewId) !== true) throw new Error("MERGE_LEDGER_INIT_FAILED");
        console.log("[premise-transform][excludes] new abonent initialized empty", { abonentId: generatedNewId });
        console.log("[premise-transform] new abonent generated", generatedNewId, "from", newResp);
        console.log("[premise-transform] old LS preserved", newResp);

        db.links.push({ abonentId: generatedNewId, regnum: newRegnum, dateFrom: date, dateTo: "" });
        console.log("[premise-transform] new responsibility period created", generatedNewId, newRegnum, date);
        console.log("[premise-transform] new active link created", generatedNewId, newRegnum);

        var ev = {
          id: "evt_" + Date.now() + "_" + Math.floor(Math.random() * 1000000),
          type: "MERGE",
          date: date,
          fromRegnums: fromRegnums.slice(),
          toRegnums: [newRegnum],
          reason: String(options && options.reason || ""),
          documentNumber: String(options && options.documentNumber || ""),
          documentDate: String(options && options.documentDate || ""),
          createdAt: (new Date()).toISOString(),
          createdBy: _ownerId()
        };
        ev.newAbonentId = generatedNewId;
        ev.sourceAbonentId = newResp;
        db.premiseEvents.push(ev);
        if (db.abonents && db.abonents[generatedNewId]) {
          db.abonents[generatedNewId].sourceMergeEventId = ev.id;
        }
        console.log("[premise-transform] event saved");

        await this.flushDbToServer();
        console.log("[premise-transform] flush success");
        markAbonentSummaryDirtyLater(generatedNewId, "RESPONSIBILITY_CHANGED");
        Object.keys(responsibleSet || {}).forEach(function(respId){ markAbonentSummaryDirtyLater(respId, "RESPONSIBILITY_CHANGED"); });
        return ev;
      } catch (e) {
        window.AbonentsDB = snapshot;
        try { if (window.saveAbonentsDB) window.saveAbonentsDB(); } catch (e2) { }
        console.log("[premise-transform] flush failed rollback");
        throw e;
      }
    }
  };

  

  // ============================================================
  // TRANSFER API (CANON TRANSFER v1.7)
  // Поддержка "передачи квартиры" с переносом долга и пени.
  // Ключи:
  //   jkh_freeze_to_v1:<fromId>                 — дата заморозки расчёта у старого
  //   jkh_frozen_debt_v1:<fromId>:<freezeISO>   — снимок долга+пени на дату заморозки
  //   jkh_transfer_to_v1:<toId>                 — мета переноса (совместимость со сторонней инструкцией)
  //   jkh_transfer_balance_v1:<toId>:<regnum>   — КАНОН (использует calc_engine.js)
  // ============================================================

  function __isoYesterday(iso){
    try{
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso||"").trim())) return "";
      var d = new Date(String(iso) + "T12:00:00");
      d.setDate(d.getDate() - 1);
      var y = d.getFullYear();
      var m = String(d.getMonth()+1).padStart(2,'0');
      var dd = String(d.getDate()).padStart(2,'0');
      return y + "-" + m + "-" + dd;
    }catch(e){ return ""; }
  }


  var DEBT_TRANSFER_FATAL_MESSAGE = "Перенос долга остановлен: не удалось надёжно рассчитать долг старого абонента.";

  function __makeDebtTransferError(code, details, cause){
    var err = new Error(DEBT_TRANSFER_FATAL_MESSAGE);
    err.code = code || "DEBT_TRANSFER_ABORTED";
    err.details = details || {};
    err.cause = cause;
    return err;
  }

  function __isDebtTransferError(e){
    var code = String(e && e.code || "");
    return code === "FROZEN_DEBT_CALC_FAILED" ||
      code === "FROZEN_DEBT_JSON_INVALID" ||
      code === "TRANSFER_BALANCE_JSON_INVALID" ||
      code === "TRANSFER_BALANCE_MISSING" ||
      code === "DEBT_TRANSFER_ABORTED" ||
      code === "LEDGER_JSON_INVALID";
  }

  function __logDebtTransferAbort(err){
    try{
      var code = String(err && err.code || "DEBT_TRANSFER_ABORTED");
      if (code === "FROZEN_DEBT_CALC_FAILED" || code === "LEDGER_JSON_INVALID") {
        console.error("[fatal][frozen-debt-calc-failed]", { code: code, details: err && err.details || {}, error: err && (err.cause || err) });
      }
      console.error("[debt-transfer][aborted]", { code: code, details: err && err.details || {}, error: err && (err.cause || err) });
    }catch(e){}
  }

  function __abortDebtTransfer(code, details, cause){
    throw __makeDebtTransferError(code, details, cause);
  }

  function __parseDebtJson(raw, code, key){
    try{
      if (!raw) __abortDebtTransfer(code, { key: key, reason: "MISSING" });
      var obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        __abortDebtTransfer(code, { key: key, reason: "NOT_OBJECT" });
      }
      return obj;
    }catch(e){
      if (__isDebtTransferError(e)) throw e;
      __abortDebtTransfer(code, { key: key, reason: "JSON_INVALID" }, e);
    }
  }

  function __validateFrozenDebt(obj, code, key){
    var principal = Number(obj && obj.principal);
    var penalty = Number(obj && obj.penalty);
    if (!Number.isFinite(principal) || !Number.isFinite(penalty)) {
      __abortDebtTransfer(code, { key: key, reason: "DEBT_AMOUNTS_INVALID" });
    }
    if (principal === 0 && penalty === 0 && obj.success !== true) {
      __abortDebtTransfer(code, { key: key, reason: "ZERO_DEBT_NOT_PROVEN" });
    }
    return {
      success: obj.success === true,
      principal: principal,
      penalty: penalty,
      calculatedAt: String(obj.calculatedAt || "")
    };
  }

  function prepareDebtTransfer(oldAbonentId, newAbonentId, regnum, transferDate, transferMode){
    if (!Data.ensureWriteOrExplain()) return false;

    try{
      var oldId = String(oldAbonentId||"").trim();
      var newId = String(newAbonentId||"").trim();
      var rn    = String(regnum||"").trim();
      var td    = String(transferDate||"").trim();
      var mode  = normalizeFinancialMode(transferMode || "WITH_DEBT");
      var legacyMode = (mode === "WITH_DEBT") ? "WITH_DEBT" : "NO_DEBT";

      if (!oldId || !newId || !rn || !/^\d{4}-\d{2}-\d{2}$/.test(td)) return false;

      // freezeDate = день ДО даты передачи
      var freezeISO = __isoYesterday(td);
      if (!freezeISO) return false;

      var frozenDebt = null;
      var frozenKey = "jkh_frozen_debt_v1:" + oldId + ":" + freezeISO;

      // 1) В режиме WITH_DEBT долг старого должен быть рассчитан явно.
      if (mode === "WITH_DEBT"){
        if (window.JKHCalcEngine && typeof window.JKHCalcEngine.calculateFrozenDebt === "function"){
          try{
            frozenDebt = window.JKHCalcEngine.calculateFrozenDebt(oldId, freezeISO);
          }catch(calcFrozenErr){
            if (__isDebtTransferError(calcFrozenErr) && calcFrozenErr.code === "FROZEN_DEBT_CALC_FAILED") throw calcFrozenErr;
            __abortDebtTransfer("FROZEN_DEBT_CALC_FAILED", { oldAbonentId: oldId, freezeISO: freezeISO }, calcFrozenErr);
          }
        }else if (window.JKHCalcEngine && typeof window.JKHCalcEngine.calcTotalsAsOfAdjusted === "function"){
          try{
            var rows = (window.JKHCalcEngine.loadPaymentsForAbonent)
              ? window.JKHCalcEngine.loadPaymentsForAbonent(oldId)
              : readPaymentLedger(oldId);
            var d = new Date(String(freezeISO)+"T12:00:00");
            var tot = window.JKHCalcEngine.calcTotalsAsOfAdjusted(rows, d, { abonentId: oldId, applyAdvanceOffset:true, allowNegativePrincipal:false });
            var principal = Number(tot && tot.principal);
            var penalty = Number(tot && tot.penaltyDebt);
            if (!Number.isFinite(principal) || !Number.isFinite(penalty)) throw new Error("calculated totals are invalid");
            frozenDebt = { success: true, principal: principal, penalty: penalty, calculatedAt: freezeISO };
          }catch(calcErr){
            __abortDebtTransfer("FROZEN_DEBT_CALC_FAILED", { oldAbonentId: oldId, freezeISO: freezeISO }, calcErr);
          }
        }else{
          __abortDebtTransfer("FROZEN_DEBT_CALC_FAILED", { oldAbonentId: oldId, freezeISO: freezeISO, reason: "CALC_ENGINE_UNAVAILABLE" });
        }

        frozenDebt = __validateFrozenDebt(frozenDebt, "FROZEN_DEBT_CALC_FAILED", frozenKey);
        if (frozenDebt.calculatedAt && frozenDebt.calculatedAt !== freezeISO) {
          __abortDebtTransfer("FROZEN_DEBT_CALC_FAILED", { key: frozenKey, reason: "CALCULATED_AT_MISMATCH", calculatedAt: frozenDebt.calculatedAt, freezeISO: freezeISO });
        }

        _setProjectRaw(frozenKey, JSON.stringify({
          success: true,
          principal: frozenDebt.principal,
          penalty: frozenDebt.penalty,
          calculatedAt: freezeISO
        }));

        var frozenRaw = _getProjectRaw(frozenKey);
        frozenDebt = __validateFrozenDebt(__parseDebtJson(frozenRaw, "FROZEN_DEBT_JSON_INVALID", frozenKey), "FROZEN_DEBT_JSON_INVALID", frozenKey);
      }

      // 2) Установить дату заморозки расчёта у старого
      _setProjectRaw("jkh_freeze_to_v1:" + oldId, freezeISO);

      // 3) Записать метаданные переноса
      if (mode === "WITH_DEBT"){
        _setProjectRaw("jkh_transfer_to_v1:" + newId, JSON.stringify({
          fromAbonentId: oldId,
          regnum: rn,
          transferDate: td,
          transferMode: "WITH_DEBT",
          createdAt: (new Date()).toISOString()
        }));

        // 3a) КАНОН: transfer_balance для движка (по regnum)
        var transferBalanceKey = "jkh_transfer_balance_v1:" + newId + ":" + rn;
        _setProjectRaw(transferBalanceKey, JSON.stringify({
          success: true,
          startDate: td,
          principal: frozenDebt.principal,
          penalty: frozenDebt.penalty,
          regnum: rn,
          fromAbonentId: oldId,
          mode: "WITH_DEBT"
        }));

        __validateFrozenDebt(__parseDebtJson(_getProjectRaw(transferBalanceKey), "TRANSFER_BALANCE_JSON_INVALID", transferBalanceKey), "TRANSFER_BALANCE_JSON_INVALID", transferBalanceKey);
        recordFinancialEvent({
          type: "TRANSFER_WITH_DEBT",
          mode: "WITH_DEBT",
          sourceAbonentId: oldId,
          targetAbonentId: newId,
          premiseId: rn,
          regnum: rn,
          date: td,
          debtAmount: (Number(frozenDebt.principal) || 0) + (Number(frozenDebt.penalty) || 0),
          balanceAmount: (Number(frozenDebt.principal) || 0) + (Number(frozenDebt.penalty) || 0)
        });
      } else {
        // NO_DEBT: снимаем возможные хвосты переноса на нового (на всякий случай)
        try{ _removeProjectRaw("jkh_transfer_to_v1:" + newId); }catch(e){}
        try{ _removeProjectRaw("jkh_transfer_balance_v1:" + newId + ":" + rn); }catch(e){}
        recordFinancialEvent({
          type: "TRANSFER_WITHOUT_DEBT",
          mode: "WITHOUT_DEBT",
          sourceAbonentId: oldId,
          targetAbonentId: newId,
          premiseId: rn,
          regnum: rn,
          date: td,
          debtAmount: 0,
          balanceAmount: 0
        });
      }

      // 4) Обновить поля периодов расчёта в AbonentsDB
      var db = window.AbonentsDB;
      if (db && db.abonents){
        if (db.abonents[oldId]){
          db.abonents[oldId].calcEndDate = freezeISO;
          db.abonents[oldId].frozenDebtDate = freezeISO;
        }
        if (db.abonents[newId]){
          db.abonents[newId].calcStartDate = td;
          db.abonents[newId].calcEndDate = "";
          db.abonents[newId].debtTransferredFrom = (mode === "WITH_DEBT") ? oldId : null;
        }
        window.saveAbonentsDB && window.saveAbonentsDB();
      }

      return true;
    }catch(e){
      var err = __isDebtTransferError(e) ? e : __makeDebtTransferError("DEBT_TRANSFER_ABORTED", {}, e);
      __logDebtTransferAbort(err);
      try{ alert(DEBT_TRANSFER_FATAL_MESSAGE); }catch(alertErr){}
      return false;
    }
  }



  function __normalizeTransferMode(mode){
    return normalizeFinancialMode(mode);
  }

  function __forceResponsibilityLedgerRecalc(ids){
    var unique = [];
    (ids || []).forEach(function(id){
      var v = String(id || "").trim();
      if (v && unique.indexOf(v) < 0) unique.push(v);
    });
    if (!unique.length) return { ok:true, changed:false, results:[] };
    if (!(window.JKHAutoAccrual && typeof window.JKHAutoAccrual.recalcForMany === "function")) {
      console.warn("[transfer-responsibility][ledger-recalc-skipped]", { reason:"AUTOACCRUAL_ENGINE_UNAVAILABLE", abonentIds: unique });
      return { ok:false, reason:"AUTOACCRUAL_ENGINE_UNAVAILABLE", results:[] };
    }
    var results = window.JKHAutoAccrual.recalcForMany(unique) || [];
    var failed = results.filter(function(r){ return !r || r.ok !== true; });
    if (failed.length) {
      console.warn("[transfer-responsibility][ledger-recalc-failed]", { abonentIds: unique, failed: failed });
      return { ok:false, reason:"RECALC_FAILED", results: results };
    }
    return {
      ok: true,
      changed: results.some(function(r){ return !!(r && r.changed); }),
      results: results
    };
  }

  function __paymentRowYmForTransferCheck(row){
    if (!row || typeof row !== "object") return "";
    var y = parseInt(String(row.year || row.y || ""), 10);
    var m = parseInt(String(row.month || row.m || ""), 10);
    if (y && m >= 1 && m <= 12) return String(y) + "-" + (m < 10 ? "0" + m : String(m));
    var ym = String(row.ym || row.yearMonth || row.y_m || "").trim();
    if (/^\d{4}-\d{2}$/.test(ym)) return ym;
    return "";
  }

  function __paymentAmountForTransferCheck(v){
    var n = parseFloat(String(v == null ? "" : v).replace(/\s+/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }

  function __paymentDateISOForTransferCheck(v){
    var s = String(v || "").trim();
    if (!s) return "";
    var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[1] + "-" + iso[2] + "-" + iso[3];
    var dmy = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (dmy) return dmy[3] + "-" + String(dmy[2]).padStart(2, "0") + "-" + String(dmy[1]).padStart(2, "0");
    return "";
  }

  function __verifyNoAccrualBeforeTransferMonth(abonentId, transferDate){
    var id = String(abonentId || "").trim();
    var td = String(transferDate || "").trim();
    var transferYm = /^\d{4}-\d{2}-\d{2}$/.test(td) ? td.slice(0, 7) : "";
    if (!id || !transferYm) return { ok:false, reason:"INVALID_ARGUMENTS" };

    var rows = readPaymentLedger(id) || [];
    var badAccrual = [];
    var badPayments = [];
    rows.forEach(function(r){
      var ym = __paymentRowYmForTransferCheck(r);
      if (ym && ym < transferYm && __paymentAmountForTransferCheck(r && r.accrued) > 0) {
        badAccrual.push({ ym: ym, accrued: __paymentAmountForTransferCheck(r && r.accrued), rowId: r && r.id });
      }

      var paid = __paymentAmountForTransferCheck(r && r.paid);
      var paidDate = __paymentDateISOForTransferCheck(r && r.paid_date);
      if (paid > 0 && paidDate && paidDate < td) {
        badPayments.push({ ym: ym, paid: paid, paid_date: paidDate, rowId: r && r.id });
      }
    });

    if (badAccrual.length) {
      console.warn("[transfer-responsibility][ledger-range-invalid]", { abonentId: id, transferDate: td, rows: badAccrual });
      return { ok:false, reason:"NEW_LEDGER_HAS_ACCRUAL_BEFORE_TRANSFER", rows: badAccrual };
    }
    if (badPayments.length) {
      console.warn("[transfer-responsibility][new-ledger-has-old-payments]", { newAbonentId: id, transferDate: td, rows: badPayments });
      return { ok:false, reason:"NEW_LEDGER_HAS_PAYMENTS_BEFORE_TRANSFER", rows: badPayments };
    }
    return { ok:true, rows: rows.length };
  }

  function __scheduleTransferFlushToServer(){
    try {
      if (!(window.Data && typeof window.Data.flushDbToServer === "function")) return;
      setTimeout(function(){
        try {
          var p = window.Data.flushDbToServer();
          if (p && typeof p.catch === "function") {
            p.catch(function(e){ console.warn("[transfer-responsibility][flush-failed]", e); });
          }
        } catch(e) {
          console.warn("[transfer-responsibility][flush-failed]", e);
        }
      }, 0);
    } catch(e) {}
  }

  function transferResponsibility(options){
    if (!Data.ensureWriteOrExplain()) return false;
    var db = window.AbonentsDB;
    if (!db || !db.abonents) return false;

    var opts = options || {};
    var oldId = String(opts.oldAbonentId || "").trim();
    var newId = String(opts.newAbonentId || "").trim();
    var rn = normalizeRegnumValue(opts.regnum);
    var td = String(opts.transferDate || opts.dateFrom || "").trim();
    var mode = __normalizeTransferMode(opts.transferMode || opts.mode);
    var legacyMode = (mode === "WITH_DEBT") ? "WITH_DEBT" : "NO_DEBT";
    var freezeISO = __isoYesterday(td);

    if (!oldId || !newId || !rn || !/^\d{4}-\d{2}-\d{2}$/.test(td) || !freezeISO) return false;
    if (!db.abonents[oldId] || !db.abonents[newId]) return false;
    if (!Array.isArray(db.links)) db.links = [];

    var activeLinks = db.links.filter(function(l){
      return normalizeRegnumValue(l && l.regnum) === rn && !String(l && l.dateTo || "").trim();
    });
    var oldActive = activeLinks.find(function(l){ return String(l && l.abonentId || "").trim() === oldId; });
    if (!oldActive) return false;
    var alreadyNewActive = activeLinks.find(function(l){ return String(l && l.abonentId || "").trim() === newId; });
    if (alreadyNewActive) return false;

    var snapshot = deepClone(db);
    var transferKeys = [
      "jkh_freeze_to_v1:" + oldId,
      "jkh_frozen_debt_v1:" + oldId + ":" + freezeISO,
      "jkh_transfer_to_v1:" + newId,
      "jkh_transfer_balance_v1:" + newId + ":" + rn,
      excludePeriodsStorageKey(newId),
      excludePeriodsStorageKey(oldId)
    ];
    try {
      var oldLedgerKey = resolvePaymentLedgerKey(oldId);
      var newLedgerKey = resolvePaymentLedgerKey(newId);
      if (oldLedgerKey) transferKeys.push(oldLedgerKey);
      if (newLedgerKey && transferKeys.indexOf(newLedgerKey) < 0) transferKeys.push(newLedgerKey);
    } catch(e) {}
    var transferRawSnapshot = {};
    transferKeys.forEach(function(k){ transferRawSnapshot[k] = _getProjectRaw(k); });
    try{
      if (prepareDebtTransfer(oldId, newId, rn, td, legacyMode) !== true) throw new Error("TRANSFER_PREPARE_FAILED");

      readCanonicalExcludePeriods(oldId);
      console.log("[transfer][excludes] old migrated", { abonentId: oldId });

      activeLinks.forEach(function(l){
        l.dateTo = freezeISO;
        var id = String(l && l.abonentId || "").trim();
        if (id && db.abonents && db.abonents[id]) {
          db.abonents[id].calcEndDate = freezeISO;
          db.abonents[id].frozenDebtDate = freezeISO;
        }
      });

      var existing = db.links.find(function(l){
        return String(l && l.abonentId || "").trim() === newId && normalizeRegnumValue(l && l.regnum) === rn;
      });
      if (existing) {
        existing.dateFrom = td;
        existing.dateTo = "";
      } else {
        db.links.push({ abonentId: newId, regnum: rn, dateFrom: td, dateTo: "" });
      }

      var newA = db.abonents[newId];
      removeLegacyExcludeFields(newA);
      console.log("[transfer][excludes] skipped legacy copy", { abonentId: newId });
      writeCanonicalExcludePeriods(newId, []);
      console.log("[transfer][excludes] new initialized empty", { abonentId: newId });
      if (createEmptyPaymentLedger(newId) !== true) throw new Error("TRANSFER_LEDGER_INIT_FAILED");
      var premise = db.premises && db.premises[rn] ? db.premises[rn] : {};
      newA.regnum = rn;
      newA.premiseRegnum = rn;
      newA.calcStartDate = td;
      newA.calcEndDate = "";
      newA.debtTransferredFrom = (mode === "WITH_DEBT") ? oldId : null;
      if (premise.city) newA.city = premise.city;
      if (premise.street) newA.street = premise.street;
      if (premise.house) newA.house = premise.house;
      if (premise.flat) newA.flat = premise.flat;
      if (premise.square !== undefined && premise.square !== null && premise.square !== "") newA.square = premise.square;

      var oldA = db.abonents[oldId];
      if (oldA) {
        if (!Array.isArray(oldA.history)) oldA.history = [];
        oldA.history.push({
          type: "responsibility_closed",
          date: (new Date()).toISOString().slice(0, 10),
          closeTo: freezeISO,
          regnum: rn,
          note: "Период ответственности закрыт при передаче квартиры"
        });
      }

      var transferMeta = {
        type: "premise_transfer",
        regnum: rn,
        fromAbonentId: oldId,
        fromFio: String(oldA && oldA.fio || ""),
        transferMode: mode,
        newRespFrom: td,
        oldRespTo: freezeISO,
        transferDebtApplied: mode === "WITH_DEBT",
        createdAt: (new Date()).toISOString().slice(0, 10)
      };
      newA.transferMeta = transferMeta;

      if (!Array.isArray(db.premiseEvents)) db.premiseEvents = [];
      db.premiseEvents.push({
        id: "evt_" + Date.now() + "_" + Math.floor(Math.random() * 1000000),
        type: "RESPONSIBILITY_TRANSFER",
        date: td,
        fromRegnums: [rn],
        toRegnums: [rn],
        oldAbonentId: oldId,
        newAbonentId: newId,
        transferMode: mode,
        oldRespTo: freezeISO,
        newRespFrom: td,
        createdAt: (new Date()).toISOString(),
        createdBy: _ownerId()
      });

      var recalc = __forceResponsibilityLedgerRecalc([oldId, newId]);
      if (!recalc || recalc.ok !== true) throw new Error("TRANSFER_LEDGER_RECALC_FAILED");

      var newLedgerRangeCheck = __verifyNoAccrualBeforeTransferMonth(newId, td);
      if (!newLedgerRangeCheck || newLedgerRangeCheck.ok !== true) throw new Error("TRANSFER_NEW_LEDGER_RANGE_INVALID");

      var saved = !!window.saveAbonentsDB && window.saveAbonentsDB();
      if (saved) {
        __scheduleTransferFlushToServer();
        markAbonentSummaryDirtyLater(oldId, "RESPONSIBILITY_CHANGED");
        markAbonentSummaryDirtyLater(newId, "RESPONSIBILITY_CHANGED");
      }
      return saved;
    }catch(e){
      window.AbonentsDB = snapshot;
      transferKeys.forEach(function(k){
        try{
          if (transferRawSnapshot[k] === null || transferRawSnapshot[k] === undefined) _removeProjectRaw(k);
          else _setProjectRaw(k, transferRawSnapshot[k]);
        }catch(storageErr){}
      });
      try{ if (window.saveAbonentsDB) window.saveAbonentsDB(); }catch(saveErr){}
      if (__isDebtTransferError(e)) {
        __logDebtTransferAbort(e);
      } else {
        try{ console.error("[transfer-responsibility][aborted]", e); }catch(logErr){}
      }
      return false;
    }
  }


  function getFinancialTransferInfo(abonentId, regnum){
    var id = String(abonentId || "").trim();
    var rn = normalizeRegnumValue(regnum);
    var info = { incoming: null, freezeDate: "", frozenDebt: null, outgoing: [] };
    if (!id) return info;
    try {
      var incomingKey = rn ? ("jkh_transfer_balance_v1:" + id + ":" + rn) : "";
      var incomingRaw = incomingKey ? _getProjectRaw(incomingKey) : null;
      if (incomingRaw) {
        var incomingObj = JSON.parse(incomingRaw);
        if (incomingObj && typeof incomingObj === "object") {
          info.incoming = {
            startDate: String(incomingObj.startDate || "").trim(),
            principal: Number(incomingObj.principal) || 0,
            penalty: Number(incomingObj.penalty) || 0,
            fromAbonentId: String(incomingObj.fromAbonentId || "").trim(),
            regnum: String(incomingObj.regnum || rn || "").trim(),
            mode: normalizeFinancialMode(incomingObj.mode || incomingObj.transferMode || "WITH_DEBT")
          };
        }
      }
    } catch (e1) {}

    try {
      var freezeISO = String(_getProjectRaw("jkh_freeze_to_v1:" + id) || "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(freezeISO)) {
        info.freezeDate = freezeISO;
        var debtRaw = _getProjectRaw("jkh_frozen_debt_v1:" + id + ":" + freezeISO);
        if (debtRaw) {
          try { info.frozenDebt = JSON.parse(debtRaw); } catch (e2) { info.frozenDebt = null; }
        }
      }
    } catch (e3) {}

    try {
      var keys = _adminKeysForOwner(_ownerId()) || [];
      var prefix = (window.JKHStorage && typeof JKHStorage.scopePrefixFor === "function")
        ? JKHStorage.scopePrefixFor(_ownerId())
        : ("jkhdb::" + String(_ownerId()) + "::");
      keys.forEach(function(scopedKey){
        var key = String(scopedKey || "");
        if (prefix && key.indexOf(prefix) === 0) key = key.slice(prefix.length);
        if (key.indexOf("jkh_transfer_balance_v1:") !== 0) return;
        var raw = _getProjectRaw(key);
        if (!raw) return;
        var obj = null;
        try { obj = JSON.parse(raw); } catch (e4) { obj = null; }
        if (!obj || typeof obj !== "object") return;
        if (String(obj.fromAbonentId || "").trim() !== id) return;
        var parts = key.split(":");
        info.outgoing.push({
          key: key,
          toAbonentId: String(parts[1] || "").trim(),
          regnum: String(parts.slice(2).join(":") || obj.regnum || "").trim(),
          startDate: String(obj.startDate || "").trim(),
          principal: Number(obj.principal) || 0,
          penalty: Number(obj.penalty) || 0,
          mode: normalizeFinancialMode(obj.mode || obj.transferMode || "WITH_DEBT")
        });
      });
      info.outgoing.sort(function(a,b){ return String(b.startDate || "").localeCompare(String(a.startDate || "")); });
    } catch (e5) {}
    return info;
  }

  function getAbonentTransferInfo(abonentId){
    try{
      var id = String(abonentId||"").trim();
      if (!id) return null;

      // recipient?
      var trRaw = _getProjectRaw("jkh_transfer_to_v1:" + id);
      if (trRaw){
        try{
          return { type: "recipient", data: JSON.parse(trRaw) };
        }catch(e){}
      }

      // source?
      var freezeISO = String(_getProjectRaw("jkh_freeze_to_v1:" + id) || "").trim();
      if (freezeISO){
        var debtRaw = _getProjectRaw("jkh_frozen_debt_v1:" + id + ":" + freezeISO);
        var debt = null;
        try{ debt = debtRaw ? JSON.parse(debtRaw) : null; }catch(e){}
        return { type: "source", freezeDate: freezeISO, frozenDebt: debt };
      }
      return null;
    }catch(e){ return null; }
  }

  // Экспорт в Service-layer API
  Data.prepareDebtTransfer = prepareDebtTransfer;
  Data.transferResponsibility = transferResponsibility;
  Data.getAbonentTransferInfo = getAbonentTransferInfo;
  Data.getFinancialTransferInfo = getFinancialTransferInfo;

window.getCalcPeriodStorageKey = resolveCalcPeriodStorageKey;
window.getCalcPeriodActiveStorageKey = resolveCalcPeriodActiveStorageKey;
window.Data = Data;
window.JKHBoot?.markReady?.('data');

  // Read-only init: empty storage is not materialized until an explicit user save.

  // ============================================================
  // DEMO SEED: 1006 / 1008 (новая конфигурация)
  // ============================================================
  function buildDemoDb_1006_1008() {
    // Важно: regnum должен существовать, иначе normalizeDb не создаст premises/links
    const a1006_regnum = "TEMP-20260125-0187";
    const a1008_regnum = "TEMP-20260125-8014";

    const db = deepClone(BASE_DB);

    db.abonents = {
      "1006": {
        id: "1006",
        fio: "КУДИНОВА СВЕТЛАНА ВЛАДИМИРОВНА",
        fam: "КУДИНОВА",
        name: "СВЕТЛАНА",
        otch: "ВЛАДИМИРОВНА",

        regnum: a1006_regnum,
        city: "М",
        street: "М",
        house: "1",
        flat: "1",

        square: 10,
        rooms: "",
        share: "",

        // расчёт/ответственность
        calcStartDate: "2025-01-01",
        calcEndDate: "",

        // служебное (не обязательно, но удобно)
        premiseCreatedAt: ""
      },

      "1008": {
        id: "1008",
        fio: "ДУПЛЕТОВА ВАЛЕРИЯ АЛЕКСАНДРОВНА",
        fam: "ДУПЛЕТОВА",
        name: "ВАЛЕРИЯ",
        otch: "АЛЕКСАНДРОВНА",

        regnum: a1008_regnum,
        city: "М",
        street: "М",
        house: "1",
        flat: "2",

        square: 10,
        rooms: "",
        share: "",

        calcStartDate: "2025-01-01",
        calcEndDate: "",
        premiseCreatedAt: ""
      }
    };

    normalizeDb(db);
    return db;
  }

  function seedDemoKeys_1006_1008() {
    // 1) DB
    const demoDb = buildDemoDb_1006_1008();
    saveToStorage(demoDb);

    // 2) last abonent
    _setRawScoped("last_abonent_id", "1008");

    // 3) источники платежей
    _setRawScoped("payment_sources_v1", JSON.stringify(["Платёж 1", "Платёж 2", "Платёж 3"]));

    // 4) тарифы (как у тебя на скрине: content/repair)
    _setRawScoped("tariffs_" + _ownerId(), JSON.stringify([{ from: "2025-01-01", content: 10, repair: 10 }]));

    // 5) ставки рефинансирования (normal + moratorium)
    _setRawScoped("refinancing_rates_normal_v1", JSON.stringify([
      { from: "01.01.2025", rate: "11" }
    ]));
    _setRawScoped("refinancing_rates_moratorium_v1", JSON.stringify([
      { from: "01.04.2025", rate: "5" }
    ]));

    // 6) периоды расчёта (пустые, как на скрине)
    ["1006", "1008"].forEach((id) => {
      const abonent = demoDb && demoDb.abonents ? demoDb.abonents[id] : null;
      const calcKey = resolveCalcPeriodStorageKey(abonent);
      const calcActiveKey = resolveCalcPeriodActiveStorageKey(abonent);
      const uid = String(abonent && abonent.uid || "").trim();
      if (calcKey) _setRawScoped(calcKey, JSON.stringify({ from: "", to: "" }));
      if (calcActiveKey) _setRawScoped(calcActiveKey, "0");
      if (isValidUid(uid)) _setRawScoped("report_period_" + uid, JSON.stringify({ from: "", to: "" }));
    });

    // 7) платежи — намеренно как “проверочный кейс”
    const demoLedgers = {
      "1006": [
        { id: 1, year: "2025", month: "01", accrued: 200, paid: 0, paid_date: "", source: "Платёж 1", payment_period: "" },
        { id: 2, year: "2025", month: "02", accrued: 200, paid: 0, paid_date: "", source: "Платёж 1", payment_period: "" },
        { id: 3, year: "2025", month: "02", accrued: 0, paid: 3870, paid_date: "10.02.2025", source: "Платёж 1", payment_period: "" }
      ],
      "1008": [
        { id: 1, year: "2025", month: "01", accrued: 200, paid: 0, paid_date: "", source: "Платёж 1", payment_period: "" }
      ]
    };

    ["1006", "1008"].forEach((abonentId) => {
      const abonent = demoDb && demoDb.abonents ? demoDb.abonents[abonentId] : null;
      const uid = String(abonent && abonent.uid || "").trim();
      if (!isValidUid(uid)) {
        const err = new Error("DEMO_UID_REQUIRED: demo abonent " + abonentId + " must have a valid uid before seeding payments");
        err.code = "DEMO_UID_REQUIRED";
        err.abonentId = abonentId;
        err.uid = uid;
        throw err;
      }
      const key = "payments_" + uid;
      console.info("[demo][uid-ledger-seed]", { abonentId: abonentId, uid: uid, key: key });
      _setRawScoped(key, JSON.stringify(demoLedgers[abonentId]));
    });
  }

  // ============================================================
  // BUTTON ACTIONS
  // ============================================================

  // "Сброс базы" — очистка проектных ключей
  window.testResetDatabase = function () {
    if (!canWriteOrExplain()) return;
    const ok = confirm(
      "Тестовый сброс: удалить ВСЕ данные проекта в браузере и начать с нуля?\n\n" +
      "Это действие необратимо."
    );
    if (!ok) return;

    removeProjectKeys();

    // После удаления — восстановим пустую структуру DB
    window.AbonentsDB = deepClone(BASE_DB);
    normalizeDb(window.AbonentsDB);
    _resetPaymentKeyResolveCache('reset-database');
    saveToStorage(window.AbonentsDB);

    alert("Готово. База очищена.");
    location.reload();
  };

  // "Загрузить демо" — полностью заново: очистка + seed 1006/1008 + конфиги
  window.testLoadDemoDatabase = function () {
    if (!canWriteOrExplain()) return;
    const ok = confirm(
      "Загрузить ДЕМО (регрессионный стенд)?\n\n" +
      "Будут загружены ТОЛЬКО абоненты 1006 и 1008.\n" +
      "Текущая база и расчётные ключи будут полностью очищены."
    );
    if (!ok) return;

    removeProjectKeys();
    seedDemoKeys_1006_1008();

    // Подтянем DB в память (чтобы текущая вкладка видела сразу)
    const fresh = loadFromStorage();
    window.AbonentsDB = fresh ? mergePreferStored(BASE_DB, fresh) : deepClone(BASE_DB);
    normalizeDb(window.AbonentsDB);
    _resetPaymentKeyResolveCache('load-demo');

    alert("Демо загружено: абоненты 1006 и 1008.");
    location.reload();
  };

  // ============================================================
  // DEV CHECK (не мешает работе)
  // ============================================================
  // console.log("data.js loaded: ", typeof window.testLoadDemoDatabase);

})();
