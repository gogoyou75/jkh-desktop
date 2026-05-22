## 2026-05-18 — Abonent summary: frontend dirty tracking

- Добавлен frontend-сервис `Data.markAbonentSummaryDirty(abonentOrId, reason)` для безопасного вызова `POST /api/abonent_summary/mark_dirty` с `credentials: "include"`.
- Dirty marking подключён после финансово значимых write-path: ledger/payment table, Excel payments apply, calc period, excludes, moratorium, transfer/merge responsibility.
- Ошибки dirty endpoint логируются как `[summary][mark-dirty-failed]` и не блокируют основное сохранение.
- Зафиксировано, что `abonent_summary` имеет состояния `fresh` / `dirty` / `missing` / `error`; `dirty` не запускает пересчёт, а `fresh` появляется только после явного UID-пересчёта и single upsert.

# CHANGELOG

## 2026-05-17 — Abonent summary single UID integration

- `POST /api/abonent_summary/rebuild` теперь поддерживает два режима: пустой body сохраняет прежний controlled missing rebuild по owner, а body с `account_uid` и `summary` выполняет single upsert только этого UID.
- Single upsert принимает только owner из серверной сессии, проверяет принадлежность UID текущему owner и сохраняет `summary_json` как derived-cache, полученный после канонического frontend UID-пересчёта.
- Backend по-прежнему не считает долг, пеню, FIFO и не читает `payments_<uid>`; `GET /api/abonent_summary` остаётся read-only без hidden writes.
- Карточка абонента после успешного UID-пересчёта отправляет fresh summary через `Data.saveAbonentSummaryAfterRecalc(...)`; fatal error сохраняется как `summary_status = error` / `summary_reason` без подстановки нулевых totals.
- Добавлены тесты single create/update, owner isolation, spoofing, invalid summary, unknown UID и сохранения legacy controlled missing rebuild.

## 2026-05-16 — Explicit abonent_summary rebuild write-path

- Добавлен `POST /api/abonent_summary/rebuild` как отдельная авторизованная write-команда для заполнения `abonent_summary` по абонентам текущего owner из сессии.
- `GET /api/abonent_summary` сохранён строго read-only: без расчёта, ledger fallback, чтения `payments_<uid>`, autoaccrual и hidden writes.
- До реализации backend-расчёта rebuild пишет controlled `missing` / `SUMMARY_NOT_BUILT` с identity и period placeholders, не подставляя нулевые totals.
- Добавлены тесты на read-only GET, запись rebuild, неизменность `web/calc_engine.js`, owner isolation и пустую базу.

## 2026-05-16 — Passive summary integration for index.html

- Главная страница начала поддерживать read-only summary-layer без recalculation и ledger fallback. Добавлено отображение `summary_status` и passive API loading.

## 2026-05-16 — Summary infrastructure contract guards

- Добавлены contract tests и read-only guards для infrastructure-only summary API. Endpoint подтверждён как derived-cache transport layer без recalculation, ledger fallback и hidden writes.

## 2026-05-16 — Stage 1 calculation modernization design contract

- Зафиксирован дизайн-контракт будущего summary-слоя и лёгкой главной страницы. Описаны `abonent_summary`, `summary_status`, dirty-механика, `affected_uids` и будущие API-контракты. Код не менялся.

## 2026-05-16 — Calculation Modernization Stage 0 Freeze

- Зафиксированы документальные запреты Этапа 0 перед оптимизацией расчётов: `web/calc_engine.js` остаётся юридическим ядром, перенос на Python/Pandas запрещён до summary-слоя, эталонных тестов и сверки 1:1.
- Запрещены изменения формулы пени, FIFO-разнесения оплат, UID-ledger `payments_<uid>`, read-only поведения `index.html`, `/api/store_dump` и fatal-поведения вместо silent fallback.
- Клиентские summary/cache/table totals закреплены только как derived data, не юридический source of truth.
- Следующий безопасный этап определён как проектирование summary-слоя: `abonent_summary`, `summary_status` fresh/dirty/missing/error, batch recalculation только по `affected_uids`, `index.html` читает готовые итоги без массового пересчёта.

## 2026-05-16 — Stable Canon Sync / CalcEngine Freeze Boundary

