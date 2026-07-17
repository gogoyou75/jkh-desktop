# Full Recalc → Snapshot → Summary → Index — COMPLETED

Date: 2026-07-15

## Problem

The explicit recalculation flow could diverge between final calculated rows, snapshot construction, and persisted index totals.

## Root Cause

Independent raw-ledger reads and incomplete full-recalc result metadata allowed snapshot/summary boundaries to use different inputs. Temporary period UI selection also needed to remain separate from full persistence.

## First Divergence Point

The full-recalc result did not carry canonical UID to the snapshot verifier; earlier, summary totals could be rebuilt from a separate raw-ledger read.

## Implementation Summary

- Full Recalc now carries one verified final result into snapshot and summary persistence.
- UID, runtime ledger version, and input hash protect the persistence boundary.
- Temporary Period Calculation remains display-only and does not affect snapshot, summary, or index.
- Investigation-only targeted diagnostics were removed after manual verification.

## Tests Passed

- `backend.tests.test_abonent_summary_rebuild`
- `backend.tests.test_card_snapshot_save`
- JavaScript syntax checks for the affected runtime files.

## Regression Risks

- Do not treat raw-ledger-version as the same value as runtime-version.
- Do not use temporary period rows as a fallback source for a full snapshot or summary.

## Project Knowledge Discovered

Summary and snapshot must be built from the same Full Recalc result. `EMPTY_ROWS_BY_ID` is a symptom of a blocked snapshot boundary, not an independent calculation failure.

## Related Commits

- `3ae943a` — canonical snapshot accrued totals
- `cbf4c64` — final rows UID validation
- `a53d6ba` — runtime ledger version validation
- `c54d3e8` — temporary period routing
- `302e653` — full recalc result UID preservation

## Related Documents

- `CHANGELOG.md`
- `LOGIC_SPEC.md`
- `TRACEABILITY_MATRIX.md`

Status: COMPLETED
