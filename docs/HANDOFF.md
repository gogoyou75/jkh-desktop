# HANDOFF

Date: 2026-07-08

## Current Task

Stabilize the abonent card lifecycle:

- make card snapshot freshness and dirty detection explicit;
- prevent full recalc from starting only because the card was opened;
- keep showing the last successful snapshot when data is dirty;
- require a manual recalc unless a future task explicitly enables an allowed auto-flow.
- stabilize manual card recalc after auto-recalc was disabled on open;
- prevent index from showing false `fresh` without a valid snapshot and rows.

## Current Branch / Commits

- Branch: `lab-card-ab-01`
- Baseline HEAD at start of this task: `a628434 fix: persist fresh card status after auto recalc`
- Current lifecycle baseline: `4240c92 fix: make card snapshot freshness explicit and update handoff`
- Relevant earlier commit: `18773e1 fix: auto recalc abonent card when snapshot is not fresh`

## What Was Discovered

- `index.html` and `abonent_card.html` are related but use different state surfaces:
  - index reads `abonent_summary`;
  - card opening reads `card_snapshot`.
- A successful card recalc updating index/summary is expected behavior.
- The root issue is not in `web/calc_engine.js`.
- The problem is lifecycle/state handling: when snapshot/status is dirty or missing, the card must diagnose and display state, not immediately start heavy full recalc.
- `temporary_court_period` and period report totals are separate from full summary and must not mark full summary fresh.
- Manual card recalc can hit `PAYMENT_LEDGER_WRITE_BLOCKED` when autoaccrual proposed rows would overwrite existing positive accruals with zero accrual rows.
- The concrete local block is `ZERO_ACCRUAL_OVERWRITE_BLOCKED` in `Data.writePaymentLedger`.
- Index batch previously could complete a UID as `fresh` from summary status alone, without proving snapshot save/readback and non-empty `rowsById`.

## What Was Fixed

- Manual card recalc treats `ZERO_ACCRUAL_OVERWRITE_BLOCKED` as non-fatal: it does not overwrite the ledger, and continues full recalc using the existing ledger rows.
- Other ledger write failures still return `PAYMENT_LEDGER_WRITE_BLOCKED`.
- Index batch now uses the rows/snapshot pipeline before completing a UID as `fresh`.
- `summaryBatchResultStatus` requires non-empty `rowsById` for `fresh`.
- Backend `complete_uid` now downgrades `fresh` to `error` unless the client summary has valid totals and a fresh saved `card_snapshot` with non-empty `rowsById`.

## Not Yet Resolved

- LAB must confirm whether abonent `1009` has a legitimate data issue that makes autoaccrual propose zero accrual rows.
- No formula, FIFO, transfer, merge, split, or `calc_engine.js` changes were made.

## Desired Behavior

- Fresh snapshot: show calculated totals, status "Итог актуален", no auto recalc.
- Dirty snapshot: show the last saved totals, status "Требуется пересчёт. Показан последний сохранённый расчёт", no auto recalc.
- Missing snapshot: show "Нет сохранённого расчёта. Нажмите 'Пересчитать'", no auto recalc.
- Invalid/error snapshot: show error/diagnostic status, no infinite auto-recalc loop.
- Manual full recalc continues through `fullRecalcForCurrentAbonent` / `Data.recalculateAbonentCard`, saves `card_snapshot` with readback, and updates `abonent_summary` for index.

## What Not To Do

- Do not change `web/calc_engine.js`.
- Do not create a second calculation engine.
- Do not change penalty formula, FIFO, transfer, merge, or split financial logic.
- Do not clear old totals only because snapshot is dirty.
- Do not run full recalc on every card open.
- Do not mix `period_report_totals` / `temporary_court_period` with full summary freshness.
- Do not run recalc for all abonents as part of this lifecycle fix.

## Next Step

Manual LAB verification:

1. Open fresh abonent `1008` repeatedly and confirm full recalc does not start.
2. Open dirty abonent `1008` or another dirty test abonent and confirm it shows stale saved totals plus manual recalc prompt, without auto start.
3. Open abonent `1007` to verify existing period/full summary isolation still holds.
4. Click `Пересчитать` manually and confirm snapshot is saved with readback, card status becomes fresh, and index shows fresh.
5. Make a financial change and confirm the card becomes dirty while still showing the last saved calculation.
6. For abonent `1009`, click manual `Пересчитать` from the card and confirm `PAYMENT_LEDGER_WRITE_BLOCKED` no longer aborts the card recalc when the detailed block is `ZERO_ACCRUAL_OVERWRITE_BLOCKED`.
7. From index, recalc abonent `1009` and confirm it cannot become false `fresh` with missing snapshot or zero/empty rows.

## Tools Note

- Graphify is configured; post-commit hook runs `graphify update .`.
- Use Continue Chat/Plan for diagnostics and architecture analysis.
- Use Agent mode only for explicit file modifications.
- DeepSeek through Continue may print raw DSML `tool_calls`; for evidence-based audits, prefer Codex plus `rg`/grep and source verification.
