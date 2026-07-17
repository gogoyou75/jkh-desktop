# Card State Sources Audit

## 1. Executive summary

The card and index do not use a single source of truth for the same financial state.

Observed sources:

- Backend `abonent_summary` table: used by index summary API and batch completion.
- Backend `card_snapshot` table: used by batch fresh guard and `/api/card_snapshot/<uid>` diagnostics/save.
- Project storage/local cache `card_snapshot_<uid>`: primary source for card status/totals on card load.
- Project storage/local cache `payments_<uid>`: canonical payment ledger for card/table calculations.
- Project storage/local cache `ledger_runtime_cache_<uid>`: runtime `rowsById` cache for payment table render and fast full recalc reuse.
- In-memory payment-table calculated rows: another render cache that can be captured into snapshots.
- Legacy/project storage keys: still used for tariffs, rates, excludes, moratorium, transfer/freeze metadata, calc/report period, notes, collapsed UI state, and legacy payment fallbacks.

The most dangerous architectural split is that index batch marks backend summary fresh only after backend `card_snapshot` is fresh, but card open reads `Data.readCardSnapshot()` from project storage (`card_snapshot_<uid>` via `JKHStore`) rather than using backend summary as the primary status source. If local/project snapshot is missing, stale, invalid, period-scoped, or input-hash mismatched, the card can display dirty/missing and may request another card recalc even after index has accepted a fresh backend snapshot.

No formulas or tariff logic were changed in this audit.

## 2. Files inspected

- `web/abonent_card.html`
- `web/payment_table.js`
- `web/data.js`
- `web/storage.js`
- `web/index.html`
- `backend/app.py`
- Related tests discovered under `backend/tests/`, especially summary/snapshot/recalc coverage.

Graphify was queried first, but the query only returned `backend/app.py:index()` and was not sufficient for this lifecycle. Conclusions below are verified against source code.

## 3. Source-of-truth map

| State | Primary readers | Primary writers | Notes |
| --- | --- | --- | --- |
| Payment ledger rows | `Data.readPaymentLedger()` in `web/data.js:1810`; `getPayments()` in `web/payment_table.js:2438` | `Data.writePaymentLedger()` in `web/data.js:1882`; `Data.writePaymentLedgerServerBacked()` in `web/data.js:1981`; payment table edits save through `savePaymentsAndFlush()` in `web/payment_table.js:2714` | Canonical key is `payments_<uid>` from `resolvePaymentLedgerKey()` in `web/data.js:816`. Legacy `payments_<LS>` is read-only fallback only when no valid UID exists. |
| Backend summary | `Data.loadAbonentSummaryPage()` in `web/data.js:3190`; index `loadPassiveSummaryPage()` in `web/index.html:1181` | `saveAbonentSummaryAfterRecalc()` in `web/data.js:3401`; backend `/api/abonent_summary/rebuild` in `backend/app.py:3341`; batch complete in `backend/app.py:2072` | Index displays totals only when summary is `fresh` and totals validate. |
| Card snapshot local/project cache | `Data.readCardSnapshot()` in `web/data.js:1048`; card `loadAbonentSummaryStatus()` in `web/abonent_card.html:4119`; payment table restore in `web/payment_table.js:684` and `web/payment_table.js:868` | `Data.saveCardSnapshot()` in `web/data.js:1116`; `Data.saveCardSnapshotAndWait()` in `web/data.js:1161`; index batch in `web/index.html:2017` | Local key is `card_snapshot_<uid>`. Card treats this as authoritative for status/totals. |
| Backend card snapshot table | Backend `CardSnapshot` model in `backend/app.py:278`; `/api/card_snapshot/<account_uid>` in `backend/app.py:3728` and `backend/app.py:3743` | `Data.saveCardSnapshotToBackend()` in `web/data.js:1143`; `Data.saveCardSnapshotAndWait()` in `web/data.js:1161` | Batch completion fresh guard requires this table row to be fresh and contain non-empty `rowsById` (`backend/app.py:1995`). |
| Runtime rows cache | `Data.readLedgerRuntimeCache()` in `web/data.js:1618`; `applyRuntimeCacheToRows()` in `web/payment_table.js:906`; `tryReuseFreshFullRecalcRuntimeCache()` in `web/payment_table.js:3902` | `Data.writeLedgerRuntimeCache()` in `web/data.js:1645`; full recalc in `web/payment_table.js:5878` | Key is `ledger_runtime_cache_<uid>`. A valid runtime cache can avoid recomputing rows. |
| In-memory calculated rows | `renderCalculatedRowsDirect()` in `web/payment_table.js:4556`; `getCalculatedRenderRowsForView()` path around `web/payment_table.js:4860` | `setPaymentTableCalculatedRenderState()` in `web/payment_table.js:258`; `capturePaymentTableComputedRowsSnapshot()` in `web/payment_table.js:659` | Can override raw ledger render without persisted saved rows. |
| Index cache/status | `indexSummaryState`, `summaryBatchJobState`, `summaryBatchProgressState` in `web/index.html:369` | Index batch UI and API responses | UI state only, except selected UIDs drive batch recalculation/snapshot creation. |

