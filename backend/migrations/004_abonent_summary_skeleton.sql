CREATE TABLE IF NOT EXISTS abonent_summary (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  owner_id VARCHAR(128) NOT NULL,
  abonent_id VARCHAR(128) NOT NULL DEFAULT '',
  account_uid VARCHAR(128) NOT NULL DEFAULT '',
  account_number VARCHAR(128) NOT NULL DEFAULT '',
  summary_json TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_abonent_summary_owner_id (owner_id),
  KEY ix_abonent_summary_abonent_id (abonent_id),
  KEY ix_abonent_summary_account_uid (account_uid),
  KEY ix_abonent_summary_account_number (account_number),
  KEY ix_abonent_summary_updated_at (updated_at)
);
