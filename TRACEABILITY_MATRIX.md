# TRACEABILITY MATRIX

## Stage 16 - Persisted Snapshot / Summary

| Rule | Spec | Code | Status | Notes |
|---|---|---|---|---|
| Card snapshots are persisted separately from the ledger | LOGIC_SPEC Stage 16 | backend/app.py / web/data.js / web/abonent_card.html | OK | `card_snapshot` table and `card_snapshot_<uid>` payloads store derived results only; no totals are written into `payments_<uid>`. |
| Index reads only `abonent_summary` | LOGIC_SPEC Stage 16 | web/index.html / backend/app.py | OK | `index.html` does not load calculation scripts or read ledgers on open; GET `/api/abonents` remains readonly. |
| Input versions and `input_hash` invalidate derived caches | LOGIC_SPEC Stage 16 | web/data.js / backend/app.py | PARTIAL | Frontend computes component versions and persists metadata; backend stores it without introducing a second calculation engine. |
| One active recalc per UID | LOGIC_SPEC Stage 16 | backend/app.py / web/data.js | OK | `/api/recalc_lock/<uid>/begin` returns `already_running`; explicit recalc releases the lock in `finally`. |
| Period/report calculation does not dirty full summary | LOGIC_SPEC Stage 16 | web/data.js / web/abonent_card.html / backend/app.py | OK | Period summaries are skipped by the summary save endpoint and remain runtime-only unless explicitly persisted as a report. |