- Проведён документальный аудит `LOGIC_SPEC.md`, `TRACEABILITY_MATRIX.md`, `CHANGELOG.md`, `CRITICAL_INDEX.md` для переноса safe canon в стабильную базовую ветку.
- Зафиксирован `CalcEngine Freeze Boundary`: `web/calc_engine.js` остаётся юридическим ядром; performance/precompute/alternate-pass изменения внутри CalcEngine запрещены без отдельного архитектурного ТЗ.
- Перенесены только SAFE CANON и SAFE HARDENING правила: server-first, UID-only `payments_<uid>`, fatal вместо silent fallback, canonical transfer flow, read-only page rules, calc summary integrity, import strict contract/audit, owner isolation, upload whitelist, canonical `calc_period_<uid>` / `calc_period_active_<uid>`, read-back validation before legacy cleanup.
- Dangerous commits: `d535dba` и `6780a25` признаны источниками DO NOT PORT для `prepareLedgerState`, single-pass/precompute totals, precomputed penalty/FIFO, optimized FIFO, alternate totals and calc-engine perf pipelines.
- Server Summary Layer подготовлен только как foundation/contract: summary remains derived cache only, без нового financial engine, без собственной формулы и без изменения FIFO/penalty/legal formulas.

## 2026-05-14 — Calc Summary Docs Freeze

- Зафиксирован завершённый канон Calc Summary: `calc_summary_<uid>` является derived cache, а не source of truth.
- Source of truth для расчёта: `payments_<uid>`, tariffs, refinancing, excludes, moratorium, responsibility и выбранный calc period.
- Summary разрешено использовать только при fresh state; stale/dirty/mismatch/invalid/missing состояния показывают «Требуется пересчёт» и не подставляют старые totals.
- Пересчёт summary разрешён только по явному действию пользователя; read-only открытие страниц, dirty detection и prepare accruals не запускают пересчёт автоматически.
- Выбранный `calc_period_<uid>` / `calc_period_active_<uid>` строго ограничивает summary; изменение периода делает ранее записанный summary not-fresh.
- Missing accruals внутри выбранного периода блокируют fresh summary. `prepare accruals` только подготавливает ledger-начисления и не создаёт `calc_summary_<uid>`.
- `prepare-and-recalc` закреплён как явная пользовательская команда, которая после подготовки начислений запускает пересчёт и только при успешном расчёте может записать fresh summary.
- Acceptance test канона: `npm run test:calc-summary:acceptance`.
- Цепочка коммитов Calc Summary freeze: `1994f4d` → `b092e78`.

## 2026-05-14 — Calc engine versioning

- `calc_checkpoint_<uid>` теперь хранит `calcEngineVersion`, `canonVersion` и `summaryFormatVersion`.
- `Data.readCalcSummary(...)` инвалидирует старые summary со статусами `engine_version_mismatch` / `summary_version_mismatch`, если checkpoint создан другой версией расчётной логики или формата summary.
- UI (`payment_table`, карточка абонента, индекс) не использует totals при version mismatch и показывает «Требуется пересчёт (Изменена версия расчёта)».
- Зафиксировано правило: `calc_summary_<uid>` зависит от данных, версии финансовой логики и версии формата summary; silent upgrade/patch запрещён.

## 2026-05-14 — Calc summary integrity

- Усилен lifecycle `calc_summary_<uid>`: summary теперь считается cache-derived entity и используется только при `integrity=fresh`.
- `Data.readCalcSummary(...)` возвращает structured state со статусами `fresh`, `missing`, `dirty`, `checkpoint_mismatch`, `invalid_json`, `invalid_structure`.
- `Data.writeCalcSummary(...)` записывает summary вместе с `calc_checkpoint_<uid>` и валидирует структуру summary/checkpoint перед сохранением.
- Checkpoint фиксирует период расчёта и lightweight fingerprints для ledger, тарифов, ставок рефинансирования, исключений, моратория, responsibility data и calc period.
- UI (`payment_table`, карточка абонента, индекс) больше не показывает старые totals при dirty/mismatch/invalid состояниях и выводит «Требуется пересчёт».

## 2026-05-12 — Import XLS: единый сборщик новых платежей

- import_xls: добавлен единый сборщик платежей `collectImportPaymentsToApply(...)`.
- Предпросмотр, счётчик кнопки и применение платежей теперь используют одну логику.
- Дубликаты больше не блокируют импорт новых платежей других абонентов.
- При смешанном файле система добавляет только новые платежи и не создаёт повторные записи.
- Добавлен диагностический лог `[import_xls][payments-collect]`.

## 2026-05-12 — Import XLS: диагностика остановленного расчёта

- import_xls: добавлена диагностика остановленного расчёта при импорте Excel.
- Найденный остановленный абонент теперь отображается отдельным статусом `STOPPED` / «УЧТЁН / РАСЧЁТ ОСТАНОВЛЕН».
- Первичка не создаёт дубль и не изменяет остановленный расчёт.
- Платежи после даты остановки расчёта блокируются.
- Добавлен лог `[import_xls][responsibility-stopped]`.

## 2026-05-10 — Responsibility transfer unified through Data.transferResponsibility

