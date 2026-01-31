// Универсальный поиск по структуре AbonentsDB.abonents
// Структура data.js: AbonentsDB.abonents = { "27": { fio:"", city:"", street:"", house:"", flat:"", ... } }

// Подсветка совпадающих фрагментов
function highlight(text, q) {
    if (!q) return text;
    const re = new RegExp("(" + q + ")", "gi");
    return text.replace(re, "<mark>$1</mark>");
}

// Основная функция
function runSearch() {
    const q = document.getElementById("search-input").value.trim().toLowerCase();

    const fioDiv = document.getElementById("result-fio");
    const addrDiv = document.getElementById("result-address");
    const accDiv = document.getElementById("result-account");
    const perDiv = document.getElementById("result-periods");

    // Очистка вывода
    fioDiv.innerHTML = "";
    addrDiv.innerHTML = "";
    accDiv.innerHTML = "";
    perDiv.innerHTML = "";

    if (q.length === 0) return;

    const db = AbonentsDB.abonents;

    for (const id in db) {
        const a = db[id];

        const fio = a.fio.toLowerCase();
        const city = (a.city || "").toLowerCase();
        const street = (a.street || "").toLowerCase();
        const house = (a.house || "").toLowerCase();
        const flat = (a.flat || "").toLowerCase();

        // Примечания храним отдельно в localStorage
        const note = (localStorage.getItem("note_" + id) || "").toLowerCase();

        // -----------------------------
        // 1. ФИО
        // -----------------------------
        if (fio.includes(q)) {
            fioDiv.innerHTML += `
                <div class="record" onclick="openAbonent('${id}')">
                    ${highlight(a.fio, q)}<br>
                    ${a.city}, ${a.street}, ${a.house}, кв. ${a.flat}
                </div>`;
        }

        // -----------------------------
        // 2. Поиск по адресу
        // -----------------------------
        const addrFull = `${city} ${street} ${house} ${flat}`;
        if (addrFull.includes(q)) {
            addrDiv.innerHTML += `
                <div class="record" onclick="openAbonent('${id}')">
                    ${highlight(a.city + ", " + a.street + ", " + a.house + ", кв. " + a.flat, q)}<br>
                    ${a.fio}
                </div>`;
        }

        // -----------------------------
        // 3. Поиск по ID (ЛС можно привязать позже)
        // -----------------------------
        if (id.includes(q)) {
            accDiv.innerHTML += `
                <div class="record" onclick="openAbonent('${id}')">
                    Абонент ID: ${highlight(id, q)}<br>
                    ${a.fio}<br>
                    ${a.city}, ${a.street}, ${a.house}, кв. ${a.flat}
                </div>`;
        }

        // -----------------------------
        // 4. Поиск в примечаниях
        // -----------------------------
        if (note && note.includes(q)) {
            perDiv.innerHTML += `
                <div class="record" onclick="openAbonent('${id}')">
                    Примечание совпало: ${highlight(localStorage.getItem("note_" + id), q)}<br>
                    Абонент: ${a.fio}
                </div>`;
        }
    }
}

// Переход в карточку
function openAbonent(id) {
    window.location.href = `abonent_card.html?abonent=${id}`;
}
