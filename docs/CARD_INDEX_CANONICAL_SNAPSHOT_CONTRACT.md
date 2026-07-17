# Card/Index Canonical Snapshot Contract

## 1. Executive summary

The intended architecture needs three separate concepts:

- Backend calculation executor: the only canonical executor for financial calculation.
- Canonical successful card snapshot: the last successful full-card recalculation result.
- UI freshness/status: card/index presentation state that may say fresh, dirty, missing, error, calculating, cancelled, or timeout.

The current code mostly follows this split on successful paths, but the contracts are still mixed in several places:

- `web/index.html` is a dashboard that reads backend summary rows, but its explicit batch/snapshot tools can also create snapshots and mark summary fresh (`web/index.html:1706`, `web/index.html:2017`).
- `web/abonent_card.html` is the correctness-control screen. It checks local/project `card_snapshot_<uid>` first, then now tries backend snapshot read-through before auto-recalc (`web/abonent_card.html:4183`, `web/data.js:1123`).
- `backend/app.py` stores `CardSnapshot` and `AbonentSummary` separately, but `/api/card_snapshot/<uid>` accepts any non-empty snapshot payload and forces it to fresh (`backend/app.py:3744`). Frontend helpers block empty `rowsById`, but the backend route is not a full canonical-snapshot gate by itself.
- Period/report calculation is guarded as temporary in the current UI path (`web/payment_table.js:5068`) and summary save skips `summary_scope=period|report` (`web/data.js:3502`), but period keys still participate in render/scope decisions and can produce mismatch/dirty-looking states.

Product rule for future fixes: canonical snapshot/totals change only after a successful full recalculation. Navigation, hydration, F5, index load, local cache writes, failed recalc, and temporary period/report calculation must not create a new canonical success.

## 2. Final product rules

1. Backend is the only canonical calculation executor.
2. Frontend may request calculation, render the result, and show status; it must not create a competing calculation truth.
3. Card is the exact recalculation/correctness-control screen.
4. Index is a fast dashboard/list that reads the last successful canonical snapshot/totals plus status.
5. Canonical successful snapshot changes only after successful full recalculation.
6. Failed recalculation may update error status/reason, but must not overwrite the last successful snapshot with zero/error/empty rows.
7. Hydration/read-through/local cache writes are cache maintenance, not calculation.
8. Opening card/index, leaving card, returning to card, and F5 are not data mutations and must not trigger dirty or full auto-recalc by themselves.
9. Dirty/fresh state changes only after financial input mutations.
10. Period/report calculation is temporary and must not update canonical `card_snapshot`, index totals, or main fresh/dirty status.

## 3. Backend calculation contract

Canonical backend objects:

- `AbonentSummary` stores index/dashboard summary state and reason (`backend/app.py:248`).
- `CardSnapshot` stores the card snapshot payload and snapshot metadata (`backend/app.py:277`).
- `RecalcBatchJob` and `RecalcBatchJobItem` coordinate explicit index batch recalculation (`backend/app.py:322`, `backend/app.py:340`).

Backend routes inspected:

- `abonents_index_list()` returns index rows and summary/snapshot metadata (`backend/app.py:3018`).
- `abonent_summary_list()` exposes summary rows (`backend/app.py:3073`).
- `abonent_summary_mark_dirty()` marks summary dirty for real input mutations (`backend/app.py:3118`).
- `abonent_summary_rebuild()` writes a supplied recalculation summary (`backend/app.py:3342`).
- `card_snapshot_get()` reads backend card snapshot (`backend/app.py:3729`).
- `card_snapshot_put()` writes backend card snapshot (`backend/app.py:3744`).
- `client_recalc_batch_job_next_uid()` and `client_recalc_batch_job_complete_uid()` drive explicit client batch work (`backend/app.py:2024`, `backend/app.py:2073`).

Current backend safety:

