# AUDIT_GAPS_AND_TODO_TABLE — что было пропущено / что надо сделать

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
*| 1 | CalcEngine / ставки | Ограничение ставки 9.5% до 01.01.2027 было в коде/UI, но не было закреплено | DONE | P0 | Перенесено в LOGIC_SPEC (раздел 6.3) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 2 | CalcEngine / ставки | Если дата расчёта раньше первой доступной ставки, CalcEngine больше не применяет первую ставку задним числом | DONE | P0 | Исправлено в calc_engine.js: rateOnDate возвращает null до первой ставки, расчёт пени останавливается через MISSING_REQUIRED_RATE | calc_engine.js / LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 3 | CalcEngine / платежи | FIFO есть в коде, но не было раскрыто в ТЗ | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел 6.4) как обязательная модель распределения оплат | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 4 | CalcEngine / платежи | Платёж без периода не должен применяться к будущим начислениям и должен гасить задолженность по принципу FIFO | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел 6.4, правила распределения платежей) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 5 | CalcEngine / переплата | Переплата/аванс описана недостаточно | DONE | P1 | Перенесено в LOGIC_SPEC v1.9.2 (раздел 6.6): переплата учитывается как аванс, сначала уменьшает основной долг, затем может участвовать в уменьшении пени по правилам CalcEngine | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 6 | Payments | Устаревшие CRITICAL-комментарии payments_<LS> заменены на актуальный формат payments_<uid> с указанием legacy-статуса | DONE | P0 | Обновлены комментарии без изменения логики | payment_table.js / spravka_sud.js / autoaccrual_engine.js / CHANGELOG |
*| 7 | Payments | Ledger является помесячной рабочей таблицей, а не event-log | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Payments / модель ledger) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) | |
*| 8 | Payments | В одном месяце допускается несколько строк, но начисление должно быть только в одной | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Payments / одно начисление на месяц) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 9 | Storage | Формат scoped key `jkhdb::<owner>::<key>` не описан как внутренний контракт | DONE | P1 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Storage / scoped keys) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 10 | Storage | Запрет прямого localStorage не закреплён достаточно жёстко | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Storage / границы JKHStore/JKHPersist) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 11 | Storage | Гость/ALL read-only есть в коде, но нужно закрепить в ТЗ | DONE | P1 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Storage / права доступа) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 12 | Storage | Empty DB overwrite protection есть как защита, но нужна регресс-проверка | VERIFY | P1 | Добавить тест “пустая база не затирает сервер” | TESTS |
*| 13 | AutoAccrual | Autoaccrual создаёт строки и фактически создаёт долг | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел AutoAccrual / генерация начислений) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 14 | AutoAccrual | Нет dry-run/preview перед массовым пересчётом | FEATURE | P1 | Добавить режим предварительного расчёта без записи | future TASK |
*| 15 | AutoAccrual | Зависимость от корректности `links` не описана достаточно жёстко | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Responsibility / требования к links) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 16 | AutoAccrual | Открытый период без `dateTo` начисляется до текущего месяца | DONE | P1 | Перенесено в LOGIC_SPEC v1.9.2 (раздел AutoAccrual / открытый период) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 17 | AutoAccrual | Смена тарифа внутри месяца делится по дням | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Tariffs / pro-rated расчёт) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 18 | AutoAccrual | Смена ответственного внутри месяца делится по дням | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Responsibility / деление по дням) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 19 | Spravka | Справка может запускать autoaccrual и менять ledger | ARCH-RISK | P0 | Вынести autoaccrual из справки или явно ограничить через подготовительный сценарий | future TASK / LOGIC_SPEC |
*| 20 | Spravka | fallback `2000-01-01` опасен | CODE-FIX | P0 | Заменить на остановку расчёта с понятной ошибкой | spravka_sud.js |
*| 21 | Spravka | Судебная разбивка пени по source-month плохо описана | DONE | P1 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Spravka / структура судебной таблицы) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 22 | Spravka | Таймаут ожидания data-ready 8 секунд может давать ложные отказы | ARCH-RISK | P2 | Добавить retry и корректное сообщение пользователю | future TASK |
*| 23 | Requisites | Нет валидации ИНН/ОГРН/email | FEATURE | P2 | Добавить проверки формата | requisites.js / LOGIC_SPEC |
*| 24 | Requisites | Нет истории изменений реквизитов | FEATURE | P2 | Добавить audit log | backend/future TASK |
*| 25 | Requisites | Правило одного default signer не было зафиксировано | DONE | P1 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Requisites / подписанты) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 26 | Import XLS | Импорт больше не применяет данные из auto-detect / legacy field-map | DONE | P0 | Рабочий импорт разрешён только через strict-template; auto-detect оставлен только для диагностики/preview | import_xls.html / app.py / LOGIC_SPEC / CHANGELOG |
*| 27 | Import XLS | fallback даты платежа на `01.MM.YYYY` запрещён для применения платежей | DONE | P0 | Исправлено в import_xls.html: платеж без точной даты блокируется, период не используется как дата оплаты | import_xls.html / LOGIC_SPEC / CHANGELOG (аудит 2026-05-04) |
*| 28 | Import XLS | Часть логики импорта клиентская, часть серверная | ARCH-RISK | P0 | Перенести применение платежей и конфликтов на сервер | future TASK |
*| 29 | Import XLS | Нужен полноценный audit log импорта | FEATURE | P0 | Логировать batch/row/result | backend import |
*| 30 | Import XLS | Rollback не гарантирован полностью | ARCH-RISK | P0 | Сделать транзакционный apply на сервере | backend import |
*| 31 | Tariffs | Модель `per_m2`/`fixed_month` не была полно описана | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Tariffs / модель) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 32 | Tariffs | Ставка тарифа действует до следующей записи | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Tariffs / историческая модель) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 33 | Tariffs | Нет dry-run перерасчёта всем абонентам | FEATURE | P1 | Добавить preview перерасчёта | future TASK |
*| 34 | Tariffs | Нет истории изменения тарифов | FEATURE | P1 | Добавить audit/history | backend/future TASK |
*| 35 | Tariffs | Нет строгих min/max ограничений значений | FEATURE | P1 | Добавить валидацию значений | tariffs.html / LOGIC_SPEC |
*| 36 | Refinancing | Ставки фактически GLOBAL, а не owner-level | DONE | P0 | Перенесено в LOGIC_SPEC v1.9.2 (раздел Refinancing / global model) | LOGIC_SPEC / TRACEABILITY / CHANGELOG (аудит 2026-05-04) |
*| 37 | Refinancing | Два формата дат повышают риск ошибки | ARCH-RISK | P1 | Утвердить единый формат хранения (ISO) | LOGIC_SPEC / future TASK |
*| 38 | Refinancing | Нет истории изменения ставок | FEATURE | P0 | Добавить audit log ставок | backend/future TASK |
*| 39 | Refinancing | Нет проверки “дыр” до первой ставки | CODE-FIX | P0 | Запретить расчёт до первой ставки | calc_engine.js / refinancing |
*| 40 | Docs | Старые документы содержат конфликтующие записи | ARCH-RISK | P0 | Вести DOCS_INVENTORY и переносить смысл в CORE | docs/0_CORE/DOCS_INVENTORY.md |
*| 41 | Import Backend | Сервер записывал платежи в payments_<LS> вместо payments_<uid> | DONE | P0 | Исправлено в app.py (apply endpoint) | app.py / LOGIC_SPEC / CHANGELOG |
*| 42 | Import Backend | apply мог выполняться при наличии invalid / non-ready строк | DONE | P0 | Запрещён запуск apply без полной валидации: apply доступен только из ready_to_apply, все строки должны быть ready | app.py / backend/tests/test_import_payments.py / LOGIC_SPEC / CHANGELOG |
*| 43 | Import Contract | Frontend и backend имели разные правила нормализации платежей | DONE | P0 | Введён единый контракт upload_rows: UID, ЛС, ISO date, YYYY-MM period, amount number, source_index | import_xls.html / app.py / LOGIC_SPEC / CHANGELOG |
*| 44 | Import Audit | Отсутствовал полный audit log по батчу | DONE | P0 | Добавлен batch-level и row-level audit log + summary endpoint | app.py / LOGIC_SPEC / CHANGELOG |
*| 45 | Import Rollback | rollback не гарантировал консистентность при сбое | DONE | P0 | Убран flush, усилен rollback, добавлен error audit log | app.py / LOGIC_SPEC / CHANGELOG |
*| 46 | Import XLS | Добавлена поддержка строгого шаблона CUSTOMER_2009 по карте 0–77 | DONE | P0 | Шаблон заказчика 2009 читается как strict-template-customer-2009 без auto-detect | import_xls.html / LOGIC_SPEC / CHANGELOG |
*| 47 | Import UX | После создания абонента/изменения площади терялись настройки и сбивался сценарий оператора | DONE | P1 | Сохранены draft/resume опции, добавлены подсказки, проверена кнопка платежей | import_xls.html / premises / LOGIC_SPEC / CHANGELOG |
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
