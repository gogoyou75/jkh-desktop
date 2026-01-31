/* ============================================================
      layout.js — БЕЗ document.write (DOM-вставка)
      Дизайн не меняем
      + кнопки: "сброс базы" и "загрузить демо"
      + auth: offline-first (login.html / admin.html)

      FIX 2026-01-28:
      - Визуальная аномалия поиска: крестик налезал/съезжал
      - Теперь крестик позиционируется ABSOLUTE внутри wrapper
        без отрицательных margin-ов.
   ============================================================ */

// ============================================================
// AUTH BOOTSTRAP (без правок остальных страниц)
// - Если auth.js не подключён напрямую, подгружаем его автоматически.
// - После загрузки auth.js он сам отрисует блок "вход/выход" и поставит защиту страниц.
// ============================================================
function ensureAuthScriptLoaded() {
  try {
    if (window.Auth && typeof window.Auth.init === "function") return;
    if (document.querySelector('script[data-auth="1"]')) return;
    const s = document.createElement("script");
    s.src = "auth.js";
    s.defer = true;
    s.setAttribute("data-auth", "1");
    document.head.appendChild(s);
  } catch { /* ignore */ }
}
ensureAuthScriptLoaded();

function ensureLayoutStyles() {
  if (document.getElementById("layoutStyles")) return;

  const style = document.createElement("style");
  style.id = "layoutStyles";
  style.textContent = `
#mini-menu {
  position: fixed; top: 0; left: 0;
  width: 60px; height: 100vh;
  border-right: 2px solid black;
  background: #fff;
  display: flex; flex-direction: column;
  padding-top: 20px;
  transition: width .25s;
  overflow: hidden;
  z-index: 1100;
}
.menu-item {
  display: flex; align-items: center;
  gap: 12px;
  height: 55px;
  padding-left: 15px;
  cursor: pointer;
  border-bottom: 2px solid black;
  white-space: nowrap;
}
.menu-item .icon { width: 30px; font-size: 22px; text-align: center; }
.menu-item .label { opacity: 0; transition: opacity .15s; font-size: 15px; }
#mini-menu:hover { width: 220px; }
#mini-menu:hover .label { opacity: 1; }

.topbar {
  position: fixed;
  top: 0; left: 60px;
  width: calc(100% - 60px);
  height: 50px;
  border-bottom: 2px solid black;
  background: #fff;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 15px;
  z-index: 900;
  box-sizing: border-box;
}

/* ===== SEARCH (FIXED) ===== */
.search-box { display: flex; align-items: center; gap: 10px; }

/* wrapper — теперь relative, чтобы крестик был внутри и не съезжал */
.search-input-wrapper{
  position: relative;
  display: flex;
  align-items: center;
  border: 1px solid black;
  height: 26px;
  box-sizing: border-box;
  background: #fff;
}

/* input — даём место под крестик справа */
.search-input-wrapper input{
  border: none;
  outline: none;
  height: 100%;
  font-size: 13px;
  padding: 3px 26px 3px 6px; /* справа место под X */
  min-width: 220px;
  box-sizing: border-box;
  background: transparent;
}

/* крестик — absolute справа, без налезаний и margin-left:-... */
.search-clear-btn{
  position: absolute;
  right: 0;
  top: 0;
  width: 24px;
  height: 100%;
  border: none;
  border-left: 1px solid #000;
  background: transparent;
  cursor: pointer;
  font-size: 14px;
  line-height: 24px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.search-clear-btn:hover { background: #eee; }

/* кнопки справа — по высоте совпадают с поиском */
.top-actions .btn-inline {
  border: 1px solid black;
  background: white;
  font-size: 12px;
  height: 26px;
  padding: 0 10px;
  cursor: pointer;
  box-sizing: border-box;
}

.content { margin-left: 60px; padding-top: 60px; }

#globalSearchResults {
  position: fixed;
  top: 50px;
  left: 60px;
  width: 420px;
  max-height: 400px;
  overflow-y: auto;
  background: white;
  border: 2px solid black;
  border-top: none;
  display: none;
  opacity: 0;
  transform: translateY(-10px);
  padding: 5px 8px;
  transition: .2s;
  z-index: 2000;
  box-sizing: border-box;
}
#globalSearchResults.visible {
  display: block;
  opacity: 1;
  transform: translateY(0);
}
.global-result-group {
  margin-bottom: 8px;
  border-bottom: 1px solid #ccc;
  padding-bottom: 5px;
}
.global-result-title {
  font-weight: bold;
  font-size: 13px;
  border-bottom: 1px solid black;
}
.global-result-item {
  border-bottom: 1px dashed #bbb;
  padding: 3px 0;
  cursor: pointer;
  font-size: 13px;
}
.global-result-item:hover { background: #f2f2f2; }
mark { background: yellow; }
  `;
  document.head.appendChild(style);
}