- `_client_recalc_summary_payload()` removes totals from non-fresh/error/skipped batch payloads (`backend/app.py:1953`).
- `_client_recalc_fresh_guard()` requires finite summary totals and a backend fresh `CardSnapshot` with non-empty `rowsById` before batch completion can mark a UID fresh (`backend/app.py:1995`).
- `client_recalc_batch_job_complete_uid()` downgrades a requested fresh completion to error if `_client_recalc_fresh_guard()` fails (`backend/app.py:2073`).

Current backend gap:

- `card_snapshot_put()` forces `snapshot_status=fresh` and `summary_status=fresh` for any valid non-empty snapshot object (`backend/app.py:3744`). It does not itself require full-scope mode, non-empty `rowsById`, compatible input hash, or a successful full-recalc token. The normal frontend save path does those checks before calling it, so this is a partial backend contract violation rather than a currently proven normal-flow data loss.

## 4. Abonent card contract

Intended role:

- Card decides whether the current server-side calculation inputs changed.
- Card shows recalculation required when inputs changed.
- Card allows manual full recalculation.
- Card must not auto-recalculate because of open/return/F5.
- Card may hydrate/render from a fresh compatible backend snapshot without treating hydration as recalculation.

Functions inspected:

- `loadAbonentSummaryStatus()` reads local snapshot, then backend read-through, then renders status (`web/abonent_card.html:4183`).
- `__isFreshCardSnapshotUsable()` validates card snapshot usability for card rendering (`web/abonent_card.html:4115`).
- `__renderFreshCardSnapshot()` hydrates visible totals/status from a compatible fresh snapshot (`web/abonent_card.html:4125`).
- `__tryUseBackendFreshSnapshot()` uses backend snapshot if local snapshot is missing/dirty/incompatible (`web/abonent_card.html:4145`).
- `__maybeStartCardAutoRecalc()` gates auto-recalc startup (`web/abonent_card.html:3747`).
- `__isCurrentCardSnapshotFreshForAutoRecalc()` blocks auto-recalc when current local snapshot is already fresh (`web/abonent_card.html:3710`).
- `savePostRecalcSnapshot()` saves a card snapshot only after full recalc result is fresh and snapshot rows exist (`web/abonent_card.html:4807`).
- Manual full recalculation calls `window.fullRecalcForCurrentAbonent()` with `recalcMode: "FULL_SUMMARY_REBUILD"` and `summaryScope: "full"` (`web/abonent_card.html:4938`).

Current state:

- Card first load is readonly table load, and auto-recalc is a separate guarded lifecycle step (`web/abonent_card.html:1738`).
- A compatible backend snapshot can now hydrate local/project cache and render without auto-recalc (`web/data.js:1123`, `web/abonent_card.html:4145`).
- Card still has many local/project storage reads that can influence render or dirty status; these must remain cache/input reads, not canonical truth.

## 5. Index contract

Intended role:

- Index is passive by default.
- Index reads backend summary/snapshot metadata and renders fast dashboard rows.
- Index must not replace last successful totals with zero/error/empty rows.
- Index may show dirty/missing/error status markers.
- Index may run explicit selected batch/snapshot tools, but those are operator actions, not passive load.

Functions inspected:

- `shouldUsePassiveSummaryMode()` controls passive summary mode (`web/index.html:788`).
- `buildSummaryFromBackendAbonentsRow()` maps backend row summary fields (`web/index.html:865`).
- `validateIndexSummaryTotals()` guards empty/invalid totals by status (`web/index.html:910`).
- `buildIndexRowFromSummaryItem()` builds UI row fields from backend summary/snapshot metadata (`web/index.html:1000`).
- `renderIndexRowsLegacyFallback()` is the legacy render path (`web/index.html:1132`).
- `loadPassiveSummaryPage()` fetches backend summary rows (`web/index.html:1181`).
- `isSnapshotBackfillCandidate()` identifies rows for explicit snapshot backfill (`web/index.html:1482`).
- `runSelectedSummaryBatch()` starts explicit selected summary/snapshot batch (`web/index.html:1706`).
- `processClientSummaryBatchJob()` performs explicit client-side recalculation/snapshot creation per UID (`web/index.html:2017`).
- `finishClientSummaryBatchJob()` completes explicit batch UI state (`web/index.html:1991`).
- `render()` initializes page rendering (`web/index.html:2249`).