- Зафиксирован единый финансовый канон передачи ответственности.
- Создание нового абонента на квартиру с активным `link` теперь допускается только через transfer-flow.
- Карточка абонента и `new_abonent.html` должны использовать единый сервис `Data.transferResponsibility(...)`.
- Разрешены базовые режимы `WITH_DEBT` и `WITHOUT_DEBT` / `NO_DEBT`.
- Старый период ответственности закрывается на `transferDate - 1`, новый начинается с `transferDate`.
- `WITH_DEBT` требует успешного frozen debt calculation; silent fallback в нулевой долг запрещён.
- `WITHOUT_DEBT` оставляет долг на старом `payments_<oldUid>`, новый абонент стартует с новым UID и нулевым ledger.
- Преобразование квартиры без назначения нового абонента не является transfer-flow и не запускает начисления.
- Кодовая реализация: commit `2a42b5d Enforce canonical responsibility transfer flow`.

## 2026-05-10 — P0: canonical excluded penalty periods

- P0: исправлена консистентность исключённых периодов при передаче/объединении/создании абонента; введён canonical source-of-truth `exclude_periods_<abonentId>`; запрещено слепое копирование `defaultExcludes`.
- Новый абонент при create/transfer/merge получает `exclude_periods_<newAbonentId> = []`; legacy `defaultExcludes` используется только как read-only migration source при отсутствии canonical key.

## 2026-05-08 — Docs: closure of P0 silent-fallback audit

- Зафиксировано, что открытие справки, главной страницы и таблицы платежей является read-only и не должно менять ledger, запускать autoaccrual apply или flush.
- Зафиксированы fatal-правила вместо молчаливых fallback: `LEDGER_JSON_INVALID`, `RATES_MISSING`, `RATES_JSON_INVALID`, `MISSING_REQUIRED_RATE`, `EXCLUDES_JSON_INVALID`, `EXCLUDES_INVALID`, `START_DATE_MISSING`, `RESPONSIBILITY_DATE_MISSING`.
- Зафиксирован запрет fallback-даты `2000-01-01`, запрет расчёта пени по ставке `0`, обязательность явного `payment_period` `YYYY-MM` при импорте платежей и запрет unsafe zero fallback при переносе долга `WITH_DEBT`.
- В audit table добавлены commit references: `60e6ee9`, `22f6858`, `9688dbb`, `815c3b0`, `13176e3`, `a2ce9a0`, `Prevent unsafe zero debt transfer fallback`.


## 2026-05-08 — Import XLS: Busy finally и разделение Excel UID / created UID

- Исправлено зависание глобального индикатора загрузки на `import_xls.html`: после инициализации, восстановления draft, операций проверки файла, создания абонента и ошибок индикатор принудительно закрывается через `finally`.
- Исправлено отображение UID после создания абонента из импорта: системный UID больше не подставляется как исходный UID Excel. В предпросмотре пустой Excel UID остаётся пустым и отдельно показывается созданный UID.

## 2026-05-08 — UI: единый индикатор процесса и UID после создания абонента

- Добавлен единый визуальный индикатор выполнения операций и улучшено сообщение после создания абонента из Excel-импорта: теперь показывается UID созданного абонента.

## 2026-05-08 — Import XLS: мягкая проверка ЛС/ФИО по UID


## 2026-05-19 — Stage 9 DB migration for recalc batch jobs

- added migration for recalc_batch_jobs and recalc_batch_job_items
- fixed schema drift after backend batch orchestration deploy

- Исправлено ложное UID_MISMATCH в Excel-импорте: при найденном UID различия форматирования ЛС/ФИО теперь дают предупреждение, а не блокировку. Блокировка сохранена только для структурных конфликтов UID/active link/regnum.

## 2026-05-07 — Import XLS: защита открытия квартиры по контексту

- Добавлена защита от изменения площади чужой квартиры при переходе из Excel-импорта. Теперь regnum из URL проверяется по UID/ЛС/ФИО строки Excel.

## 2026-05-07 — Premises: защита площади и фиксация кадастрового номера

- Добавлена защита от изменения площади чужой квартиры при переходе из Excel-импорта. Запрещено изменение даты создания, адреса и идентификационных номеров квартиры после создания. В режиме редактирования существующей квартиры разрешено менять только площадь.
- Добавлена фиксация объекта после установки кадастрового номера. После фиксации разрешено менять только площадь.

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

## 2026-05-07 — Excel Import: A15 year validation and durable draft preview

- Добавлена строгая проверка расчётного года из ячейки `A15` первого листа Excel-файла.
- Пустая или некорректная `A15` блокирует импорт; оплаты того же года разрешены, оплаты соседнего года дают warning, оплаты с расхождением больше одного года блокируют импорт.
- Предпросмотр импорта сохраняет результат A15 validation и восстанавливается после возврата на страницу без повторного выбора исходного файла.
- Старые draft без A15 validation блокируются до повторной загрузки файла.
- После применения платежей таблица предпросмотра не очищается: применённые строки помечаются как «применено», остальные остаются доступными; очистка выполняется только кнопкой «Сбросить предпросмотр».

