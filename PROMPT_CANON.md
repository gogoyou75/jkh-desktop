
# PROMPT_CANON — ПАПАЖКХ

Версия: v1.9.1

## 🔴 CRITICAL UID PAYMENTS RULE — 2026-05-03

1. Лицевой счёт может повторяться.
2. UID — единственный технический идентификатор абонента.
3. Ledger оплат/начислений хранится только как `payments_<uid>`.
4. Запрещено читать/писать `payments_<ЛС>` для абонента с UID.
5. Все модули обязаны получать ключ через `window.getPaymentsKeyForAbonent(abonentId)`.
6. Если Data/UID не готовы — операция блокируется, fallback на ЛС запрещён.
7. `DOMContentLoaded` не имеет права запускать чтение оплат до `JKH_UI_STATE.data.status === "ready"`.

Нарушение любого пункта = критическая ошибка.

## 🔴 PREMISE MERGE RULE — 2026-05-03

1. Объединение квартир создаёт новый объект квартиры.
2. Старые квартиры закрываются как `merged` и остаются историей.
3. Старые active links закрываются, старые абоненты получают `calcEndDate`.
4. Новая квартира получает новый regnum и дату создания = дату объединения.
5. Новый ответственный создаётся как новый абонент с новым ЛС и новым UID.
6. Старые долги/платежи не переносятся автоматически.
7. На closed/merged квартиру запрещено создавать активного абонента.
8. История преобразований хранится в `premiseEvents`.

Нарушение любого пункта = критическая ошибка.

## 🔴 CALCULATION MODERNIZATION STAGE 0 FREEZE — 2026-05-16

1. `web/calc_engine.js` является юридическим ядром расчёта. До появления summary-слоя, эталонных тестов и сверки результатов 1:1 перенос расчётов на Python/Pandas запрещён.
2. Формулу пени менять запрещено: первые 30 дней = 0; 31–90 день = 1/300; 91+ день = 1/130; ежедневная ставка на конкретный день; ограничение ставки 9.5% до 01.01.2027; fatal при отсутствии ставок.
3. FIFO менять запрещено: старые начисления закрываются раньше новых; платёж без периода не уходит в будущее; переплата/аванс не маскирует ошибки расчёта.
4. `index.html` при открытии остаётся read-only: не запускает autoaccrual apply, не пишет `payments_<uid>`, не делает flush/upload и не пересчитывает всех абонентов молча.
5. Frontend summary/cache/table totals являются только производными данными; юридическая логика долга и пени остаётся в каноническом расчётном слое.
6. SQL payments — отдельный будущий этап; canonical ledger на текущем этапе остаётся `payments_<uid>`.
7. `/api/store_dump` нельзя удалять или ломать до завершения server-first summary-слоя.
8. silent fallback запрещён для `LEDGER_JSON_INVALID`, `RATES_MISSING`, `RATES_JSON_INVALID`, `MISSING_REQUIRED_RATE`, `EXCLUDES_JSON_INVALID`, `EXCLUDES_INVALID`, `START_DATE_MISSING`, `RESPONSIBILITY_DATE_MISSING`.
9. Следующий безопасный этап — summary-слой: `abonent_summary`, `summary_status` fresh/dirty/missing/error, batch recalculation только по `affected_uids`, `index.html` читает готовые итоги.

Нарушение любого пункта = критическая ошибка.


## 🔴 CALCULATION MODERNIZATION STAGE 1 SUMMARY DESIGN CONTRACT — 2026-05-16

1. Stage 1 is documentation-only: do not change `backend/app.py`, migrations, `index.html`, `data.js`, `payment_table.js`, `calc_engine.js`, `autoaccrual_engine.js`, runtime APIs, or implementation tests.
2. Future `abonent_summary` is a derived summary layer for the lightweight main page, not a legal calculation engine and not a second financial engine.
3. `abonent_summary` may store only results produced by the canonical calculation layer; it must not change debt, penalty, FIFO, or legal calculation formulas.
4. Minimal `abonent_summary` fields: `owner_id`, `abonent_id`, `abonent_uid`, `total_debt`, `total_penalty`, `total_accrued`, `total_paid`, `period_from`, `period_to`, `summary_status`, `summary_reason`, `recalc_fingerprint`, `calc_engine_version`, `canon_version`, `updated_at`.
5. Allowed `summary_status`: `fresh`, `dirty`, `missing`, `error`.
6. `error` must not become `total_debt = 0`; `missing` must not be displayed as zero debt; `dirty` must not be displayed as legally fresh.
7. `summary_reason` stores the status reason, including `OK`, `LEDGER_JSON_INVALID`, `RATES_MISSING`, `RATES_JSON_INVALID`, `MISSING_REQUIRED_RATE`, `EXCLUDES_JSON_INVALID`, `EXCLUDES_INVALID`, `START_DATE_MISSING`, `RESPONSIBILITY_DATE_MISSING`, `SUMMARY_NOT_BUILT`, `DATA_DIRTY`.
8. Source-data changes mark concrete `affected_uids` as `dirty`; the system must not recalculate the whole owner database synchronously on `index.html` open.
9. Future `GET /api/abonents?page=1&limit=50&sort=total_debt&order=desc&query=` returns only one page of abonents plus summary totals and status.
10. Future `POST /api/recalc/mark-dirty` marks `affected_uids` dirty; future `POST /api/recalc/batch` recalculates only listed UID values and records per-UID errors as `summary_status = error` with `summary_reason`.
11. `index.html` open is read-only: no full `payments_<uid>` scan, no autoaccrual apply, no recalc all, no `payments_<uid>` writes, no flush/upload, no missing ledger creation, no masking missing/error summary with zeroes.

Нарушение любого пункта = критическая ошибка.
