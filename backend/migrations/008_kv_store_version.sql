-- MySQL 8.0 / InnoDB. Run once before deploying the CAS server.
-- The information_schema guard makes a repeated run harmless.
SET @kv_version_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'kv_store'
      AND COLUMN_NAME = 'version'
);
SET @kv_version_ddl := IF(
    @kv_version_exists = 0,
    'ALTER TABLE kv_store ADD COLUMN version BIGINT NOT NULL DEFAULT 0',
    'SELECT 1'
);
PREPARE kv_version_stmt FROM @kv_version_ddl;
EXECUTE kv_version_stmt;
DEALLOCATE PREPARE kv_version_stmt;