## 2026-05-11 — Financial modes: canonical service boundary

- Financial modes сгруппированы и частично объединены в canonical service layer `Data`.
- UI write-path для ledger/transfer постепенно закрывается через `Data.readPaymentLedger`, `Data.writePaymentLedger`, `Data.createEmptyPaymentLedger` и `Data.transferResponsibility`.
- `payments_<uid>` закреплён как единственный write-path ledger.
- Legacy `payments_<LS>` оставлен только для read fallback внутри service layer.
- Добавлены нормализация `WITH_DEBT` / `WITHOUT_DEBT` / `NO_DEBT` и минимальный financial event log.

## 2026-05-19 — Stage 9 Backend Batch Orchestration
- backend стал coordinator batch-пересчёта abonent_summary;
- frontend создаёт job и читает progress;
- owner/UID allowlist проверяются только на backend;
- batch не делает full-scan и не падает целиком из-за одного UID;
- calc_engine.js не изменялся.

## 2026-05-20 — Stage 11 Batch Job Progress UI
- Добавлен расширенный status payload для `GET /api/abonent_summary/recalc_batch_job/<job_id>`: top-level `job_id/status/total/processed/fresh/error/skipped/message/affected_uids` + совместимый `job` блок.
- Backend status endpoint теперь продвигает queued/running job по шагам, что даёт реальный polling progress без скрытого full-recalc.
- Frontend index добавил runtime polling (ограниченные retry, без бесконечных таймеров), блокировку кнопки запуска во время active job, вывод прогресса и авто-refresh текущей summary-страницы после completed.

## 2026-05-21 - Stage 13.1: Period keys are view-state, not financial dirty

- `calc_period_<uid>`, `calc_period_active_<uid>` and `report_period_<uid>` are fixed as view/report state, not financial ledger mutations.
- Saving or toggling calc period no longer marks `abonent_summary` dirty with `CALC_PERIOD_CHANGED`.
- Backend `POST /api/abonent_summary/mark_dirty` accepts `CALC_PERIOD_CHANGED` as a view-only reason and returns `status=skipped` without creating or updating financial dirty summary rows.
- No changes to `payments_<uid>`, `ledger_runtime_cache_<uid>`, autoaccrual, FIFO, penalty formula, checkpoint/tail-recalc or `web/calc_engine.js`.

## 2026-05-21 — Stage 13.2A: canonical ledger diagnostics and dirty/fresh race stabilization

- Manual recalc controlled autoaccrual writes keep `summaryDirtyReason:false`, invalidate stale runtime ledger cache, and refresh `ledger_runtime_cache_<uid>` after the explicit recalc flow.
- Added read-only `window.JKH_diagnoseLedger()` diagnostics for canonical `payments_<uid>` vs legacy `payments_<LS>` state without migration, deletion, or writes.
- Legacy `payments_<LS>` fallback remains transitional read-only mode and now logs `[ledger][legacy-readonly-fallback]`.
- Fresh `abonent_summary` is blocked for legacy-only ledgers with `LEGACY_LEDGER_MIGRATION_REQUIRED`; UID generation is blocked when a UID-missing abonent already has legacy ledger rows.
- `web/calc_engine.js`, backend financial calculation, storage key migration, and server-first read-only page behavior were not changed.

## 2026-05-21 — Stage 13.2B: migration verification layer

- Added read-only `window.JKH_verifyLedgerMigration(options)` to classify canonical/legacy ledger migration readiness without creating, overwriting, migrating, or deleting ledger keys.
- Verification reports `READY_TO_MIGRATE`, mixed-ledger blockers, missing/invalid UID blockers, stale runtime cache, and optional orphan summary items supplied through `options.summaryItems`.
- The layer does not run autoaccrual, does not calculate backend financial totals, does not mark `CALC_PERIOD_CHANGED` dirty, and does not touch `web/calc_engine.js`.

## 2026-05-21 — Stage 13.2B.a: per-abonent ledger migration diagnostics

- Added read-only `window.JKH_verifyLedgerMigrationForAbonent(abonentId)` and `window.JKH_debugAbonentLedger(abonentId)` for one-account diagnostics.
- Debug output explains UID/canonical/legacy state, migration blockers, mixed-ledger comparison, and why index totals/summary may be empty.
- No ledger writes, migration, autoaccrual, backend financial calculation, formula changes, or `web/calc_engine.js` changes.

## 2026-05-21 — Stage 13.2C: summary build diagnostics for canonical ledger

