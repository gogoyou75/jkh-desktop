# CHANGELOG

## Stage 15.1

- Added minimal persisted subscriber card snapshots under `card_snapshot_<uid>`.
- Card opening now uses a fresh snapshot when available and otherwise shows that recalculation is required.
- Manual card recalculation saves a snapshot before the UI marks the summary as fresh.
- Payment ledger writes invalidate the card snapshot and keep the existing summary dirty flow.
- No calculation formulas, FIFO allocation, `payments_<uid>` structure, judicial certificate logic, or server snapshot API were changed.
