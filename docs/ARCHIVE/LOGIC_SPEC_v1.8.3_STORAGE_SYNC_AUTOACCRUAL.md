# LOGIC_SPEC_v1.8.3_STORAGE_SYNC_AUTOACCRUAL

Версия: **v1.8.3**  
Дата фиксации: **2026-04-30**  
Статус: **ЖЁСТКИЙ КАНОН ДЛЯ CODEX / РАЗРАБОТЧИКОВ**

---

## 0. Назначение

Этот документ фиксирует изменения, внесённые после стабилизации цепочки:

`server-first load → payments_<ЛС> ledger → autoaccrual → index.html → spravka_sud → upload whitelist`.

Цель документа: не допустить повторного появления уже найденных ошибок:
- пустой индекс после автозагрузки;
- пустая судебная справка при существующем ledger;
- `changed:true` без сохранённого результата;
- падение UI из-за `Data.flushDbToServer()`;
- отправка legacy/admin/global ключей на `/api/store` и 403.

---

## 1. Источник истины данных

### 1.1. Backend — главный источник

Серверная БД является главным источником данных.  
Frontend и `localStorage` используются как runtime-cache и транспортный слой.

### 1.2. UI не должен зависеть от успешности upload

Страницы обязаны строиться из локально доступного owner-scoped кэша после server-first загрузки.

Запрещено:
```js
await Data.flushDbToServer();
// и дальше строить UI только если upload успешен
```

Правильно:
```js
try {
  await Data.flushDbToServer();
} catch (e) {
  console.warn('[module] flush failed but continue', e);
}

// UI строится всё равно
rebuildOrRender();
```

Обязательное правило: ошибка sync/upload не должна оставлять `index.html`, `spravka_sud.js` или карточку абонента пустыми, если данные уже есть локально.

---

## 2. payments_<ЛС> — канонический ledger

### 2.1. Назначение

`payments_<ЛС>` — помесячный ledger абонента. Это не журнал событий, а рабочая таблица начислений/оплат.

В одном месяце допустимы:
- строка начисления;
- одна или несколько строк оплат;
- строки с уточнением оплаты за период.

### 2.2. Минимальная структура строки

Строка ledger должна поддерживать поля:
```js
{
  year: 2025,
  month: 1,
  accrued: 538.00,
  paid: 0,
  paid_date: '',
  id: '...'
}
```

### 2.3. Проверка пригодности ledger

Ledger считается пригодным для пропуска autoaccrual только если есть хотя бы одна строка с:

```js
Number(row.accrued) > 0
```

Важно:
- `paid > 0` без `accrued > 0` НЕ считается полноценным ledger;
- импорт платежей может создать оплаты без начислений;
- в этом случае autoaccrual обязан восстановить начисления.

---

## 3. Autoaccrual

### 3.1. Назначение

`autoaccrual_engine.js` создаёт/восстанавливает начисления в `payments_<ЛС>`.

### 3.2. Обязательное owner-scoped сохранение

`JKHAutoAccrual.recalcForAbonent(ls)` обязан читать и писать ledger в одном owner-scope:

```js
const ownerId = JKHStore.getOwnerId();
JKHStore.setRaw('payments_' + ls, JSON.stringify(rows), ownerId);
const check = JKHStore.getRaw('payments_' + ls, ownerId);
```

Запрещено:
- писать `payments_<ЛС>` без ownerId;
- читать из одного owner, а писать в другой;
- возвращать `changed:true`, если после расчёта `rows.length === 0`.

### 3.3. Обязательные диагностические логи

После записи:
```js
console.log('[autoaccrual][save]', { id: ls, rowsCount: rows.length, owner: ownerId });
```

После проверки:
```js
console.log('[autoaccrual][after-save]', { id: ls, exists: !!check, len: parsed.length });
```

---

## 4. index.html

### 4.1. Роль главной страницы

`index.html` не является главным расчётчиком.  
Главная страница — умный читатель ledger.

Правильный порядок:
1. дождаться `JKH_UI_STATE.data.status === ready|empty`;
2. проверить `payments_<ЛС>`;
3. если ledger пригоден — `skip existing`;
4. если начисления отсутствуют — точечно вызвать `recalcForAbonent(id)`;
5. после пересчёта всегда выполнить `rebuildIndexRows(); render();`.

### 4.2. Запрещено

Запрещено на главной:
- делать массовый `recalcAll()` без проверки ledger;
- запускать бесконечный пересчёт при каждом `JKH_UI_STATE_CHANGED`;
- блокировать render из-за ошибки upload;
- считать ledger пригодным только по `paid > 0`.

### 4.3. Обязательная защита от повторов

Должны быть флаги:
- `indexAutoAccrualInFlight`;
- `indexAutoAccrualDoneForOwner`.

Owner учитывается через:
```js
JKHStore.getOwnerId()
```

---

## 5. spravka_sud.js

### 5.1. Роль судебной справки

Справка суда — производная от ledger. Она не должна менять юридическую логику карточки.

### 5.2. Поведение перед построением

Перед чтением таблицы справка обязана:
1. прочитать `payments_<ЛС>`;
2. проверить наличие `accrued > 0`;
3. если начислений нет — вызвать `JKHAutoAccrual.recalcForAbonent(ctx.abonentId)`;
4. если был пересчёт — попытаться `Data.flushDbToServer()` через `try/catch`;
5. независимо от результата flush повторно прочитать `payments_<ЛС>`;
6. построить справку.

### 5.3. Обязательное правило

`SERVER_UPLOAD_FAILED` не имеет права останавливать построение справки, если локальный ledger уже создан.

