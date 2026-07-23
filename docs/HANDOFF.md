# HANDOFF — переход к серверному Full Recalc

## 1. ПРОЕКТ

Проект:

```text
ПАПА ЖКХ
```

Рабочая ветка:

```text
2307_pereschet_01
```

Текущий стабильный baseline:

```text
b5c4cf5baa4dc180a1bda185ae66c37cdcbd4690
```

Среда:

```text
LOCAL / LAB
```

Ограничение:

```text
PROD НЕ ОТКРЫВАТЬ
PROD НЕ ИЗМЕНЯТЬ
PROD НЕ ДЕПЛОИТЬ
```

---

## 2. ЧТО УЖЕ РЕАЛИЗОВАНО

На странице Index реализован browser-side sequential batch Full Recalc.

Сценарий:

```text
пользователь выбирает нерассчитанных абонентов
→ Index последовательно запускает существующий JavaScript Full Recalc
→ одновременно рассчитывается один UID
→ результат сохраняется
→ запускается следующий UID
```

Добавлен wrapper:

```text
Data.runPermanentFullRecalcForUid()
```

Он использует существующий расчётный путь:

```text
Data.recalculateAbonentCardWithRows()
→ Data.recalculateAbonentCard()
```

Отдельный расчётный алгоритм для Index не создавался.

---

## 3. ИСПРАВЛЁННАЯ ОШИБКА FALSE-FRESH

Ранее browser batch сохранял summary как `fresh` до проверки ledger, rowsById и snapshot.

Из-за этого абоненты с пустым ledger становились ложными `fresh`.

Исправлено в commit:

```text
b5c4cf5baa4dc180a1bda185ae66c37cdcbd4690
```

Новый порядок:

```text
Full Recalc с saveSummary: false
→ проверка ledger
→ проверка rowsById
→ сохранение snapshot
→ snapshot readback
→ сохранение summary
→ проверка persisted summary
→ complete_uid
```

Пустой ledger теперь даёт:

```text
LEDGER_ROWS_EMPTY
```

и не создаёт `fresh`.

---

## 4. LAB-ПРОВЕРКА BROWSER BATCH

Подтверждено:

```text
последовательная очередь — PASS
empty ledger skip — PASS
false-fresh protection — PASS
valid success — PASS
Index update без F5 — PASS
soft stop — PASS
lock release — PASS
beforeunload logic — PASS
Card F5 — PASS
temporary period/reset — PASS
spravka_sud UID isolation — PASS
```

Не доказаны из-за отсутствия безопасных тестовых данных:

```text
manual → batch skipped_locked при реальной гонке
batch → manual lock refusal при реальной гонке
три успешных UID подряд с непустыми ledger
нативное визуальное окно beforeunload
```

Это не подтверждённые ошибки, а непроверенные сценарии.

---

## 5. ПОДТВЕРЖДЁННАЯ ПРОБЛЕМА СКОРОСТИ

Для абонента:

```text
ЛС 1038
UID uid_mqmgnatj_dnj81p
ledger rows: 229
```

полный browser batch занял:

```text
293 412 ms
```

Этап:

```text
buildRowsByIdFromLedgerForSnapshot
```

занял:

```text
289 467 ms
```

Причина:

```text
для 229 уникальных дат
229 раз вызывается полный
JKHCalcEngine.calcTotalsAsOfAdjusted(...)
```

Каждый вызов повторно:

```text
фильтрует обязательства;
фильтрует платежи;
распределяет FIFO;
считает пени;
обрабатывает финансовые правила.
```

Проблема является CPU-проблемой JavaScript, а не сетью или сервером.

---

## 6. ПРОАНАЛИЗИРОВАННЫЕ INCREMENTAL-ПУТИ

В проекте уже найдены:

```text
experimentalBuildRowsByIdIncremental
JKHCalcEngine.computeRowsStateIncremental
experimentalBuildRowsByIdIncrementalV2
JKHCalcEngine.computeRowsStateIncrementalV2
```

Но они не являются настоящим rolling-state решением.

Они всё ещё для каждой даты повторно:

```text
фильтруют данные;
копируют обязательства;
выполняют FIFO;
считают пени.
```

V2 является экспериментальным skeleton и делегирует итоговую работу V1.

Простое включение существующих флагов не решит проблему.

---

## 7. ПРИНЯТОЕ СТРАТЕГИЧЕСКОЕ НАПРАВЛЕНИЕ

Обсуждались два пути:

### Вариант 1

Продолжать оптимизировать только browser batch.

### Вариант 2

Перенести Full Recalc на сервер и сделать качественную конечную архитектуру.

Принято направление:

```text
текущий browser batch оставить как стабильную Version 1;
не удалять и не ломать;
начать проектирование единого JavaScript Full Recalc Engine;
движок должен запускаться и браузером, и Node server worker;
не переписывать финансовые формулы на Python;
после серверного перехода оптимизировать единый движок один раз.
```

Перенос на сервер решает:

```text
независимость от открытой вкладки;
persistent jobs;
восстановление после сбоя;
серверные блокировки;
массовые фоновые расчёты;
единый источник результата.
```

Оптимизация rolling-state отдельно решает скорость.

Перенос на сервер сам по себе не устранит медленный алгоритм, но создаст правильную основу для общей оптимизации.

---

## 8. ПРЕДЛАГАЕМАЯ КОНЕЧНАЯ АРХИТЕКТУРА

```text
Index / Card
    ↓
Flask API
    ↓
persistent recalculation job
    ↓
Node Full Recalc Worker
    ↓
единый JavaScript Calc Engine
    ↓
verified full result
    ↓
ledger + snapshot + summary
```

Index и карточка должны стать панелями запуска и отображения.

Финансовые формулы должны остаться в одном JavaScript-движке.

