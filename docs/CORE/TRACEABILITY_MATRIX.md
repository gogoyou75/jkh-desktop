# TRACEABILITY MATRIX (Соответствие ТЗ и кода)

## 📌 Назначение

Этот документ фиксирует соответствие между:

* бизнес-логикой (ТЗ / LOGIC_SPEC)
* реализацией (код проекта)

Цель:

* исключить потерю логики
* выявить противоречия
* контролировать изменения

---

## 🧭 Статусы

| Статус      | Значение                                 |
| ----------- | ---------------------------------------- |
| ✅ OK        | Полностью соответствует                  |
| 🟡 PARTIAL  | Частично реализовано / требует уточнения |
| 🔴 CONFLICT | Противоречие между ТЗ и кодом            |
| ⚪ IDEA      | Есть в ТЗ, но не реализовано             |
| ⚫ UNKNOWN   | Не проверено                             |

---

## 🧩 Блок: Расчёт пени (Calc Engine)

| Правило                                   | Где в ТЗ          | Где в коде                                | Статус | Комментарий           |
| ----------------------------------------- | ----------------- | ----------------------------------------- | ------ | --------------------- |
| Льготный период 30 дней                   | LOGIC_SPEC → Пеня | calc_engine.js / calcPenaltyForObligation | ⚫      |                       |
| 31–90 день: 1/300                         | LOGIC_SPEC → Пеня | calc_engine.js                            | ⚫      |                       |
| 91+ день: 1/130                           | LOGIC_SPEC → Пеня | calc_engine.js                            | ⚫      |                       |
| Ограничение ставки 9.5% до 2027           | ❌ отсутствует     | calc_engine.js / capRateUntil2027         | 🔴     | Есть в коде, нет в ТЗ |
| Ежедневный расчёт пени                    | LOGIC_SPEC        | calc_engine.js                            | ⚫      |                       |
| Исключённые периоды отключают только пеню | LOGIC_SPEC        | calc_engine.js / isExcludedDay            | ⚫      |                       |

---

## 🧩 Блок: Платежи

| Правило                                | Где в ТЗ                  | Где в коде                              | Статус | Комментарий |
| -------------------------------------- | ------------------------- | --------------------------------------- | ------ | ----------- |
| Платежи распределяются FIFO            | ❌ отсутствует             | calc_engine.js / allocatePaymentsFIFO   | 🔴     | Нет в ТЗ    |
| Платёж без периода не уходит в будущее | ❌ отсутствует             | calc_engine.js / buildPaymentEvents     | 🔴     | Критично    |
| Переплата сначала гасит основной долг  | ❌ отсутствует             | calc_engine.js / calcTotalsAsOfAdjusted | 🔴     |             |
| Затем гасится пеня                     | ❌ отсутствует             | calc_engine.js                          | 🔴     |             |
| Хранение payments_<uid>                | LOGIC_SPEC (новая модель) | calc_engine.js / resolvePaymentKey      | ⚫      |             |

---

## 🧩 Блок: Ставки

| Правило                          | Где в ТЗ                     | Где в коде                  | Статус | Комментарий                  |
| -------------------------------- | ---------------------------- | --------------------------- | ------ | ---------------------------- |
| Ставка берётся по дате           | LOGIC_SPEC                   | calc_engine.js / rateOnDate | ⚫      |                              |
| Если ставка отсутствует — fatal `RATES_MISSING` / `RATES_JSON_INVALID` | LOGIC_SPEC | calc_engine.js / loadRates | ✅ OK | commit 9688dbb |
| Если дата не покрыта ставками — fatal `MISSING_REQUIRED_RATE` | LOGIC_SPEC | calc_engine.js | ✅ OK | commit 9688dbb |

---

## 🧩 Блок: Архитектура данных

| Правило             | Где в ТЗ   | Где в коде     | Статус | Комментарий |
| ------------------- | ---------- | -------------- | ------ | ----------- |
| payments_<uid>      | LOGIC_SPEC | calc_engine.js | ⚫      |             |
| server-first        | LOGIC_SPEC | storage.js     | ⚫      |             |
| owner-scoped данные | LOGIC_SPEC | storage.js     | ⚫      |             |

---

## 📌 Как использовать

1. Каждое правило должно быть:

   * либо в ТЗ
   * либо в коде
   * либо в обоих

2. Если правило:

   * есть в коде, но нет в ТЗ → 🔴 добавить в LOGIC_SPEC
   * есть в ТЗ, но нет в коде → ⚪ реализовать
   * конфликт → 🔴 исправить

3. После каждой правки:

   * обновить статус
   * зафиксировать в CHANGELOG

---

## 🚧 Правило безопасности

НЕЛЬЗЯ:

* удалять файлы
* менять логику

ПОКА:

* правило не отражено в TRACEABILITY_MATRIX
## 🧩 Блок: CalcEngine — расчёт долга, пени, ставок и платежей