Current state:

- Passive index render reads backend summary/status fields, not local `card_snapshot_<uid>`.
- Explicit batch/snapshot buttons can recalculate, build a card snapshot, save it, and complete the backend job (`web/index.html:2065`, `web/index.html:2111`, `web/index.html:2120`).
- This is acceptable only as an explicit operation. It must not become an implicit index freshness controller.

## 6. Canonical snapshot lifecycle

Canonical successful write path:

1. Full card recalculation is requested manually from the card, or selected UID batch is explicitly run from index.
2. `window.fullRecalcForCurrentAbonent()` builds runtime rows and calls `Data.recalculateAbonentCard()` for full summary save (`web/payment_table.js:5878`, `web/payment_table.js:6149`).
3. `Data.recalculateAbonentCard()` calls `recalcAbonentSummaryExplicit()` and `saveAbonentSummaryAfterRecalc()` for full summaries (`web/data.js:5683`, `web/data.js:5454`, `web/data.js:3502`).
4. Card builds snapshot from the successful fresh result using `Data.buildCardSnapshotFromCurrentResult()` (`web/data.js:1443`, `web/abonent_card.html:5020`).
5. Card saves it through `Data.saveCardSnapshotAndWait()` (`web/data.js:1262`, `web/abonent_card.html:5037`).
6. `Data.saveCardSnapshotToBackend()` calls `/api/card_snapshot/<uid>` (`web/data.js:1244`, `backend/app.py:3744`).
7. Index batch completion accepts fresh only after `_client_recalc_fresh_guard()` sees backend fresh snapshot with non-empty `rowsById` (`backend/app.py:1995`, `backend/app.py:2073`).

Local/project snapshot writes:

- `saveCardSnapshot()` writes `card_snapshot_<uid>` and fire-and-forgets backend/project store writes (`web/data.js:1217`).
- `saveCardSnapshotAndWait()` writes local/project cache and waits for backend/readback (`web/data.js:1262`).
- These writes are cache writes unless they occur as part of the successful full recalculation path above.

## 7. Dirty/fresh event matrix

Events that should make summary/snapshot dirty:

| Event | Current primary write/read path | Contract |
|---|---|---|
| Payment added/edited/deleted | `writePaymentLedger()` / `writePaymentLedgerServerBacked()` (`web/data.js:1983`, `web/data.js:2082`) | Dirty |
| Abonent/premise/link change | UID/responsibility/link functions and summary dirty API | Dirty |
| Responsibility period changed | Transfer/freeze/responsibility storage and ledger recalculation paths (`web/data.js:6846`, `web/data.js:6859`) | Dirty |
| Tariffs changed | `tariffs_<owner>` keys and server store (`web/storage.js:220`, `web/storage.js:1074`) | Dirty |
| Refinancing rates changed | `refinancing_rates_normal_v1`, `refinancing_rates_moratorium_v1` (`web/storage.js:163`, `web/data.js:3859`) | Dirty |
| Exclude periods changed | `exclude_periods_<id>` / `exclude_periods_v1` (`web/storage.js:343`, `web/abonent_card.html:1499`) | Dirty |
| Moratorium changed | `moratorium_<id>` (`web/storage.js:367`, `web/abonent_card.html:2634`) | Dirty |
| Transfer/freeze input changed | `jkh_transfer_*`, `jkh_freeze_*` (`web/storage.js:363`, `web/data.js:6698`) | Dirty |

