(function () {
  "use strict";

  var K_SESS = "auth_session_v1";
  var K_LAST_EMAIL = "auth_last_email_v1";
  var ADMIN_VIEW_SCOPE_KEY = "jkh_admin_view_scope_v1";
  var K_MASTER_PENDING = "auth_master_key_pending_v1";

  // ============================================================
  // CRITICAL FIX (2026-03-21)
  // Источник истины по авторизации = серверная session-cookie + /api/auth/me
  // localStorage = только кэш для UI.
  //
  // ВАЖНО:
  // - первый admin уже существует на сервере;
  // - поэтому authEnabled()/usersCount() больше НЕ зависят от localStorage,
  //   чтобы второй компьютер не думал "пользователей нет, надо регистрировать заново".
  // ============================================================

  var _sessionReady = false;
  var _syncPromise = null;
  var _initStarted = false;
  var _initPromise = null;

  function _getAutoLoadGate() {
    if (!window.__JKH_LOGIN_AUTOLOAD_GATE) {
      window.__JKH_LOGIN_AUTOLOAD_GATE = {
        inFlight: null,
        doneForUserId: "",
        done: false,
        failed: false,
        lastResult: null
      };
    }
    return window.__JKH_LOGIN_AUTOLOAD_GATE;
  }

  function _resetAutoLoadGate(userId) {
    var gate = _getAutoLoadGate();
    var uid = String(userId || "");
    if (uid && gate.doneForUserId && gate.doneForUserId !== uid) {
      gate.done = false;
      gate.failed = false;
      gate.lastResult = null;
      gate.inFlight = null;
      gate.doneForUserId = uid;
      return;
    }
    if (!gate.doneForUserId && uid) gate.doneForUserId = uid;
  }

  function _withTimeout(promise, ms) {
    var t = Math.max(1000, parseInt(ms, 10) || 20000);
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error("AUTOLOAD_TIMEOUT_" + t));
      }, t);
      Promise.resolve(promise).then(function (v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      }).catch(function (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  async function runAutoLoadAfterLoginOnce(sourceTag) {
    var tag = String(sourceTag || "unknown");
    if (!window.JKHDataLoader || typeof window.JKHDataLoader.loadFromServer !== "function") {
      console.warn("[auth] JKHDataLoader missing; continue without blocking login");
      return false;
    }

    var user = getCurrentUser();
    var uid = String(user && user.id || "");
    var gate = _getAutoLoadGate();
    _resetAutoLoadGate(uid);

    if (gate.done && gate.doneForUserId === uid) {
      return true;
    }

    if (gate.inFlight) {
      return gate.inFlight;
    }

    gate.inFlight = (async function () {
      console.info("[auth] autoload gate start source=%s userId=%s", tag, uid);
      try {
        _setUIState({
          server: { status: "online", checkedAt: _nowISO(), message: "" },
          data: { status: "loading", source: "server", message: "" }
        });

        var result = await _withTimeout(window.JKHDataLoader.loadFromServer({ reason: "auth_autoload", force: true }), 25000);
        var ok = !!(result && result.ok);
        var status = String(result && result.status || "");

        if (!ok || (status !== "ready" && status !== "empty")) {
          gate.done = false;
          gate.failed = true;
          gate.lastResult = false;
          _setUIState({
            server: { status: String(result && result.serverStatus || "offline"), checkedAt: _nowISO(), message: String(result && result.message || "") },
            data: { status: "error", source: "server", message: String(result && result.message || "Не удалось автоматически загрузить данные") }
          });
          console.warn("[auth] autoload failed but login allowed source=%s userId=%s", tag, uid);
          return false;
        }

        gate.done = true;
        gate.failed = false;
        gate.lastResult = true;
        gate.doneForUserId = uid;
        _setUIState({
          server: { status: "online", checkedAt: _nowISO(), message: "" },
          data: { status: status, loadedAt: String(result && result.loadedAt || _nowISO()), source: "server", message: "" }
        });
        console.info("[auth] autoload gate done source=%s userId=%s status=%s", tag, uid, status);
        return true;
      } catch (e) {
        gate.done = false;
        gate.failed = true;
        gate.lastResult = false;
        _setUIState({
          server: { status: "offline", checkedAt: _nowISO(), message: String(e && e.message ? e.message : e || "") },
          data: { status: "error", source: "server", message: String(e && e.message ? e.message : e || "") }
        });
        console.warn("[auth] autoload exception but login allowed source=%s userId=%s:", tag, uid, e);
        return false;
      } finally {
        gate.inFlight = null;
      }
    })();

    return gate.inFlight;
  }


  function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

function _nowISO() {
  return new Date().toISOString();
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

function _setUIState(patch) {
  patch = patch || {};
  var st = _ensureUIState();
  if (patch.auth && typeof patch.auth === "object") {
    st.auth = Object.assign({}, st.auth, patch.auth);
  }
  if (patch.server && typeof patch.server === "object") {
    st.server = Object.assign({}, st.server, patch.server);
  }
  if (patch.data && typeof patch.data === "object") {
    st.data = Object.assign({}, st.data, patch.data);
  }
  _emitUIStateChanged(st);
  return st;
}

function _userToAuthState(user) {
  var role = (user && user.role === "admin") ? "admin" : "user";
  return {
    status: role,
    userId: (user && user.id) ? user.id : null,
    email: (user && user.email) ? String(user.email) : "",
    role: role
  };
}

function _guestAuthState() {
  return {
    status: "guest",
    userId: null,
    email: "",
    role: "guest"
  };
}

function _isUnauthorizedError(err) {
  var msg = String(err && err.message ? err.message : err || "");
  return msg === "HTTP_401" || msg === "unauthorized";
}

  function safeJsonStringify(v) {
    try { return JSON.stringify(v); } catch (e) { return ""; }
  }

  function normalizeEmail(email) {
    return String(email || "").trim().toLowerCase();
  }

  function getCachedSession() {
    return safeJsonParse(localStorage.getItem(K_SESS) || "null", null);
  }

  function cacheSessionUser(user) {
    if (!user || !user.id) {
      localStorage.removeItem(K_SESS);
      return;
    }
    localStorage.setItem(K_SESS, safeJsonStringify({
      userId: user.id,
      role: user.role || "user",
      email: user.email || "",
      displayName: user.displayName || "",
      disabled: !!user.disabled,
      createdAt: Date.now(),
      expiresAt: 0
    }));
  }

  function clearSessionCache() {
    localStorage.removeItem(K_SESS);
  }

  function getCurrentUser() {
    var s = getCachedSession();
    if (!s || !s.userId) return null;

    return {
      id: s.userId,
      email: s.email || "",
      role: s.role || "user",
      displayName: s.displayName || "",
      disabled: !!s.disabled,
      createdAt: s.createdAt || 0
    };
  }

  function setLastEmail(email) {
    try { localStorage.setItem(K_LAST_EMAIL, normalizeEmail(email)); } catch (e) {}
  }

  function getLastEmail() {
    try { return localStorage.getItem(K_LAST_EMAIL) || ""; } catch (e) { return ""; }
  }

  async function api(path, options) {
    options = options || {};
    var headers = options.headers || {};

    if (!(options.body instanceof FormData) && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    var res = await fetch(path, Object.assign({
      credentials: "same-origin",
      headers: headers
    }, options));

    var txt = await res.text();
    var data = {};

    try {
      data = txt ? JSON.parse(txt) : {};
    } catch (e) {
      data = { ok: false, error: "invalid_json", raw: txt };
    }

    if (!res.ok || data.ok === false) {
      throw new Error(data.error || ("HTTP_" + res.status));
    }

    return data;
  }

  async function fetchMe() {
    var data = await api("/api/auth/me", { method: "GET" });
    cacheSessionUser(data.user);
    return data.user;
  }

  async function syncSessionFromServer(force) {
    if (!force && _syncPromise) return _syncPromise;

    _syncPromise = (async function () {
      try {
        var user = await fetchMe();
        _sessionReady = true;
        return user;
      } catch (e) {
        clearSessionCache();
        _sessionReady = true;
        throw e;
      } finally {
        _syncPromise = null;
      }
    })();

    return _syncPromise;
  }

  function isLoggedIn() {
    return !!getCurrentUser();
  }

  function isGuest() {
    return !getCurrentUser();
  }

  // ============================================================
  // CRITICAL FIX:
  // Старый код определял "есть ли пользователи" по localStorage текущего ПК.
  // Из-за этого на втором компьютере система могла думать, что пользователей нет,
  // и снова показывать сценарий первой регистрации.
  //
  // Сейчас:
  // - если backend уже подключён, считаем авторизацию включённой всегда;
  // - usersCount() возвращает 1 как флаг "система уже инициализирована".
  //
  // Это правильное поведение для твоей текущей системы, где первый admin уже создан.
  // ============================================================
  function usersCount() {
    return 1;
  }

  function authEnabled() {
    return true;
  }

  function getAdminViewScope() {
    var u = getCurrentUser();
    if (!u || u.role !== "admin") return null;

    try {
      return localStorage.getItem(ADMIN_VIEW_SCOPE_KEY) || u.id;
    } catch (e) {
      return u.id;
    }
  }

  function setAdminViewScope(scope) {
    var u = getCurrentUser();
    if (!u || u.role !== "admin") return false;

    try {
      localStorage.setItem(ADMIN_VIEW_SCOPE_KEY, scope || u.id);
      return true;
    } catch (e) {
      return false;
    }
  }

  function getActiveDbOwnerId() {
    var u = getCurrentUser();
    if (!u) return "guest";
    if (u.role === "admin") return getAdminViewScope() || u.id;
    return u.id;
  }

  function renderAuthStatus() {
    var authBox = document.getElementById("authBox");
    if (!authBox) return;

    var u = getCurrentUser();
    if (!u) {
      authBox.innerHTML =
        '<a href="login.html" style="color:blue; text-decoration:underline; margin-right:10px;">регистрация</a>' +
        '<a href="login.html" style="color:blue; text-decoration:underline;">вход</a>';
      return;
    }

    var links = "";
    if (u.role === "admin") {
      links =
        '<a href="admin.html" style="color:blue;text-decoration:underline;font-size:12px;">админка</a>' +
        '<span style="margin:0 6px;">|</span>' +
        '<a href="user_panel.html#statusBox" style="color:blue;text-decoration:underline;font-size:12px;">резервные копии</a>' +
        '<span style="margin:0 6px;">|</span>';
    } else {
      links =
        '<a href="user_panel.html#statusBox" style="color:blue;text-decoration:underline;font-size:12px;">резервные копии</a>' +
        '<span style="margin:0 6px;">|</span>';
    }

    var scopeHtml = "";
    var scopeLabelHtml = "";

    if (u.role === "admin") {
      var scope = getAdminViewScope() || u.id;

      scopeLabelHtml =
        '<span style="font-size:12px;">База: <b>' +
        (scope === "ALL" ? "все базы (только просмотр)" : (scope === u.id ? "админа" : "юзера")) +
        "</b></span>";

      scopeHtml = '<select id="adminDbScopeSelect" style="font-size:12px; padding:2px 6px; border:1px solid black;"></select>';

      setTimeout(function () {
        var sel = document.getElementById("adminDbScopeSelect");
        if (!sel) return;

        Auth.adminListUsers().then(function (list) {
          var opts = [
            '<option value="' + u.id + '">база админа</option>',
            '<option value="ALL">все базы</option>'
          ];

          for (var i = 0; i < list.length; i++) {
            var uu = list[i] || {};
            if (!uu.id || uu.id === u.id) continue;
            opts.push('<option value="' + uu.id + '">юзер: ' + (uu.email || uu.id) + '</option>');
          }

          sel.innerHTML = opts.join("");
          sel.value = scope;
          sel.onchange = function () {
            if (Auth.setAdminViewScope(this.value)) location.reload();
          };
        }).catch(function () {});
      }, 0);
    }

    authBox.innerHTML =
      '<div style="display:flex; align-items:center; gap:8px;">' +
      links +
      '<span style="font-size:12px;">' + (u.email || "") + "</span>" +
      scopeLabelHtml +
      scopeHtml +
      '<button onclick="Auth.logoutAndRedirect()" style="font-size:12px; padding:2px 8px; border:1px solid black; background:white; cursor:pointer;">выйти</button>' +
      "</div>";
  }

  function protectPages() {
    var path = window.location.pathname || "";
    var protectedNames = ["admin.html", "import_xls.html", "tariffs.html", "requisites.html", "user_panel.html"];
    var isProtected = false;

    for (var i = 0; i < protectedNames.length; i++) {
      if (path.indexOf(protectedNames[i]) !== -1) {
        isProtected = true;
        break;
      }
    }
    if (!isProtected) return;

    var user = getCurrentUser();
    if (!user) {
      syncSessionFromServer(false).then(function () {
        renderAuthStatus();
        var u2 = getCurrentUser();
        if (path.indexOf("admin.html") !== -1 && u2 && u2.role !== "admin") {
          alert("Недостаточно прав для доступа к этой странице");
          window.location.href = "index.html";
        }
      }).catch(function () {
        window.location.href = "login.html?redirect=" + encodeURIComponent(window.location.pathname.split("/").pop() || "index.html");
      });
      return;
    }

    if (path.indexOf("admin.html") !== -1 && user.role !== "admin") {
      alert("Недостаточно прав для доступа к этой странице");
      window.location.href = "index.html";
    }
  }

  function patchGuestDialogsForLoggedIn() {
    try {
      if (window.__JKH_GUEST_DIALOGS_PATCHED) return;
      window.__JKH_GUEST_DIALOGS_PATCHED = true;

      var origConfirm = window.confirm;
      window.confirm = function (msg) {
        try {
          var u = getCurrentUser();
          if (
            u &&
            typeof msg === "string" &&
            (msg.indexOf("Гость: только просмотр") !== -1 || msg.indexOf("Войдите, чтобы сохранять") !== -1)
          ) {
            return true;
          }
        } catch (e) {}
        return origConfirm.apply(window, arguments);
      };

      var origAlert = window.alert;
      window.alert = function (msg) {
        try {
          var u2 = getCurrentUser();
          if (
            u2 &&
            typeof msg === "string" &&
            (msg.indexOf("Гость: только просмотр") !== -1 || msg.indexOf("Войдите, чтобы сохранять") !== -1)
          ) {
            return;
          }
        } catch (e) {}
        return origAlert.apply(window, arguments);
      };
    } catch (e) {}
  }

  async function loginByPassword(email, password) {
    setLastEmail(email);

    var data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: normalizeEmail(email),
        password: String(password || "")
      })
    });

    cacheSessionUser(data.user);
    _sessionReady = true;
    _setUIState({
      auth: _userToAuthState(data.user),
      server: { status: "online", checkedAt: _nowISO(), message: "" },
      data: { status: "loading", source: "server", message: "" }
    });
    console.info("[auth] login userId=%s email=%s", String(data.user && data.user.id || ""), String(data.user && data.user.email || ""));

    try {
      await runAutoLoadAfterLoginOnce("loginByPassword");
    } catch (e) {
      console.warn("[auth] login autoload ignored:", e);
    }

    renderAuthStatus();
    protectPages();

    return data.user;
  }

  async function registerUser(email, password, name) {
    setLastEmail(email);

    var data = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: normalizeEmail(email),
        password: String(password || ""),
        displayName: String(name || "")
      })
    });

    cacheSessionUser(data.user);
    _sessionReady = true;
    _setUIState({
      auth: _userToAuthState(data.user),
      server: { status: "online", checkedAt: _nowISO(), message: "" },
      data: { status: "loading", source: "server", message: "" }
    });
    console.info("[auth] register userId=%s email=%s role=%s", String(data.user && data.user.id || ""), String(data.user && data.user.email || ""), String(data.user && data.user.role || ""));

    try {
      await runAutoLoadAfterLoginOnce("registerUser");
    } catch (e) {
      console.warn("[auth] register autoload ignored:", e);
    }

    renderAuthStatus();
    protectPages();

    return { user: data.user, secrets: null };
  }

  async function registerFirstAdmin(email, password, name) {
    // Оставляем совместимость со старым UI.
    // Но фактически это обычная серверная регистрация.
    return registerUser(email, password, name);
  }

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch (e) {}

    clearSessionCache();
    _sessionReady = true;
    try {
      var gate = _getAutoLoadGate();
      gate.inFlight = null;
      gate.done = false;
      gate.failed = false;
      gate.lastResult = null;
      gate.doneForUserId = "";
    } catch (e2) {}
    _setUIState({
      auth: _guestAuthState(),
      server: { status: "unauthorized", checkedAt: _nowISO(), message: "" },
      data: { status: "idle", source: "none", message: "" }
    });
    renderAuthStatus();
  }

  function logoutAndRedirect() {
    logout().finally(function () {
      var p = window.location.pathname || "";
      if (p.indexOf("admin.html") !== -1 || p.indexOf("user_panel.html") !== -1) {
        window.location.href = "index.html";
      } else {
        window.location.reload();
      }
    });
  }

  function requireRole(role) {
    var u = getCurrentUser();
    if (!u) throw new Error("Не выполнен вход");
    if (role && u.role !== role) throw new Error("Недостаточно прав");
    return u;
  }

  async function getSessionUser() {
    var cached = getCurrentUser();
    if (cached) return cached;
    return syncSessionFromServer(false);
  }

  async function ensureSessionValid() {
    return getSessionUser();
  }

  async function adminListUsers() {
    var data = await api("/api/admin/users", { method: "GET" });
    return data.users || [];
  }

  async function adminCreateUser(payload) {
    payload = payload || {};

    var data = await api("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        email: normalizeEmail(payload.email),
        password: String(payload.password || ""),
        displayName: String(payload.displayName || ""),
        role: String(payload.role || "user")
      })
    });

    return data.user;
  }

  async function adminSetDisabled(userId, disabled) {
    var data = await api("/api/admin/users/" + encodeURIComponent(userId) + "/disable", {
      method: "POST",
      body: JSON.stringify({ disabled: !!disabled })
    });

    var cur = getCurrentUser();
    if (cur && cur.id === userId && !!disabled) {
      clearSessionCache();
    }

    return data.user;
  }

  async function adminResetPassword(userId, newPass) {
    await api("/api/admin/users/" + encodeURIComponent(userId) + "/password", {
      method: "POST",
      body: JSON.stringify({ password: String(newPass || "") })
    });
    return true;
  }

  async function adminDeleteUser(userId) {
    await api("/api/admin/users/" + encodeURIComponent(userId), { method: "DELETE" });
    return true;
  }

  function adminRotateMasterKey() {
    var key = "MK-" + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
    try { localStorage.setItem(K_MASTER_PENDING, key); } catch (e) {}
    return Promise.resolve(true);
  }

  function popMasterKeyOnce() {
    var key = "";
    try {
      key = localStorage.getItem(K_MASTER_PENDING) || "";
      if (key) localStorage.removeItem(K_MASTER_PENDING);
    } catch (e) {}
    return key;
  }

  function exportProjectStorageSnapshot() {
    requireRole("admin");

    var snap = {
      _meta: { format: "papajkh_localstorage_snapshot_v1", createdAt: Date.now() },
      keys: {}
    };

    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k === K_MASTER_PENDING) continue;
      snap.keys[k] = localStorage.getItem(k);
    }

    return snap;
  }

  function importProjectStorageSnapshot(obj) {
    requireRole("admin");

    if (!obj || !obj.keys || typeof obj.keys !== "object") {
      throw new Error("Неверный формат резервной копии");
    }

    localStorage.clear();

    for (var k in obj.keys) {
      if (Object.prototype.hasOwnProperty.call(obj.keys, k)) {
        localStorage.setItem(k, obj.keys[k]);
      }
    }

    return true;
  }

  function readBootstrapSecretsOnce() {
    return null;
  }

  function init() {
  if (_initStarted) return _initPromise;
  _initStarted = true;

  _initPromise = (async function () {
    patchGuestDialogsForLoggedIn();
    renderAuthStatus();
    protectPages();

    try {
      await syncSessionFromServer(false);
      var u = getCurrentUser();

      // ✅ Гость: это нормальное состояние, не ошибка
      if (!u) {
        _setUIState({
          auth: _guestAuthState(),
          server: { status: "unauthorized", checkedAt: _nowISO(), message: "" },
          data: { status: "idle", source: "none", message: "" }
        });
        renderAuthStatus();
        protectPages();
        return true;
      }

      _setUIState({
        auth: _userToAuthState(u),
        server: { status: "online", checkedAt: _nowISO(), message: "" },
        data: { status: "loading", source: "server", message: "" }
      });

      console.info("[auth] init session userId=%s email=%s", String(u.id || ""), String(u.email || ""));
      var loaded = await runAutoLoadAfterLoginOnce("Auth.init");

      if (loaded) {
        var st = _ensureUIState();
        _setUIState({
          auth: _userToAuthState(u),
          server: { status: "online", checkedAt: _nowISO(), message: "" },
          data: {
            status: (st.data.status === "empty" ? "empty" : "ready"),
            loadedAt: st.data.loadedAt || "",
            source: "server",
            message: ""
          }
        });
      } else {
        _setUIState({
          auth: _userToAuthState(u),
          server: { status: "online", checkedAt: _nowISO(), message: "" },
          data: { status: "error", source: "server", message: "Не удалось автоматически загрузить данные" }
        });
      }

      renderAuthStatus();
      protectPages();
      return true;

    } catch (e) {
      // ✅ 401 для гостя — не ошибка приложения
      clearSessionCache();
      if (_isUnauthorizedError(e)) {
        _setUIState({
          auth: _guestAuthState(),
          server: { status: "unauthorized", checkedAt: _nowISO(), message: "" },
          data: { status: "idle", source: "none", message: "" }
        });
      } else {
        _setUIState({
          auth: _guestAuthState(),
          server: { status: "offline", checkedAt: _nowISO(), message: String(e && e.message ? e.message : e || "") },
          data: { status: "idle", source: "none", message: "" }
        });
      }
      renderAuthStatus();
      protectPages();
      return true;
    }
  })();

  return _initPromise;
}

  window.Auth = {
    isAuthEnabled: authEnabled,
    authEnabled: authEnabled,
    isLoggedIn: isLoggedIn,
    usersCount: usersCount,

    getCurrentUser: getCurrentUser,
    getSessionUser: getSessionUser,
    ensureSessionValid: ensureSessionValid,
    logout: logout,
    logoutAndRedirect: logoutAndRedirect,
    requireRole: requireRole,
    readBootstrapSecretsOnce: readBootstrapSecretsOnce,

    init: init,
    renderAuthStatus: renderAuthStatus,
    protectPages: protectPages,

    loginByPassword: loginByPassword,
    registerFirstAdmin: registerFirstAdmin,
    registerUser: registerUser,
    signIn: loginByPassword,

    adminListUsers: adminListUsers,
    adminCreateUser: adminCreateUser,
    adminSetDisabled: adminSetDisabled,
    adminResetPassword: adminResetPassword,
    adminDeleteUser: adminDeleteUser,
    adminRotateMasterKey: adminRotateMasterKey,
    popMasterKeyOnce: popMasterKeyOnce,

    isGuest: isGuest,
    getAdminViewScope: getAdminViewScope,
    setAdminViewScope: setAdminViewScope,
    getActiveDbOwnerId: getActiveDbOwnerId,

    exportProjectStorageSnapshot: exportProjectStorageSnapshot,
    importProjectStorageSnapshot: importProjectStorageSnapshot,

    setLastEmail: setLastEmail,
    getLastEmail: getLastEmail,

    syncSessionFromServer: syncSessionFromServer,
    runAutoLoadAfterLoginOnce: runAutoLoadAfterLoginOnce
  };

  // Автозапуск
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