---

## 9. ТЕКУЩАЯ ЗАДАЧА НОВОГО ЧАТА

Подготовить для CODEX read-only задание:

```text
Архитектура единого environment-neutral JavaScript Full Recalc Engine,
который можно запускать:

1. в браузере;
2. в Node server worker.
```

На первом этапе:

```text
CHANGES MADE: NONE
```

Нельзя сразу переносить код или создавать worker.

Сначала требуется архитектурный анализ.

---

## 10. ЧТО ДОЛЖЕН УСТАНОВИТЬ CODEX

CODEX должен определить:

1. Какие части Full Recalc уже независимы от браузера.

2. Какие части зависят от:

```text
window;
document;
DOM;
localStorage;
fetch;
глобального current UID;
runtime cache;
UI карточки.
```

3. Полный текущий call graph:

```text
fullRecalcForCurrentAbonent
recalculateAbonentCardWithRows
recalculateAbonentCard
calc_engine
autoaccrual_engine
ledger
snapshot
summary
```

4. Какие финансовые функции являются каноническими.

5. Какие browser-зависимости нужно заменить явными адаптерами.

6. Как должен выглядеть единый input contract:

```text
abonent;
owner;
UID;
ledger;
payments;
tariffs;
refinancing;
exclusions;
responsibility;
freeze;
transfer;
versions;
input hashes;
calculation date.
```

7. Как должен выглядеть единый result object:

```text
ledger;
rows;
rowsById;
snapshot;
summary;
totals;
versions;
metadata;
diagnostics.
```

8. Как запускать тот же JS engine из Node без копирования формул.

9. Нужен ли отдельный Node worker container.

10. Как Flask будет создавать и контролировать persistent jobs.

11. Как реализовать единый permanent lock:

```text
owner/namespace + canonical UID + permanent_full_recalc
```

12. Как выполнить атомарный verified result commit:

```text
ledger + snapshot + summary
```

13. Как сохранить temporary period отдельным и не смешать его с permanent Full Recalc.

14. Как переводить ручную карточку на серверный сервис без резкого отключения старого пути.

15. Как сравнивать browser OLD и server candidate в shadow mode.

16. Какие файлы и Docker-компоненты будут затронуты.

17. Какие миграции потребуются.

18. Какой rollback будет возможен.

19. Какие риски появятся для:

```text
карточки;
Index;
temporary period;
spravka_sud;
ledger;
snapshot;
summary;
owner isolation.
```

---

## 11. БЕЗОПАСНЫЙ ПОРЯДОК ПЕРЕХОДА

Предлагаемые этапы:

```text
Phase 1
Read-only architecture analysis.

Phase 2
Выделение environment-neutral JS engine без изменения рабочего пути.

Status: completed for the safe first slice. `web/full_recalc_core.js` owns pure permanent rows-by-id orchestration and receives the unchanged browser totals calculator by injection. Browser Full Recalc and Batch V1 remain primary; persistence and temporary mode are unchanged. Node Worker is not created. Next phase remains a no-write Node shadow runner, subject to separate authorization.

Phase 2B status: completed. The shared calculation call accepts explicit serialized responsibility, rates, exclusions, freeze, transfer and payment-period inputs. Browser compatibility still obtains these through the existing loaders before the call; formulas, persistence, temporary mode and autoaccrual are unchanged. Node Worker is not created.

Phase 3
Node shadow runner для одного UID без сохранения данных.

Status: implemented locally with no-write JSON export/CLI comparison. Browser OLD remains the canonical writer; manual LAB shadow run is NOT EXECUTED because a safe UID was not proven. No backend API, worker, job, persistence change or Node autoaccrual was added.

Phase 4
Строгое сравнение browser OLD и Node candidate.

Phase 5
Server-backed verified result commit.

Phase 6
Перевод ручного permanent Full Recalc карточки на единый сервис.

Phase 7
Persistent server batch worker.

Phase 8
Перевод Index на серверный запуск и polling.

Phase 9
Оптимизация общего buildRowsById/rolling-state алгоритма.

Phase 10
Полная LAB-регрессия и только затем отдельное решение по PROD.
```

На каждом этапе старый browser path должен сохраняться до доказательства эквивалентности.

---

## 12. ГЛАВНЫЕ ОГРАНИЧЕНИЯ

Запрещено:

```text
переписывать финансовые формулы на Python;
создавать второй независимый расчётный движок;
сразу отключать browser path;
сразу менять карточку;
смешивать temporary и permanent;
сохранять частичный результат как fresh;
включать новый путь в PROD;
менять формулы FIFO, пени, тарифов или округления.
```

---

## 13. WORKFLOW

Использовать Workflow Standard проекта «ПАПА ЖКХ».

Сначала CODEX должен вернуть:

```text
CONFIRMED
NOT PROVEN
Root Cause
First Divergence Point
CURRENT CALL GRAPH
BROWSER DEPENDENCIES
CANONICAL ENGINE BOUNDARY
INPUT CONTRACT
OUTPUT CONTRACT
NODE EXECUTION OPTIONS
WORKER DESIGN
ATOMIC COMMIT DESIGN
MIGRATION PLAN
ROLLBACK PLAN
AFFECTED FILES
REGRESSION RISKS
IMPLEMENTATION PHASES
CHANGES MADE: NONE
PROD NOT TOUCHED
```

До анализа изменений кода не разрешать.

---

## 14. ПЕРВАЯ ФРАЗА В НОВОМ ЧАТЕ

Продолжаем работу по хендофу. Подготовь единое задание CODEX на Phase 3: Node shadow runner для одного LAB UID без persistence и со строгим сравнением Browser OLD против общего JavaScript Core. PROD не открывать и не затрагивать.
