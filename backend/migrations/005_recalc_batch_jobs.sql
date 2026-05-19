CREATE TABLE IF NOT EXISTS recalc_batch_jobs (
    id INT NOT NULL AUTO_INCREMENT,
    owner_id VARCHAR(128) NOT NULL,
    requested_by VARCHAR(64) NOT NULL DEFAULT '',
    reason VARCHAR(64) NOT NULL DEFAULT '',
    status VARCHAR(32) NOT NULL DEFAULT 'queued',
    total_count INT NOT NULL DEFAULT 0,
    processed_count INT NOT NULL DEFAULT 0,
    fresh_count INT NOT NULL DEFAULT 0,
    error_count INT NOT NULL DEFAULT 0,
    skipped_count INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME NULL,
    finished_at DATETIME NULL,
    error_message TEXT NOT NULL,
    PRIMARY KEY (id),
    KEY ix_recalc_batch_jobs_owner_id (owner_id),
    KEY ix_recalc_batch_jobs_status (status)
);

CREATE TABLE IF NOT EXISTS recalc_batch_job_items (
    id INT NOT NULL AUTO_INCREMENT,
    job_id INT NOT NULL,
    owner_id VARCHAR(128) NOT NULL,
    account_uid VARCHAR(128) NOT NULL DEFAULT '',
    status VARCHAR(32) NOT NULL DEFAULT 'queued',
    summary_status VARCHAR(32) NOT NULL DEFAULT '',
    summary_reason VARCHAR(128) NOT NULL DEFAULT '',
    started_at DATETIME NULL,
    finished_at DATETIME NULL,
    error_message TEXT NOT NULL,
    PRIMARY KEY (id),
    KEY ix_recalc_batch_job_items_job_id (job_id),
    KEY ix_recalc_batch_job_items_owner_id (owner_id),
    KEY ix_recalc_batch_job_items_account_uid (account_uid),
    KEY ix_recalc_batch_job_items_status (status),
    CONSTRAINT fk_recalc_batch_job_items_job_id
        FOREIGN KEY (job_id) REFERENCES recalc_batch_jobs(id)
);