| Правило | Где в ТЗ | Где в коде | Статус | Комментарий |
|---|---|---|---|---|
| Льготный период: первые 30 дней просрочки пеня = 0 | Исходное ТЗ → расчёт пени | calc_engine.js → calcPenaltyForObligation | ✅ OK | Совпадает с ТЗ |
| С 31 по 90 день применяется 1/300 ставки | Исходное ТЗ → расчёт пени | calc_engine.js → calcPenaltyForObligation | ✅ OK | Совпадает с ТЗ |
| С 91 дня применяется 1/130 ставки | Исходное ТЗ → расчёт пени | calc_engine.js → calcPenaltyForObligation | ✅ OK | Совпадает с ТЗ |
| Пеня считается по дням, с актуальной ставкой на каждый день | Исходное ТЗ → учёт истории ставок | calc_engine.js → calcPenaltyForObligation + rateOnDate | ✅ OK | Совпадает с ТЗ |
| Ставка ЦБ ограничивается 9.5% до 01.01.2027 | В текущем ТЗ отсутствует | calc_engine.js → capRateUntil2027 | 🔴 CONFLICT | Есть в коде, но не внесено в LOGIC_SPEC |
| Исключённые периоды отключают только пеню | Исходное ТЗ / особые периоды | calc_engine.js → isExcludedDay + calcPenaltyForObligation | ✅ OK | Основной долг не трогается |
| Мораторий переключает справочник ставок | Исходное ТЗ → мораторий | calc_engine.js → isMoratoriumActive + loadRates | ✅ OK | Используется обычный или мораторный ключ ставок |
| Если справочник ставок пустой, fallback-ставка запрещена | В LOGIC_SPEC надо зафиксировать явно | calc_engine.js → loadRates | 🟡 PARTIAL | Код возвращает пустой массив и предупреждает |
| Если дата раньше первой ставки, сейчас берётся первая известная ставка | Противоречит новому правилу проекта | calc_engine.js → rateOnDate | 🔴 CONFLICT | По нашему новому правилу расчёт надо останавливать |
| Платежи распределяются FIFO | В старом ТЗ явно не раскрыто | calc_engine.js → allocatePaymentsFIFO | 🔴 CONFLICT | В коде есть важная логика, в LOGIC_SPEC надо добавить |
| Платёж без “оплаты за период” не уходит в будущие месяцы | В LOGIC_SPEC надо зафиксировать | calc_engine.js → buildPaymentEventsFromRows | 🔴 CONFLICT | Критическое правило платежей |
| Переплата сначала гасит основной долг, затем пеню | В LOGIC_SPEC надо зафиксировать | calc_engine.js → calcTotalsAsOfAdjusted | 🔴 CONFLICT | Важное юридико-финансовое правило |
| Платежи читаются по UID: payments_<uid> | Новая архитектура проекта | calc_engine.js → resolvePaymentKeyForAbonent | ✅ OK | Старый верхний комментарий про payments_<LS> устарел |
| Если UID не найден — расчёт платежей блокируется | Новая архитектура проекта | calc_engine.js → resolvePaymentKeyForAbonent | ✅ OK | Это защита от смешивания старых ЛС |
| Долг/пеня закрытого абонента считаются только до freezeTo | В LOGIC_SPEC надо добавить | calc_engine.js → getFreezeToISO + calcTotalsAsOfCore | 🟡 PARTIAL | В коде есть, в документах надо проверить |
| Перенос долга между абонентами поддерживается через transfer balance | LOGIC_SPEC → Financial Canon | calc_engine.js → getTransferBalance | ✅ OK | commit 2a42b5d; legacy-совместимость остаётся отдельным контекстом |
| Судебная разбивка пени считается по исходному месяцу долга | В LOGIC_SPEC надо добавить | calc_engine.js → calcPenaltyBreakdownBySourceMonth | 🟡 PARTIAL | Нужно синхронизировать со spravka_sud.js |


## 🧩 Блок: Storage / Data Access

| Правило | Где в ТЗ | Где в коде | Статус | Комментарий |
|--------|----------|------------|--------|------------|
| Все данные привязаны к owner (user scope) | LOGIC_SPEC | storage.js / getActiveOwnerId | ⚫ | |
| Ключи имеют формат jkhdb::<owner>::<key> | ❌ отсутствует | storage.js / scopePrefixFor | 🔴 | Нет в ТЗ |
| Гость (guest) не может записывать данные | ❌ отсутствует | storage.js / setItem | 🔴 | |
| Режим ALL — только чтение | ❌ отсутствует | storage.js / isAllMode | 🔴 | |
| Глобальные ключи доступны только admin | ❌ отсутствует | storage.js / isGlobalProjectKey | 🔴 | |
| Запрещено использовать localStorage напрямую | ❌ отсутствует | storage.js / strict guard | 🔴 | Критично |
| Все операции должны идти через JKHStore | ❌ отсутствует | storage.js | 🔴 | |
| Сервер является основным источником данных | LOGIC_SPEC (server-first) | storage.js / store_dump | ⚫ | |
| Локальные данные заменяются серверными | ❌ отсутствует | storage.js / replace scope | 🔴 | |
| Нельзя перезаписать сервер пустой базой | ❌ отсутствует | storage.js / upload safeguard | 🔴 | |
| Проверяется структура abonents_db_v1 | ❌ отсутствует | storage.js / validate | 🔴 | |
| Есть whitelist ключей для upload | ❌ отсутствует | storage.js / _isUploadAllowedKey | 🔴 | |

## 🧩 Блок: Payment Engine / Ledger

