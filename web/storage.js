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

  // ---- API calls ----
  async function _apiGet(url) {
    var r = await fetch(url, { method: "GET", credentials: "same-origin" });
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
      credentials: "same-origin"
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
      var res = await _apiGet("/api/store_keys?owner=" + encodeURIComponent(_ownerId() || "guest"));
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
    var sig = (scope === "all") ? _sigForALL(ownerId) : _sigForDB(ownerId);
    var lastSig = _lsGet(_getLastSigKey(scope), "");
    if (onlyIfChanged && lastSig && sig === lastSig) {
      _setStatus({ lastAction: "Изменений нет — сохранение пропущено", lastError: null });
      return true;
    }

    try {
      if (scope === "all") {
        // грузим все scoped keys этого ownerId как отдельные записи
        var scopedKeys = window.JKHStore.keysForOwner(ownerId) || [];
        var pref = window.JKHStore.scopePrefixFor(ownerId) || "";
        scopedKeys.sort();
        for (var i = 0; i < scopedKeys.length; i++) {
          var sk = scopedKeys[i];
          var baseKey = sk.indexOf(pref) === 0 ? sk.slice(pref.length) : sk;
          var raw = window.JKHStore.getRaw(baseKey, ownerId) || "";
          var resSet = await _apiPost("/api/store", { owner: ownerId, key: baseKey, value: raw });
          if (!(resSet.okHttp && resSet.data && resSet.data.ok === true)) {
            _setStatus({ lastAction: "Ошибка сохранения (all)", lastError: (resSet.data && resSet.data.error) ? resSet.data.error : ("HTTP " + resSet.status) });
            return false;
          }
        }
      } else {
        // db-only
        var KEY_DB = "abonents_db_v1";
        var rawDb = window.JKHStore.getRaw(KEY_DB, ownerId) || "";
        var res = await _apiPost("/api/store", { owner: ownerId, key: KEY_DB, value: rawDb });
        if (!(res.okHttp && res.data && res.data.ok === true)) {
          _setStatus({ lastAction: "Ошибка сохранения (db)", lastError: (res.data && res.data.error) ? res.data.error : ("HTTP " + res.status) });
          return false;
        }
      }

      _lsSet(_getLastSigKey(scope), sig);
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
      if (scope === "all") {
        var resKeys = await _apiGet("/api/store_keys?owner=" + encodeURIComponent(ownerId));
        if (!(resKeys.okHttp && resKeys.data && resKeys.data.ok === true)) {
          _setStatus({ lastAction: "Ошибка чтения ключей", lastError: (resKeys.data && resKeys.data.error) ? resKeys.data.error : ("HTTP " + resKeys.status) });
          return false;
        }
        var keys = resKeys.data.keys || [];
        for (var i = 0; i < keys.length; i++) {
          var baseKey = keys[i];
          var resGet = await _apiGet("/api/store?owner=" + encodeURIComponent(ownerId) + "&key=" + encodeURIComponent(baseKey));
          if (!(resGet.okHttp && resGet.data && resGet.data.ok === true)) {
            _setStatus({ lastAction: "Ошибка загрузки ключа " + baseKey, lastError: (resGet.data && resGet.data.error) ? resGet.data.error : ("HTTP " + resGet.status) });
            return false;
          }
          window.JKHStore.setRaw(baseKey, resGet.data.value || "", ownerId);
        }
      } else {
        var KEY_DB = "abonents_db_v1";
        var resDb = await _apiGet("/api/store?owner=" + encodeURIComponent(ownerId) + "&key=" + encodeURIComponent(KEY_DB));
        if (!(resDb.okHttp && resDb.data && resDb.data.ok === true)) {
          _setStatus({ lastAction: "Ошибка загрузки базы", lastError: (resDb.data && resDb.data.error) ? resDb.data.error : ("HTTP " + resDb.status) });
          return false;
        }
        window.JKHStore.setRaw(KEY_DB, resDb.data.value || "", ownerId);
      }

      // пересчёт сигнатуры после загрузки
      var sig = (scope === "all") ? _sigForALL(ownerId) : _sigForDB(ownerId);
      _lsSet(_getLastSigKey(scope), sig);

      _setStatus({ lastAction: "✅ Загружено с сервера", lastError: null });
      try { location.reload(); } catch (e) { }
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
    refreshStatusUI: refreshStatusUI
  };
})();
