# 🧪 REGRESSION_TEST v1.6 CANON

Канонический набор регрессионных тестов проекта **ПАПАЖКХ (JKH)**.  
Объединяет:
- финансово-юридическую логику (v1.5.2),
- роли,
- разделение баз,
- UI-регрессии.

❗ Провал любого пункта с пометкой **CRITICAL** =  
**версия запрещена к релизу / передаче / использованию в суде**.

---

## 0. Канон проекта (не обсуждается)

- Guest — только просмотр
- User — работа **только со своей базой**
- Admin — отдельная база + управление
- Режим «Все базы» — только просмотр
- Данные разных баз **никогда не пересекаются**
- Импортированные данные неизменяемы вручную
- ES-modules запрещены (поддержка file://)

---

## 1. Новый абонент — нулевой старт (CRITICAL)

1) Создать абонента с `calcStartDate = 01.01.2025`  
2) Открыть месяцы до января 2025

**Ожидание:**
- начисления = 0  
- оплаты = 0  
- задолженность = 0  
- пеня = 0  

## 1.1. Canonical ledger: empty-overwrite server guard (CRITICAL)

1) Для отсутствующего `payments_<uid>` отправить `[]` через разрешённый write-path.
2) Для существующего `[]` повторить запись `[]`.
3) Для существующего непустого ledger попытаться отправить `[]` generic sync и `PAYMENT_TABLE_WRITE`.
4) Выполнить обычный Full Recalc с непустыми `proposedRows`.
5) Проверить доказанный final-empty Full Recalc: `completed:true`, `finalLedgerEmpty:true`, exact UID и active recalc-lock token.

**Ожидание:**
- пп. 1–2: success;
- п. 3: HTTP `409`, `PAYMENT_LEDGER_EMPTY_OVERWRITE_BLOCKED`, серверный ledger не изменён;
- п. 4: запись непустого ledger работает как раньше;
- п. 5: `[]` разрешён только с полным verified contract;
- passive snapshot restore и временный period не пишут ledger.

### LAB result — abonent 1009 (2026-07-17)

Manual verification after deployment of `de6468b` passed: the card displayed calculated data, Full Recalc restored the canonical ledger, derived snapshot/summary remained usable, `spravka_sud` populated its table and calculated amounts, and return to the card worked. No explicit regression was observed in this scenario. This result is LAB-only and does not authorize PROD deployment.

---

## 2. Импорт Excel — блокировка оплат (CRITICAL)

1) Импортировать Excel с оплатами  
2) Открыть карточку абонента

**Ожидание:**
- строки помечены 📥  
- сумма / дата / источник не редактируются  
- кнопка удаления отсутствует  

---

## 3. Ledger в одном месяце (CRITICAL)

1) В одном месяце:
- 1 начисление  
- ≥2 оплат  

**Ожидание:**
- несколько строк в месяце — допустимо  
- долг месяца = `accrued − sum(paid)`  

---

## 4. «Оплата за период» влияет только на пеню (CRITICAL)

1) На ручной оплате включить «за период»  
2) Задать период

**Ожидание:**
- основной долг не меняется  
- дата оплаты не меняется  
- меняется только логика пени  

---

## 5. Anti-retro (CRITICAL)

1) Фактическая дата оплаты = январь 2026  
2) «За период» = август 2025  

**Ожидание:**
- пеня считается по фактической дате  
- деньги не «телепортируются» в прошлое  

---

## 6. Исключённые периоды (CRITICAL)

1) Включить исключённый период

**Ожидание:**
- основной долг не меняется  
- пеня за исключённые даты = 0  

---

## 7. Карточка ↔ Справка для суда (CRITICAL)

1) Сформировать справку за тот же период

**Ожидание:**
- долг совпадает  
- пеня совпадает  
- расчёт помесячный, без накоплений  

---

## 8. ES-modules запрещены (CRITICAL)

Открыть проект через `file://`

**Ожидание:**
- нет `type="module"`  
- нет CORS / Import ошибок  

---

# 🔐 ADDENDUM A — Роли и базы (CRITICAL)

## A1. Admin → User (изоляция)

- Admin создал квартиру  
- User её **не видит**

## A2. User → Admin (изоляция)

- User создал квартиру  
- Admin её **не видит**

## A3. new_abonent.html — список квартир

- список **не пуст**
- только текущая база
- привязка сохраняется

## A4. Запрет guest-сообщений

Проверить:
- reports.html  
- requisites.html  
- import_xls.html  
- new_abonent.html  

**Ожидание:**
- ❌ нет alert / toast «Гость…»
- ограничения через disabled / guard

## A5. «Все базы» = read-only

- данные видны  
- сохранения заблокированы  
- ❌ нет записей в storage  

## A6. Импорт → активная база

- данные видны только у текущего пользователя  
- у других — отсутствуют  

## A7. Console-check

- нет `undefined / null`
- нет storage без namespace
- нет auto-миграций

---

## A8. Сервис-слой Data.* для записей (CANON v1.6)

Проверить:
- `new_abonent.html` сохраняет через `Data.upsertAbonent(...)`
- `abonent_card.html` любые изменения абонента/квартиры/связей пишут только через `Data.*`

**Ожидание:**
- после F5 изменения не теряются
- Guest и режим Admin «Все базы» не могут сохранить
- в `?dev=1` нет предупреждений о прямой записи БД в обход Data/storage

---

## ⛔ Блокеры релиза

- протекание данных между базами  
- Guest может сохранить  
- пустой список квартир  
- guest-сообщения  
- импорт не в тот namespace  

✅ Только при полном прохождении всех пунктов версия считается допустимой.
# Browser batch false-fresh regression

- A missing UID with an empty ledger or empty `rowsById` must complete as non-fresh and must not persist `summary_status=fresh` / `summary_reason=OK`.
- Browser batch may persist a fresh summary only after snapshot save and readback validation with the matching canonical UID.
