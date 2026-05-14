// data.js — база абонентов (пустая по умолчанию) + ДЕМО 1006/1008 по кнопке
// Полная новая версия под "загрузить демо" (регрессионный стенд)

(function () {
  "use strict";

  // ============================================================
  // CONFIG
  // ============================================================
  const KEY_DB = "abonents_db_v1";
  const CALC_SUMMARY_ENGINE_VERSION = "calc-engine-v1.9.4";
  const CALC_SUMMARY_CANON_VERSION = "financial-canon-v1.9.4";
  const CALC_SUMMARY_FORMAT_VERSION = "calc-summary-format-v2-period-boundary";
  window.JKH_CALC_CANON_VERSION = CALC_SUMMARY_CANON_VERSION;


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
    if (uid) {
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

  function _findAbonentByIdOrUid(abonentOrId) {
    var db = window.AbonentsDB || {};
    var abonents = db && db.abonents && typeof db.abonents === "object" ? db.abonents : {};
    if (abonentOrId && typeof abonentOrId === "object") {
      var objId = String(abonentOrId.id || "").trim();
      if (objId && abonents[objId]) return { id: objId, abonent: abonents[objId] };
      var objUid = String(abonentOrId.uid || "").trim();
      if (objUid) {
        var byObjUid = Object.keys(abonents).find(function (id) { return String(abonents[id] && abonents[id].uid || "").trim() === objUid; });
        if (byObjUid) return { id: byObjUid, abonent: abonents[byObjUid] };
      }
      return objId || objUid ? { id: objId || "", abonent: abonentOrId } : null;
    }

    var raw = String(abonentOrId || "").trim();
    if (!raw) return null;
    if (abonents[raw]) return { id: raw, abonent: abonents[raw] };
    var byUid = Object.keys(abonents).find(function (id) { return String(abonents[id] && abonents[id].uid || "").trim() === raw; });
    if (byUid) return { id: byUid, abonent: abonents[byUid] };
    return { id: raw, abonent: null };
  }

  function resolveCalcPeriodStorageKey(abonentOrId, options) {
    var opts = options || {};
    var suffix = String(opts && opts.suffix || "").trim();
    var found = _findAbonentByIdOrUid(abonentOrId);
    var abonent = found && found.abonent ? found.abonent : null;
    var uid = String(abonent && abonent.uid || "").trim();
    if (!uid) return "";
    return "calc_period" + suffix + "_" + uid;
  }

  function resolveCalcPeriodActiveStorageKey(abonentOrId) {
    return resolveCalcPeriodStorageKey(abonentOrId, { suffix: "_active" });
  }

  function _resolveAbonentUid(abonentOrId) {
    var found = _findAbonentByIdOrUid(abonentOrId);
    var abonent = found && found.abonent ? found.abonent : null;
    return String(abonent && abonent.uid || "").trim();
  }

  function resolveCalcSummaryKey(abonentOrId) {
    var uid = _resolveAbonentUid(abonentOrId);
    return uid ? ("calc_summary_" + uid) : "";
  }

  function resolveCalcCheckpointKey(abonentOrId) {
    var uid = _resolveAbonentUid(abonentOrId);
    return uid ? ("calc_checkpoint_" + uid) : "";
  }

  function resolveCalcDirtyKey(abonentOrId) {
    var uid = _resolveAbonentUid(abonentOrId);
    return uid ? ("calc_dirty_" + uid) : "";
  }

  function isCalcDirty(abonentOrId) {
    var key = resolveCalcDirtyKey(abonentOrId);
    if (!key) return true;
    var raw = _getProjectRaw(key);
    if (raw === "1" || raw === "true" || raw === true) return true;
    if (raw === "0" || raw === "false" || raw === false || raw === null || raw === undefined || raw === "") return false;
    try {
      var parsed = JSON.parse(String(raw));
      return !!(parsed && parsed.dirty);
    } catch (e) {
      return false;
    }
  }

  function markCalcDirty(abonentOrId, reason) {
    var key = resolveCalcDirtyKey(abonentOrId);
    if (!key) return false;
    var payload = JSON.stringify({ dirty: true, reason: String(reason || ""), updatedAt: new Date().toISOString() });
    var ok = _setProjectRaw(key, payload);
    if (ok !== false) {
      var uid = _resolveAbonentUid(abonentOrId);
      _calcLog("[calc-summary][dirty]", { uid: uid, key: key, reason: String(reason || "") });
      if (String(reason || "") === "calc_period_changed") _calcWarn("[calc-period-boundary][mismatch]", { uid: uid, key: key, reason: "calc_period_changed" });
    }
    return ok;
  }

  function _calcSummaryState(status, abonentOrId, summary, checkpoint, reason) {
    return {
      status: status,
      summary: summary || null,
      checkpoint: checkpoint || null,
      uid: _resolveAbonentUid(abonentOrId),
      reason: String(reason || status || "")
    };
  }

  function _stableCalcStringify(value) {
    if (value === null || value === undefined) return String(value);
    if (typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(function (item) { return _stableCalcStringify(item); }).join(",") + "]";
    var keys = Object.keys(value).sort();
    return "{" + keys.map(function (key) { return JSON.stringify(key) + ":" + _stableCalcStringify(value[key]); }).join(",") + "}";
  }

  function _calcFingerprintFromRaw(key) {
    var raw = _getProjectRaw(key);
    if (raw === null || raw === undefined) raw = "";
    return { key: key, hash: _simpleCalcHash(String(raw)), length: String(raw).length };
  }

  function _calcFingerprintObject(name, value) {
    var raw = _stableCalcStringify(value === undefined ? null : value);
    return { key: name, hash: _simpleCalcHash(raw), length: raw.length };
  }

  function _readCalcSummaryJson(key, tag) {
    var raw = _getProjectRaw(key);
    if (raw === null || raw === undefined || raw === "") return { status: "missing", value: null, raw: raw };
    try {
      return { status: "ok", value: JSON.parse(String(raw)), raw: String(raw) };
    } catch (e) {
      _calcWarn(tag || "[calc-summary][invalid-summary]", { key: key, reason: "JSON_PARSE_FAILED", error: e && e.message ? e.message : String(e) });
      return { status: "invalid_json", value: null, raw: String(raw), reason: "JSON_PARSE_FAILED" };
    }
  }

  function _calcPeriodMode(period) {
    if (period && period.active) return "selected_calc_period";
    if (period && String(period.source || "") === "responsibility") return "full_active_responsibility";
    return "current_default";
  }

  function _effectiveCalcPeriodForCheckpoint(abonentOrId, summary) {
    var activeKey = resolveCalcPeriodActiveStorageKey(abonentOrId);
    var periodKey = resolveCalcPeriodStorageKey(abonentOrId);
    var activeRaw = activeKey ? _getProjectRaw(activeKey) : null;
    var periodRaw = periodKey ? _getProjectRaw(periodKey) : null;
    var active = _readActiveCalcPeriod(abonentOrId);
    var fallback = null;
    if (!active) {
      var found = _findAbonentByIdOrUid(abonentOrId);
      fallback = _defaultCalcPeriodForAbonent(found && found.id, found && found.abonent);
    }
    var effective = active || fallback || { from: "", to: "", active: false, source: "unknown" };
    var mode = _calcPeriodMode(effective);
    return {
      key: periodKey,
      activeKey: activeKey,
      value: { activeRaw: activeRaw === null || activeRaw === undefined ? "" : String(activeRaw), periodRaw: periodRaw === null || periodRaw === undefined ? "" : String(periodRaw), from: String(effective.from || ""), to: String(effective.to || ""), active: !!effective.active, source: String(effective.source || ""), periodMode: mode },
      effectiveFrom: String(effective.from || ""),
      effectiveTo: String(effective.to || ""),
      periodMode: mode,
      summaryFrom: String(summary && (summary.periodFrom || summary.from) || ""),
      summaryTo: String(summary && (summary.periodTo || summary.to) || ""),
      summaryMode: String(summary && summary.periodMode || "")
    };
  }

  function _responsibilitySnapshotForCheckpoint(abonentId, uid) {
    var db = window.AbonentsDB || {};
    var abonents = db && db.abonents && typeof db.abonents === "object" ? db.abonents : {};
    var links = Array.isArray(db && db.links) ? db.links : [];
    var premises = db && db.premises && typeof db.premises === "object" ? db.premises : {};
    var relevantLinks = links.filter(function (l) { return String(l && l.abonentId || "") === String(abonentId || ""); });
    var regnums = {};
    relevantLinks.forEach(function (l) { var r = String(l && l.regnum || "").trim(); if (r) regnums[r] = true; });
    var relevantPremises = {};
    Object.keys(regnums).sort().forEach(function (r) { relevantPremises[r] = premises[r] || null; });
    return { abonent: abonents[String(abonentId || "")] || null, uid: uid || "", links: relevantLinks, premises: relevantPremises };
  }

  function _buildCalcCheckpoint(abonentOrId, summary) {
    var found = _findAbonentByIdOrUid(abonentOrId);
    var abonentId = String(found && found.id || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || summary && summary.abonentId || "").trim();
    var abonent = found && found.abonent ? found.abonent : null;
    var uid = String(abonent && abonent.uid || summary && summary.uid || "").trim();
    if (!uid || !abonentId) return null;
    var owner = _ownerId();
    var calcPeriod = _effectiveCalcPeriodForCheckpoint(abonent || abonentId, summary);
    var ledgerKey = "payments_" + uid;
    var fingerprints = {
      ledger: _calcFingerprintFromRaw(ledgerKey),
      tariffs: _calcFingerprintObject("tariffs", { owner: owner, tariffsOwner: _getRawScoped("tariffs_" + owner, owner), tariffsV1: _getProjectRaw("tariffs_v1") }),
      refinancing: _calcFingerprintObject("refinancing", { refinancingV1: _getProjectRaw("refinancing_v1"), normal: _getProjectRaw("refinancing_rates_normal_v1"), moratorium: _getProjectRaw("refinancing_rates_moratorium_v1") }),
      excludes: _calcFingerprintFromRaw(excludePeriodsStorageKey(abonentId)),
      moratorium: _calcFingerprintFromRaw("moratorium_" + uid),
      responsibility: _calcFingerprintObject("responsibility", _responsibilitySnapshotForCheckpoint(abonentId, uid)),
      calcPeriod: _calcFingerprintObject("calc_period", calcPeriod.value)
    };
    return {
      uid: uid,
      abonentId: abonentId,
      generatedAt: new Date().toISOString(),
      calcEngineVersion: CALC_SUMMARY_ENGINE_VERSION,
      summaryFormatVersion: CALC_SUMMARY_FORMAT_VERSION,
      canonVersion: CALC_SUMMARY_CANON_VERSION,
      periodFrom: String(summary && (summary.periodFrom || summary.from) || calcPeriod.effectiveFrom || ""),
      periodTo: String(summary && (summary.periodTo || summary.to) || calcPeriod.effectiveTo || ""),
      periodMode: String(summary && summary.periodMode || calcPeriod.periodMode || ""),
      calcPeriodKey: calcPeriod.key,
      calcPeriodValue: calcPeriod.value,
      ledgerKey: ledgerKey,
      ledgerFingerprint: fingerprints.ledger,
      tariffsFingerprint: fingerprints.tariffs,
      refinancingFingerprint: fingerprints.refinancing,
      excludesFingerprint: fingerprints.excludes,
      moratoriumFingerprint: fingerprints.moratorium,
      responsibilityFingerprint: fingerprints.responsibility,
      calcPeriodFingerprint: fingerprints.calcPeriod,
      summaryFingerprint: _calcFingerprintObject("summary", summary || null),
      fingerprints: fingerprints
    };
  }

  function _validateCalcSummaryStructure(summary, uid, abonentId) {
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) return "SUMMARY_NOT_OBJECT";
    if (String(summary.uid || "").trim() !== uid) return "SUMMARY_UID_MISMATCH";
    if (String(summary.abonentId || "").trim() !== abonentId) return "SUMMARY_ABONENT_MISMATCH";
    if (!_parseCalcDateISO(summary.periodFrom || summary.from) || !_parseCalcDateISO(summary.periodTo || summary.to)) return "SUMMARY_PERIOD_INVALID";
    if (!["selected_calc_period", "full_active_responsibility", "current_default", "explicit_options"].includes(String(summary.periodMode || ""))) return "SUMMARY_PERIOD_MODE_INVALID";
    var total = summary.totalDebt !== undefined ? summary.totalDebt : (summary.total !== undefined ? summary.total : summary.total_debt);
    if (!Number.isFinite(Number(total))) return "SUMMARY_TOTAL_INVALID";
    return "";
  }

  function _validateCalcCheckpointStructure(checkpoint, uid, abonentId) {
    if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return "CHECKPOINT_NOT_OBJECT";
    if (String(checkpoint.uid || "").trim() !== uid) return "CHECKPOINT_UID_MISMATCH";
    if (String(checkpoint.abonentId || "").trim() !== abonentId) return "CHECKPOINT_ABONENT_MISMATCH";
    if (!_parseCalcDateISO(checkpoint.periodFrom) || !_parseCalcDateISO(checkpoint.periodTo)) return "CHECKPOINT_PERIOD_INVALID";
    if (!["selected_calc_period", "full_active_responsibility", "current_default", "explicit_options"].includes(String(checkpoint.periodMode || ""))) return "CHECKPOINT_PERIOD_MODE_INVALID";
    if (!checkpoint.generatedAt || !checkpoint.fingerprints || typeof checkpoint.fingerprints !== "object") return "CHECKPOINT_FINGERPRINTS_MISSING";
    if (!checkpoint.calcEngineVersion || !checkpoint.summaryFormatVersion || !checkpoint.canonVersion) return "CHECKPOINT_VERSION_MISSING";
    if (!checkpoint.ledgerFingerprint || !checkpoint.tariffsFingerprint || !checkpoint.refinancingFingerprint || !checkpoint.excludesFingerprint || !checkpoint.moratoriumFingerprint || !checkpoint.responsibilityFingerprint || !checkpoint.calcPeriodFingerprint) return "CHECKPOINT_REQUIRED_FINGERPRINT_MISSING";
    return "";
  }

  function _calcCheckpointVersionMismatch(stored) {
    if (String(stored && stored.calcEngineVersion || "") !== CALC_SUMMARY_ENGINE_VERSION) return { status: "engine_version_mismatch", reason: "Изменена версия расчёта" };
    if (String(stored && stored.canonVersion || "") !== CALC_SUMMARY_CANON_VERSION) return { status: "engine_version_mismatch", reason: "Изменена версия расчёта" };
    if (String(stored && stored.summaryFormatVersion || "") !== CALC_SUMMARY_FORMAT_VERSION) return { status: "summary_version_mismatch", reason: "Изменена версия расчёта" };
    return null;
  }

  function _calcCheckpointMismatchReason(current, stored) {
    var fields = ["ledger", "tariffs", "refinancing", "excludes", "moratorium", "responsibility", "calcPeriod"];
    for (var i = 0; i < fields.length; i++) {
      var name = fields[i];
      var a = current && current.fingerprints && current.fingerprints[name];
      var b = stored && stored.fingerprints && stored.fingerprints[name];
      if (_stableCalcStringify(a) !== _stableCalcStringify(b)) return String(name).toUpperCase() + "_FINGERPRINT_MISMATCH";
    }
    if (_stableCalcStringify(current && current.summaryFingerprint) !== _stableCalcStringify(stored && stored.summaryFingerprint)) return "SUMMARY_FINGERPRINT_MISMATCH";
    if (String(current.periodFrom || "") !== String(stored.periodFrom || "") || String(current.periodTo || "") !== String(stored.periodTo || "") || String(current.periodMode || "") !== String(stored.periodMode || "")) return "PERIOD_MISMATCH";
    return "";
  }

  function readCalcSummary(abonentOrId) {
    var summaryKey = resolveCalcSummaryKey(abonentOrId);
    var checkpointKey = resolveCalcCheckpointKey(abonentOrId);
    var uid = _resolveAbonentUid(abonentOrId);
    var found = _findAbonentByIdOrUid(abonentOrId);
    var abonentId = String(found && found.id || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
    _calcLog("[calc-summary][integrity-check]", { uid: uid, abonentId: abonentId, summaryKey: summaryKey, checkpointKey: checkpointKey });
    if (!summaryKey || !checkpointKey || !uid || !abonentId) return _calcSummaryState("missing", abonentOrId, null, null, "UID_REQUIRED");

    var summaryRead = _readCalcSummaryJson(summaryKey, "[calc-summary][invalid-summary]");
    if (summaryRead.status === "missing") return _calcSummaryState("missing", abonentOrId, null, null, "SUMMARY_MISSING");
    if (summaryRead.status === "invalid_json") return _calcSummaryState("invalid_json", abonentOrId, null, null, "SUMMARY_JSON_INVALID");

    var checkpointRead = _readCalcSummaryJson(checkpointKey, "[calc-summary][invalid-checkpoint]");
    if (checkpointRead.status === "missing") {
      _calcWarn("[calc-summary][invalid-checkpoint]", { uid: uid, abonentId: abonentId, key: checkpointKey, reason: "CHECKPOINT_MISSING" });
      return _calcSummaryState("invalid_structure", abonentOrId, summaryRead.value, null, "CHECKPOINT_MISSING");
    }
    if (checkpointRead.status === "invalid_json") return _calcSummaryState("invalid_json", abonentOrId, summaryRead.value, null, "CHECKPOINT_JSON_INVALID");

    var versionMismatch = _calcCheckpointVersionMismatch(checkpointRead.value);
    if (versionMismatch) {
      _calcWarn("[calc-summary][version-mismatch]", { uid: uid, abonentId: abonentId, key: checkpointKey, status: versionMismatch.status, reason: versionMismatch.reason });
      return _calcSummaryState(versionMismatch.status, abonentOrId, summaryRead.value, checkpointRead.value, versionMismatch.reason);
    }

    var summaryReason = _validateCalcSummaryStructure(summaryRead.value, uid, abonentId);
    if (summaryReason) {
      _calcWarn("[calc-summary][invalid-summary]", { uid: uid, abonentId: abonentId, key: summaryKey, reason: summaryReason });
      return _calcSummaryState("invalid_structure", abonentOrId, summaryRead.value, checkpointRead.value, summaryReason);
    }
    var checkpointReason = _validateCalcCheckpointStructure(checkpointRead.value, uid, abonentId);
    if (checkpointReason) {
      _calcWarn("[calc-summary][invalid-checkpoint]", { uid: uid, abonentId: abonentId, key: checkpointKey, reason: checkpointReason });
      return _calcSummaryState("invalid_structure", abonentOrId, summaryRead.value, checkpointRead.value, checkpointReason);
    }

    if (isCalcDirty(abonentOrId)) {
      _calcLog("[calc-summary][dirty]", { uid: uid, abonentId: abonentId, reason: "DIRTY_FLAG" });
      return _calcSummaryState("dirty", abonentOrId, summaryRead.value, checkpointRead.value, "DIRTY_FLAG");
    }

    var currentCheckpoint = _buildCalcCheckpoint(abonentOrId, summaryRead.value);
    var mismatchReason = _calcCheckpointMismatchReason(currentCheckpoint, checkpointRead.value);
    if (mismatchReason) {
      _calcWarn("[calc-summary][checkpoint-mismatch]", { uid: uid, abonentId: abonentId, reason: mismatchReason });
      if (mismatchReason === "CALCPERIOD_FINGERPRINT_MISMATCH" || mismatchReason === "PERIOD_MISMATCH") {
        _calcWarn("[calc-period-boundary][mismatch]", { uid: uid, abonentId: abonentId, reason: mismatchReason, currentPeriodFrom: currentCheckpoint && currentCheckpoint.periodFrom, currentPeriodTo: currentCheckpoint && currentCheckpoint.periodTo, currentPeriodMode: currentCheckpoint && currentCheckpoint.periodMode, storedPeriodFrom: checkpointRead.value && checkpointRead.value.periodFrom, storedPeriodTo: checkpointRead.value && checkpointRead.value.periodTo, storedPeriodMode: checkpointRead.value && checkpointRead.value.periodMode });
      }
      return _calcSummaryState("checkpoint_mismatch", abonentOrId, summaryRead.value, checkpointRead.value, mismatchReason);
    }

    _calcLog("[calc-summary][fresh]", { uid: uid, abonentId: abonentId });
    return _calcSummaryState("fresh", abonentOrId, summaryRead.value, checkpointRead.value, "OK");
  }


  function _calcDebugFingerprintPair(currentCheckpoint, storedCheckpoint, fieldName, storedPropName) {
    var currentFp = currentCheckpoint && currentCheckpoint.fingerprints ? currentCheckpoint.fingerprints[fieldName] : null;
    var storedFp = storedCheckpoint && storedCheckpoint.fingerprints ? storedCheckpoint.fingerprints[fieldName] : null;
    if (!storedFp && storedCheckpoint && storedPropName) storedFp = storedCheckpoint[storedPropName] || null;
    return { current: currentFp || null, checkpoint: storedFp || null };
  }

  function _calcDebugFingerprintMismatch(currentCheckpoint, storedCheckpoint, fieldName, storedPropName) {
    var pair = _calcDebugFingerprintPair(currentCheckpoint, storedCheckpoint, fieldName, storedPropName);
    if (!pair.current && !pair.checkpoint) return false;
    return _stableCalcStringify(pair.current) !== _stableCalcStringify(pair.checkpoint);
  }

  function getCalcSummaryDebugInfo(abonentOrId) {
    var summaryKey = resolveCalcSummaryKey(abonentOrId);
    var checkpointKey = resolveCalcCheckpointKey(abonentOrId);
    var uid = _resolveAbonentUid(abonentOrId);
    var found = _findAbonentByIdOrUid(abonentOrId);
    var abonentId = String(found && found.id || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
    var summaryRead = summaryKey ? _readCalcSummaryJson(summaryKey, "[calc-summary-debug][invalid-summary]") : { status: "missing", value: null, raw: null };
    var checkpointRead = checkpointKey ? _readCalcSummaryJson(checkpointKey, "[calc-summary-debug][invalid-checkpoint]") : { status: "missing", value: null, raw: null };
    var summaryExists = !!(summaryRead.raw !== null && summaryRead.raw !== undefined && summaryRead.raw !== "");
    var checkpointExists = !!(checkpointRead.raw !== null && checkpointRead.raw !== undefined && checkpointRead.raw !== "");
    var summaryState = readCalcSummary(abonentOrId);
    var summary = summaryRead.value && typeof summaryRead.value === "object" ? summaryRead.value : (summaryState && summaryState.summary ? summaryState.summary : null);
    var checkpoint = checkpointRead.value && typeof checkpointRead.value === "object" ? checkpointRead.value : (summaryState && summaryState.checkpoint ? summaryState.checkpoint : null);
    var currentCheckpoint = null;
    try {
      if (summary && uid && abonentId) currentCheckpoint = _buildCalcCheckpoint(abonentOrId, summary);
    } catch (e) {
      currentCheckpoint = null;
    }

    var calcDirty = isCalcDirty(abonentOrId);
    var periodFrom = String(summary && (summary.periodFrom || summary.from) || checkpoint && checkpoint.periodFrom || currentCheckpoint && currentCheckpoint.periodFrom || "");
    var periodTo = String(summary && (summary.periodTo || summary.to) || checkpoint && checkpoint.periodTo || currentCheckpoint && currentCheckpoint.periodTo || "");
    var periodMode = String(summary && summary.periodMode || checkpoint && checkpoint.periodMode || currentCheckpoint && currentCheckpoint.periodMode || "");
    var storedEngineVersion = String(checkpoint && checkpoint.calcEngineVersion || "");
    var storedCanonVersion = String(checkpoint && checkpoint.canonVersion || "");
    var storedSummaryVersion = String(checkpoint && checkpoint.summaryFormatVersion || "");

    var flags = {
      ledger: _calcDebugFingerprintMismatch(currentCheckpoint, checkpoint, "ledger", "ledgerFingerprint"),
      tariffs: _calcDebugFingerprintMismatch(currentCheckpoint, checkpoint, "tariffs", "tariffsFingerprint"),
      refinancing: _calcDebugFingerprintMismatch(currentCheckpoint, checkpoint, "refinancing", "refinancingFingerprint"),
      excludes: _calcDebugFingerprintMismatch(currentCheckpoint, checkpoint, "excludes", "excludesFingerprint"),
      moratorium: _calcDebugFingerprintMismatch(currentCheckpoint, checkpoint, "moratorium", "moratoriumFingerprint"),
      responsibility: _calcDebugFingerprintMismatch(currentCheckpoint, checkpoint, "responsibility", "responsibilityFingerprint"),
      engineVersion: !!(checkpoint && (storedEngineVersion !== CALC_SUMMARY_ENGINE_VERSION || storedCanonVersion !== CALC_SUMMARY_CANON_VERSION)),
      summaryVersion: !!(checkpoint && storedSummaryVersion !== CALC_SUMMARY_FORMAT_VERSION),
      period: !!(checkpoint && currentCheckpoint && (String(currentCheckpoint.periodFrom || "") !== String(checkpoint.periodFrom || "") || String(currentCheckpoint.periodTo || "") !== String(checkpoint.periodTo || "") || String(currentCheckpoint.periodMode || "") !== String(checkpoint.periodMode || "") || _calcDebugFingerprintMismatch(currentCheckpoint, checkpoint, "calcPeriod", "calcPeriodFingerprint")))
    };

    return {
      uid: uid,
      summaryStatus: summaryState && summaryState.status ? summaryState.status : (summaryExists ? "invalid_json" : "missing"),
      summaryReason: summaryState && summaryState.reason ? summaryState.reason : (summaryExists ? "SUMMARY_UNREADABLE" : "SUMMARY_MISSING"),
      calcDirty: calcDirty,
      summaryExists: summaryExists,
      checkpointExists: checkpointExists,

      periodFrom: periodFrom,
      periodTo: periodTo,
      periodMode: periodMode,

      calcEngineVersion: storedEngineVersion || CALC_SUMMARY_ENGINE_VERSION,
      canonVersion: storedCanonVersion || CALC_SUMMARY_CANON_VERSION,
      summaryFormatVersion: storedSummaryVersion || CALC_SUMMARY_FORMAT_VERSION,

      generatedAt: String(checkpoint && checkpoint.generatedAt || summary && (summary.generatedAt || summary.calculatedAt || summary.updatedAt) || ""),

      fingerprints: {
        ledger: _calcDebugFingerprintPair(currentCheckpoint, checkpoint, "ledger", "ledgerFingerprint"),
        tariffs: _calcDebugFingerprintPair(currentCheckpoint, checkpoint, "tariffs", "tariffsFingerprint"),
        refinancing: _calcDebugFingerprintPair(currentCheckpoint, checkpoint, "refinancing", "refinancingFingerprint"),
        excludes: _calcDebugFingerprintPair(currentCheckpoint, checkpoint, "excludes", "excludesFingerprint"),
        moratorium: _calcDebugFingerprintPair(currentCheckpoint, checkpoint, "moratorium", "moratoriumFingerprint"),
        responsibility: _calcDebugFingerprintPair(currentCheckpoint, checkpoint, "responsibility", "responsibilityFingerprint")
      },

      mismatchFlags: flags
    };
  }

  function writeCalcSummary(abonentOrId, summary) {
    if (!Data.ensureWriteOrExplain()) return false;
    var summaryKey = resolveCalcSummaryKey(abonentOrId);
    var checkpointKey = resolveCalcCheckpointKey(abonentOrId);
    var dirtyKey = resolveCalcDirtyKey(abonentOrId);
    var found = _findAbonentByIdOrUid(abonentOrId);
    var abonentId = String(found && found.id || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || summary && summary.abonentId || "").trim();
    var uid = _resolveAbonentUid(abonentOrId) || String(summary && summary.uid || "").trim();
    if (!summaryKey || !checkpointKey || !dirtyKey || !uid || !abonentId) return false;
    var payload = Object.assign({}, (summary && typeof summary === "object" && !Array.isArray(summary)) ? summary : {}, { uid: uid, abonentId: abonentId, updatedAt: new Date().toISOString() });
    var summaryReason = _validateCalcSummaryStructure(payload, uid, abonentId);
    if (summaryReason) {
      _calcWarn("[calc-summary][invalid-summary]", { uid: uid, abonentId: abonentId, key: summaryKey, reason: summaryReason });
      return false;
    }
    var checkpoint = _buildCalcCheckpoint(abonentOrId, payload);
    var checkpointReason = _validateCalcCheckpointStructure(checkpoint, uid, abonentId);
    if (checkpointReason) {
      _calcWarn("[calc-summary][invalid-checkpoint]", { uid: uid, abonentId: abonentId, key: checkpointKey, reason: checkpointReason });
      return false;
    }
    _calcLog("[calc-summary][write]", { uid: uid, abonentId: abonentId, summaryKey: summaryKey, checkpointKey: checkpointKey });
    _calcLog("[calc-summary][checkpoint]", { uid: uid, abonentId: abonentId, checkpoint: checkpoint });
    var checkpointOk = _setProjectRaw(checkpointKey, JSON.stringify(checkpoint));
    if (checkpointOk === false) return false;
    var summaryOk = _setProjectRaw(summaryKey, JSON.stringify(payload));
    if (summaryOk === false) return false;
    _setProjectRaw(dirtyKey, "0");
    return summaryOk;
  }




  function _calcLog(tag, payload) {
    try { console.log(tag, payload || {}); } catch (e) { }
  }

  function _calcWarn(tag, payload) {
    try { console.warn(tag, payload || {}); } catch (e) { }
  }

  function _parseCalcDateISO(value) {
    var raw = String(value || "").trim();
    if (!raw) return null;
    var m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
      if (d && d.getFullYear() === Number(m[1]) && (d.getMonth() + 1) === Number(m[2]) && d.getDate() === Number(m[3])) return d;
      return null;
    }
    var m2 = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m2) {
      var d2 = new Date(Number(m2[3]), Number(m2[2]) - 1, Number(m2[1]), 12, 0, 0, 0);
      if (d2 && d2.getFullYear() === Number(m2[3]) && (d2.getMonth() + 1) === Number(m2[2]) && d2.getDate() === Number(m2[1])) return d2;
    }
    return null;
  }

  function _toCalcDateISO(date) {
    if (!date || !date.getFullYear) return "";
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, "0");
    var d = String(date.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }


  function _rowCalcYm(row) {
    var y = Number(row && row.year) || 0;
    var m = Number(row && row.month) || 0;
    if (y && m >= 1 && m <= 12) return String(y).padStart(4, "0") + "-" + String(m).padStart(2, "0");
    var d = _parseCalcDateISO(row && row.paid_date);
    return d ? (String(d.getFullYear()).padStart(4, "0") + "-" + String(d.getMonth() + 1).padStart(2, "0")) : "";
  }

  function _filterCalcRowsByPeriod(rows, periodFrom, periodTo) {
    var fromD = _parseCalcDateISO(periodFrom);
    var toD = _parseCalcDateISO(periodTo);
    if (!fromD || !toD) return _cloneLedgerRows(rows);
    var fromYm = String(fromD.getFullYear()).padStart(4, "0") + "-" + String(fromD.getMonth() + 1).padStart(2, "0");
    var toYm = String(toD.getFullYear()).padStart(4, "0") + "-" + String(toD.getMonth() + 1).padStart(2, "0");
    return _cloneLedgerRows(rows).filter(function (row) {
      var ym = _rowCalcYm(row);
      if (ym && (ym < fromYm || ym > toYm)) return false;
      var paid = Number(String(row && row.paid || "0").replace(/\s+/g, "").replace(",", ".")) || 0;
      var paidD = _parseCalcDateISO(row && row.paid_date);
      if (paid > 0.0000001 && paidD) {
        if (paidD.getTime() < fromD.getTime()) return false;
        if (paidD.getTime() > toD.getTime()) return false;
      }
      return true;
    });
  }

  function _readActiveCalcPeriod(abonentOrId) {
    var periodKey = resolveCalcPeriodStorageKey(abonentOrId);
    var activeKey = resolveCalcPeriodActiveStorageKey(abonentOrId);
    if (!periodKey || !activeKey) return null;
    var activeRaw = _getProjectRaw(activeKey);
    if (String(activeRaw || "") !== "1") return null;
    var raw = _getProjectRaw(periodKey);
    if (!raw) return null;
    try {
      var p = JSON.parse(String(raw));
      var from = String(p && p.from || "").trim();
      var to = String(p && p.to || "").trim();
      if (!_parseCalcDateISO(from) || !_parseCalcDateISO(to)) return null;
      return { from: from, to: to, active: true };
    } catch (e) {
      return null;
    }
  }

  function _defaultCalcPeriodForAbonent(abonentId, abonent) {
    try {
      if (window.JKHCalcEngine && typeof window.JKHCalcEngine.getActiveResponsibilityRangeISO === "function") {
        var range = window.JKHCalcEngine.getActiveResponsibilityRangeISO(String(abonentId || ""));
        if (range && range.from) {
          var from = String(range.from || "").trim();
          var to = String(range.to || "").trim() || _toCalcDateISO(new Date());
          if (_parseCalcDateISO(from) && _parseCalcDateISO(to)) return { from: from, to: to, active: false, source: "responsibility" };
        }
      }
    } catch (e) { }

    var fallbackFrom = String(abonent && (abonent.dateFrom || abonent.date_from || abonent.calcFrom || abonent.startDate) || "").trim();
    if (!_parseCalcDateISO(fallbackFrom)) fallbackFrom = _toCalcDateISO(new Date());
    return { from: fallbackFrom, to: _toCalcDateISO(new Date()), active: false, source: "safe-current" };
  }

  function _simpleCalcHash(raw) {
    var s = String(raw || "");
    var h = 0;
    for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return String(h >>> 0);
  }

  function _sumCalcRows(rows, field) {
    return (Array.isArray(rows) ? rows : []).reduce(function (sum, row) {
      var n = Number(String(row && row[field] || "0").replace(/\s+/g, "").replace(",", "."));
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
  }

  function _calcMoneyNumber(value) {
    var n = Number(String(value === null || value === undefined ? "0" : value).replace(/\s+/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }

  function _calcPeriodMonths(periodFrom, periodTo) {
    var fromD = _parseCalcDateISO(periodFrom);
    var toD = _parseCalcDateISO(periodTo);
    if (!fromD || !toD) return [];
    var y = fromD.getFullYear();
    var m = fromD.getMonth() + 1;
    var endY = toD.getFullYear();
    var endM = toD.getMonth() + 1;
    var months = [];
    while (y < endY || (y === endY && m <= endM)) {
      months.push(String(y).padStart(4, "0") + "-" + String(m).padStart(2, "0"));
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return months;
  }

  function _checkPeriodAccrualReadiness(rows, periodFrom, periodTo, context) {
    var ctx = context || {};
    var list = Array.isArray(rows) ? rows : [];
    var months = _calcPeriodMonths(periodFrom, periodTo);
    var byMonth = {};
    list.forEach(function (row) {
      var ym = _rowCalcYm(row);
      if (!ym) return;
      if (!byMonth[ym]) byMonth[ym] = { rows: 0, accrued: 0 };
      byMonth[ym].rows += 1;
      byMonth[ym].accrued += _calcMoneyNumber(row && row.accrued);
    });

    var missing = months.filter(function (ym) {
      var info = byMonth[ym];
      if (!info || info.rows <= 0) return true;
      return !(info.accrued > 0.0000001);
    });

    var payload = {
      abonentId: String(ctx.abonentId || ""),
      uid: String(ctx.uid || ""),
      ledgerKey: String(ctx.ledgerKey || ""),
      periodFrom: String(periodFrom || ""),
      periodTo: String(periodTo || ""),
      periodMode: String(ctx.periodMode || ""),
      months: months,
      rowsInPeriod: list.length
    };
    _calcLog("[period-accrual-readiness][check]", payload);

    if (missing.length) {
      var missingPayload = Object.assign({}, payload, { missingMonths: missing });
      _calcWarn("[period-accrual-readiness][missing]", missingPayload);
      return { ok: false, reason: "period_accruals_missing", missingMonths: missing, months: months };
    }

    _calcLog("[period-accrual-readiness][ok]", payload);
    return { ok: true, reason: "OK", missingMonths: [], months: months };
  }

  function recalculateCalcSummary(abonentOrId, options) {
    var opts = options || {};
    var found = _findAbonentByIdOrUid(abonentOrId);
    var abonentId = String(found && found.id || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
    var abonent = found && found.abonent ? found.abonent : null;
    var uid = String(abonent && abonent.uid || "").trim();
    var startedAt = new Date().toISOString();
    _calcLog("[calc-summary][recalc] start", { abonentId: abonentId, uid: uid });

    try {
      if (!Data.ensureWriteOrExplain()) return { ok: false, uid: uid, abonentId: abonentId, periodFrom: "", periodTo: "", summary: null, reason: "WRITE_BLOCKED" };
      if (!abonent || !abonentId || !uid) throw new Error("ABONENT_UID_REQUIRED");

      var ledgerKey = "payments_" + uid;
      var raw = _getProjectRaw(ledgerKey);
      var rows = raw === null || raw === undefined || raw === "" ? [] : _parseLedgerRows(raw, ledgerKey);
      var period = _readActiveCalcPeriod(abonentId) || _defaultCalcPeriodForAbonent(abonentId, abonent);
      var periodMode = _calcPeriodMode(period);
      var periodFrom = String((period.active ? period.from : (opts.periodFrom || period.from)) || "").trim();
      var periodTo = String((period.active ? period.to : (opts.periodTo || period.to)) || "").trim();
      if (!period.active && (opts.periodFrom || opts.periodTo)) periodMode = "explicit_options";
      if (!_parseCalcDateISO(periodFrom) || !_parseCalcDateISO(periodTo)) throw new Error("CALC_PERIOD_INVALID");
      _calcLog("[calc-summary][recalc] period", { abonentId: abonentId, uid: uid, periodFrom: periodFrom, periodTo: periodTo, periodMode: periodMode, selected: !!period.active });
      _calcLog("[calc-period-boundary][resolve]", { abonentId: abonentId, uid: uid, periodFrom: periodFrom, periodTo: periodTo, periodMode: periodMode, selected: !!period.active, source: String(period.source || "") });

      var autoaccrualResult = { ok: true, changed: false, reason: "SKIPPED" };
      if (!period.active && window.JKHAutoAccrual && typeof window.JKHAutoAccrual.recalcForAbonent === "function") {
        autoaccrualResult = window.JKHAutoAccrual.recalcForAbonent(abonentId, { explicit: true, periodFrom: periodFrom, periodTo: periodTo });
        raw = _getProjectRaw(ledgerKey);
        rows = raw === null || raw === undefined || raw === "" ? [] : _parseLedgerRows(raw, ledgerKey);
      } else if (period.active) {
        autoaccrualResult = { ok: true, changed: false, reason: "SELECTED_PERIOD_NO_UNSCOPED_AUTOACCRUAL" };
      }
      _calcLog("[calc-summary][recalc] autoaccrual", { abonentId: abonentId, uid: uid, result: autoaccrualResult });
      if (autoaccrualResult && autoaccrualResult.ok === false) throw new Error(autoaccrualResult.reason || "AUTOACCRUAL_FAILED");

      if (!window.JKHCalcEngine || typeof window.JKHCalcEngine.calcTotalsAsOfAdjusted !== "function") throw new Error("CALC_ENGINE_NOT_AVAILABLE");
      var periodRows = _filterCalcRowsByPeriod(rows, periodFrom, periodTo);
      var readinessRequired = !!period.active || !!opts.periodFrom || !!opts.periodTo;
      if (readinessRequired) {
        var readiness = _checkPeriodAccrualReadiness(periodRows, periodFrom, periodTo, { abonentId: abonentId, uid: uid, ledgerKey: ledgerKey, periodMode: periodMode });
        if (!readiness.ok) return { ok: false, uid: uid, abonentId: abonentId, periodFrom: periodFrom, periodTo: periodTo, summary: null, reason: readiness.reason, missingMonths: readiness.missingMonths };
      }
      var asOf = _parseCalcDateISO(periodTo);
      var totals = window.JKHCalcEngine.calcTotalsAsOfAdjusted(periodRows, asOf, { abonentId: abonentId, applyAdvanceOffset: true, allowNegativePrincipal: true });
      if (!totals || !Number.isFinite(Number(totals.principal)) || !Number.isFinite(Number(totals.penaltyDebt)) || !Number.isFinite(Number(totals.total))) {
        throw new Error("CALC_TOTALS_INVALID");
      }

      var summary = {
        uid: uid,
        abonentId: abonentId,
        calculatedAt: new Date().toISOString(),
        periodFrom: periodFrom,
        periodTo: periodTo,
        periodMode: periodMode,
        from: periodFrom,
        to: periodTo,
        selectedPeriod: !!period.active,
        ledgerKey: ledgerKey,
        rowsTotal: rows.length,
        rowsInPeriod: periodRows.length,
        accrued: Math.round(_sumCalcRows(periodRows, "accrued") * 100) / 100,
        accruedTotal: Math.round(_sumCalcRows(periodRows, "accrued") * 100) / 100,
        nachisleno: Math.round(_sumCalcRows(periodRows, "accrued") * 100) / 100,
        paid: Math.round(_sumCalcRows(periodRows, "paid") * 100) / 100,
        paidTotal: Math.round(_sumCalcRows(periodRows, "paid") * 100) / 100,
        oplacheno: Math.round(_sumCalcRows(periodRows, "paid") * 100) / 100,
        principal: Math.round(Number(totals.principal) * 100) / 100,
        mainDebt: Math.round(Number(totals.principal) * 100) / 100,
        main_debt: Math.round(Number(totals.principal) * 100) / 100,
        penalty: Math.round(Number(totals.penaltyDebt) * 100) / 100,
        penaltyDebt: Math.round(Number(totals.penaltyDebt) * 100) / 100,
        penalty_debt: Math.round(Number(totals.penaltyDebt) * 100) / 100,
        totalDebt: Math.round(Number(totals.total) * 100) / 100,
        total_debt: Math.round(Number(totals.total) * 100) / 100,
        total: Math.round(Number(totals.total) * 100) / 100,
        startDate: periodFrom,
        endDate: periodTo,
        totals: totals
      };

      _calcLog("[calc-period-boundary][summary-period]", { abonentId: abonentId, uid: uid, periodFrom: summary.periodFrom, periodTo: summary.periodTo, periodMode: summary.periodMode, rowsTotal: summary.rowsTotal, rowsInPeriod: summary.rowsInPeriod });
      var summaryOk = writeCalcSummary(abonentId, summary);
      if (summaryOk === false) throw new Error("SUMMARY_WRITE_FAILED");
      _calcLog("[calc-summary][recalc] summary-written", { abonentId: abonentId, uid: uid, key: resolveCalcSummaryKey(abonentId), checkpointKey: resolveCalcCheckpointKey(abonent) });
      _calcLog("[calc-summary][recalc] dirty-cleared", { abonentId: abonentId, uid: uid, key: resolveCalcDirtyKey(abonentId) });

      return { ok: true, uid: uid, abonentId: abonentId, periodFrom: periodFrom, periodTo: periodTo, summary: summary, reason: "OK" };
    } catch (e) {
      var reason = e && e.message ? e.message : String(e);
      _calcWarn("[calc-summary][recalc] failed", { abonentId: abonentId, uid: uid, reason: reason });
      return { ok: false, uid: uid, abonentId: abonentId, periodFrom: "", periodTo: "", summary: null, reason: reason };
    }
  }

  function preparePeriodAccruals(abonentOrId, options) {
    var opts = options || {};
    var found = _findAbonentByIdOrUid(abonentOrId);
    var abonentId = String(found && found.id || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
    var abonent = found && found.abonent ? found.abonent : null;
    var uid = String(abonent && abonent.uid || "").trim();
    _calcLog("[period-accrual-prepare][start]", { abonentId: abonentId, uid: uid, source: String(opts.source || "") });

    try {
      if (!Data.ensureWriteOrExplain()) return { ok: false, uid: uid, abonentId: abonentId, periodFrom: "", periodTo: "", reason: "WRITE_BLOCKED" };
      if (!abonent || !abonentId || !uid) throw new Error("ABONENT_UID_REQUIRED");

      var ledgerKey = "payments_" + uid;
      var resolvedLedgerKey = resolvePaymentLedgerKey(abonentId);
      if (resolvedLedgerKey !== ledgerKey) throw new Error("UID_LEDGER_REQUIRED");

      var raw = _getProjectRaw(ledgerKey);
      var rowsBefore = raw === null || raw === undefined || raw === "" ? [] : _parseLedgerRows(raw, ledgerKey);
      var period = _readActiveCalcPeriod(abonentId);
      if (!period || !period.active) throw new Error("ACTIVE_CALC_PERIOD_REQUIRED");

      var periodFrom = String(period.from || "").trim();
      var periodTo = String(period.to || "").trim();
      if (!_parseCalcDateISO(periodFrom) || !_parseCalcDateISO(periodTo)) throw new Error("CALC_PERIOD_INVALID");
      _calcLog("[period-accrual-prepare][period]", { abonentId: abonentId, uid: uid, ledgerKey: ledgerKey, periodFrom: periodFrom, periodTo: periodTo, months: _calcPeriodMonths(periodFrom, periodTo) });

      if (!window.JKHAutoAccrual || typeof window.JKHAutoAccrual.recalcForAbonent !== "function") throw new Error("AUTOACCRUAL_NOT_AVAILABLE");
      var result = window.JKHAutoAccrual.recalcForAbonent(abonentId, {
        explicit: true,
        periodFrom: periodFrom,
        periodTo: periodTo,
        keepExistingOutside: true,
        source: "period_accrual_prepare"
      });
      if (result && result.ok === false) throw new Error(result.reason || "AUTOACCRUAL_FAILED");

      var afterRaw = _getProjectRaw(ledgerKey);
      var rowsAfter = afterRaw === null || afterRaw === undefined || afterRaw === "" ? [] : _parseLedgerRows(afterRaw, ledgerKey);
      var periodRows = _filterCalcRowsByPeriod(rowsAfter, periodFrom, periodTo);
      _calcLog("[period-accrual-prepare][written]", { abonentId: abonentId, uid: uid, ledgerKey: ledgerKey, changed: !!(result && result.changed), rowsBefore: rowsBefore.length, rowsAfter: rowsAfter.length, rowsInPeriod: periodRows.length, result: result || null });

      var dirtyOk = markCalcDirty(abonentId, "period_accrual_prepare");
      _calcLog("[period-accrual-prepare][dirty]", { abonentId: abonentId, uid: uid, key: resolveCalcDirtyKey(abonentId), ok: dirtyOk !== false });

      return { ok: true, uid: uid, abonentId: abonentId, ledgerKey: ledgerKey, periodFrom: periodFrom, periodTo: periodTo, rowsBefore: rowsBefore.length, rowsAfter: rowsAfter.length, rowsInPeriod: periodRows.length, changed: !!(result && result.changed), reason: "OK" };
    } catch (e) {
      var reason = e && e.message ? e.message : String(e);
      _calcWarn("[period-accrual-prepare][failed]", { abonentId: abonentId, uid: uid, reason: reason });
      return { ok: false, uid: uid, abonentId: abonentId, periodFrom: "", periodTo: "", reason: reason };
    }
  }




  function prepareAndRecalculateCalcSummary(abonentOrId, options) {
    var opts = options || {};
    var found = _findAbonentByIdOrUid(abonentOrId);
    var abonentId = String(found && found.id || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
    var abonent = found && found.abonent ? found.abonent : null;
    var uid = String(abonent && abonent.uid || "").trim();
    var startedAt = new Date().toISOString();
    _calcLog("[prepare-and-recalc][start]", { abonentId: abonentId, uid: uid, source: String(opts.source || ""), startedAt: startedAt });

    var prepared = null;
    var summary = null;
    try {
      if (!Data.ensureWriteOrExplain()) {
        _calcWarn("[prepare-and-recalc][failed]", { abonentId: abonentId, uid: uid, reason: "WRITE_BLOCKED" });
        return { ok: false, uid: uid, abonentId: abonentId, periodFrom: "", periodTo: "", prepared: null, recalculated: null, summary: null, reason: "WRITE_BLOCKED" };
      }
      if (!abonent || !abonentId || !uid) throw new Error("ABONENT_UID_REQUIRED");

      var period = _readActiveCalcPeriod(abonentId);
      if (!period || !period.active) throw new Error("ACTIVE_CALC_PERIOD_REQUIRED");

      prepared = preparePeriodAccruals(abonentId, Object.assign({}, opts, { source: String(opts.source || "prepare_and_recalc") }));
      _calcLog("[prepare-and-recalc][prepared]", { abonentId: abonentId, uid: uid, result: prepared });
      if (!prepared || prepared.ok !== true) {
        var prepareReason = prepared && prepared.reason ? prepared.reason : "PERIOD_ACCRUAL_PREPARE_FAILED";
        _calcWarn("[prepare-and-recalc][failed]", { abonentId: abonentId, uid: uid, reason: prepareReason, step: "prepare" });
        return { ok: false, uid: uid, abonentId: abonentId, periodFrom: period.from, periodTo: period.to, prepared: prepared, recalculated: null, summary: null, reason: prepareReason };
      }

      summary = recalculateCalcSummary(abonentId, Object.assign({}, opts, { source: String(opts.source || "prepare_and_recalc") }));
      _calcLog("[prepare-and-recalc][summary]", { abonentId: abonentId, uid: uid, result: summary });
      if (!summary || summary.ok !== true) {
        var summaryReason = summary && summary.reason ? summary.reason : "CALC_RECALC_FAILED";
        _calcWarn("[prepare-and-recalc][failed]", { abonentId: abonentId, uid: uid, reason: summaryReason, step: "summary" });
        return { ok: false, uid: uid, abonentId: abonentId, periodFrom: prepared.periodFrom || period.from, periodTo: prepared.periodTo || period.to, prepared: prepared, recalculated: summary || null, summary: summary || null, reason: summaryReason };
      }

      return { ok: true, uid: uid, abonentId: abonentId, periodFrom: summary.periodFrom || prepared.periodFrom || period.from, periodTo: summary.periodTo || prepared.periodTo || period.to, prepared: prepared, recalculated: summary, summary: summary, reason: "OK" };
    } catch (e) {
      var reason = e && e.message ? e.message : String(e);
      _calcWarn("[prepare-and-recalc][failed]", { abonentId: abonentId, uid: uid, reason: reason });
      return { ok: false, uid: uid, abonentId: abonentId, periodFrom: "", periodTo: "", prepared: prepared, recalculated: summary, summary: summary, reason: reason };
    }
  }



  function _hasCalcAccrualRows(rows) {
    return (Array.isArray(rows) ? rows : []).some(function (row) {
      var accrued = Number(String(row && row.accrued || "0").replace(/\s+/g, "").replace(",", "."));
      return Number.isFinite(accrued) && Math.abs(accrued) > 0.0000001;
    });
  }

  function _roundCalcMoney(value) {
    var n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }

  function _endOfCalcMonthDate(year, month) {
    var y = Number(year) || 0;
    var m = Number(month) || 0;
    if (!y || m < 1 || m > 12) return null;
    return new Date(y, m, 0, 12, 0, 0, 0);
  }

  function _asOfDateForCalcRow(row) {
    var paid = Number(String(row && row.paid || "0").replace(/\s+/g, "").replace(",", ".")) || 0;
    if (paid > 0.0000001) {
      var paidDate = _parseCalcDateISO(row && row.paid_date);
      if (paidDate) return paidDate;
    }
    return _endOfCalcMonthDate(row && row.year, row && row.month) || new Date();
  }

  function _rowInCalcPeriod(row, periodFrom, periodTo) {
    return _filterCalcRowsByPeriod([row], periodFrom, periodTo).length > 0;
  }

  function _calcRowsWithEngine(rows, periodFrom, periodTo, periodActive, abonentId) {
    if (!window.JKHCalcEngine || typeof window.JKHCalcEngine.calcTotalsAsOfAdjusted !== "function") throw new Error("CALC_ENGINE_NOT_AVAILABLE");
    var allRows = _cloneLedgerRows(rows);
    var baseRows = periodActive ? _filterCalcRowsByPeriod(allRows, periodFrom, periodTo) : allRows;
    var sorted = allRows.slice().sort(function (a, b) {
      var ad = _asOfDateForCalcRow(a).getTime();
      var bd = _asOfDateForCalcRow(b).getTime();
      if (ad !== bd) return ad - bd;
      return (Number(a && a.id) || 0) - (Number(b && b.id) || 0);
    });

    sorted.forEach(function (row) {
      if (!_rowInCalcPeriod(row, periodFrom, periodTo)) return;
      var asOf = _asOfDateForCalcRow(row);
      var totals = window.JKHCalcEngine.calcTotalsAsOfAdjusted(baseRows, asOf, { abonentId: abonentId, applyAdvanceOffset: true, allowNegativePrincipal: true });
      if (!totals || !Number.isFinite(Number(totals.principal)) || !Number.isFinite(Number(totals.penaltyDebt)) || !Number.isFinite(Number(totals.total))) {
        throw new Error("CALC_TOTALS_INVALID");
      }
      row.pay_main = _roundCalcMoney(totals.principal);
      row.pay_penalty = _roundCalcMoney(totals.penaltyDebt);
      row.total = _roundCalcMoney(totals.total);
      row.total_debt = _roundCalcMoney(totals.total);
    });

    return allRows;
  }

  function _isServerFirstDataReadyForRecalc() {
    try {
      if (!_remoteEnabled()) return true;
      var st = window.JKH_UI_STATE && window.JKH_UI_STATE.data;
      var status = String(st && st.status || "");
      if (status !== "ready" && status !== "empty") return false;
      if (st && Object.prototype.hasOwnProperty.call(st, "source") && String(st.source || "") !== "server") return false;
      return true;
    } catch (e) {
      return !_remoteEnabled();
    }
  }

  async function _waitForServerFirstDataReadyForRecalc() {
    if (_isServerFirstDataReadyForRecalc()) return true;
    if (_remoteEnabled() && window.JKHDataLoader && typeof window.JKHDataLoader.loadFromServer === "function") {
      try { await window.JKHDataLoader.loadFromServer({ reason: "abonent_card_recalc", force: false }); } catch (e) { }
      if (_isServerFirstDataReadyForRecalc()) return true;
    }

    if (!_remoteEnabled()) return true;
    var started = Date.now();
    while (Date.now() - started < 8000) {
      await new Promise(function (resolve) { setTimeout(resolve, 100); });
      if (_isServerFirstDataReadyForRecalc()) return true;
    }
    throw new Error("SERVER_DATA_NOT_READY");
  }

  async function recalculateAbonentCard(abonentOrId, options) {
    var opts = options || {};
    var startedAt = new Date().toISOString();
    var found0 = _findAbonentByIdOrUid(abonentOrId);
    var abonentId0 = String(found0 && found0.id || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
    _calcLog("[abonent-card-recalc][start]", { abonentId: abonentId0, source: String(opts.source || ""), startedAt: startedAt });

    try {
      await _waitForServerFirstDataReadyForRecalc();
      if (!Data.ensureWriteOrExplain()) return { ok: false, rowsCount: 0, summary: null, reason: "WRITE_BLOCKED" };

      var found = _findAbonentByIdOrUid(abonentOrId);
      var abonentId = String(found && found.id || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
      var abonent = found && found.abonent ? found.abonent : null;
      var uid = String(abonent && abonent.uid || "").trim();
      if (!abonent || !abonentId || !uid) throw new Error("ABONENT_UID_REQUIRED");

      var ledgerKey = resolvePaymentLedgerKey(abonentId);
      _calcLog("[abonent-card-recalc][ledger-key]", { abonentId: abonentId, uid: uid, ledgerKey: ledgerKey });
      if (!ledgerKey) throw new Error("LEDGER_KEY_REQUIRED");

      var raw = _getProjectRaw(ledgerKey);
      var ledgerMissing = raw === null || raw === undefined || raw === "";
      var rows = ledgerMissing ? [] : _parseLedgerRows(raw, ledgerKey);
      var period = _readActiveCalcPeriod(abonentId) || _defaultCalcPeriodForAbonent(abonentId, abonent);
      var periodMode = _calcPeriodMode(period);
      var periodFrom = String(period && period.from || "").trim();
      var periodTo = String(period && period.to || "").trim();
      if (!_parseCalcDateISO(periodFrom) || !_parseCalcDateISO(periodTo)) throw new Error("CALC_PERIOD_INVALID");
      var rowsForAccrualCheck = _filterCalcRowsByPeriod(rows, periodFrom, periodTo);
      var hasAccrualInScope = _hasCalcAccrualRows(rowsForAccrualCheck);
      _calcLog("[abonent-card-recalc][rows-before]", { abonentId: abonentId, uid: uid, ledgerKey: ledgerKey, rowsCount: rows.length, ledgerMissing: ledgerMissing, hasAccrual: _hasCalcAccrualRows(rows), hasAccrualInScope: hasAccrualInScope, periodFrom: periodFrom, periodTo: periodTo, periodMode: periodMode });

      var autoaccrualResult = { ok: true, changed: false, reason: period.active ? "SELECTED_PERIOD_NO_UNSCOPED_AUTOACCRUAL" : "SKIPPED" };
      _calcLog("[abonent-card-recalc][autoaccrual]", { abonentId: abonentId, uid: uid, result: autoaccrualResult });

      if (period.active) {
        var readiness = _checkPeriodAccrualReadiness(rowsForAccrualCheck, periodFrom, periodTo, { abonentId: abonentId, uid: uid, ledgerKey: ledgerKey, periodMode: periodMode });
        if (!readiness.ok) return { ok: false, uid: uid, abonentId: abonentId, periodFrom: periodFrom, periodTo: periodTo, summary: null, reason: readiness.reason, missingMonths: readiness.missingMonths };
      }

      var recalculatedRows = _calcRowsWithEngine(rows, periodFrom, periodTo, !!period.active, abonentId);
      _calcLog("[abonent-card-recalc][rows-after]", { abonentId: abonentId, uid: uid, ledgerKey: ledgerKey, rowsCount: recalculatedRows.length, periodFrom: periodFrom, periodTo: periodTo, periodMode: periodMode });

      var ledgerOk = writePaymentLedger(abonentId, recalculatedRows, { eventType: "ABONENT_CARD_RECALC_LEDGER_WRITE", dirtyReason: "abonent_card_recalc", event: { source: String(opts.source || "abonent_card") } });
      if (ledgerOk === false) throw new Error("LEDGER_WRITE_FAILED");

      var summaryRows = _filterCalcRowsByPeriod(recalculatedRows, periodFrom, periodTo);
      var asOf = _parseCalcDateISO(periodTo);
      var totals = window.JKHCalcEngine.calcTotalsAsOfAdjusted(summaryRows, asOf, { abonentId: abonentId, applyAdvanceOffset: true, allowNegativePrincipal: true });
      if (!totals || !Number.isFinite(Number(totals.principal)) || !Number.isFinite(Number(totals.penaltyDebt)) || !Number.isFinite(Number(totals.total))) throw new Error("CALC_TOTALS_INVALID");

      var accruedTotal = _roundCalcMoney(_sumCalcRows(summaryRows, "accrued"));
      var paidTotal = _roundCalcMoney(_sumCalcRows(summaryRows, "paid"));
      var summary = {
        uid: uid,
        abonentId: abonentId,
        calculatedAt: new Date().toISOString(),
        periodFrom: periodFrom,
        periodTo: periodTo,
        periodMode: periodMode,
        from: periodFrom,
        to: periodTo,
        selectedPeriod: !!period.active,
        ledgerKey: ledgerKey,
        rowsTotal: recalculatedRows.length,
        rowsInPeriod: summaryRows.length,
        accrued: accruedTotal,
        accruedTotal: accruedTotal,
        nachisleno: accruedTotal,
        paid: paidTotal,
        paidTotal: paidTotal,
        oplacheno: paidTotal,
        principal: _roundCalcMoney(totals.principal),
        mainDebt: _roundCalcMoney(totals.principal),
        main_debt: _roundCalcMoney(totals.principal),
        penalty: _roundCalcMoney(totals.penaltyDebt),
        penaltyDebt: _roundCalcMoney(totals.penaltyDebt),
        penalty_debt: _roundCalcMoney(totals.penaltyDebt),
        totalDebt: _roundCalcMoney(totals.total),
        total_debt: _roundCalcMoney(totals.total),
        total: _roundCalcMoney(totals.total),
        startDate: periodFrom,
        endDate: periodTo,
        totals: totals
      };

      var summaryOk = writeCalcSummary(abonentId, summary);
      if (summaryOk === false) throw new Error("SUMMARY_WRITE_FAILED");
      _calcLog("[abonent-card-recalc][summary-write]", { abonentId: abonentId, uid: uid, key: resolveCalcSummaryKey(abonentId), rowsInPeriod: summary.rowsInPeriod, total: summary.total });
      _calcLog("[abonent-card-recalc][dirty-clear]", { abonentId: abonentId, uid: uid, key: resolveCalcDirtyKey(abonentId) });

      var readBackSummary = readCalcSummary(abonentId);
      var readBackLedger = readPaymentLedger(abonentId);
      if (!readBackSummary || readBackSummary.status !== "fresh") throw new Error(readBackSummary && readBackSummary.reason ? readBackSummary.reason : "SUMMARY_READBACK_NOT_FRESH");
      _calcLog("[abonent-card-recalc][done]", { abonentId: abonentId, uid: uid, rowsCount: readBackLedger.length, summaryStatus: readBackSummary.status });

      return { ok: true, rowsCount: readBackLedger.length, summary: readBackSummary.summary };
    } catch (e) {
      var reason = e && e.message ? e.message : String(e);
      _calcWarn("[abonent-card-recalc][failed]", { abonentId: abonentId0, reason: reason });
      return { ok: false, rowsCount: 0, summary: null, reason: reason };
    }
  }


  function resolvePaymentLedgerKey(abonentOrId, options) {
    var opts = options || {};
    var found = _findAbonentByIdOrUid(abonentOrId);
    var id = String(found && found.id || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
    var abonent = found && found.abonent ? found.abonent : null;
    var uid = String(abonent && abonent.uid || "").trim();
    if (uid) return "payments_" + uid;
    if (opts && opts.allowLegacyRead === true && id) return "payments_" + id;
    return "";
  }

  function readPaymentLedger(abonentOrId) {
    var found = _findAbonentByIdOrUid(abonentOrId);
    var id = String(found && found.id || (typeof abonentOrId === "object" ? abonentOrId && abonentOrId.id : abonentOrId) || "").trim();
    var canonicalKey = resolvePaymentLedgerKey(abonentOrId);
    if (canonicalKey) {
      var raw = _getProjectRaw(canonicalKey);
      if (raw !== null && raw !== undefined) return _cloneLedgerRows(_parseLedgerRows(raw, canonicalKey));
    }

    // calc_summary architecture: ordinary reads do not fall back to legacy payments_<LS>.
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
    if (!key || !uid) {
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
    if (ok !== false) markCalcDirty(abonentOrId, opts.dirtyReason || "payments_changed");
    if (ok !== false && opts.event !== false) {
      recordFinancialEvent(Object.assign({
        type: opts.eventType || "LEDGER_WRITE",
        sourceAbonentId: id,
        targetAbonentId: id,
        mode: opts.mode || "",
        date: opts.date || ""
      }, opts.event || {}));
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
    if (!key || !uid) {
      _logLedgerInit({ abonentId: id, uid: uid, key: key || "", result: "blocked", reason: "UID_REQUIRED" });
      return false;
    }
    if (key !== "payments_" + uid || (id && id !== uid && key === "payments_" + id)) {
      _logLedgerInit({ abonentId: id, uid: uid, key: key, result: "blocked", reason: "LS_LEDGER_CREATE_FORBIDDEN" });
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


  function migrateLegacyCalcPeriodKeysForDb(db) {
    if (!db || !db.abonents || typeof db.abonents !== "object") return 0;
    var migrated = 0;
    var ownerId = _ownerId();
    Object.keys(db.abonents).forEach(function (abonentId) {
      var a = db.abonents[abonentId] || {};
      var uid = String(a.uid || "").trim();
      if (!uid) return;
      [
        { prefix: "calc_period_", canonicalKey: "calc_period_" + uid },
        { prefix: "calc_period_active_", canonicalKey: "calc_period_active_" + uid }
      ].forEach(function (meta) {
        var aliases = [abonentId, a.id, a.ls, a.account, a.accountNumber, a.personalAccount, a.regnum, a.premiseRegnum];
        aliases.forEach(function (alias) {
          var suffix = String(alias || "").trim();
          if (!suffix || suffix === uid) return;
          var legacyKey = meta.prefix + suffix;
          var val = _getRawScoped(legacyKey, ownerId);
          if (val !== null && val !== undefined) {
            if (_getRawScoped(meta.canonicalKey, ownerId) === null) _setRawScoped(meta.canonicalKey, val, ownerId);
            _removeRawScoped(legacyKey, ownerId);
            migrated++;
            try { console.warn("[calc-period][legacy-cleanup]", { from: legacyKey, to: meta.canonicalKey, ownerId: ownerId, abonentId: String(abonentId || ""), uid: uid }); } catch (e) {}
          }
        });
      });
    });
    return migrated;
  }

  function _responsibilityDbFingerprint(db) {
    var src = db || {};
    return _simpleCalcHash(_stableCalcStringify({ premises: src.premises || {}, links: Array.isArray(src.links) ? src.links : [] }));
  }

  function saveToStorage(db) {
    if (!_canWriteStorage()) return false;
    migrateLegacyCalcPeriodKeysForDb(db);
    try {
      var beforeRaw = _getRawScoped(KEY_DB);
      var beforeHash = "";
      if (beforeRaw) {
        try { beforeHash = _responsibilityDbFingerprint(JSON.parse(String(beforeRaw))); } catch (e0) { beforeHash = "invalid"; }
      }
      var afterHash = _responsibilityDbFingerprint(db);
      _setRawScoped(KEY_DB, JSON.stringify(db));
      if (beforeHash && beforeHash !== afterHash) __markAllCalcDirty("responsibility_changed");
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
    if (currentUid) return { ok: true, uid: currentUid, changed: false };

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
      if (objUid) {
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

  // ============================================================
  // INIT global DB
  // ============================================================
  const stored = loadFromStorage();
  if (!_isAllMode()) window.JKH_DATA_READY = !!stored;
  window.AbonentsDB = stored ? mergePreferStored(BASE_DB, stored) : deepClone(BASE_DB);
  normalizeDb(window.AbonentsDB);
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
    CALC_SUMMARY_ENGINE_VERSION: CALC_SUMMARY_ENGINE_VERSION,
    CALC_SUMMARY_CANON_VERSION: CALC_SUMMARY_CANON_VERSION,
    CALC_SUMMARY_FORMAT_VERSION: CALC_SUMMARY_FORMAT_VERSION,
    normalizeExcludePeriodsList: normalizeExcludePeriodsList,
    readCanonicalExcludePeriods: readCanonicalExcludePeriods,
    writeCanonicalExcludePeriods: writeCanonicalExcludePeriods,
    repairEmptyExcludePeriodsKeys: repairEmptyExcludePeriodsKeys,
    migrateLegacyCalcPeriodKeysForDb: migrateLegacyCalcPeriodKeysForDb,
    ensureAbonentUid: ensureAbonentUid,
    resolveCalcPeriodStorageKey: resolveCalcPeriodStorageKey,
    resolveCalcPeriodActiveStorageKey: resolveCalcPeriodActiveStorageKey,
    resolveCalcSummaryKey: resolveCalcSummaryKey,
    resolveCalcCheckpointKey: resolveCalcCheckpointKey,
    resolveCalcDirtyKey: resolveCalcDirtyKey,
    markCalcDirty: markCalcDirty,
    isCalcDirty: isCalcDirty,
    readCalcSummary: readCalcSummary,
    getCalcSummaryDebugInfo: getCalcSummaryDebugInfo,
    writeCalcSummary: writeCalcSummary,
    recalculateCalcSummary: recalculateCalcSummary,
    preparePeriodAccruals: preparePeriodAccruals,
    prepareAndRecalculateCalcSummary: prepareAndRecalculateCalcSummary,
    recalculateAbonentCard: recalculateAbonentCard,
    resolvePaymentLedgerKey: resolvePaymentLedgerKey,
    readPaymentLedger: readPaymentLedger,
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
      if (saved) __scheduleTransferFlushToServer();
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
window.CALC_SUMMARY_ENGINE_VERSION = CALC_SUMMARY_ENGINE_VERSION;
window.CALC_SUMMARY_CANON_VERSION = CALC_SUMMARY_CANON_VERSION;
window.CALC_SUMMARY_FORMAT_VERSION = CALC_SUMMARY_FORMAT_VERSION;
window.resolveCalcSummaryKey = resolveCalcSummaryKey;
window.resolveCalcCheckpointKey = resolveCalcCheckpointKey;
window.resolveCalcDirtyKey = resolveCalcDirtyKey;
window.markCalcDirty = markCalcDirty;
window.readCalcSummary = readCalcSummary;
window.getCalcSummaryDebugInfo = getCalcSummaryDebugInfo;
window.writeCalcSummary = writeCalcSummary;
window.recalculateCalcSummary = recalculateCalcSummary;
window.prepareAndRecalculateCalcSummary = prepareAndRecalculateCalcSummary;
window.recalculateAbonentCard = recalculateAbonentCard;
window.Data = Data;

function __markAllCalcDirty(reason) {
  try {
    var db = window.AbonentsDB || {};
    var abonents = db && db.abonents && typeof db.abonents === "object" ? db.abonents : {};
    Object.keys(abonents).forEach(function (id) { markCalcDirty(id, reason); });
  } catch (e) { }
}

function __markCalcDirtyForStorageMutation(key) {
  var k = String(key || "");
  if (!k || k.indexOf("calc_dirty_") === 0 || k.indexOf("calc_summary_") === 0 || k.indexOf("calc_checkpoint_") === 0) return;
  if (k.indexOf("tariff") >= 0 || k.indexOf("refinancing_rates_") === 0 || k === "refinancing_v1") {
    __markAllCalcDirty(k.indexOf("refinancing") === 0 ? "refinancing_rates_changed" : "tariffs_changed");
    return;
  }
  if (k.indexOf("payments_") === 0) {
    markCalcDirty(k.slice("payments_".length), "payments_changed");
    return;
  }
  if (k.indexOf("calc_period_active_") === 0) {
    markCalcDirty(k.slice("calc_period_active_".length), "calc_period_changed");
    return;
  }
  if (k.indexOf("calc_period_") === 0) {
    markCalcDirty(k.slice("calc_period_".length), "calc_period_changed");
    return;
  }
  if (k.indexOf("exclude_periods_") === 0) {
    markCalcDirty(k.slice("exclude_periods_".length), "exclude_periods_changed");
    return;
  }
  if (k.indexOf("moratorium_") === 0) {
    markCalcDirty(k.slice("moratorium_".length), "moratorium_changed");
  }
}

(function __installCalcDirtyStorageHooks(){
  try {
    if (!window.JKHStore || window.JKHStore.__calcDirtyHooksInstalled) return;
    var originalSetRaw = window.JKHStore.setRaw;
    var originalRemoveRaw = window.JKHStore.removeRaw;
    if (typeof originalSetRaw === "function") {
      window.JKHStore.setRaw = function(key, value, ownerId){
        var res = originalSetRaw.apply(this, arguments);
        if (res !== false) __markCalcDirtyForStorageMutation(key);
        return res;
      };
    }
    if (typeof originalRemoveRaw === "function") {
      window.JKHStore.removeRaw = function(key, ownerId){
        var res = originalRemoveRaw.apply(this, arguments);
        if (res !== false) __markCalcDirtyForStorageMutation(key);
        return res;
      };
    }
    window.JKHStore.__calcDirtyHooksInstalled = true;
  } catch (e) {
    try { console.warn("[calc-dirty][storage-hooks-failed]", e); } catch (_) {}
  }
})();
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
      if (calcKey) _setRawScoped(calcKey, JSON.stringify({ from: "", to: "" }));
      if (calcActiveKey) _setRawScoped(calcActiveKey, "0");
      _setRawScoped("report_period_" + id, JSON.stringify({ from: "", to: "" }));
    });

    // 7) платежи — намеренно как “проверочный кейс”
    _setRawScoped("payments_1006", JSON.stringify([
      { id: 1, year: "2025", month: "01", accrued: 200, paid: 0, paid_date: "", source: "Платёж 1", payment_period: "" },
      { id: 2, year: "2025", month: "02", accrued: 200, paid: 0, paid_date: "", source: "Платёж 1", payment_period: "" },
      { id: 3, year: "2025", month: "02", accrued: 0, paid: 3870, paid_date: "10.02.2025", source: "Платёж 1", payment_period: "" }
    ]));

    _setRawScoped("payments_1008", JSON.stringify([
      { id: 1, year: "2025", month: "01", accrued: 200, paid: 0, paid_date: "", source: "Платёж 1", payment_period: "" }
    ]));
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