| Правило | Где в ТЗ | Где в коде | Статус | Комментарий |
|--------|----------|------------|--------|------------|
| Карточка абонента — источник истины | LOGIC_SPEC | payment_table.js | ⚫ | |
| payments_<LS> = ledger (не журнал) | ❌ | payment_table.js | 🔴 | Критично |
| В одном месяце одно начисление | ❌ | ensureAutoAccruals | 🔴 | |
| Если строки нет — создаётся автоматически | ❌ | ensureAutoAccruals | 🔴 | |
| Оплаты распределяются FIFO | ❌ | allocatePaymentsFIFO | 🔴 | |
| Пеня считается по дням | ❌ | calcPenaltyForObligation | 🔴 | |
| Пеня: 30/90 дней логика | ❌ | calcPenaltyForObligation | 🔴 | |
| Ставка берётся на каждый день | ❌ | rateOnDate | 🔴 | |
| Долг = начисления - оплаты | LOGIC_SPEC | calcTotalsAsOf | ⚫ | |
| Переплата = отрицательный долг | ❌ | calcTotalsAsOf | 🔴 | |
| Начисление = тариф × площадь | ❌ | tariffSumForMonth | 🔴 | |
| Начисление делится по собственникам | ❌ | splitAccrualByOwnership | 🔴 | Очень важно |
| Учитывается период ответственности | ❌ | getActiveResponsibilityRangeISO | 🔴 | |
| Исключённые периоды отключают пеню | LOGIC_SPEC | loadExcludes | ⚫ | |
| Любое изменение → flush на сервер | LOGIC_SPEC | savePaymentsAndFlush | ⚫ | |
| paid ≥ 0 | ❌ | normalizePaymentRow | 🔴 | |
| month/year синхронизируются с paid_date | ❌ | syncYearMonthFromPaidDate | 🔴 | |

## 🧩 Блок: AutoAccrual Engine

| Правило | Где в ТЗ | Где в коде | Статус | Комментарий |
|--------|----------|------------|--------|------------|
| Автоначисление создаёт строки | ❌ | ensureAutoAccruals | 🔴 | КРИТИЧНО |
| Начисление по диапазону ответственности | ❌ | getActiveRangeISO | 🔴 | |
| Если нет dateTo → до текущей даты | ❌ | getActiveRangeISO | 🔴 | Опасно |
| Начисление = тариф × площадь | ❌ | sumPerM2ForMonth | 🔴 | |
| Фиксированные тарифы | ❌ | fixedSum | 🔴 | |
| Смена тарифа внутри месяца делится по дням | ❌ | proRated | 🔴 | Очень важно |
| Деление между собственниками | ❌ | splitAccrualByOwnership | 🔴 | Сложная логика |
| 1 начисление на месяц | ❌ | ensureAutoAccruals | 🔴 | |
| Лишние начисления обнуляются | ❌ | ensureAutoAccruals | 🔴 | |
| Автосохранение после расчёта | ❌ | recalcForAbonent | 🔴 | |
| Зависимость от UID | ❌ | resolvePaymentsKey | 🔴 | |

## 🧩 Блок: spravka_sud (Court Report)

| Правило | Где в ТЗ | Где в коде | Статус | Комментарий |
|--------|----------|------------|--------|------------|
| Справка использует calc_engine | ❌ | buildCourtViewRows | 🔴 | |
| Справка НЕ должна менять данные | LOGIC_SPEC | read-only view guard | ✅ OK | commit 60e6ee9 |
| Используется payments_<uid> | LOGIC_SPEC | resolvePaymentsKey | ⚫ | |
| Если UID нет → блокировка | ❌ | resolvePaymentsKey | 🔴 | |
| Справка не запускает autoaccrual apply при открытии | LOGIC_SPEC | read-only view guard | ✅ OK | commit 60e6ee9 |
| Данные загружаются через server-first | LOGIC_SPEC | waitForInit | ⚫ | |
| Есть таймаут загрузки | ❌ | waitForInit | 🔴 | |
| Период выбирается пользователем | LOGIC_SPEC | loadSelectedPeriod | ⚫ | |
| Период ограничивается датой начала | ❌ | clamp logic | 🔴 | |
| Если нет даты — fatal `START_DATE_MISSING` / `RESPONSIBILITY_DATE_MISSING` | LOGIC_SPEC | resolveAbonentStartDate | ✅ OK | commit 13176e3 |
| Пеня считается по source-month | ❌ | calcPenaltyBreakdown | 🔴 | |
| Итог берётся из calc_engine | LOGIC_SPEC | calcTotalsAsOfAdjusted | ⚫ | |

## 🧩 Блок: Requisites (Organization Data)

| Правило | Где в ТЗ | Где в коде | Статус | Комментарий |
|--------|----------|------------|--------|------------|
| Реквизиты хранятся в organization_requisites_v1 | ❌ | requisites.js | 🔴 | |
| Подписанты хранятся в organization_signers_v1 | ❌ | requisites.js | 🔴 | |
| Данные привязаны к owner | LOGIC_SPEC | JKHPersist | ⚫ | |
| Используется JKHPersist (server-first запись) | ❌ | requisites.js | 🔴 | |
| Сохранение запрещено без owner | ❌ | getOwnerId | 🔴 | |
| Данные загружаются после server-first | LOGIC_SPEC | waitForDataReadyEvent | ⚫ | |
| Обязательное поле full_name | ❌ | readReqForm | 🔴 | |
| Должен быть один default подписант | ❌ | normalizeSigners | 🔴 | |
| Пустые подписанты удаляются | ❌ | normalizeSigners | 🔴 | |
| Очистка удаляет данные с сервера | ❌ | JKHPersist.remove | 🔴 | |
| Нет валидации ИНН/ОГРН | ❌ | отсутствует | 🔴 | риск |
| Нет истории изменений | ❌ | отсутствует | 🔴 | |

