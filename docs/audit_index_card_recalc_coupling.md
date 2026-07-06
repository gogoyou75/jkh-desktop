# Audit: index and abonent card recalculation coupling

Date: 2026-07-06

## Scope

Diagnostic-only audit for the relationship between `index.html`, `abonent_summary`, `card_snapshot`, runtime cache, and abonent card recalculation.

No business logic was changed. `web/calc_engine.js` was not changed or edited.

The requested commands referenced `/root/jkh-lab`; this run used the provided workspace path:

`C:\Users\SERGIO TOBETO\Documents\GitHub\jkh-desktop`

## Repository state

- Branch: `lab-pay-01`
- Last commit before this report: `546436e fix: resolve full recalculation render contract test`
- Dirty files before creating this report: none

Recent commits inspected:

```text
546436e fix: resolve full recalculation render contract test
29e7a68 fix: complete card debt and penalty recalculation without timeout
e026624 fix: avoid false tariffs missing in card recalc preflight
acccd78 debug: trace data summary tariffs reason
4afdd65 debug: trace real source of TARIFFS_NOT_FOUND
e1505cd chore: ignore graphify output files
e788497 restore manual recalc period contract in abonent card
8762863 relax calculated rows matching for payment table render
62d27a4 Graphify installl
4f90ba2 Create HOW_TO_USE.md
```

## Diagnostic commands

Executed:

```text
git status -sb
git branch --show-current
git log --oneline -10
rg -n "card_snapshot|abonent_summary|summary_status|FULL_SUMMARY_REBUILD|snapshot|full_recalc_completed|loadPaymentTable" web backend tests
rg -n "recalc|autoaccrual|calc_engine|buildRows|rebuild|summary" web/abonent_card.html web/payment_table.js web/data.js web/index.html
rg -n "payments_<|payments_|getPaymentsKeyForAbonent|abonent.uid|uid" web/index.html web/abonent_card.html web/payment_table.js web/data.js web/storage.js backend/app.py
rg -n "card_snapshot|abonent_summary|recalc_summary|recalc/batch|api/abonents|FULL_SUMMARY_REBUILD" backend web tests
node --check web/storage.js
node --check web/data.js
node --check web/payment_table.js
python -m py_compile backend/app.py
python -m unittest discover -s tests
python -m unittest discover -s backend/tests
```

`rg` was used instead of `grep` because this workspace is Windows/PowerShell.

## Index recalculation path

Passive `index.html` is explicitly guarded as a read-only summary consumer:

- `web/index.html:352` - comment states index must not read ledgers, trigger recalculation, auto-build summary, auto-repair ledger, or fallback to ledger totals inside passive summary mode.
- `backend/app.py:2984` - `GET /api/abonents` endpoint.
- `backend/app.py:3044` - backend comment states there are no `payments_<uid>` reads inside `GET /api/abonent_summary`; the same read-only summary contract is reflected in the surrounding index API code and tests.

Explicit index batch recalculation exists and is user-triggered:

- `web/index.html:1706` - `runSelectedSummaryBatch(options)`.
- `web/index.html:1793` - `ensureCalcEngineForManualBatch()`.
- `web/index.html:2015` - `processClientSummaryBatchJob(jobId, totalAccepted, mode)`.
- `web/index.html:2064` - snapshot mode calls `Data.recalculateAbonentCardWithRows(...)`.
- `web/index.html:2093` - normal mode calls `Data.recalculateAbonentCard(...)`.
- `web/index.html:2128` - snapshot mode saves the built `card_snapshot` through `Data.saveCardSnapshotAndWait(...)`.
- `web/index.html:2137` - batch completion calls `Data.completeRecalcUid(...)`; backend completion persists the supplied summary for the UID.

Index batch mode therefore can produce both:

- persisted `abonent_summary`;
- persisted/local `card_snapshot`.

No static evidence was found that passive index opening writes `payments_<uid>` or runs calculation.

## Card recalculation and display path

The abonent card loads calculation scripts directly:

- `web/abonent_card.html:27` - loads `autoaccrual_engine.js`.
- `web/abonent_card.html:30` - loads `calc_engine.js`.
- `web/abonent_card.html:1523` - invokes `window.__loadPaymentTable(...)` when available.

Card opening is intentionally read-only:

- `web/abonent_card.html:1733` - comment states opening the card is read-only and must not start auto-recalculation.

Fast totals/status display on card opening depends on a fresh usable card snapshot:

- `web/abonent_card.html:3914` - reads `Data.readCardSnapshot(uid)`.
- `web/abonent_card.html:3924` - `__isFreshCardSnapshotUsable(uid, snapshot)` validates snapshot freshness, row presence, and ledger version.
- `web/abonent_card.html:3962` - rejects unusable snapshot as dirty/missing for display.
- `web/abonent_card.html:3980` - renders totals from fresh snapshot-derived summary.
- `web/abonent_card.html:3997` - `__renderAbonentTotalsFromFreshSummary(summary)`.

Manual full card recalculation is a separate explicit path:

- `web/abonent_card.html:4657` - checks `window.fullRecalcForCurrentAbonent`.
- `web/abonent_card.html:4662` - calls `window.fullRecalcForCurrentAbonent({ applyAutoAccrual: true, recalcMode: "FULL_SUMMARY_REBUILD", summaryScope: "full", ... })`.
- `web/payment_table.js:5685` - defines `window.fullRecalcForCurrentAbonent`.
- `web/payment_table.js:6006` - reloads payment table after summary stage with reason `full_recalc_completed`.

Payment table render can reuse existing derived data:

- `web/payment_table.js:726` and `web/payment_table.js:750` - snapshot validation/read helpers.
- `web/payment_table.js:870` and `web/payment_table.js:872` - snapshot read path used for display logic.
- `web/payment_table.js:3805` - reads `Data.readCardSnapshot(id)`.
- `web/payment_table.js:2393` - `reloadPaymentTableReadonlyNoRecalc(reason)` preserves no-recalc behavior for read-only updates.

## Data and backend write paths

Card snapshot:

- `web/data.js:1105` - POST to `/api/card_snapshot/<uid>`.
- `web/data.js:1118` - `saveCardSnapshotAndWait(abonentOrId, snapshot, options)`.
- `web/data.js:1299` - `buildCardSnapshotFromCurrentResult(abonentOrId, result, options)`.
- `backend/app.py:3695` - `GET /api/card_snapshot/<account_uid>`.
- `backend/app.py:3710` - `POST /api/card_snapshot/<account_uid>`.

Abonent summary:

- `web/data.js:3205` - `saveAbonentSummaryAfterRecalc(abonentOrId, summary)`.
- `web/data.js:3254` - POST to `/api/abonent_summary/rebuild`.
- `web/data.js:3378` - `completeRecalcUid(...)`.
- `web/data.js:5028` - `recalcAbonentSummaryExplicit(abonentOrId, options)`.
- `backend/app.py:3039` - `GET /api/abonent_summary`.
- `backend/app.py:3308` - `POST /api/abonent_summary/rebuild`.

## Coupling verdict

### Does card fast display depend on artifacts index can create?

Yes.

The card uses `card_snapshot_<uid>` / server card snapshot for immediate totals and status on opening. Index explicit snapshot batch can create that same snapshot through `Data.recalculateAbonentCardWithRows(...)` followed by `Data.saveCardSnapshotAndWait(...)`. Therefore the observed behavior is explained for fast display:

`index explicit recalc/backfill -> card_snapshot exists and is fresh -> card opening quickly displays debt/penalty/totals`.

### Is index proven to be a mandatory prerequisite for manual full card recalculation?

Not proven by static audit.

The card has an explicit independent recalculation entry point through `fullRecalcForCurrentAbonent`. Static code shows the card can load `calc_engine.js`, invoke payment table logic, build summary, and save summary/snapshot without going through index. If the manual card button fails when no index-created snapshot exists, that needs a separate runtime trace focused on `fullRecalcForCurrentAbonent`, not a passive-index dependency assumption.

