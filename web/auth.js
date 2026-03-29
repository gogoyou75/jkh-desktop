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

  function safeJsonParse(s, fallback) {
    try { return JSON.parse(s); } catch (e) { return fallback; }
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
    console.info("[auth] login userId=%s email=%s", String(data.user && data.user.id || ""), String(data.user && data.user.email || ""));

    if (!window.JKHRemoteSync || typeof window.JKHRemoteSync.autoLoadAfterLogin !== "function") {
      window.JKH_DATA_READY = false;
      throw new Error("AUTOLOAD_REQUIRED");
    }
    var loaded = await window.JKHRemoteSync.autoLoadAfterLogin();
    if (!loaded) {
      window.JKH_DATA_READY = false;
      throw new Error("AUTOLOAD_REQUIRED");
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
    console.info("[auth] register userId=%s email=%s role=%s", String(data.user && data.user.id || ""), String(data.user && data.user.email || ""), String(data.user && data.user.role || ""));

    if (!window.JKHRemoteSync || typeof window.JKHRemoteSync.autoLoadAfterLogin !== "function") {
      window.JKH_DATA_READY = false;
      throw new Error("AUTOLOAD_REQUIRED");
    }
    var loaded = await window.JKHRemoteSync.autoLoadAfterLogin();
    if (!loaded) {
      window.JKH_DATA_READY = false;
      throw new Error("AUTOLOAD_REQUIRED");
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
    patchGuestDialogsForLoggedIn();
    renderAuthStatus();
    protectPages();

    syncSessionFromServer(false).then(function () {
      var u = getCurrentUser();
      if (u) console.info("[auth] init session userId=%s email=%s", String(u.id || ""), String(u.email || ""));
      renderAuthStatus();
      protectPages();
      try {
        if (window.JKHRemoteSync && typeof window.JKHRemoteSync.autoLoadAfterLogin === "function") {
          window.JKHRemoteSync.autoLoadAfterLogin().then(function(ok){ if (!ok) window.JKH_DATA_READY = false; }).catch(function () { window.JKH_DATA_READY = false; });
        } else {
          window.JKH_DATA_READY = false;
        }
      } catch (e) {}
    }).catch(function () {
      clearSessionCache();
      renderAuthStatus();
    });
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

    syncSessionFromServer: syncSessionFromServer
  };

  // Автозапуск
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
