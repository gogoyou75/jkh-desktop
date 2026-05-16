# 🔒 CRITICAL INDEX — ПАПАЖКХ

Версия: v1.5.4
Дата фиксации: 2026-05-16

Единый список жёстких канонов и запретов.

---

## 1. CalcEngine Freeze Boundary

- `web/calc_engine.js` — юридическое расчётное ядро и единственный источник финансовой формулы.
- Запрещено менять `calc_engine.js` для performance optimization, precompute, alternate-pass или second-pass без отдельного архитектурного ТЗ.
- Запрещены alternate calc pipeline, multi-path financial execution, precomputed penalty/FIFO engine, optimized FIFO path, vectorized penalty calculations and alternate totals path.
- UI, summary/cache and server prepared data не имеют права считать долг, пеню или FIFO собственной формулой.
- Summary/cache являются derived cache only и не могут быть вторым financial engine.

## 2. Dangerous commits / DO NOT PORT

Dangerous commits для стабильной базовой ветки:
- `d535dba`;
- `6780a25`.

Из этих commits запрещено переносить code-paths, связанные с:
- `prepareLedgerState`;
- single-pass totals precompute;
- precomputed penalty engine;
- precomputed FIFO / optimized FIFO path;
- alternate totals calculation;
- calc-engine perf pipelines;
- `calc-precompute` / `calc-apply` runtime paths.

## 3. Safe canon allowed in stable baseline

Разрешённый canon для переноса и синхронизации:
- server-first owner-scoped load;
- UID-only `payments_<uid>` ledger;
- `payments_<LS>` only as read-only legacy fallback inside service layer;
- canonical transfer flow through `Data.transferResponsibility(...)`;
- canonical financial modes `WITH_DEBT` and `WITHOUT_DEBT` / `NO_DEBT`;
- canonical `calc_period_<uid>` and `calc_period_active_<uid>`;
- calc summary integrity with checkpoint and fresh-only reads;
- strict import contract and import audit log;
- owner isolation from server session;
- upload whitelist;
- read-back validation before legacy cleanup.

## 4. Safe hardening required

- Fatal instead of silent fallback for missing/corrupt financial inputs.
- Read-only page open must not trigger write-side-effect, autoaccrual apply or summary recalculation.
- Stale/dirty/mismatch/invalid summary must show recalculation required and must not provide old totals as current.
- Import apply must remain atomic and auditable.
- Legacy/admin/global/foreign-owner keys must not be uploaded to `/api/store`.

## 5. Server Summary Layer boundary

Server Summary Layer may be prepared only as foundation until a separate implementation task exists.

Allowed now:
- interface/contract documentation;
- TODO/CRITICAL comments;
- data boundary descriptions;
- read-only derived-cache semantics.

Forbidden now:
- new financial engine;
- Python/Pandas CalcEngine replacement;
- changes to legal formula;
- changes to FIFO logic;
- changes to penalty logic;
- alternate totals fallback.