- Added read-only `window.JKH_debugSummaryBuild(abonentId)` to trace canonical ledger rows, frontend calc totals, prepared summary payload, current `/api/abonent_summary`, current `/api/abonents` mapping, and `whyIndexTotalsEmpty`.
- The helper does not call the summary save/recalc write path; it reports `READ_ONLY_DIAGNOSTIC_NOT_EXECUTED` for `Data.recalculateAbonentCard` and builds the comparable payload locally.
- No changes to ledger data, autoaccrual, backend totals, financial formulas, FIFO, or `web/calc_engine.js`.

## 2026-05-21 — Stage 13.2C.a: totals validation diagnostics

- Added read-only `window.JKH_debugTotalsValidation(abonentId)` for field-level totals validation diagnostics.
- The helper reports raw `calcTotalsAsOfAdjusted`, type/finite/missing/NaN status for principal/debt/penalty/total/accrued/paid/balance, validation blocker, payload before validation, and invalid field lists.
- No summary writes, ledger writes, migration, autoaccrual, formula changes, or `web/calc_engine.js` changes.

## 2026-05-21 — Stage 13.2C.b: summary status and render guard diagnostics

- Added read-only `window.JKH_debugSummaryRenderState(abonentId)` to show summary status before/after validation, invalid fields, freshness/runtime flags, index render guard ALLOW/DENY states, and the guard hiding totals.
- Added read-only `window.JKH_getIndexRenderDebugState(...)` on `index.html` so diagnostics can inspect passive summary mode, pagination, row mapping, and render signature state without changing render behavior.
- No summary writes, ledger writes, migration, autoaccrual, formula changes, or `web/calc_engine.js` changes.

## 2026-05-21 — Stage 13.2C.c: summary totals object mapping

- Fresh summary payload now includes canonical nested `summary.totals` fields: `principal`, `debt`, `penalty`, `total`, `accrued`, `paid`, and `balance`, while keeping legacy flat aliases.
- `index.html` reads nested `summary.totals.*` first and falls back to legacy flat fields.
- No ledger writes, migration, autoaccrual, formula changes, FIFO changes, backend totals, or `web/calc_engine.js` changes.

## 2026-05-21 — Stage 13.2C.d: index totals DOM mapping

- `index.html` now carries resolved rendered totals through explicit `renderedValues` and writes debt, penalty, accrued, and paid into identifiable table cells.
- Added `[index][totals-render]` diagnostics with UID, summary status, totals source, totals object, and rendered values for passive summary rows.
- No ledger writes, migration, autoaccrual, formula changes, FIFO changes, backend totals, or `web/calc_engine.js` changes.

## 2026-05-21 — Stage 13.2C.e: index totals cell targeting

- Index totals DOM writes now target explicit `td[data-field="debt"]`, `td[data-field="penalty"]`, `td[data-field="accrued"]`, and `td[data-field="paid"]`.
- Added `[index][totals-dom-write]` diagnostics with UID, field, value, targetFound, beforeText, and afterText.
- No positional `cells[5]` / `cells[6]` / `cells[7]` totals mapping, ledger writes, backend totals, formula changes, or `web/calc_engine.js` changes.

## 2026-05-21 - Stage 13.2D: diagnose and stabilize abonent card calc/report period flow

- Added card recalc diagnostics: `[card-recalc][click]`, `[card-recalc][period-saved]`, and `[card-recalc][result]` show UID, input dates, canonical key readback, recalc result, ledger rows count, and summary totals.
- Card and reports flows now persist/read canonical `report_period_uid_<uid>` together with `calc_period_uid_<uid>` and `calc_period_active_uid_<uid>` so `spravka_sud` can bootstrap the same selected period.
- Added read-only `window.JKH_debugCardPeriodFlow(abonentId)` for calc/report period key diagnostics and spravka bootstrap warnings.
- `CALC_PERIOD_CHANGED` remains view-only, no ledger writes/migration/backend totals/formula/FIFO changes were added, and `web/calc_engine.js` was not changed.

## 2026-05-21 - Stage 13.2D.a: fix card period handoff to reports/spravka

- The card reports button now saves and readback-checks `calc_period_uid_<uid>`, `calc_period_active_uid_<uid>`, and `report_period_uid_<uid>` before navigation.
- `reports.html` bootstraps its date inputs from URL period first, then `report_period_uid_<uid>`, then `calc_period_uid_<uid>`, and logs `[reports][bootstrap-period]`.
- `spravka_sud.js` logs `[spravka][bootstrap-period]` and keeps report-period-first fallback behavior.
- No ledger rows, autoaccrual on open, formulas/FIFO/penalty logic, financial dirty behavior, or `web/calc_engine.js` were changed.

## 2026-05-22 - Stage 13.2D.b: auto-accept report period from card handoff

