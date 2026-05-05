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
| Если ставка отсутствует — ошибка | ⚪ должно быть                | calc_engine.js / loadRates  | 🟡     | Сейчас warning               |
| Если дата раньше первой ставки   | LOGIC_SPEC (правило проекта) | calc_engine.js              | 🔴     | Сейчас берётся первая ставка |

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
| Перенос долга между абонентами поддерживается через transfer balance | В LOGIC_SPEC надо добавить/уточнить | calc_engine.js → getTransferBalance | 🟡 PARTIAL | Есть совместимость со старой схемой |
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
| Справка НЕ должна менять данные | ❌ | recalcForAbonent | 🔴 | Нарушение |
| Используется payments_<uid> | LOGIC_SPEC | resolvePaymentsKey | ⚫ | |
| Если UID нет → блокировка | ❌ | resolvePaymentsKey | 🔴 | |
| Справка может запустить автоначисление | ❌ | recalcForAbonent | 🔴 | Очень опасно |
| Данные загружаются через server-first | LOGIC_SPEC | waitForInit | ⚫ | |
| Есть таймаут загрузки | ❌ | waitForInit | 🔴 | |
| Период выбирается пользователем | LOGIC_SPEC | loadSelectedPeriod | ⚫ | |
| Период ограничивается датой начала | ❌ | clamp logic | 🔴 | |
| Если нет даты — fallback 2000 год | ❌ | resolveAbonentStartDate | 🔴 | КРИТИЧНО |
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





