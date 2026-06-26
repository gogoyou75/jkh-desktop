import json
import os
import sys
import tempfile
import unittest
from decimal import Decimal
from sqlalchemy import create_engine

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import app as app_module


class CardSnapshotSaveTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._db_file = tempfile.NamedTemporaryFile(prefix="jkh_stage19_snapshot_", suffix=".sqlite", delete=False)
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
            app_module.db.session.add(app_module.User(id="admin", email="admin@test", password_hash="x", role="admin"))
            app_module.db.session.add(app_module.KVStore(owner="owner1", k="abonents_db_v1", v=json.dumps({
                "abonents": {
                    "1001": {"uid": "uid-1", "id": "1001", "fio": "One"},
                }
            })))
            app_module.db.session.add(app_module.KVStore(owner="owner2", k="abonents_db_v1", v=json.dumps({
                "abonents": {
                    "2001": {"uid": "uid-2", "id": "2001", "fio": "Two"},
                }
            })))
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner1",
                abonent_id="1001",
                account_uid="uid-1",
                account_number="1001",
                total_debt=Decimal("12.00"),
                total_accrued=Decimal("15.00"),
                total_paid=Decimal("3.00"),
                penalty_debt=Decimal("2.00"),
                summary_status="fresh",
                summary_reason="OK",
                input_hash="hash-1",
                summary_json=json.dumps({
                    "account_uid": "uid-1",
                    "summary_status": "fresh",
                    "summary_reason": "OK",
                    "input_hash": "hash-1",
                    "totals": {"debt": 12, "accrued": 15, "paid": 3, "penalty": 2},
                }),
            ))
            app_module.db.session.commit()

    def _login(self, user_id):
        with self.client.session_transaction() as sess:
            sess["user_id"] = user_id

    def _snapshot(self, uid="uid-1", input_hash="hash-1"):
        return {
            "uid": uid,
            "abonentId": "1001",
            "input_hash": input_hash,
            "ledgerVersion": "ledger-v1",
            "tariff_version": "tariff-v1",
            "rate_version": "rate-v1",
            "exclude_version": "exclude-v1",
            "links_version": "links-v1",
            "engine_version": "JKHCalcEngine",
            "rows": [{"id": "r1", "paid": 3, "accrued": 15}],
            "rowsById": {"r1": {"pay_main": 3, "pay_penalty": 0}},
            "totals": {"debt": 12, "accrued": 15, "paid": 3, "penalty": 2},
        }

    def test_snapshot_save_requires_auth(self):
        response = self.client.post("/api/card_snapshot/uid-1", json={"snapshot": self._snapshot()})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json()["error"], "not_authenticated")

    def test_foreign_owner_cannot_save_snapshot_for_uid(self):
        self._login("owner2")
        response = self.client.post("/api/card_snapshot/uid-1", json={"snapshot": self._snapshot()})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["error"], "uid_not_found")

    def test_snapshot_save_rejects_uid_mismatch(self):
        self._login("owner1")
        response = self.client.post("/api/card_snapshot/uid-1", json={"snapshot": self._snapshot(uid="uid-2")})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "uid_mismatch")

    def test_fresh_snapshot_with_matching_hash_is_clean_in_audit(self):
        self._login("owner1")
        response = self.client.post("/api/card_snapshot/uid-1", json={"snapshot": self._snapshot()})
        body = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body["snapshot_status"], "fresh")
        self.assertEqual(body["snapshot_reason"], "OK")
        self.assertEqual(body["input_hash"], "hash-1")
        self.assertEqual(body["ledger_version"], "ledger-v1")
        self.assertEqual(body["tariff_version"], "tariff-v1")
        self.assertEqual(body["rate_version"], "rate-v1")
        self.assertEqual(body["exclude_version"], "exclude-v1")
        self.assertEqual(body["links_version"], "links-v1")
        self.assertEqual(body["engine_version"], "JKHCalcEngine")

        self._login("admin")
        audit = self.client.get("/api/audit/snapshot_summary?owner=owner1").get_json()
        item = next(x for x in audit["items"] if x["account_uid"] == "uid-1")
        self.assertEqual(audit["counts"]["snapshot_missing_count"], 0)
        self.assertEqual(audit["counts"]["hash_mismatch_count"], 0)
        self.assertFalse(item["hash_mismatch"])
        self.assertEqual(item["warnings"], [])


if __name__ == "__main__":
    unittest.main()