- `reports.html` now auto-accepts periods bootstrapped from URL, `report_period_uid_<uid>`, or `calc_period_uid_<uid>` by saving canonical period keys and confirming readback.
- Added `[reports][period-auto-accepted]` diagnostics and enabled opening the court report after successful auto-accept without requiring the manual "Выбрать" click.
- No formula/FIFO/penalty changes, no `CALC_PERIOD_CHANGED` financial dirty behavior, and no `web/calc_engine.js` changes.

## 2026-05-22 - Stage 13.2D.c: restore calc period inputs on card return

- `abonent_card.html` now bootstraps `calcFrom` / `calcTo` from `report_period_uid_<uid>` first, then `calc_period_uid_<uid>`, and logs `[card-period][bootstrap-inputs]`.
- Returning from reports/spravka to the card preserves the selected period without triggering automatic recalculation.
- No formula/FIFO/penalty changes, no financial dirty behavior, no ledger row changes, and no `web/calc_engine.js` changes.

## 2026-05-22 - Stage 13.2D.d: default report period when card period is empty

- The card reports button now creates a default report period when `calcFrom` / `calcTo` are empty, using responsibility start, `calcStartDate`, compatible abonent start fields, premise creation date, or earliest ledger month fallback.
- The generated period is saved into `report_period_uid_<uid>`, `calc_period_uid_<uid>`, and active calc-period state before opening reports, with `[report-period][default-created]` diagnostics.
- No autoaccrual on open, no formula/FIFO/penalty changes, no `CALC_PERIOD_CHANGED` financial dirty behavior, no ledger row changes, and no `web/calc_engine.js` changes.

## 2026-05-22 - Stage 13.2D.e: preserve report period when returning from spravka to abonent card

- `spravka_sud.js` now saves and readback-checks `report_period_uid_<uid>`, `calc_period_uid_<uid>`, and `calc_period_active_uid_<uid>` before returning to the abonent card.
- The back-to-card URL now includes `abonent`, `account`, `uid`, `from`, and `to`, with `[spravka][return-card-period-save]` and `[spravka][return-card-url]` diagnostics.
- `abonent_card.html` now restores `calcFrom` / `calcTo` from URL `from/to` before falling back to canonical report/calc period keys, with `[card-period][bootstrap-inputs-from-url]`.
- No autoaccrual on return, no formula/FIFO/penalty changes, no `CALC_PERIOD_CHANGED` financial dirty behavior, no ledger row changes, and no `web/calc_engine.js` changes.

## 2026-05-22 - Stage 13.2D.f: restore filtered payment table after return from spravka

- Card period bootstrap now writes and readback-checks active canonical calc/report period keys before the payment table load, logging `[card-period][bootstrap-active]`.
- `payment_table.js` includes active period state in the render signature, supports forced readonly reloads, and logs `[payment-table][period-filter-applied-on-load]` when the period filter is applied on page load.
- Returning from spravka restores both `calcFrom` / `calcTo` and the filtered table view without autoaccrual/recalc.
- No formula/FIFO/penalty changes, no `CALC_PERIOD_CHANGED` financial dirty behavior, no ledger row changes, and no `web/calc_engine.js` changes.

## 2026-05-22 - Stage 13.2D.g: restore period-aware payment table runtime values after returning from spravka

- `payment_table.js` now uses a period-aware runtime signature that includes ledger version, `periodActive`, and selected `from/to`.
- Runtime cache created for the full ledger is not applied to an active period view; readonly period loads rebuild row runtime values from the filtered view and may refresh only `ledger_runtime_cache_<uid>`.
- Added `[payment-table][period-runtime-source]` diagnostics with full/view row counts, cache usage, period match, and base rows source.
- No formula/FIFO/penalty changes, no `CALC_PERIOD_CHANGED` financial dirty behavior, no ledger row changes, no autoaccrual on return, and no `web/calc_engine.js` changes.

## 2026-05-22 - Stage 13.2D.h: force readonly period-view totals recalculation after spravka return

- Active period readonly loads now force row runtime values from `applyResponsibilityRangeToView(applyCalcFilter(...))` and `runningTotalsBaseRows(filteredRows)`.
- Period view signatures are built from filtered base rows plus period state, and `[payment-table][period-runtime-source]` reports `runtimeCacheUsed:false`, `baseRowsSource:"filtered"`, and the active signature.
- The active period path does not use full-ledger runtime cache, does not write ledger rows, and does not trigger autoaccrual/recalc on return.
- No formula/FIFO/penalty changes, no `CALC_PERIOD_CHANGED` financial dirty behavior, and no `web/calc_engine.js` changes.

## 2026-05-22 - Stage 13.2D.i: force period-aware running totals signature in payment_table