## 🧩 Блок: Import XLS (Data Ingestion)

| Правило | Где в ТЗ | Где в коде | Статус | Комментарий |
|--------|----------|------------|--------|------------|
| Импорт не должен угадывать структуру | ❌ | detectPrimaryHeaderStructure | 🔴 | КРИТИЧНО |
| Должен быть строгий формат входных данных | ❌ | отсутствует | 🔴 | |
| UID обязателен для платежей | LOGIC_SPEC | applyPayments | ⚫ | |
| Импорт не должен создавать абонентов без контроля | ❌ | createAbonentMinimal | 🔴 | |
| Импорт не должен менять базу напрямую | ❌ | applyPrimary | 🔴 | |
| Все операции должны идти через API | LOGIC_SPEC | частично | 🔴 | |
| Дата платежа должна быть точной | ❌ | normalizePaidDate | 🔴 | |
| Не должно быть fallback 01.MM | ❌ | normalizePaidDate | 🔴 | |
| Конфликты должны решаться сервером | ❌ | evaluatePaymentsRow | 🔴 | |
| Должен быть rollback гарантированный | ❌ | rollbackAfterFlushError | 🔴 | |
| Должен быть audit лог импорта | ❌ | отсутствует | 🔴 | |
| IMPORT-RESP-STOPPED: Импорт Excel обязан различать найденного активного абонента и найденного остановленного абонента | LOGIC_SPEC → Import XLS Strict Template Rule | web/import_xls.html: `getImportAbonentResponsibilityStatus(...)`; статус `STOPPED`; лог `[import_xls][responsibility-stopped]`; блокировка платежей после `dateTo` | ✅ OK | Проверка: шаблон 2009; ЛС 1005; период ответственности закрыт до 2026-04-30; предпросмотр показывает «УЧТЁН / РАСЧЁТ ОСТАНОВЛЕН»; платежи после 2026-04-30 не применяются. |
| IMPORT-PAYMENTS-NEW-ONLY: Импорт Excel применяет только новые платежи, а уже существующие платежи распознаёт как дубликаты и не записывает повторно. | LOGIC_SPEC → Import XLS Strict Template Rule | web/import_xls.html: `collectImportPaymentsToApply(db, options)`; `getPaymentsToApplyCount()`; `applyPayments()`; лог `[import_xls][payments-collect]` | ✅ OK | Проверка: загрузить шаблон 2009; часть платежей уже есть в базе; добавить нового абонента ЛС 1007 с UID и новым платежом; перейти в «Шаг 2 — Платежи»; кнопка показывает «Применить: добавить 1 платежей» или фактическое количество новых; после применения в `payments_<uid>` добавляются только новые платежи; дубликаты повторно не создаются. |

## 🧩 Блок: Tariffs (Accrual Source)

| Правило | Где в ТЗ | Где в коде | Статус | Комментарий |
|--------|----------|------------|--------|------------|
| Тарифы хранятся per owner | LOGIC_SPEC | tariffs_{owner} | ⚫ | |
| Ставка действует до следующей | ❌ | rates[] | 🔴 | |
| Тип тарифа влияет на расчёт | ❌ | per_m2/fixed | 🔴 | |
| Дата всегда 1-е число месяца | ❌ | normalizeISOToFirst | 🔴 | |
| Перерасчёт обязателен после изменения | ❌ | recalcAll | 🔴 | |
| Изменение тарифа влияет на ВСЕ начисления | ❌ | recalcAll | 🔴 | |
| Нет ограничений на значения | ❌ | отсутствует | 🔴 | |
| Нет истории изменений | ❌ | отсутствует | 🔴 | |
| Нет dry-run режима | ❌ | отсутствует | 🔴 | |
| Нет строгой валидации ставок | ❌ | toNum | 🔴 | |
| Нет контроля дыр в периодах | ❌ | отсутствует | 🔴 | |

## 🧩 Блок: Refinancing Rates (Penalty Input)

| Правило | Где в ТЗ | Где в коде | Статус | Комментарий |
|--------|----------|------------|--------|------------|
| Ставки глобальные (не owner) | LOGIC_SPEC | KEY_NORMAL | ⚫ | |
| Только admin может менять | LOGIC_SPEC | canEditRefRates | ⚫ | |
| Используется server-first API | LOGIC_SPEC | apiGetStore | ⚫ | |
| Ставка действует до следующей | ❌ | normalizeList | 🔴 | |
| Есть режим моратория | LOGIC_SPEC | KEY_MORA | ⚫ | |
| Ограничение 9.5% до 2027 | ❌ | UI + calc_engine | 🔴 | КРИТИЧНО |
| Нет контроля дыр | ❌ | отсутствует | 🔴 | |
| Нет истории изменений | ❌ | отсутствует | 🔴 | |
| Нет versioning | ❌ | отсутствует | 🔴 | |
| Дата в двух форматах | ❌ | toDMY / ISO | 🔴 | риск |

