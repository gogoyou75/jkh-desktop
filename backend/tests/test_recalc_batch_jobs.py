import json
import os
import sys
import tempfile
import unittest
from sqlalchemy import create_engine

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import app as app_module


class RecalcBatchJobsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._db_file = tempfile.NamedTemporaryFile(prefix="jkh_stage9_", suffix=".sqlite", delete=False)
        cls._db_file.close()
        app_module.app.config["TESTING"] = True
        app_module.app.config["SQLALCHEMY_DATABASE_URI"] = f"sqlite:///{cls._db_file.name}"
        with app_module.app.app_context():
            app_module.db.session.remove()
            engines = app_module.app.extensions["sqlalchemy"].engines
            for e in list(engines.values()):
                e.dispose()
            engines[None] = create_engine(app_module.app.config["SQLALCHEMY_DATABASE_URI"])

    @classmethod
    def tearDownClass(cls):
        os.unlink(cls._db_file.name)

    def setUp(self):
        self.client = app_module.app.test_client()
        with app_module.app.app_context():
            app_module.db.session.remove()
            app_module.db.drop_all()
            app_module.db.create_all()
            app_module.db.session.execute(app_module.text("DROP TABLE abonent_summary"))
            app_module.db.session.execute(app_module.text("""
                CREATE TABLE abonent_summary (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner_id VARCHAR(128) NOT NULL,
                    abonent_id VARCHAR(128) NOT NULL DEFAULT '',
                    account_uid VARCHAR(128) NOT NULL DEFAULT '',
                    account_number VARCHAR(128) NOT NULL DEFAULT '',
                    summary_json TEXT NOT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            """))
            app_module.db.session.add(app_module.User(id="owner1", email="o1@test", password_hash="x", role="user", display_name="o1"))
            app_module.db.session.add(app_module.User(id="owner2", email="o2@test", password_hash="x", role="user", display_name="o2"))
            app_module.db.session.add(app_module.KVStore(owner="owner1", k="abonents_db_v1", v=json.dumps({"abonents": {"1001": {"uid": "u1"}, "1002": {"uid": "u2"}}})))
            app_module.db.session.add(app_module.KVStore(owner="owner2", k="abonents_db_v1", v=json.dumps({"abonents": {"2001": {"uid": "u3"}}})))
            app_module.db.session.add(app_module.AbonentSummary(owner_id="owner1", abonent_id="1001", account_uid="u1", account_number="1001", summary_json=json.dumps({"summary_status": "fresh", "summary_reason": "OK"})))
            app_module.db.session.add(app_module.AbonentSummary(owner_id="owner1", abonent_id="1002", account_uid="u2", account_number="1002", summary_json=json.dumps({"summary_status": "error", "summary_reason": "LEDGER_JSON_INVALID"})))
            app_module.db.session.commit()

    def _login(self, uid):
        with self.client.session_transaction() as s:
            s["user_id"] = uid

    def test_create_job_owner_scope_and_duplicates(self):
        self._login("owner1")
        r = self.client.post("/api/abonent_summary/recalc_batch_job", json={"uids": ["u1", "u1", "u3", "unknown"]})
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body["requested"], 3)
        self.assertEqual(body["accepted"], 1)
        self.assertEqual(body["skipped"], 2)

    def test_run_job_and_status(self):
        self._login("owner1")
        created = self.client.post("/api/abonent_summary/recalc_batch_job", json={"uids": ["u1", "u2"]}).get_json()
        run = self.client.post(f"/api/abonent_summary/recalc_batch_job/{created['job_id']}/run")
        self.assertEqual(run.status_code, 200)
        status = self.client.get(f"/api/abonent_summary/recalc_batch_job/{created['job_id']}").get_json()
        self.assertEqual(status["job"]["processed_count"], 2)
        self.assertEqual(status["job"]["fresh_count"], 1)
        self.assertEqual(status["job"]["error_count"], 1)


if __name__ == "__main__":
    unittest.main()