Events that must not make canonical snapshot dirty:

| Event | Current code path | Contract |
|---|---|---|
| Opening card | `loadAbonentSummaryStatus()` and readonly table load (`web/abonent_card.html:4183`, `web/payment_table.js:4602`) | No dirty, no auto-recalc |
| Opening index | `loadPassiveSummaryPage()` (`web/index.html:1181`) | No dirty, no recalc |
| F5/page refresh | Same load paths | No dirty, no auto-recalc |
| Card to index to card | Passive index + card load paths | No dirty, no auto-recalc |
| Backend snapshot hydration | `readFreshBackendCardSnapshotForCard()` with local hydrate (`web/data.js:1123`) | Cache only |
| Local/project cache read/write | `card_snapshot_<uid>` and runtime cache helpers | Cache only |
| Period/report calculation | `runTemporaryPeriodCalculation()` (`web/payment_table.js:5068`) | Temporary/report only |

## 8. Navigation and F5 no-recalc rule

Current answer: partial.

What is safe now:

- Card initial table load is readonly/no-recalc by design (`web/abonent_card.html:1738`).
- Card auto-recalc is a separate guarded step (`web/abonent_card.html:3747`).
- Fresh compatible local snapshot blocks auto-recalc (`web/abonent_card.html:3710`).
- Fresh compatible backend snapshot can hydrate/render and stop auto-recalc when local snapshot is missing/dirty (`web/abonent_card.html:4145`, `web/data.js:1123`).
- Index passive load does not recalculate (`web/index.html:1181`).

Remaining risk:

- `Data.readCardSnapshot()` marks the local snapshot dirty when current local input hash or ledger version differs (`web/data.js:1048`). If the divergence is caused by local/project cache state rather than a real server-side data mutation, card open/F5 can still display dirty and can allow the guarded auto-recalc fallback.
- Payment table restore has multiple runtime/render sources: fresh card snapshot, dirty display-only snapshot, runtime cache, and raw ledger (`web/payment_table.js:684`, `web/payment_table.js:868`, `web/payment_table.js:906`, `web/payment_table.js:4602`). Divergent local caches can therefore affect render source on card open.

## 9. Failed recalculation safety rule

Current answer: partial.

Safe normal paths:

- Manual card recalc saves snapshot only after result status normalizes to fresh and `rowsById` is non-empty (`web/abonent_card.html:5011`, `web/abonent_card.html:5020`, `web/abonent_card.html:5037`).
- `Data._prepareCardSnapshotForSave()` blocks empty `rowsById` before local/backend save (`web/data.js:1193`, `web/data.js:1217`, `web/data.js:1262`).
- Batch completion removes totals from non-fresh/error payloads (`backend/app.py:1953`) and requires backend fresh snapshot rows before accepting fresh (`backend/app.py:1995`).
- Current regression tests assert error summaries do not create fake zero totals and manual zero-overwrite is blocked (`backend/tests/test_abonent_summary_rebuild.py:279`, `backend/tests/test_abonent_summary_rebuild.py:1977`).

Gap:

- Backend `card_snapshot_put()` does not enforce `rowsById`, full-scope mode, or successful full-recalc provenance itself (`backend/app.py:3744`). A malformed caller could overwrite `CardSnapshot` with a fresh-marked payload. Normal frontend paths reduce this risk, but canonical safety should be enforced at the backend boundary.

## 10. Full recalculation lifecycle

Full canonical recalculation functions inspected:

- `window.fullRecalcForCurrentAbonent()` orchestrates manual full recalculation in the card table (`web/payment_table.js:5878`).
- `Data.recalculateAbonentCard()` owns card summary recalculation and lock lifecycle (`web/data.js:5683`).
- `Data.recalcAbonentSummaryExplicit()` builds full or period summary payloads (`web/data.js:5454`).
- `buildAbonentSummaryAfterExplicitRecalc()` creates fresh summary from canonical UID ledger (`web/data.js:4910`).
- `buildAbonentSummaryErrorAfterExplicitRecalc()` creates error summary payloads (`web/data.js:5042`).
- `saveAbonentSummaryAfterRecalc()` saves full summaries and skips period/report summaries (`web/data.js:3502`).
- `buildRowsByIdFromLedgerForSnapshot()` builds rows for snapshots from ledger rows (`web/data.js:4279`).
- `recalculateAbonentCardWithRows()` supports explicit index batch snapshot/summary rebuild (`web/data.js:5833`).
- `processClientSummaryBatchJob()` calls the batch full recalculation path and saves snapshot before completing UID (`web/index.html:2017`).

Contract:

- Full recalculation success creates the new canonical snapshot.
- Summary/index totals should change only after this success.
- Runtime cache is allowed as an optimization, but must never be treated as a new canonical success by itself.

## 11. Period/report calculation lifecycle

Period/report functions inspected:

- `saveCalcPeriod()` stores selected calculation period UI state (`web/abonent_card.html:3421`).
- `setCalcPeriodActive()` stores whether selected period mode is active (`web/abonent_card.html:3521`).
- `saveReportPeriodForSpravka()` stores report period for reports/spravka flow (`web/abonent_card.html:3081`).
- Manual report-period branch calls `runTemporaryPeriodCalculation()` and returns before full recalc (`web/abonent_card.html:4860` through `web/abonent_card.html:4928`).
- `runTemporaryPeriodCalculation()` explicitly logs blocked full-write targets and returns `summary_status:"skipped"` / `summary_reason:"TEMPORARY_PERIOD_NOT_SAVED"` (`web/payment_table.js:5068`).
- `saveAbonentSummaryAfterRecalc()` skips `summary_scope === "period" || summary_scope === "report"` (`web/data.js:3502`).

Current answer: partial but mostly guarded.

- Normal period/report UI path does not call full snapshot save.
- Period summary save is skipped.
- Tests assert period summary is not saved as index summary and `CALC_PERIOD_CHANGED` is not used for index/batch dirtying (`backend/tests/test_abonent_summary_rebuild.py:1600`, `backend/tests/test_abonent_summary_rebuild.py:1193`).
- Remaining risk is contamination through period/report storage keys changing render scope, runtime signature, or compatibility checks on card load.

## 12. Selected period penalty rule

Product contract:

- Selected period calculation is standalone from `period_from` to `period_to`.
- It is not a slice cut from full historical calculation.
- Penalty logic for the report period starts from the beginning of the selected period.
- The result belongs only to temporary/report context.

Current inspected paths:

- Temporary period mode filters and renders period rows in `runTemporaryPeriodCalculation()` / `loadPaymentTableImpl()` (`web/payment_table.js:5068`, `web/payment_table.js:4602`).
- The temporary path blocks canonical full-write targets (`web/payment_table.js:5097`).

Audit note:

- This report does not verify formulas or penalty math, per strict rule. It only records the lifecycle boundary: period/report result must not write canonical snapshot, index totals, or main fresh/dirty state.

## 13. localStorage/project storage risk map

High-risk calculation/render inputs:

| Key/prefix | Current use | Risk |
|---|---|---|
| `card_snapshot_<uid>` | Local/project card snapshot read by `Data.readCardSnapshot()` and card status/render (`web/data.js:1048`, `web/abonent_card.html:4183`) | Can override or diverge from backend fresh snapshot unless read-through wins |
| `ledger_runtime_cache_<uid>` | Runtime rows/cache read/write (`web/data.js:1719`, `web/data.js:1746`, `web/payment_table.js:3902`) | Can make recalc return ALREADY_FRESH or render cached rows |
| `payments_<uid>` | Canonical UID ledger in project storage (`web/storage.js:10`, `web/data.js:1911`) | Affects calculations and input hash |
| legacy `payments_<LS>` | Legacy compatibility path (`web/storage.js:15`, `web/payment_table.js:1691`) | Can affect old/no-UID records and migration paths |
| `calc_period_uid_<uid>`, `calc_period_active_uid_<uid>` | Selected card period (`web/abonent_card.html:3418`) | Should be view/report state only, but can affect render scope/runtime signature |
| `report_period_uid_<uid>` | Report/spravka period (`web/abonent_card.html:2752`) | Should be report-only; can affect bootstrap/render mode |
| `exclude_periods_<id>`, `exclude_periods_v1` | Exclusion periods (`web/storage.js:343`, `web/abonent_card.html:1499`) | Financial input hash/calculation input |
| `moratorium_<id>` | Moratorium state (`web/storage.js:367`, `web/abonent_card.html:2634`) | Financial input hash/calculation input |
| `tariffs_<owner>` and legacy tariff keys | Tariff storage/read paths (`web/storage.js:220`, `web/storage.js:335`) | Financial input hash/calculation input |
| `refinancing_rates_normal_v1`, `refinancing_rates_moratorium_v1` | Rates storage/read paths (`web/storage.js:163`, `web/data.js:3859`) | Financial input hash/calculation input |
| `jkh_transfer_to_v1:*`, `jkh_transfer_balance_v1:*`, `jkh_freeze_to_v1:*` | Responsibility transfer/freeze (`web/storage.js:363`, `web/data.js:6698`) | Financial input and ledger generation |

Lower-risk UI-only storage:

| Key/prefix | Current use | Contract |
|---|---|---|
| `payments_ui_collapsed_<id>` | Payment table collapsed UI state (`web/storage.js:362`, `web/payment_table.js:1356`) | UI-only |
| index in-memory state (`indexSummaryState`, batch progress state) | Dashboard rendering/progress (`web/index.html:1550`, `web/index.html:1568`) | UI-only unless explicit batch action starts |
| temporary session state `jkh_period_recalc_state_v1:*` | Return/period flow state (`web/abonent_card.html:1549`) | UI/report-only |

Storage writes that can mark dirty:

- `writePaymentLedger()` and `writePaymentLedgerServerBacked()` invalidate runtime/snapshot and schedule summary dirty (`web/data.js:1983`, `web/data.js:2082`).
- `markAbonentSummaryDirty()` posts dirty status to backend (`web/data.js:3327`, `backend/app.py:3118`).
- `invalidateCardSnapshot()` marks local snapshot dirty (`web/data.js:1411`).

Storage writes that must not mark dirty:

- Backend snapshot hydration to local/project cache (`web/data.js:1123`).
- `calc_period_*` / `report_period_*` view-state writes. Current tests assert `CALC_PERIOD_CHANGED` is skipped/masked for index dirty (`backend/tests/test_abonent_summary_rebuild.py:635`, `backend/tests/test_abonent_summary_rebuild.py:684`).

## 14. Current violations found

1. Backend snapshot PUT is under-validated.
   - `card_snapshot_put()` forces fresh and writes snapshot JSON without enforcing rows, full mode, or successful full-recalc provenance (`backend/app.py:3744`).
   - Severity: high boundary risk, partial current-flow risk.

2. Local/project snapshot can still drive card render/status before backend read-through.
   - `readCardSnapshot()` marks dirty from local hash/version comparison (`web/data.js:1048`), and `loadAbonentSummaryStatus()` reads local snapshot before backend fallback (`web/abonent_card.html:4183`).
   - Recent read-through reduces this, but local render/status remains influential.
   - Severity: high lifecycle risk.

3. Runtime cache is a competing render/recalc shortcut.
   - `tryReuseFreshFullRecalcRuntimeCache()` can return ALREADY_FRESH (`web/payment_table.js:3902`).
   - Runtime cache writes happen before and after summary save (`web/payment_table.js:6115`, `web/payment_table.js:6197`).
   - Severity: medium/high; useful optimization but must never be canonical truth.

