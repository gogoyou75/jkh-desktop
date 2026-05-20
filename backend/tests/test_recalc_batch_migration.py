import unittest
from pathlib import Path


class RecalcBatchMigrationTest(unittest.TestCase):
    def _migration_sql_path(self) -> Path:
        tests_dir = Path(__file__).resolve().parent
        backend_dir = tests_dir.parent
        repo_root = backend_dir.parent
        candidates = [
            repo_root / "backend" / "migrations" / "005_recalc_batch_jobs.sql",
            backend_dir / "migrations" / "005_recalc_batch_jobs.sql",
            Path("/app/migrations/005_recalc_batch_jobs.sql"),
        ]
        for candidate in candidates:
            if candidate.exists():
                return candidate
        self.fail(
            "Migration SQL not found. Checked: "
            + ", ".join(str(path) for path in candidates)
        )

    def test_stage9_migration_defines_required_tables_and_indexes(self):
        sql = self._migration_sql_path().read_text(encoding="utf-8")

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
