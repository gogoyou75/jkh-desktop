# HANDOFF

Date: 2026-07-08

## Current Task

Stabilize the abonent card lifecycle:

- make card snapshot freshness and dirty detection explicit;
- prevent full recalc from starting only because the card was opened;
- keep showing the last successful snapshot when data is dirty;
- require a manual recalc unless a future task explicitly enables an allowed auto-flow.

## Current Branch / Commits

- Branch: `lab-card-ab-01`
- Baseline HEAD at start of this task: `a628434 fix: persist fresh card status after auto recalc`
- Relevant earlier commit: `18773e1 fix: auto recalc abonent card when snapshot is not fresh`

## What Was Discovered

- `index.html` and `abonent_card.html` are related but use different state surfaces:
  - index reads `abonent_summary`;
  - card opening reads `card_snapshot`.
- A successful card recalc updating index/summary is expected behavior.
- The root issue is not in `web/calc_engine.js`.
- The problem is lifecycle/state handling: when snapshot/status is dirty or missing, the card must diagnose and display state, not immediately start heavy full recalc.
- `temporary_court_period` and period report totals are separate from full summary and must not mark full summary fresh.

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

## Tools Note

- Graphify is configured; post-commit hook runs `graphify update .`.
- Use Continue Chat/Plan for diagnostics and architecture analysis.
- Use Agent mode only for explicit file modifications.
- DeepSeek through Continue may print raw DSML `tool_calls`; for evidence-based audits, prefer Codex plus `rg`/grep and source verification.
