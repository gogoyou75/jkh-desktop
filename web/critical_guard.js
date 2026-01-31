/* 🔒 CRITICAL GUARD (dev-only)
   Purpose: prevent accidental architectural breaks (ES-modules, script order) that can change legal-calculation results.

   Enabled only when:
     - URL has ?dev=1
     - OR hostname is localhost/127.0.0.1

   Dev hard mode (since v01.27.6):
     - logs violations to localStorage
     - auto-saves a PNG snapshot of the WARNING panel (not whole page)
     - stops execution (window.stop + throw Error) to avoid "quiet" wrong numbers
*/
(function () {
  var LS_KEY_LOG = "JKH_CRITICAL_GUARD_LOG";
  var LS_KEY_LAST_SHOT = "JKH_CRITICAL_GUARD_LAST_SHOT_PNG";
  var LS_KEY_LAST_SHOT_META = "JKH_CRITICAL_GUARD_LAST_SHOT_META";

  function isDevMode() {
    try {
      var sp = new URLSearchParams(window.location.search || "");
      if (sp.get("dev") === "1") return true;
      var h = (window.location.hostname || "").toLowerCase();
      return h === "localhost" || h === "127.0.0.1";
    } catch (e) {
      return false;
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
    });
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return ""; }
  }

  function readLog() {
    try {
      var raw = localStorage.getItem(LS_KEY_LOG);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function writeLog(entry) {
    try {
      var arr = readLog();
      arr.push(entry);
      // keep last 50 entries to avoid storage bloat
      if (arr.length > 50) arr = arr.slice(arr.length - 50);
      localStorage.setItem(LS_KEY_LOG, JSON.stringify(arr));
    } catch (e) {}
  }

  function buildWarningHtml(messages) {
    var items = messages.map(function (m) { return "<li>" + esc(m) + "</li>"; }).join("");
    return (
      '<div style="display:flex;gap:12px;align-items:flex-start;">' +
        '<div style="font-weight:700;white-space:nowrap;">CRITICAL GUARD</div>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="opacity:.92;margin-bottom:6px;">Обнаружены потенциально опасные изменения (dev-only). В обычной работе это должно быть исправлено.</div>' +
          '<ul style="margin:0;padding-left:18px;">' + items + "</ul>" +
          '<div style="opacity:.85;margin-top:8px;font-size:12px;">' +
            'Лог: <b>' + esc(LS_KEY_LOG) + '</b> · Скрин: <b>' + esc(LS_KEY_LAST_SHOT_META) + '</b>' +
          "</div>" +
        "</div>" +
        '<div style="display:flex;flex-direction:column;gap:6px;align-items:stretch;"><button id="JKH_CRITICAL_GUARD_OPEN_SHOT" style="background:#fff;color:#b00020;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font-weight:700;">Открыть скриншот</button><button id="JKH_CRITICAL_GUARD_COPY_TEXT" style="background:#fff;color:#b00020;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font-weight:700;">Скопировать текст</button><button id="JKH_CRITICAL_GUARD_CLOSE" style="background:#fff;color:#b00020;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font-weight:700;">OK</button></div>' +
      "</div>"
    );
  }

  function showBanner(messages) {
    if (!messages || !messages.length) return null;
    if (document.getElementById("JKH_CRITICAL_GUARD")) return document.getElementById("JKH_CRITICAL_GUARD");

    var wrap = document.createElement("div");
    wrap.id = "JKH_CRITICAL_GUARD";
    wrap.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:999999;" +
      "background:#b00020;color:#fff;font:14px/1.35 Arial,sans-serif;" +
      "padding:10px 12px;box-shadow:0 2px 10px rgba(0,0,0,.25);" +
      "pointer-events:auto;";

    wrap.innerHTML = buildWarningHtml(messages);

    (document.body || document.documentElement).appendChild(wrap);

    var btn = document.getElementById("JKH_CRITICAL_GUARD_CLOSE");
    if (btn) btn.onclick = function () { wrap.remove(); };


    // Open last screenshot (dataURL PNG) saved to localStorage
    var btnShot = document.getElementById("JKH_CRITICAL_GUARD_OPEN_SHOT");
    if (btnShot) btnShot.onclick = function () {
      try {
        var png = localStorage.getItem(LS_KEY_LAST_SHOT_PNG);
        if (!png) {
          alert("Скрин ещё не записан. Нажмите ещё раз через мгновение.");
          return;
        }
        window.open(png, "_blank");
      } catch (e) {
        try { alert("Не удалось открыть скриншот: " + (e && e.message ? e.message : e)); } catch (_) {}
      }
    };

    // Copy violations text to clipboard (with fallback)
    var btnCopy = document.getElementById("JKH_CRITICAL_GUARD_COPY_TEXT");
    if (btnCopy) btnCopy.onclick = function () {
      var text =
        "CRITICAL GUARD\n" +
        "URL: " + String(window.location.href || "") + "\n" +
        "Time: " + nowIso() + "\n\n" +
        messages.map(function (m, i) { return (i + 1) + ". " + m; }).join("\n") + "\n\n" +
        "Log key: " + LS_KEY_LOG + "\n" +
        "Shot meta key: " + LS_KEY_LAST_SHOT_META + "\n";
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            try { btnCopy.textContent = "Скопировано ✅"; setTimeout(function(){ btnCopy.textContent = "Скопировать текст"; }, 1200); } catch (_) {}
          }, function () {
            throw new Error("clipboard denied");
          });
          return;
        }
      } catch (e) {}

      // Fallback for file:// and restricted clipboard
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.top = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = false;
        try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        if (ok) {
          try { btnCopy.textContent = "Скопировано ✅"; setTimeout(function(){ btnCopy.textContent = "Скопировать текст"; }, 1200); } catch (_) {}
        } else {
          alert("Не удалось скопировать автоматически. Откройте DevTools → Application → LocalStorage и скопируйте из " + LS_KEY_LOG);
        }
      } catch (e) {
        try { alert("Ошибка копирования: " + (e && e.message ? e.message : e)); } catch (_) {}
      }
    };


    return wrap;
  }

  // Auto-screenshot of the WARNING panel using SVG foreignObject (works in modern Chrome/Edge).
  // Saves a PNG dataURL into localStorage (last only) and writes metadata.
  function autoSnapshotPanel(panelEl, messages) {
    try {
      if (!panelEl) return;

      var w = Math.max(640, panelEl.offsetWidth || 640);
      var h = Math.max(120, panelEl.offsetHeight || 120);

      var html = panelEl.outerHTML || "";
      html = html.replace(/id="JKH_CRITICAL_GUARD_CLOSE"/g, 'id="JKH_CRITICAL_GUARD_CLOSE_SNAPSHOT"');

      var svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
          '<foreignObject width="100%" height="100%">' +
            '<div xmlns="http://www.w3.org/1999/xhtml">' + html + "</div>" +
          "</foreignObject>" +
        "</svg>";

      var img = new Image();
      img.onload = function () {
        try {
          var canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          var png = canvas.toDataURL("image/png");

          localStorage.setItem(LS_KEY_LAST_SHOT, png);
          localStorage.setItem(LS_KEY_LAST_SHOT_META, JSON.stringify({
            at: nowIso(),
            page: String(window.location.pathname || ""),
            href: String(window.location.href || ""),
            count: (messages || []).length
          }));
        } catch (e) {}
      };
      img.onerror = function () {};
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    } catch (e) {}
  }

  function hardStop(messages) {
    try { window.stop && window.stop(); } catch (e) {}
    setTimeout(function () {
      throw new Error("CRITICAL_GUARD: " + (messages || []).join(" | "));
    }, 0);
  }

  function check() {
    var messages = [];

    // 1) ES-modules detection
    var scripts = Array.prototype.slice.call(document.getElementsByTagName("script"));
    var moduleScripts = scripts.filter(function (s) { return (s.type || "").toLowerCase() === "module"; });
    if (moduleScripts.length) {
      messages.push('Найдены <script type="module">. ES-modules запрещены для v1.5.x (риски file:// и порядка загрузки).');
    }

    // 2) Script order checks (calc_engine must be earlier)
    function findIndexBySrc(re) {
      for (var i = 0; i < scripts.length; i++) {
        var src = scripts[i].getAttribute("src") || "";
        if (re.test(src)) return i;
      }
      return -1;
    }

    var iCalc = findIndexBySrc(/(^|\/)calc_engine\.js(\?|$)/);
    var iPay  = findIndexBySrc(/(^|\/)payment_table\.js(\?|$)/);
    var iSud  = findIndexBySrc(/(^|\/)spravka_sud\.js(\?|$)/);

    if (iCalc !== -1 && iPay !== -1 && iCalc > iPay) {
      messages.push("Нарушен порядок подключений: calc_engine.js должен идти ДО payment_table.js.");
    }
    if (iCalc !== -1 && iSud !== -1 && iCalc > iSud) {
      messages.push("Нарушен порядок подключений: calc_engine.js должен идти ДО spravka_sud.js.");
    }

    // 3) Historical pitfall: spravka_sud.html should not load storage.js (ES-module / side-effects)
    var p = (window.location.pathname || "").toLowerCase();
    if (p.indexOf("spravka_sud") !== -1) {
      var iStorage = findIndexBySrc(/(^|\/)storage\.js(\?|$)/);
      if (iStorage !== -1) {
        messages.push("spravka_sud.html не должен подключать storage.js (исторически ломало загрузку/данные).");
      }
    }

    if (messages.length) {
      try { console.error("[CRITICAL_GUARD]", messages); } catch (e) {}

      // Log to localStorage (dev-only)
      writeLog({
        at: nowIso(),
        page: String(window.location.pathname || ""),
        href: String(window.location.href || ""),
        userAgent: String(navigator.userAgent || ""),
        messages: messages.slice(0)
      });

      var panel = showBanner(messages);

      // Auto-screenshot (warning panel only)
      autoSnapshotPanel(panel, messages);

      // Hard stop execution in dev mode (requested)
      hardStop(messages);
    }
  }

  if (!isDevMode()) return;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", check);
  } else {
    check();
  }
})();