- Active period loads now use `effectiveSignature = ledgerSignatureForRows(baseRows) + "|period:<from>:<to>"` for memoized totals and running-total updates.
- `scheduleRunningTotalsUpdate` runs in readonly mode when an active period is present, using filtered `view/baseRows` rather than the full ledger.
- `[payment-table][period-runtime-source]` now reports `effectiveSignature`, `runtimeCacheUsed:false`, and `baseRowsSource:"filtered"` for period views.
- No formula/FIFO/penalty changes, no ledger writes, no autoaccrual on return, no `CALC_PERIOD_CHANGED` financial dirty behavior, and no `web/calc_engine.js` changes.

## 2026-05-22 - Stage 13.2D.j: URL period fallback for payment table after spravka return

- `payment_table.js` now reads URL `from/to` as a fallback period when canonical calc-period data is missing or not active yet.
- `isCalcPeriodActive()` treats a valid URL period as active only when canonical active key is not set, logging `[payment-table][period-url-fallback]`.
- Period-aware signatures and filtered runtime calculations now also work when the card was restored from URL period before canonical keys are readable.
- No formula/FIFO/penalty changes, no ledger writes, no autoaccrual on return, no `CALC_PERIOD_CHANGED` financial dirty behavior, and no `web/calc_engine.js` changes.

## 2026-05-22 - Stage 13.2D.k: reset card period restores full payment table view

- Card period reset now clears calc/report period keys, deactivates `calc_period_active_uid_<uid>`, removes URL `from/to` with `history.replaceState`, and logs `[card-period][reset]`.
- Added `window.JKH_resetPaymentTablePeriodRuntime(reason)` to clear period-derived render signature and memoized totals without touching ledger rows.
- Full readonly table reload after reset logs `[payment-table][period-runtime-reset]` and `[payment-table][full-view-after-period-reset]`.
- No formula/FIFO/penalty changes, no ledger writes, no autoaccrual, no `CALC_PERIOD_CHANGED` financial dirty behavior, and no `web/calc_engine.js` changes.

## 2026-05-22 — Stage 13.3 — index empty totals and summary status consistency

- `index.html` теперь валидирует fresh summary перед отображением totals: fresh без `summary.totals`, без обязательных debt/penalty/accrued/paid или с non-finite значениями отображается как `error` с reason `FRESH_TOTALS_MISSING` / `FRESH_TOTALS_INVALID`.
- Добавлен read-only diagnostic helper `window.JKH_debugIndexSummaryRows()` и console diagnostics `[index][summary-row-empty]` / `[index][summary-row-invalid-fresh]` для точной причины пустых расчетных колонок.
- Legacy `CALC_PERIOD_CHANGED` больше не трактуется как financial dirty: backend index payload нормализует старый dirty reason в `missing`, frontend показывает view-only legacy reason и клиентский dirty helper не отправляет этот reason на сервер.
- `web/calc_engine.js`, формулы, FIFO, пени, чтение `payments_<uid>` на index, autoaccrual и hidden rebuild не изменялись.

## 2026-05-22 — Stage 13.3E — batch invalid fresh totals guard

- Backend summary transport теперь валидирует `fresh` totals перед index payload и batch job accounting: fresh без `summary.totals` или без finite debt/penalty/accrued/paid превращается в `error` с `FRESH_TOTALS_MISSING` / `FRESH_TOTALS_INVALID`.
- Batch job больше не считает invalid fresh как fresh: такие UID идут в `error_count`, item получает `summary_status=error` и точный `summary_reason`.
- Не добавлялись hidden rebuild, fake zero totals, чтение `payments_<uid>` на index, autoaccrual или изменения `web/calc_engine.js`.

## 2026-05-22 — Stage 13.4 — abonent card summary pipeline

- Single `POST /api/abonent_summary/rebuild` теперь сохраняет нормализованный summary: invalid `fresh` без обязательных nested `totals.debt/penalty/accrued/paid` превращается в `error` без fake totals.
- Frontend save path после ручного пересчёта логирует `[summary][save-ok]` с UID, status и ключами `summary.totals`; карточка показывает понятное сообщение, если расчёт выполнен, но summary для главной страницы не сохранён.
- Кнопка index batch переименована в проверку summary, чтобы не маскировать validator как пересчёт карточек.
- Не менялись `web/calc_engine.js`, формулы/FIFO/пени, backend financial logic, чтение `payments_<uid>` на index, hidden rebuild и storage keys.

## 2026-05-22 — Stage 13.4A — summary pipeline audit diagnostics

- Уточнён контракт rebuild без body: он остаётся controlled missing rebuild и не притворяется финансовым пересчётом totals.
- Frontend save path логирует `[summary][build-payload]`, `[summary][save-ok]`, `[summary][save-failed]` с UID, status, reason и `summary.totals` keys.
- Добавлена regression-проверка, что rebuild без body не исправляет invalid fresh финансовыми totals и не подставляет fake totals.
- Index по-прежнему не читает `payments_<uid>` и batch остаётся validator, не пересчётом карточек.

