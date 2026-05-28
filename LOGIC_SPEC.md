# LOGIC SPEC

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
