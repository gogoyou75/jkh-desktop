# TRACEABILITY MATRIX

## Stage 16 - Persisted Snapshot / Summary

| Rule | Spec | Code | Status | Notes |
|---|---|---|---|---|
| Card snapshots are persisted separately from the ledger | LOGIC_SPEC Stage 16 | backend/app.py / web/data.js / web/abonent_card.html | OK | `card_snapshot` table and `card_snapshot_<uid>` payloads store derived results only; no totals are written into `payments_<uid>`. |
| Index reads only `abonent_summary` | LOGIC_SPEC Stage 16 | web/index.html / backend/app.py | OK | `index.html` does not load calculation scripts or read ledgers on open; GET `/api/abonents` remains readonly. |
| Input versions and `input_hash` invalidate derived caches | LOGIC_SPEC Stage 16 | web/data.js / backend/app.py | PARTIAL | Frontend computes component versions and persists metadata; backend stores it without introducing a second calculation engine. |
| One active recalc per UID | LOGIC_SPEC Stage 16 | backend/app.py / web/data.js | OK | `/api/recalc_lock/<uid>/begin` returns `already_running`; explicit recalc releases the lock in `finally`. |
| Period/report calculation does not dirty full summary | LOGIC_SPEC Stage 16 | web/data.js / web/abonent_card.html / backend/app.py | OK | Period summaries are skipped by the summary save endpoint and remain runtime-only unless explicitly persisted as a report. |

## Stage 16 - bulk-calc-verify

| Rule | Spec | Code | Status | Notes |
|---|---|---|---|---|
| Bulk verify requires explicit UID list | LOGIC_SPEC Stage 16 bulk-calc-verify | backend/app.py | OK | `POST /api/abonent_summary/bulk_calc_verify` rejects missing/non-list `uids`; no full database scan is launched from an empty request. |
| Verify does not create a second calc engine | LOGIC_SPEC Stage 16 bulk-calc-verify | backend/app.py | OK | Backend compares persisted `abonent_summary` and `card_snapshot`; it does not calculate legal totals in Python/Pandas and does not change `calc_engine.js`. |
| Verify does not apply results | LOGIC_SPEC Stage 16 bulk-calc-verify | backend/app.py | OK | Job items store old/new/diff reports only; `abonent_summary` and `card_snapshot` are not overwritten by verify. |
| Per-UID errors do not fail the batch | LOGIC_SPEC Stage 16 bulk-calc-verify | backend/app.py / backend/tests/test_bulk_calc_verify.py | OK | Missing/invalid snapshot is recorded as an item error while other UIDs continue. |
| One active bulk/recalc job per UID | LOGIC_SPEC Stage 16 bulk-calc-verify | backend/app.py / backend/tests/test_bulk_calc_verify.py | OK | Active verify jobs, recalc batch jobs, and UID locks cause a second UID request to be `already_running` / `skipped`. |