function htmlToElement(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function renderLayout() {
  window.__layoutStartScript = document.currentScript;

  ensureLayoutStyles();
  if (document.getElementById("mini-menu")) return;

  const menu = htmlToElement(`
<div id="mini-menu">
  <div class="menu-item" onclick="location.href='index.html'">
    <span class="icon">🏠</span><span class="label">Главная</span>
  </div>
  <div class="menu-item" onclick="location.href='abonent_card.html'">
    <span class="icon">👤</span><span class="label">Абонент</span>
  </div>
  <div class="menu-item" onclick="location.href='new_abonent.html'">
    <span class="icon">➕</span><span class="label">Абонент +</span>
  </div>
  <div class="menu-item" onclick="location.href='premises.html'">
    <span class="icon">🏘️</span><span class="label">Квартиры</span>
  </div>
  <div class="menu-item" onclick="location.href='import_xls.html'">
    <span class="icon">📄</span><span class="label">Импорт XLS</span>
  </div>
  <div class="menu-item" onclick="location.href='tariffs.html'">
    <span class="icon">💰</span><span class="label">Тарифы</span>
  </div>
  <div class="menu-item" onclick="location.href='requisites.html'">
    <span class="icon">🏢</span><span class="label">Реквизиты</span>
  </div>
  <div class="menu-item" onclick="location.href='refinancing.html'">
    <span class="icon">📈</span><span class="label">Ставки</span>
  </div>
  <div class="menu-item" onclick="location.href='reports.html'">
    <span class="icon">📘</span><span class="label">Справки</span>
  </div>
</div>
  `);

  const topbar = htmlToElement(`
<div class="topbar">
  <div class="search-box">
    <div class="search-input-wrapper">
      <input id="globalSearchInput" type="text" placeholder="поиск">
      <button id="globalSearchClear" class="search-clear-btn" type="button" aria-label="Очистить поиск">✖</button>
    </div>
    <a href="search_extended.html" style="font-size:13px;text-decoration:none;">расширенный</a>
  </div>

  <div class="top-actions">
    <button class="btn-inline" data-action="send" type="button">отправить</button>
    <button class="btn-inline" data-action="print" type="button">распечатать</button>
    <button class="btn-inline" data-action="save" type="button">сохранить</button>

    <button class="btn-inline" data-action="resetdb" type="button" title="Сброс базы (тестовый режим)">сброс базы</button>
    <button class="btn-inline" data-action="loaddemo" type="button" title="Загрузить демо (только тест)">загрузить демо</button>
  </div>

  <div class="login-box" id="authBox" style="font-size:13px;">регистрация / вход</div>
</div>
  `);

  const results = htmlToElement(`<div id="globalSearchResults"></div>`);
  const content = htmlToElement(`<div class="content" id="layoutContent"></div>`);

  const anchor = window.__layoutStartScript || document.body.firstChild;
  document.body.insertBefore(menu, anchor);
  document.body.insertBefore(topbar, anchor);
  document.body.insertBefore(results, anchor);
  document.body.insertBefore(content, anchor);
}

function closeLayout() {
  const endScript = document.currentScript;
  const startScript = window.__layoutStartScript;
  const content = document.getElementById("layoutContent");
  if (!startScript || !endScript || !content) return;

  let node = startScript.nextSibling;
  while (node && node !== endScript) {
    const next = node.nextSibling;

    if (
      node !== content &&
      node !== document.getElementById("mini-menu") &&
      node !== document.querySelector(".topbar") &&
      node !== document.getElementById("globalSearchResults")
    ) {
      content.appendChild(node);
    }
    node = next;
  }
}

// ====== ПОИСК (как было) ======
function highlight(text, q) {
  if (!q) return text;
  return text.replace(new RegExp("(" + q + ")", "gi"), "<mark>$1</mark>");
}

function openAbonent(id) {
  window.location.href = "abonent_card.html?abonent=" + id;
}

function renderSearchResults(data, q) {
  const box = document.getElementById("globalSearchResults");
  if (!box) return;

  if (!q || data.count === 0) {
    box.classList.remove("visible");
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }

  let html = "";
  const groups = [
    ["fio", "Совпадения по ФИО"],
    ["address", "Совпадения по адресу"],
    ["id", "ID абонентов"],
    ["notes", "Примечания абонента"]
  ];

  groups.forEach(([key, title]) => {
    if (data[key].length) {
      html += `<div class="global-result-group">
        <div class="global-result-title">${title}</div>`;
      data[key].forEach(a => {
        html += `<div class="global-result-item" onclick="openAbonent('${a.id}')">
          ${a.line}
        </div>`;
      });
      html += `</div>`;
    }
  });

  box.innerHTML = html;
  box.style.display = "block";
  requestAnimationFrame(() => box.classList.add("visible"));
}

function globalSearch(q) {
  q = (q || "").toLowerCase();
  const db = window.AbonentsDB?.abonents || {};
  const result = { fio: [], address: [], id: [], notes: [], count: 0 };

  for (const id in db) {
    const a = db[id];
    const fio = a.fio?.toLowerCase() || "";
    const adr = `${a.city || ""} ${a.street || ""} ${a.house || ""} ${a.flat || ""}`.toLowerCase();
    const noteRaw = localStorage.getItem("note_" + id) || "";
    const note = noteRaw.toLowerCase();

    if (fio.includes(q)) {
      result.fio.push({ id, line: highlight(a.fio, q) + "<br>" + a.city + ", " + a.street + ", " + a.house + ", кв " + a.flat });
      result.count++;
    }
    if (adr.includes(q)) {
      result.address.push({ id, line: highlight(`${a.city}, ${a.street}, ${a.house}, кв ${a.flat}`, q) + "<br>" + a.fio });
      result.count++;
    }
    if (String(id).includes(q)) {
      result.id.push({ id, line: "ID: " + highlight(String(id), q) + "<br>" + a.fio });
      result.count++;
    }
    if (note.includes(q)) {
      result.notes.push({ id, line: highlight(noteRaw, q) + "<br>" + a.fio });
      result.count++;
    }
  }

  renderSearchResults(result, q);
}

document.addEventListener("DOMContentLoaded", () => {
  // AUTH: инициируем отображение статуса входа и защиту страниц.
  // auth.js может грузиться чуть позже (defer) — подождём коротко.
  (function waitAuthInit(attempt) {
    attempt = attempt || 0;
    if (window.Auth && typeof window.Auth.init === "function") {
      try { window.Auth.init(); } catch { /* ignore */ }
      return;
    }
    if (attempt < 60) setTimeout(() => waitAuthInit(attempt + 1), 50);
  })();

  document.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", () => {
      const a = btn.dataset.action;

      if (a === "print") window.print();
      if (a === "save") alert("Данные сохранены (имитация)");
      if (a === "send") alert("Отправка выполнена (имитация)");

      if (a === "resetdb") {
        if (typeof window.testResetDatabase === "function") window.testResetDatabase();
        else alert("testResetDatabase() не найдена. Проверь data.js");
      }

      if (a === "loaddemo") {
        if (typeof window.testLoadDemoDatabase === "function") window.testLoadDemoDatabase();
        else alert("testLoadDemoDatabase() не найдена. Проверь data.js");
      }
    });
  });

  const input = document.getElementById("globalSearchInput");
  const clear = document.getElementById("globalSearchClear");

  if (input && clear) {
    input.addEventListener("input", () => globalSearch(input.value.trim()));
    input.addEventListener("focus", () => input.value.trim() && globalSearch(input.value.trim()));

    clear.addEventListener("click", () => {
      input.value = "";
      input.focus();
      globalSearch("");
    });

    document.addEventListener("click", e => {
      const box = document.getElementById("globalSearchResults");
      if (!box) return;
      if (!box.contains(e.target) && e.target !== input && e.target !== clear) {
        box.classList.remove("visible");
        box.style.display = "none";
      }
    });
  }
});