## 4. localStorage key map

Project-scoped data keys are recognized by `storage.js` and bridged from direct `localStorage.*` to `JKHStore` for known project keys (`web/storage.js:488`, `web/storage.js:511`). Upload-allowed project keys are defined in `web/storage.js:1033`.

| Key or prefix | Use | Calculation/render impact |
| --- | --- | --- |
| `payments_<uid>` | Canonical payment ledger (`web/data.js:816`, `web/data.js:1810`) | High. Source rows for calculations and table render. |
| `payments_<LS>` | Legacy ledger fallback when valid UID is absent (`web/data.js:1810`) | High for old/no-UID records; can affect render/calculation if fallback is used. |
| `card_snapshot_<uid>` | Local/project card snapshot (`web/data.js:956`, `web/data.js:1048`) | High. Card status/totals and payment-table restored rows can come from it. |
| `ledger_runtime_cache_<uid>` | Runtime rowsById cache (`web/data.js:829`, `web/data.js:1618`) | High. Can skip recomputation and render calculated rows. |
| `calc_period_uid_<uid>`, `calc_period_active_uid_<uid>` | Card selected calculation period (`web/data.js:644`, `web/abonent_card.html:3418`) | High. Period state changes summary scope/render and can trigger dirty/mismatch paths. |
| `report_period_uid_<uid>` | Reports/spravka period (`web/data.js:661`, `web/abonent_card.html:2752`) | Medium/high. Should be report-only, but legacy contamination guards exist. |
| `exclude_periods_<uid>` / `exclude_periods_v1` | Penalty exclusion periods (`web/data.js:325`, `web/payment_table.js:4103`) | High. Included in financial input hash and penalty calculation. |
| `moratorium_<uid>` | Moratorium flag (`web/payment_table.js:4104`, `web/abonent_card.html:2634`) | High. Included in fingerprint paths and rate behavior. |
| `tariffs_<ownerId>`, `tariffs_v1` | Tariffs (`web/data.js:907`, `web/data.js:939`) | High. Financial input hash and accrual calculation dependency. |
| `refinancing_rates_normal_v1`, `refinancing_rates_moratorium_v1`, `ref_rates_*` | Penalty rates (`web/data.js:908`, `web/payment_table.js:4167`) | High. Penalty calculation dependency. |
| `jkh_freeze_to_v1:<id>` | Responsibility transfer freeze date (`web/data.js:6596`) | High. Transfer calculations and fast-recalc precondition (`web/payment_table.js:3474`). |
| `jkh_frozen_debt_v1:<id>:<date>` | Frozen debt/penalty snapshot (`web/data.js:6597`) | High. Transfer state can affect debt carryover. |
| `jkh_transfer_to_v1:<id>` | Transfer metadata (`web/data.js:6598`) | High. Transfer/recalc lifecycle. |
| `jkh_transfer_balance_v1:<id>:<regnum>` | Canonical transfer balance (`web/data.js:6599`) | High. Used by calc engine path and fast-recalc guard. |
| `payment_sources_v1` | Source names for payment UI (`web/payment_table.js:1403`) | Low/medium. Mostly UI labels, but edits can update rows' source field. |
| `payments_ui_collapsed_<id>` | Collapsed month UI state (`web/payment_table.js:1352`) | Safe UI-only. |
| `note_<id>` | Abonent note (`web/index.html:508`, `web/abonent_card.html:2671`) | Safe UI/content-only for calculations. |
| `jkh_sync_mode_v1` | Offline/online mode (`web/storage.js:810`; direct read in `web/index.html:1159`) | Medium. Does not change formulas but changes data source availability/sync behavior. |
| `jkh_sync_*` autosync/status keys | Sync configuration and status (`web/storage.js:810`) | Mostly infrastructure/UI; can affect whether local cache is source. |
| `CRITICAL_ASSERT_THROW` | Dev assertion behavior (`web/index.html:421`) | Safe diagnostic-only. |
| `stage16_recalc_lock_<uid>` in `sessionStorage` | Local recalc lock (`web/data.js:5482`, `web/data.js:5510`) | Medium. Prevents duplicate recalc in same browser/session. |
| Last-added payment ID in `sessionStorage` | Row highlight (`web/payment_table.js:2297`) | Safe UI-only. |