## 🧩 Блок: Responsibility Transfer / Debt Transfer

| Правило | Где в ТЗ | Где в коде | Статус | Комментарий |
|---|---|---|---|---|
| Единый transfer-flow через Data.transferResponsibility | LOGIC_SPEC → Financial Canon | web/data.js; web/new_abonent.html; web/abonent_card.html | ✅ OK | commit 2a42b5d |
| Создание нового абонента на квартиру с active link запрещено без transfer-flow | LOGIC_SPEC → Financial Canon | web/new_abonent.html; web/data.js | ✅ OK | Новый абонент на занятую квартиру должен идти через transfer |
| Старый период закрывается transferDate - 1, новый начинается transferDate | LOGIC_SPEC → Financial Canon | web/data.js | ✅ OK | Устраняет пересечение ответственности |
| WITH_DEBT требует успешный frozen debt calculation | LOGIC_SPEC → Financial Canon | web/data.js | ✅ OK | Silent fallback в 0 запрещён |
| WITHOUT_DEBT / NO_DEBT оставляет долг старому UID | LOGIC_SPEC → Financial Canon | web/data.js | ✅ OK | Новый UID стартует с нуля |
| UI не считает долг и не пишет transfer balance напрямую | LOGIC_SPEC → Financial Canon | web/new_abonent.html; web/abonent_card.html | ✅ OK | UI вызывает единый сервис |
| Structural transform без абонента не является transfer | LOGIC_SPEC → Financial Canon | web/data.js / premiseEvents | 🟡 PARTIAL | Зафиксировать как правило; код проверить отдельно при аудите transform |

## 🧩 Блок: P0 Silent-fallback Audit Closure

| Правило | Где в ТЗ | Где в коде | Статус | Комментарий |
|--------|----------|------------|--------|------------|
| Открытие справки, главной страницы и таблицы платежей не меняет ledger, не запускает autoaccrual apply и не вызывает flush | LOGIC_SPEC 15.1 | read-only view guards | ✅ OK | commit 60e6ee9 Block read-only view write side effects |
| Существующий повреждённый или не-array `payments_<uid>` является fatal `LEDGER_JSON_INVALID`, а не fallback `[]` | LOGIC_SPEC 15.2 | payment ledger readers | ✅ OK | commit 22f6858 Make invalid payment ledgers fatal |
| Отсутствующие, повреждённые или непокрывающие дату ставки являются fatal `RATES_MISSING` / `RATES_JSON_INVALID` / `MISSING_REQUIRED_RATE`, расчёт по `0` запрещён | LOGIC_SPEC 15.3 | calc_engine.js / refinancing readers | ✅ OK | commit 9688dbb Make refinancing rate errors fatal |
| Повреждённые или невалидные `exclude_periods_<abonentId>` являются fatal `EXCLUDES_JSON_INVALID` / `EXCLUDES_INVALID`, fallback «без исключений» запрещён | LOGIC_SPEC 15.4 | exclusion period readers | ✅ OK | commit 815c3b0 Make invalid exclusion periods fatal |
| `2000-01-01` запрещена как fallback для финансовых/судебных дат; отсутствие даты даёт `START_DATE_MISSING` / `RESPONSIBILITY_DATE_MISSING` | LOGIC_SPEC 15.5 | responsibility/start date resolution | ✅ OK | commit 13176e3 Remove default 2000 date fallback |
| Импорт платежей требует явный `payment_period` `YYYY-MM`; текущий год не используется как fallback | LOGIC_SPEC 15.6 | import payments validation | ✅ OK | commit a2ce9a0 Require explicit payment import period |
| Перенос долга `WITH_DEBT` требует успешный frozen debt calculation; ошибка расчёта/JSON не становится `principal: 0` / `penalty: 0` | LOGIC_SPEC 15.7 | debt transfer / frozen debt calculation | ✅ OK | commit Prevent unsafe zero debt transfer fallback |


## 🧩 Блок: Canonical Financial Modes

| Правило | Где в ТЗ | Где в коде | Статус | Комментарий |
| --- | --- | --- | --- | --- |
| UID-first ledger write-path | LOGIC_SPEC → Canonical Financial Modes | web/data.js / Data.writePaymentLedger | ✅ OK | Запись разрешена только в `payments_<uid>` |
| Canonical ledger reader | LOGIC_SPEC → Canonical Financial Modes | web/data.js / Data.readPaymentLedger | ✅ OK | Legacy `payments_<LS>` оставлен только read-only fallback |
| Canonical ledger writer | LOGIC_SPEC → Canonical Financial Modes | web/data.js / Data.writePaymentLedger | ✅ OK | UI вызывает service boundary |
| Transfer with debt | LOGIC_SPEC → Canonical Financial Modes | web/data.js / Data.transferResponsibility, prepareDebtTransfer | ✅ OK | Создаёт frozen debt и transfer balance |
| Transfer without debt | LOGIC_SPEC → Canonical Financial Modes | web/data.js / Data.transferResponsibility, prepareDebtTransfer | ✅ OK | `NO_DEBT` нормализуется в `WITHOUT_DEBT` |
| Frozen debt | LOGIC_SPEC → Canonical Financial Modes | web/data.js / `jkh_frozen_debt_v1:*` | ✅ OK | Запись только service layer |
| Transfer balance | LOGIC_SPEC → Canonical Financial Modes | web/data.js / `jkh_transfer_balance_v1:*` | ✅ OK | Запись только service layer |
| Financial event log | LOGIC_SPEC → Canonical Financial Modes | web/data.js / Data.recordFinancialEvent | ✅ OK | Минимальный event log добавлен |
| Duplicate protection | LOGIC_SPEC → Canonical Financial Modes | web/import_xls.html, web/new_abonent.html | 🟡 PARTIAL | Существующие проверки сохранены, общий service-level duplicate API не вводился |
| Rollback protection | LOGIC_SPEC → Canonical Financial Modes | web/data.js / transfer rollback snapshots | ✅ OK | Transfer snapshots raw keys и DB |
| Merge premises responsibility boundary | LOGIC_SPEC → Canonical Financial Modes | web/data.js / Data.mergePremises TODO/CRITICAL | 🟡 PARTIAL | Merge работает, boundary отмечен к унификации |
| Split premises future mode | LOGIC_SPEC → Canonical Financial Modes | web/data.js / Data.financialModes.SPLIT_PREMISES | ⚪ IDEA | Только enum/документационный режим, бизнес-логики split нет |

