# Card Snapshot Restoration Regression — Investigation Handoff

Date: 2026-07-12  
Branch: `lab-card-ab-01`  
Current baseline: `017f716` (`preserve server readiness after local cache quota failure`)

## Scope and guardrails

This is an investigation handoff only. It records verified lifecycle evidence
and the remaining reproduction work. Do not change calculation formulas, FIFO,
transfer/merge/split logic, or `web/calc_engine.js` while continuing this work.

## Confirmed root causes

1. **The index and card previously used different freshness authorities.**
   The index displays backend `abonent_summary`, while card opening had depended
   on the project-local `card_snapshot_<uid>`. Therefore, a fresh backend
   summary/snapshot could coexist with a missing, stale, or incompatible local
   snapshot; the card then showed a non-fresh state or entered its recalculation
   path. This is proven by the reader/writer paths in
   `web/index.html`, `web/abonent_card.html`, `web/data.js`, and
   `backend/app.py`; see also `docs/CARD_STATE_SOURCES_AUDIT.md`.

2. **A localStorage quota failure after a successful `/api/store_dump` could
   downgrade readiness to `offline`.**
   The server response and hydrated runtime data were valid, but the failed
   local-cache write contaminated the UI/data readiness state. Manual full
   recalculation then waited for readiness and ended with
   `DATA_READY_TIMEOUT`. This cause is fixed in the current baseline: server
   hydration/readiness and local-cache-write failure are now tracked
   separately. The local-cache failure remains a visible warning.

3. **Snapshot rows were not always materialized for passive card rendering
   after reload.**
   A canonical snapshot could exist but the payment table could render from an
   empty ledger/runtime path instead of its `rowsById`. The canonical passive
   restoration path was added before the current baseline; it restores and
   renders snapshot rows without starting calculation.

## Completed investigations and resulting changes

- Mapped all relevant state surfaces: backend `abonent_summary`, backend
  `card_snapshot`, local `card_snapshot_<uid>`, canonical
  `payments_<uid>`, `ledger_runtime_cache_<uid>`, and in-memory calculated
  rows.
- Proved that backend batch completion must not mark a UID `fresh` merely from
  summary status: it now requires a fresh backend card snapshot with non-empty
  `rowsById`.
- Made the backend `card_snapshot` route the canonical persistence contract and
  added save/readback diagnostics.
- Made local snapshot persistence passive: a local write failure must not
  prevent the backend canonical save from being attempted.
- Added card-open preference for an accepted fresh backend canonical snapshot
  before any card-side recalculation decision.
- Added explicit post-reload canonical snapshot row restoration for passive
  payment-table display.
- Separated temporary report/period calculation state from full-summary state.
- Traced manual-recalc exits, readiness evaluation, readiness writers, and the
  pre-readiness `offline` origin. The final confirmed trigger was the local
  cache quota failure described above.
- Persisted canonical totals to backend `abonent_summary` for index display.

## Proven event sequence

### Previous failure sequence

1. Index batch or a manual calculation creates a full card result.
2. Client attempts to save `card_snapshot` locally and to the backend.
3. A later card reload reads a different surface than the index: local
   `card_snapshot_<uid>` and/or runtime/ledger render state.
4. If that local state is absent, stale, incompatible, or its calculated rows
   are not restored, the card can display a non-fresh/empty state despite a
   backend-fresh summary.
5. If a successful server store dump is followed by a localStorage quota error,
   readiness can become `offline` in the affected baseline.
6. Manual full recalc enters `waitForManualRecalcDataReady()` and times out as
   `DATA_READY_TIMEOUT`, before it can reach canonical snapshot save.

### Current expected sequence

1. Server data hydrates successfully.
2. A fresh backend canonical snapshot is read and accepted for the card when
   valid for the UID/mode/input.
3. `rowsById` is restored into passive payment-table rendering; this must not
   launch a recalculation.
4. A local cache write can fail, but it must remain a local-cache warning and
   must not change server/hydrated readiness to `offline`.
5. Manual recalculation, when requested, passes the readiness gate, produces
   rows/totals, saves the canonical snapshot, reads it back, and updates the
   backend summary for index display.

## Remaining regressions / unverified outcomes

None of the following is a confirmed new root cause; each requires a fresh LAB
reproduction on the current baseline.

- Verify after an F5 that card totals and payment rows remain the accepted
  canonical snapshot values and match the index totals for the same UID.
