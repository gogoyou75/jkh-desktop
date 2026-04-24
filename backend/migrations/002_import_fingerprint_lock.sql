ALTER TABLE import_batch_rows
  ADD COLUMN IF NOT EXISTS paid_date VARCHAR(10) NOT NULL DEFAULT '' AFTER payment_date,
  ADD COLUMN IF NOT EXISTS applied_at DATETIME NULL AFTER matched_payment_id;

ALTER TABLE import_applied_fingerprints
  ADD COLUMN IF NOT EXISTS import_type VARCHAR(32) NOT NULL DEFAULT 'payments' AFTER owner_id,
  ADD COLUMN IF NOT EXISTS account_uid VARCHAR(191) DEFAULT NULL AFTER fingerprint,
  ADD COLUMN IF NOT EXISTS account_number VARCHAR(191) DEFAULT NULL AFTER account_uid,
  ADD COLUMN IF NOT EXISTS payment_period CHAR(7) DEFAULT NULL AFTER account_number,
  ADD COLUMN IF NOT EXISTS paid_date DATE DEFAULT NULL AFTER payment_period,
  ADD COLUMN IF NOT EXISTS amount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER paid_date,
  ADD COLUMN IF NOT EXISTS source_index INT NOT NULL DEFAULT 1 AFTER amount,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER batch_id,
  MODIFY COLUMN id BIGINT NOT NULL AUTO_INCREMENT,
  MODIFY COLUMN owner_id VARCHAR(191) NOT NULL,
  MODIFY COLUMN fingerprint VARCHAR(255) NOT NULL,
  MODIFY COLUMN batch_id BIGINT NULL,
  MODIFY COLUMN payment_id VARCHAR(64) NOT NULL DEFAULT '';

ALTER TABLE import_applied_fingerprints
  DROP INDEX uq_import_applied_fingerprint,
  ADD UNIQUE KEY uq_owner_import_fp (owner_id, import_type, fingerprint);

CREATE INDEX idx_owner_batch ON import_applied_fingerprints (owner_id, batch_id);
CREATE INDEX idx_owner_account ON import_applied_fingerprints (owner_id, account_number);