---

## 🧩 Блок: Calc summary integrity

| Правило | Где в ТЗ | Где в коде | Статус | Комментарий |
| --- | --- | --- | --- | --- |
| `calc_summary_<uid>` является derived cache, не source of truth | Задание 12 → п.1 | `web/data.js`, `web/payment_table.js`, `web/index.html`, `web/abonent_card.html` | ✅ OK | Summary используется UI только при `status === "fresh"`; финансовым source of truth не является. |
| Источники истины ограничены ledger/tariffs/rates/excludes/moratorium/responsibility/calc period | Задание 12 → п.2 | `web/data.js`, `web/calc_engine.js`, storage keys | ✅ OK | Source of truth: `payments_<uid>`, tariffs, refinancing, excludes, moratorium, responsibility, calc period; summary только derived cache. |
| Checkpoint содержит identity, период, versions и fingerprints источников истины | Задание 3 → п.1; Задание 4 → п.2; Задание 12 → п.2 | `web/data.js` | ✅ OK | Хранит `calcEngineVersion`, `canonVersion`, `summaryFormatVersion` и lightweight deterministic fingerprints без crypto layer. |
| `readCalcSummary` возвращает structured state | Задание 3 → п.3; Задание 4 → п.3; Задание 12 → п.3–4 | `web/data.js` | ✅ OK | Статусы: `fresh`, `missing`, `dirty`, `checkpoint_mismatch`, `engine_version_mismatch`, `summary_version_mismatch`, `invalid_json`, `invalid_structure`. |
| Dirty/mismatch/version mismatch/invalid блокируют старые totals | Задание 3 → п.4–5, п.7; Задание 4 → п.4; Задание 12 → п.4 | `web/payment_table.js`, `web/index.html`, `web/abonent_card.html` | ✅ OK | UI показывает «Требуется пересчёт», reason «Изменена версия расчёта» для version mismatch и не делает silent fallback. |
| Пересчёт summary выполняется только по явному действию пользователя | Задание 12 → п.5, п.8–9 | `web/abonent_card.html`, `web/payment_table.js` | ✅ OK | Read-only открытие страниц и prepare accruals не создают summary; `prepare-and-recalc` является явной пользовательской командой. |
| Выбранный calc period строго ограничивает summary | Задание 12 → п.6 | `web/data.js`, `web/abonent_card.html` | ✅ OK | Fresh summary фиксирует `periodFrom`/`periodTo`; изменение `calc_period_<uid>` делает прежний summary not-fresh. |
| Missing accruals блокируют fresh summary | Задание 12 → п.7 | `web/abonent_card.html`, `web/autoaccrual_engine.js` | ✅ OK | При отсутствующих начислениях UI показывает «Требуется пересчёт» / «Подготовить начисления», но не пишет fresh summary. |
| Изменения ledger/tariffs/rates/excludes/moratorium/responsibility/calc period инвалидируют актуальность summary | Задание 3 → п.6; Задание 12 → п.2, п.4 | `web/data.js` | ✅ OK | Dirty ставится через storage hooks и сохранение responsibility snapshot. |
| `calc_summary_<uid>` зависит от данных, версии финансовой логики и версии формата summary | Задание 4 → п.1–3, п.5–6; Задание 12 → п.1–4 | `web/data.js`, `docs/CORE/LOGIC_SPEC.md` | ✅ OK | Версии заданы ручными константами; silent upgrade/patch старого checkpoint запрещён. |
| Acceptance test Calc Summary | Задание 12 → п.10 | `tests/calc_summary_acceptance.test.js`, `package.json` | ✅ OK | Каноническая проверка: `npm run test:calc-summary:acceptance`. |


---

## 🧩 Блок: Stable Canon Sync / CalcEngine Freeze Boundary

