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
    "jkh_transfer_balance_v1:",
    "jkh_freeze_to_v1:"
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

  function getAbonentTechId(abonentId) {
    try {
      var id = String(abonentId || '').trim();
      var db = (window.Data && typeof window.Data.getDb === 'function') ? window.Data.getDb() : (window.AbonentsDB || {});
      var abonents = (db && db.abonents && typeof db.abonents === 'object') ? db.abonents : {};
      var a = abonents[id] || null;
      var uid = String(a && a.uid || '').trim();
      var techId = uid || id;
      var mode = uid ? 'uid' : 'legacy';
      try { console.log('[payment-key] resolve', { abonentId: id, uid: uid || '', key: 'payments_' + techId, mode: mode }); } catch(e) {}
      return techId;
    } catch (e) {
      var fallback = String(abonentId || '').trim();
      try { console.log('[payment-key] resolve', { abonentId: fallback, uid: '', key: 'payments_' + fallback, mode: 'legacy' }); } catch(_) {}
      return fallback;
    }
  }

  function getPaymentsKeyForAbonent(abonentId) {
    return 'payments_' + getAbonentTechId(abonentId);
  }

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

  function saveToStorage(db) {
    if (!_canWriteStorage()) return false;
    try {
      _setRawScoped(KEY_DB, JSON.stringify(db));
      return true;
    } catch (e) {
      return false;
    }
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
          createdAt: a.premiseCreatedAt || a.premiseCreated || "2000-01-01",
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

  window.saveAbonentsDB = function () {
    if (!window.AbonentsDB) return;
    normalizeDb(window.AbonentsDB);
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
      if (!String(merged.createdAt || "").trim()) merged.createdAt = "2000-01-01";
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

      var regnum = normalizeRegnumValue(input.premiseRegnum || input.regnum);
      if (regnum) {
        input.premiseRegnum = regnum;
        input.regnum = regnum;
      }

      window.AbonentsDB.abonents[id] = input;

      if (regnum) {
        var premiseObj = {
          regnum: regnum,
          city: input.city || "",
          street: input.street || "",
          house: input.house || "",
          flat: input.flat || "",
          square: input.square !== undefined ? input.square : (input.totalArea !== undefined ? input.totalArea : ""),
          createdAt: input.premiseCreatedAt || input.premiseCreated || "2000-01-01",
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
        db.abonents[generatedNewId] = newAbonent;
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

  function prepareDebtTransfer(oldAbonentId, newAbonentId, regnum, transferDate, transferMode){
    if (!Data.ensureWriteOrExplain()) return false;

    try{
      var oldId = String(oldAbonentId||"").trim();
      var newId = String(newAbonentId||"").trim();
      var rn    = String(regnum||"").trim();
      var td    = String(transferDate||"").trim();
      var mode  = (String(transferMode||"WITH_DEBT").trim() === "NO_DEBT") ? "NO_DEBT" : "WITH_DEBT";

      if (!oldId || !newId || !rn || !/^\d{4}-\d{2}-\d{2}$/.test(td)) return false;

      // freezeDate = день ДО даты передачи
      var freezeISO = __isoYesterday(td);
      if (!freezeISO) return false;

      // 1) Рассчитать и заморозить долг старого (principal + penalty)
      var frozenDebt = null;
      if (window.JKHCalcEngine && typeof window.JKHCalcEngine.calculateFrozenDebt === "function"){
        frozenDebt = window.JKHCalcEngine.calculateFrozenDebt(oldId, freezeISO);
      }else if (window.JKHCalcEngine && typeof window.JKHCalcEngine.calcTotalsAsOfAdjusted === "function"){
        try{
          var rows = (window.JKHCalcEngine.loadPaymentsForAbonent)
            ? window.JKHCalcEngine.loadPaymentsForAbonent(oldId)
            : (function(){
                try{ var raw=_getProjectRaw("payments_"+oldId); return raw?JSON.parse(raw):[]; }catch(e){ return []; }
              })();
          var d = new Date(String(freezeISO)+"T12:00:00");
          var tot = window.JKHCalcEngine.calcTotalsAsOfAdjusted(rows, d, { abonentId: oldId, applyAdvanceOffset:true, allowNegativePrincipal:false });
          frozenDebt = { principal: Number(tot?.principal)||0, penalty: Number(tot?.penaltyDebt)||0, calculatedAt: freezeISO };
        }catch(e){}
      }

      if (frozenDebt){
        _setProjectRaw("jkh_frozen_debt_v1:" + oldId + ":" + freezeISO, JSON.stringify({
          principal: Number(frozenDebt.principal)||0,
          penalty: Number(frozenDebt.penalty)||0,
          calculatedAt: String(frozenDebt.calculatedAt||freezeISO)
        }));
      } else {
        // если не смогли рассчитать — всё равно пишем нули, чтобы система была детерминированной
        _setProjectRaw("jkh_frozen_debt_v1:" + oldId + ":" + freezeISO, JSON.stringify({
          principal: 0, penalty: 0, calculatedAt: freezeISO
        }));
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
        try{
          var debtRaw = _getProjectRaw("jkh_frozen_debt_v1:" + oldId + ":" + freezeISO);
          var dd = debtRaw ? JSON.parse(debtRaw) : { principal:0, penalty:0 };
          _setProjectRaw("jkh_transfer_balance_v1:" + newId + ":" + rn, JSON.stringify({
            startDate: td,
            principal: Number(dd?.principal)||0,
            penalty: Number(dd?.penalty)||0,
            regnum: rn,
            fromAbonentId: oldId,
            mode: "WITH_DEBT"
          }));
        }catch(e){}
      } else {
        // NO_DEBT: снимаем возможные хвосты переноса на нового (на всякий случай)
        try{ _removeProjectRaw("jkh_transfer_to_v1:" + newId); }catch(e){}
        try{ _removeProjectRaw("jkh_transfer_balance_v1:" + newId + ":" + rn); }catch(e){}
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
      return false;
    }
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
  Data.getAbonentTransferInfo = getAbonentTransferInfo;

window.Data = Data;
window.JKHBoot?.markReady?.('data');

  // Если storage пустой — сохраним пустую структуру один раз
  if (!stored) {
    window.saveAbonentsDB();
  }

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
        premiseCreatedAt: "2000-01-01"
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
        premiseCreatedAt: "2000-01-01"
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
      _setRawScoped("calc_period_" + id, JSON.stringify({ from: "", to: "" }));
      _setRawScoped("calc_period_active_" + id, "0");
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

    alert("Демо загружено: абоненты 1006 и 1008.");
    location.reload();
  };

  // ============================================================
  // DEV CHECK (не мешает работе)
  // ============================================================
  // console.log("data.js loaded: ", typeof window.testLoadDemoDatabase);

})();
