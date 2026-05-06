# CHANGELOG

## 2026-05-06 — Import: fingerprint extended with source_index

- Fingerprint платежа расширен до `account_uid + payment_date + amount + source_index`.
- Платежи с одинаковыми UID, датой и суммой, но разными `source_index`, больше не считаются дублями.
- Audit log импорта платежей фиксирует `source_index` рядом с fingerprint.

## 2026-05-06 — Import: idempotency duplicate protection

- Повторный импорт одинакового платежа не создаёт дубль в `payments_<uid>`.
- Duplicate/skipped строки фиксируются в audit log.
- Добавлены тесты защиты duplicate/idempotency.

## 2026-05-06 — Import E2E tests

- Добавлены сквозные тесты импорта платежей.
- Проверка позитивного и негативного сценария.
- Добавлен тест schema guard.

## 2026-05-06 — Import DB: добавлены audit-поля import_batches

- Добавлена обязательная миграция `import_batches` для audit-полей `rows_skipped`, `file_name`, `uploaded_by`, `error_message`.
- Зафиксирована deploy-проверка `DESCRIBE import_batches;` после backend-обновлений моделей БД.
- Backend import теперь проверяет критичные колонки `import_batches` перед import endpoints и возвращает понятную ошибку схемы вместо HTTP 500.

## 2026-05-06 — Import XLS: восстановление сценария оператора

- Сохраняются настройки импорта при переходах со страницы импорта.
- Добавлено предупреждение для созданного абонента без UID в Excel.
- Добавлена подсказка при переходе к изменению площади квартиры.
- Проверена активация кнопки применения платежей для валидных UID-строк.

## 2026-05-06 — Import: проверка хронологии платежей

- Запрещён импорт платежей раньше даты начала абонента.
- Добавлена валидация payment_period < calcStartDate.
- Исправлен ReferenceError year is not defined.

## 2026-05-05 — Import XLS: поддержка CUSTOMER_2009

- Добавлен строгий режим strict-template-customer-2009.
- Шаблон заказчика 2009 читается по служебной строке 15 и карте полей 0–77.
- Платежи конвертируются в единый контракт upload_rows.
- Auto-detect и legacy field-map не используются для CUSTOMER_2009.
- Первичка автоматически не изменяется.

## 2026-05-05 — Import XLS: запрет auto-detect для apply

- Auto-detect больше не является рабочим режимом импорта.
- Legacy field-map больше нельзя вручную разрешить для применения.
- Рабочий импорт разрешён только по strict-template.
- Нестрогие структуры доступны только для предпросмотра и диагностики.
- Импорт стал полностью шаблонным и предсказуемым.

## 2026-05-05 — Import: усиление rollback

- убран flush внутри apply
- гарантирована атомарность транзакции
- добавлен audit log при ошибке
- В audit log при ошибке теперь фиксируется строка, на которой произошёл сбой
- запрещён повторный apply failed batch

## 2026-05-05 — Import: полный audit log

- Добавлен batch-level audit log
- Добавлены агрегированные показатели импорта
- Добавлен endpoint /api/import/<id>/summary
- Усилен row-level audit log

## 2026-05-05 — Import XLS: единый frontend/backend контракт

- Зафиксирован единый JSON-контракт для /api/import/payments/upload_rows.
- Frontend отправляет payment_date только в формате YYYY-MM-DD.
- Frontend отправляет payment_period только в формате YYYY-MM.
- Backend строго валидирует upload_rows по тем же правилам.
- Коды ошибок frontend/backend унифицированы.

## 2026-05-05 — Import backend: переход на payments_<uid>

- Серверный импорт больше не записывает платежи в payments_<LS>
- Основной ключ хранения: payments_<uid>
- payments_<LS> используется только как legacy fallback

## 2026-05-05 — Import XLS: запрет частичного импорта

- Импорт платежей теперь атомарный
- При любой ошибке (дата/валидность) импорт полностью останавливается
- Исключена тихая потеря данных

## 2026-05-05 — Import XLS: запрет fallback даты платежа

