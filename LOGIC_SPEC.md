# LOGIC SPEC

## Full Recalc and Temporary Period Calculation

- Explicit Full Recalc produces one canonical final result: `uid`, structural final rows, `rowsById`, runtime `ledgerVersion`, and `inputHash`.
- The same verified final result is the source for `card_snapshot_<uid>` and `abonent_summary`; the index reads only the persisted summary and never recalculates the ledger.
- Snapshot/summary persistence validates canonical UID, runtime ledger version, and `inputHash`. Runtime-version is a full financial-input fingerprint; raw-ledger-version is a distinct storage-level hash and must not be compared as the same contract.
- Temporary Period Calculation is runtime-only. It may render selected-period rows on the card or in a report, but must not persist a full snapshot, update `abonent_summary`, or affect index totals.
- `EMPTY_ROWS_BY_ID` is a snapshot-build symptom. A valid full result must supply both structural final rows and calculated `rowsById` before snapshot materialization.

## Stage 15.1 — card snapshot

- `calc_engine.js` remains the source of calculation logic and is not changed by Stage 15.1.
- The canonical payment ledger remains `payments_<uid>`. Legacy `payments_<ЛС>` is not used as a fallback for snapshot logic.
- Subscriber card snapshots are stored in owner-scoped local storage under `card_snapshot_<uid>`.
- Snapshot payload contains `snapshotVersion`, `uid`, `abonentId`, `computedAt`, `ledgerVersion`, `rows`, `totals`, `summary_status`, and `summary_reason`.
- Opening a card is readonly: it may read `card_snapshot_<uid>` and display it when `ledgerVersion` matches and the snapshot is not dirty, but it must not start automatic recalculation.
- Payment ledger writes invalidate `card_snapshot_<uid>` and mark the summary dirty for the UID.
- Phone, subscriber notes, and UI state changes do not invalidate card snapshots.
- Judicial certificate logic is outside Stage 15.1 and is not changed.

## Stage 16 - Persisted Snapshot + Summary Invalidations

- `calc_engine.js` remains the only calculation source of truth and is not changed by Stage 16.
- The canonical financial ledger remains `payments_<uid>`; calculated totals are never written back into the ledger.
- `card_snapshot` is a persisted owner-scoped result of an explicit full card calculation. It stores status, reason, component versions, `input_hash`, timestamps, and the snapshot payload.
- `abonent_summary` is the lightweight owner-scoped index layer. It stores identity fields, lightweight totals, status/reason, `input_hash`, and the canonical JSON payload.
- `input_hash` is derived from ledger, tariff, rate, exclude, links, and engine versions. A mismatch makes a cached snapshot/summary stale instead of silently recalculating.
- One UID may have only one active recalculation lock. A second request returns `already_running` and must not destroy the previous fresh snapshot.
- `index.html` is summary-only: it does not load the calculation engine, read payment ledgers, apply autoaccrual, flush, or recalculate on open.
- Card opening remains readonly. Fresh snapshots can be displayed; dirty/missing/error/invalid states require an explicit recalculation action.
- Period/report calculations are runtime-only unless a report is explicitly saved. They do not dirty the full `card_snapshot` or `abonent_summary`.

## Stage 16 - bulk-calc-verify

- `POST /api/abonent_summary/bulk_calc_verify` accepts only an explicit `uids` list. It must not infer "all abonents" from an empty request.
- `GET /api/abonent_summary/bulk_calc_verify/<job_id>` returns job counters and per-UID `ok`, `mismatch`, `error`, or `skipped` items.
- This stage is a verify shell only. It does not apply recalculated data, does not overwrite `abonent_summary`, and does not modify `card_snapshot`.
- The backend does not implement a second calculation engine. It compares persisted `abonent_summary` with persisted `card_snapshot` fields produced by the existing explicit card calculation path.
- Compared fields: `total_accrued`, `total_paid`, `main_debt`, `penalty_debt`, `total_debt`, `period_from`, `period_to`, `input_hash`, and version metadata when present.
- Per-UID failures are recorded in the item result and do not fail the whole batch.
- One active bulk verify/recalc job per UID is allowed. Concurrent UID work is reported as `already_running` / `skipped`.
- `payments_<LS>` fallback, Python/Pandas calculation, FIFO optimization, formula changes, incremental replay, checkpoint continuation, and verify/apply mixing are forbidden.
