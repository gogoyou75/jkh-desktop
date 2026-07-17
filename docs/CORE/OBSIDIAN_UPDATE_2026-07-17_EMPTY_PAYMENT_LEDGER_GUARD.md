# Empty Payment Ledger Guard — COMPLETED

Date: 2026-07-17

## Problem

`POST /api/store` accepted an empty array for an existing non-empty canonical `payments_<uid>` ledger. This could erase the primary ledger while derived snapshot/summary data remained populated.

## Confirmed Cause

The generic server store write boundary had no payment-ledger-specific non-empty → empty guard. The historical actor/path for abonent 1009 remains unproven; the unsafe write capability was confirmed.

## Decision

Block an existing non-empty canonical ledger from becoming `[]` by default. Return HTTP `409` and `PAYMENT_LEDGER_EMPTY_OVERWRITE_BLOCKED` without mutating KV. Permit initial/idempotent empty values and only a verified Full Recalc `CALCULATED_FINAL_EMPTY` exception bound to the exact UID and active recalc-lock token.

## Files Changed

- `backend/app.py`
- `web/data.js`
- `web/payment_table.js`
- `backend/tests/test_payment_ledger_empty_overwrite_guard.py`
- `backend/tests/test_payment_ledger_empty_frontend_contract.py`
- `CHANGELOG.md`, `LOGIC_SPEC.md`, `TRACEABILITY_MATRIX.md`, `docs/regression/REGRESSION_TEST_v1.6_CANON.md`, `docs/critical/CRITICAL_DO_NOT_TOUCH.md`

## Tests

- Backend: initial/idempotent empty, blocked generic/payment-table/unknown empty, verified final empty, UID/token mismatch, non-payments behavior.
- Frontend contract: Full Recalc non-empty path, unconfirmed empty block, narrowed contract, generic/payment-table isolation, passive snapshot and temporary-period isolation.

## LAB Verification

Initial local note: pending deployment. Superseded by the final LAB verification below.

## Regression Risk

Intentional full clearing is blocked unless it uses the explicit verified Full Recalc contract. No UI operation for clearing financial history was introduced.

## Permanent Project Rule

`payments_<uid>` is canonical. Derived snapshot/summary cannot restore it. Existing non-empty → `[]` is forbidden except verified `CALCULATED_FINAL_EMPTY` Full Recalc.

## Rollback

Revert this single commit, then rerun backend and frontend-contract regression tests. No data migration or abonent 1009 modification is included.

## Commit

To be filled with the resulting single commit hash.

## LAB FINAL VERIFICATION

- Date: 2026-07-17
- Environment: LAB
- Implementation Commit: `de6468b`
- Tested Abonent: 1009
- UID: `uid_mqmevxsl_wlr604`
- Previous State: canonical ledger was `[]`; snapshot contained 230 rows.
- Recovery Method: verified dry-run followed by the standard Full Recalc.
- User Verification: card, calculated data, Full Recalc, court-certificate navigation, and return to the card work.
- Court Certificate Result: the table is populated and amounts are calculated; the missing-accrual message no longer appears.
- Guard Regression Result: the normal non-empty Full Recalc was not blocked and restored the canonical ledger.
- PROD Status: not deployed and not changed.
- Remaining Unknown: the historical writer that stored `[]` is not proven.
- Final Decision: LAB issue resolved. The implementation is eligible for a later PROD deployment only through a separate controlled task.
