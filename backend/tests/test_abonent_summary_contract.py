import inspect
import json
import os
import sys
import unittest
from datetime import datetime
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import app as app_module


class _SummaryRow:
    def __init__(self, row_id, owner_id, abonent_id, account_uid, account_number, summary):
        self.id = row_id
        self.owner_id = owner_id
        self.abonent_id = abonent_id
        self.account_uid = account_uid
        self.account_number = account_number
        self.summary_json = json.dumps(summary)
        self.created_at = datetime(2026, 5, 16, 10, row_id, 0)
        self.updated_at = datetime(2026, 5, 16, 11, row_id, 0)


class _SummaryQuery:
    def __init__(self, rows):
        self._rows = list(rows)
        self.filter_calls = []
        self.count_calls = 0
        self.order_by_calls = 0
        self.offset_value = None
        self.limit_value = None

    def filter_by(self, **kwargs):
        self.filter_calls.append(kwargs)
        filtered = [row for row in self._rows if all(getattr(row, k) == v for k, v in kwargs.items())]
        child = _SummaryQuery(filtered)
        child.filter_calls = self.filter_calls
        return child

    def count(self):
        self.count_calls += 1
        return len(self._rows)

    def order_by(self, *args, **kwargs):
        self.order_by_calls += 1
        self._rows.sort(key=lambda row: (row.updated_at, row.id), reverse=True)
        return self

    def offset(self, value):
        self.offset_value = value
        return self

    def limit(self, value):
        self.limit_value = value
        return self

    def all(self):
        start = self.offset_value or 0
        end = None if self.limit_value is None else start + self.limit_value
        return self._rows[start:end]


class _ForbiddenSession:
    def add(self, obj):
        raise AssertionError("GET /api/abonent_summary must not write")

    def commit(self):
        raise AssertionError("GET /api/abonent_summary must not commit")

    def flush(self):
        raise AssertionError("GET /api/abonent_summary must not flush")

    def execute(self, *args, **kwargs):
        sql = str(args[0]) if args else ""
        if "payments_" in sql:
            raise AssertionError("GET /api/abonent_summary must not read payments_<uid>")
        raise AssertionError("GET /api/abonent_summary must not use ad-hoc session SQL")


class _ForbiddenQuery:
    def __get__(self, instance, owner):
        raise AssertionError("GET /api/abonent_summary must not read ledger/store fallback")