- Добавлена строгая нормализация даты платежа `normalizePaidDateStrict()`.
- Запрещена автоматическая подстановка даты платежа как `01.MM.YYYY`.
- Платёж без точной даты больше не применяется.
- Legacy field-map распознавание требует явного подтверждения пользователя перед применением платежей.
- Логика UID/payments_<uid> не изменялась.

## 2026-04-26 — Server-first import payments + frontend boot-layer

### Статус
Критический архитектурный пакет. После успешной проверки должен быть слит в `main` и зафиксирован как эталон.

### Сделано

1. Добавлен единый frontend boot-layer `web/boot.js`:
   - `window.JKH_READY`;
   - `window.JKHBoot.markReady(name)`;
   - `window.JKHBoot.isReady(name)`;
   - `window.JKHBoot.waitFor(names, timeoutMs)`;
   - `window.JKHBoot.getMissing(names)`.
2. Устранена гонка загрузки на `premises.html`.
3. Разделены auth-флаги.
4. Исправлена проблема `window.JKHAutoAccrual === undefined`.
5. Добавлена серверная модель импорта платежей через batch-flow.
6. Добавлена миграция.
7. Исправлен backend UID↔ЛС lookup.
8. Добавлена классификация платежей.
9. Добавлен fingerprint платежа.
10. Обновлена apply-логика.
11. Обновлён `web/import_xls.html`.
12. Убраны alert/confirm из критичных UI.

---

## 2026-04-26 — Tariffs switched to JKHPersist (partial persist migration)

### Статус
Стабильная промежуточная точка. Проверено вручную. Готово к использованию в production.

### Сделано

1. Тарифы переведены на точечное сохранение через `JKHPersist`:
   - ключ: `tariffs_{owner}`;
   - сохранение через `/api/store`;
   - добавлена проверка `verify`.

2. В `web/tariffs.html`:
   - подключён `persist.js`;
   - добавлена функция `saveTariffsToCanonPersist()`.

3. Убрана зависимость тарифов от `uploadNow()`:
   - тарифы больше не сохраняются массовым dump;
   - `uploadNow()` используется только для `abonents_db_v1`.

4. Новый pipeline:
   saveAllFromUI()
   → recalcAll()
   → persistAccrualsAfterRecalc()

5. Разделение:
   - tariffs → JKHPersist
   - accruals → abonents_db_v1 + uploadNow

6. Расчётная логика:
   - calc_engine.js — без изменений
   - autoaccrual_engine.js — без изменений

### Проверено

- [tariffs][persist] ok
- [persist][api-store] status=ok
- перерасчёт работает
- синхронизация между устройствами есть

### Ограничения

- uploadNow пока остаётся для abonents_db_v1
- полный отказ — отдельный этап

---

## 2026-04-30 — STORAGE SYNC + AUTOACCRUAL HARDENING v1.8.3

### Изменено
- `autoaccrual_engine.js`: `recalcForAbonent()` пишет `payments_<ЛС>` строго в owner-scope и проверяет сохранение через `[autoaccrual][after-save]`.
- `index.html`: главная сначала читает ledger, точечно ремонтирует отсутствующие начисления, затем всегда делает rebuild/render.
- `spravka_sud.js`: справка не падает от `SERVER_UPLOAD_FAILED`, повторно читает ledger после autoaccrual и строится из локальных данных.
- `storage.js`: введён строгий upload whitelist `_isUploadAllowedKey()`; legacy/admin/global ключи не отправляются на `/api/store`.

### Устранены классы ошибок
- пустой index при существующих/созданных начислениях;
- пустая судебная справка из-за падения upload;
- `changed:true` при пустом ledger;
- 403 по `tariffs_dynamic_v1` / `refinancing_rates_*` в обычном user upload;
- повторная отправка неизвестных ключей на сервер.

### Новое критическое правило
UI строится из локального owner-cache, если данные есть. Sync/upload — важен, но не имеет права блокировать отображение уже созданного ledger.


---

## 2026-05-03 — UID-only Payments + Premise Merge v1.9.0

