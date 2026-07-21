import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.exc import SQLAlchemyError

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import app as app_module


class PaymentLedgerStoreAuditTest(unittest.TestCase):
    owner = "owner-audit"
    uid = "uid_audit_test"

    @classmethod
    def setUpClass(cls):
        cls._db_file = tempfile.NamedTemporaryFile(prefix="jkh_payment_ledger_audit_", suffix=".sqlite", delete=False)
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
            app_module.db.session.add(app_module.User(id=self.owner, email="owner-audit@test", password_hash="x", role="user"))
            app_module.db.session.add(app_module.User(id="admin-audit", email="admin-audit@test", password_hash="x", role="admin"))
            app_module.db.session.commit()

    def _login(self, user_id):
        with self.client.session_transaction() as session:
            session["user_id"] = user_id

    @property
    def key(self):
        return "payments_" + self.uid

    def _seed(self, value):
        with app_module.app.app_context():
            app_module.db.session.add(app_module.KVStore(owner=self.owner, k=self.key, v=value))
            app_module.db.session.commit()

    def _post(self, value, **extra):
        self._login(self.owner)
        payload = {"key": self.key, "value": value, "source": "audit-test"}
        payload.update(extra)
        return self.client.post("/api/store", json=payload)

    def _audit_rows(self):
        with app_module.app.app_context():
            return app_module.PaymentLedgerStoreAudit.query.order_by(app_module.PaymentLedgerStoreAudit.id.asc()).all()

    def test_post_nonempty_to_nonempty_records_metadata_only(self):
        self._seed(json.dumps([{"id": "old"}]))
        response = self._post(json.dumps([{"id": "new"}, {"id": "newer"}]))
        self.assertEqual(response.status_code, 200)
        row = self._audit_rows()[0]
        self.assertEqual((row.action, row.old_rows_count, row.new_rows_count), ("POST", 1, 2))
        self.assertEqual(row.guard_result, "ALLOWED")
        self.assertEqual(row.actor_id, self.owner)
        self.assertEqual(row.source, "audit-test")
        self.assertNotIn("newer", row.details_json)
        self.assertEqual(response.get_json()["request_id"], row.request_id)

    def test_blocked_empty_overwrite_is_audited_before_409(self):
        original = json.dumps([{"id": "old"}])
        self._seed(original)
        response = self._post("[]")
        self.assertEqual(response.status_code, 409)
        row = self._audit_rows()[0]
        self.assertEqual(row.guard_result, "BLOCKED")
        self.assertEqual(row.guard_reason, app_module.PAYMENT_LEDGER_EMPTY_OVERWRITE_BLOCKED)
        self.assertEqual((row.old_rows_count, row.new_rows_count), (1, 0))
        with app_module.app.app_context():
            self.assertEqual(app_module.KVStore.query.filter_by(owner=self.owner, k=self.key).first().v, original)

    def test_initial_empty_and_invalid_payload_are_audited(self):
        initial = self._post("[]")
        self.assertEqual(initial.status_code, 200)
        invalid = self._post("{not-json")
        self.assertEqual(invalid.status_code, 422)
        rows = self._audit_rows()
        self.assertEqual((rows[0].guard_result, rows[0].old_rows_count, rows[0].new_rows_count), ("ALLOWED", None, 0))
        self.assertEqual((rows[1].guard_result, rows[1].guard_reason), ("REJECTED", "payment_ledger_value_must_be_json_array"))

    def test_approved_calculated_final_empty_records_contract_and_lock(self):
        self._seed(json.dumps([{"id": "old"}]))
        with app_module.app.app_context():
            app_module.db.session.add(app_module.RecalcUidLock(
                owner_id=self.owner, abonent_uid=self.uid, lock_token="audit-lock", status="running"
            ))
            app_module.db.session.commit()
        response = self._post("[]", payment_ledger_contract={
            "action": "CALCULATED_FINAL_EMPTY", "completed": True, "finalLedgerEmpty": True,
            "uid": self.uid, "recalcLockToken": "audit-lock",
        })
        self.assertEqual(response.status_code, 200)
        row = self._audit_rows()[0]
        self.assertTrue(row.calculated_final_empty)
        self.assertTrue(row.full_recalc_lock_present)
        self.assertEqual((row.old_rows_count, row.new_rows_count), (1, 0))

    def test_delete_existing_and_missing_are_audited(self):
        self._seed(json.dumps([{"id": "old"}]))
        self._login(self.owner)
        existing = self.client.delete("/api/store", json={"key": self.key, "source": "audit-test"})
        missing = self.client.delete("/api/store", json={"key": self.key, "source": "audit-test"})
        self.assertEqual((existing.status_code, missing.status_code), (200, 200))
        rows = self._audit_rows()
        self.assertEqual((rows[0].action, rows[0].old_rows_count, rows[0].new_value_present), ("DELETE", 1, False))
        self.assertEqual((rows[1].action, rows[1].guard_reason, rows[1].old_value_present), ("DELETE", "NOT_FOUND", False))

    def test_nonpayment_key_has_no_payment_ledger_audit(self):
        self._login(self.owner)
        response = self.client.post("/api/store", json={"key": "note_audit_test", "value": "[]"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._audit_rows(), [])

    def test_admin_get_filters_uid_and_rejects_regular_user(self):
        self._post("[]")
        self._login(self.owner)
        forbidden = self.client.get("/api/audit/payment-ledger-store?account_uid=" + self.uid)
        self.assertEqual(forbidden.status_code, 403)
        self._login("admin-audit")
        response = self.client.get(
            "/api/audit/payment-ledger-store",
            query_string={"owner_id": self.owner, "account_uid": self.uid, "limit": 999},
        )
        body = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body["limit"], 500)
        self.assertEqual(len(body["items"]), 1)
        self.assertEqual(body["items"][0]["account_uid"], self.uid)

    def test_audit_commit_failure_fails_closed_without_ledger_change(self):
        original = json.dumps([{"id": "old"}])
        self._seed(original)
        self._login(self.owner)
        with app_module.app.app_context(), patch.object(app_module.db.session, "commit", side_effect=SQLAlchemyError("audit failure")):
            response = self.client.post("/api/store", json={"key": self.key, "value": json.dumps([{"id": "new"}])})
        self.assertEqual(response.status_code, 500)
        with app_module.app.app_context():
            current = app_module.KVStore.query.filter_by(owner=self.owner, k=self.key).first()
            self.assertEqual(current.v, original)
            self.assertEqual(app_module.PaymentLedgerStoreAudit.query.count(), 0)


if __name__ == "__main__":
    unittest.main()