class AbonentSummaryContractTest(unittest.TestCase):
    def _user(self, user_id="owner_A", role="user"):
        return type("U", (), {"id": user_id, "role": role})()

    def _call_summary(self, path, rows, user=None):
        query = _SummaryQuery(rows)
        user = user or self._user()
        with app_module.app.test_request_context(path, method="GET"):
            with patch.object(app_module, "_require_user", return_value=(user, None)):
                with patch.object(app_module.AbonentSummary, "query", query):
                    response = app_module.abonent_summary_list()
        flask_response, status_code = response if isinstance(response, tuple) else (response, response.status_code)
        return flask_response.get_json(), status_code, query

    def test_requires_login(self):
        with app_module.app.test_client() as client:
            response = client.get("/api/abonent_summary")

        body = response.get_json()
        self.assertEqual(response.status_code, 401)
        self.assertEqual(body.get("error"), "not_authenticated")

    def test_guest_role_is_read_only_and_owner_scoped(self):
        rows = [
            _SummaryRow(1, "guest_owner", "a1", "uid_1", "1001", {"summary_status": "fresh"}),
            _SummaryRow(2, "owner_B", "b1", "uid_2", "2001", {"summary_status": "fresh"}),
        ]

        body, status_code, query = self._call_summary(
            "/api/abonent_summary?owner=owner_B",
            rows,
            user=self._user("guest_owner", "guest"),
        )

        self.assertEqual(status_code, 200)
        self.assertTrue(body["ok"])
        self.assertEqual([item["owner_id"] for item in body["items"]], ["guest_owner"])
        self.assertEqual(query.filter_calls[0], {"owner_id": "guest_owner"})

    def test_user_cannot_read_other_owner_even_with_owner_query_param(self):
        rows = [
            _SummaryRow(1, "owner_A", "a1", "uid_A", "1001", {"summary_status": "fresh"}),
            _SummaryRow(2, "owner_B", "b1", "uid_B", "2001", {"summary_status": "fresh"}),
        ]

        body, status_code, query = self._call_summary("/api/abonent_summary?owner=owner_B", rows)

        self.assertEqual(status_code, 200)
        self.assertEqual(body["pagination"]["total"], 1)
        self.assertEqual([item["owner_id"] for item in body["items"]], ["owner_A"])
        self.assertEqual(query.filter_calls[0], {"owner_id": "owner_A"})

    def test_exact_filters_do_not_escape_owner_scope_or_rebuild(self):
        rows = [
            _SummaryRow(1, "owner_A", "a1", "uid_A", "1001", {"summary_status": "fresh"}),
            _SummaryRow(2, "owner_A", "a2", "uid_A2", "1002", {"summary_status": "dirty"}),
            _SummaryRow(3, "owner_B", "a1", "uid_A", "1001", {"summary_status": "fresh"}),
        ]

        body, status_code, query = self._call_summary(
            "/api/abonent_summary?owner=owner_B&abonent_id=a1&account_uid=uid_A&account_number=1001",
            rows,
        )

        self.assertEqual(status_code, 200)
        self.assertEqual(body["pagination"]["total"], 1)
        self.assertEqual(body["items"][0]["owner_id"], "owner_A")
        self.assertEqual(
            query.filter_calls,
            [
                {"owner_id": "owner_A"},
                {"abonent_id": "a1"},
                {"account_uid": "uid_A"},
                {"account_number": "1001"},
            ],
        )

    def test_missing_summary_returns_empty_without_ledger_fallback_or_writes(self):
        with app_module.app.test_request_context("/api/abonent_summary?account_uid=missing_uid", method="GET"):
            with patch.object(app_module, "_require_user", return_value=(self._user(), None)):
                with patch.object(app_module.AbonentSummary, "query", _SummaryQuery([])):
                    with patch.object(app_module.KVStore, "query", _ForbiddenQuery()):
                        with patch.object(app_module, "db", type("DB", (), {"session": _ForbiddenSession()})()):
                            response = app_module.abonent_summary_list()

        body = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body["items"], [])
        self.assertEqual(body["pagination"]["total"], 0)

    def test_preserves_existing_summary_status_and_values(self):
        rows = [
            _SummaryRow(1, "owner_A", "a1", "uid_fresh", "1001", {"summary_status": "fresh", "total_debt": 10}),
            _SummaryRow(2, "owner_A", "a2", "uid_dirty", "1002", {"summary_status": "dirty", "total_debt": 20}),
            _SummaryRow(3, "owner_A", "a3", "uid_missing", "1003", {"summary_status": "missing", "summary_reason": "SUMMARY_NOT_BUILT"}),
            _SummaryRow(4, "owner_A", "a4", "uid_error", "1004", {"summary_status": "error", "summary_reason": "LEDGER_JSON_INVALID"}),
        ]

        body, status_code, _query = self._call_summary("/api/abonent_summary", rows)

        self.assertEqual(status_code, 200)
        statuses = {item["account_uid"]: item["summary"]["summary_status"] for item in body["items"]}
        self.assertEqual(statuses["uid_fresh"], "fresh")
        self.assertEqual(statuses["uid_dirty"], "dirty")
        self.assertEqual(statuses["uid_missing"], "missing")
        self.assertEqual(statuses["uid_error"], "error")
        missing = next(item for item in body["items"] if item["account_uid"] == "uid_missing")
        error = next(item for item in body["items"] if item["account_uid"] == "uid_error")
        self.assertNotIn("total_debt", missing["summary"])
        self.assertNotEqual(error["summary"].get("total_debt"), 0)

    def test_pagination_contract_and_stable_json_structure(self):
        rows = [
            _SummaryRow(1, "owner_A", "a1", "uid_1", "1001", {"summary_status": "fresh"}),
            _SummaryRow(2, "owner_A", "a2", "uid_2", "1002", {"summary_status": "fresh"}),
            _SummaryRow(3, "owner_A", "a3", "uid_3", "1003", {"summary_status": "fresh"}),
        ]

        body, status_code, _query = self._call_summary("/api/abonent_summary?page=2&per_page=1", rows)

        self.assertEqual(status_code, 200)
        self.assertEqual(set(body.keys()), {"ok", "items", "pagination"})
        self.assertEqual(body["pagination"], {
            "page": 2,
            "per_page": 1,
            "total": 3,
            "pages": 3,
            "has_next": True,
            "has_prev": True,
        })
        self.assertEqual(len(body["items"]), 1)
        self.assertEqual(
            set(body["items"][0].keys()),
            {"id", "owner_id", "abonent_id", "account_uid", "account_number", "summary", "created_at", "updated_at"},
        )

    def test_invalid_pagination_params_are_clamped_without_side_effects(self):
        rows = [_SummaryRow(1, "owner_A", "a1", "uid_1", "1001", {"summary_status": "fresh"})]

        body, status_code, _query = self._call_summary("/api/abonent_summary?page=bad&per_page=-10", rows)

        self.assertEqual(status_code, 200)
        self.assertEqual(body["pagination"]["page"], 1)
        self.assertEqual(body["pagination"]["per_page"], 1)

    def test_endpoint_source_keeps_explicit_anti_engine_guard(self):
        source = inspect.getsource(app_module.abonent_summary_list)

        self.assertIn("Summary API is read-only derived-cache transport", source)
        self.assertIn("Do not add", source)
        self.assertIn("recalculation", source)
        self.assertIn("ledger rebuild", source)
        self.assertIn("autoaccrual", source)
        self.assertIn("fallback totals", source)
        self.assertIn("hidden writes", source)
        self.assertIn("implicit refresh", source)
        self.assertNotIn("commit(", source)
        self.assertNotIn("flush(", source)
        self.assertNotIn("db.session.add", source)
        self.assertNotIn("KVStore", source)
        self.assertNotIn("_classify_payment", source)

    def test_recalc_batch_validates_owner_scoped_uids_without_rebuild(self):
        user = self._user("owner_batch")
        targets = [
            {"abonent_id": "1001", "account_uid": "uid_batch_1001", "account_number": "1001"},
            {"abonent_id": "1002", "account_uid": "uid_batch_1002", "account_number": "1002"},
        ]

        with app_module.app.test_request_context("/api/abonent_summary/recalc_batch", method="POST", json={
            "account_uids": ["uid_batch_1001", "uid_foreign", "uid_batch_1002", "uid_batch_1001"]
        }):
            with patch.object(app_module, "_require_user", return_value=(user, None)):
                with patch.object(app_module, "_owner_abonent_summary_targets", return_value=targets) as targets_mock:
                    response = app_module.abonent_summary_recalc_batch()

        body = response.get_json()
        self.assertEqual(response.status_code, 200)
        targets_mock.assert_called_once_with("owner_batch")
        self.assertEqual(body["allowed_uids"], ["uid_batch_1001", "uid_batch_1002"])
        statuses = {item["account_uid"]: item["status"] for item in body["items"]}
        self.assertEqual(statuses["uid_batch_1001"], "allowed")
        self.assertEqual(statuses["uid_batch_1002"], "allowed")
        self.assertEqual(statuses["uid_foreign"], "not_found")


    def test_recalc_batch_deduplicates_same_uid(self):
        user = self._user("owner_batch_dupe")
        targets = [
            {"abonent_id": "1001", "account_uid": "uid_batch_dupe_1001", "account_number": "1001"},
        ]

        with app_module.app.test_request_context("/api/abonent_summary/recalc_batch", method="POST", json={
            "account_uids": ["uid_batch_dupe_1001", "uid_batch_dupe_1001", "uid_batch_dupe_1001"]
        }):
            with patch.object(app_module, "_require_user", return_value=(user, None)):
                with patch.object(app_module, "_owner_abonent_summary_targets", return_value=targets):
                    response = app_module.abonent_summary_recalc_batch()

        body = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body["allowed_uids"], ["uid_batch_dupe_1001"])
        self.assertEqual(len(body["items"]), 1)
        self.assertEqual(body["items"][0]["status"], "allowed")

    def test_recalc_batch_source_does_not_calculate_or_write(self):
        source = inspect.getsource(app_module.abonent_summary_recalc_batch)

        self.assertIn("_require_user", source)
        self.assertIn("_owner_abonent_summary_targets", source)
        self.assertNotIn("commit(", source)
        self.assertNotIn("flush(", source)
        self.assertNotIn("db.session.add", source)
        self.assertNotIn("calc", source.lower().replace("recalc_batch", ""))
        self.assertNotIn("payments_", source)



if __name__ == "__main__":
    unittest.main()
