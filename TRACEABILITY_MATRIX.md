# TRACEABILITY MATRIX

## Full Recalc → Snapshot → Summary → Index

| Rule | Spec | Code | Status | Notes |
|---|---|---|---|---|
| Full Recalc uses one final result for snapshot and summary | LOGIC_SPEC Full Recalc | web/payment_table.js / web/data.js / web/abonent_card.html | OK | The successful result carries canonical UID, final rows, `rowsById`, runtime ledger version, and input hash. |
| Snapshot and summary verifier contract | LOGIC_SPEC Full Recalc | web/data.js | OK | UID, runtime `ledgerVersion`, and `inputHash` must match current canonical inputs before persistence. |
| Index consumes saved summary only | LOGIC_SPEC Full Recalc | web/index.html / backend/app.py | OK | No index-side ledger read or recalculation. |
| Temporary Period Calculation is non-persistent | LOGIC_SPEC Full Recalc | web/abonent_card.html / web/payment_table.js | OK | It renders runtime rows without writing ledger, full snapshot, summary, or index totals. |
| Existing non-empty canonical ledger cannot become `[]` accidentally | LOGIC_SPEC Canonical payment-ledger empty-write boundary | `de6468b`; backend/app.py `/api/store`; web/data.js; web/payment_table.js; guard regression tests | OK | HTTP 409 `PAYMENT_LEDGER_EMPTY_OVERWRITE_BLOCKED`; only active-lock verified `CALCULATED_FINAL_EMPTY` may clear it. Manual LAB verification: 1009 Full Recalc restored ledger, snapshot/summary path and court certificate succeeded. |
| Every canonical ledger store mutation has persistent metadata audit | LOGIC_SPEC Canonical payment-ledger empty-write boundary | backend/app.py `PaymentLedgerStoreAudit`, `/api/audit/payment-ledger-store`; migration `007_payment_ledger_store_audit.sql`; backend audit tests | OK | POST/DELETE, blocked guard, validation rejection, initial empty, and calculated-final-empty are recorded without storing ledger rows. Mutation succeeds only when its audit event commits in the same transaction. |

## Stage 16 - Persisted Snapshot / Summary

| Rule | Spec | Code | Status | Notes |
|---|---|---|---|---|
| Card snapshots are persisted separately from the ledger | LOGIC_SPEC Stage 16 | backend/app.py / web/data.js / web/abonent_card.html | OK | `card_snapshot` table and `card_snapshot_<uid>` payloads store derived results only; no totals are written into `payments_<uid>`. |
| Index reads only `abonent_summary` | LOGIC_SPEC Stage 16 | web/index.html / backend/app.py | OK | `index.html` does not load calculation scripts or read ledgers on open; GET `/api/abonents` remains readonly. |
| Input versions and `input_hash` invalidate derived caches | LOGIC_SPEC Stage 16 | web/data.js / backend/app.py | PARTIAL | Frontend computes component versions and persists metadata; backend stores it without introducing a second calculation engine. |
| One active recalc per UID | LOGIC_SPEC Stage 16 | backend/app.py / web/data.js | OK | `/api/recalc_lock/<uid>/begin` returns `already_running`; explicit recalc releases the lock in `finally`. |
| Index browser permanent batch | LOGIC_SPEC Index browser permanent batch | web/index.html / web/data.js / backend/app.py | PARTIAL | Sequential browser execution calls the canonical full path, validates snapshot before persisting fresh summary, and rejects fresh/dirty input; interruption/resume remains governed by the existing job protocol. |
| Period/report calculation does not dirty full summary | LOGIC_SPEC Stage 16 | web/data.js / web/abonent_card.html / backend/app.py | OK | Period summaries are skipped by the summary save endpoint and remain runtime-only unless explicitly persisted as a report. |

## Stage 16 - bulk-calc-verify

| Rule | Spec | Code | Status | Notes |
|---|---|---|---|---|
| Bulk verify requires explicit UID list | LOGIC_SPEC Stage 16 bulk-calc-verify | backend/app.py | OK | `POST /api/abonent_summary/bulk_calc_verify` rejects missing/non-list `uids`; no full database scan is launched from an empty request. |
| Verify does not create a second calc engine | LOGIC_SPEC Stage 16 bulk-calc-verify | backend/app.py | OK | Backend compares persisted `abonent_summary` and `card_snapshot`; it does not calculate legal totals in Python/Pandas and does not change `calc_engine.js`. |
| Verify does not apply results | LOGIC_SPEC Stage 16 bulk-calc-verify | backend/app.py | OK | Job items store old/new/diff reports only; `abonent_summary` and `card_snapshot` are not overwritten by verify. |
| Per-UID errors do not fail the batch | LOGIC_SPEC Stage 16 bulk-calc-verify | backend/app.py / backend/tests/test_bulk_calc_verify.py | OK | Missing/invalid snapshot is recorded as an item error while other UIDs continue. |
| One active bulk/recalc job per UID | LOGIC_SPEC Stage 16 bulk-calc-verify | backend/app.py / backend/tests/test_bulk_calc_verify.py | OK | Active verify jobs, recalc batch jobs, and UID locks cause a second UID request to be `already_running` / `skipped`. |
