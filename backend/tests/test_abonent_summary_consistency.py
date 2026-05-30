import json
import os
import sys
import tempfile
import unittest
from decimal import Decimal
from sqlalchemy import create_engine

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import app as app_module


class AbonentSummaryConsistencyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._db_file = tempfile.NamedTemporaryFile(prefix="jkh_summary_consistency_", suffix=".sqlite", delete=False)
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
            app_module.db.session.commit()

    def _login(self):
        with self.client.session_transaction() as sess:
            sess["user_id"] = "owner1"

    def _add_summary(self, **kwargs):
        defaults = {
            "owner_id": "owner1",
            "abonent_id": "a1",
            "account_uid": "uid1",
            "account_number": "1001",
            "summary_status": "missing",
            "summary_reason": "",
            "summary_json": "{}",
        }
        defaults.update(kwargs)
        with app_module.app.app_context():
            row = app_module.AbonentSummary(**defaults)
            app_module.db.session.add(row)
            app_module.db.session.commit()
            return row.id

    def test_json_error_repairs_column_status_to_error(self):
        row_id = self._add_summary(
            summary_status="missing",
            summary_reason="",
            summary_json=json.dumps({"summary_status": "error", "summary_reason": "LEDGER_JSON_INVALID"}),
        )

        with app_module.app.app_context():
            dry_run = app_module.audit_abonent_summary_consistency(apply=False)
            self.assertEqual(dry_run["mismatch_count"], 1)
            row = app_module.db.session.get(app_module.AbonentSummary, row_id)
            self.assertEqual(row.summary_status, "missing")

            applied = app_module.audit_abonent_summary_consistency(apply=True)
            self.assertEqual(applied["updated"], 1)
            row = app_module.db.session.get(app_module.AbonentSummary, row_id)
            self.assertEqual(row.summary_status, "error")
            self.assertEqual(row.summary_reason, "LEDGER_JSON_INVALID")

    def test_json_fresh_totals_repair_columns_match(self):
        row_id = self._add_summary(
            summary_json=json.dumps({
                "summary_status": "fresh",
                "summary_reason": "OK",
                "totals": {
                    "debt": "105.50",
                    "accrued": "120.75",
                    "paid": "15.25",
                    "penalty": "5.00",
                },
            }),
        )

        with app_module.app.app_context():
            app_module.audit_abonent_summary_consistency(apply=True)
            row = app_module.db.session.get(app_module.AbonentSummary, row_id)
            self.assertEqual(row.summary_status, "fresh")
            self.assertEqual(row.summary_reason, "OK")
            self.assertEqual(row.total_debt, Decimal("105.50"))
            self.assertEqual(row.total_accrued, Decimal("120.75"))
            self.assertEqual(row.total_paid, Decimal("15.25"))
            self.assertEqual(row.penalty_debt, Decimal("5.00"))

    def test_missing_summary_totals_remain_null_not_zero(self):
        row_id = self._add_summary(
            total_debt=Decimal("0.00"),
            total_accrued=Decimal("0.00"),
            total_paid=Decimal("0.00"),
            penalty_debt=Decimal("0.00"),
            summary_json=json.dumps({"summary_status": "missing", "summary_reason": "SUMMARY_NOT_BUILT"}),
        )

        with app_module.app.app_context():
            app_module.audit_abonent_summary_consistency(apply=True)
            row = app_module.db.session.get(app_module.AbonentSummary, row_id)
            self.assertEqual(row.summary_status, "missing")
            self.assertIsNone(row.total_debt)
            self.assertIsNone(row.total_accrued)
            self.assertIsNone(row.total_paid)
            self.assertIsNone(row.penalty_debt)

    def test_broken_summary_json_is_safe_invalid_and_api_does_not_fake_fresh(self):
        row_id = self._add_summary(
            summary_status="fresh",
            total_debt=Decimal("99.00"),
            summary_json="{broken-json",
        )

        with app_module.app.app_context():
            applied = app_module.audit_abonent_summary_consistency(apply=True)
            self.assertEqual(applied["updated"], 1)
            row = app_module.db.session.get(app_module.AbonentSummary, row_id)
            self.assertEqual(row.summary_status, "invalid")
            self.assertEqual(row.summary_reason, "SUMMARY_JSON_INVALID")
            self.assertIsNone(row.total_debt)

        self._login()
        response = self.client.get("/api/abonent_summary")
        body = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body["items"][0]["summary"]["summary_status"], "invalid")
        self.assertNotEqual(body["items"][0]["summary"].get("summary_status"), "fresh")


if __name__ == "__main__":
    unittest.main()
