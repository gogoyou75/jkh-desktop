# DEPLOY CHECKLIST

## Stage 16 DB Migration

Run schema migration before enabling Stage 16 on an existing database.

```sql
CREATE TABLE IF NOT EXISTS card_snapshot (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  owner_id VARCHAR(128) NOT NULL,
  abonent_uid VARCHAR(128) NOT NULL,
  abonent_id VARCHAR(128) NOT NULL DEFAULT '',
  snapshot_status VARCHAR(32) NOT NULL DEFAULT 'missing',
  snapshot_reason VARCHAR(128) NOT NULL DEFAULT '',
  input_hash VARCHAR(64) NOT NULL DEFAULT '',
  ledger_version VARCHAR(64) NOT NULL DEFAULT '',
  tariff_version VARCHAR(64) NOT NULL DEFAULT '',
  rate_version VARCHAR(64) NOT NULL DEFAULT '',
  exclude_version VARCHAR(64) NOT NULL DEFAULT '',
  links_version VARCHAR(64) NOT NULL DEFAULT '',
  engine_version VARCHAR(64) NOT NULL DEFAULT 'JKHCalcEngine:stage16-mvp',
  computed_at DATETIME NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  snapshot_json TEXT NOT NULL,
  UNIQUE KEY uq_card_snapshot_owner_uid (owner_id, abonent_uid)
);

CREATE TABLE IF NOT EXISTS recalc_uid_locks (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  owner_id VARCHAR(128) NOT NULL,
  abonent_uid VARCHAR(128) NOT NULL,
  lock_token VARCHAR(64) NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'running',
  started_at DATETIME NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_recalc_uid_lock_owner_uid (owner_id, abonent_uid)
);
```

If `abonent_summary` already exists, add the Stage 16 columns:

```sql
ALTER TABLE abonent_summary
  ADD COLUMN fio VARCHAR(255) NOT NULL DEFAULT '',
  ADD COLUMN address VARCHAR(1024) NOT NULL DEFAULT '',
  ADD COLUMN total_accrued DECIMAL(14,2) NULL,
  ADD COLUMN total_paid DECIMAL(14,2) NULL,
  ADD COLUMN main_debt DECIMAL(14,2) NULL,
  ADD COLUMN penalty_debt DECIMAL(14,2) NULL,
  ADD COLUMN total_debt DECIMAL(14,2) NULL,
  ADD COLUMN summary_status VARCHAR(32) NOT NULL DEFAULT 'missing',
  ADD COLUMN summary_reason VARCHAR(128) NOT NULL DEFAULT '',
  ADD COLUMN input_hash VARCHAR(64) NOT NULL DEFAULT '',
  ADD COLUMN dirty_since DATETIME NULL,
  ADD COLUMN last_error_code VARCHAR(64) NOT NULL DEFAULT '';
```

Post-deploy checks:

```sql
DESCRIBE card_snapshot;
DESCRIBE abonent_summary;
DESCRIBE recalc_uid_locks;
```