4. Period/report keys are still in card render/scope lifecycle.
   - `calc_period_*` and `report_period_*` are read/written by card bootstrap and period/report flows (`web/abonent_card.html:2787`, `web/abonent_card.html:3081`, `web/abonent_card.html:3421`).
   - Guards exist, but these keys can still affect card render mode and compatibility decisions.
   - Severity: medium.

5. Status/reason normalization differs between index, card, and backend.
   - Index normalizes stale to dirty and only accepts fresh/dirty/missing/error/invalid (`web/index.html:799`).
   - Card allows extra statuses such as calculating, cancelled, timeout, already_running (`web/abonent_card.html:3895`).
   - Backend cache status set is narrower (`backend/app.py:1553`).
   - Severity: medium; can confuse lifecycle decisions if reasons are reused across screens.

## 15. Minimal fix plan

1. Backend snapshot write gate:
   - Make `/api/card_snapshot/<uid>` reject snapshots without non-empty `rowsById`, full-scope mode, compatible UID, and a clear successful full-recalc provenance field.
   - Do not change formulas.

2. Separate last successful snapshot from error/current status:
   - Keep `CardSnapshot` as last successful full snapshot.
   - Store failed/error status in `AbonentSummary` or a separate status field without overwriting `CardSnapshot.snapshot_json`.

3. Card open contract:
   - On open/F5, read backend fresh compatible snapshot before presenting dirty/recalc when local snapshot is missing/dirty.
   - Treat local `card_snapshot_<uid>` only as a cache copy.
   - Remove or permanently disable auto-recalc on navigation; card should show "needs recalculation" and require explicit manual action.

4. Index passive contract:
   - Keep index passive load read-only.
   - Render last successful totals when dirty/error exists and a successful snapshot/summary is available.
   - Do not let passive index writes alter freshness.

5. Period/report isolation:
   - Keep `runTemporaryPeriodCalculation()` and period/report summaries isolated.
   - Add a guard/test that no period/report path calls `saveCardSnapshotAndWait()`, `saveAbonentSummaryAfterRecalc()` with full scope, or batch `complete_uid` fresh.

6. Normalize status/reason contract:
   - Define backend enum names for canonical state: `fresh`, `dirty`, `missing`, `error`, `invalid`.
   - Let card-only transient statuses remain UI-only: `calculating`, `already_running`, `cancelled`, `timeout`.
   - Do not force index and card UI to be identical.

## 16. Regression tests needed

Backend tests:

1. `card_snapshot_put` rejects empty/missing `rowsById`.
2. `card_snapshot_put` rejects period/report snapshots as canonical snapshots.
3. Failed/error batch completion does not overwrite existing backend `CardSnapshot.snapshot_json`.
4. Existing fresh snapshot remains after `abonent_summary_rebuild` receives error summary.
5. `CALC_PERIOD_CHANGED` remains view-only and does not dirty existing fresh summary.

Frontend/source contract tests:

1. Card open with backend fresh snapshot and missing/dirty local snapshot hydrates local cache and does not call `fullRecalcForCurrentAbonent()`.
2. Card open/F5 with fresh compatible backend snapshot renders fresh and does not request auto-recalc.
3. Incompatible backend snapshot allows "needs recalculation" but does not auto-run full recalc from navigation.
4. Period/report calculation calls `runTemporaryPeriodCalculation()` and never `saveCardSnapshotAndWait()`.
5. Period/report calculation returns skipped/not-saved summary status and does not alter main summary UI after completion.
6. Index passive render does not call `Data.recalculateAbonentCardWithRows()`, `Data.saveCardSnapshotAndWait()`, or dirty APIs.
7. Runtime cache ALREADY_FRESH path cannot write backend `CardSnapshot` unless it is inside an explicit successful full recalc flow with rows.