## 2026-05-22 — Stage 13.4B — abonent card calc-period canonical key resolution

- `abonent_card.html` и `payment_table.js` теперь резолвят calc period keys через `Data.resolveCalcPeriodStorageKey(...)` / `Data.resolveCalcPeriodActiveStorageKey(...)` даже когда локальный объект абонента ещё не готов, используя requested id как вход в canonical resolver.
- Добавлена диагностика `[calc-period][canonical-key-used]` с `requestedId`, `resolvedUid`, `storageKey`, `activeStorageKey`, `ownerId`.
- Сохранение периода остаётся view-only: без `CALC_PERIOD_CHANGED` dirty, без legacy `calc_period_<ЛС>` writes, без hidden rebuild и без изменений `web/calc_engine.js`.

## 2026-05-22 — Stage 13.4B — separate full summary from period calculation

- Period/report calculation in `fullRecalcForCurrentAbonent` no longer saves its selected-period result as the main `AbonentSummary` for index; it returns period summary for card display and logs `[summary][skip-save-period-summary]`.
- Full/canonical summary saves are logged as `[summary][save-full-summary]`; only non-period recalculation may write the main summary cache.
- Backend transport ignores `summary_scope=period` / `report_scope=period` summaries for index by mapping them to `missing/PERIOD_SUMMARY_IGNORED` and stripping totals.
- No `web/calc_engine.js`, FIFO, penalty formula, index ledger read, hidden rebuild, or `CALC_PERIOD_CHANGED` financial dirty changes.

## 2026-05-22 — Stage 13.4B — protect index summary from period/report saves

- `Data.saveAbonentSummaryAfterRecalc(...)` now hard-skips `summary_scope=period/report` before POST and logs `[summary][skip-save-period-summary]`.
- Backend `POST /api/abonent_summary/rebuild` rejects period/report summaries with `period_summary_not_allowed`.
- Reports-period save path ensures canonical UID before writing calc-period keys, preserving UID-only `calc_period_uid_*` / `calc_period_active_uid_*`.
- No calc engine, FIFO, penalty, index ledger read, hidden rebuild, or fake summary changes were added.

## 2026-05-22 - Stage 13.4G - calc period reset persistence

- Reset in abonent card now clears canonical `calc_period_uid_*`, sets `calc_period_active_uid_*` to inactive, removes canonical report period, and verifies readback before updating the UI.
- Added reset diagnostics: `[calc-period][reset-start]`, `[calc-period][reset-saved]`, `[calc-period][reset-readback-ok]`, and `[calc-period][reset-readback-failed]`.
- If canonical reset readback fails, the card shows `Период не сброшен на сервере` and does not silently present a successful reset.
- No financial dirty, summary save, hidden rebuild, index ledger read, `calc_engine.js`, FIFO, penalty, or formula changes were added.

## 2026-05-22 - Stage 13.4F - legacy period summary read masking

- Added read-only backend masking for legacy fresh summaries without `summary_scope` whose stored `period.from/to` conflicts with known canonical abonent boundaries.
- Contaminated legacy summaries are transported as `missing` / `PERIOD_SUMMARY_LEGACY` with totals aliases removed; the database row is not updated.
- Unknown canonical boundaries are diagnostic-only and are not aggressively masked.
- No SQL cleanup, hidden rebuild, backend recalculation, index ledger read, `calc_engine.js`, FIFO, penalty, or formula changes were added.

## 2026-05-22 - Stage 13.4E - reports button without card recalculation

- Reports button in abonent card is kept as a navigation/report-period action only: UID ensure, calc/report period save, and transition to reports page.
- Added `[reports][open-with-period]` diagnostics and a `[reports][blocked-card-recalc]` guard marker for accidental card recalculation attempts from the reports path.
- Added source-level regression that the reports button handler does not call card recalculation, summary save/rebuild, or autoaccrual heavy path.
- No `calc_engine.js`, FIFO, penalty, index ledger read, hidden rebuild, or period-summary-as-main-summary changes were added.

## 2026-05-22 - Stage 13.4C - period summary guard and canonical calc-period keys

- Fixed `Data.saveAbonentSummaryAfterRecalc(...)` period/report guard so it runs only after the real summary payload object is defined and returns `PERIOD_SUMMARY_NOT_SAVED` without a JS exception.
- Fixed calc-period legacy-key detection: `calc_period_uid_...` and `calc_period_active_uid_...` are canonical and no longer blocked as legacy writes; account-number keys remain blocked.
- Kept server-first/index constraints unchanged: no hidden rebuild, no index ledger read, no fake totals, no `calc_engine.js` changes.
