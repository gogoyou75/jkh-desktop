import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch
from sqlalchemy.exc import SQLAlchemyError
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

    def _post_snapshot(self, snapshot):
        return self.client.post("/api/card_snapshot/uid-1", json={"snapshot": snapshot})

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
        response = self._post_snapshot(self._snapshot(uid="uid-2"))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "uid_mismatch")

    def test_snapshot_save_accepts_valid_full_canonical_snapshot(self):
        self._login("owner1")
        response = self._post_snapshot(dict(
            self._snapshot(),
            snapshot_status="fresh",
            summary_status="fresh",
            summary_scope="full",
            snapshotMode="full",
            summary_reason="OK",
        ))
        body = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body["snapshot_status"], "fresh")
        self.assertEqual(body["snapshot_reason"], "OK")
        self.assertEqual(body["snapshot"]["summary_status"], "fresh")

    def test_canonical_snapshot_post_get_preserves_rows_and_totals(self):
        self._login("owner1")
        snapshot = dict(
            self._snapshot(),
            snapshot_status="fresh",
            summary_status="fresh",
            summary_scope="full",
            snapshotMode="full",
            summary_reason="OK",
        )
        posted = self._post_snapshot(snapshot)
        self.assertEqual(posted.status_code, 200)
        posted_snapshot = posted.get_json()["snapshot"]
        self.assertEqual(posted_snapshot["rowsById"], snapshot["rowsById"])
        self.assertEqual(posted_snapshot["totals"], snapshot["totals"])

        loaded = self.client.get("/api/card_snapshot/uid-1")
        self.assertEqual(loaded.status_code, 200)
        loaded_snapshot = loaded.get_json()["snapshot"]
        self.assertEqual(len(loaded_snapshot["rowsById"]), len(snapshot["rowsById"]))
        self.assertEqual(loaded_snapshot["rowsById"], snapshot["rowsById"])
        self.assertEqual(loaded_snapshot["totals"], snapshot["totals"])

        index_response = self.client.get("/api/abonents?limit=10")
        self.assertEqual(index_response.status_code, 200)
        index_item = next(item for item in index_response.get_json()["items"] if item.get("uid", item.get("account_uid")) == "uid-1")
        if isinstance(index_item.get("summary"), dict):
            index_item = index_item["summary"]
        self.assertEqual(index_item["summary_status"], "fresh")
        self.assertEqual(index_item["totals"]["debt"], 12)
        self.assertEqual(index_item["totals"]["accrued"], 15)
        self.assertEqual(index_item["totals"]["paid"], 3)
        self.assertEqual(index_item["totals"]["penalty"], 2)

    def test_snapshot_save_rejects_period_or_report_snapshot(self):
        self._login("owner1")
        for payload in (
            dict(self._snapshot(), summary_scope="period"),
            dict(self._snapshot(), report_scope="report"),
            dict(self._snapshot(), snapshotMode="period"),
            dict(self._snapshot(), recalcMode="REPORT_PERIOD_CALCULATION"),
            dict(self._snapshot(), periodActive=True),
            dict(self._snapshot(), temporaryCalculation=True),
        ):
            response = self._post_snapshot(payload)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.get_json()["error"], "snapshot_period_not_allowed")

    def test_snapshot_save_rejects_empty_rows_by_id(self):
        self._login("owner1")
        response = self._post_snapshot(dict(self._snapshot(), rowsById={}))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "snapshot_rows_missing")

    def test_snapshot_save_rejects_error_or_fatal_status(self):
        self._login("owner1")
        for payload in (
            dict(self._snapshot(), snapshot_status="error", snapshot_reason="CALC_FAILED"),
            dict(self._snapshot(), summary_status="fatal", summary_reason="RATES_FATAL"),
            dict(self._snapshot(), calculation_status="error", calculation_reason="CALC_FAILED"),
        ):
            response = self._post_snapshot(payload)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.get_json()["error"], "snapshot_not_fresh")

    def test_snapshot_save_requires_abonent_identity_and_versions(self):
        self._login("owner1")
        for field, error in (
            ("abonentId", "abonent_id_required"),
            ("input_hash", "input_hash_required"),
            ("ledgerVersion", "ledger_version_required"),
        ):
            snapshot = self._snapshot()
            snapshot.pop(field, None)
            response = self._post_snapshot(snapshot)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.get_json()["error"], error)

    def test_snapshot_save_rejects_abonent_id_mismatch(self):
        self._login("owner1")
        response = self._post_snapshot(dict(self._snapshot(), abonentId="1002"))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "abonent_id_mismatch")

    def test_rejected_snapshot_does_not_overwrite_previous_success(self):
        self._login("owner1")
        first = self._post_snapshot(self._snapshot())
        self.assertEqual(first.status_code, 200)

        rejected = self._post_snapshot(dict(
            self._snapshot(input_hash="bad-hash"),
            summary_scope="period",
            rowsById={"bad": {"pay_main": 999}},
        ))
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(rejected.get_json()["error"], "snapshot_period_not_allowed")

        current = self.client.get("/api/card_snapshot/uid-1").get_json()
        self.assertEqual(current["snapshot_status"], "fresh")
        self.assertEqual(current["input_hash"], "hash-1")
        self.assertEqual(current["snapshot"]["rowsById"], {"r1": {"pay_main": 3, "pay_penalty": 0}})

    def test_fresh_snapshot_with_matching_hash_is_clean_in_audit(self):
        self._login("owner1")
        response = self._post_snapshot(self._snapshot())
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


    def _mark_dirty(self):
        return self.client.post("/api/abonent_summary/mark_dirty", json={
            "account_uid": "uid-1", "reason": "TARIFFS_CHANGED"})

    def _confirmed_summary(self, snapshot):
        return {"account_uid": "uid-1", "confirm_snapshot": True, "summary": {
            "summary_status": "fresh", "summary_reason": "OK", "summary_scope": "full",
            "calculation_mode": "FULL_SUMMARY_REBUILD", "input_hash": snapshot["input_hash"],
            "period": {"from": "2026-01-01", "to": "2026-01-31"},
            "totals": snapshot["totals"]}}

    def test_dirty_preserves_last_result_and_f5_without_hash_promotion(self):
        self._login("owner1")
        self._post_snapshot(self._snapshot())
        with app_module.app.app_context():
            row = app_module.AbonentSummary.query.filter_by(owner_id="owner1").one()
            value = json.loads(row.summary_json)
            value["generated_at"] = "2026-02-01T00:00:00Z"
            row.summary_json = json.dumps(value)
            app_module.db.session.commit()
        for _ in range(2):
            self.assertEqual(self._mark_dirty().status_code, 200)
        # A new HTTP context must use the persisted dirty status even with equal hashes.
        fresh_client = app_module.app.test_client()
        with fresh_client.session_transaction() as sess:
            sess["user_id"] = "owner1"
        result = fresh_client.get("/api/card_snapshot/uid-1").get_json()
        self.assertEqual(result["snapshot_status"], "dirty")
        self.assertEqual(result["snapshot"]["rowsById"], self._snapshot()["rowsById"])
        self.assertEqual(result["last_summary"]["totals"]["debt"], 12)
        self.assertEqual(result["last_summary"]["input_hash"], "hash-1")
        self.assertEqual(result["last_summary"]["generated_at"], "2026-02-01T00:00:00Z")
        with app_module.app.app_context():
            row = app_module.AbonentSummary.query.filter_by(owner_id="owner1").one()
            self.assertEqual(row.summary_status, "dirty")
            self.assertEqual(row.total_debt, Decimal("12.00"))

    def test_dirty_rollback_keeps_both_objects_fresh(self):
        self._login("owner1")
        self._post_snapshot(self._snapshot())
        with patch.object(app_module.db.session, "commit", side_effect=SQLAlchemyError("isolated failure")):
            self.assertEqual(self._mark_dirty().status_code, 500)
        with app_module.app.app_context():
            self.assertEqual(app_module.AbonentSummary.query.filter_by(owner_id="owner1").one().summary_status, "fresh")
            self.assertEqual(app_module.CardSnapshot.query.filter_by(owner_id="owner1").one().snapshot_status, "fresh")

    def test_dirty_missing_objects_do_not_invent_zero_totals(self):
        self._login("owner1")
        with app_module.app.app_context():
            app_module.AbonentSummary.query.filter_by(owner_id="owner1").delete()
            app_module.db.session.commit()
        self.assertEqual(self._mark_dirty().status_code, 200)
        result = self.client.get("/api/card_snapshot/uid-1").get_json()
        self.assertIsNone(result["snapshot"])
        self.assertNotIn("totals", result["last_summary"])
        with app_module.app.app_context():
            self.assertIsNone(app_module.AbonentSummary.query.filter_by(owner_id="owner1").one().total_debt)

    def test_dirty_cannot_clear_before_full_pair_confirmation(self):
        self._login("owner1")
        self._post_snapshot(self._snapshot())
        self._mark_dirty()
        new_snapshot = self._snapshot(input_hash="hash-new")
        payload = self._confirmed_summary(new_snapshot)
        unconfirmed = dict(payload, confirm_snapshot=False)
        self.assertEqual(self.client.post("/api/abonent_summary/rebuild", json=unconfirmed).status_code, 409)
        self.assertEqual(self._post_snapshot(new_snapshot).get_json()["snapshot_status"], "dirty")
        # A failed confirmation must not clear dirty or replace the last summary.
        wrong = self._confirmed_summary(new_snapshot)
        wrong["summary"]["totals"] = dict(new_snapshot["totals"], debt=99)
        self.assertEqual(self.client.post("/api/abonent_summary/rebuild", json=wrong).status_code, 409)
        self.assertEqual(self.client.get("/api/card_snapshot/uid-1").get_json()["snapshot_status"], "dirty")
        self.assertEqual(self.client.post("/api/abonent_summary/rebuild", json=payload).status_code, 200)
        self.assertEqual(self.client.get("/api/card_snapshot/uid-1").get_json()["snapshot_status"], "fresh")
        with app_module.app.app_context():
            self.assertEqual(app_module.AbonentSummary.query.filter_by(owner_id="owner1").one().summary_status, "fresh")

    def test_new_dirty_after_snapshot_blocks_old_confirmation(self):
        self._login("owner1")
        self._mark_dirty()
        self._post_snapshot(self._snapshot())
        self._mark_dirty()
        response = self.client.post("/api/abonent_summary/rebuild", json=self._confirmed_summary(self._snapshot()))
        self.assertEqual(response.status_code, 409)

    def test_confirmation_failure_rolls_back_fresh_snapshot_status(self):
        self._login("owner1")
        self._mark_dirty()
        self._post_snapshot(self._snapshot())
        with patch.object(app_module.db.session, "commit", side_effect=SQLAlchemyError("isolated confirmation failure")):
            try:
                self.client.post("/api/abonent_summary/rebuild", json=self._confirmed_summary(self._snapshot()))
            except SQLAlchemyError:
                # The testing client propagates unhandled errors; teardown rolls back.
                pass
        with app_module.app.app_context():
            self.assertEqual(app_module.CardSnapshot.query.filter_by(owner_id="owner1").one().snapshot_status, "dirty")
            self.assertEqual(app_module.AbonentSummary.query.filter_by(owner_id="owner1").one().summary_status, "dirty")

    def test_transferred_history_stays_dirty_and_balances_unchanged(self):
        self._login("owner1")
        self._post_snapshot(self._snapshot())
        keys = {"jkh_transfer_balance_v1:2002:test": json.dumps({"fromAbonentId": "1001", "principal": 10, "penalty": 2}),
                "jkh_frozen_debt_v1:1001:2025-12-31": json.dumps({"principal": 10, "penalty": 2})}
        with app_module.app.app_context():
            for key, value in keys.items():
                app_module.db.session.add(app_module.KVStore(owner="owner1", k=key, v=value))
            app_module.db.session.commit()
        self.assertEqual(self._mark_dirty().get_json()["reason"], "PROTECTED_HISTORY_CHANGED")
        self.assertEqual(self._post_snapshot(self._snapshot()).status_code, 409)
        self.assertEqual(self.client.post("/api/abonent_summary/rebuild", json=self._confirmed_summary(self._snapshot())).status_code, 409)
        with app_module.app.app_context():
            for key, value in keys.items():
                self.assertEqual(app_module.KVStore.query.filter_by(owner="owner1", k=key).one().v, value)


if __name__ == "__main__":
    unittest.main()
