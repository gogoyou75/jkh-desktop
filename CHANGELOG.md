# CHANGELOG

## Phase 3 — no-write Node shadow runner

- Added local `scripts/run_full_recalc_shadow.js`: it accepts an exported explicit input, runs the shared Core plus explicit `JKHCalcEngine`, emits PASS/BLOCKED/ERROR and never imports persistence or network code.
- Added strict normalized comparison, stable SHA-256 input/result hashes, anonymized fixtures and a guarded browser diagnostic exporter. Browser OLD remains the only writer.
- Shadow inputs/reports are gitignored. Node autoaccrual, worker/container, server jobs, backend APIs and PROD changes were not created.

## Phase 2B — explicit financial inputs

- `JKHCalcEngine.calcTotalsAsOfAdjusted()` now accepts `options.financialInputs`; responsibility, rates, exclusions, freeze, transfer and payment-period data are normalized from that explicit, serializable input rather than loaded during the calculation.
- `buildBrowserFinancialInputs()` preserves the former browser loaders for compatibility. The permanent rows-by-id adapter passes this result through `FullRecalcCore` to the unchanged financial formulas.
- Added no-hidden-read and Node-without-browser-global coverage. Autoaccrual, persistence, temporary mode, Browser Batch V1, backend and Docker remain unchanged.

## Phase 2 — environment-neutral Full Recalc Core

- Added `web/full_recalc_core.js`: a pure, dependency-injected rows-by-id Core with no persistence, transport, UI, browser-cache, or browser-data reads.
- The existing browser `JKHCalcEngine.calcTotalsAsOfAdjusted()` remains the only financial calculator. `data.js` now supplies it to the Core as an explicit adapter dependency; FIFO, penalties, rates, exclusions, responsibility, transfer, freeze, and rounding were not changed.
- Browser Full Recalc and Browser Batch V1 retain their existing wrappers and snapshot → summary persistence sequence. Temporary-period behavior is unchanged.
- Node Worker, server jobs, migrations, Docker changes, and PROD changes were not created.

## Canonical payment-ledger write history

- Added `payment_ledger_store_audit` metadata history for every canonical `payments_<uid>` POST/DELETE operation, including successful writes, blocked empty overwrites, invalid payloads, initial empty creation, and missing-key deletes.
- Audit records actor, UID/key, request ID, source, old/new row counts, guard/HTTP result, and verified calculated-final-empty lock metadata; it never stores full ledger rows, secrets, or payment details.
- Canonical ledger mutation and audit persistence are transactional: audit failure rolls back the ledger change and returns a failure response.
- Added admin-only, owner-scoped, limit-bounded `GET /api/audit/payment-ledger-store`. No ledger recovery, snapshot synchronization, calculation, or frontend behavior changed.

## LAB verification — empty canonical ledger recovery (2026-07-17)

- Guard from `de6468b` was deployed and manually verified on LAB for abonent 1009.
- The verified Full Recalc restored the canonical ledger; the subscriber card, fresh derived snapshot/summary path, and court certificate work normally.
- The court-certificate table is populated and calculates amounts; return to the card also works.
- PROD was not deployed or changed.

## Storage guard — accidental empty canonical ledger overwrite

- `POST /api/store` now rejects `payments_<uid>` existing non-empty JSON array → incoming `[]` with HTTP `409` and stable code `PAYMENT_LEDGER_EMPTY_OVERWRITE_BLOCKED`; the stored value is not changed.
- Initial empty ledger (missing key → `[]`) and idempotent empty ledger (`[]` → `[]`) remain valid.
- The only exception is an active UID-scoped Full Recalc lock plus explicit `CALCULATED_FINAL_EMPTY`, `completed:true`, and `finalLedgerEmpty:true` contract. Generic sync and `PAYMENT_TABLE_WRITE` cannot receive this contract.
- Added backend mutation tests and frontend-contract regression tests. Snapshot, summary, index, court certificate, import, temporary-period behavior, and calculation formulas were not changed.

## Full Recalc → Snapshot → Summary → Index stabilization

- Completed investigation and restored the explicit full-recalculation chain: one verified final result produces the persisted card snapshot and the `abonent_summary` consumed by the index.
- Full-recalc final rows are verified by canonical UID, runtime ledger version, and financial `input_hash` before snapshot/summary persistence.
- Temporary period calculation remains display-only: it does not write the payment ledger, full card snapshot, `abonent_summary`, or index totals.
- Removed investigation-only targeted payment dump/write diagnostics after successful manual verification.

## Stage 15.1

- Added minimal persisted subscriber card snapshots under `card_snapshot_<uid>`.
- Card opening now uses a fresh snapshot when available and otherwise shows that recalculation is required.
- Manual card recalculation saves a snapshot before the UI marks the summary as fresh.
- Payment ledger writes invalidate the card snapshot and keep the existing summary dirty flow.
- No calculation formulas, FIFO allocation, `payments_<uid>` structure, judicial certificate logic, or server snapshot API were changed.

## Stage 16

- Added backend `card_snapshot` persistence and UID recalc lock tables.
- Extended `abonent_summary` as the lightweight index cache with status, reason, totals, identity, and `input_hash` metadata.
- Added component version/input-hash metadata to explicit card summary/snapshot saves.
- Wrapped explicit full-card recalculation with a one-active-job-per-UID lock; concurrent calls return `already_running`.
- Kept period/report calculations runtime-only and blocked period summaries from updating the full summary layer.
- Switched `index.html` to summary-only loading: no calculation engine, ledger reads, autoaccrual, flush, or hidden recalculation on open.
- `calc_engine.js`, FIFO, penalty formulas, transfer/merge/split financial logic, and `payments_<uid>` ledger structure were not changed.

## Stage 16 bulk-calc-verify

- Added verify-only backend endpoints `POST /api/abonent_summary/bulk_calc_verify` and `GET /api/abonent_summary/bulk_calc_verify/<job_id>`.
- Added owner-scoped `bulk_calc_verify_jobs` and `bulk_calc_verify_job_items` storage for per-UID `ok`, `mismatch`, `error`, and `skipped` reports.
- Added UID concurrency guard against active bulk verify, recalc batch, and recalc lock work; duplicate active UID work is reported as `already_running` / `skipped`.
- Added diff reporting between persisted `abonent_summary` and persisted `card_snapshot` fields without applying or overwriting summary data.
- No changes to `web/calc_engine.js`, FIFO, penalty formula, backend financial formulas, `payments_<uid>` storage, or server-first index behavior.

## Stage 16.1 - test/schema stabilization

- Updated backend SQLite test compatibility for `BIGINT` autoincrement primary keys while keeping non-SQLite storage types unchanged.
- Aligned the manual `abonent_summary` test schema with the current persisted summary model fields.
- Updated stale abonent summary rebuild assertions to the current readonly/report-period and explicit full-summary contracts.
- Fixed Windows SQLite test teardown to close SQLAlchemy connections before deleting temporary database files.
- No changes to `web/calc_engine.js`, penalty formula, FIFO, payment allocation, bulk verify endpoint behavior, or backend financial logic.

## Index browser permanent recalculation batch

- Index selected batch now calls `Data.runPermanentFullRecalcForUid()` sequentially; it reuses the existing permanent summary/ledger/rows path and persists the canonical snapshot before item completion.
- The first version accepts only missing/error/invalid results. Fresh and dirty/stale results are not queued.
- The batch is browser-bound: an active run installs a `beforeunload` warning and clears it when the run ends.
- Fresh summary persistence is deferred until permanent ledger/rows, snapshot save, and snapshot readback succeed; an empty ledger/`rowsById` cannot convert `missing` to `fresh`.