| Правило | Где в ТЗ | Где в коде/документах | Статус | Комментарий |
| --- | --- | --- | --- | --- |
| `calc_engine.js` является единственным юридическим расчётным ядром | LOGIC_SPEC → CalcEngine Freeze Boundary | `web/calc_engine.js`; `docs/CORE/LOGIC_SPEC.md` | ✅ OK | Документально запрещён alternate calc path, second-pass/optimized-pass and perf rewrite без отдельного ТЗ. |
| UI не считает долг, пеню, FIFO или frozen debt собственной формулой | LOGIC_SPEC → CalcEngine Freeze Boundary; Canonical Financial Modes | `web/payment_table.js`, `web/data.js`, `web/spravka_sud.js` | ✅ OK | UI/service layer должен использовать CalcEngine/service boundary, а не собственный financial engine. |
| Summary/cache не являются вторым financial engine | LOGIC_SPEC → CalcEngine Freeze Boundary; Calc summary integrity | `web/data.js`, `web/payment_table.js`, `docs/CORE/LOGIC_SPEC.md` | ✅ OK | `calc_summary_<uid>` является derived cache only и используется только при `fresh`. |
| Dangerous commits `d535dba` и `6780a25` не портируются | LOGIC_SPEC → Architecture Port Audit | `docs/CORE/CHANGELOG.md`, `docs/CORE/CRITICAL_INDEX.md` | ✅ OK | DO NOT PORT: `prepareLedgerState`, precompute/perf CalcEngine pipelines, alternate totals, optimized penalty/FIFO. |
| Server Summary Layer ограничен foundation/contract | LOGIC_SPEC → Server Summary Layer — foundation only | `docs/CORE/LOGIC_SPEC.md` | 🟡 PARTIAL | Разрешены interface/contract/data boundaries; runtime engine не реализован. |
| Canonical calc period keys ограничивают summary | LOGIC_SPEC → Calc summary integrity | `web/storage.js`, `web/data.js`, `web/payment_table.js` | ✅ OK | `calc_period_<uid>` / `calc_period_active_<uid>` входят в checkpoint; изменение периода делает summary not-fresh. |
| Import strict contract and audit remain safe hardening | LOGIC_SPEC → Import contract/audit; CHANGELOG import sections | `web/import_xls.html`, backend import flow, `docs/CORE/CHANGELOG.md` | ✅ OK | Strict template/upload_rows, audit log, rollback and no silent date fallback are safe to keep. |
| Read-back validation required before legacy cleanup | LOGIC_SPEC → Architecture Port Audit | `web/storage.js`, `web/data.js` | ✅ OK | Legacy cleanup must follow successful canonical read-back, especially UID and calc-period migration. |

## 🧩 Блок: Calculation Modernization Stage 0 Freeze

| Требование / запрет | Источник | Область | Статус | Комментарий |
|---|---|---|---|---|
| `web/calc_engine.js` остаётся юридическим ядром; перенос расчётов на Python/Pandas запрещён до summary-слоя, эталонных тестов и сверки 1:1 | LOGIC_SPEC 20.1 | docs / `web/calc_engine.js` | ✅ CANON | Этап 0 фиксирует запрет переноса, а не меняет код. |
| Формула пени не меняется: 30 дней = 0, 31–90 = 1/300, 91+ = 1/130, ежедневная ставка, cap 9.5% до 01.01.2027, fatal при отсутствии ставок | LOGIC_SPEC 20.2 | `web/calc_engine.js` | ✅ CANON | Любое изменение требует отдельного этапа и сверки. |
| FIFO не меняется: старые начисления закрываются первыми, платёж без периода не уходит в будущее, аванс не маскирует ошибки | LOGIC_SPEC 20.3 | `web/calc_engine.js` / ledger | ✅ CANON | Optimized/precomputed FIFO запрещён на текущем этапе. |
| `index.html` остаётся read-only при открытии: нет autoaccrual apply, записи `payments_<uid>`, flush/upload и массового пересчёта | LOGIC_SPEC 20.4 | `web/index.html` | ✅ CANON | Главная страница должна читать готовые итоги, а не пересчитывать всех молча. |
| Frontend summary/cache/table totals являются derived data only, не юридическим source of truth | LOGIC_SPEC 20.5 | frontend summary / UI totals | ✅ CANON | Долг и пеня остаются через канонический расчётный слой. |
| SQL payments — будущий этап; canonical ledger остаётся `payments_<uid>` | LOGIC_SPEC 20.6 | storage / future SQL | ✅ CANON | Миграции БД и смена source of truth запрещены в Этапе 0. |
| `/api/store_dump` нельзя удалять или ломать до завершения server-first summary-слоя | LOGIC_SPEC 20.7 | backend store dump | ✅ CANON | Старый механизм загрузки данных сохраняется для совместимости. |
| silent fallback запрещён для LEDGER/RATES/EXCLUDES/START_DATE/RESPONSIBILITY ошибок | LOGIC_SPEC 20.8 | calc inputs / readers | ✅ CANON | Ошибки не превращаются в 0, пустой массив или успешный расчёт. |
| Следующий этап — summary-дизайн: `abonent_summary`, `summary_status`, recalculation по `affected_uids`, `index.html` читает готовые итоги | LOGIC_SPEC 20.9 | future summary layer | ✅ CANON | Summary остаётся derived cache без собственной финансовой формулы. |


## 🧩 Блок: Calculation Modernization Stage 1 — Summary Design Contract

