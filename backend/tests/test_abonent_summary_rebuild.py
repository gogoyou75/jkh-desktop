import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from sqlalchemy import create_engine

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app as app_module


class AbonentSummaryRebuildTest(unittest.TestCase):
    @staticmethod
    def _find_repo_file(*parts: str):
        tests_dir = Path(__file__).resolve().parent
        backend_dir = tests_dir.parent
        repo_root = backend_dir.parent
        candidates = [
            repo_root.joinpath(*parts),
            Path("/app").joinpath(*parts),
        ]
        for candidate in candidates:
            if candidate.exists():
                return candidate
        return None

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

    def test_single_upsert_preserves_fresh_summary_metadata_fields(self):
        with app_module.app.app_context():
            self._add_user("owner-single-metadata")
            self._put_abonents("owner-single-metadata", {
                "1001": {"uid": "uid_single_metadata_1001", "id": "1001"},
            })
            app_module.db.session.commit()
        self._login("owner-single-metadata")

        response = self.client.post("/api/abonent_summary/rebuild", json={
            "account_uid": "uid_single_metadata_1001",
            "abonent_id": "1001",
            "account_number": "1001",
            "summary": {
                **self._fresh_summary(21, 3, 24),
                "canon_version": "canon-v1",
                "recalc_fingerprint": hashlib.sha256(b"uid_single_metadata_1001").hexdigest(),
                "updated_at": "2026-02-01T00:00:01Z",
            },
        })

        self.assertEqual(response.status_code, 200)
        with app_module.app.app_context():
            payload = json.loads(app_module.AbonentSummary.query.one().summary_json)
            self.assertEqual(payload["calc_engine_version"], "test")
            self.assertEqual(payload["canon_version"], "canon-v1")
            self.assertIn("recalc_fingerprint", payload)
            self.assertEqual(payload["generated_at"], "2026-02-01T00:00:00Z")
            self.assertEqual(payload["updated_at"], "2026-02-01T00:00:01Z")

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

    def test_single_upsert_one_uid_does_not_touch_other_uid_same_owner(self):
        with app_module.app.app_context():
            self._add_user("owner-single-two-uids")
            self._put_abonents("owner-single-two-uids", {
                "1001": {"uid": "uid_single_one_1001", "id": "1001"},
                "1002": {"uid": "uid_single_one_1002", "id": "1002"},
            })
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner-single-two-uids",
                abonent_id="1002",
                account_uid="uid_single_one_1002",
                account_number="1002",
                summary_json=json.dumps(self._fresh_summary(90, 9, 99)),
            ))
            app_module.db.session.commit()
        self._login("owner-single-two-uids")

        response = self.client.post("/api/abonent_summary/rebuild", json={
            "account_uid": "uid_single_one_1001",
            "abonent_id": "1001",
            "account_number": "1001",
            "summary": self._fresh_summary(10, 2, 12),
        })

        self.assertEqual(response.status_code, 200)
        with app_module.app.app_context():
            rows = {r.account_uid: json.loads(r.summary_json) for r in app_module.AbonentSummary.query.all()}
            self.assertEqual(rows["uid_single_one_1001"]["totals"]["total"], 12)
            self.assertEqual(rows["uid_single_one_1002"]["totals"]["total"], 99)

    def test_dirty_uid_becomes_fresh_after_single_upsert(self):
        with app_module.app.app_context():
            self._add_user("owner-dirty-to-fresh")
            self._put_abonents("owner-dirty-to-fresh", {
                "1001": {"uid": "uid_dirty_to_fresh_1001", "id": "1001"},
            })
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner-dirty-to-fresh",
                abonent_id="1001",
                account_uid="uid_dirty_to_fresh_1001",
                account_number="1001",
                summary_json=json.dumps({"summary_status": "dirty", "summary_reason": "PAYMENTS_CHANGED"}),
            ))
            app_module.db.session.commit()
        self._login("owner-dirty-to-fresh")

        response = self.client.post("/api/abonent_summary/rebuild", json={
            "account_uid": "uid_dirty_to_fresh_1001",
            "abonent_id": "1001",
            "account_number": "1001",
            "summary": self._fresh_summary(7, 1, 8),
        })

        self.assertEqual(response.status_code, 200)
        with app_module.app.app_context():
            payload = json.loads(app_module.AbonentSummary.query.one().summary_json)
            self.assertEqual(payload["summary_status"], "fresh")
            self.assertEqual(payload["summary_reason"], "OK")
            self.assertEqual(payload["totals"]["total"], 8)

    def test_single_upsert_calculation_error_has_no_fake_zero_totals(self):
        with app_module.app.app_context():
            self._add_user("owner-error-summary")
            self._put_abonents("owner-error-summary", {
                "1001": {"uid": "uid_error_summary_1001", "id": "1001"},
            })
            app_module.db.session.commit()
        self._login("owner-error-summary")

        response = self.client.post("/api/abonent_summary/rebuild", json={
            "account_uid": "uid_error_summary_1001",
            "abonent_id": "1001",
            "account_number": "1001",
            "summary": {
                "summary_status": "error",
                "summary_reason": "LEDGER_JSON_INVALID",
                "account_uid": "uid_error_summary_1001",
                "account_number": "1001",
                "period_start": "2026-01-01",
                "period_end": "2026-01-31",
            },
        })

        self.assertEqual(response.status_code, 200)
        with app_module.app.app_context():
            payload = json.loads(app_module.AbonentSummary.query.one().summary_json)
            self.assertEqual(payload["summary_status"], "error")
            self.assertEqual(payload["summary_reason"], "LEDGER_JSON_INVALID")
            self.assertNotIn("totals", payload)
            self.assertNotEqual(payload.get("total_debt"), 0)

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

    def test_data_write_payment_ledger_blocks_account_number_write_path(self):
        data_path = self._find_repo_file("web", "data.js")
        if data_path is None:
            self.skipTest("web/data.js is unavailable in this runtime image")
        src = data_path.read_text(encoding="utf-8")

        self.assertIn("LS_LEDGER_WRITE_FORBIDDEN", src)
        self.assertIn('key === "payments_" + id', src)
        self.assertIn('key !== "payments_" + uid', src)

    def test_rebuild_does_not_touch_calc_engine_js(self):
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        if calc_engine_path is None:
            self.skipTest("web/calc_engine.js is unavailable in this runtime image")
        before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        with app_module.app.app_context():
            self._add_user("owner-calc-engine")
            self._put_abonents("owner-calc-engine", {
                "1001": {"uid": "uid_calc_engine_1001", "id": "1001"},
            })
            app_module.db.session.commit()
        self._login("owner-calc-engine")

        response = self.client.post("/api/abonent_summary/rebuild")

        after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
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


    def test_mark_dirty_creates_dirty_summary_for_known_uid(self):
        with app_module.app.app_context():
            self._add_user("owner-dirty-create")
            self._put_abonents("owner-dirty-create", {
                "1001": {"uid": "uid_dirty_create_1001", "id": "1001", "fio": "Dirty User"},
            })
            app_module.db.session.commit()
        self._login("owner-dirty-create")

        response = self.client.post("/api/abonent_summary/mark_dirty", json={
            "account_uid": "uid_dirty_create_1001",
            "reason": "PAYMENTS_CHANGED",
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["counters"], {"created": 1, "updated": 0, "skipped": 0, "errors": 0})
        self.assertEqual(response.get_json()["status"], "dirty")
        self.assertEqual(response.get_json()["reason"], "PAYMENTS_CHANGED")
        with app_module.app.app_context():
            row = app_module.AbonentSummary.query.one()
            self.assertEqual(row.owner_id, "owner-dirty-create")
            self.assertEqual(row.abonent_id, "1001")
            self.assertEqual(row.account_uid, "uid_dirty_create_1001")
            self.assertEqual(row.account_number, "1001")
            payload = json.loads(row.summary_json)
            self.assertEqual(payload["summary_status"], "dirty")
            self.assertEqual(payload["summary_reason"], "PAYMENTS_CHANGED")
            self.assertEqual(payload["status"], "dirty")
            self.assertEqual(payload["reason"], "PAYMENTS_CHANGED")
            self.assertEqual(payload["period"], {"from": None, "to": None})
            self.assertIn("dirty_at", payload)
            self.assertNotIn("totals", payload)

    def test_mark_dirty_updates_existing_fresh_summary_to_dirty(self):
        with app_module.app.app_context():
            self._add_user("owner-dirty-update")
            self._put_abonents("owner-dirty-update", {
                "1001": {"uid": "uid_dirty_update_1001", "id": "1001"},
            })
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner-dirty-update",
                abonent_id="1001",
                account_uid="uid_dirty_update_1001",
                account_number="1001",
                summary_json=json.dumps(self._fresh_summary(50, 7, 57)),
            ))
            app_module.db.session.commit()
        self._login("owner-dirty-update")

        response = self.client.post("/api/abonent_summary/mark_dirty", json={
            "account_uid": "uid_dirty_update_1001",
            "reason": "IMPORT_PAYMENTS_APPLIED",
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["counters"], {"created": 0, "updated": 1, "skipped": 0, "errors": 0})
        with app_module.app.app_context():
            row = app_module.AbonentSummary.query.one()
            payload = json.loads(row.summary_json)
            self.assertEqual(payload["summary_status"], "dirty")
            self.assertEqual(payload["summary_reason"], "IMPORT_PAYMENTS_APPLIED")
            self.assertEqual(payload["status"], "dirty")
            self.assertEqual(payload["reason"], "IMPORT_PAYMENTS_APPLIED")
            self.assertNotIn("totals", payload)
            self.assertNotEqual(payload.get("total_debt"), 0)

    def test_mark_dirty_rejects_unknown_uid_with_404(self):
        with app_module.app.app_context():
            self._add_user("owner-dirty-unknown")
            self._put_abonents("owner-dirty-unknown", {
                "1001": {"uid": "uid_dirty_known_1001", "id": "1001"},
            })
            app_module.db.session.commit()
        self._login("owner-dirty-unknown")

        response = self.client.post("/api/abonent_summary/mark_dirty", json={
            "account_uid": "uid_dirty_unknown_1001",
            "reason": "PAYMENTS_CHANGED",
        })

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json(), {"ok": False, "error": "uid_not_found"})
        with app_module.app.app_context():
            self.assertEqual(app_module.AbonentSummary.query.count(), 0)

    def test_mark_dirty_ignores_query_and_body_owner_spoofing(self):
        with app_module.app.app_context():
            self._add_user("owner-dirty-spoof-a")
            self._add_user("owner-dirty-spoof-b")
            self._put_abonents("owner-dirty-spoof-a", {
                "1001": {"uid": "uid_dirty_spoof_a_1001", "id": "1001"},
            })
            self._put_abonents("owner-dirty-spoof-b", {
                "2001": {"uid": "uid_dirty_spoof_b_2001", "id": "2001"},
            })
            app_module.db.session.commit()
        self._login("owner-dirty-spoof-a")

        response = self.client.post("/api/abonent_summary/mark_dirty?owner=owner-dirty-spoof-b", json={
            "owner": "owner-dirty-spoof-b",
            "account_uid": "uid_dirty_spoof_a_1001",
            "reason": "PAYMENTS_CHANGED",
        })

        self.assertEqual(response.status_code, 200)
        with app_module.app.app_context():
            row = app_module.AbonentSummary.query.one()
            self.assertEqual(row.owner_id, "owner-dirty-spoof-a")
            self.assertEqual(row.account_uid, "uid_dirty_spoof_a_1001")

    def test_mark_dirty_skips_calc_period_changed_without_creating_summary(self):
        with app_module.app.app_context():
            self._add_user("owner-period-skip-create")
            self._put_abonents("owner-period-skip-create", {
                "1001": {"uid": "uid_period_skip_create_1001", "id": "1001"},
            })
            app_module.db.session.commit()
        self._login("owner-period-skip-create")

        response = self.client.post("/api/abonent_summary/mark_dirty", json={
            "account_uid": "uid_period_skip_create_1001",
            "reason": "CALC_PERIOD_CHANGED",
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "skipped")
        self.assertEqual(response.get_json()["view_only_reason"], "CALC_PERIOD_CHANGED")
        self.assertEqual(response.get_json()["counters"], {"created": 0, "updated": 0, "skipped": 1, "errors": 0})
        with app_module.app.app_context():
            self.assertEqual(app_module.AbonentSummary.query.count(), 0)

    def test_mark_dirty_skips_calc_period_changed_without_dirtying_existing_summary(self):
        original_summary = self._fresh_summary(50, 7, 57)
        with app_module.app.app_context():
            self._add_user("owner-period-skip-existing")
            self._put_abonents("owner-period-skip-existing", {
                "1001": {"uid": "uid_period_skip_existing_1001", "id": "1001"},
            })
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner-period-skip-existing",
                abonent_id="1001",
                account_uid="uid_period_skip_existing_1001",
                account_number="1001",
                summary_json=json.dumps(original_summary, sort_keys=True),
            ))
            app_module.db.session.commit()
        self._login("owner-period-skip-existing")

        response = self.client.post("/api/abonent_summary/mark_dirty", json={
            "account_uid": "uid_period_skip_existing_1001",
            "reason": "CALC_PERIOD_CHANGED",
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "skipped")
        with app_module.app.app_context():
            row = app_module.AbonentSummary.query.one()
            self.assertEqual(json.loads(row.summary_json), original_summary)

    def test_mark_dirty_does_not_touch_other_owner(self):
        with app_module.app.app_context():
            self._add_user("owner-dirty-a")
            self._add_user("owner-dirty-b")
            self._put_abonents("owner-dirty-a", {
                "1001": {"uid": "uid_dirty_shared_1001", "id": "1001"},
            })
            self._put_abonents("owner-dirty-b", {
                "2001": {"uid": "uid_dirty_shared_1001", "id": "2001"},
            })
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner-dirty-b",
                abonent_id="2001",
                account_uid="uid_dirty_shared_1001",
                account_number="2001",
                summary_json=json.dumps({"summary_status": "fresh", "owner": "b", "totals": {"total": 99}}),
            ))
            app_module.db.session.commit()
        self._login("owner-dirty-a")

        response = self.client.post("/api/abonent_summary/mark_dirty", json={
            "account_uid": "uid_dirty_shared_1001",
            "reason": "EXCLUDES_CHANGED",
        })

        self.assertEqual(response.status_code, 200)
        with app_module.app.app_context():
            rows = app_module.AbonentSummary.query.order_by(app_module.AbonentSummary.owner_id.asc()).all()
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0].owner_id, "owner-dirty-a")
            self.assertEqual(json.loads(rows[0].summary_json)["summary_status"], "dirty")
            self.assertEqual(rows[1].owner_id, "owner-dirty-b")
            self.assertEqual(json.loads(rows[1].summary_json), {"summary_status": "fresh", "owner": "b", "totals": {"total": 99}})

    def test_mark_dirty_does_not_calculate_totals(self):
        with app_module.app.app_context():
            self._add_user("owner-dirty-no-totals")
            self._put_abonents("owner-dirty-no-totals", {
                "1001": {"uid": "uid_dirty_no_totals_1001", "id": "1001"},
            })
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner-dirty-no-totals",
                abonent_id="1001",
                account_uid="uid_dirty_no_totals_1001",
                account_number="1001",
                summary_json=json.dumps({"summary_status": "fresh", "totals": {"principal": 5, "penalty": 1, "total": 6}}),
            ))
            app_module.db.session.commit()
        self._login("owner-dirty-no-totals")

        response = self.client.post("/api/abonent_summary/mark_dirty", json={
            "account_uid": "uid_dirty_no_totals_1001",
            "reason": "LEDGER_WRITE",
        })

        self.assertEqual(response.status_code, 200)
        with app_module.app.app_context():
            payload = json.loads(app_module.AbonentSummary.query.one().summary_json)
            self.assertEqual(payload["summary_status"], "dirty")
            self.assertNotIn("totals", payload)
            self.assertNotEqual(payload.get("totals"), {"principal": 0, "penalty": 0, "total": 0})

    def test_get_abonent_summary_remains_read_only_after_mark_dirty_endpoint_added(self):
        with app_module.app.app_context():
            self._add_user("owner-dirty-get")
            self._put_abonents("owner-dirty-get", {
                "1001": {"uid": "uid_dirty_get_1001", "id": "1001"},
            })
            app_module.db.session.commit()
        self._login("owner-dirty-get")

        response = self.client.get("/api/abonent_summary?account_uid=uid_dirty_get_1001")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["items"], [])
        with app_module.app.app_context():
            self.assertEqual(app_module.AbonentSummary.query.count(), 0)

    def test_calc_period_frontend_save_is_view_state_only(self):
        path = self._find_repo_file("web", "abonent_card.html")
        self.assertIsNotNone(path)
        source = path.read_text(encoding="utf-8")
        self.assertIn("function saveCalcPeriod(from, to){", source)
        self.assertIn("function setCalcPeriodActive(active){", source)
        save_body = source.split("function saveCalcPeriod(from, to){", 1)[1].split("function setCalcPeriodActive(active){", 1)[0]
        active_body = source.split("function setCalcPeriodActive(active){", 1)[1].split("function confirmCalcPeriodSaved(){", 1)[0]

        combined = save_body + active_body
        self.assertIn("storeSet(meta.storageKey", save_body)
        self.assertIn("storeSet(meta.activeStorageKey", combined)
        self.assertNotIn("markCurrentAbonentSummaryDirty", combined)
        self.assertNotIn("markAbonentSummaryDirty", combined)
        self.assertNotIn("payments_", combined)
        self.assertNotIn("ledger_runtime_cache_", combined)
        self.assertNotIn("recalc", combined.lower())
        self.assertNotIn("autoaccrual", combined.lower())

    def test_calc_period_changed_is_not_used_by_index_or_batch_recalc(self):
        for parts in (("web", "index.html"), ("web", "data.js")):
            path = self._find_repo_file(*parts)
            self.assertIsNotNone(path)
            source = path.read_text(encoding="utf-8")
            if parts[-1] == "index.html":
                self.assertNotIn("CALC_PERIOD_CHANGED", source)
            if parts[-1] == "data.js":
                pattern = re.compile(r"recalc_batch[^\\n]+CALC_PERIOD_CHANGED|CALC_PERIOD_CHANGED[^\\n]+recalc_batch", re.I)
                self.assertIsNone(pattern.search(source))

    def test_calc_engine_source_remains_unmodified_for_stage_13_1(self):
        path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(path)
        source = path.read_text(encoding="utf-8")
        self.assertIn("calc_period_", source)
        self.assertIn("allocatePaymentsFIFO", source)

    def test_manual_full_recalc_saves_canonical_abonent_summary(self):
        path = self._find_repo_file("web", "payment_table.js")
        self.assertIsNotNone(path)
        source = path.read_text(encoding="utf-8")
        self.assertIn("window.fullRecalcForCurrentAbonent", source)
        body = source.split("window.fullRecalcForCurrentAbonent", 1)[1].split("window.__loadPaymentTable", 1)[0]

        self.assertIn("applyControlledAutoAccrualForManualRecalc", source)
        self.assertIn("validateResponsibilityRangeForManualRecalc", source)
        self.assertIn("suggestResponsibilityStartFromPayments", source)
        self.assertIn("allowResponsibilityStartRepair === true", source)
        self.assertIn("[responsibility][repair-from-payments]", source)
        self.assertIn("RESPONSIBILITY_PERIOD_MISSING", source)
        self.assertIn("window.JKHAutoAccrual.dryRunForAbonent(abonentId)", source)
        self.assertIn("Data.writePaymentLedger", source)
        self.assertIn("summaryDirtyReason:false", source)
        self.assertIn("hasAccrualInManualRecalcPeriod", source)
        self.assertIn("ACCRUALS_NOT_CREATED", source)
        self.assertIn("Data.flushDbToServer", source)
        self.assertIn("Data.writeLedgerRuntimeCache", body)
        self.assertIn('__paymentTableMode = "readonly_no_recalc"', body)
        self.assertIn('await loadPaymentTable("full_recalc_completed")', body)
        self.assertIn("Data.recalculateAbonentCard(id, { period: opts.period })", body)
        self.assertIn("autoaccrual_changed", body)
        self.assertIn("summary_status", body)
        self.assertIn("summary_save", body)
        self.assertNotIn("calcStartDate = fromISO2", source)
        self.assertNotIn("return clamp({ from: fromISO2", source)
        self.assertNotIn("recalc_batch", body)

        data_path = self._find_repo_file("web", "data.js")
        self.assertIsNotNone(data_path)
        data_source = data_path.read_text(encoding="utf-8")
        self.assertIn("opts.summaryDirtyReason !== false", data_source)

    def test_calc_run_button_renders_summary_returned_by_manual_recalc(self):
        path = self._find_repo_file("web", "abonent_card.html")
        self.assertIsNotNone(path)
        source = path.read_text(encoding="utf-8")
        self.assertIn("calcRunBtn", source)
        self.assertIn("window.fullRecalcForCurrentAbonent", source)
        self.assertIn("__isCanonicalCalcPeriodKey", source)
        self.assertIn("__isCanonicalCalcPeriodActiveKey", source)
        self.assertIn("CANONICAL_READBACK_FAILED", source)
        self.assertIn("confirmCalcPeriodSaved()) return", source)
        body = source.split("window.fullRecalcForCurrentAbonent", 1)[1].split("if (!recalcHandled)", 1)[0]

        self.assertIn("applyAutoAccrual: true", body)
        self.assertIn("period: { from: from, to: to }", body)
        self.assertIn("recalcResult.summary", body)
        self.assertIn("manualRecalcErrorMessage", source)
        self.assertIn("Не задан период ответственности/дата начала расчёта", source)
        self.assertIn("renderAbonentSummaryStatus(summaryStatus, summaryReason)", body)
        self.assertIn("__renderAbonentTotalsFromFreshSummary(summary)", body)
        self.assertNotIn("CALC_PERIOD_CHANGED", body)
        self.assertNotIn("recalc_batch", body)

    def test_stage_13_2a_ledger_canonical_diagnostics_and_race_guards(self):
        data_path = self._find_repo_file("web", "data.js")
        payment_path = self._find_repo_file("web", "payment_table.js")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(data_path)
        self.assertIsNotNone(payment_path)
        self.assertIsNotNone(calc_engine_path)
        data_source = data_path.read_text(encoding="utf-8")
        payment_source = payment_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        manual_body = payment_source.split("applyControlledAutoAccrualForManualRecalc", 1)[1].split("window.fullRecalcForCurrentAbonent", 1)[0]
        self.assertIn('eventType:"AUTOACCRUAL_WRITE", summaryDirtyReason:false', manual_body)
        self.assertIn('eventType: "PAYMENT_TABLE_WRITE", summaryDirtyReason: "PAYMENTS_CHANGED"', payment_source)
        self.assertIn("clearPaymentLedgerReadCache(\"manual-recalc-autoaccrual\")", manual_body)
        self.assertIn("Data.invalidateLedgerRuntimeCache(abonentId)", manual_body)
        self.assertIn("freshPayload", payment_source)
        self.assertIn("Data.writeLedgerRuntimeCache(id, freshPayload)", payment_source)

        self.assertIn("window.JKH_diagnoseLedger = function()", data_source)
        diagnostic_body = data_source.split("window.JKH_diagnoseLedger = function()", 1)[1].split("window.getPaymentsKeyForAbonent", 1)[0]
        self.assertIn("console.table(report)", diagnostic_body)
        self.assertIn("return report", diagnostic_body)
        self.assertNotIn("_setProjectRaw", diagnostic_body)
        self.assertNotIn("_removeProjectRaw", diagnostic_body)
        self.assertIn("LEGACY_ONLY", diagnostic_body)
        self.assertIn("MIXED_CANONICAL_AND_LEGACY", diagnostic_body)
        self.assertIn("UID_MISSING_WITH_LEGACY", diagnostic_body)

        read_body = data_source.split("function readPaymentLedger", 1)[1].split("function _logLedgerInit", 1)[0]
        self.assertIn("[ledger][legacy-readonly-fallback]", data_source)
        self.assertIn("legacyRowsCount", read_body)
        self.assertNotIn("_setProjectRaw", read_body)
        self.assertNotIn("_removeProjectRaw", read_body)

        recalc_body = data_source.split("async function recalculateAbonentCard", 1)[1].split("// ============================================================", 1)[0]
        self.assertIn("[summary][fresh-blocked-legacy-ledger]", data_source)
        self.assertIn("LEGACY_LEDGER_MIGRATION_REQUIRED", recalc_body)
        self.assertIn("canonicalRaw === null || canonicalRaw === undefined", recalc_body)

        ensure_body = data_source.split("function ensureAbonentUidOnRecord", 1)[1].split("async function ensureAbonentUid", 1)[0]
        self.assertIn("[uid][generation-blocked-legacy-ledger]", data_source)
        self.assertIn("UID_MISSING_WITH_LEGACY_LEDGER", ensure_body)
        self.assertIn("_hasLegacyLedgerRows(id, a)", ensure_body)

        self.assertNotIn("CALC_PERIOD_CHANGED", payment_source.split("window.fullRecalcForCurrentAbonent", 1)[1].split("window.__loadPaymentTable", 1)[0])
        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_stage_13_2b_ledger_migration_verification_is_read_only(self):
        data_path = self._find_repo_file("web", "data.js")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(data_path)
        self.assertIsNotNone(calc_engine_path)
        data_source = data_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        self.assertIn("window.JKH_verifyLedgerMigration = function(options)", data_source)
        body = data_source.split("window.JKH_verifyLedgerMigration = function(options)", 1)[1].split("window.getPaymentsKeyForAbonent", 1)[0]
        self.assertIn("verification-only", body)
        self.assertIn("readOnly: true", body)
        self.assertIn("READY_TO_MIGRATE", data_source)
        self.assertIn("READY_TO_MIGRATE_EMPTY_CANONICAL", data_source)
        self.assertIn("BLOCKED_MIXED_LEDGER", data_source)
        self.assertIn("BLOCKED_UID_MISSING_WITH_LEGACY", data_source)
        self.assertIn("BLOCKED_INVALID_UID", data_source)
        self.assertIn("STALE_RUNTIME_CACHE", data_source)
        self.assertIn("BLOCKED_ORPHAN_SUMMARY", data_source)
        self.assertIn("console.table(items)", body)
        self.assertIn("[ledger][migration-verification]", body)
        self.assertNotIn("_setProjectRaw", body)
        self.assertNotIn("_removeProjectRaw", body)
        self.assertNotIn("writePaymentLedger", body)
        self.assertNotIn("createEmptyPaymentLedger", body)
        self.assertNotIn("ensureAbonentUid", body)
        self.assertNotIn("AUTOACCRUAL_WRITE", body)
        self.assertNotIn("CALC_PERIOD_CHANGED", body)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_stage_13_2ba_per_abonent_ledger_diagnostics_are_read_only(self):
        data_path = self._find_repo_file("web", "data.js")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(data_path)
        self.assertIsNotNone(calc_engine_path)
        data_source = data_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        self.assertIn("window.JKH_verifyLedgerMigrationForAbonent = function(abonentId)", data_source)
        self.assertIn("window.JKH_debugAbonentLedger = function(abonentId)", data_source)
        helper_body = data_source.split("function _debugAbonentLedgerReport", 1)[1].split("window.getPaymentsKeyForAbonent", 1)[0]
        self.assertIn("[ledger-migration][abonent-verification]", helper_body)
        self.assertIn("[ledger-migration][abonent-debug]", helper_body)
        self.assertIn("whySummaryFreshBlocked", helper_body)
        self.assertIn("whyIndexTotalsEmpty", helper_body)
        self.assertIn("LEGACY_LEDGER_MIGRATION_REQUIRED", helper_body)
        self.assertIn("UID_MISSING_WITH_LEGACY_LEDGER", helper_body)
        self.assertIn("MIXED_LEDGER_DIFFERENCE", helper_body)
        self.assertIn("RESPONSIBILITY_PERIOD_MISSING", helper_body)
        self.assertIn("CANONICAL_LEDGER_EMPTY", helper_body)
        self.assertIn("TOTALS_EMPTY", helper_body)
        self.assertIn("mixedComparison", helper_body)
        self.assertIn("checksumEqual", data_source)
        self.assertIn("totalsEqual", data_source)
        self.assertNotIn("_setProjectRaw", helper_body)
        self.assertNotIn("_removeProjectRaw", helper_body)
        self.assertNotIn("writePaymentLedger", helper_body)
        self.assertNotIn("createEmptyPaymentLedger", helper_body)
        self.assertNotIn("ensureAbonentUid", helper_body)
        self.assertNotIn("AUTOACCRUAL_WRITE", helper_body)
        self.assertNotIn("CALC_PERIOD_CHANGED", helper_body)
        self.assertIn("window.JKH_verifyLedgerMigration = function(options)", data_source)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)


if __name__ == "__main__":
    unittest.main()
