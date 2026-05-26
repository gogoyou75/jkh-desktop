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
