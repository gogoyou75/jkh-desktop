# LOGIC SPEC

## Full Recalc and Temporary Period Calculation

## Phase 2 — shared Core boundary

- `web/full_recalc_core.js` is a pure rows-by-id orchestration boundary. It accepts an explicit `permanent_full_recalc` input and an injected totals calculator; it neither reads browser state nor persists a result.
- The browser adapter in `web/data.js` preserves the existing as-of-date enumeration and calls the unchanged `window.JKHCalcEngine.calcTotalsAsOfAdjusted()` through that injected dependency.
- This is not a second financial engine and is not a Node Worker. The browser path remains canonical; ledger, snapshot, summary, lock, false-fresh, temporary-period and UI contracts are unchanged.

## Phase 2B — explicit financial inputs

- `financialInputs` carries serialized responsibility, rates, exclusions, freeze, transfer and payment-period values. Its explicit calculation path does not call browser loaders.
- The compatibility path calls `buildBrowserFinancialInputs()` before calculation, preserving current loader normalization and error behavior. Formula-bearing functions, FIFO, penalties and rounding are unchanged.

## Phase 3 — no-write shadow comparison

- Shadow input has schema version 1, `mode:"permanent_full_recalc"` and `executionMode:"shadow"`; it contains explicit financial inputs, canonical ledger, calculated rows and a Browser OLD reference result.
- The local Node CLI validates input hash, calculates only through the shared Core/explicit engine, then returns `PASS` (0), `BLOCKED` (1), `ERROR` (2), or usage/configuration error (3). Timings, generated timestamps, run IDs, environment labels and memory metadata are ignored; financial fields are strict.
- Browser export is diagnostic-only and fails closed for unknown/PROD environment. No persistence, backend API, worker, job or Node autoaccrual is part of this phase.

## Canonical payment-ledger empty-write boundary

- `payments_<uid>` is the canonical financial ledger. `card_snapshot_<uid>` and `abonent_summary` are derived data and must never be used to reconstruct or silently replace it.
- At `POST /api/store`, a missing canonical key may be created as `[]`, and existing `[]` may be written as `[]` idempotently.
- Replacing an existing non-empty canonical ledger with `[]` is forbidden by default. The server returns HTTP `409` with `PAYMENT_LEDGER_EMPTY_OVERWRITE_BLOCKED` and leaves KV data unchanged.
- The sole exception is a verified manual Full Recalc that supplies `CALCULATED_FINAL_EMPTY`, `completed:true`, `finalLedgerEmpty:true`, the exact UID, and the active UID-scoped recalc-lock token. Generic sync and payment-table edits have no authority to use this exception.
- A canonical `payments_<uid>` value must be a JSON array at this server boundary; an invalid/non-array payload is rejected without coercion.
- Every canonical `POST` and `DELETE /api/store` operation creates metadata-only `payment_ledger_store_audit` history. It records actor, key/UID, request ID, source, old/new row counts, guard outcome, HTTP outcome, and calculated-empty/lock flags; it never stores ledger rows and is not a recovery source.
- A canonical ledger mutation and its successful audit event share one database transaction. If audit persistence fails, the mutation is rolled back and the request fails closed.
- `GET /api/audit/payment-ledger-store` is admin-only, owner-scoped, limited to 500 newest metadata records, and cannot return a full ledger.
- LAB verification for abonent 1009 confirmed this contract: accidental non-empty → `[]` remains blocked, while a verified non-empty Full Recalc persists the restored canonical ledger and refreshes its derived snapshot/summary. The court certificate then reads that restored canonical ledger; this LAB result does not authorize a PROD deployment.

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

### Index browser permanent batch

- `Data.runPermanentFullRecalcForUid(uid)` is a wrapper around the canonical permanent full-summary/rows path. It does not implement formulas.
- It saves and reads back the snapshot before the caller may mark the item fresh, then clears only the derived runtime cache for that UID.
- The execution is strictly sequential and requires the Index tab to remain open; it must not be represented as a server-side calculation worker.
- Browser batch must not save a fresh summary before validating permanent ledger, non-empty `rowsById`, snapshot UID, and snapshot readback. A failed validation leaves a missing result non-fresh.

## Stage 16 - bulk-calc-verify

- `POST /api/abonent_summary/bulk_calc_verify` accepts only an explicit `uids` list. It must not infer "all abonents" from an empty request.
- `GET /api/abonent_summary/bulk_calc_verify/<job_id>` returns job counters and per-UID `ok`, `mismatch`, `error`, or `skipped` items.
- This stage is a verify shell only. It does not apply recalculated data, does not overwrite `abonent_summary`, and does not modify `card_snapshot`.
- The backend does not implement a second calculation engine. It compares persisted `abonent_summary` with persisted `card_snapshot` fields produced by the existing explicit card calculation path.
- Compared fields: `total_accrued`, `total_paid`, `main_debt`, `penalty_debt`, `total_debt`, `period_from`, `period_to`, `input_hash`, and version metadata when present.
- Per-UID failures are recorded in the item result and do not fail the whole batch.
- One active bulk verify/recalc job per UID is allowed. Concurrent UID work is reported as `already_running` / `skipped`.
- `payments_<LS>` fallback, Python/Pandas calculation, FIFO optimization, formula changes, incremental replay, checkpoint continuation, and verify/apply mixing are forbidden.
