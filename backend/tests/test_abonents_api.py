import inspect
import os
import sys
import tempfile
import unittest
from decimal import Decimal
from sqlalchemy import create_engine

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import app as app_module


class AbonentsApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._db_file = tempfile.NamedTemporaryFile(prefix="jkh_stage17a_abonents_", suffix=".sqlite", delete=False)
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
            app_module.db.session.execute(app_module.text("DROP TABLE IF EXISTS abonent"))
            app_module.db.session.execute(app_module.text("DROP TABLE IF EXISTS premise"))
            app_module.db.session.execute(app_module.text("""
                CREATE TABLE abonent (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner_id TEXT NOT NULL,
                    abonent_id TEXT NOT NULL,
                    account_number TEXT NOT NULL,
                    uid TEXT NOT NULL,
                    fio TEXT NOT NULL,
                    premise_id INTEGER
                )
            """))
            app_module.db.session.execute(app_module.text("""
                CREATE TABLE premise (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner_id TEXT NOT NULL,
                    regnum TEXT,
                    address TEXT,
                    city TEXT,
                    street TEXT,
                    house TEXT,
                    flat TEXT
                )
            """))
            app_module.db.session.add(app_module.User(id="owner1", email="o1@test", password_hash="x", role="user", display_name="o1"))
            app_module.db.session.add(app_module.User(id="owner2", email="o2@test", password_hash="x", role="user", display_name="o2"))
            app_module.db.session.execute(app_module.text("""
                INSERT INTO premise (id, owner_id, regnum, address, city, street, house, flat)
                VALUES
                    (1, 'owner1', 'REG-1', 'Main st 1 flat 1', 'Town', 'Main', '1', '1'),
                    (2, 'owner1', 'REG-2', 'Second st 2 flat 2', 'Town', 'Second', '2', '2'),
                    (3, 'owner1', 'REG-3', 'Error st 3 flat 3', 'Town', 'Error', '3', '3'),
                    (4, 'owner2', 'REG-X', 'Other owner address', 'Other', 'Hidden', '9', '9')
            """))
            app_module.db.session.execute(app_module.text("""
                INSERT INTO abonent (owner_id, abonent_id, account_number, uid, fio, premise_id)
                VALUES
                    ('owner1', 'a1', '1001', 'uid-fresh', 'Ivan Fresh', 1),
                    ('owner1', 'a2', '1002', 'uid-missing', 'Maria Missing', 2),
                    ('owner1', 'a3', '1003', 'uid-error', 'Petr Error', 3),
                    ('owner2', 'b1', '2001', 'uid-other', 'Other Owner', 4)
            """))
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner1",
                abonent_id="a1",
                account_uid="uid-fresh",
                account_number="1001",
                total_debt=Decimal("999.00"),
                summary_status="dirty",
                summary_reason="OLDER_ROW",
                summary_json='{"summary_status":"dirty"}',
            ))
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner1",
                abonent_id="a1",
                account_uid="uid-fresh",
                account_number="1001",
                fio="Ivan Fresh",
                address="Main st 1 flat 1",
                total_accrued=Decimal("150.25"),
                total_paid=Decimal("50.00"),
                total_debt=Decimal("100.25"),
                penalty_debt=Decimal("7.75"),
                summary_status="fresh",
                summary_reason="OK",
                summary_json='{"summary_status":"fresh"}',
            ))
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner1",
                abonent_id="a3",
                account_uid="uid-error",
                account_number="1003",
                fio="Petr Error",
                address="Error st 3 flat 3",
                summary_status="error",
                summary_reason="LEDGER_JSON_INVALID",
                summary_json='{"summary_status":"error","summary_reason":"LEDGER_JSON_INVALID"}',
            ))
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner2",
                abonent_id="b1",
                account_uid="uid-other",
                account_number="2001",
                total_debt=Decimal("999.00"),
                summary_status="fresh",
                summary_reason="OK",
                summary_json='{"summary_status":"fresh"}',
            ))
            app_module.db.session.commit()

    def _login(self, user_id):
        with self.client.session_transaction() as sess:
            sess["user_id"] = user_id

    def test_auth_required(self):
        response = self.client.get("/api/abonents")
        body = response.get_json()
        self.assertEqual(response.status_code, 401)
        self.assertEqual(body.get("error"), "not_authenticated")

    def test_owner_isolation_ignores_client_owner_query(self):
        self._login("owner1")
        response = self.client.get("/api/abonents?owner=owner2&limit=100")
        body = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body["total"], 3)
        self.assertEqual({item["uid"] for item in body["items"]}, {"uid-fresh", "uid-missing", "uid-error"})

    def test_abonent_without_summary_is_returned_as_missing_with_null_totals(self):
        self._login("owner1")
        body = self.client.get("/api/abonents?search=uid-missing").get_json()
        item = body["items"][0]
        self.assertEqual(item["summary_status"], "missing")
        self.assertEqual(item["summary_reason"], "SUMMARY_NOT_BUILT")
        self.assertIsNone(item["total_debt"])
        self.assertIsNone(item["total_accrued"])
        self.assertIsNone(item["total_paid"])
        self.assertIsNone(item["total_penalty"])

    def test_fresh_summary_returns_totals(self):
        self._login("owner1")
        body = self.client.get("/api/abonents?query=1001").get_json()
        item = body["items"][0]
        self.assertEqual(item["summary_status"], "fresh")
        self.assertEqual(item["summary_reason"], "OK")
        self.assertEqual(item["total_debt"], 100.25)
        self.assertEqual(item["total_accrued"], 150.25)
        self.assertEqual(item["total_paid"], 50)
        self.assertEqual(item["penalty_debt"], 7.75)
        self.assertEqual(item["total_penalty"], 7.75)
        self.assertEqual(item["regnum"], "REG-1")
        self.assertEqual(item["address_street"], "Main")

    def test_error_summary_is_not_converted_to_zero(self):
        self._login("owner1")
        body = self.client.get("/api/abonents?search=uid-error").get_json()
        item = body["items"][0]
        self.assertEqual(item["summary_status"], "error")
        self.assertEqual(item["summary_reason"], "LEDGER_JSON_INVALID")
        self.assertIsNone(item["total_debt"])
        self.assertNotEqual(item["total_debt"], 0)

    def test_pagination_uses_limit_and_total(self):
        self._login("owner1")
        body = self.client.get("/api/abonents?page=2&limit=1").get_json()
        self.assertEqual(body["page"], 2)
        self.assertEqual(body["limit"], 1)
        self.assertEqual(body["total"], 3)
        self.assertEqual(len(body["items"]), 1)

    def test_status_filter_includes_missing_left_join_rows(self):
        self._login("owner1")
        body = self.client.get("/api/abonents?summary_status=missing").get_json()
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["items"][0]["uid"], "uid-missing")
        self.assertEqual(body["items"][0]["summary_status"], "missing")

    def test_limit_is_clamped_to_200(self):
        self._login("owner1")
        body = self.client.get("/api/abonents?limit=999").get_json()
        self.assertEqual(body["limit"], 200)

    def test_endpoint_source_has_no_frontend_or_recalc_dependencies(self):
        source = inspect.getsource(app_module.abonents_index_list)
        self.assertNotIn("web/index.html", source)
        self.assertNotIn("web/data.js", source)
        self.assertNotIn("web/calc_engine.js", source)
        self.assertNotIn("recalc_batch", source)
        self.assertNotIn("autoaccrual", source.lower().replace("do not run recalculation/autoaccrual", ""))
        self.assertNotIn("payments_<", source.lower().replace("do not read payments_<uid>", ""))


if __name__ == "__main__":
    unittest.main()