- Reproduce a localStorage quota failure after successful server hydration and
  verify that manual recalc no longer returns `DATA_READY_TIMEOUT` solely for
  that reason.
- Verify an intentionally missing or hash-mismatched local snapshot does not
  override a valid backend canonical snapshot.
- Verify invalid/period-scoped/incompatible backend snapshots are rejected with
  a concrete reason and do not silently display as fresh.
- Confirm the prior data-specific `1009` autoaccrual case separately. Do not
  attribute it to this restoration regression unless logs show the same event
  chain.

## Current diagnostics

Use browser console and backend logs; preserve the complete sequence for one
UID and one run ID.

| Diagnostic | Meaning |
| --- | --- |
| `[reload-chain][canonical-read]` | Backend canonical snapshot GET result, status, row count, totals, and hash metadata. |
| `[reload-chain][canonical-save-request]` / `...response` | Canonical snapshot POST inputs and accepted backend result. |
| `[reload-chain][canonical-readback-after-save]` | Client confirmation after canonical save. |
| `[reload-chain][card-open-source]` | The source selected by card open, including backend canonical acceptance. |
| `[reload-chain][card-snapshot-accepted]` / `...rejected` | Snapshot validation outcome and rejection reason. |
| `[reload-chain][rows-apply-result]` / `[reload-chain][runtime-after-reload]` | Whether rows were materialized and what runtime state survived reload. |
| `[reload-chain][index-summary-raw]`, `...index-totals-normalized`, `...comparison` | Index/card totals comparison chain. |
| `[readiness-regression][after-passive-restore]`, `...before-manual-recalc`, `...state-delta` | State transition between passive restoration and manual recalc. |
| `[readiness-write]` / `[readiness-write-sequence]` | Every observed readiness-state writer during the measured run. |
| `[readiness-enter]`, `[readiness-eval]`, `[readiness-timeout-summary]` | Readiness gate result and the exact failed predicate. |
| `[payment-render-regression]` events | Snapshot restoration followed by an unexpected empty payment-table render. |

## Files involved

- `web/abonent_card.html` — card-open snapshot selection, status UI, and
  restore diagnostics.
- `web/payment_table.js` — passive `rowsById` materialization, render state,
  manual-recalc readiness gate, and readiness diagnostics.
- `web/data.js` — local/backend snapshot save/readback and summary persistence.
- `web/storage.js`, `web/auth.js` — storage hydration, quota classification,
  and readiness-state instrumentation.
- `web/index.html` — backend summary display and batch snapshot workflow.
- `backend/app.py` — canonical snapshot API, validation, completion guard, and
  backend diagnostic logs.
- `backend/tests/test_abonent_summary_rebuild.py` — source-level lifecycle and
  regression contract coverage.
- `backend/tests/test_card_snapshot_save.py` — backend snapshot-save contract.
- `scripts/test_payment_table_view_merge.js` — payment-table restore/readiness
  regression checks.
- `docs/CARD_STATE_SOURCES_AUDIT.md` and `docs/HANDOFF.md` — earlier evidence
  and lifecycle constraints.

## Next investigation steps

1. Capture one clean current-baseline run for a known UID: index state, card
   open, F5 reload, and optional manual recalc. Correlate all log entries by UID
   and run ID.
2. Check the canonical backend snapshot payload first: owner, UID, status,
   `rowsById` count, totals, input hash, ledger version, and calculation mode.
3. On card open, determine whether it was accepted or rejected. If rejected,
   use the logged reason before proposing any code change.
4. If the table is empty, compare `rowsById` count at canonical read,
   `card-open-source`, `rows-apply-result`, and first render. This isolates
   persistence, acceptance, materialization, and render overwrite stages.
5. If manual recalc times out, retain the full readiness trace and identify the
   exact false predicate from `[readiness-timeout-summary]`; do not change the
   readiness gate without that proof.
6. Run the existing focused checks before any implementation work:

   ```powershell
   node scripts/test_payment_table_view_merge.js
   python -m pytest backend/tests/test_abonent_summary_rebuild.py backend/tests/test_card_snapshot_save.py
   ```

7. Only after a new root cause is proven, propose the smallest lifecycle/state
   change. Keep formula and financial calculation code out of scope.

## Rollback note

If a follow-up lifecycle change regresses card opening, revert only that
follow-up commit. Do not delete persisted snapshots or summaries; existing
backend canonical snapshots and local cache entries are diagnostic evidence.
