import json
import os
import sys
import tempfile
import unittest
from sqlalchemy import create_engine

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import app as app_module


class BulkCalcVerifyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._db_file = tempfile.NamedTemporaryFile(prefix="jkh_stage16_bulk_verify_", suffix=".sqlite", delete=False)
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
            engines = app_module.app.extensions["sqlalchemy"].engines
            for engine in list(engines.values()):
                engine.dispose()
        os.unlink(cls._db_file.name)

    def setUp(self):
        self.client = app_module.app.test_client()
        with app_module.app.app_context():
            app_module.db.session.remove()
            app_module.db.drop_all()
            app_module.db.create_all()
            app_module.db.session.add(app_module.User(id="owner1", email="o1@test", password_hash="x", role="user", display_name="o1"))
            app_module.db.session.add(app_module.KVStore(owner="owner1", k="abonents_db_v1", v=json.dumps({
                "abonents": {
                    "1001": {"uid": "u1", "id": "1001"},
                    "1002": {"uid": "u2", "id": "1002"},
                    "1003": {"uid": "u3", "id": "1003"},
                }
            })))
            app_module.db.session.commit()
        self._login("owner1")

    def _login(self, user_id):
        with self.client.session_transaction() as sess:
            sess["user_id"] = user_id

    def _summary(self, total=12, penalty=2, input_hash="h1"):
        return {
            "summary_status": "fresh",
            "summary_reason": "OK",
            "period": {"from": "2026-01-01", "to": "2026-01-31"},
            "total_debt": total,
            "total_penalty": penalty,
            "total_accrued": 10,
            "total_paid": 0,
            "totals": {"principal": total - penalty, "debt": total, "penalty": penalty, "total": total, "accrued": 10, "paid": 0},
            "input_hash": input_hash,
            "calc_engine_version": "JKHCalcEngine",
        }

    def _add_summary_and_snapshot(self, uid, summary=None, snapshot=None):
        summary = summary if summary is not None else self._summary()
        snapshot = snapshot if snapshot is not None else self._summary()
        with app_module.app.app_context():
            next_summary_id = (app_module.AbonentSummary.query.count() or 0) + 1
            next_snapshot_id = (app_module.CardSnapshot.query.count() or 0) + 1
            app_module.db.session.add(app_module.AbonentSummary(
                id=next_summary_id,
                owner_id="owner1",
                abonent_id="1001",
                account_uid=uid,
                account_number="1001",
                summary_json=json.dumps(summary),
            ))
            app_module.db.session.add(app_module.CardSnapshot(
                id=next_snapshot_id,
                owner_id="owner1",
                abonent_uid=uid,
                abonent_id="1001",
                snapshot_status="fresh",
                snapshot_reason="OK",
                input_hash=snapshot.get("input_hash", ""),
                snapshot_json=json.dumps(snapshot),
            ))
            app_module.db.session.commit()

    def test_post_requires_explicit_uid_list(self):
        response = self.client.post("/api/abonent_summary/bulk_calc_verify", json={"reason": "STAGE16_BULK_VERIFY"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "uids_required")

    def test_single_uid_ok_compares_summary_and_snapshot(self):
        self._add_summary_and_snapshot("u1")
        created = self.client.post("/api/abonent_summary/bulk_calc_verify", json={"uids": ["u1"], "reason": "STAGE16_BULK_VERIFY"}).get_json()
        status = self.client.get(f"/api/abonent_summary/bulk_calc_verify/{created['job_id']}").get_json()
        self.assertEqual(status["status"], "completed")
        self.assertEqual(status["ok"], 1)
        self.assertEqual(status["mismatch"], 0)
        self.assertEqual(status["items"][0]["status"], "ok")
        self.assertEqual(status["items"][0]["diff"], {})

    def test_mismatch_reports_diff_without_overwriting_summary(self):
        old_summary = self._summary(total=12, penalty=2, input_hash="old")
        new_snapshot = self._summary(total=15, penalty=3, input_hash="new")
        self._add_summary_and_snapshot("u1", old_summary, new_snapshot)
        created = self.client.post("/api/abonent_summary/bulk_calc_verify", json={"uids": ["u1"]}).get_json()
        status = self.client.get(f"/api/abonent_summary/bulk_calc_verify/{created['job_id']}").get_json()
        self.assertEqual(status["mismatch"], 1)
        item = status["items"][0]
        self.assertEqual(item["status"], "mismatch")
        self.assertIn("total_debt", item["diff"])
        with app_module.app.app_context():
            persisted = json.loads(app_module.AbonentSummary.query.filter_by(owner_id="owner1", account_uid="u1").one().summary_json)
            self.assertEqual(persisted["total_debt"], 12)
            self.assertEqual(persisted["input_hash"], "old")

    def test_missing_snapshot_errors_one_uid_without_failing_batch(self):
        self._add_summary_and_snapshot("u1")
        with app_module.app.app_context():
            app_module.db.session.add(app_module.AbonentSummary(
                id=10,
                owner_id="owner1",
                abonent_id="1002",
                account_uid="u2",
                account_number="1002",
                summary_json=json.dumps(self._summary()),
            ))
            app_module.db.session.commit()
        created = self.client.post("/api/abonent_summary/bulk_calc_verify", json={"uids": ["u1", "u2"]}).get_json()
        status = self.client.get(f"/api/abonent_summary/bulk_calc_verify/{created['job_id']}").get_json()
        self.assertEqual(status["status"], "completed")
        self.assertEqual(status["ok"], 1)
        self.assertEqual(status["error"], 1)
        by_uid = {item["uid"]: item for item in status["items"]}
        self.assertEqual(by_uid["u2"]["status"], "error")
        self.assertEqual(by_uid["u2"]["error_code"], "CARD_SNAPSHOT_MISSING")

    def test_second_job_skips_uid_already_queued(self):
        self._add_summary_and_snapshot("u1")
        first = self.client.post("/api/abonent_summary/bulk_calc_verify", json={"uids": ["u1"]}).get_json()
        second = self.client.post("/api/abonent_summary/bulk_calc_verify", json={"uids": ["u1", "u2"]}).get_json()
        self.assertNotEqual(first["job_id"], second["job_id"])
        by_uid = {item["uid"]: item for item in second["items"]}
        self.assertEqual(by_uid["u1"]["status"], "skipped")
        self.assertEqual(by_uid["u1"]["reason"], "already_running")


if __name__ == "__main__":
    unittest.main()
