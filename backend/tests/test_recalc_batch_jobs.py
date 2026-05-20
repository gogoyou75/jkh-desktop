import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from sqlalchemy import create_engine

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import app as app_module


class RecalcBatchJobsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._db_file = tempfile.NamedTemporaryFile(prefix="jkh_stage10_", suffix=".sqlite", delete=False)
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
            app_module.db.session.add(app_module.User(id="owner1", email="o1@test", password_hash="x", role="user", display_name="o1"))
            app_module.db.session.add(app_module.User(id="owner2", email="o2@test", password_hash="x", role="user", display_name="o2"))
            app_module.db.session.add(app_module.KVStore(owner="owner1", k="abonents_db_v1", v=json.dumps({"abonents": {"1001": {"uid": "u1"}, "1002": {"uid": "u2"}, "1003": {"uid": "u3"}}})))
            app_module.db.session.add(app_module.KVStore(owner="owner2", k="abonents_db_v1", v=json.dumps({"abonents": {"2001": {"uid": "u9"}}})))
            app_module.db.session.commit()

    def _login(self, uid):
        with self.client.session_transaction() as s:
            s["user_id"] = uid

    def test_duplicate_same_uids_same_reason_returns_existing_job(self):
        self._login("owner1")
        a = self.client.post("/api/abonent_summary/recalc_batch_job", json={"uids": ["u1", "u2"], "reason": "MANUAL_RECALC"}).get_json()
        b = self.client.post("/api/abonent_summary/recalc_batch_job", json={"uids": ["u1", "u2"], "reason": "MANUAL_RECALC"}).get_json()
        self.assertEqual(a["job_id"], b["job_id"])

    def test_duplicate_uids_different_order_returns_existing_job(self):
        self._login("owner1")
        a = self.client.post("/api/abonent_summary/recalc_batch_job", json={"uids": ["u2", "u1"], "reason": "MANUAL_RECALC"}).get_json()
        b = self.client.post("/api/abonent_summary/recalc_batch_job", json={"uids": ["u1", "u2"], "reason": "MANUAL_RECALC"}).get_json()
        self.assertEqual(a["job_id"], b["job_id"])

    def test_stale_running_job_is_marked_failed_or_stale(self):
        with app_module.app.app_context():
            old = datetime.utcnow() - timedelta(minutes=31)
            job = app_module.RecalcBatchJob(owner_id="owner1", requested_by="owner1", reason="MANUAL_RECALC", status="running", started_at=old)
            app_module.db.session.add(job)
            app_module.db.session.commit()
        self._login("owner1")
        self.client.post("/api/abonent_summary/recalc_batch_job", json={"uids": ["u1"], "reason": "MANUAL_RECALC"})
        with app_module.app.app_context():
            stale = app_module.RecalcBatchJob.query.filter_by(id=1).first()
            self.assertEqual(stale.status, "stale")
            self.assertEqual(stale.error_message, "STALE_RUNNING_RECOVERED")

    def test_cleanup_removes_old_completed_jobs_only(self):
        with app_module.app.app_context():
            old = datetime.utcnow() - timedelta(days=8)
            for i in range(25):
                j = app_module.RecalcBatchJob(owner_id="owner1", requested_by="owner1", reason="R", status="completed", created_at=old, finished_at=old)
                app_module.db.session.add(j)
            app_module.db.session.commit()
        self._login("owner1")
        self.client.post("/api/abonent_summary/recalc_batch_job", json={"uids": ["u1"], "reason": "MANUAL_RECALC"})
        with app_module.app.app_context():
            count = app_module.RecalcBatchJob.query.filter_by(owner_id="owner1", status="completed").count()
            self.assertLessEqual(count, 20)

    def test_max_uid_limit_rejects_oversized_job(self):
        self._login("owner1")
        uids = [f"u{i}" for i in range(101)]
        r = self.client.post("/api/abonent_summary/recalc_batch_job", json={"uids": uids, "reason": "MANUAL_RECALC"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.get_json()["error"], "TOO_MANY_UIDS")

    def test_owner_isolation_jobs_are_not_shared(self):
        self._login("owner1")
        job_id = self.client.post("/api/abonent_summary/recalc_batch_job", json={"uids": ["u1"]}).get_json()["job_id"]
        self._login("owner2")
        r = self.client.get(f"/api/abonent_summary/recalc_batch_job/{job_id}")
        self.assertEqual(r.status_code, 404)

    def test_latest_job_returns_last_owner_job(self):
        self._login("owner1")
        self.client.post("/api/abonent_summary/recalc_batch_job", json={"uids": ["u1"], "reason": "A"})
        b = self.client.post("/api/abonent_summary/recalc_batch_job", json={"uids": ["u2"], "reason": "B"}).get_json()
        latest = self.client.get("/api/abonent_summary/recalc_batch_job/latest").get_json()
        self.assertEqual(latest["job"]["id"], b["job_id"])

    def test_spam_click_creates_only_one_active_job(self):
        self._login("owner1")
        ids = []
        for _ in range(5):
            ids.append(self.client.post("/api/abonent_summary/recalc_batch_job", json={"uids": ["u1", "u2"], "reason": "MANUAL_RECALC"}).get_json()["job_id"])
        self.assertEqual(len(set(ids)), 1)

    def test_status_completed_returns_counters(self):
        self._login("owner1")
        created = self.client.post("/api/abonent_summary/recalc_batch_job", json={"uids": ["u1", "u2"]}).get_json()
        job_id = created["job_id"]
        self.client.post(f"/api/abonent_summary/recalc_batch_job/{job_id}/run")
        status = self.client.get(f"/api/abonent_summary/recalc_batch_job/{job_id}").get_json()
        self.assertTrue(status["ok"])
        self.assertEqual(status["job_id"], job_id)
        self.assertIn(status["status"], {"running", "completed"})
        self.assertIn("processed", status)
        self.assertIn("total", status)
        self.assertIn("fresh", status)
        self.assertIn("error", status)
        self.assertIn("skipped", status)

    def test_status_failed_returns_reason_message(self):
        with app_module.app.app_context():
            job = app_module.RecalcBatchJob(owner_id="owner1", requested_by="owner1", reason="MANUAL_RECALC", status="failed", error_message="FAILED_REASON")
            app_module.db.session.add(job)
            app_module.db.session.commit()
            job_id = int(job.id)
        self._login("owner1")
        status = self.client.get(f"/api/abonent_summary/recalc_batch_job/{job_id}").get_json()
        self.assertEqual(status["status"], "failed")
        self.assertEqual(status["message"], "FAILED_REASON")

    def test_duplicate_polling_does_not_mutate_completed_job(self):
        self._login("owner1")
        created = self.client.post("/api/abonent_summary/recalc_batch_job", json={"uids": ["u1"]}).get_json()
        job_id = created["job_id"]
        for _ in range(3):
            self.client.get(f"/api/abonent_summary/recalc_batch_job/{job_id}")
        first = self.client.get(f"/api/abonent_summary/recalc_batch_job/{job_id}").get_json()
        second = self.client.get(f"/api/abonent_summary/recalc_batch_job/{job_id}").get_json()
        self.assertEqual(first["processed"], second["processed"])
        self.assertEqual(first["fresh"], second["fresh"])
        self.assertEqual(first["error"], second["error"])

    def test_batch_does_not_accept_fresh_without_totals(self):
        with app_module.app.app_context():
            app_module.db.session.add(app_module.AbonentSummary(
                id=1,
                owner_id="owner1",
                abonent_id="1001",
                account_uid="u1",
                account_number="1001",
                summary_json=json.dumps({
                    "summary_status": "fresh",
                    "status": "fresh",
                    "period": {"from": "2025-01", "to": "2025-02"},
                }),
            ))
            app_module.db.session.commit()
        self._login("owner1")
        created = self.client.post("/api/abonent_summary/recalc_batch_job", json={"uids": ["u1"]}).get_json()
        job_id = created["job_id"]
        self.client.post(f"/api/abonent_summary/recalc_batch_job/{job_id}/run")
        status = self.client.get(f"/api/abonent_summary/recalc_batch_job/{job_id}").get_json()
        self.assertEqual(status["fresh"], 0)
        self.assertEqual(status["error"], 1)
        self.assertEqual(status["items"][0]["summary_status"], "error")
        self.assertEqual(status["items"][0]["summary_reason"], "MISSING_TOTAL_DEBT")

    def test_batch_accepts_fresh_with_totals_and_period(self):
        with app_module.app.app_context():
            app_module.db.session.add(app_module.AbonentSummary(
                id=1,
                owner_id="owner1",
                abonent_id="1001",
                account_uid="u1",
                account_number="1001",
                summary_json=json.dumps({
                    "summary_status": "fresh",
                    "status": "fresh",
                    "total_debt": 11,
                    "total_penalty": 2,
                    "total_accrued": 30,
                    "total_paid": 19,
                    "period": {"start": "2025-01", "end": "2025-02"},
                }),
            ))
            app_module.db.session.commit()
        self._login("owner1")
        created = self.client.post("/api/abonent_summary/recalc_batch_job", json={"uids": ["u1"]}).get_json()
        job_id = created["job_id"]
        self.client.post(f"/api/abonent_summary/recalc_batch_job/{job_id}/run")
        status = self.client.get(f"/api/abonent_summary/recalc_batch_job/{job_id}").get_json()
        self.assertEqual(status["fresh"], 1)
        self.assertEqual(status["error"], 0)


if __name__ == "__main__":
    unittest.main()