| Требование / запрет | Источник | Область | Статус | Комментарий |
|---|---|---|---|---|
| Future `abonent_summary` хранит производные итоги абонента для быстрой главной страницы и не является юридическим движком | LOGIC_SPEC 21.1 | future summary layer / docs only | ⚪ IDEA | Этап 1 фиксирует контракт без создания таблицы, миграции или runtime-кода. |
| `abonent_summary` хранит результат только из канонического расчётного слоя и не имеет собственной формулы долга, пени или FIFO | LOGIC_SPEC 21.1 | future summary layer / CalcEngine boundary | ⚪ IDEA | Запрещён frontend/backend summary как второй financial engine. |
| `summary_status` допускает только `fresh`, `dirty`, `missing`, `error` | LOGIC_SPEC 21.2 | future summary API / UI | ⚪ IDEA | `error` нельзя превращать в ноль, `missing` нельзя показывать как нулевой долг, `dirty` нельзя показывать как юридически свежий итог. |
| `summary_reason` хранит диагностическую причину статуса | LOGIC_SPEC 21.3 | future summary API / UI | ⚪ IDEA | Базовые причины включают `OK`, `LEDGER_JSON_INVALID`, `RATES_MISSING`, `MISSING_REQUIRED_RATE`, `SUMMARY_NOT_BUILT`, `DATA_DIRTY`. |
| Dirty-механика помечает конкретные UID вместо синхронного пересчёта всей базы | LOGIC_SPEC 21.4 | future mark-dirty flow | ⚪ IDEA | Изменения ledger, Excel-платежей, ручных начислений, calc period, excludes, moratorium, transfer/frozen debt, responsibility links и дат расчёта делают affected UID dirty. |
| `affected_uids` описывает UID, затронутые операцией | LOGIC_SPEC 21.5 | future import/edit/tariff/rate flows | ⚪ IDEA | Excel import, правка платежа, изменение тарифа и изменение ставки должны формировать ограниченный список affected UID. |
| Future `GET /api/abonents?page=1&limit=50&sort=total_debt&order=desc&query=` возвращает страницу абонентов и summary-итоги | LOGIC_SPEC 21.6 | future API / index page | ⚪ IDEA | API не реализован в Stage 1; контракт нужен для лёгкой главной страницы. |
| `index.html` запрашивает только одну страницу и показывает `summary_status` рядом с итогами | LOGIC_SPEC 21.6 | future `index.html` | ⚪ IDEA | Главная страница не читает все `payments_<uid>`, не запускает autoaccrual/recalc и не делает flush/upload. |
| `POST /api/abonent_summary/rebuild` является отдельным explicit write-path для заполнения `abonent_summary` | LOGIC_SPEC 21.7 | `backend/app.py`, `backend/tests/test_abonent_summary_rebuild.py` | ✅ OK | Endpoint требует авторизацию, берёт owner только из сессии и создаёт/обновляет controlled missing summary без расчёта. |
| `GET /api/abonent_summary` остаётся строго read-only и не создаёт missing rows | LOGIC_SPEC 21.7, 21.9 | `backend/app.py`, `backend/tests/test_abonent_summary_contract.py`, `backend/tests/test_abonent_summary_rebuild.py` | ✅ OK | GET не пишет в БД, не читает `payments_<uid>` и не запускает rebuild/fallback. |
| До появления backend-расчёта rebuild не пишет нулевые totals | LOGIC_SPEC 21.7 | `backend/app.py`, `backend/tests/test_abonent_summary_rebuild.py` | ✅ OK | `summary_json` содержит `missing` / `SUMMARY_NOT_BUILT`, identity и period placeholders; `total_debt` / `total_penalty` не синтезируются. |
| Single UID upsert `POST /api/abonent_summary/rebuild` сохраняет frontend CalcEngine summary после пересчёта карточки | LOGIC_SPEC 21.7.1 | `backend/app.py`, `web/data.js`, `web/abonent_card.html`, `backend/tests/test_abonent_summary_rebuild.py` | ✅ OK | Body с `account_uid` + object `summary` выполняет upsert только текущего UID; owner берётся из server session. |
| `abonent_summary` остаётся derived-cache, а не новым финансовым движком | LOGIC_SPEC 21.7.1 | `backend/app.py`, `web/abonent_card.html`, `web/calc_engine.js` | ✅ OK | Backend сохраняет переданный summary и не считает долг/пеню; `web/calc_engine.js` не изменяется. |
| Future `POST /api/recalc/mark-dirty` помечает `affected_uids` как dirty | LOGIC_SPEC 21.8 | future API | ⚪ IDEA | API не реализован в Stage 1. |
| Future `POST /api/recalc/batch` пересчитывает только указанные UID и возвращает результат по каждому UID | LOGIC_SPEC 21.8 | future API / batch recalc | ⚪ IDEA | Один ошибочный UID не останавливает batch; ошибка сохраняется как `summary_status = error` и `summary_reason`. |
| `index.html` при открытии является read-only страницей | LOGIC_SPEC 21.9 | future and current page-open boundary | ✅ CANON | Запрещены чтение всех `payments_<uid>`, autoaccrual apply, recalc all, запись ledger, flush/upload, создание missing ledger и маскировка missing/error summary нулями. |
| Stage 1 PR не меняет код и не добавляет реализацию | LOGIC_SPEC 21.10 | limited backend write-path | ✅ CANON | Исторический Stage 1 был docs-only; текущий этап разрешает только explicit rebuild endpoint и тесты, не затрагивая frontend/calc engine. |
