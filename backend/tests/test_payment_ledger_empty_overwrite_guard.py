import json
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import app as app_module


class _Row:
    def __init__(self, owner, key, value):
        self.owner = owner
        self.k = key
        self.v = value


class _Query:
    def __init__(self, rows):
        self.rows = rows
        self.filters = {}

    def filter_by(self, **kwargs):
        self.filters = kwargs
        return self

    def first(self):
        for row in self.rows:
            if all(getattr(row, field, None) == value for field, value in self.filters.items()):
                return row
        return None


class _Session:
    def __init__(self, rows):
        self.rows = rows
        self.added = []
        self.commits = 0

    def add(self, row):
        self.added.append(row)
        if hasattr(row, "v"):
            self.rows.append(row)

    def commit(self):
        self.commits += 1


class PaymentLedgerEmptyOverwriteGuardTest(unittest.TestCase):
    owner = "u_test"
    uid = "uid_guard_test"

    def _call_store_set(self, existing_value, incoming_value, contract=None, lock=None, key=None):
        key = key or "payments_" + self.uid
        rows = [] if existing_value is None else [_Row(self.owner, key, existing_value)]
        session = _Session(rows)
        kv_query = _Query(rows)
        locks = [] if lock is None else [lock]
        lock_query = _Query(locks)
        user = type("User", (), {"id": self.owner, "role": "user"})()
        payload = {"key": key, "value": incoming_value}
        if contract is not None:
            payload["payment_ledger_contract"] = contract
        db_stub = type("DB", (), {"session": session})()
        with app_module.app.test_request_context("/api/store", method="POST", json=payload):
            with patch.object(app_module, "_session_store_owner", return_value=(user, self.owner, None)), \
                 patch.object(app_module, "_require_write_access_for_key", return_value=(None, None)), \
                 patch.object(app_module.KVStore, "query", kv_query), \
                 patch.object(app_module.RecalcUidLock, "query", lock_query), \
                 patch.object(app_module, "db", db_stub):
                result = app_module.store_set()
        response, status = result if isinstance(result, tuple) else (result, result.status_code)
        return response.get_json(), status, rows, session

    def _approved_contract(self, uid=None, token="lock-token"):
        return {
            "action": "CALCULATED_FINAL_EMPTY",
            "completed": True,
            "finalLedgerEmpty": True,
            "uid": uid or self.uid,
            "recalcLockToken": token,
        }

    def _running_lock(self, token="lock-token"):
        return type("Lock", (), {
            "owner_id": self.owner,
            "abonent_uid": self.uid,
            "status": "running",
            "lock_token": token,
        })()

    def test_missing_key_accepts_initial_empty_ledger(self):
        data, status, rows, session = self._call_store_set(None, "[]")
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(rows[0].v, "[]")
        self.assertEqual(session.commits, 1)

    def test_existing_empty_accepts_idempotent_empty_ledger(self):
        data, status, rows, session = self._call_store_set("[]", "[]")
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(rows[0].v, "[]")
        self.assertEqual(session.commits, 1)

    def test_existing_nonempty_generic_empty_is_blocked_without_mutation(self):
        original = json.dumps([{"id": 1}])
        data, status, rows, session = self._call_store_set(original, "[]")
        self.assertEqual(status, 409)
        self.assertEqual(data["error"], app_module.PAYMENT_LEDGER_EMPTY_OVERWRITE_BLOCKED)
        self.assertEqual(rows[0].v, original)
        self.assertEqual(session.commits, 1)
        self.assertEqual(len(session.added), 1)
        self.assertEqual(session.added[0].guard_result, "BLOCKED")

    def test_payment_table_empty_is_blocked_without_mutation(self):
        original = json.dumps([{"id": 1}])
        data, status, rows, session = self._call_store_set(original, "[]", {"action": "PAYMENT_TABLE_WRITE"})
        self.assertEqual(status, 409)
        self.assertEqual(data["error"], app_module.PAYMENT_LEDGER_EMPTY_OVERWRITE_BLOCKED)
        self.assertEqual(rows[0].v, original)
        self.assertEqual(session.commits, 1)
        self.assertEqual(len(session.added), 1)
        self.assertEqual(session.added[0].guard_result, "BLOCKED")

    def test_unknown_or_missing_contract_empty_is_blocked(self):
        original = json.dumps([{"id": 1}])
        for contract in (None, {"action": "UNKNOWN"}):
            with self.subTest(contract=contract):
                data, status, rows, session = self._call_store_set(original, "[]", contract)
                self.assertEqual(status, 409)
                self.assertEqual(data["error"], app_module.PAYMENT_LEDGER_EMPTY_OVERWRITE_BLOCKED)
                self.assertEqual(rows[0].v, original)
                self.assertEqual(session.commits, 1)
                self.assertEqual(len(session.added), 1)
                self.assertEqual(session.added[0].guard_result, "BLOCKED")

    def test_verified_calculated_final_empty_contract_is_allowed(self):
        original = json.dumps([{"id": 1}])
        data, status, rows, session = self._call_store_set(
            original, "[]", self._approved_contract(), self._running_lock()
        )
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(rows[0].v, "[]")
        self.assertEqual(session.commits, 1)

    def test_uid_or_lock_mismatch_is_rejected_without_mutation(self):
        original = json.dumps([{"id": 1}])
        for contract, lock in (
            (self._approved_contract(uid="uid_other"), self._running_lock()),
            (self._approved_contract(token="wrong-token"), self._running_lock()),
        ):
            with self.subTest(contract=contract):
                data, status, rows, session = self._call_store_set(original, "[]", contract, lock)
                self.assertEqual(status, 409)
                self.assertEqual(data["error"], app_module.PAYMENT_LEDGER_EMPTY_OVERWRITE_BLOCKED)
                self.assertEqual(rows[0].v, original)
                self.assertEqual(session.commits, 1)
                self.assertEqual(len(session.added), 1)
                self.assertEqual(session.added[0].guard_result, "BLOCKED")

    def test_nonpayments_key_retains_generic_empty_value_behavior(self):
        data, status, rows, session = self._call_store_set("[1]", "[]", key="notes_guard_test")
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(rows[0].v, "[]")
        self.assertEqual(session.commits, 1)


if __name__ == "__main__":
    unittest.main()
