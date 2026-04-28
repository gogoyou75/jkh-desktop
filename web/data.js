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
    "tariffs_content_repair_v1",
    "tariffs_content_repair_v1_backup",
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

  function _isActiveAbonent(a) {
    var st = String((a && a.status) || "active").trim().toLowerCase();
    return st !== "deleted";
  }
  function _isIsoDate(v) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(v || "").trim());
  }
  function _isoToTs(v) {
    var s = String(v || "").trim();
    if (!_isIsoDate(s)) return NaN;
    var d = new Date(s + "T12:00:00");
    return Number.isFinite(d.getTime()) ? d.getTime() : NaN;
  }
  function _isoMinusOne(iso) {
    if (!_isIsoDate(iso)) return "";
    var d = new Date(String(iso) + "T12:00:00");
    d.setDate(d.getDate() - 1);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + dd;
  }
  function _ownerMismatch(linkOwner, ownerId) {
    var lo = String(linkOwner || "").trim();
    var oo = String(ownerId || "").trim();
    if (!oo) return false;
    return lo !== oo;
  }
  function _normalizeResponsibilityHistory(history, ownerId) {
    console.log("[responsibility][normalize]", { count: Array.isArray(history) ? history.length : 0 });
    var src = Array.isArray(history) ? history.slice() : [];
    var dedupeMap = {};
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var l = src[i];
      if (!l || typeof l !== "object") continue;
      var regnum = String(l.regnum || "").trim();
      var abonentId = String(l.abonentId || "").trim();
      var dateFrom = String(l.dateFrom || "").trim();
      if (!regnum || !abonentId || !dateFrom) continue;
      var key = regnum + "::" + abonentId + "::" + dateFrom;
      if (dedupeMap[key]) {
        console.warn("[responsibility][dedupe]", { key: key });
        continue;
      }
      dedupeMap[key] = true;
      var ln = Object.assign({}, l);
      if (ownerId && !String(ln.ownerId || "").trim()) ln.ownerId = String(ownerId);
      out.push(ln);
    }
    out.sort(function (a, b) {
      var ra = String(a.regnum || "").trim();
      var rb = String(b.regnum || "").trim();
      if (ra !== rb) return ra.localeCompare(rb, "ru");
      return String(a.dateFrom || "").localeCompare(String(b.dateFrom || ""));
    });
    return out;
  }
  function _validateResponsibilityHistoryForDb(history, db, ownerId) {
    console.log("[responsibility][validate]", { count: Array.isArray(history) ? history.length : 0, ownerId: ownerId || "" });
    var grouped = {};
    var arr = Array.isArray(history) ? history : [];
    for (var i = 0; i < arr.length; i++) {
      var l = arr[i];
      var reg = String(l && l.regnum || "").trim();
      if (!reg) continue;
      if (_ownerMismatch(l && l.ownerId, ownerId)) {
        var eOm = new Error("RESPONSIBILITY_OWNER_MISMATCH");
        eOm.code = "RESPONSIBILITY_OWNER_MISMATCH";
        throw eOm;
      }
      var dfRaw = String(l && l.dateFrom || "").trim();
      var dtRaw = String(l && l.dateTo || "").trim();
      if (!_isIsoDate(dfRaw) || (dtRaw && !_isIsoDate(dtRaw))) {
        var eId = new Error("RESPONSIBILITY_INVALID_DATE");
        eId.code = "RESPONSIBILITY_INVALID_DATE";
        throw eId;
      }
      if (dtRaw && _isoToTs(dtRaw) < _isoToTs(dfRaw)) {
        var eInvRange = new Error("RESPONSIBILITY_INVALID_DATE");
        eInvRange.code = "RESPONSIBILITY_INVALID_DATE";
        throw eInvRange;
      }
      if (!grouped[reg]) grouped[reg] = [];
      grouped[reg].push(l);
    }
    var regs = Object.keys(grouped);
    for (var r = 0; r < regs.length; r++) {
      var items = grouped[regs[r]].slice().sort(function (a, b) {
        return String(a.dateFrom || "").localeCompare(String(b.dateFrom || ""));
      });
      var activeCount = 0;
      for (var j = 0; j < items.length; j++) {
        var cur = items[j];
        var curFrom = _isoToTs(cur.dateFrom);
        var curTo = String(cur.dateTo || "").trim() ? _isoToTs(cur.dateTo) : Number.POSITIVE_INFINITY;
        var isOpen = !String(cur.dateTo || "").trim();
        if (isOpen) activeCount++;
        if (!Number.isFinite(curFrom) || !(Number.isFinite(curTo) || curTo === Number.POSITIVE_INFINITY) || curTo < curFrom) {
          var eInv = new Error("RESPONSIBILITY_INVALID_DATE");
          eInv.code = "RESPONSIBILITY_INVALID_DATE";
          throw eInv;
        }
        if (isOpen && db && db.abonents) {
          var aid = String(cur.abonentId || "").trim();
          var ab = db.abonents[aid];
          if (ab && !_isActiveAbonent(ab)) {
            var eDel = new Error("RESPONSIBILITY_DELETED_ACTIVE");
            eDel.code = "RESPONSIBILITY_DELETED_ACTIVE";
            throw eDel;
          }
        }
        for (var k = j + 1; k < items.length; k++) {
          var nxt = items[k];
          var nf = _isoToTs(nxt.dateFrom);
          var nt = String(nxt.dateTo || "").trim() ? _isoToTs(nxt.dateTo) : Number.POSITIVE_INFINITY;
          if (!(curTo < nf || nt < curFrom)) {
            console.warn("[responsibility][overlap]", { regnum: regs[r], left: cur, right: nxt });
            var eOv = new Error("RESPONSIBILITY_PERIOD_OVERLAP");
            eOv.code = "RESPONSIBILITY_PERIOD_OVERLAP";
            throw eOv;
          }
        }
      }
      if (activeCount > 1) {
        var eMa = new Error("RESPONSIBILITY_MULTIPLE_ACTIVE");
        eMa.code = "RESPONSIBILITY_MULTIPLE_ACTIVE";
        throw eMa;
      }
    }
    return true;
  }
  function _validateResponsibilityHistory(history, ownerId) {
    return _validateResponsibilityHistoryForDb(history, null, ownerId);
  }
  function _applyResponsibilityChange(db, regnum, abonentId, startDate, ownerId) {
    var r = String(regnum || "").trim();
    var aid = String(abonentId || "").trim();
    var sd = String(startDate || "").trim();
    if (!r || !aid || !_isIsoDate(sd)) {
      var e = new Error("RESPONSIBILITY_INVALID_DATE");
      e.code = "RESPONSIBILITY_INVALID_DATE";
      throw e;
    }
    if (!Array.isArray(db.links)) db.links = [];
    var beforeLinks = deepClone(db.links);
    var duplicate = db.links.find(function (l) {
      return String(l && l.regnum || "").trim() === r &&
        String(l && l.abonentId || "").trim() === aid &&
        String(l && l.dateFrom || "").trim() === sd;
    });
    if (duplicate) {
      return { ok: true, skipped: true, reason: "duplicate" };
    }
    try {
      for (var i = 0; i < db.links.length; i++) {
        var l = db.links[i];
        if (String(l && l.regnum || "").trim() !== r) continue;
        if (_ownerMismatch(l && l.ownerId, ownerId)) {
          var eOm = new Error("RESPONSIBILITY_OWNER_MISMATCH");
          eOm.code = "RESPONSIBILITY_OWNER_MISMATCH";
          throw eOm;
        }
        var lf = String(l && l.dateFrom || "").trim();
        var lt = String(l && l.dateTo || "").trim();
        if (_isIsoDate(lf) && lt && _isIsoDate(lt)) {
          var lfTs = _isoToTs(lf);
          var ltTs = _isoToTs(lt);
          var sdTs = _isoToTs(sd);
          if (lfTs <= sdTs && sdTs <= ltTs) {
            var isSameStart = String(l && l.abonentId || "").trim() === aid && lf === sd;
            if (!isSameStart) {
              var eOvClosed = new Error("RESPONSIBILITY_PERIOD_OVERLAP");
              eOvClosed.code = "RESPONSIBILITY_PERIOD_OVERLAP";
              throw eOvClosed;
            }
          }
        }
      }
      for (var j = 0; j < db.links.length; j++) {
        var al = db.links[j];
        if (String(al && al.regnum || "").trim() !== r) continue;
        var alt = String(al && al.dateTo || "").trim();
        if (alt) continue;
        var alf = String(al && al.dateFrom || "").trim();
        if (!_isIsoDate(alf)) continue;
        if (_isoToTs(alf) < _isoToTs(sd)) {
          al.dateTo = _isoMinusOne(sd);
          continue;
        }
        var eOvActive = new Error("RESPONSIBILITY_PERIOD_OVERLAP");
        eOvActive.code = "RESPONSIBILITY_PERIOD_OVERLAP";
        throw eOvActive;
      }

      db.links.push({ abonentId: aid, regnum: r, dateFrom: sd, dateTo: "", ownerId: ownerId || "" });
      db.links = _normalizeResponsibilityHistory(db.links, ownerId);
      _validateResponsibilityHistoryForDb(db.links, db, ownerId);
      return { ok: true, skipped: false };
    } catch (err) {
      db.links = beforeLinks;
      throw err;
    }
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
      if (!String(a.status || "").trim()) a.status = "active";

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
          createdAt: a.premiseCreatedAt || a.premiseCreated || "2000-01-01"
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

    // чистим битые links
    db.links = db.links.filter((l) => {
      const abonentOk = !!db.abonents?.[String(l?.abonentId)];
      const premiseOk = !!db.premises?.[String(l?.regnum || "").trim()];
      return abonentOk && premiseOk;
    });
    db.links = _normalizeResponsibilityHistory(db.links, _ownerId());
    db._responsibilityInvalid = false;
    db._responsibilityInvalidCode = "";
    db._responsibilityInvalidAt = "";
    try {
      _validateResponsibilityHistoryForDb(db.links, db, _ownerId());
    } catch (e) {
      var code = e && e.code ? e.code : "RESPONSIBILITY_INVALID";
      db._responsibilityInvalid = true;
      db._responsibilityInvalidCode = String(code);
      db._responsibilityInvalidAt = new Date().toISOString();
      console.warn("[responsibility][validate] normalizeDb warning", code);
    }
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
      return listByObjectValues(db && db.abonents).filter(_isActiveAbonent);
    },
    getAbonent: function (abonentId) {
      var db = this.getDb();
      if (!db || !db.abonents) return null;
      var ab = db.abonents[String(abonentId)] || null;
      return _isActiveAbonent(ab) ? ab : null;
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
      if (!String(merged.createdAt || "").trim()) merged.createdAt = "2000-01-01";

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
      if (!String(input.status || "").trim()) input.status = "active";
      if (!String(input.ownerId || "").trim()) input.ownerId = _ownerId();

      window.AbonentsDB.abonents[id] = input;

      if (regnum) {
        var premiseObj = {
          regnum: regnum,
          city: input.city || "",
          street: input.street || "",
          house: input.house || "",
          flat: input.flat || "",
          square: input.square !== undefined ? input.square : (input.totalArea !== undefined ? input.totalArea : ""),
          createdAt: input.premiseCreatedAt || input.premiseCreated || "2000-01-01"
        };
        this.ensurePremise(premiseObj);
        var startDate = input.calcStartDate || input.startDate || "";
        var endDate = input.calcEndDate || input.endDate || "";
        if (startDate && !endDate) {
          try { _applyResponsibilityChange(window.AbonentsDB, regnum, id, startDate, _ownerId()); }
          catch (e) {
            throw e;
          }
        } else {
          this.linkAbonentToPremise(id, regnum, startDate, endDate);
        }
      }

      return !!window.saveAbonentsDB && window.saveAbonentsDB();
    },
    deleteAbonent: function (abonentId) {
      if (!this.ensureWriteOrExplain()) return false;
      if (!window.AbonentsDB) return false;
      var id = String(abonentId || "").trim();
      if (!id) return false;
      var reason = arguments.length > 1 ? String(arguments[1] || "").trim() : "";
      var beforeDb = deepClone(window.AbonentsDB);
      if (window.AbonentsDB.abonents && window.AbonentsDB.abonents[id]) {
        var a = window.AbonentsDB.abonents[id];
        var deletedAt = new Date().toISOString();
        var deletedIso = String(deletedAt).slice(0, 10);
        a.status = "deleted";
        a.deleted_at = deletedAt;
        a.deleted_reason = reason || "manual";
        console.warn("[abonent][soft-delete]", { abonentId: id, reason: a.deleted_reason });
        if (Array.isArray(window.AbonentsDB.links)) {
          for (var i = 0; i < window.AbonentsDB.links.length; i++) {
            var l = window.AbonentsDB.links[i];
            if (String(l && l.abonentId || "").trim() !== id) continue;
            var dt = String(l && l.dateTo || "").trim();
            if (dt) continue;
            var df = String(l && l.dateFrom || "").trim();
            if (_isIsoDate(df) && _isoToTs(df) > _isoToTs(deletedIso)) {
              l.dateTo = df;
            } else {
              l.dateTo = deletedIso;
            }
            console.warn("[responsibility][close-on-delete]", { abonentId: id, regnum: l.regnum || "", dateTo: l.dateTo });
          }
        }
        try {
          window.AbonentsDB.links = _normalizeResponsibilityHistory(window.AbonentsDB.links, _ownerId());
          _validateResponsibilityHistoryForDb(window.AbonentsDB.links, window.AbonentsDB, _ownerId());
        } catch (e) {
          window.AbonentsDB = beforeDb;
          throw e;
        }
      }
      var saved = !!window.saveAbonentsDB && window.saveAbonentsDB();
      if (!saved) window.AbonentsDB = beforeDb;
      return saved;
    },
    normalizeResponsibilityHistory: function (history) { return _normalizeResponsibilityHistory(history, _ownerId()); },
    validateResponsibilityHistory: function (history) { return _validateResponsibilityHistoryForDb(history, this.getDb() || null, _ownerId()); },
    getResponsibilityHealth: function () {
      var db = this.getDb() || {};
      var ok = !db._responsibilityInvalid;
      return {
        ok: !!ok,
        code: ok ? "" : String(db._responsibilityInvalidCode || "RESPONSIBILITY_INVALID"),
        at: ok ? "" : String(db._responsibilityInvalidAt || "")
      };
    },
    applyResponsibilityChange: function (regnum, abonentId, startDate) {
      if (!window.AbonentsDB) return false;
      return _applyResponsibilityChange(window.AbonentsDB, regnum, abonentId, startDate, _ownerId());
    },
    repairResponsibilityHistorySafe: function () {
      if (!this.ensureWriteOrExplain()) return { ok: false, code: "WRITE_BLOCKED" };
      if (!window.AbonentsDB) return { ok: false, code: "NO_DB" };
      var beforeDb = deepClone(window.AbonentsDB);
      var ownerId = _ownerId();
      try {
        var src = Array.isArray(window.AbonentsDB.links) ? window.AbonentsDB.links : [];
        var out = [];
        var seen = {};
        for (var i = 0; i < src.length; i++) {
          var l = src[i];
          if (!l || typeof l !== "object") continue;
          var reg = String(l.regnum || "").trim();
          var aid = String(l.abonentId || "").trim();
          var df = String(l.dateFrom || "").trim();
          if (!reg || !aid || !df) continue;
          var lo = String(l.ownerId || "").trim();
          if (ownerId && lo && lo !== ownerId) {
            var eOwn = new Error("RESPONSIBILITY_OWNER_MISMATCH");
            eOwn.code = "RESPONSIBILITY_OWNER_MISMATCH";
            throw eOwn;
          }
          var key = reg + "::" + aid + "::" + df;
          if (seen[key]) continue;
          seen[key] = true;
          var ln = Object.assign({}, l);
          if (ownerId && !String(ln.ownerId || "").trim()) ln.ownerId = ownerId;
          out.push(ln);
        }
        window.AbonentsDB.links = _normalizeResponsibilityHistory(out, ownerId);
        _validateResponsibilityHistoryForDb(window.AbonentsDB.links, window.AbonentsDB, ownerId);
        var saved = !!window.saveAbonentsDB && window.saveAbonentsDB();
        if (!saved) {
          window.AbonentsDB = beforeDb;
          return { ok: false, code: "SAVE_FAILED" };
        }
        return { ok: true };
      } catch (e) {
        window.AbonentsDB = beforeDb;
        return { ok: false, code: String((e && e.code) || "RESPONSIBILITY_INVALID") };
      }
    },
    isAbonentActive: function (abonentObj) { return _isActiveAbonent(abonentObj); },
    runResponsibilitySelfCheck: function () {
      var tdb = { links: [] };
      tdb.links.push({ abonentId: "1", regnum: "R1", dateFrom: "2009-01-01", dateTo: "" });
      _applyResponsibilityChange(tdb, "R1", "2", "2015-01-01", _ownerId());
      return tdb.links;
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
    _setRawScoped("tariffs_content_repair_v1", JSON.stringify({
      content: [{ date: "2025-01-01", rate: 10 }],
      repair: [{ date: "2025-01-01", rate: 10 }]
    }));

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
