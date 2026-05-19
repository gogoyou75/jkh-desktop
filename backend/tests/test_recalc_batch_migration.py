import unittest
from pathlib import Path


class RecalcBatchMigrationTest(unittest.TestCase):
    def test_stage9_migration_defines_required_tables_and_indexes(self):
        sql = Path("backend/migrations/005_recalc_batch_jobs.sql").read_text(encoding="utf-8")

        required_fragments = [
            "CREATE TABLE IF NOT EXISTS recalc_batch_jobs",
            "CREATE TABLE IF NOT EXISTS recalc_batch_job_items",
            "owner_id VARCHAR(128) NOT NULL",
            "status VARCHAR(32) NOT NULL DEFAULT 'queued'",
            "job_id INT NOT NULL",
            "account_uid VARCHAR(128) NOT NULL DEFAULT ''",
            "KEY ix_recalc_batch_jobs_owner_id (owner_id)",
            "KEY ix_recalc_batch_jobs_status (status)",
            "KEY ix_recalc_batch_job_items_job_id (job_id)",
            "KEY ix_recalc_batch_job_items_account_uid (account_uid)",
            "KEY ix_recalc_batch_job_items_status (status)",
            "FOREIGN KEY (job_id) REFERENCES recalc_batch_jobs(id)",
        ]

        for fragment in required_fragments:
            self.assertIn(fragment, sql)


if __name__ == "__main__":
    unittest.main()
