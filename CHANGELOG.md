# CHANGELOG

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
