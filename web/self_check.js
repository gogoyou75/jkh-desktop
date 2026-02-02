/* Минимальная самопроверка (без модулей) */
(function () {
  "use strict";

  const resultsEl = document.getElementById("results");
  const btnRun = document.getElementById("btnRun");
  const APP_CTX = window.AppContext;

  function addResult(title, ok, details) {
    const div = document.createElement("div");
    div.className = "result " + (ok ? "ok" : "fail");
    div.innerHTML = `<b>${ok ? "OK" : "FAIL"}:</b> ${title}` +
      (details ? `<div class="muted">${details}</div>` : "");
    resultsEl.appendChild(div);
  }

  function clearResults() {
    resultsEl.innerHTML = "";
  }

  function baseDbWithPremise(regnum) {
    return {
      orgName: 'ТСЖ "Проверка"',
      orgInn: "0000000000",
      chairman: "",
      premises: {
        [regnum]: {
          regnum,
          city: "Тест",
          street: "Проверочная",
          house: "1",
          flat: "1",
          square: 42,
          createdAt: "2000-01-01"
        }
      },
      links: [],
      abonents: {}
    };
  }

  function writeDb(namespace, regnum) {
    const key = APP_CTX.buildKey(namespace, "abonents_db_v1");
    localStorage.setItem(key, JSON.stringify(baseDbWithPremise(regnum)));
  }

  function removeDb(namespace) {
    const key = APP_CTX.buildKey(namespace, "abonents_db_v1");
    localStorage.removeItem(key);
  }

  function loadIframe(src) {
    return new Promise((resolve, reject) => {
      const iframe = document.createElement("iframe");
      iframe.style.width = "1px";
      iframe.style.height = "1px";
      iframe.style.position = "absolute";
      iframe.style.left = "-9999px";
      iframe.src = src;
      iframe.onload = () => resolve(iframe);
      iframe.onerror = () => reject(new Error("iframe load failed: " + src));
      document.body.appendChild(iframe);
    });
  }

  async function testPremisesInNewAbonent(namespace) {
    APP_CTX.setActiveNamespace(namespace);
    const iframe = await loadIframe("new_abonent.html");
    const doc = iframe.contentDocument;
    const sel = doc ? doc.getElementById("premiseSelect") : null;
    const count = sel ? sel.options.length : 0;
    iframe.remove();
    return count > 1;
  }

  async function testReadOnlyAllMode() {
    APP_CTX.setActiveNamespace("all");
    const iframe = await loadIframe("new_abonent.html");
    const doc = iframe.contentDocument;
    const btn = doc ? doc.getElementById("btnCreate") : null;
    const disabled = !!(btn && btn.disabled);
    iframe.remove();
    return disabled;
  }

  async function testGuestMessages(pages) {
    let ok = true;
    for (const p of pages) {
      const iframe = await loadIframe(p);
      const text = iframe.contentDocument ? iframe.contentDocument.body.textContent : "";
      if (text && text.includes("Гость: только просмотр")) ok = false;
      iframe.remove();
    }
    return ok;
  }

  async function run() {
    clearResults();
    if (!APP_CTX) {
      addResult("AppContext недоступен", false, "access.js не загружен.");
      return;
    }

    const originalNs = APP_CTX.getActiveNamespace();
    const originalLast = localStorage.getItem("papajkh_last_active_base_v1");

    const userNs = "user:selfcheck";
    const adminNs = "admin:selfcheck";

    try {
      writeDb(userNs, "REG-USER-1");
      writeDb(adminNs, "REG-ADMIN-1");

      // Test 1: premises list visible in new_abonent
      const listOk = await testPremisesInNewAbonent(userNs);
      addResult("User создаёт квартиру → видна в new_abonent.html", listOk);

      // Test 2: isolation between namespaces
      APP_CTX.setActiveNamespace(userNs);
      const userDbRaw = APP_CTX.storage.getItem("abonents_db_v1");
      APP_CTX.setActiveNamespace(adminNs);
      const adminDbRaw = APP_CTX.storage.getItem("abonents_db_v1");
      const userDb = userDbRaw ? JSON.parse(userDbRaw) : {};
      const adminDb = adminDbRaw ? JSON.parse(adminDbRaw) : {};
      const isoOk = !!(userDb?.premises?.["REG-USER-1"] && !adminDb?.premises?.["REG-USER-1"]);
      addResult("Admin база изолирована от User (и наоборот)", isoOk);

      // Test 3: no guest toast/alert message
      APP_CTX.setActiveNamespace(userNs);
      const guestOk = await testGuestMessages([
        "reports.html",
        "requisites.html",
        "import_xls.html",
        "new_abonent.html"
      ]);
      addResult("На pages reports/requisites/import_xls/new_abonent нет guest-toast", guestOk);

      // Test 4: all bases view-only
      const roOk = await testReadOnlyAllMode();
      addResult("Режим «Все базы» только просмотр (кнопки disabled)", roOk);
    } catch (e) {
      addResult("Ошибка выполнения самопроверки", false, e && e.message ? e.message : String(e));
    } finally {
      removeDb(userNs);
      removeDb(adminNs);
      if (originalNs) {
        APP_CTX.setActiveNamespace(originalNs);
      }
      if (originalLast !== null) {
        localStorage.setItem("papajkh_last_active_base_v1", originalLast);
      }
    }
  }

  btnRun.addEventListener("click", run);
})();
