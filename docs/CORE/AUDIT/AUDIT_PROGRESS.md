# AUDIT_GAPS_AND_TODO_TABLE — что было пропущено / что надо сделать

## Stage 16 bulk-calc-verify update

- Added verify-only backend shell for explicit UID batches.
- Scope is limited to persisted `abonent_summary` versus persisted `card_snapshot` comparison.
- No `calc_engine.js` changes, no Python/Pandas financial calculation, no summary apply, no `payments_<LS>` fallback.
- Remaining audit risk: backend can verify only persisted results that were produced earlier by the existing explicit card calculation path; it does not independently recompute legal formulas.

Дата: **2026-05-04**  
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
| 1 | CalcEngine / ставки | Ограничение ставки 9.5% до 01.01.2027 было в коде/UI, но не было явно закреплено в LOGIC_SPEC | DOC-GAP | P0 | Внести как критическое юридическое правило | LOGIC_SPEC / TRACEABILITY / CHANGELOG |
| 2 | CalcEngine / ставки | Если дата раньше первой ставки, код может брать первую ставку назад во времени | CODE-FIX | P0 | Остановить расчёт с понятным предупреждением | calc_engine.js / spravka_sud.js / карточка |
| 3 | CalcEngine / платежи | FIFO есть в коде, но не было раскрыто в ТЗ | DOC-GAP | P0 | Описать FIFO как обязательную модель распределения оплат | LOGIC_SPEC |
| 4 | CalcEngine / платежи | Платёж без периода не должен уходить в будущее | DOC-GAP | P0 | Закрепить правило и тест | LOGIC_SPEC / regression tests |
| 5 | CalcEngine / переплата | Переплата/аванс описана недостаточно | DOC-GAP | P1 | Описать порядок зачёта переплаты | LOGIC_SPEC |
| 6 | Payments | Старые CRITICAL-комментарии говорят `payments_<LS>`, но текущий канон — `payments_<uid>` | CODE-FIX | P0 | Обновить комментарии, не меняя логику | payment_table.js / spravka_sud.js / autoaccrual_engine.js |
| 7 | Payments | Ledger является помесячной рабочей таблицей, а не event-log | DOC-GAP | P0 | Явно описать ledger-модель | LOGIC_SPEC |
| 8 | Payments | В одном месяце допускается несколько строк, но начисление должно быть только в одной | DOC-GAP | P0 | Закрепить правило “одно начисление на месяц” | LOGIC_SPEC / tests |
| 9 | Storage | Формат scoped key `jkhdb::<owner>::<key>` не описан как внутренний контракт | DOC-GAP | P1 | Описать как внутреннюю модель, не как внешний API | LOGIC_SPEC |
| 10 | Storage | Запрет прямого localStorage не закреплён достаточно жёстко | DOC-GAP | P0 | Зафиксировать JKHStore/JKHPersist как границы | LOGIC_SPEC / Codex rules |
| 11 | Storage | Гость/ALL read-only есть в коде, но нужно закрепить в ТЗ | DOC-GAP | P1 | Описать права guest/ALL | LOGIC_SPEC |
| 12 | Storage | Empty DB overwrite protection есть как защита, но нужна регресс-проверка | VERIFY | P1 | Добавить тест “пустая база не затирает сервер” | TESTS |
| 13 | AutoAccrual | Autoaccrual создаёт строки и фактически создаёт долг | DOC-GAP | P0 | Описать как финансово критическое действие | LOGIC_SPEC |
| 14 | AutoAccrual | Нет dry-run/preview перед массовым пересчётом | FEATURE | P1 | Добавить режим предварительного расчёта без записи | future TASK |
| 15 | AutoAccrual | Зависимость от корректности `links` не описана достаточно жёстко | DOC-GAP | P0 | Описать требования к links без пересечений/дыр | LOGIC_SPEC |
| 16 | AutoAccrual | Открытый период без `dateTo` начисляется до текущего месяца | DOC-GAP | P1 | Зафиксировать как правило и добавить лимиты безопасности | LOGIC_SPEC / tests |
| 17 | AutoAccrual | Смена тарифа внутри месяца делится по дням | DOC-GAP | P0 | Внести как канон начислений | LOGIC_SPEC |
| 18 | AutoAccrual | Смена ответственного внутри месяца делится по дням | DOC-GAP | P0 | Внести как канон ответственности | LOGIC_SPEC |
| 19 | Spravka | Справка может запускать autoaccrual и менять ledger | ARCH-RISK | P0 | Решить: оставить временно с логами или вынести в подготовительный сценарий | future TASK / LOGIC_SPEC |
| 20 | Spravka | fallback `2000-01-01` опасен | CODE-FIX | P0 | Заменить на остановку справки с ошибкой | spravka_sud.js |
| 21 | Spravka | Судебная разбивка пени по source-month плохо описана | DOC-GAP | P1 | Описать как модель судебной таблицы | LOGIC_SPEC |
| 22 | Spravka | Таймаут ожидания data-ready 8 секунд может давать ложные отказы | ARCH-RISK | P2 | Сделать понятный retry/возврат к карточке | future TASK |
| 23 | Requisites | Нет валидации ИНН/ОГРН/email | FEATURE | P2 | Добавить проверки формата | requisites.js / LOGIC_SPEC |
| 24 | Requisites | Нет истории изменений реквизитов | FEATURE | P2 | Добавить audit log | backend/future TASK |
| 25 | Requisites | Правило одного default signer не было зафиксировано | DOC-GAP | P1 | Внести в LOGIC_SPEC | LOGIC_SPEC |
| 26 | Import XLS | Импорт угадывает структуру Excel | ARCH-RISK | P0 | Сделать строгий контракт шаблона; auto-detect только preview | IMPORT_CANON / future TASK |
| 27 | Import XLS | fallback даты платежа на `01.MM.YYYY` опасен | CODE-FIX | P0 | Помечать как guessed или блокировать без явной даты | import_xls.html / server import |
| 28 | Import XLS | Часть логики импорта клиентская, часть серверная | ARCH-RISK | P0 | Перенести применение платежей/конфликтов в API | future TASK |
| 29 | Import XLS | Нужен полноценный audit log импорта | FEATURE | P0 | Логировать batch/row/fingerprint/result | backend import |
| 30 | Import XLS | Rollback не гарантирован полностью | ARCH-RISK | P0 | Делать apply на сервере транзакционно | backend import |
| 31 | Tariffs | Модель `per_m2`/`fixed_month` не была полно описана | DOC-GAP | P0 | Внести структуру тарифа в LOGIC_SPEC | LOGIC_SPEC |
| 32 | Tariffs | Ставка тарифа действует до следующей записи | DOC-GAP | P0 | Описать как историческую модель | LOGIC_SPEC |
| 33 | Tariffs | Нет dry-run перерасчёта всем абонентам | FEATURE | P1 | Добавить preview “сколько изменится” | future TASK |
| 34 | Tariffs | Нет истории изменения тарифов | FEATURE | P1 | Добавить audit/history | backend/future TASK |
| 35 | Tariffs | Нет строгих min/max ограничений значений | FEATURE | P1 | Ввести разумные валидации и предупреждения | tariffs.html / LOGIC_SPEC |
| 36 | Refinancing | Ставки фактически GLOBAL, а старый LOGIC_SPEC местами называл их owner-level | CODE-FIX | P0 | Привести LOGIC_SPEC к GLOBAL/admin-only модели | LOGIC_SPEC |
| 37 | Refinancing | Два формата дат `ДД.ММ.ГГГГ` и ISO повышают риск ошибки | ARCH-RISK | P1 | Утвердить единый storage-формат, UI может показывать DMY | LOGIC_SPEC / future TASK |
| 38 | Refinancing | Нет истории изменения ставок | FEATURE | P0 | Добавить audit log изменения ставок | backend/future TASK |
| 39 | Refinancing | Нет проверки “дыр” до первой ставки | CODE-FIX | P0 | Не считать пеню до заполнения ставки | calc_engine.js / refinancing.html |
| 40 | Docs | Старые документы содержат полезные, но конфликтующие записи | ARCH-RISK | P0 | Не удалять; вести DOCS_INVENTORY и переносить смысл в CORE | docs/0_CORE/DOCS_INVENTORY.md |

---

## Ближайший порядок работ

1. **P0 документация:** заменить `LOGIC_SPEC.md` новой версией v1.9.2.
2. **P0 код:** исправить раннюю дату ставки и fallback `2000-01-01`.
3. **P0 комментарии:** заменить устаревшие `payments_<LS>` в CRITICAL-блоках на `payments_<uid>` или пометить legacy.
4. **P0 импорт:** запретить молчаливую guessed-date запись платежей.
5. **P1 тарифы:** добавить dry-run перерасчёта.
6. **P1 аудит:** завести `DOCS_INVENTORY.md` и разбирать старые документы только через него.

---

## Что НЕ делать сейчас

- Не удалять старые документы физически.
- Не переписывать calc_engine без отдельного ТЗ.
- Не делать массовый refactor import_xls без серверной транзакционной схемы.
- Не переносить долги при split/merge без отдельного финансового ТЗ.