Обязательный лог после перечитывания:
```js
console.log('[spravka_sud][ledger-after-recalc] id=' + ctx.abonentId + ' len=' + allRows.length);
```

---

## 6. Upload whitelist

### 6.1. Главный принцип

Обычный upload работает только по whitelist.

Запрещён принцип:
> отправить всё, кроме blacklist.

Разрешён принцип:
> отправить только явно разрешённые owner-ключи.

Функция-граница:
```js
_isUploadAllowedKey(baseKey, ownerId)
```

Любой ключ вне whitelist:
- не отправляется;
- логируется;
- не считается ошибкой UI.

Лог:
```js
console.warn('[JKH sync][skip-upload-not-allowed]', key);
```

---

## 7. Разрешённые upload-ключи

### 7.1. Точные owner-scoped ключи

Разрешены:
- `abonents_db_v1`
- `abonent_notes_v1`
- `exclude_periods_v1`
- `organization_requisites_v1`
- `organization_signers_v1`
- `payment_sources_v1`
- `last_abonent_id`
- `import_preview_v1`
- `draft_new_abonent_v1`
- `jkh_excel_date_debug`

### 7.2. Разрешённые префиксы

Разрешены:
- `payments_`
- `exclude_periods_`
- `note_`
- `calc_period_`
- `calc_period_active_`
- `report_period_`
- `payments_ui_collapsed_`
- `jkh_transfer_to_v1:`
- `jkh_transfer_balance_v1:`
- `jkh_freeze_to_v1:`
- `jkh_frozen_debt_v1:`
- `moratorium_`

### 7.3. Тарифы

Разрешён только ключ:
```text
tariffs_<ownerId>
```

Запрещены к upload:
- `tariffs_dynamic_v1`
- `tariffs_content_repair_v1`
- `tariffs_content_repair_v1_backup`
- `tariffs_`
- `tariffs_<чужой ownerId>`

Legacy тарифы можно читать только как fallback/migration, но нельзя отправлять на сервер.

---

## 8. GLOBAL/admin-only ключи

### 8.1. Ставки рефинансирования

Ключи:
- `refinancing_rates_normal_v1`
- `refinancing_rates_moratorium_v1`

Статус:
- backend owner: `GLOBAL`;
- write: только admin;
- read: все роли;
- обычный upload пользователя НЕ отправляет эти ключи.

### 8.2. Запрещено

Запрещено:
- писать ставки с клиента обычным user-flow;
- включать `refinancing_rates_*` в owner upload;
- восстанавливать fallback-ставки молча;
- создавать `ref_rates_{owner}`.

---

## 9. Legacy keys

Legacy-ключи допустимы только как read-only/migration fallback.

Примеры:
- `tariffs_dynamic_v1`
- `tariffs_content_repair_v1`
- `tariffs_content_repair_v1_backup`

Если такой ключ найден в localStorage/cache:
- его можно прочитать для миграции;
- его нельзя отправлять на сервер;
- его нельзя использовать как новый источник записи.

---

## 10. Запрет молчаливого расчёта при отсутствии ставок

Если дата начала расчёта/регистрации/долга абонента раньше первой доступной ставки рефинансирования:
- система обязана показать понятное информационное предупреждение;
- расчёт пени / судебной справки должен быть остановлен до исправления данных;
- запрещено молча применять первую найденную ставку задним числом;
- запрещено молча считать пеню как 0.

Это правило распространяется на:
- `CalcEngine`;
- `spravka_sud`;
- карточку абонента;
- отчёты.

---

## 11. Обязательные проверки после изменений

### 11.1. Browser

После `Ctrl+F5` на `index.html`:
- нет `SyntaxError`;
- нет `POST /api/store 403`;
- таблица заполнена;
- при существующем ledger видно `skip existing payments_...`;
- при отсутствии ledger создаётся autoaccrual и затем выполняется rebuild.

### 11.2. Судебная справка

После открытия `spravka_sud.html?abonent=<ЛС>`:
- справка строится;
- ledger читается;
- при существующем ledger видно `skipped existing ledger`;
- `SERVER_UPLOAD_FAILED` не ломает построение.

### 11.3. Terminal

Минимальные проверки:
```bash
node --check web/storage.js
node --check web/autoaccrual_engine.js
node --check web/spravka_sud.js
rg -n "tariffs_dynamic_v1|tariffs_content_repair_v1|refinancing_rates_normal_v1|refinancing_rates_moratorium_v1" web/storage.js
```

---

## 12. Запреты для будущих задач Codex

Codex запрещено:
- возвращать прямой `await Data.flushDbToServer()` без `try/catch` в UI-сценариях;
- удалять ownerId из `JKHStore.getRaw/setRaw` для `payments_<ЛС>`;
- считать `paid > 0` полноценным ledger без `accrued > 0`;
- отправлять неизвестные ключи на сервер;
- менять `calc_engine.js` без отдельного ТЗ;
- менять юридическую формулу пени вместе с UI-фиксом;
- использовать ES-modules в v1.5.x/v1.8.x classic-script режиме.

---

## 13. Файлы, затронутые каноном

Основные:
- `web/storage.js`
- `web/autoaccrual_engine.js`
- `web/index.html`
- `web/spravka_sud.js`
- `web/data.js`
- `web/payment_table.js`

Не трогать без отдельного ТЗ:
- `web/calc_engine.js`

---

## 14. Короткий инженерный принцип

**Сначала читаем валидный local owner-cache. Потом ремонтируем дырки. Потом пробуем sync. UI строим всегда, если локальные данные есть.**
