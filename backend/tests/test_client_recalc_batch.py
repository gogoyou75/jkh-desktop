import json
import os
import sys
import tempfile
import unittest
from decimal import Decimal
from sqlalchemy import create_engine

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import app as app_module


class ClientRecalcBatchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._db_file = tempfile.NamedTemporaryFile(prefix="jkh_stage17c_client_recalc_", suffix=".sqlite", delete=False)
        cls._db_file.close()
        app_module.app.config["TESTING"] = True
        app_module.app.config["SQLALCHEMY_DATABASE_URI"] = f"sqlite:///{cls._db_file.name}"
        with app_module.app.app_context():
            app_module.db.session.remove()
            engines = app_module.app.extensions["sqlalchemy"].engines
            for engine in list(engines.values()):
                engine.dispose()
            engines[None] = create_engine(app_module.app.config["SQLALCHEMY_DATABASE_URI"])

    @classmethod
    def tearDownClass(cls):
        with app_module.app.app_context():
            app_module.db.session.remove()
            app_module.db.engine.dispose()
        os.unlink(cls._db_file.name)

    def setUp(self):
        self.client = app_module.app.test_client()
        with app_module.app.app_context():
            app_module.db.session.remove()
            app_module.db.drop_all()
            app_module.db.create_all()
            app_module.db.session.add(app_module.User(id="owner1", email="o1@test", password_hash="x", role="user"))
            app_module.db.session.add(app_module.User(id="owner2", email="o2@test", password_hash="x", role="user"))
            app_module.db.session.add(app_module.KVStore(owner="owner1", k="abonents_db_v1", v=json.dumps({
                "abonents": {
                    "1001": {"uid": "uid-1", "id": "1001", "fio": "One"},
                    "1002": {"uid": "uid-2", "id": "1002", "fio": "Two"},
                }
            })))
            app_module.db.session.add(app_module.KVStore(owner="owner2", k="abonents_db_v1", v=json.dumps({
                "abonents": {
                    "2001": {"uid": "uid-other", "id": "2001", "fio": "Other"},
                }
            })))
            app_module.db.session.commit()

    def _login(self, user_id):
        with self.client.session_transaction() as sess:
            sess["user_id"] = user_id

    def _create_job(self, user_id="owner1", uids=None):
        self._login(user_id)
        response = self.client.post("/api/abonent_summary/recalc_batch_job", json={
            "uids": uids or ["uid-1"],
            "reason": "CLIENT_RECALC",
        })
        self.assertEqual(response.status_code, 200)
        return response.get_json()["job_id"]

    def test_next_uid_requires_auth(self):
        response = self.client.get("/api/recalc_batch_job/1/next_uid")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json()["error"], "not_authenticated")

    def test_next_uid_owner_isolation_and_running_transition(self):
        owner1_job = self._create_job("owner1", ["uid-1"])
        owner2_job = self._create_job("owner2", ["uid-other"])

        self._login("owner2")
        forbidden = self.client.get(f"/api/recalc_batch_job/{owner1_job}/next_uid")
        self.assertEqual(forbidden.status_code, 404)

        response = self.client.get(f"/api/recalc_batch_job/{owner2_job}/next_uid")
        body = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body["account_uid"], "uid-other")
        self.assertEqual(body["account_number"], "2001")
        with app_module.app.app_context():
            item = app_module.RecalcBatchJobItem.query.filter_by(id=body["item_id"]).first()
            self.assertEqual(item.status, "running")
            self.assertIsNotNone(item.started_at)

    def test_complete_uid_accepts_only_running_item(self):
        job_id = self._create_job("owner1", ["uid-1"])
        response = self.client.post(f"/api/recalc_batch_job/{job_id}/complete_uid", json={
            "item_id": 1,
            "status": "skipped",
            "error_reason": "NOT_RUNNING",
        })
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["error"], "item_not_running")

    def test_complete_uid_rejects_foreign_item_and_repeat_completion(self):
        owner1_job = self._create_job("owner1", ["uid-1"])
        next_body = self.client.get(f"/api/recalc_batch_job/{owner1_job}/next_uid").get_json()
        item_id = next_body["item_id"]

        self._login("owner2")
        foreign = self.client.post(f"/api/recalc_batch_job/{owner1_job}/complete_uid", json={
            "item_id": item_id,
            "status": "skipped",
        })
        self.assertEqual(foreign.status_code, 404)

        self._login("owner1")
        done = self.client.post(f"/api/recalc_batch_job/{owner1_job}/complete_uid", json={
            "item_id": item_id,
            "status": "skipped",
            "error_reason": "SKIP_TEST",
        })
        self.assertEqual(done.status_code, 200)
        repeat = self.client.post(f"/api/recalc_batch_job/{owner1_job}/complete_uid", json={
            "item_id": item_id,
            "status": "skipped",
        })
        self.assertEqual(repeat.status_code, 409)
        self.assertEqual(repeat.get_json()["error"], "item_not_running")

    def test_complete_uid_rejects_summary_uid_mismatch(self):
        job_id = self._create_job("owner1", ["uid-1"])
        item = self.client.get(f"/api/recalc_batch_job/{job_id}/next_uid").get_json()
        response = self.client.post(f"/api/recalc_batch_job/{job_id}/complete_uid", json={
            "item_id": item["item_id"],
            "status": "fresh",
            "summary": {"account_uid": "uid-2", "summary_status": "fresh", "totals": {"debt": 1, "accrued": 1, "paid": 0, "penalty": 0}},
        })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "uid_mismatch")

    def test_error_completion_persists_error_without_zero_totals(self):
        job_id = self._create_job("owner1", ["uid-1"])
        item = self.client.get(f"/api/recalc_batch_job/{job_id}/next_uid").get_json()
        response = self.client.post(f"/api/recalc_batch_job/{job_id}/complete_uid", json={
            "item_id": item["item_id"],
            "status": "error",
            "summary": {"account_uid": "uid-1", "summary_status": "error", "summary_reason": "CALC_FAILED", "total_debt": 0},
            "error_reason": "CALC_FAILED",
        })
        self.assertEqual(response.status_code, 200)
        with app_module.app.app_context():
            row = app_module.AbonentSummary.query.filter_by(owner_id="owner1", account_uid="uid-1").first()
            self.assertEqual(row.summary_status, "error")
            self.assertEqual(row.summary_reason, "CALC_FAILED")
            self.assertIsNone(row.total_debt)
            payload = json.loads(row.summary_json)
            self.assertEqual(payload["calculation_source"], "CLIENT_CALCULATED_SUMMARY")
            self.assertNotIn("total_debt", payload)

    def test_fresh_completion_updates_summary_json_and_columns(self):
        job_id = self._create_job("owner1", ["uid-1"])
        item = self.client.get(f"/api/recalc_batch_job/{job_id}/next_uid").get_json()
        with app_module.app.app_context():
            app_module.db.session.add(app_module.CardSnapshot(
                owner_id="owner1",
                abonent_uid="uid-1",
                abonent_id="1001",
                snapshot_status="fresh",
                snapshot_reason="OK",
                snapshot_json=json.dumps({
                    "uid": "uid-1",
                    "summary_status": "fresh",
                    "summary_reason": "OK",
                    "ledgerVersion": "ledger-v1",
                    "rowsById": {"row-1": {"pay_main": 100.50, "pay_penalty": 5.00, "total": 105.50}},
                    "totals": {"debt": "105.50", "accrued": "120.75", "paid": "15.25", "penalty": "5.00"},
                }, sort_keys=True),
            ))
            app_module.db.session.commit()
        response = self.client.post(f"/api/recalc_batch_job/{job_id}/complete_uid", json={
            "item_id": item["item_id"],
            "status": "fresh",
            "summary": {
                "account_uid": "uid-1",
                "summary_status": "fresh",
                "summary_reason": "OK",
                "totals": {"debt": "105.50", "accrued": "120.75", "paid": "15.25", "penalty": "5.00"},
            },
        })
        body = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body["status"], "done")
        with app_module.app.app_context():
            row = app_module.AbonentSummary.query.filter_by(owner_id="owner1", account_uid="uid-1").first()
            self.assertEqual(row.summary_status, "fresh")
            self.assertEqual(row.summary_reason, "OK")
            self.assertEqual(row.total_debt, Decimal("105.50"))
            self.assertEqual(row.total_accrued, Decimal("120.75"))
            self.assertEqual(row.total_paid, Decimal("15.25"))
            self.assertEqual(row.penalty_debt, Decimal("5.00"))
            payload = json.loads(row.summary_json)
            self.assertEqual(payload["calculation_source"], "CLIENT_CALCULATED_SUMMARY")

    def test_fresh_completion_without_snapshot_is_error(self):
        job_id = self._create_job("owner1", ["uid-1"])
        item = self.client.get(f"/api/recalc_batch_job/{job_id}/next_uid").get_json()
        response = self.client.post(f"/api/recalc_batch_job/{job_id}/complete_uid", json={
            "item_id": item["item_id"],
            "status": "fresh",
            "summary": {
                "account_uid": "uid-1",
                "summary_status": "fresh",
                "summary_reason": "OK",
                "totals": {"debt": "0.00", "accrued": "0.00", "paid": "0.00", "penalty": "0.00"},
            },
        })
        self.assertEqual(response.status_code, 200)
        with app_module.app.app_context():
            row = app_module.AbonentSummary.query.filter_by(owner_id="owner1", account_uid="uid-1").first()
            self.assertEqual(row.summary_status, "error")
            self.assertEqual(row.summary_reason, "CARD_SNAPSHOT_MISSING")
            payload = json.loads(row.summary_json)
            self.assertEqual(payload["summary_status"], "error")
            self.assertNotIn("totals", payload)


if __name__ == "__main__":
    unittest.main()
