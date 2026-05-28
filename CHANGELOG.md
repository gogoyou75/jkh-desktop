# CHANGELOG

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