### Is card opening expected to calculate by itself?

No, according to the current documented and implemented contract.

`LOGIC_SPEC.md:9` states card opening is readonly: it may read `card_snapshot_<uid>` and display it when fresh, but must not start automatic recalculation. `docs/CORE/LOGIC_SPEC.md:1543` states summary recalculation is allowed only by explicit user action and read-only page opening must not trigger recalculation.

## Canon checks

- `index.html` as passive overview: no static evidence of ledger reads, hidden recalculation, or payment writes on open.
- Card opening: intentionally read-only; missing snapshot leads to missing/dirty display instead of automatic calculation.
- Canonical ledger: `payments_<uid>` remains the canonical key in current specs and tests.
- Forbidden `payments_<LS>` fallback: no new evidence of index/card passive summary relying on `payments_<LS>` was found in the audited paths. Existing docs still describe legacy fallback only inside constrained service/migration contexts.
- `calc_engine.js`: not edited.
- Read-only opening mutating ledger: not proven in audited index/card open paths.

## Existing relevant tests

Summary and index API:

- `backend/tests/test_abonent_summary_rebuild.py`
- `backend/tests/test_abonent_summary_contract.py`
- `backend/tests/test_abonent_summary_consistency.py`
- `backend/tests/test_abonents_api.py`

Card snapshot:

- `backend/tests/test_card_snapshot_save.py`
- `backend/tests/test_bulk_calc_verify.py`

Client/index recalculation coordination:

- `backend/tests/test_client_recalc_batch.py`
- `backend/tests/test_recalc_batch_jobs.py`
- `backend/tests/test_recalc_batch_migration.py`

UID payments:

- `backend/tests/test_import_payments.py`
- `backend/tests/test_abonent_summary_rebuild.py:470` and `backend/tests/test_abonent_summary_contract.py:300` include static guards around payment keys and summary contracts.

No root `tests/` suite was found/importable in this workspace during `python -m unittest discover -s tests`.

## Verification results

Passed:

```text
node --check web/storage.js
node --check web/data.js
node --check web/payment_table.js
python -m py_compile backend/app.py
python -m unittest discover -s backend/tests
```

Backend tests result:

```text
Ran 159 tests in 45.495s
OK
```

Warnings observed during backend tests:

- Python `DeprecationWarning` for `datetime.utcnow()`.
- Expected application warning logs from legacy/forbidden-owner diagnostic cases.

Failed / not runnable:

```text
python -m unittest discover -s tests
```

Reason:

```text
ImportError: Start directory is not importable: 'tests'
```

The root `tests` directory is missing or not importable in this checkout.

## Financial logic risk

No financial formula, FIFO allocation, penalty formula, payment ledger structure, or `calc_engine.js` logic was changed.

The main architectural risk found is diagnostic/UX ambiguity:

- card opening is read-only by design;
- card opening uses `card_snapshot` for fast totals;
- index explicit snapshot backfill can create that snapshot;
- this can look like the card "depends on index", even though static code still contains an independent explicit full-recalc path.

## Next minimal patch plan

Do not change financial logic first. The next safe patch should add a focused browser or JS contract test that proves one exact scenario:

1. Start with no `card_snapshot_<uid>` and no fresh `abonent_summary` for a UID.
2. Open `abonent_card.html?abonent=<id>` and verify no automatic ledger mutation or recalculation starts.
3. Click explicit `Пересчитать`.
4. Assert `fullRecalcForCurrentAbonent` completes without any prior index batch run.
5. Assert fresh `abonent_summary` and `card_snapshot` are saved for that UID.
6. Assert `index.html` then displays the same derived totals without recalculating.

If this test fails, patch only the explicit card full-recalc chain:

- `web/abonent_card.html` explicit recalc handler;
- `web/payment_table.js` `fullRecalcForCurrentAbonent`;
- `web/data.js` summary/snapshot save calls.

Do not patch passive `index.html` and do not change `web/calc_engine.js`.
