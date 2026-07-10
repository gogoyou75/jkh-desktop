import hashlib
import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from sqlalchemy import create_engine

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from _repo_paths import find_repo_file
import app as app_module


class AbonentSummaryRebuildTest(unittest.TestCase):
    @staticmethod
    def _find_repo_file(*parts: str):
        return find_repo_file(*parts)

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
                    fio VARCHAR(255) NOT NULL DEFAULT '',
                    address VARCHAR(1024) NOT NULL DEFAULT '',
                    total_accrued NUMERIC(14, 2) NULL,
                    total_paid NUMERIC(14, 2) NULL,
                    main_debt NUMERIC(14, 2) NULL,
                    penalty_debt NUMERIC(14, 2) NULL,
                    total_debt NUMERIC(14, 2) NULL,
                    summary_status VARCHAR(32) NOT NULL DEFAULT 'missing',
                    summary_reason VARCHAR(128) NOT NULL DEFAULT '',
                    input_hash VARCHAR(64) NOT NULL DEFAULT '',
                    dirty_since DATETIME NULL,
                    last_error_code VARCHAR(64) NOT NULL DEFAULT '',
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
            "totals": {"principal": principal, "debt": total, "penalty": penalty, "total": total, "accrued": principal, "paid": 0},
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
            self.assertEqual(payload["totals"]["principal"], 10)
            self.assertEqual(payload["totals"]["debt"], 12)
            self.assertEqual(payload["totals"]["penalty"], 2)
            self.assertEqual(payload["totals"]["total"], 12)
            self.assertEqual(payload["totals"]["accrued"], 10)
            self.assertEqual(payload["totals"]["paid"], 0)

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

    def test_rebuild_without_body_does_not_pretend_financial_recalc(self):
        with app_module.app.app_context():
            self._add_user("owner-rebuild-no-financial")
            self._put_abonents("owner-rebuild-no-financial", {
                "1001": {"uid": "uid_rebuild_no_financial_1001", "id": "1001"},
            })
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner-rebuild-no-financial",
                abonent_id="1001",
                account_uid="uid_rebuild_no_financial_1001",
                account_number="1001",
                summary_json=json.dumps({"summary_status": "fresh", "summary_reason": "OK"}),
            ))
            app_module.db.session.commit()
        self._login("owner-rebuild-no-financial")

        response = self.client.post("/api/abonent_summary/rebuild")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["counters"], {"created": 0, "updated": 1, "skipped": 0, "errors": 0})
        with app_module.app.app_context():
            payload = json.loads(app_module.AbonentSummary.query.one().summary_json)
            self.assertEqual(payload["summary_status"], "missing")
            self.assertEqual(payload["summary_reason"], "SUMMARY_NOT_BUILT")
            self.assertNotIn("totals", payload)
            self.assertNotIn("total_debt", payload)
            self.assertNotEqual(payload.get("summary_status"), "fresh")

    def test_data_write_payment_ledger_blocks_account_number_write_path(self):
        data_path = self._find_repo_file("web", "data.js")
        self.assertIsNotNone(data_path)
        src = data_path.read_text(encoding="utf-8")

        self.assertIn("LS_LEDGER_WRITE_FORBIDDEN", src)
        self.assertIn('key === "payments_" + id', src)
        self.assertIn('key !== "payments_" + uid', src)

    def test_rebuild_does_not_touch_calc_engine_js(self):
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(calc_engine_path)
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

    def test_index_api_maps_legacy_calc_period_changed_dirty_to_missing(self):
        with app_module.app.app_context():
            self._add_user("owner-period-legacy-index")
            self._put_abonents("owner-period-legacy-index", {
                "1001": {"uid": "uid_period_legacy_index_1001", "id": "1001"},
            })
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner-period-legacy-index",
                abonent_id="1001",
                account_uid="uid_period_legacy_index_1001",
                account_number="1001",
                summary_json=json.dumps({
                    "summary_status": "dirty",
                    "summary_reason": "CALC_PERIOD_CHANGED",
                    "status": "dirty",
                    "reason": "CALC_PERIOD_CHANGED",
                }, sort_keys=True),
            ))
            app_module.db.session.commit()
        self._login("owner-period-legacy-index")

        response = self.client.get("/api/abonents?limit=10")

        self.assertEqual(response.status_code, 200)
        item = response.get_json()["items"][0]
        self.assertEqual(item["summary_status"], "missing")
        self.assertEqual(item["summary"]["summary_status"], "missing")
        self.assertEqual(item["summary"]["summary_reason"], "CALC_PERIOD_CHANGED")

        dirty_response = self.client.get("/api/abonents?limit=10&summary_status=dirty")
        missing_response = self.client.get("/api/abonents?limit=10&summary_status=missing")
        self.assertEqual(dirty_response.status_code, 200)
        self.assertEqual(missing_response.status_code, 200)
        self.assertEqual(dirty_response.get_json()["items"], [])
        self.assertEqual(len(missing_response.get_json()["items"]), 1)

    def test_invalid_fresh_without_totals_is_error_for_index_and_batch_job(self):
        with app_module.app.app_context():
            self._add_user("owner-invalid-fresh-batch")
            self._put_abonents("owner-invalid-fresh-batch", {
                "1001": {"uid": "uid_invalid_fresh_batch_1001", "id": "1001"},
            })
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner-invalid-fresh-batch",
                abonent_id="1001",
                account_uid="uid_invalid_fresh_batch_1001",
                account_number="1001",
                summary_json=json.dumps({
                    "summary_status": "fresh",
                    "summary_reason": "OK",
                    "status": "fresh",
                    "reason": "OK",
                }, sort_keys=True),
            ))
            app_module.db.session.commit()
        self._login("owner-invalid-fresh-batch")

        index_response = self.client.get("/api/abonents?limit=10")

        self.assertEqual(index_response.status_code, 200)
        index_item = index_response.get_json()["items"][0]
        self.assertEqual(index_item["summary_status"], "error")
        self.assertEqual(index_item["summary"]["summary_status"], "error")
        self.assertEqual(index_item["summary"]["summary_reason"], "FRESH_TOTALS_MISSING")
        self.assertNotIn("totals", index_item["summary"])

        create_response = self.client.post("/api/abonent_summary/recalc_batch_job", json={
            "uids": ["uid_invalid_fresh_batch_1001"],
            "reason": "MANUAL_RECALC",
        })
        self.assertEqual(create_response.status_code, 200)
        job_id = create_response.get_json()["job_id"]

        run_response = self.client.post(f"/api/abonent_summary/recalc_batch_job/{job_id}/run")

        self.assertEqual(run_response.status_code, 200)
        payload = run_response.get_json()
        self.assertEqual(payload["processed"], 1)
        self.assertEqual(payload["fresh"], 0)
        self.assertEqual(payload["error"], 1)
        self.assertEqual(payload["items"][0]["summary_status"], "error")
        self.assertEqual(payload["items"][0]["summary_reason"], "FRESH_TOTALS_MISSING")

    def test_dirty_summary_batch_job_persists_error_result(self):
        with app_module.app.app_context():
            self._add_user("owner-dirty-batch-error")
            self._put_abonents("owner-dirty-batch-error", {
                "1001": {"uid": "uid_dirty_batch_error_1001", "id": "1001"},
            })
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner-dirty-batch-error",
                abonent_id="1001",
                account_uid="uid_dirty_batch_error_1001",
                account_number="1001",
                summary_json=json.dumps({
                    "summary_status": "dirty",
                    "summary_reason": "TARIFFS_CHANGED",
                    "status": "dirty",
                    "reason": "TARIFFS_CHANGED",
                    "totals": {"total": 999},
                }, sort_keys=True),
            ))
            app_module.db.session.commit()
        self._login("owner-dirty-batch-error")

        create_response = self.client.post("/api/abonent_summary/recalc_batch_job", json={
            "uids": ["uid_dirty_batch_error_1001"],
            "reason": "MANUAL_RECALC",
        })
        self.assertEqual(create_response.status_code, 200)
        job_id = create_response.get_json()["job_id"]

        run_response = self.client.post(f"/api/abonent_summary/recalc_batch_job/{job_id}/run")

        self.assertEqual(run_response.status_code, 200)
        payload = run_response.get_json()
        self.assertEqual(payload["status"], "completed")
        self.assertEqual(payload["processed"], 1)
        self.assertEqual(payload["fresh"], 0)
        self.assertEqual(payload["error"], 1)
        self.assertEqual(payload["items"][0]["summary_status"], "error")
        self.assertEqual(payload["items"][0]["summary_reason"], "BATCH_RECALC_NOT_AVAILABLE:TARIFFS_CHANGED")
        self.assertIn("uid_dirty_batch_error_1001", payload["errors_by_uid"])
        with app_module.app.app_context():
            stored = json.loads(app_module.AbonentSummary.query.one().summary_json)
            self.assertEqual(stored["summary_status"], "error")
            self.assertEqual(stored["summary_reason"], "BATCH_RECALC_NOT_AVAILABLE:TARIFFS_CHANGED")
            self.assertNotIn("totals", stored)

    def test_rebuild_rejects_period_summary_payload(self):
        with app_module.app.app_context():
            self._add_user("owner-period-summary-reject")
            self._put_abonents("owner-period-summary-reject", {
                "1001": {"uid": "uid_period_summary_reject_1001", "id": "1001"},
            })
            app_module.db.session.commit()
        self._login("owner-period-summary-reject")

        summary = self._fresh_summary(100, 5, 105)
        summary["summary_scope"] = "period"
        response = self.client.post("/api/abonent_summary/rebuild", json={
            "account_uid": "uid_period_summary_reject_1001",
            "summary": summary,
        })

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "period_summary_not_allowed")
        with app_module.app.app_context():
            self.assertEqual(app_module.AbonentSummary.query.count(), 0)

    def test_rebuild_masks_full_summary_payload_with_report_period(self):
        with app_module.app.app_context():
            self._add_user("owner-full-summary-report-period")
            self._put_abonents("owner-full-summary-report-period", {
                "1001": {
                    "uid": "uid_full_summary_report_period_1001",
                    "id": "1001",
                    "calcStartDate": "2020-01-01",
                    "calcEndDate": "2026-05-22",
                },
            })
            app_module.db.session.commit()
        self._login("owner-full-summary-report-period")

        summary = self._fresh_summary(100, 5, 105)
        summary["summary_scope"] = "full"
        summary["calculation_mode"] = "FULL_SUMMARY_REBUILD"
        summary["period"] = {"from": "2026-01-01", "to": "2026-01-31"}
        response = self.client.post("/api/abonent_summary/rebuild", json={
            "account_uid": "uid_full_summary_report_period_1001",
            "summary": summary,
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["summary_status"], "missing")
        self.assertEqual(response.get_json()["summary_reason"], "PERIOD_SUMMARY_LEGACY")
        with app_module.app.app_context():
            stored = json.loads(app_module.AbonentSummary.query.one().summary_json)
            self.assertEqual(stored["summary_status"], "missing")
            self.assertEqual(stored["summary_reason"], "PERIOD_SUMMARY_LEGACY")
            self.assertNotIn("totals", stored)

    def test_fresh_with_required_totals_stays_fresh_for_index_and_batch_job(self):
        with app_module.app.app_context():
            self._add_user("owner-valid-fresh-batch")
            self._put_abonents("owner-valid-fresh-batch", {
                "1001": {"uid": "uid_valid_fresh_batch_1001", "id": "1001"},
            })
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner-valid-fresh-batch",
                abonent_id="1001",
                account_uid="uid_valid_fresh_batch_1001",
                account_number="1001",
                summary_json=json.dumps(self._fresh_summary(100, 5, 105), sort_keys=True),
            ))
            app_module.db.session.commit()
        self._login("owner-valid-fresh-batch")

        index_response = self.client.get("/api/abonents?limit=10")

        self.assertEqual(index_response.status_code, 200)
        index_item = index_response.get_json()["items"][0]
        self.assertEqual(index_item["summary_status"], "fresh")
        self.assertEqual(index_item["summary"]["summary_status"], "fresh")
        self.assertEqual(index_item["summary"]["totals"]["debt"], 105)
        self.assertEqual(index_item["summary"]["totals"]["penalty"], 5)
        self.assertEqual(index_item["summary"]["totals"]["accrued"], 100)
        self.assertEqual(index_item["summary"]["totals"]["paid"], 0)

        create_response = self.client.post("/api/abonent_summary/recalc_batch_job", json={
            "uids": ["uid_valid_fresh_batch_1001"],
            "reason": "MANUAL_RECALC",
        })
        self.assertEqual(create_response.status_code, 200)
        job_id = create_response.get_json()["job_id"]

        run_response = self.client.post(f"/api/abonent_summary/recalc_batch_job/{job_id}/run")

        self.assertEqual(run_response.status_code, 200)
        payload = run_response.get_json()
        self.assertEqual(payload["processed"], 1)
        self.assertEqual(payload["fresh"], 1)
        self.assertEqual(payload["error"], 0)
        self.assertEqual(payload["items"][0]["summary_status"], "fresh")

    def test_period_summary_is_ignored_by_index_transport(self):
        with app_module.app.app_context():
            self._add_user("owner-period-summary-index")
            self._put_abonents("owner-period-summary-index", {
                "1007": {"uid": "uid_period_summary_index_1007", "id": "1007"},
            })
            period_summary = self._fresh_summary(100, 5, 105)
            period_summary["summary_scope"] = "period"
            period_summary["report_scope"] = "period"
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner-period-summary-index",
                abonent_id="1007",
                account_uid="uid_period_summary_index_1007",
                account_number="1007",
                summary_json=json.dumps(period_summary, sort_keys=True),
            ))
            app_module.db.session.commit()
        self._login("owner-period-summary-index")

        response = self.client.get("/api/abonents?limit=10")

        self.assertEqual(response.status_code, 200)
        item = response.get_json()["items"][0]
        self.assertEqual(item["summary_status"], "missing")
        self.assertEqual(item["summary"]["summary_status"], "missing")
        self.assertEqual(item["summary"]["summary_reason"], "PERIOD_SUMMARY_IGNORED")
        self.assertNotIn("totals", item["summary"])

    def test_legacy_period_summary_contamination_is_masked_on_index_transport(self):
        with app_module.app.app_context():
            self._add_user("owner-legacy-period-mask")
            self._put_abonents("owner-legacy-period-mask", {
                "1007": {
                    "uid": "uid_legacy_period_mask_1007",
                    "id": "1007",
                    "calcStartDate": "2020-01-01",
                    "calcEndDate": "2026-05-22",
                },
            })
            legacy_summary = self._fresh_summary(100, 5, 105)
            legacy_summary["period"] = {"from": "2026-01-01", "to": "2026-01-31"}
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner-legacy-period-mask",
                abonent_id="1007",
                account_uid="uid_legacy_period_mask_1007",
                account_number="1007",
                summary_json=json.dumps(legacy_summary, sort_keys=True),
            ))
            app_module.db.session.commit()
        self._login("owner-legacy-period-mask")

        response = self.client.get("/api/abonents?limit=10")

        self.assertEqual(response.status_code, 200)
        item = response.get_json()["items"][0]
        self.assertEqual(item["summary_status"], "missing")
        self.assertEqual(item["summary"]["summary_status"], "missing")
        self.assertEqual(item["summary"]["summary_reason"], "PERIOD_SUMMARY_LEGACY")
        self.assertNotIn("totals", item["summary"])
        with app_module.app.app_context():
            row = app_module.AbonentSummary.query.filter_by(account_uid="uid_legacy_period_mask_1007").first()
            stored = json.loads(row.summary_json)
            self.assertEqual(stored["summary_status"], "fresh")
            self.assertIn("totals", stored)

        create_response = self.client.post("/api/abonent_summary/recalc_batch_job", json={
            "uids": ["uid_legacy_period_mask_1007"],
            "reason": "MANUAL_RECALC",
        })
        self.assertEqual(create_response.status_code, 200)
        job_id = create_response.get_json()["job_id"]

        run_response = self.client.post(f"/api/abonent_summary/recalc_batch_job/{job_id}/run")

        self.assertEqual(run_response.status_code, 200)
        payload = run_response.get_json()
        self.assertEqual(payload["processed"], 1)
        self.assertEqual(payload["fresh"], 0)
        self.assertEqual(payload["error"], 1)
        self.assertEqual(payload["items"][0]["summary_status"], "error")
        self.assertEqual(payload["items"][0]["summary_reason"], "BATCH_RECALC_NOT_AVAILABLE:PERIOD_SUMMARY_LEGACY")

    def test_legacy_summary_with_canonical_full_period_stays_fresh(self):
        with app_module.app.app_context():
            self._add_user("owner-legacy-period-full")
            self._put_abonents("owner-legacy-period-full", {
                "1007": {
                    "uid": "uid_legacy_period_full_1007",
                    "id": "1007",
                    "calcStartDate": "2020-01-01",
                    "calcEndDate": "2026-05-22",
                },
            })
            summary = self._fresh_summary(100, 5, 105)
            summary["period"] = {"from": "2020-01-01", "to": "2026-05-22"}
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner-legacy-period-full",
                abonent_id="1007",
                account_uid="uid_legacy_period_full_1007",
                account_number="1007",
                summary_json=json.dumps(summary, sort_keys=True),
            ))
            app_module.db.session.commit()
        self._login("owner-legacy-period-full")

        response = self.client.get("/api/abonents?limit=10")

        self.assertEqual(response.status_code, 200)
        item = response.get_json()["items"][0]
        self.assertEqual(item["summary_status"], "fresh")
        self.assertEqual(item["summary"]["summary_status"], "fresh")
        self.assertEqual(item["summary"]["totals"]["debt"], 105)

    def test_legacy_period_summary_with_unknown_boundaries_is_not_masked(self):
        with app_module.app.app_context():
            self._add_user("owner-legacy-period-unknown")
            self._put_abonents("owner-legacy-period-unknown", {
                "1007": {"uid": "uid_legacy_period_unknown_1007", "id": "1007"},
            })
            summary = self._fresh_summary(100, 5, 105)
            summary["period"] = {"from": "2026-01-01", "to": "2026-01-31"}
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner-legacy-period-unknown",
                abonent_id="1007",
                account_uid="uid_legacy_period_unknown_1007",
                account_number="1007",
                summary_json=json.dumps(summary, sort_keys=True),
            ))
            app_module.db.session.commit()
        self._login("owner-legacy-period-unknown")

        response = self.client.get("/api/abonents?limit=10")

        self.assertEqual(response.status_code, 200)
        item = response.get_json()["items"][0]
        self.assertEqual(item["summary_status"], "fresh")
        self.assertEqual(item["summary"]["summary_status"], "fresh")
        self.assertEqual(item["summary"]["totals"]["debt"], 105)

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

    def test_stage_13_4b_calc_period_uses_uid_resolvers_not_legacy_account_keys(self):
        card_path = self._find_repo_file("web", "abonent_card.html")
        payment_path = self._find_repo_file("web", "payment_table.js")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(card_path)
        self.assertIsNotNone(payment_path)
        self.assertIsNotNone(calc_engine_path)
        card_source = card_path.read_text(encoding="utf-8")
        payment_source = payment_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        card_meta_body = card_source.split("function getCalcPeriodStorageMeta()", 1)[1].split("function calcPeriodKey()", 1)[0]
        payment_meta_body = payment_source.split("function calcPeriodStorageMeta()", 1)[1].split("function calcPeriodKey()", 1)[0]
        card_save_body = card_source.split("function saveCalcPeriod(from, to){", 1)[1].split("function setCalcPeriodActive", 1)[0]
        full_recalc_body = payment_source.split("window.fullRecalcForCurrentAbonent", 1)[1].split("window.__loadPaymentTable", 1)[0]

        self.assertIn("Data.resolveCalcPeriodStorageKey(resolverInput)", card_meta_body)
        self.assertIn("Data.resolveCalcPeriodActiveStorageKey(resolverInput)", card_meta_body)
        self.assertIn("Data.resolveCalcPeriodStorageKey(resolverInput)", payment_meta_body)
        self.assertIn("Data.resolveCalcPeriodActiveStorageKey(resolverInput)", payment_meta_body)
        self.assertIn("function __logCalcPeriodCanonicalUsed(payload)", card_source)
        self.assertIn("__logCalcPeriodCanonicalUsed({", card_meta_body)
        self.assertIn("logCalcPeriodOnce", payment_meta_body)
        self.assertIn("source: \"abonent_card\"", card_meta_body)
        self.assertIn('source: "payment_table"', payment_meta_body)
        self.assertIn("requestedId", card_meta_body)
        self.assertIn("resolvedUid", card_meta_body)
        self.assertIn("storageKey", card_meta_body)
        self.assertIn("activeStorageKey", card_meta_body)
        self.assertIn("ownerId", card_meta_body)
        self.assertIn("requestedId", payment_meta_body)
        self.assertIn("resolvedUid", payment_meta_body)
        self.assertIn("storageKey", payment_meta_body)
        self.assertIn("activeStorageKey", payment_meta_body)
        self.assertIn("ownerId", payment_meta_body)
        self.assertIn("storeSet(meta.storageKey", card_save_body)
        self.assertIn("storeSet(meta.activeStorageKey", card_save_body)
        self.assertIn("ensureCurrentAbonentUidForCalcPeriod", card_source)
        self.assertIn('Data.ensureAbonentUid(id, { source: source || "abonent_card.calc_period" })', card_source)
        self.assertNotIn("calc_period_\" +", card_save_body)
        self.assertNotIn("calc_period_active_\" +", card_save_body)
        self.assertNotIn("CALC_PERIOD_CHANGED", card_save_body)
        self.assertNotIn("markAbonentSummaryDirty", card_save_body)
        self.assertNotIn("CALC_PERIOD_CHANGED", full_recalc_body)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_calc_period_changed_is_not_used_by_index_or_batch_recalc(self):
        for parts in (("web", "index.html"), ("web", "data.js")):
            path = self._find_repo_file(*parts)
            self.assertIsNotNone(path)
            source = path.read_text(encoding="utf-8")
            if parts[-1] == "index.html":
                self.assertIn("CALC_PERIOD_CHANGED_VIEW_ONLY_LEGACY", source)
                self.assertNotIn('summaryStatus: "dirty", summaryReason: "CALC_PERIOD_CHANGED"', source)
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
        self.assertIn("Data.recalculateAbonentCard(id, {", body)
        self.assertIn("saveSummary: !explicitReportPeriod", body)
        self.assertIn('summaryScope: explicitReportPeriod ? "period" : "full"', body)
        self.assertIn("periodActive: !!explicitReportPeriod", body)
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
        self.assertIn("saveSummary: false", source)
        self.assertIn('summaryScope: "period"', source)
        self.assertIn("recalcResult.summary", body)
        self.assertIn("manualRecalcErrorMessage", source)
        self.assertIn("Не задан период ответственности/дата начала расчёта", source)
        self.assertIn('renderAbonentSummaryStatus(summaryStatus, __normalizeSummaryStatus(summaryStatus) === "fresh" ? "OK" : summaryReason)', body)
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
        self.assertIn("LEGACY_EMPTY", data_source)
        self.assertIn("LEGACY_LEDGER_EMPTY", data_source)
        self.assertIn("MIXED_CANONICAL_AND_LEGACY", diagnostic_body)
        self.assertIn("UID_MISSING_WITH_LEGACY", diagnostic_body)

        read_body = data_source.split("function readPaymentLedger", 1)[1].split("function _logLedgerInit", 1)[0]
        self.assertIn("[ledger][legacy-readonly-fallback]", data_source)
        self.assertIn("legacyRowsCount", read_body)
        self.assertNotIn("_setProjectRaw", read_body)
        self.assertNotIn("_removeProjectRaw", read_body)

        recalc_body = data_source.split("async function recalculateAbonentCard", 1)[1].split("// ============================================================", 1)[0]
        self.assertIn("[summary][fresh-blocked-legacy-ledger]", data_source)
        self.assertIn("canonicalRaw === null || canonicalRaw === undefined", recalc_body)
        self.assertIn("_safeLedgerInfoForDiagnostic(legacyKey)", recalc_body)
        self.assertIn("legacyInfo.rowsCount > 0", recalc_body)
        self.assertIn("_logFreshBlockedLegacyLedger", recalc_body)

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
        self.assertIn("blockers", helper_body)
        self.assertIn("warnings", helper_body)
        self.assertIn("item.issues", helper_body)
        self.assertIn('state: item ? item.state : "ABONENT_NOT_FOUND"', helper_body)
        self.assertIn('state = "BLOCKED_UID_MISSING_WITH_LEGACY"', data_source)
        self.assertIn('issues.push("UID_MISSING_WITH_LEGACY_LEDGER")', data_source)
        self.assertIn('item.state === "LEGACY_EMPTY"', helper_body)
        self.assertIn('warnings.push("LEGACY_LEDGER_EMPTY")', helper_body)
        self.assertIn('state = "BLOCKED_MIXED_LEDGER"', data_source)
        self.assertIn('issues.push("MIXED_CANONICAL_AND_LEGACY")', data_source)
        self.assertIn("hasResponsibilityStart", data_source)
        self.assertIn("responsibilityFrom", data_source)
        self.assertIn("respFrom", data_source)
        self.assertIn('state = "CANONICAL_EMPTY"', data_source)
        self.assertIn("item.hasCanonical", data_source)
        self.assertIn("item.canonicalRowsCount <= 0", data_source)
        self.assertIn('item.summaryStatus === "fresh"', data_source)
        self.assertIn("whyIndexTotalsEmpty: item ? _whyIndexTotalsEmpty(item, abonent) : \"UNKNOWN\"", helper_body)
        self.assertIn("mixedComparison", helper_body)
        self.assertIn("canonicalRowsCount", data_source)
        self.assertIn("legacyRowsCount", data_source)
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

    def test_stage_13_2c_summary_build_debug_helper_is_read_only(self):
        data_path = self._find_repo_file("web", "data.js")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(data_path)
        self.assertIsNotNone(calc_engine_path)
        data_source = data_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        self.assertIn("window.JKH_debugSummaryBuild = async function(abonentId)", data_source)
        body = data_source.split("window.JKH_debugSummaryBuild = async function(abonentId)", 1)[1].split("async function recalcAbonentSummaryExplicit", 1)[0]
        self.assertIn("calcTotalsAsOfAdjusted", body)
        self.assertIn("preparedSummaryPayload", body)
        self.assertIn("recalculateAbonentCardResult", body)
        self.assertIn("READ_ONLY_DIAGNOSTIC_NOT_EXECUTED", body)
        self.assertIn("apiSummary", body)
        self.assertIn("apiAbonents", body)
        self.assertIn("whyIndexTotalsEmpty", body)
        self.assertIn("SUMMARY_SAVE_FAILED", data_source)
        self.assertIn("SUMMARY_PAYLOAD_INVALID", data_source)
        self.assertIn("TOTALS_BUILD_FAILED", data_source)
        self.assertIn("API_SUMMARY_NOT_RETURNED", data_source)
        self.assertIn("INDEX_MAPPING_MISMATCH", data_source)
        self.assertNotIn("_setProjectRaw", body)
        self.assertNotIn("_removeProjectRaw", body)
        self.assertNotIn("writePaymentLedger", body)
        self.assertNotIn("createEmptyPaymentLedger", body)
        self.assertNotIn("AUTOACCRUAL_WRITE", body)
        self.assertNotIn("markAbonentSummaryDirty", body)
        self.assertNotIn("CALC_PERIOD_CHANGED", body)
        self.assertIn("window.JKH_verifyLedgerMigration = function(options)", data_source)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_stage_13_2ca_totals_validation_debug_helper_is_read_only(self):
        data_path = self._find_repo_file("web", "data.js")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(data_path)
        self.assertIsNotNone(calc_engine_path)
        data_source = data_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        self.assertIn("window.JKH_debugTotalsValidation = async function(abonentId)", data_source)
        body = data_source.split("window.JKH_debugTotalsValidation = async function(abonentId)", 1)[1].split("async function recalcAbonentSummaryExplicit", 1)[0]
        self.assertIn("rawCalcTotalsAsOfAdjusted", body)
        self.assertIn("totalsFields", body)
        self.assertIn("exactValidationBlocker", body)
        self.assertIn("exactReasonSummaryBecameInvalid", body)
        self.assertIn("preparedSummaryPayloadBeforeValidation", body)
        self.assertIn("validationResultAfterValidation", body)
        self.assertIn("missingOrInvalidFields", body)
        self.assertIn("principal", data_source)
        self.assertIn("debt", data_source)
        self.assertIn("penalty", data_source)
        self.assertIn("total", data_source)
        self.assertIn("accrued", data_source)
        self.assertIn("paid", data_source)
        self.assertIn("balance", data_source)
        self.assertIn("TOTALS_NAN", data_source)
        self.assertIn("TOTALS_UNDEFINED", data_source)
        self.assertIn("TOTALS_MISSING_FIELDS", data_source)
        self.assertIn("TOTALS_VALIDATION_FAILED", data_source)
        self.assertIn("PAYLOAD_SCHEMA_MISMATCH", data_source)
        self.assertNotIn("_setProjectRaw", body)
        self.assertNotIn("_removeProjectRaw", body)
        self.assertNotIn("writePaymentLedger", body)
        self.assertNotIn("createEmptyPaymentLedger", body)
        self.assertNotIn("AUTOACCRUAL_WRITE", body)
        self.assertNotIn("markAbonentSummaryDirty", body)
        self.assertNotIn("CALC_PERIOD_CHANGED", body)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_stage_13_2cb_summary_render_guard_debug_is_read_only(self):
        data_path = self._find_repo_file("web", "data.js")
        index_path = self._find_repo_file("web", "index.html")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(data_path)
        self.assertIsNotNone(index_path)
        self.assertIsNotNone(calc_engine_path)
        data_source = data_path.read_text(encoding="utf-8")
        index_source = index_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        self.assertIn("window.JKH_debugSummaryRenderState = async function(abonentId)", data_source)
        self.assertIn("window.JKH_getIndexRenderDebugState = function(abonentIdOrUid)", index_source)
        body = data_source.split("window.JKH_debugSummaryRenderState = async function(abonentId)", 1)[1].split("async function recalcAbonentSummaryExplicit", 1)[0]
        index_body = index_source.split("window.JKH_getIndexRenderDebugState = function(abonentIdOrUid)", 1)[1].split("</script>", 1)[0]
        self.assertIn("preparedSummaryPayload", body)
        self.assertIn("summaryStatusBeforeValidation", body)
        self.assertIn("summaryStatusAfterValidation", body)
        self.assertIn("exactValidationResult", body)
        self.assertIn("exactInvalidFieldList", body)
        self.assertIn("freshnessRuntimeFlags", body)
        self.assertIn("indexRenderAllowDenyReasons", body)
        self.assertIn("whyTotalsHiddenDespiteFiniteTotals", body)
        self.assertIn("exactGuardThatReturnsTotalsEmpty", body)
        self.assertIn("hasSummary", data_source)
        self.assertIn("summary_status === fresh", data_source)
        self.assertIn("totals object exists", data_source)
        self.assertIn("totals finite", data_source)
        self.assertIn("passiveSummaryMode", index_body)
        self.assertIn("pagination", index_body)
        self.assertIn("renderSignatureSkip", index_body)
        for forbidden in ("_setProjectRaw", "_removeProjectRaw", "writePaymentLedger", "createEmptyPaymentLedger", "AUTOACCRUAL_WRITE", "markAbonentSummaryDirty", "CALC_PERIOD_CHANGED"):
            self.assertNotIn(forbidden, body)
            self.assertNotIn(forbidden, index_body)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_stage_13_2cc_summary_totals_mapping_uses_nested_canonical_totals(self):
        data_path = self._find_repo_file("web", "data.js")
        index_path = self._find_repo_file("web", "index.html")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(data_path)
        self.assertIsNotNone(index_path)
        self.assertIsNotNone(calc_engine_path)
        data_source = data_path.read_text(encoding="utf-8")
        index_source = index_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        summary_body = data_source.split("function buildAbonentSummaryAfterExplicitRecalc", 1)[1].split("function buildAbonentSummaryErrorAfterExplicitRecalc", 1)[0]
        self.assertIn("totals: {", summary_body)
        self.assertIn("principal: principal", summary_body)
        self.assertIn("debt: total", summary_body)
        self.assertIn("penalty: penalty", summary_body)
        self.assertIn("total: total", summary_body)
        self.assertIn("accrued: periodTotals.total_accrued", summary_body)
        self.assertIn("paid: periodTotals.total_paid", summary_body)
        self.assertIn("balance: total", summary_body)
        self.assertIn("total_debt: total", summary_body)
        self.assertIn("total_penalty: penalty", summary_body)

        totals_keys_body = index_source.split("const INDEX_SUMMARY_TOTAL_KEYS = {", 1)[1].split("};", 1)[0]
        index_body = index_source.split("function buildIndexRowFromSummaryItem", 1)[1].split("function renderIndexSummaryLoading", 1)[0]
        self.assertIn("function pickSummaryValueWithSource(summary, keys)", index_source)
        self.assertIn("INDEX_SUMMARY_TOTAL_KEYS", index_source)
        self.assertIn('debt: ["totals.debt"', totals_keys_body)
        self.assertIn('"total_debt"', totals_keys_body)
        self.assertIn('penalty: ["totals.penalty"', totals_keys_body)
        self.assertIn('"total_penalty"', totals_keys_body)
        self.assertIn('accrued: ["totals.accrued"', totals_keys_body)
        self.assertIn('"total_accrued"', totals_keys_body)
        self.assertIn('paid: ["totals.paid"', totals_keys_body)
        self.assertIn('"total_paid"', totals_keys_body)
        self.assertIn("pickSummaryValueWithSource(summary, INDEX_SUMMARY_TOTAL_KEYS.debt)", index_body)
        self.assertIn("pickSummaryValueWithSource(summary, INDEX_SUMMARY_TOTAL_KEYS.penalty)", index_body)
        self.assertIn("pickSummaryValueWithSource(summary, INDEX_SUMMARY_TOTAL_KEYS.accrued)", index_body)
        self.assertIn("pickSummaryValueWithSource(summary, INDEX_SUMMARY_TOTAL_KEYS.paid)", index_body)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_stage_13_4_card_summary_pipeline_contract(self):
        data_path = self._find_repo_file("web", "data.js")
        card_path = self._find_repo_file("web", "abonent_card.html")
        index_path = self._find_repo_file("web", "index.html")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(data_path)
        self.assertIsNotNone(card_path)
        self.assertIsNotNone(index_path)
        self.assertIsNotNone(calc_engine_path)
        data_source = data_path.read_text(encoding="utf-8")
        card_source = card_path.read_text(encoding="utf-8")
        index_source = index_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        summary_body = data_source.split("function buildAbonentSummaryAfterExplicitRecalc", 1)[1].split("function buildAbonentSummaryErrorAfterExplicitRecalc", 1)[0]
        save_body = data_source.split("async function saveAbonentSummaryAfterRecalc", 1)[1].split("async function validateAbonentSummaryRecalcBatch", 1)[0]
        card_recalc_body = card_source.split("function bindCalcButtons", 1)[1].split("resetBtn.addEventListener", 1)[0]

        self.assertIn("totals: {", summary_body)
        self.assertIn("debt: total", summary_body)
        self.assertIn("penalty: penalty", summary_body)
        self.assertIn("accrued: periodTotals.total_accrued", summary_body)
        self.assertIn("paid: periodTotals.total_paid", summary_body)
        self.assertIn("[summary][build-payload]", save_body)
        self.assertIn("[summary][save-ok]", save_body)
        self.assertIn("[summary][save-failed]", save_body)
        self.assertIn("[summary][skip-save-period-summary]", save_body)
        self.assertIn('summaryScope === "period" || summaryScope === "report"', save_body)
        self.assertIn("totalsKeys", save_body)
        self.assertIn("Расчёт выполнен, но итоговый summary для главной страницы не сохранён", card_recalc_body)
        self.assertIn("summaryBatchRunBtn", index_source)
        self.assertIn("Data.createAbonentSummaryRecalcBatchJob", index_source)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_stage_13_4b_period_summary_is_not_saved_as_index_summary(self):
        data_path = self._find_repo_file("web", "data.js")
        payment_path = self._find_repo_file("web", "payment_table.js")
        index_path = self._find_repo_file("web", "index.html")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(data_path)
        self.assertIsNotNone(payment_path)
        self.assertIsNotNone(index_path)
        self.assertIsNotNone(calc_engine_path)
        data_source = data_path.read_text(encoding="utf-8")
        payment_source = payment_path.read_text(encoding="utf-8")
        index_source = index_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        recalc_body = data_source.split("async function recalcAbonentSummaryExplicit", 1)[1].split("async function recalculateAbonentCard", 1)[0]
        full_recalc_body = payment_source.split("window.fullRecalcForCurrentAbonent", 1)[1].split("window.__loadPaymentTable", 1)[0]

        self.assertIn("[summary][skip-save-period-summary]", recalc_body)
        self.assertIn("[summary][save-full-summary]", recalc_body)
        save_body = data_source.split("async function saveAbonentSummaryAfterRecalc", 1)[1].split("async function validateAbonentSummaryRecalcBatch", 1)[0]
        self.assertIn("[summary][skip-save-period-summary]", save_body)
        self.assertIn("var summaryPayload =", save_body)
        self.assertIn("summaryPayload.summary_scope || summaryPayload.report_scope || summaryPayload.scope", save_body)
        self.assertIn("summary: summaryPayload", save_body)
        self.assertIn('summary.summary_scope = "period"', recalc_body)
        self.assertIn('summary.summary_scope = "full"', recalc_body)
        self.assertIn('mode === SUMMARY_RECALC_MODE_REPORT', recalc_body)
        self.assertIn("saveSummary: !explicitReportPeriod", full_recalc_body)
        self.assertIn('summaryScope: explicitReportPeriod ? "period" : "full"', full_recalc_body)
        self.assertIn("periodActive: !!explicitReportPeriod", full_recalc_body)
        self.assertIn("FRESH_TOTALS_MISSING", index_source)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_stage_13_5_full_summary_uses_canonical_period_not_report_period(self):
        data_path = self._find_repo_file("web", "data.js")
        backend_path = self._find_repo_file("backend", "app.py")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(data_path)
        self.assertIsNotNone(backend_path)
        self.assertIsNotNone(calc_engine_path)
        data_source = data_path.read_text(encoding="utf-8")
        backend_source = backend_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        resolver_body = data_source.split("async function _resolveAbonentSummaryRecalcPeriod", 1)[1].split("function resolveAbonentRegnumForSummary", 1)[0]
        recalc_body = data_source.split("async function recalcAbonentSummaryExplicit", 1)[1].split("async function recalculateAbonentCard", 1)[0]
        save_body = backend_source.split("@app.post(\"/api/abonent_summary/rebuild\")", 1)[1].split("@app.post(\"/api/auth/register\")", 1)[0]

        self.assertIn("FULL_SUMMARY_REBUILD", data_source)
        self.assertIn("REPORT_PERIOD_CALCULATION", data_source)
        self.assertIn("mode === SUMMARY_RECALC_MODE_REPORT && explicitPeriod", resolver_body)
        self.assertIn("mode === SUMMARY_RECALC_MODE_FULL", resolver_body)
        self.assertIn("RESPONSIBILITY_DATE_MISSING", resolver_body)
        self.assertIn("source = \"canonical_full_period\"", resolver_body)
        self.assertIn('summary.calculation_mode = SUMMARY_RECALC_MODE_FULL', recalc_body)
        self.assertIn('summary.calculation_mode = SUMMARY_RECALC_MODE_REPORT', recalc_body)
        self.assertNotIn("await _readCurrentAbonentSummaryPeriod", resolver_body.split("if (mode === SUMMARY_RECALC_MODE_FULL)", 1)[0])
        self.assertIn("_summary_without_stale_totals(summary, target, owner)", save_body)
        self.assertIn("targets_by_uid", backend_source)
        self.assertIn("_summary_from_row_or_missing(row, target)", backend_source)
        self.assertIn("PERIOD_SUMMARY_LEGACY", backend_source)
        self.assertIn('if (msg.indexOf("RATES_JSON_INVALID") >= 0) return "RATES_JSON_INVALID";', data_source)
        self.assertIn('if (msg.indexOf("EXCLUDES_JSON_INVALID") >= 0) return "EXCLUDES_JSON_INVALID";', data_source)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_stage_13_4c_canonical_active_calc_period_key_is_not_legacy(self):
        card_path = self._find_repo_file("web", "abonent_card.html")
        payment_path = self._find_repo_file("web", "payment_table.js")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(card_path)
        self.assertIsNotNone(payment_path)
        self.assertIsNotNone(calc_engine_path)
        card_source = card_path.read_text(encoding="utf-8")
        payment_source = payment_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        self.assertNotIn("calc_period_(active_)?(?!uid_)", card_source)
        self.assertNotIn("calc_period_(active_)?(?!uid_)", payment_source)
        for source in (card_source, payment_source):
            self.assertIn("calc_period_active_(?!uid_)", source)
            self.assertIn("calc_period_(?!uid_|active_uid_)", source)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_stage_13_4e_reports_button_does_not_run_card_recalc(self):
        card_path = self._find_repo_file("web", "abonent_card.html")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(card_path)
        self.assertIsNotNone(calc_engine_path)
        card_source = card_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        reports_body = card_source.split('repBtn.addEventListener("click"', 1)[1].split("});\n}", 1)[0]
        self.assertIn("[reports][open-with-period]", reports_body)
        self.assertIn("getCalcPeriodStorageMeta()", reports_body)
        self.assertIn("getReportPeriodStorageKey(readonlyMeta)", reports_body)
        self.assertIn('reason: "URL_ONLY"', reports_body)
        self.assertIn("location.href = href", reports_body)
        self.assertIn("[reports][blocked-card-recalc]", card_source)
        self.assertNotIn("ensureCurrentAbonentUidForCalcPeriod", reports_body)
        self.assertNotIn("saveCalcPeriod(from, to)", reports_body)
        self.assertNotIn("saveReportPeriodForSpravka", reports_body)
        self.assertNotIn("fullRecalcForCurrentAbonent", reports_body)
        self.assertNotIn("Data.recalculateAbonentCard", reports_body)
        self.assertNotIn("saveAbonentSummaryAfterRecalc", reports_body)
        self.assertNotIn("/api/abonent_summary/rebuild", reports_body)
        self.assertNotIn("applyAutoAccrual", reports_body)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_stage_13_4g_calc_period_reset_persists_canonical_empty_state(self):
        card_path = self._find_repo_file("web", "abonent_card.html")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(card_path)
        self.assertIsNotNone(calc_engine_path)
        card_source = card_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        meta_body = card_source.split("function getCalcPeriodStorageMeta()", 1)[1].split("function calcPeriodKey()", 1)[0]
        reset_helper = card_source.split("function resetCalcPeriodCanonicalState", 1)[1].split("function bootstrapActiveCalcPeriod", 1)[0]
        reset_handler = card_source.split('resetBtn.addEventListener("click"', 1)[1].split('repBtn.addEventListener("click"', 1)[0]
        self.assertIn("Data.resolveCalcPeriodStorageKey(resolverInput)", meta_body)
        self.assertIn("Data.resolveCalcPeriodActiveStorageKey(resolverInput)", meta_body)
        self.assertIn("[calc-period][reset-start]", reset_helper)
        self.assertIn("[calc-period][reset-saved]", reset_helper)
        self.assertIn("[calc-period][reset-readback-ok]", reset_helper)
        self.assertIn("[calc-period][reset-readback-failed]", reset_helper)
        self.assertIn("storeRemove(m.storageKey", reset_helper)
        self.assertIn('storeSet(m.activeStorageKey, "0"', reset_helper)
        self.assertIn("storeRemove(reportKey", reset_helper)
        self.assertIn("__isCalcPeriodInactiveReadback(result.activeReadback.raw)", reset_helper)
        self.assertIn("await resetCalcPeriodCanonicalState(meta", reset_handler)
        self.assertIn("Период не сброшен на сервере/в хранилище", reset_handler)
        self.assertNotIn("markCurrentAbonentSummaryDirty", reset_handler)
        self.assertNotIn("CALC_PERIOD_CHANGED", reset_handler)
        self.assertNotIn("saveAbonentSummaryAfterRecalc", reset_handler)
        self.assertNotIn("fullRecalcForCurrentAbonent", reset_handler)
        self.assertNotIn("calc_period_\" +", reset_handler)
        self.assertNotIn("calc_period_active_\" +", reset_handler)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_stage_13_4h_period_reset_uses_server_delete_contract(self):
        data_path = self._find_repo_file("web", "data.js")
        card_path = self._find_repo_file("web", "abonent_card.html")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(data_path)
        self.assertIsNotNone(card_path)
        self.assertIsNotNone(calc_engine_path)
        data_source = data_path.read_text(encoding="utf-8")
        card_source = card_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        helper_body = data_source.split("async function resetCalcPeriodKeysForAbonent", 1)[1].split("function resolvePaymentLedgerKey", 1)[0]
        delete_body = data_source.split("async function _serverStoreDelete", 1)[1].split("async function _serverStoreSet", 1)[0]
        reset_handler = card_source.split('resetBtn.addEventListener("click"', 1)[1].split('repBtn.addEventListener("click"', 1)[0]
        self.assertIn("resetCalcPeriodKeysForAbonent: resetCalcPeriodKeysForAbonent", data_source)
        self.assertIn('method: "DELETE"', delete_body)
        self.assertIn("_serverStoreDelete(ownerId, keys.calcKey)", helper_body)
        self.assertIn("_serverStoreDelete(ownerId, keys.reportKey)", helper_body)
        self.assertIn('_serverStoreSet(ownerId, keys.activeKey, "0")', helper_body)
        self.assertIn("_serverStoreDelete(ownerId, keys.legacyCalcKey)", helper_body)
        self.assertIn("_serverStoreDelete(ownerId, keys.legacyReportKey)", helper_body)
        self.assertNotIn("value: null", helper_body)
        self.assertNotIn('_setRawScoped(keys.legacyCalcKey', helper_body)
        self.assertNotIn('_setRawScoped(keys.legacyReportKey', helper_body)
        self.assertIn("Data.resetCalcPeriodKeysForAbonent", card_source)
        self.assertIn("window.JKH_debugCalcPeriodKeys", card_source)
        self.assertIn("[period][server-reset-readback-ok]", helper_body)
        self.assertIn("[period][server-reset-readback-failed]", helper_body)
        self.assertIn("[period][restore-source]", card_source)
        self.assertIn("key:", card_source)
        self.assertIn("raw:", card_source)
        load_body = card_source.split("function loadCalcPeriodUI()", 1)[1].split("function saveCalcPeriod", 1)[0]
        self.assertNotIn("summary.period", load_body)
        self.assertNotIn("markCurrentAbonentSummaryDirty", reset_handler)
        self.assertNotIn("CALC_PERIOD_CHANGED", reset_handler)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_stage_13_2cd_index_totals_dom_mapping_uses_rendered_values(self):
        index_path = self._find_repo_file("web", "index.html")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(index_path)
        self.assertIsNotNone(calc_engine_path)
        source = index_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        build_body = source.split("function buildIndexRowFromSummaryItem", 1)[1].split("function renderIndexSummaryLoading", 1)[0]
        render_body = source.split("function render() {", 1)[1].split("tbody.onclick", 1)[0]
        self.assertIn("function pickSummaryValueWithSource", source)
        self.assertIn("__totalsRenderDebug", build_body)
        self.assertIn("renderedValues", build_body)
        self.assertIn("totalsSource", build_body)
        self.assertIn("totalsObject", build_body)
        self.assertIn("[index][totals-render]", render_body)
        self.assertIn('data-field="debt"', render_body)
        self.assertIn('data-field="penalty"', render_body)
        self.assertIn('data-field="accrued"', render_body)
        self.assertIn('data-field="paid"', render_body)
        self.assertIn("INDEX_SUMMARY_TOTAL_KEYS", source)
        self.assertIn("pickSummaryValueWithSource(summary, INDEX_SUMMARY_TOTAL_KEYS.debt)", build_body)
        self.assertIn("pickSummaryValueWithSource(summary, INDEX_SUMMARY_TOTAL_KEYS.penalty)", build_body)
        self.assertIn("pickSummaryValueWithSource(summary, INDEX_SUMMARY_TOTAL_KEYS.accrued)", build_body)
        self.assertIn("pickSummaryValueWithSource(summary, INDEX_SUMMARY_TOTAL_KEYS.paid)", build_body)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_stage_13_2ce_index_totals_cell_targeting_uses_data_fields(self):
        index_path = self._find_repo_file("web", "index.html")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(index_path)
        self.assertIsNotNone(calc_engine_path)
        source = index_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        render_body = source.split("function render() {", 1)[1].split("tbody.onclick", 1)[0]
        helper_body = source.split("function writeIndexTotalsCell", 1)[1].split("function renderIndexSummaryLoading", 1)[0]
        self.assertIn("function writeIndexTotalsCell", source)
        self.assertIn('querySelector(\'td[data-field="\' + field + \'"]\')', helper_body)
        self.assertIn("[index][totals-dom-write]", helper_body)
        self.assertIn('data-field="debt"', render_body)
        self.assertIn('data-field="penalty"', render_body)
        self.assertIn('data-field="accrued"', render_body)
        self.assertIn('data-field="paid"', render_body)
        self.assertIn('writeIndexTotalsCell(tr, r.accountUid, "debt", r.totalDebt)', render_body)
        self.assertIn('writeIndexTotalsCell(tr, r.accountUid, "penalty", r.penalty)', render_body)
        self.assertIn('writeIndexTotalsCell(tr, r.accountUid, "accrued", r.nachisleno)', render_body)
        self.assertIn('writeIndexTotalsCell(tr, r.accountUid, "paid", r.oplacheno)', render_body)
        self.assertNotIn("cells[5]", source)
        self.assertNotIn("cells[6]", source)
        self.assertNotIn("cells[7]", source)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_stage_13_3_index_invalid_fresh_totals_are_not_rendered_as_fresh(self):
        index_path = self._find_repo_file("web", "index.html")
        data_path = self._find_repo_file("web", "data.js")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(index_path)
        self.assertIsNotNone(data_path)
        self.assertIsNotNone(calc_engine_path)
        index_source = index_path.read_text(encoding="utf-8")
        data_source = data_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        build_body = index_source.split("function buildIndexRowFromSummaryItem", 1)[1].split("function writeIndexTotalsCell", 1)[0]
        debug_body = index_source.split("window.JKH_debugIndexSummaryRows = function()", 1)[1].split("window.JKH_getIndexRenderDebugState", 1)[0]
        render_body = index_source.split("function render() {", 1)[1].split("tbody.onclick", 1)[0]
        self.assertIn("function validateIndexSummaryTotals", index_source)
        self.assertIn("INDEX_SUMMARY_TOTAL_KEYS", index_source)
        self.assertIn("FRESH_TOTALS_MISSING", index_source)
        self.assertIn("FRESH_TOTALS_INVALID", index_source)
        self.assertIn('const isFresh = status === "fresh" && totalsValidation.validFreshTotals', build_body)
        self.assertIn("displayStatus", build_body)
        self.assertIn("rawSummaryStatus", build_body)
        self.assertIn("hasTotalsObject", build_body)
        self.assertIn("totalsFinite", build_body)
        self.assertIn("whyEmptyTotals", build_body)
        self.assertIn("exactGuard", build_body)
        self.assertIn("[index][summary-row-empty]", render_body)
        self.assertIn("[index][summary-row-invalid-fresh]", render_body)
        self.assertIn("window.JKH_debugIndexSummaryRows = function()", index_source)
        for required in ("account", "uid", "summary_status", "summary_reason", "hasTotalsObject", "totalsFinite", "renderedValues", "whyEmptyTotals", "exactGuard"):
            self.assertIn(required, debug_body)

        dirty_body = data_source.split("async function markAbonentSummaryDirty", 1)[1].split("function markAbonentSummaryDirtyLater", 1)[0]
        self.assertIn('reasonCode === "CALC_PERIOD_CHANGED"', dirty_body)
        self.assertIn("view_only_reason", dirty_body)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_card_snapshot_open_lifecycle_does_not_auto_recalc_contract(self):
        card_path = self._find_repo_file("web", "abonent_card.html")
        data_path = self._find_repo_file("web", "data.js")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(card_path)
        self.assertIsNotNone(data_path)
        self.assertIsNotNone(calc_engine_path)
        card_source = card_path.read_text(encoding="utf-8")
        data_source = data_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        self.assertIn("window.__JKH_CARD_AUTO_RECALC", card_source)
        self.assertIn("function __requestCardAutoRecalc", card_source)
        self.assertIn("function __maybeStartCardAutoRecalc", card_source)
        self.assertIn("function __skipCardAutoRecalcFreshSnapshot", card_source)
        self.assertIn("function __renderAbonentTotalsFromSummary", card_source)
        self.assertIn("function __summaryFromCardSnapshot", card_source)
        self.assertIn("async function __tryUseBackendFreshSnapshot", card_source)
        self.assertIn("function __renderFreshCardSnapshot", card_source)
        self.assertIn("[abonent_card][auto-recalc]", card_source)
        self.assertIn("[abonent_card][backend-snapshot]", card_source)
        self.assertIn('"skipped fresh snapshot"', card_source)
        self.assertIn('"already in flight"', card_source)
        self.assertIn('"blocked passive cache"', card_source)
        self.assertIn('"done"', card_source)
        self.assertIn('"error"', card_source)
        self.assertIn('__maybeStartCardAutoRecalc("payment-table-loaded:" + String(reason || ""))', card_source)
        self.assertIn("card_auto_recalc_disabled_passive_cache", card_source)
        self.assertNotIn('renderAbonentSummaryStatus(state.requestedStatus || "dirty", "Требуется пересчёт. Запускаю пересчёт карточки...")', card_source)

        status_body = card_source.split("async function loadAbonentSummaryStatus()", 1)[1].split("function __summaryCalcErrorCode", 1)[0]
        self.assertNotIn("__requestCardAutoRecalc(", status_body)
        self.assertIn('if (await __tryUseBackendFreshSnapshot(uid, "CARD_OPEN_BACKEND_FIRST")) return;', status_body)
        self.assertLess(status_body.index('__tryUseBackendFreshSnapshot(uid, "CARD_OPEN_BACKEND_FIRST")'), status_body.index("Data.readCardSnapshot(uid)"))
        self.assertIn('__resetCardAutoRecalcForUid(uid)', status_body)
        self.assertIn('renderAbonentSummaryStatus("missing", "Нет сохранённого расчёта. Нажмите «Пересчитать»")', status_body)
        self.assertIn('renderAbonentSummaryStatus("missing", "Серверный snapshot недоступен. Локальный cache не является источником актуальности.")', status_body)
        self.assertIn("__renderAbonentTotalsFromSummary(cachedSummary)", status_body)
        self.assertIn("__renderAbonentTotalsFromSummary(invalidSummary)", status_body)
        self.assertIn('__renderFreshCardSnapshot(uid, snapshot, "local_card_snapshot_passive_fallback")', status_body)
        fresh_render_body = card_source.split("function __renderFreshCardSnapshot", 1)[1].split("async function __tryUseBackendFreshSnapshot", 1)[0]
        self.assertIn("__skipCardAutoRecalcFreshSnapshot(uid)", fresh_render_body)

        invalid_event_body = card_source.split('window.addEventListener("jkh:card-snapshot-invalid"', 1)[1].split("function __baseStorageKeyForCurrentOwner", 1)[0]
        self.assertNotIn("__requestCardAutoRecalc(", invalid_event_body)
        self.assertIn("__resetCardAutoRecalcForUid(uid)", invalid_event_body)
        self.assertNotIn('renderAbonentSummaryStatus("dirty"', invalid_event_body)
        runtime_invalid_body = card_source.split('window.addEventListener("jkh:runtime-cache-invalid"', 1)[1].split('window.addEventListener("jkh:runtime-cache-valid"', 1)[0]
        self.assertNotIn('renderAbonentSummaryStatus("dirty"', runtime_invalid_body)
        storage_recheck_body = card_source.split('window.addEventListener("storage"', 1)[1].split("function __isFreshCardSnapshotUsable", 1)[0]
        self.assertNotIn('new CustomEvent("jkh:card-snapshot-invalid"', storage_recheck_body)
        self.assertIn("card_local_snapshot_invalid_passive", card_source)

        auto_recalc_body = card_source.split("async function __maybeStartCardAutoRecalc", 1)[1].split("function __logFullRecalcEventIgnored", 1)[0]
        self.assertIn('if (await __tryUseBackendFreshSnapshot(uid, state.lastReason || "AUTO_RECALC_GATE"))', auto_recalc_body)
        self.assertNotIn("runBtn.click()", auto_recalc_body)
        self.assertIn("card_auto_recalc_disabled_passive_cache", auto_recalc_body)

        self.assertIn("async function readFreshBackendCardSnapshotForCard", data_source)
        self.assertIn("_validateFreshCardSnapshotForCurrentInputs", data_source)
        self.assertIn("validateLocalInputs: false", card_source)
        self.assertIn("localInputValidationSkipped", data_source)
        self.assertIn("readFreshBackendCardSnapshotForCard: readFreshBackendCardSnapshotForCard", data_source)
        for reason in (
            "card_backend_snapshot_used",
            "card_backend_snapshot_hydrated_local",
            "card_auto_recalc_backend_snapshot_missing",
            "card_auto_recalc_backend_snapshot_incompatible",
        ):
            self.assertIn(reason, card_source + data_source)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_card_auto_recalc_persists_snapshot_before_fresh_final_contract(self):
        card_path = self._find_repo_file("web", "abonent_card.html")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(card_path)
        self.assertIsNotNone(calc_engine_path)
        card_source = card_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        self.assertIn("async function savePostRecalcSnapshot(snapshot)", card_source)
        self.assertNotIn("function schedulePostRecalcSnapshotSave", card_source)
        self.assertNotIn("save-card-snapshot-async", card_source)
        self.assertIn("Data.saveCardSnapshotAndWait(currentAbonentId, snapshot, { runId: recalcRunId })", card_source)

        success_body = card_source.split('if (__normalizeSummaryStatus(summaryStatus) === "fresh") {', 1)[1].split('if (finishFullRecalcAbortFromUi("abort-before-final-render")) return;', 1)[0]
        self.assertIn("const snapshotSave = await savePostRecalcSnapshot(snapshot);", success_body)
        self.assertIn("snapshotSave.ok !== true", success_body)
        self.assertIn('renderAbonentSummaryStatus("error", snapshotReason)', success_body)
        self.assertIn("__skipCardAutoRecalcFreshSnapshot(fullRecalcState.uid || currentAbonentId)", success_body)

        save_post_body = card_source.split("async function savePostRecalcSnapshot(snapshot)", 1)[1].split("async function ensureCurrentAbonentUidForCalcPeriod", 1)[0]
        self.assertIn("snapshotSaveResult.ok === true", save_post_body)
        self.assertIn("snapshotSaveResult.backendSnapshotOk === true", save_post_body)
        self.assertIn("snapshotSaveResult.backendReadbackOk === true", save_post_body)
        self.assertNotIn("snapshotSaveResult.localOk === true && snapshotSaveResult.serverOk === true", save_post_body)
        self.assertIn("card_snapshot_backend_save_succeeded_local_cache_failed", save_post_body)

        final_render_idx = card_source.index('renderExplicitFullRecalcFinal("recalc-success")')
        snapshot_save_idx = card_source.index("const snapshotSave = await savePostRecalcSnapshot(snapshot);")
        self.assertLess(snapshot_save_idx, final_render_idx)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_card_snapshot_save_continues_backend_after_local_cache_failure_contract(self):
        data_path = self._find_repo_file("web", "data.js")
        card_path = self._find_repo_file("web", "abonent_card.html")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(data_path)
        self.assertIsNotNone(card_path)
        self.assertIsNotNone(calc_engine_path)
        data_source = data_path.read_text(encoding="utf-8")
        card_source = card_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        self.assertIn("function _setProjectRawDetailed(key, value)", data_source)
        save_body = data_source.split("async function saveCardSnapshotAndWait", 1)[1].split("async function debugCardSnapshotLifecycle", 1)[0]
        self.assertIn("localCacheOk", save_body)
        self.assertIn("localCacheReason", save_body)
        self.assertIn("localCacheError", save_body)
        self.assertIn("backendKvOk", save_body)
        self.assertIn("backendSnapshotOk", save_body)
        self.assertIn("backendReadbackOk", save_body)
        self.assertIn('result.warning = "LOCAL_CACHE_SAVE_FAILED"', save_body)
        self.assertIn("card_snapshot_local_cache_save_failed", save_body)
        self.assertIn("card_snapshot_backend_save_continued", save_body)
        self.assertIn("card_snapshot_backend_save_succeeded_local_cache_failed", save_body)
        self.assertIn("card_snapshot_backend_save_failed", save_body)
        self.assertIn("card_snapshot_backend_readback_failed", save_body)
        self.assertNotIn('result.reason = "LOCAL_SAVE_FAILED"', save_body)

        local_failure_idx = save_body.index('result.warning = "LOCAL_CACHE_SAVE_FAILED"')
        kv_save_idx = save_body.index("var serverResult = await _serverStoreSet(ownerId, key, serialized)")
        canonical_save_idx = save_body.index("saveCardSnapshotToBackend(abonentOrId, normalized)")
        readback_idx = save_body.index("var readback = await _serverStoreGet(ownerId, key)")
        self.assertLess(local_failure_idx, kv_save_idx)
        self.assertLess(kv_save_idx, canonical_save_idx)
        self.assertLess(canonical_save_idx, readback_idx)

        card_save_body = card_source.split("async function savePostRecalcSnapshot(snapshot)", 1)[1].split("async function ensureCurrentAbonentUidForCalcPeriod", 1)[0]
        self.assertIn("snapshotSaveResult.ok === true", card_save_body)
        self.assertIn("snapshotSaveResult.backendSnapshotOk === true", card_save_body)
        self.assertIn("snapshotSaveResult.backendReadbackOk === true", card_save_body)
        self.assertNotIn("snapshotSaveResult.localCacheOk === true", card_save_body.split("const saveOk =", 1)[1].split(";", 1)[0])

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_manual_card_recalc_zero_overwrite_block_is_nonfatal_contract(self):
        payment_path = self._find_repo_file("web", "payment_table.js")
        index_path = self._find_repo_file("web", "index.html")
        backend_path = self._find_repo_file("backend", "app.py")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(payment_path)
        self.assertIsNotNone(index_path)
        self.assertIsNotNone(backend_path)
        self.assertIsNotNone(calc_engine_path)
        payment_source = payment_path.read_text(encoding="utf-8")
        index_source = index_path.read_text(encoding="utf-8")
        backend_source = backend_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        auto_body = payment_source.split("async function applyControlledAutoAccrualForManualRecalc", 1)[1].split("window.fullRecalcForCurrentAbonent", 1)[0]
        self.assertIn('block.reason === "ZERO_ACCRUAL_OVERWRITE_BLOCKED"', auto_body)
        self.assertIn('"[full-recalc][autoaccrual-write-skipped]"', auto_body)
        self.assertIn("result.changed = false", auto_body)
        self.assertIn("Data.writePaymentLedgerServerBacked", auto_body)
        self.assertIn('reason:"SERVER_PERSIST_REQUIRED"', auto_body)
        self.assertIn('reason:"LOCAL_CACHE_WRITE_FAILED"', auto_body)
        self.assertIn('return { ok:false, changed:true, reason:"PAYMENT_LEDGER_WRITE_BLOCKED"', auto_body)
        self.assertIn("writePaymentLedgerServerBacked: writePaymentLedgerServerBacked", self._find_repo_file("web", "data.js").read_text(encoding="utf-8"))

        index_status_body = index_source.split("function summaryBatchResultStatus", 1)[1].split("function summaryBatchResultReason", 1)[0]
        self.assertIn("rowsByIdCount > 0", index_status_body)
        batch_body = index_source.split("async function runSelectedSummaryBatch", 1)[1].split("function renderSummaryBatchError", 1)[0]
        self.assertIn("Data.recalculateAbonentCardWithRows(uid", batch_body)
        self.assertNotIn("Data.recalculateAbonentCard(uid", batch_body)
        self.assertIn("Data.saveCardSnapshotAndWait(uid, snapshot)", batch_body)
        self.assertIn('if (status === "fresh")', batch_body)
        self.assertIn("completePayload = await Data.completeRecalcUid(jobId, itemId, status, summary, reason)", batch_body)

        self.assertIn("def _client_recalc_fresh_guard", backend_source)
        self.assertIn('return False, "CARD_SNAPSHOT_MISSING"', backend_source)
        self.assertIn('return False, "CARD_SNAPSHOT_ROWS_MISSING"', backend_source)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_manual_card_recalc_rates_fatal_preserves_payment_rows_contract(self):
        payment_path = self._find_repo_file("web", "payment_table.js")
        card_path = self._find_repo_file("web", "abonent_card.html")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(payment_path)
        self.assertIsNotNone(card_path)
        self.assertIsNotNone(calc_engine_path)
        payment_source = payment_path.read_text(encoding="utf-8")
        card_source = card_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        self.assertIn("RATES_FATAL_LEDGER_VISIBLE_MESSAGE", payment_source)
        render_rates_body = payment_source.split("function renderRatesFatal(tbody)", 1)[1].split("// ===========================", 1)[0]
        self.assertIn('tbody.querySelector("tr[data-row-id]")', render_rates_body)
        self.assertIn("[payment-table][rates-fatal-rows-preserved]", render_rates_body)
        self.assertIn("Строки ledger недоступны", render_rates_body)

        self.assertIn("function __isRatesSummaryReason(reason)", card_source)
        self.assertIn("function __ratesFatalLedgerVisibleMessage()", card_source)
        error_body = card_source.split('rememberExplicitFullRecalcFinal("error", reason, recalcResult);', 1)[1].split('alert(manualRecalcErrorMessage(recalcResult, reason));', 1)[0]
        self.assertIn('renderAbonentSummaryStatus("error", reason);', error_body)
        self.assertIn('__safeLoadPaymentTableOnce("manual-full-recalc-rates-error")', error_body)
        self.assertNotIn("savePostRecalcSnapshot", error_body)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_manual_card_recalc_rates_missing_diagnostics_contract(self):
        data_path = self._find_repo_file("web", "data.js")
        payment_path = self._find_repo_file("web", "payment_table.js")
        storage_path = self._find_repo_file("web", "storage.js")
        refinancing_path = self._find_repo_file("web", "refinancing.html")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(data_path)
        self.assertIsNotNone(payment_path)
        self.assertIsNotNone(storage_path)
        self.assertIsNotNone(refinancing_path)
        self.assertIsNotNone(calc_engine_path)
        data_source = data_path.read_text(encoding="utf-8")
        payment_source = payment_path.read_text(encoding="utf-8")
        storage_source = storage_path.read_text(encoding="utf-8")
        refinancing_source = refinancing_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        for source in (data_source, payment_source, refinancing_source):
            self.assertIn('"[manual-recalc][rates]"', source)
            for field in (
                "normalKeysChecked",
                "moratoriumKeysChecked",
                "rawNormalExists",
                "rawMoratoriumExists",
                "parsedNormalCount",
                "parsedMoratoriumCount",
                "firstNormalRate",
                "lastNormalRate",
                "firstMoratoriumRate",
                "lastMoratoriumRate",
                "activeOwnerId",
                "envType",
            ):
                self.assertIn(field, source)

        for source in (data_source, payment_source, storage_source):
            for field in (
                "serverOk",
                "serverOwner",
                "requestedKey",
                "returnedKeysCount",
                "hasRefinancingRatesNormalV1",
                "hasRefinancingRatesMoratoriumV1",
                "localExistsFalseExpected",
            ):
                self.assertIn(field, source)
        for source in (data_source, payment_source):
            for field in ("normalShape", "moratoriumShape", "calcInputAssembly", "hasCalcEngineLoadRates"):
                self.assertIn(field, source)

        self.assertIn('"server:/api/store:" + item.kind', data_source)
        self.assertIn("payment_table.throwRatesFatal", payment_source)
        self.assertIn("refinancing.html.server-load", refinancing_source)
        self.assertIn("diagnose_rates_backend_exists", data_source + payment_source + storage_source)
        self.assertIn("diagnose_rates_backend_shape_mismatch", data_source + payment_source)
        self.assertIn("diagnose_rates_missing_in_calc_input", data_source)
        self.assertIn("diagnose_rates_server_ok_local_false_expected", storage_source)
        self.assertIn("refinancing_rates_normal_v1", data_source)
        self.assertIn("refinancing_rates_moratorium_v1", data_source)
        self.assertIn("ref_rates_", data_source)
        self.assertIn("refinancing_v1", data_source)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_manual_full_recalc_hydrates_global_refinancing_rates_before_sync_calc(self):
        payment_path = self._find_repo_file("web", "payment_table.js")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(payment_path)
        self.assertIsNotNone(calc_engine_path)
        payment_source = payment_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        self.assertIn("async function ensureGlobalRefinancingRatesHydrated", payment_source)
        self.assertIn("refinancing_rates_normal_v1", payment_source)
        self.assertIn("refinancing_rates_moratorium_v1", payment_source)
        self.assertIn("JKHStore.hydrateGlobalReadCache(key, String(value))", payment_source)
        self.assertIn("rates_hydrate_global_read_cache_written", payment_source)
        self.assertIn("rates_hydrate_global_read_cache_rejected", payment_source)
        self.assertIn('"/api/store?key=" + encodeURIComponent(key)', payment_source)
        self.assertIn("rates_hydrate_before_recalc_start", payment_source)
        self.assertIn("rates_hydrate_global_key_loaded", payment_source)
        self.assertIn("rates_hydrate_global_key_missing_after_fetch", payment_source)
        self.assertIn("rates_hydrate_before_recalc_done", payment_source)
        self.assertIn("async function waitForManualRecalcDataReady", payment_source)
        self.assertIn("manual_recalc_data_ready_wait_start", payment_source)
        self.assertIn("manual_recalc_data_ready_wait_done", payment_source)
        self.assertIn("manual_recalc_data_ready_timeout", payment_source)
        self.assertIn("manual_recalc_direct_rate_read_after_hydrate", payment_source)
        self.assertIn("manual_recalc_env_prefix_check", payment_source)
        self.assertIn('return { ok:false, reason:"DATA_READY_TIMEOUT"', payment_source)

        full_recalc_body = payment_source.split("window.fullRecalcForCurrentAbonent", 1)[1].split("window.__loadPaymentTable", 1)[0]
        hydrate_pos = full_recalc_body.index('ensureGlobalRefinancingRatesHydrated("payment_table.fullRecalcForCurrentAbonent.before-sync-calc")')
        ready_pos = full_recalc_body.index('waitForManualRecalcDataReady("payment_table.fullRecalcForCurrentAbonent.before-sync-calc")')
        begin_lock_pos = full_recalc_body.index('logFullRecalcStep(runId, "begin-lock"')
        autoaccrual_pos = full_recalc_body.index('logFullRecalcStep(runId, "autoaccrual"')
        runtime_rows_pos = full_recalc_body.index('logFullRecalcStep(runId, "build-runtime-rows-before-summary"')
        self.assertLess(hydrate_pos, ready_pos)
        self.assertLess(ready_pos, begin_lock_pos)
        self.assertLess(ready_pos, autoaccrual_pos)
        self.assertLess(ready_pos, runtime_rows_pos)
        self.assertLess(hydrate_pos, begin_lock_pos)
        self.assertLess(hydrate_pos, autoaccrual_pos)
        self.assertLess(hydrate_pos, runtime_rows_pos)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_global_refinancing_rate_hydration_uses_trusted_read_cache_only(self):
        storage_path = self._find_repo_file("web", "storage.js")
        payment_path = self._find_repo_file("web", "payment_table.js")
        self.assertIsNotNone(storage_path)
        self.assertIsNotNone(payment_path)
        storage_source = storage_path.read_text(encoding="utf-8")
        payment_source = payment_path.read_text(encoding="utf-8")

        self.assertIn("function hydrateGlobalReadCache(baseKey, value)", storage_source)
        helper_body = storage_source.split("function hydrateGlobalReadCache(baseKey, value)", 1)[1].split("function resolveOwnerForKey", 1)[0]
        self.assertIn("if (!isGlobalProjectKey(key))", helper_body)
        self.assertIn('throw new Error("GLOBAL_READ_CACHE_KEY_REJECTED")', helper_body)
        self.assertIn('_lsSetDirect(k(key, "GLOBAL"), v)', helper_body)
        self.assertIn("hydrateGlobalReadCache: hydrateGlobalReadCache", storage_source)

        set_item_body = storage_source.split("function setItem(key, value, ownerId)", 1)[1].split("function removeItem", 1)[0]
        self.assertIn("GLOBAL_ADMIN_ONLY", set_item_body)
        self.assertIn("isGlobalProjectKey(key) && !_isAdmin()", set_item_body)

        helper_recalc_body = payment_source.split("async function ensureGlobalRefinancingRatesHydrated", 1)[1].split("function excludePeriodsKey", 1)[0]
        self.assertIn("JKHStore.hydrateGlobalReadCache(key, String(value))", helper_recalc_body)
        self.assertNotIn("storeSetRaw(key, String(value))", helper_recalc_body)
        self.assertIn("rates_hydrate_global_read_cache_written", helper_recalc_body)
        self.assertIn("rates_hydrate_global_read_cache_rejected", helper_recalc_body)

    def test_manual_full_recalc_data_ready_wait_verifies_direct_rate_reads(self):
        payment_path = self._find_repo_file("web", "payment_table.js")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(payment_path)
        self.assertIsNotNone(calc_engine_path)
        payment_source = payment_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        self.assertIn("function directGlobalRateReadState(source)", payment_source)
        direct_body = payment_source.split("function directGlobalRateReadState(source)", 1)[1].split("function manualRecalcDataReadyForSync", 1)[0]
        self.assertIn('JKHStore.getRaw(key)', direct_body)
        self.assertIn("hasNormal", direct_body)
        self.assertIn("hasMoratorium", direct_body)
        self.assertIn("envType", direct_body)
        self.assertIn("uiStatus", direct_body)
        self.assertIn("uiSource", direct_body)
        self.assertIn("legacyDataReady", direct_body)
        self.assertIn("jkhDataReady", direct_body)
        self.assertIn("normalRateReadable", direct_body)
        self.assertIn("moratoriumRateReadable", direct_body)
        self.assertIn("hydratedDatabaseState", direct_body)
        self.assertIn("envPrefixStable", direct_body)

        wait_body = payment_source.split("async function waitForManualRecalcDataReady", 1)[1].split("function excludePeriodsKey", 1)[0]
        self.assertIn("manualRecalcDataReadyForSync(state, expectedEnvType)", wait_body)
        self.assertIn("expectedEnvType", wait_body)
        self.assertIn("state.envPrefixStable", wait_body)
        self.assertIn("Data.waitForServerFirstDataReady", wait_body)
        self.assertIn("JKHDataLoader.loadFromServer", wait_body)
        self.assertIn("state.acceptedStateReason", wait_body)
        self.assertIn('reason: "manual_recalc_data_ready_timeout"', wait_body)
        self.assertIn("manual_recalc_data_ready_gate_passed", wait_body)
        self.assertIn("manual_recalc_data_ready_blockers", wait_body)
        self.assertIn("preciseReason: blockerReason", wait_body)
        self.assertIn('return { ok: false, reason: "DATA_READY_TIMEOUT"', wait_body)

        ready_body = payment_source.split("function manualRecalcDataReadyForSync", 1)[1].split("async function waitForManualRecalcDataReady", 1)[0]
        self.assertIn("serverFirstReadableState()", ready_body)
        self.assertIn("ok: false", ready_body)
        self.assertIn("readable: readable.ok === true", ready_body)
        self.assertIn("observed.hasNormal === true", ready_body)
        self.assertIn("observed.hasMoratorium === true", ready_body)
        self.assertIn("hydrated.hydrated === true", ready_body)
        self.assertIn("envStable === true", ready_body)
        self.assertIn("normalKey: REFI_KEY_NORMAL", ready_body)
        self.assertIn("moratoriumKey: REFI_KEY_MORA", ready_body)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)

    def test_manual_full_recalc_data_ready_timeout_reports_exact_blockers(self):
        payment_path = self._find_repo_file("web", "payment_table.js")
        self.assertIsNotNone(payment_path)
        payment_source = payment_path.read_text(encoding="utf-8")

        self.assertIn("function manualRecalcDataReadyBlockerReason(gate)", payment_source)
        blocker_body = payment_source.split("function manualRecalcDataReadyBlockerReason(gate)", 1)[1].split("function compactManualRecalcDataReadyGate", 1)[0]
        self.assertIn('blockers.push("READABLE")', blocker_body)
        self.assertIn('blockers.push("NORMAL_RATE")', blocker_body)
        self.assertIn('blockers.push("MORATORIUM_RATE")', blocker_body)
        self.assertIn('blockers.push("DB_HYDRATION")', blocker_body)
        self.assertIn('blockers.push("ENV_UNSTABLE")', blocker_body)
        self.assertIn('"DATA_READY_TIMEOUT_" + blockers[0]', blocker_body)
        self.assertIn('"DATA_READY_TIMEOUT_MULTIPLE"', blocker_body)

        compact_body = payment_source.split("function compactManualRecalcDataReadyGate", 1)[1].split("function manualRecalcDataReadyForSync", 1)[0]
        for field in (
            "readableOk",
            "readableReason",
            "uiStatus",
            "uiSource",
            "legacyDataReady",
            "hasNormal",
            "hasMoratorium",
            "hydrated",
            "hydratedReason",
            "envStable",
            "envBefore",
            "envAfter",
            "elapsedMs",
            "attempts",
            "blockerReason",
        ):
            self.assertIn(field, compact_body)

        wait_body = payment_source.split("async function waitForManualRecalcDataReady", 1)[1].split("function excludePeriodsKey", 1)[0]
        self.assertIn("let attempts = 0", wait_body)
        self.assertIn("let latestGate = null", wait_body)
        self.assertIn("attempts += 1", wait_body)
        self.assertIn("latestGate = gate", wait_body)
        self.assertIn("manual_recalc_data_ready_gate_passed", wait_body)
        self.assertIn("manual_recalc_data_ready_blockers", wait_body)
        self.assertIn('return { ok: false, reason: "DATA_READY_TIMEOUT", preciseReason: blockerReason', wait_body)

    def test_payment_table_manual_recalc_readiness_matches_server_first_contract(self):
        payment_path = self._find_repo_file("web", "payment_table.js")
        self.assertIsNotNone(payment_path)
        payment_source = payment_path.read_text(encoding="utf-8")

        self.assertIn("function serverFirstReadableState()", payment_source)
        helper_body = payment_source.split("function serverFirstReadableState()", 1)[1].split("function isDataReady()", 1)[0]
        self.assertIn('out.uiStatus === "ready"', helper_body)
        self.assertIn('out.acceptedReason = "manual_recalc_data_ready_server_ready"', helper_body)
        self.assertIn('out.uiStatus === "empty" && out.uiSource === "server"', helper_body)
        self.assertIn('out.acceptedReason = "manual_recalc_data_ready_server_empty"', helper_body)
        self.assertIn("window.JKH_DATA_READY === true", helper_body)
        self.assertIn('out.acceptedReason = "manual_recalc_data_ready_legacy"', helper_body)
        self.assertNotIn('out.uiStatus === "loading"', helper_body)
        self.assertNotIn('out.uiStatus === "error"', helper_body)

        is_ready_body = payment_source.split("function isDataReady()", 1)[1].split("function storeGetRaw", 1)[0]
        self.assertIn("serverFirstReadableState().ok === true", is_ready_body)

        wait_body = payment_source.split("async function waitForManualRecalcDataReady", 1)[1].split("function excludePeriodsKey", 1)[0]
        self.assertIn("Data.waitForServerFirstDataReady", wait_body)
        self.assertIn("JKHDataLoader.loadFromServer", wait_body)
        self.assertIn("manual_recalc_data_ready_timeout", wait_body)

        self.assertNotIn('JKH_UI_STATE.data.status = "ready"', payment_source)
        self.assertNotIn("JKH_UI_STATE.data.status = 'ready'", payment_source)
        self.assertNotIn("window.JKH_DATA_READY = true", payment_source)

    def test_backend_global_refinancing_rates_are_read_for_active_owner(self):
        normal_rates = json.dumps([{"from": "2020-01-01", "rate": 7.5}], ensure_ascii=False)
        moratorium_rates = json.dumps([{"from": "2020-01-01", "rate": 0}], ensure_ascii=False)
        with app_module.app.app_context():
            self._add_user("owner-rates-read")
            app_module.db.session.add(app_module.KVStore(
                owner=app_module.GLOBAL_OWNER,
                k="refinancing_rates_normal_v1",
                v=normal_rates,
            ))
            app_module.db.session.add(app_module.KVStore(
                owner=app_module.GLOBAL_OWNER,
                k="refinancing_rates_moratorium_v1",
                v=moratorium_rates,
            ))
            app_module.db.session.commit()
        self._login("owner-rates-read")

        response = self.client.get("/api/store?key=refinancing_rates_normal_v1&client_owner_hint=owner-rates-read")
        payload = response.get_json()

        self.assertEqual(response.status_code, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["owner"], app_module.GLOBAL_OWNER)
        self.assertEqual(json.loads(payload["value"]), [{"from": "2020-01-01", "rate": 7.5}])

        keys = self.client.get("/api/store_keys?client_owner_hint=owner-rates-read").get_json()
        self.assertIn("refinancing_rates_normal_v1", keys["keys"])
        self.assertIn("refinancing_rates_moratorium_v1", keys["keys"])

    def test_stage_13_2d_card_report_period_flow_diagnostics(self):
        card_path = self._find_repo_file("web", "abonent_card.html")
        payment_path = self._find_repo_file("web", "payment_table.js")
        reports_path = self._find_repo_file("web", "reports.html")
        spravka_path = self._find_repo_file("web", "spravka_sud.js")
        data_path = self._find_repo_file("web", "data.js")
        calc_engine_path = self._find_repo_file("web", "calc_engine.js")
        self.assertIsNotNone(card_path)
        self.assertIsNotNone(payment_path)
        self.assertIsNotNone(reports_path)
        self.assertIsNotNone(spravka_path)
        self.assertIsNotNone(data_path)
        self.assertIsNotNone(calc_engine_path)
        card_source = card_path.read_text(encoding="utf-8")
        payment_source = payment_path.read_text(encoding="utf-8")
        reports_source = reports_path.read_text(encoding="utf-8")
        spravka_source = spravka_path.read_text(encoding="utf-8")
        data_source = data_path.read_text(encoding="utf-8")
        calc_before = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()

        self.assertIn("[card-recalc][click]", card_source)
        self.assertIn("[card-recalc][period-saved]", card_source)
        self.assertIn("[card-recalc][result]", card_source)
        self.assertIn("[report-period][readback]", card_source)
        self.assertIn("[card-period][bootstrap-inputs]", card_source)
        self.assertIn("[card-period][bootstrap-inputs-from-url]", card_source)
        self.assertIn("[card-period][bootstrap-active]", card_source)
        self.assertIn("[card-period][reset]", card_source)
        self.assertIn("searchParams.delete(\"from\")", card_source)
        self.assertIn("searchParams.delete(\"to\")", card_source)
        self.assertIn("JKH_resetPaymentTablePeriodRuntime", card_source)
        self.assertIn("function bootstrapActiveCalcPeriod", card_source)
        self.assertIn("__safeLoadPaymentTableOnce(\"calc-period-bootstrap-url\", { force: true })", card_source)
        self.assertIn("[report-period][default-created]", card_source)
        self.assertIn("function buildDefaultReportPeriodForCard", card_source)
        self.assertIn("responsibility.dateFrom", card_source)
        self.assertIn("abonent.calcStartDate", card_source)
        self.assertIn("premise.createdAt", card_source)
        self.assertIn("ledger.earliestMonth", card_source)
        self.assertIn("window.JKH_debugCardPeriodFlow = function(abonentId)", card_source)
        self.assertIn("saveReportPeriodForSpravka", card_source)
        self.assertIn("report_period_\" + uid", card_source)
        self.assertIn("/^report_period_uid_/", card_source)
        self.assertIn("&account=", card_source)
        self.assertIn("&uid=", card_source)
        self.assertIn("&from=", card_source)
        self.assertIn("&to=", card_source)
        self.assertIn("periodBefore", card_source)
        self.assertIn("activeBefore", card_source)
        self.assertIn("spravkaCanBootstrap", card_source)
        load_body = card_source.split("function loadCalcPeriodUI()", 1)[1].split("function saveCalcPeriod", 1)[0]
        self.assertIn('params.get("from")', load_body)
        self.assertIn('params.get("to")', load_body)
        self.assertIn("reportReadback.value || calcReadback.value", load_body)
        self.assertIn("source = reportReadback.value ? \"report_period_uid\"", load_body)
        self.assertNotIn("fullRecalcForCurrentAbonent", load_body)
        self.assertNotIn("markCurrentAbonentSummaryDirty", load_body)
        default_body = card_source.split("function buildDefaultReportPeriodForCard", 1)[1].split("function saveReportPeriodForSpravka", 1)[0]
        self.assertIn("__todayISOForCardPeriod", default_body)
        self.assertIn("__earliestLedgerMonthISO", default_body)
        self.assertNotIn("fullRecalcForCurrentAbonent", default_body)
        self.assertNotIn("markCurrentAbonentSummaryDirty", default_body)

        helper_body = card_source.split("window.JKH_debugCardPeriodFlow = function(abonentId)", 1)[1].split("function loadCalcPeriodUI", 1)[0]
        self.assertNotIn("storeSet(", helper_body)
        self.assertNotIn("storeRemove(", helper_body)
        self.assertNotIn("writePaymentLedger", helper_body)
        self.assertNotIn("fullRecalcForCurrentAbonent", helper_body)
        self.assertNotIn("CALC_PERIOD_CHANGED", helper_body)

        self.assertIn("reportKey: uid ? (\"report_period_\" + uid) : \"\"", reports_source)
        self.assertIn("source: \"canonical-report\"", reports_source)
        self.assertIn("[reports][bootstrap-period]", reports_source)
        self.assertIn("[reports][period-auto-accepted]", reports_source)
        self.assertIn("function autoAcceptReportsPeriod", reports_source)
        self.assertIn("[reports][readonly-open]", reports_source)
        self.assertIn("openBtn.disabled = !ok", reports_source)
        self.assertIn("uidFromUrl", reports_source)
        self.assertIn("function storeSetCanonical", reports_source)
        self.assertIn("[reports][write-blocked-readonly]", reports_source)
        self.assertIn("/^report_period_uid_/.test(meta.reportKey)", reports_source)
        self.assertIn("[report-period][readback]", reports_source)

        self.assertIn("[payment-table][period-filter-applied-on-load]", payment_source)
        self.assertIn("[payment-table][period-runtime-source]", payment_source)
        self.assertIn("window.JKH_resetPaymentTablePeriodRuntime = function(reason)", payment_source)
        self.assertIn("[payment-table][period-runtime-reset]", payment_source)
        self.assertIn("[payment-table][full-view-after-period-reset]", payment_source)
        self.assertIn("[payment-table][period-url-fallback]", payment_source)
        self.assertIn("function getPeriodFromURL", payment_source)
        self.assertIn("params.get(\"from\")", payment_source)
        self.assertIn("params.get(\"to\")", payment_source)
        self.assertIn("canonical-active-missing-url-period-present", payment_source)
        self.assertIn("function runtimeCacheSignature", payment_source)
        self.assertIn("runtimeCachePeriodMatches", payment_source)
        self.assertIn("runtimeRowsByIdFromRows", payment_source)
        self.assertIn('baseRowsSource = periodActive && selectedPeriod ? "filtered"', payment_source)
        self.assertIn("inspectRuntimeCachePeriodMatch", payment_source)
        self.assertIn("runtimeSignature", payment_source)
        self.assertIn("periodActive", payment_source)
        self.assertIn("runtimeCacheUsed: runtimeCacheUsed", payment_source)
        self.assertIn("effectiveSignature", payment_source)
        self.assertIn("\"|period:\"", payment_source)
        self.assertIn("scheduleRunningTotalsUpdate(view, baseRows, tbody, effectiveSignature)", payment_source)
        self.assertIn("opts.force", payment_source)
        self.assertIn("__paymentTableRenderedSignature = \"\"", payment_source)
        self.assertIn("::period:", payment_source)

        self.assertIn("reportStorageKey", spravka_source)
        self.assertIn("report_period_uid", spravka_source)
        self.assertIn("const selectedPeriod = urlPeriod || reportPeriod || (activeRaw === \"1\" ? calcPeriod : null)", spravka_source)
        self.assertIn("[spravka][bootstrap-period]", spravka_source)
        self.assertIn("[spravka][return-card-period-save]", spravka_source)
        self.assertIn("[spravka][return-card-url]", spravka_source)
        self.assertIn("buildCardReturnUrl", spravka_source)
        self.assertIn("saveReturnCardPeriod", spravka_source)
        self.assertIn("report_period_\" + uid", spravka_source)
        self.assertIn("resolveCalcPeriodStorageKey", spravka_source)
        self.assertIn("resolveCalcPeriodActiveStorageKey", spravka_source)

        self.assertIn("_setRawScoped(\"report_period_\" + uid", data_source)
        self.assertNotIn("_setRawScoped(\"report_period_\" + id", data_source)

        calc_after = hashlib.sha256(calc_engine_path.read_bytes()).hexdigest()
        self.assertEqual(calc_before, calc_after)


if __name__ == "__main__":
    unittest.main()
