# 🔒 CRITICAL INDEX — ПАПАЖКХ

Версия: v1.5.5
Дата фиксации: 2026-05-16

Единый список жёстких канонов и запретов.

---

## 1. CalcEngine Freeze Boundary

- `web/calc_engine.js` — юридическое расчётное ядро и единственный источник финансовой формулы.
- Запрещено менять `calc_engine.js` для performance optimization, precompute, alternate-pass или second-pass без отдельного архитектурного ТЗ.
- Запрещены alternate calc pipeline, multi-path financial execution, precomputed penalty/FIFO engine, optimized FIFO path, vectorized penalty calculations and alternate totals path.
- UI, summary/cache and server prepared data не имеют права считать долг, пеню или FIFO собственной формулой.
- Summary/cache являются derived cache only и не могут быть вторым financial engine.

## 2. Dangerous commits / DO NOT PORT

Dangerous commits для стабильной базовой ветки:
- `d535dba`;
- `6780a25`.

Из этих commits запрещено переносить code-paths, связанные с:
- `prepareLedgerState`;
- single-pass totals precompute;
- precomputed penalty engine;
- precomputed FIFO / optimized FIFO path;
- alternate totals calculation;
- calc-engine perf pipelines;
- `calc-precompute` / `calc-apply` runtime paths.

## 3. Safe canon allowed in stable baseline

Разрешённый canon для переноса и синхронизации:
- server-first owner-scoped load;
- UID-only `payments_<uid>` ledger;
- `payments_<LS>` only as read-only legacy fallback inside service layer;
- canonical transfer flow through `Data.transferResponsibility(...)`;
- canonical financial modes `WITH_DEBT` and `WITHOUT_DEBT` / `NO_DEBT`;
- canonical `calc_period_<uid>` and `calc_period_active_<uid>`;
- calc summary integrity with checkpoint and fresh-only reads;
- strict import contract and import audit log;
- owner isolation from server session;
- upload whitelist;
- read-back validation before legacy cleanup.

## 4. Safe hardening required

- Fatal instead of silent fallback for missing/corrupt financial inputs.
- Read-only page open must not trigger write-side-effect, autoaccrual apply or summary recalculation.
- Stale/dirty/mismatch/invalid summary must show recalculation required and must not provide old totals as current.
- Import apply must remain atomic and auditable.
- Legacy/admin/global/foreign-owner keys must not be uploaded to `/api/store`.

## 5. Server Summary Layer boundary

Server Summary Layer may be prepared only as foundation until a separate implementation task exists.

Allowed now:
- interface/contract documentation;
- TODO/CRITICAL comments;
- data boundary descriptions;
- read-only derived-cache semantics.

Forbidden now:
- new financial engine;
- Python/Pandas CalcEngine replacement;
- changes to legal formula;
- changes to FIFO logic;
- changes to penalty logic;
- alternate totals fallback.

## 6. Calculation Modernization Stage 0 — hard prohibitions

Before any calculation modernization, these prohibitions are mandatory:
- `web/calc_engine.js` является юридическим ядром расчёта. До появления summary-слоя, эталонных тестов и сверки результатов 1:1 перенос расчётов на Python/Pandas запрещён.
- Penalty formula must not change: first 30 days = 0, days 31–90 = 1/300, days 91+ = 1/130, daily rate by exact date, 9.5% cap until 01.01.2027, fatal on missing rates.
- FIFO must not change: oldest accruals are closed first, payment without period must not go to the future, overpayment/advance must not hide calculation errors.
- `index.html` must remain read-only on open: no autoaccrual apply, no `payments_<uid>` writes, no flush/upload, no silent full-abonent recalculation.
- Frontend summary/cache/table totals are derived data only and must not be trusted as legal financial data.
- SQL payments are a separate future stage; canonical ledger remains `payments_<uid>` now.
- `/api/store_dump` must not be removed or broken before the server-first summary layer is complete.
- silent fallback is forbidden for `LEDGER_JSON_INVALID`, `RATES_MISSING`, `RATES_JSON_INVALID`, `MISSING_REQUIRED_RATE`, `EXCLUDES_JSON_INVALID`, `EXCLUDES_INVALID`, `START_DATE_MISSING`, `RESPONSIBILITY_DATE_MISSING`.
- Next safe stage: summary design with `abonent_summary`, `summary_status` fresh/dirty/missing/error, batch recalculation only by `affected_uids`, and `index.html` reading ready totals instead of recalculating everyone.


## 7. Calculation Modernization Stage 1 — summary design contract

Stage 1 is documentation-only. It defines future `abonent_summary`, `summary_status`, `summary_reason`, dirty mechanics, `affected_uids`, and future API boundaries without changing code.

Mandatory boundaries:
- `abonent_summary` is derived cache only and not a legal calculation engine.
- `abonent_summary` must store results from the canonical calculation layer and must not change debt, penalty or FIFO formulas.
- Allowed `summary_status` values are `fresh`, `dirty`, `missing`, `error`.
- `error` must not become `total_debt = 0`; `missing` must not be shown as zero debt; `dirty` must not be shown as legally fresh.
- `summary_reason` must preserve the diagnostic reason, including fatal input problems such as `LEDGER_JSON_INVALID`, `RATES_MISSING`, `RATES_JSON_INVALID`, `MISSING_REQUIRED_RATE`, `EXCLUDES_JSON_INVALID`, `EXCLUDES_INVALID`, `START_DATE_MISSING`, `RESPONSIBILITY_DATE_MISSING`, `SUMMARY_NOT_BUILT`, `DATA_DIRTY`.
- Source changes mark concrete `affected_uids` as dirty instead of recalculating the whole owner database synchronously.
- Tariff/rate changes may mark all affected owner UID values dirty, but synchronous mass recalculation on `index.html` open remains forbidden.
- Future `GET /api/abonents?page=1&limit=50&sort=total_debt&order=desc&query=` may return only a page of abonents and their summary totals.
- Future `POST /api/recalc/mark-dirty` marks `affected_uids` dirty; future `POST /api/recalc/batch` recalculates only requested UID values and records per-UID `summary_status` / `summary_reason`.
- `index.html` open is read-only: no full `payments_<uid>` scan, no autoaccrual apply, no recalc all, no `payments_<uid>` writes, no flush/upload, no missing ledger creation, no masking missing/error summary with zeroes.
- Stage 1 must not modify `backend/app.py`, migrations, `index.html`, `data.js`, `payment_table.js`, `calc_engine.js`, `autoaccrual_engine.js`, runtime APIs, or implementation tests.
