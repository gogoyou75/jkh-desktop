# AUDIT_GAPS_AND_TODO_TABLE — что было пропущено / что надо сделать

Дата: **2026-05-04**  
Обновлено: **2026-05-14** — Calc Summary pipeline закрыт как DONE.  
Источник: аудит `TRACEABILITY_MATRIX.md`, `LOGIC_SPEC.md`, ключевых frontend-файлов.

---

## Легенда

| Статус | Значение |
|---|---|
| DOC-GAP | Правило есть в коде, но плохо/неполно описано в LOGIC_SPEC |
| CODE-FIX | В LOGIC_SPEC правило есть, но код ему противоречит или требует исправления |
| ARCH-RISK | Архитектурный риск, пока не обязательно баг |
| FEATURE | Нужно добавить как отдельную функцию/улучшение |
| VERIFY | Нужно перепроверить по коду/сценарию |

---

## Таблица задач

| № | Зона | Что обнаружено | Тип | Приоритет | Что сделать | Куда внести |
|---:|---|---|---|---|---|---|
| 1 | CalcEngine / ставки | Ограничение ставки 9.5% до 01.01.2027 было в коде/UI, но не было закреплено | DONE | P0 | Перенесено в LOGIC_SPEC (раздел 6.3) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 2 | CalcEngine / ставки | Если дата расчёта раньше первой доступной ставки, CalcEngine больше не применяет первую ставку задним числом | DONE | P0 | Исправлено в calc_engine.js: rateOnDate возвращает null до первой ставки, расчёт пени останавливается через MISSING_REQUIRED_RATE | calc_engine.js / LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 3 | CalcEngine / платежи | FIFO есть в коде, но не было раскрыто в ТЗ | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел 6.4) как обязательная модель распределения оплат | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 4 | CalcEngine / платежи | Платёж без периода не должен применяться к будущим начислениям и должен гасить задолженность по принципу FIFO | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел 6.4, правила распределения платежей) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 5 | CalcEngine / переплата | Переплата/аванс описана недостаточно | DONE | P1 | Перенесено в LOGIC_SPEC v1.9.2 (раздел 6.6): переплата учитывается как аванс, сначала уменьшает основной долг, затем может участвовать в уменьшении пени по правилам CalcEngine | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 6 | Payments | Устаревшие CRITICAL-комментарии payments_<LS> заменены на актуальный формат payments_<uid> с указанием legacy-статуса | DONE | P0 | Обновлены комментарии без изменения логики | payment_table.js / spravka_sud.js / autoaccrual_engine.js / CHANGELOG |
| 7 | Payments | Ledger является помесячной рабочей таблицей, а не event-log | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Payments / модель ledger) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 8 | Payments | В одном месяце допускается несколько строк, но начисление должно быть только в одной | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Payments / одно начисление на месяц) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 9 | Storage | Формат scoped key `jkhdb::<owner>::<key>` не описан как внутренний контракт | DONE | P1 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Storage / scoped keys) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 10 | Storage | Запрет прямого localStorage не закреплён достаточно жёстко | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Storage / границы JKHStore/JKHPersist) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 11 | Storage | Гость/ALL read-only есть в коде, но нужно закрепить в ТЗ | DONE | P1 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Storage / права доступа) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 12 | Storage | Empty DB overwrite protection есть как защита, но нужна регресс-проверка | VERIFY | P1 | Добавить тест “пустая база не затирает сервер” | TESTS |
| 13 | AutoAccrual | Autoaccrual создаёт строки и фактически создаёт долг | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел AutoAccrual / генерация начислений) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 14 | AutoAccrual | Нет dry-run/preview перед массовым пересчётом | FEATURE | P1 | Добавить режим предварительного расчёта без записи | future TASK |
| 15 | AutoAccrual | Зависимость от корректности `links` не описана достаточно жёстко | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Responsibility / требования к links) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 16 | AutoAccrual | Открытый период без `dateTo` начисляется до текущего месяца | DONE | P1 | Перенесено в LOGIC_SPEC v1.9.2 (раздел AutoAccrual / открытый период) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 17 | AutoAccrual | Смена тарифа внутри месяца делится по дням | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Tariffs / pro-rated расчёт) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 18 | AutoAccrual | Смена ответственного внутри месяца делится по дням | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Responsibility / деление по дням) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 19 | Spravka | Справка может запускать autoaccrual и менять ledger | DONE | P0 | Read-only открытие справки не меняет ledger, не запускает autoaccrual apply и не вызывает flush | LOGIC_SPEC / TRACEABILITY / CHANGELOG; commit 60e6ee9 Block read-only view write side effects |
| 20 | Spravka | fallback `2000-01-01` опасен | DONE | P0 | Запрещён fake-date fallback; отсутствие даты завершает расчёт `START_DATE_MISSING` / `RESPONSIBILITY_DATE_MISSING` | LOGIC_SPEC / TRACEABILITY / CHANGELOG; commit 13176e3 Remove default 2000 date fallback |
| 21 | Spravka | Судебная разбивка пени по source-month плохо описана | DONE | P1 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Spravka / структура судебной таблицы) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 22 | Spravka | Таймаут ожидания data-ready 8 секунд может давать ложные отказы | ARCH-RISK | P2 | Добавить retry и корректное сообщение пользователю | future TASK |
| 23 | Requisites | Нет валидации ИНН/ОГРН/email | FEATURE | P2 | Добавить проверки формата | requisites.js / LOGIC_SPEC |
| 24 | Requisites | Нет истории изменений реквизитов | FEATURE | P2 | Добавить audit log | backend/future TASK |
| 25 | Requisites | Правило одного default signer не было зафиксировано | DONE | P1 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Requisites / подписанты) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 26 | Import XLS | Импорт больше не применяет данные из auto-detect / legacy field-map | DONE | P0 | Рабочий импорт разрешён только через strict-template; auto-detect оставлен только для диагностики/preview | import_xls.html / app.py / LOGIC_SPEC / CHANGELOG |
| 27 | Import XLS | fallback даты платежа на `01.MM.YYYY` запрещён для применения платежей | DONE | P0 | Исправлено в import_xls.html: платеж без точной даты блокируется, период не используется как дата оплаты | import_xls.html / LOGIC_SPEC / CHANGELOG (аудит 2026-05-04) |
| 28 | Import XLS | Часть логики импорта клиентская, часть серверная | ARCH-RISK | P0 | Перенести применение платежей и конфликтов на сервер | future TASK |
| 29 | Import XLS | Нужен полноценный audit log импорта | FEATURE | P0 | Логировать batch/row/result | backend import |
| 30 | Import XLS | Rollback не гарантирован полностью | ARCH-RISK | P0 | Сделать транзакционный apply на сервере | backend import |
| 31 | Tariffs | Модель `per_m2`/`fixed_month` не была полно описана | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Tariffs / модель) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 32 | Tariffs | Ставка тарифа действует до следующей записи | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Tariffs / историческая модель) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 33 | Tariffs | Нет dry-run перерасчёта всем абонентам | FEATURE | P1 | Добавить preview перерасчёта | future TASK |
| 34 | Tariffs | Нет истории изменения тарифов | FEATURE | P1 | Добавить audit/history | backend/future TASK |
| 35 | Tariffs | Нет строгих min/max ограничений значений | FEATURE | P1 | Добавить валидацию значений | tariffs.html / LOGIC_SPEC |
| 36 | Refinancing | Ставки фактически GLOBAL, а не owner-level | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Refinancing / global model) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
| 37 | Refinancing | Два формата дат повышают риск ошибки | ARCH-RISK | P1 | Утвердить единый формат хранения (ISO) | LOGIC_SPEC / future TASK |
| 38 | Refinancing | Нет истории изменения ставок | FEATURE | P0 | Добавить audit log ставок | backend/future TASK |
| 39 | Refinancing | Нет проверки “дыр” до первой ставки | DONE | P0 | Отсутствие/повреждение/непокрытие ставок стало fatal: `RATES_MISSING` / `RATES_JSON_INVALID` / `MISSING_REQUIRED_RATE`; ставка `0` как fallback запрещена | LOGIC_SPEC / TRACEABILITY / CHANGELOG; commit 9688dbb Make refinancing rate errors fatal |
| 40 | Docs | Старые документы содержат конфликтующие записи | ARCH-RISK | P0 | Вести DOCS_INVENTORY и переносить смысл в CORE | docs/0_CORE/DOCS_INVENTORY.md |
| 41 | Import Backend | Сервер записывал платежи в payments_<LS> вместо payments_<uid> | DONE | P0 | Исправлено в app.py (apply endpoint) | app.py / LOGIC_SPEC / CHANGELOG |
| 42 | Import Backend | apply мог выполняться при наличии invalid / non-ready строк | DONE | P0 | Запрещён запуск apply без полной валидации: apply доступен только из ready_to_apply, все строки должны быть ready | app.py / backend/tests/test_import_payments.py / LOGIC_SPEC / CHANGELOG |
| 43 | Import Contract | Frontend и backend имели разные правила нормализации платежей | DONE | P0 | Введён единый контракт upload_rows: UID, ЛС, ISO date, YYYY-MM period, amount number, source_index | import_xls.html / app.py / LOGIC_SPEC / CHANGELOG |
| 44 | Import Audit | Отсутствовал полный audit log по батчу | DONE | P0 | Добавлен batch-level и row-level audit log + summary endpoint | app.py / LOGIC_SPEC / CHANGELOG |
| 45 | Import Rollback | rollback не гарантировал консистентность при сбое | DONE | P0 | Убран flush, усилен rollback, добавлен error audit log | app.py / LOGIC_SPEC / CHANGELOG |
| 46 | Import XLS | Добавлена поддержка строгого шаблона CUSTOMER_2009 по карте 0–77 | DONE | P0 | Шаблон заказчика 2009 читается как strict-template-customer-2009 без auto-detect | import_xls.html / LOGIC_SPEC / CHANGELOG |
| 47 | Import UX | После создания абонента/изменения площади терялись настройки и сбивался сценарий оператора | DONE | P1 | Сохранены draft/resume опции, добавлены подсказки, проверена кнопка платежей | import_xls.html / premises / LOGIC_SPEC / CHANGELOG |
| 48 | Import DB Migration | Backend ожидал новые поля import_batches, но MySQL-схема не была обновлена | DONE | P0 | Добавлена миграция и deploy-check | LOGIC_SPEC / CHANGELOG / DEPLOY |
| 49 | Import E2E | Нет сквозной проверки импорта frontend→backend→DB | DONE | P1 | Добавлены E2E тесты импорта | tests / CHANGELOG |
| 50 | Import Idempotency | Нужна проверка защиты от повторного импорта платежей | DONE | P1 | Добавлены тесты duplicate/idempotency | tests / LOGIC_SPEC / CHANGELOG |
| 51 | Import Fingerprint | Возможны ложные дубли без source_index | DONE | P1 | Добавлен source_index в fingerprint | tests / LOGIC_SPEC / CHANGELOG |
| 52 | Read-only pages | Открытие справки, главной страницы и таблицы платежей не должно иметь write-side-effects | DONE | P0 | Ledger не меняется, autoaccrual apply и flush не запускаются из read-only открытия | LOGIC_SPEC / TRACEABILITY / CHANGELOG; commit 60e6ee9 Block read-only view write side effects |
| 53 | Ledger integrity | Повреждённый или не-array `payments_<uid>` раньше мог превращаться в `[]` | DONE | P0 | Существующий невалидный ledger завершает операцию `LEDGER_JSON_INVALID`; fallback `[]` запрещён | LOGIC_SPEC / TRACEABILITY / CHANGELOG; commit 22f6858 Make invalid payment ledgers fatal |
| 54 | Refinancing | Отсутствующие/повреждённые/непокрывающие дату ставки не должны давать расчёт по `0` | DONE | P0 | Fatal-коды: `RATES_MISSING`, `RATES_JSON_INVALID`, `MISSING_REQUIRED_RATE`; ставка `0` как fallback запрещена | LOGIC_SPEC / TRACEABILITY / CHANGELOG; commit 9688dbb Make refinancing rate errors fatal |
| 55 | Exclusion periods | Повреждённые `exclude_periods_<abonentId>` или невалидные даты не должны игнорироваться | DONE | P0 | Fatal-коды: `EXCLUDES_JSON_INVALID`, `EXCLUDES_INVALID`; расчёт «как будто исключений нет» запрещён | LOGIC_SPEC / TRACEABILITY / CHANGELOG; commit 815c3b0 Make invalid exclusion periods fatal |
| 56 | Fake dates | `2000-01-01` нельзя использовать как fallback для финансовых/судебных дат | DONE | P0 | Отсутствие даты начала расчёта/ответственности завершает операцию `START_DATE_MISSING` / `RESPONSIBILITY_DATE_MISSING` | LOGIC_SPEC / TRACEABILITY / CHANGELOG; commit 13176e3 Remove default 2000 date fallback |
| 57 | Import period | Импорт платежей не должен использовать текущий год как fallback периода | DONE | P0 | `payment_period` обязателен в формате `YYYY-MM`; строка без явного периода не применяется | LOGIC_SPEC / TRACEABILITY / CHANGELOG; commit a2ce9a0 Require explicit payment import period |
| 58 | Responsibility transfer / Debt transfer | Передача ответственности должна идти через единый `Data.transferResponsibility(...)`; `WITH_DEBT` не должен превращать ошибку frozen debt calculation в нулевой долг | DONE | P0 | Финансовый канон зафиксирован: active link требует transfer-flow, периоды закрываются/открываются по `transferDate`, `WITH_DEBT` требует successful frozen debt calculation, `WITHOUT_DEBT` оставляет долг старому UID | LOGIC_SPEC / TRACEABILITY / CHANGELOG; commit 2a42b5d Enforce canonical responsibility transfer flow |
| 59 | Calc Summary pipeline | Канон Calc Summary должен быть завершён и синхронизирован с кодом: summary только derived cache, source of truth — ledger/tariffs/rates/excludes/moratorium/responsibility/calc period, fresh-only read, explicit recalc, strict calc period boundary, missing accruals block fresh summary | DONE | P0 | Pipeline закрыт: stale/dirty/mismatch/invalid/missing → «Требуется пересчёт»; prepare accruals не создаёт summary; prepare-and-recalc — явная команда; acceptance test `npm run test:calc-summary:acceptance` | LOGIC_SPEC / TRACEABILITY / CHANGELOG; chain 1994f4d → b092e78 |
---

## Ближайший порядок работ

1. **P0 silent-fallback audit:** закрыт, правила перенесены в LOGIC_SPEC / TRACEABILITY / CHANGELOG.
2. **P0 документация:** поддерживать LOGIC_SPEC v1.9.3 как актуальный канон.
3. **P0 комментарии:** заменить устаревшие `payments_<LS>` в CRITICAL-блоках на `payments_<uid>` или пометить legacy.
4. **P0 импорт:** не допускать новых guessed-date / guessed-period fallback.
5. **P1 тарифы:** добавить dry-run перерасчёта.
6. **P1 аудит:** завести `DOCS_INVENTORY.md` и разбирать старые документы только через него.

---

## Что НЕ делать сейчас

- Не удалять старые документы физически.
- Не переписывать calc_engine без отдельного ТЗ.
- Не делать массовый refactor import_xls без серверной транзакционной схемы.
- Не переносить долги при split/merge без отдельного финансового ТЗ.
