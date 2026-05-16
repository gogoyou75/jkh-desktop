import hashlib
import json
import os
import sys
import tempfile
import unittest
from sqlalchemy import create_engine

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import app as app_module


class AbonentSummaryRebuildTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._db_file = tempfile.NamedTemporaryFile(prefix="jkh_summary_rebuild_", suffix=".sqlite", delete=False)
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
        try:
            os.unlink(cls._db_file.name)
        except OSError:
            pass

    def setUp(self):
        self.client = app_module.app.test_client()
        with app_module.app.app_context():
            app_module.db.session.remove()
            app_module.db.drop_all()
            app_module.db.create_all()
            app_module.db.session.execute(app_module.text("DROP TABLE abonent_summary"))
            app_module.db.session.execute(app_module.text("""
                CREATE TABLE abonent_summary (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner_id VARCHAR(128) NOT NULL,
                    abonent_id VARCHAR(128) NOT NULL DEFAULT '',
                    account_uid VARCHAR(128) NOT NULL DEFAULT '',
                    account_number VARCHAR(128) NOT NULL DEFAULT '',
                    summary_json TEXT NOT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            """))
            app_module.db.session.commit()

    def _add_user(self, user_id, role="user"):
        app_module.db.session.add(app_module.User(
            id=user_id,
            email=f"{user_id}@example.test",
            password_hash="not-used",
            role=role,
            display_name=user_id,
        ))

    def _login(self, user_id):
        with self.client.session_transaction() as sess:
            sess["user_id"] = user_id

    def _put_abonents(self, owner_id, abonents):
        app_module.db.session.add(app_module.KVStore(
            owner=owner_id,
            k="abonents_db_v1",
            v=json.dumps({"abonents": abonents}, ensure_ascii=False),
        ))

    def test_get_does_not_create_missing_summary_rows(self):
        with app_module.app.app_context():
            self._add_user("owner-get")
            self._put_abonents("owner-get", {
                "1001": {"uid": "uid_get_1001", "id": "1001", "fio": "GET User"},
            })
            app_module.db.session.commit()
        self._login("owner-get")

        response = self.client.get("/api/abonent_summary")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["items"], [])
        with app_module.app.app_context():
            self.assertEqual(app_module.AbonentSummary.query.count(), 0)

    def test_rebuild_creates_and_updates_controlled_missing_summary(self):
        with app_module.app.app_context():
            self._add_user("owner-rebuild")
            self._put_abonents("owner-rebuild", {
                "1001": {"uid": "uid_rebuild_1001", "id": "1001", "fio": "First"},
                "1002": {"uid": "uid_rebuild_1002", "id": "1002", "address": "Street 2"},
            })
            app_module.db.session.commit()
        self._login("owner-rebuild")

        first = self.client.post("/api/abonent_summary/rebuild")
        second = self.client.post("/api/abonent_summary/rebuild")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.get_json()["counters"], {"created": 2, "updated": 0, "skipped": 0, "errors": 0})
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.get_json()["counters"], {"created": 0, "updated": 2, "skipped": 0, "errors": 0})
        with app_module.app.app_context():
            rows = app_module.AbonentSummary.query.order_by(app_module.AbonentSummary.account_uid.asc()).all()
            self.assertEqual(len(rows), 2)
            payload = json.loads(rows[0].summary_json)
            self.assertEqual(payload["status"], "missing")
            self.assertEqual(payload["reason"], "SUMMARY_NOT_BUILT")
            self.assertEqual(payload["summary_status"], "missing")
            self.assertEqual(payload["summary_reason"], "SUMMARY_NOT_BUILT")
            self.assertEqual(payload["period"], {"from": None, "to": None})
            self.assertNotIn("total_debt", payload)
            self.assertNotIn("total_penalty", payload)

    def test_rebuild_does_not_touch_calc_engine_js(self):
        calc_engine_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "web", "calc_engine.js"))
        with open(calc_engine_path, "rb") as fh:
            before = hashlib.sha256(fh.read()).hexdigest()
        with app_module.app.app_context():
            self._add_user("owner-calc-engine")
            self._put_abonents("owner-calc-engine", {
                "1001": {"uid": "uid_calc_engine_1001", "id": "1001"},
            })
            app_module.db.session.commit()
        self._login("owner-calc-engine")

        response = self.client.post("/api/abonent_summary/rebuild")

        with open(calc_engine_path, "rb") as fh:
            after = hashlib.sha256(fh.read()).hexdigest()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(before, after)

    def test_rebuild_uses_only_session_owner(self):
        with app_module.app.app_context():
            self._add_user("owner-a")
            self._add_user("owner-b")
            self._put_abonents("owner-a", {
                "1001": {"uid": "uid_owner_a_1001", "id": "1001"},
            })
            self._put_abonents("owner-b", {
                "2001": {"uid": "uid_owner_b_2001", "id": "2001"},
            })
            app_module.db.session.commit()
        self._login("owner-a")

        response = self.client.post("/api/abonent_summary/rebuild?owner=owner-b")

        self.assertEqual(response.status_code, 200)
        with app_module.app.app_context():
            rows = app_module.AbonentSummary.query.all()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0].owner_id, "owner-a")
            self.assertEqual(rows[0].account_uid, "uid_owner_a_1001")

    def test_rebuild_empty_database_does_not_fail(self):
        with app_module.app.app_context():
            self._add_user("owner-empty")
            app_module.db.session.commit()
        self._login("owner-empty")

        response = self.client.post("/api/abonent_summary/rebuild")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["counters"], {"created": 0, "updated": 0, "skipped": 0, "errors": 0})


if __name__ == "__main__":
    unittest.main()