### Критическое изменение оплат
- Лицевой счёт больше не является техническим ключом оплат.
- Канонический ledger: `payments_<uid>`.
- `payments_<ЛС>` запрещён для новых/актуальных абонентов.
- Все модули должны получать ключ через `window.getPaymentsKeyForAbonent(abonentId)`.
- Старые `payments_<ЛС>` могут оставаться в storage, но не должны читаться абонентами с UID.
- `DOMContentLoaded` не имеет права запускать чтение оплат до готовности Data.

### Критическое изменение квартир
- Добавлена операция объединения квартир.
- Старые квартиры закрываются как `merged`, но остаются историей.
- Новая квартира создаётся как новый объект с новым regnum и датой создания = дата объединения.
- Создаётся новый абонент с новым ЛС и новым UID.
- Старые долги/оплаты не переносятся автоматически.
- Создание активного абонента на закрытой/объединённой квартире запрещено.

### Проверочный признак
После создания нового абонента с повторным ЛС в логах не должно быть чтения `payments_<ЛС>`; должны использоваться только ключи `payments_<uid>`.

---

## 2026-05-04 — Premise Split v1.9.1 / safe split without money transfer

### Статус
Следующий крупный этап после `UID-only Payments + Premise Merge v1.9.0`.
Фиксируется как безопасная первая версия split.

### Канон
1. Split v1 — структурное разъединение квартир.
2. Старые долги, оплаты, начисления и пеня не распределяются автоматически.
3. Исходная объединённая квартира закрывается и остаётся историей.
4. Новые квартиры создаются как отдельные active premises.
5. Новые/назначенные абоненты получают active links с даты split.
6. Новые абоненты получают новые UID.
7. Ledger новых абонентов должен использовать только `payments_<uid>`.
8. Все действия фиксируются в `premiseEvents` с `type = "split"`.

### Запрещено
- переносить старый ledger на новые квартиры;
- делить долг автоматически;
- делить оплаты автоматически;
- удалять исходную квартиру;
- удалять старого абонента;
- выполнять split без подтверждения;
- делать split без записи события в `premiseEvents`.

### Файлы, которые затронет реализация
- `web/data.js` — сервисная функция splitPremise/splitPremises;
- `web/abonent_card.html` — UI-кнопка и модальное окно split;
- `web/premises_admin.js` — при необходимости отображение/служебные проверки;
- `web/index.html` — отображение статуса split;
- `LOGIC_SPEC.md` — канон;
- `CHANGELOG.md` — журнал изменений.

### Проверки после реализации
```bash
node --check web/data.js
node --check web/premises_admin.js
node --check web/storage.js
rg -n "splitPremise|premise-transform\]\[split|type: ['\"]split" web LOGIC_SPEC.md CHANGELOG.md
```

### Важное ограничение
Распределение задолженности по площади, долям или ручным суммам не входит в v1. Это отдельный будущий этап.


## 2026-05-05 — Payments: консистентность CRITICAL-комментариев

- Обновлены оставшиеся CRITICAL-комментарии в calc_engine.js и storage.js
- Канон payments_<uid> теперь единообразен во всей системе

## 2026-05-05 — CalcEngine: запрет ставки задним числом

- Исправлено поведение `rateOnDate()` в `web/calc_engine.js`.
- Если дата расчёта раньше первой доступной ставки рефинансирования, система больше не применяет первую найденную ставку задним числом.
- При отсутствии ставки возвращается `null`, расчёт пени останавливается через диагностический путь `MISSING_REQUIRED_RATE`.
- Правило соответствует `LOGIC_SPEC.md`: запрещено молча применять первую ставку назад во времени и запрещено считать пеню как 0.

## 2026-05-05 — Payments: обновление CRITICAL-комментариев

- Обновлены CRITICAL-комментарии: payments_<LS> заменены на payments_<uid>
- Добавлено явное указание legacy-статуса LS
- Логика работы с платежами НЕ изменялась

## 2026-05-05 — Import backend: строгая атомарность apply

- apply теперь доступен только при status = ready_to_apply
- запрещён запуск apply при наличии invalid строк
- гарантирована атомарность применения батча
