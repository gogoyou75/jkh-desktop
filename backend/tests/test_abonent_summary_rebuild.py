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


    def _fresh_summary(self, principal=10, penalty=2, total=12):
        return {
            "status": "fresh",
            "reason": "OK",
            "summary_status": "fresh",
            "summary_reason": "OK",
            "period": {"from": "2026-01-01", "to": "2026-01-31"},
            "totals": {"principal": principal, "penalty": penalty, "total": total},
            "calc_engine_version": "test",
            "generated_at": "2026-02-01T00:00:00Z",
        }

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


    def test_single_upsert_creates_fresh_summary_by_uid(self):
        with app_module.app.app_context():
            self._add_user("owner-single-create")
            self._put_abonents("owner-single-create", {
                "1001": {"uid": "uid_single_create_1001", "id": "1001", "fio": "Fresh User"},
            })
            app_module.db.session.commit()
        self._login("owner-single-create")

        response = self.client.post("/api/abonent_summary/rebuild", json={
            "account_uid": "uid_single_create_1001",
            "abonent_id": "1001",
            "account_number": "1001",
            "summary": self._fresh_summary(),
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["counters"], {"created": 1, "updated": 0, "skipped": 0, "errors": 0})
        with app_module.app.app_context():
            row = app_module.AbonentSummary.query.one()
            self.assertEqual(row.owner_id, "owner-single-create")
            self.assertEqual(row.account_uid, "uid_single_create_1001")
            payload = json.loads(row.summary_json)
            self.assertEqual(payload["summary_status"], "fresh")
            self.assertEqual(payload["summary_reason"], "OK")
            self.assertEqual(payload["totals"], {"principal": 10, "penalty": 2, "total": 12})

    def test_single_upsert_updates_existing_row(self):
        with app_module.app.app_context():
            self._add_user("owner-single-update")
            self._put_abonents("owner-single-update", {
                "1001": {"uid": "uid_single_update_1001", "id": "1001"},
            })
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner-single-update",
                abonent_id="old",
                account_uid="uid_single_update_1001",
                account_number="old",
                summary_json=json.dumps({"summary_status": "missing"}),
            ))
            app_module.db.session.commit()
        self._login("owner-single-update")

        response = self.client.post("/api/abonent_summary/rebuild", json={
            "account_uid": "uid_single_update_1001",
            "abonent_id": "1001-new",
            "account_number": "1001-new",
            "summary": self._fresh_summary(33, 4, 37),
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["counters"], {"created": 0, "updated": 1, "skipped": 0, "errors": 0})
        with app_module.app.app_context():
            rows = app_module.AbonentSummary.query.all()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0].abonent_id, "1001-new")
            self.assertEqual(rows[0].account_number, "1001-new")
            self.assertEqual(json.loads(rows[0].summary_json)["totals"]["total"], 37)

    def test_single_upsert_does_not_touch_other_owner(self):
        with app_module.app.app_context():
            self._add_user("owner-single-a")
            self._add_user("owner-single-b")
            self._put_abonents("owner-single-a", {
                "1001": {"uid": "uid_shared_1001", "id": "1001"},
            })
            self._put_abonents("owner-single-b", {
                "2001": {"uid": "uid_shared_1001", "id": "2001"},
            })
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner-single-b",
                abonent_id="2001",
                account_uid="uid_shared_1001",
                account_number="2001",
                summary_json=json.dumps({"summary_status": "missing", "owner": "b"}),
            ))
            app_module.db.session.commit()
        self._login("owner-single-a")

        response = self.client.post("/api/abonent_summary/rebuild", json={
            "account_uid": "uid_shared_1001",
            "abonent_id": "1001",
            "account_number": "1001",
            "summary": self._fresh_summary(),
        })

        self.assertEqual(response.status_code, 200)
        with app_module.app.app_context():
            rows = app_module.AbonentSummary.query.order_by(app_module.AbonentSummary.owner_id.asc()).all()
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0].owner_id, "owner-single-a")
            self.assertEqual(json.loads(rows[0].summary_json)["summary_status"], "fresh")
            self.assertEqual(rows[1].owner_id, "owner-single-b")
            self.assertEqual(json.loads(rows[1].summary_json)["owner"], "b")

    def test_single_upsert_ignores_query_and_body_owner_spoofing(self):
        with app_module.app.app_context():
            self._add_user("owner-spoof-a")
            self._add_user("owner-spoof-b")
            self._put_abonents("owner-spoof-a", {
                "1001": {"uid": "uid_spoof_a_1001", "id": "1001"},
            })
            self._put_abonents("owner-spoof-b", {
                "2001": {"uid": "uid_spoof_b_2001", "id": "2001"},
            })
            app_module.db.session.commit()
        self._login("owner-spoof-a")

        response = self.client.post("/api/abonent_summary/rebuild?owner=owner-spoof-b", json={
            "owner": "owner-spoof-b",
            "account_uid": "uid_spoof_a_1001",
            "abonent_id": "1001",
            "account_number": "1001",
            "summary": self._fresh_summary(),
        })

        self.assertEqual(response.status_code, 200)
        with app_module.app.app_context():
            row = app_module.AbonentSummary.query.one()
            self.assertEqual(row.owner_id, "owner-spoof-a")
            self.assertEqual(row.account_uid, "uid_spoof_a_1001")

    def test_single_upsert_invalid_summary_returns_400(self):
        with app_module.app.app_context():
            self._add_user("owner-invalid-summary")
            self._put_abonents("owner-invalid-summary", {
                "1001": {"uid": "uid_invalid_summary_1001", "id": "1001"},
            })
            app_module.db.session.commit()
        self._login("owner-invalid-summary")

        response = self.client.post("/api/abonent_summary/rebuild", json={
            "account_uid": "uid_invalid_summary_1001",
            "summary": "not-object",
        })

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "summary_invalid")

    def test_single_upsert_unknown_uid_returns_404(self):
        with app_module.app.app_context():
            self._add_user("owner-unknown-uid")
            self._put_abonents("owner-unknown-uid", {
                "1001": {"uid": "uid_known_1001", "id": "1001"},
            })
            app_module.db.session.commit()
        self._login("owner-unknown-uid")

        response = self.client.post("/api/abonent_summary/rebuild", json={
            "account_uid": "uid_unknown_1001",
            "summary": self._fresh_summary(),
        })

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["error"], "uid_not_found")

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