## 5. Card lifecycle: open card directly

1. Card hydrates runtime DB from `abonents_db_v1` via `JKHStore.getJSON/getRaw` (`web/abonent_card.html:743`, `web/abonent_card.html:828`).
2. Payment table boot waits for hydrated DB and data readiness, then resolves `paymentsKey()` (`web/payment_table.js:4602`, `web/payment_table.js:1691`).
3. Payment rows come through `getPayments()` (`web/payment_table.js:2438`), which delegates to the data/store layer and ultimately canonical ledger key resolution in `Data.resolvePaymentLedgerKey()` (`web/data.js:816`) and `Data.readPaymentLedger()` (`web/data.js:1810`).
4. Card status/totals are loaded by `loadAbonentSummaryStatus()` (`web/abonent_card.html:4119`).
5. `loadAbonentSummaryStatus()` reads `Data.readCardSnapshot(uid)` only. It does not fetch backend `abonent_summary` as a fallback for card status/totals.
6. If local/project snapshot is missing, dirty, stale by ledger/input hash, or lacks usable `rowsById`, the card renders `missing`/`dirty` and/or renders totals from the dirty snapshot (`web/abonent_card.html:4119`, `web/abonent_card.html:4109`).
7. Payment table can restore rows from in-memory calculated state, a fresh card snapshot, a display-only dirty snapshot, runtime cache, or raw ledger (`web/payment_table.js:4602`).

## 6. Card lifecycle: open from index after snapshot exists

1. Index uses passive summary mode when `Data.loadAbonentSummaryPage()` exists (`web/index.html:788`).
2. Index fetches `/api/abonents` or `/api/abonent_summary` through `Data.loadAbonentSummaryPage()` (`web/data.js:3190`) and `loadPassiveSummaryPage()` (`web/index.html:1181`).
3. Index row values are built by `buildIndexRowFromSummaryItem()` (`web/index.html:1000`) from backend summary payload/columns, not from local card snapshot.
4. Index treats fresh totals as displayable only when `validateIndexSummaryTotals()` passes (`web/index.html:910`).
5. Snapshot backfill candidates are identified from backend row fields `snapshot_status`, `hash_mismatch`, and warnings (`web/index.html:1482`).
6. When running selected batch, index calls `Data.recalculateAbonentCardWithRows()` (`web/index.html:2065`), builds a snapshot, saves it with `Data.saveCardSnapshotAndWait()` (`web/index.html:2110`, `web/index.html:2120`), then calls `Data.completeRecalcUid()` (`web/index.html:2129`).
7. Backend `complete_uid` accepts `fresh` only if `_client_recalc_fresh_guard()` finds a fresh backend `CardSnapshot` row with non-empty `rowsById` (`backend/app.py:1995`, `backend/app.py:2072`).
8. After index completes, opening the card still depends on local/project `card_snapshot_<uid>` being present and matching current local input hash. Backend summary freshness alone is not enough for the card load path.

## 7. Recalc lifecycle

Manual card full recalc:

1. `fullRecalcForCurrentAbonent()` starts in `web/payment_table.js:5878`.
2. It obtains a recalc lock via `Data.beginRecalcUidLock()` (`web/payment_table.js:5943`, backend route `backend/app.py:3793`).
3. It may reuse fresh runtime cache and fresh card snapshot via `tryReuseFreshFullRecalcRuntimeCache()` (`web/payment_table.js:3902`).
4. Otherwise it builds runtime `rowsById` with `buildRowsByIdFastVerified()` (`web/payment_table.js:3798`) or `buildRowsByIdSlowLegacy()` (`web/payment_table.js:3452`).
5. It writes `ledger_runtime_cache_<uid>` before summary save (`web/payment_table.js:6107`).
6. It calls `Data.recalculateAbonentCard()` (`web/payment_table.js:6143`), which delegates to `recalcAbonentSummaryExplicit()` (`web/data.js:5582`, `web/data.js:5353`) and saves summary through `/api/abonent_summary/rebuild` when appropriate.
7. It reuses the same fresh rows after summary save and rewrites runtime cache (`web/payment_table.js:6187`).
8. It rerenders table in `readonly_no_recalc` mode (`web/payment_table.js:6211`).

Index batch recalc/snapshot:

1. Index creates a server batch job (`web/index.html:1768`, `backend/app.py:3240`).
2. Client worker obtains next UID (`web/index.html:2017`, backend `backend/app.py:2023`).
3. Client calculates summary and rows (`web/index.html:2065`, `web/data.js:5732`).
4. Client builds/saves card snapshot (`web/index.html:2110`, `web/index.html:2120`).
5. Backend completion verifies backend snapshot and then updates `abonent_summary` (`backend/app.py:1995`, `backend/app.py:2072`).

## 8. Runtime rows lifecycle

Runtime computed rows are created by:

- `runtimeRowsByIdFromRows()` in `web/payment_table.js:154` for period/render rows.
- `buildRowsByIdSlowLegacy()` in `web/payment_table.js:3452`.
- `buildRowsByIdFastCore()` in `web/payment_table.js:3678`.
- `buildRowsByIdFastVerified()` in `web/payment_table.js:3798`.
- `Data.buildRowsByIdFromLedgerForSnapshot()` in `web/data.js:4178`.
- Experimental builders in `web/data.js:4570` and `web/data.js:4624`.
- Temporary court/report period builder path used by `runTemporaryPeriodCalculation()` in `web/payment_table.js:5068`.

Runtime rows override saved/raw rows when:

- `applyFreshCalculatedRowsForRender()` matches current view/signature inside `loadPaymentTableImpl()` (`web/payment_table.js:4602`).
- `tryApplyCardSnapshotToRows()` validates a fresh snapshot and applies `rowsById` (`web/payment_table.js:684`).
- `tryApplyDisplayOnlyCardSnapshotRows()` applies dirty/stale snapshot rows for display only (`web/payment_table.js:868`).
- `applyRuntimeCacheToRows()` applies `ledger_runtime_cache_<uid>` (`web/payment_table.js:906`).
- `applyComputedSnapshotRowsToLedgerRows()` backfills computed fields when raw ledger has no totals (`web/payment_table.js:610`).
- `renderCalculatedRowsDirect()` can render calculated rows before data hydration completes (`web/payment_table.js:4556`).

## 9. Dangerous legacy dependencies

1. `card_snapshot_<uid>` local/project cache can override backend truth on card open because card status/totals are sourced from `Data.readCardSnapshot()` (`web/abonent_card.html:4119`, `web/data.js:1048`).
2. `ledger_runtime_cache_<uid>` can make recalc return `ALREADY_FRESH` when runtime cache and local snapshot validate (`web/payment_table.js:3902`).
3. Legacy `payments_<LS>` read-only fallback still affects old/no-UID records (`web/data.js:1810`).
4. `calc_period_*` / `report_period_*` legacy and canonical period keys can change period scope and produce dirty/mismatch display states (`web/abonent_card.html:2737`, `web/abonent_card.html:3418`).
5. Local financial inputs (`exclude_periods_*`, `moratorium_*`, rates, tariffs, transfer/freeze keys) are part of input hash/versioning and can make a backend-fresh snapshot locally dirty (`web/data.js:923`, `web/abonent_card.html:4109`).

## 10. Safe localStorage usages

Safe or mostly UI-only:

- `payments_ui_collapsed_<id>` for month collapse state (`web/payment_table.js:1352`).
- `note_<id>` for notes (`web/index.html:508`, `web/abonent_card.html:2671`).
- `CRITICAL_ASSERT_THROW` diagnostic assert mode (`web/index.html:421`).
- Last-added payment row ID in `sessionStorage` (`web/payment_table.js:2297`).
- Temporary return/report session data in `sessionStorage` (`web/abonent_card.html:1548`), provided it does not write canonical period keys.

Not safe to treat as UI-only:

- `jkh_sync_mode_v1`, because offline mode changes whether local cache can become the operational data source (`web/index.html:1159`, `web/storage.js:110`).
- `payment_sources_v1`, because source-label edits can update payment row source values (`web/payment_table.js:1403`, `web/payment_table.js:6388`).

## 11. Suspected root cause

The card/index lifecycle has two freshness contracts:

1. Index/backend contract: `abonent_summary` can become fresh after the client saves a backend `card_snapshot` table row and backend validates that row in `_client_recalc_fresh_guard()` (`backend/app.py:1995`).
2. Card contract: card freshness is based on local/project `card_snapshot_<uid>` from `Data.readCardSnapshot()` and current local financial input hash (`web/abonent_card.html:4119`, `web/data.js:1048`).

These contracts can diverge. A backend-fresh summary/snapshot does not guarantee that the card's local/project snapshot exists, matches local `payments_<uid>`, matches local rates/tariffs/excludes/moratorium/transfer keys, has full-mode rows, or has a compatible runtime signature. That explains why the card can recalc again after index already created a fresh snapshot.

## 12. Recommended minimal fix plan

Do not change formulas or tariff logic.

1. Define one explicit card open precedence rule:
   - Prefer backend `card_snapshot` table or backend summary when server is available.
   - Use local/project `card_snapshot_<uid>` only as cache/read-through copy, not as an independent truth.
2. Add a read-through hydration step: when card local snapshot is missing/dirty but backend snapshot is fresh and matches input hash/ledger version, copy backend snapshot into `card_snapshot_<uid>` before rendering dirty.
3. Make card `loadAbonentSummaryStatus()` record source in debug output: `backend_card_snapshot`, `local_card_snapshot`, `backend_summary`, `runtime_cache`, or `raw_ledger`.
4. Gate auto-recalc: before `__requestCardAutoRecalc()` can start, check backend snapshot/summary freshness if server is online.
5. Keep legacy localStorage reads, but classify them in code comments and tests; do not remove yet.
6. Add regression tests for lifecycle behavior before formula changes.

Rollback plan: revert only the read-through/gating changes. Existing local `card_snapshot_<uid>` and backend snapshot data can remain; no data migration is required for rollback.

## 13. Recommended regression tests

Manual tests:

1. Open index in summary mode with a UID whose backend summary and backend card snapshot are fresh; open card and verify no auto-recalc starts.
2. Delete only local/project `card_snapshot_<uid>`, keep backend card snapshot fresh; open card and verify backend snapshot hydrates local cache or card remains fresh without recalc.
3. Change `payments_<uid>` locally after fresh backend snapshot; open card and verify snapshot becomes dirty because input hash/ledger version changed.
4. Set active period keys and open card; verify full summary is not overwritten by period/report summary.
5. Old/no-UID record with only `payments_<LS>`: verify read-only fallback still works and no canonical write to LS key occurs.

Automated tests:

1. Backend: `complete_uid` rejects fresh when `CardSnapshot` row is missing or has empty `rowsById`.
2. Backend: `complete_uid` accepts fresh only when summary totals are finite and snapshot is fresh.
3. Frontend unit/integration: card local snapshot missing but backend snapshot fresh does not call `fullRecalcForCurrentAbonent()`.
4. Frontend unit/integration: local financial input hash mismatch marks local snapshot dirty and does not present fresh status.
5. Frontend unit/integration: `readonly_no_recalc` table load restores rows from snapshot/runtime cache without scheduling heavy recalculation.
6. Storage regression: `payments_ui_collapsed_*`, `note_*`, and `CRITICAL_ASSERT_THROW` do not affect calculation fingerprints.
7. Storage regression: `exclude_periods_*`, `moratorium_*`, rates, tariffs, and transfer/freeze keys do affect snapshot/input hash validation.

