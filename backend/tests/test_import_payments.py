import os
import sys
import unittest
from unittest.mock import patch
import json
import tempfile
from sqlalchemy import create_engine

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import app as app_module


class DummyBatch:
    def __init__(self, status):
        self.status = status


class ImportHelpersTest(unittest.TestCase):
    def test_state_machine_forbids_parse_on_applied(self):
        with app_module.app.app_context():
            res = app_module._ensure_batch_transition(DummyBatch("applied"), "parse")
            self.assertIsNotNone(res)
            payload, code = res
            self.assertEqual(code, 409)
            self.assertEqual(payload.json.get("error"), "state_transition_forbidden")

    def test_state_machine_forbids_validate_on_applied(self):
        with app_module.app.app_context():
            res = app_module._ensure_batch_transition(DummyBatch("applied"), "validate")
            self.assertIsNotNone(res)
            payload, code = res
            self.assertEqual(code, 409)

    def test_state_machine_forbids_apply_on_applied(self):
        with app_module.app.app_context():
            res = app_module._ensure_batch_transition(DummyBatch("applied"), "apply")
            self.assertIsNotNone(res)
            payload, code = res
            self.assertEqual(code, 409)

    def test_state_machine_forbids_apply_on_validated_for_partial_apply(self):
        with app_module.app.app_context():
            res = app_module._ensure_batch_transition(DummyBatch("validated"), "apply")
            self.assertIsNotNone(res)
            payload, code = res
            self.assertEqual(code, 409)
            self.assertEqual(payload.json.get("error"), "state_transition_forbidden")

    def test_header_normalization_maps_aliases(self):
        header = ["UID", "Дата оплаты", "Период", "Сумма оплаты", "Источник платежа"]
        mapped = app_module._parse_header_map(header)
        self.assertIn("account_uid", mapped)
        self.assertIn("payment_date", mapped)
        self.assertIn("payment_period", mapped)
        self.assertIn("amount", mapped)
        self.assertIn("source_index", mapped)

    def test_build_payment_fingerprint_is_stable_for_normalized_values(self):
        fp1 = app_module.build_payment_fingerprint(
            "owner1",
            " UID-1 ",
            "  000123 ",
            "01.02.2026",
            "10,5",
            "2",
            "2026/2",
        )
        fp2 = app_module.build_payment_fingerprint(
            "owner1",
            "UID-1",
            "000123",
            "2026-02-01",
            "10.50",
            2,
            "2026-02",
        )
        self.assertEqual(fp1, fp2)

    def test_payment_duplicate_same_period_date_amount_has_same_fingerprint(self):
        fp1 = app_module.build_payment_fingerprint(
            "owner1", "uid_1", "0001", "2025-02-10", "1500", 1, "2025-02"
        )
        fp2 = app_module.build_payment_fingerprint(
            "owner1", "uid_1", "0001", "10.02.2025", "1500.00", 1, "02.2025"
        )
        self.assertEqual(fp1, fp2)

    def test_payment_conflict_same_period_date_other_amount_has_other_fingerprint(self):
        fp1 = app_module.build_payment_fingerprint(
            "owner1", "uid_1", "0001", "2025-02-10", "1500", 1, "2025-02"
        )
        fp2 = app_module.build_payment_fingerprint(
            "owner1", "uid_1", "0001", "2025-02-10", "1700", 1, "2025-02"
        )
        self.assertNotEqual(fp1, fp2)

    def test_additional_payment_same_period_other_date_has_other_fingerprint(self):
        fp1 = app_module.build_payment_fingerprint(
            "owner1", "uid_1", "0001", "2025-02-10", "1500", 1, "2025-02"
        )
        fp2 = app_module.build_payment_fingerprint(
            "owner1", "uid_1", "0001", "2025-02-15", "1500", 1, "2025-02"
        )
        self.assertNotEqual(fp1, fp2)

    def test_fingerprint_depends_on_source_but_not_period(self):
        fp1 = app_module.build_payment_fingerprint(
            "owner1", "uid_1", "0001", "2025-02-10", "1500", 1, "2025-02"
        )
        fp2 = app_module.build_payment_fingerprint(
            "owner1", "uid_1", "0001", "2025-02-10", "1500", 99, "2025-03"
        )
        self.assertNotEqual(fp1, fp2)

    def test_classification_duplicate_same_uid_date_amount(self):
        ledger = [{"paid_date": "10.02.2025", "paid": 1500.0}]
        result = app_module._classify_payment("uid_1", "2025-02-10", "1500.00", ledger)
        self.assertEqual(result, "DUPLICATE")

    def test_classification_conflict_same_uid_date_other_amount(self):
        ledger = [{"paid_date": "2025-02-10", "paid": 1700}]
        result = app_module._classify_payment("uid_1", "2025-02-10", "1500.00", ledger)
        self.assertEqual(result, "CONFLICT")

    def test_classification_new_payment_same_month_other_date(self):
        ledger = [{"paid_date": "10.02.2025", "paid": 1500.0, "payment_period": "2025-02"}]
        result = app_module._classify_payment("uid_1", "2025-02-15", "1500.00", ledger)
        self.assertEqual(result, "NEW_PAYMENT")

    def test_classification_skips_ledger_items_with_other_uid(self):
        ledger = [{"uid": "other_uid", "paid_date": "10.02.2025", "paid": 1500.0}]
        result = app_module._classify_payment("uid_1", "2025-02-10", "1500.00", ledger)
        self.assertEqual(result, "NEW_PAYMENT")

    def test_classification_backward_compatible_without_uid(self):
        ledger = [{"paid_date": "10.02.2025", "paid": 1500.0}]
        result = app_module._classify_payment("uid_1", "2025-02-10", "1500.00", ledger)
        self.assertEqual(result, "DUPLICATE")

    def test_apply_skips_row_when_fingerprint_already_applied_after_validation(self):
        owner_id = "owner-1"
        account_uid = "uid_1"
        account_number = "100500"
        paid_date = "2025-02-10"
        amount = "1500.00"
        fingerprint = app_module.payment_fingerprint(account_uid, paid_date, amount, 1)

        class DummyBatch:
            def __init__(self):
                self.id = 100
                self.owner_id = owner_id
                self.status = "validated"
                self.rows_applied = 0
                self.finished_at = None
                self.uploaded_at = None
                self.upload_blob = b""
                self.rows_invalid = 0

        class DummyRow:
            def __init__(self):
                self.id = 200
                self.row_no = 1
                self.status = "ready"
                self.reason_code = "NEW_PAYMENT"
                self.reason_text = ""
                self.account_uid = account_uid
                self.account_number = account_number
                self.paid_date = paid_date
                self.payment_date = paid_date
                self.payment_period = "2025-02"
                self.amount = amount
                self.source_index = 1
                self.source_label = "Источник 1"
                self.matched_payment_id = ""
                self.applied_at = None
                self.fingerprint = ""

        class DummyFilterBy:
            def __init__(self, result):
                self._result = result

            def first(self):
                return self._result

            def order_by(self, *args, **kwargs):
                return self

            def all(self):
                return self._result

        class DummySession:
            def __init__(self):
                self.added = []
                self.committed = 0
                self.rolled_back = 0

            def add(self, obj):
                self.added.append(obj)

            def flush(self):
                return None

            def commit(self):
                self.committed += 1

            def rollback(self):
                self.rolled_back += 1

        dummy_batch = DummyBatch()
        dummy_row = DummyRow()
        existing_fp = type("ExistingFP", (), {"payment_id": "100500:1"})()
        dummy_session = DummySession()

        with app_module.app.test_request_context("/api/import/100/apply", method="POST"):
            with patch.object(app_module, "_require_user", return_value=(type("U", (), {"id": owner_id, "role": "user"})(), None)):
                with patch.object(app_module, "_ensure_batch_transition", return_value=None):
                    with patch.object(app_module, "_load_owner_sources", return_value={}):
                        with patch.object(app_module, "_batch_payload", return_value={"id": dummy_batch.id, "status": "applied"}):
                            with patch.object(app_module.ImportBatch, "query", type("Q", (), {
                                "filter_by": staticmethod(lambda **kwargs: DummyFilterBy(dummy_batch))
                            })()):
                                with patch.object(app_module.ImportBatchRow, "query", type("RQ", (), {
                                    "filter_by": staticmethod(lambda **kwargs: DummyFilterBy([dummy_row]))
                                })()):
                                    with patch.object(app_module.ImportAppliedFingerprint, "query", type("FQ", (), {
                                        "filter_by": staticmethod(lambda **kwargs: DummyFilterBy(existing_fp))
                                    })()):
                                        with patch.object(app_module, "db", type("DB", (), {"session": dummy_session})()):
                                            resp = app_module.import_payments_apply(100)

        payload = resp.json
        self.assertTrue(payload.get("ok"))
        self.assertEqual(payload["summary"]["applied_count"], 0)
        self.assertEqual(payload["summary"]["duplicate_count"], 1)
        self.assertEqual(payload["summary"]["conflict_count"], 0)
        self.assertEqual(dummy_row.status, "duplicate")
        self.assertEqual(dummy_row.reason_code, "DUPLICATE")
        self.assertEqual(dummy_row.matched_payment_id, "100500:1")
        self.assertEqual(dummy_session.committed, 1)


    def test_reapply_batch_is_forbidden_by_state_machine(self):
        with app_module.app.app_context():
            res = app_module._ensure_batch_transition(DummyBatch("applied"), "apply")
            self.assertIsNotNone(res)
            payload, code = res
            self.assertEqual(code, 409)
            self.assertEqual(payload.json.get("error"), "state_transition_forbidden")

    def test_same_uploaded_file_fingerprints_match_and_will_be_treated_as_duplicate(self):
        fp1 = app_module.payment_fingerprint("uid_1", "2025-02-10", "1500.00", 1)
        fp2 = app_module.payment_fingerprint("uid_1", "10.02.2025", "1500", 1)
        fp3 = app_module.payment_fingerprint("uid_1", "10.02.2025", "1500", 2)
        self.assertEqual(fp1, fp2)
        self.assertNotEqual(fp1, fp3)

    def test_build_payment_fingerprint_requires_uid(self):
        with self.assertRaises(ValueError):
            app_module.build_payment_fingerprint(
                "owner1", " ", "0001", "2025-02-10", "1500", 1, "2025-02"
            )

    def test_normalize_source_index_rejects_non_positive(self):
        with self.assertRaises(ValueError):
            app_module.normalize_source_index(0)

    def test_normalize_account_number_is_required(self):
        with self.assertRaises(ValueError):
            app_module.normalize_account_number(" ")

    def test_to_ledger_paid_date_uses_legacy_format(self):
        self.assertEqual(app_module.to_ledger_paid_date("2026-02-01"), "01.02.2026")

    def test_find_owner_accounts_reads_nested_abonents_from_abonents_db_v1(self):
        owner_id = "owner-1"
        uid = "uid_mo9q8hat_yq3n5r"
        ls = "100500"
        payload = {
            "abonents": {
                "a1": {"uid": uid, "id": ls},
            }
        }

        class DummyQuery:
            def filter_by(self, owner, k):
                self.owner = owner
                self.k = k
                return self

            def first(self):
                if self.owner == owner_id and self.k == "abonents_db_v1":
                    return type("Row", (), {"v": json.dumps(payload)})()
                return None

        with app_module.app.app_context():
            with patch.object(app_module.KVStore, "query", DummyQuery()):
                result = app_module._find_owner_accounts(owner_id, uid, ls)

        self.assertTrue(result["uid_found"])
        self.assertEqual(len(result["matches"]), 1)

    def test_find_owner_accounts_reports_uid_ls_mismatch(self):
        owner_id = "owner-1"
        uid = "uid_mo9q8hat_yq3n5r"
        payload = {"abonents": {"a1": {"uid": uid, "id": "777"}}}

        class DummyQuery:
            def filter_by(self, owner, k):
                self.owner = owner
                self.k = k
                return self

            def first(self):
                if self.owner == owner_id and self.k == "abonents_db_v1":
                    return type("Row", (), {"v": json.dumps(payload)})()
                return None

        with app_module.app.app_context():
            with patch.object(app_module.KVStore, "query", DummyQuery()):
                result = app_module._find_owner_accounts(owner_id, uid, "999")

        self.assertTrue(result["uid_found"])
        self.assertEqual(result["matches"], [])

    def test_find_owner_accounts_uses_abonent_object_key_as_canonical_ls(self):
        owner_id = "owner-1"
        uid = "uid_moefhmpj_chndmn"
        payload = {"abonents": {"1006": {"uid": uid, "id": "9999"}}}

        class DummyQuery:
            def filter_by(self, owner, k):
                self.owner = owner
                self.k = k
                return self

            def first(self):
                if self.owner == owner_id and self.k == "abonents_db_v1":
                    return type("Row", (), {"v": json.dumps(payload)})()
                return None

        with app_module.app.app_context():
            with patch.object(app_module.KVStore, "query", DummyQuery()):
                result = app_module._find_owner_accounts(owner_id, uid, "1006")

        self.assertTrue(result["uid_found"])
        self.assertEqual(len(result["matches"]), 1)


class ImportPaymentsE2ETest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._db_file = tempfile.NamedTemporaryFile(prefix="jkh_import_e2e_", suffix=".sqlite", delete=False)
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
        self.owner_id = "owner-import-e2e"
        self.account_uid = "uid_customer_2009_e2e"
        self.account_number = "2009001"
        self.client = app_module.app.test_client()
        with app_module.app.app_context():
            app_module.db.drop_all()
            app_module.db.create_all()
            app_module.db.session.execute(app_module.text("DROP TABLE import_applied_fingerprints"))
            app_module.db.session.execute(app_module.text("""
                CREATE TABLE import_applied_fingerprints (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner_id VARCHAR(191) NOT NULL,
                    import_type VARCHAR(32) NOT NULL DEFAULT 'payments',
                    fingerprint VARCHAR(255) NOT NULL,
                    account_uid VARCHAR(191),
                    account_number VARCHAR(191),
                    payment_period VARCHAR(7),
                    paid_date DATE,
                    amount NUMERIC(12, 2) NOT NULL,
                    source_index INTEGER NOT NULL DEFAULT 1,
                    payment_id VARCHAR(64) NOT NULL DEFAULT '',
                    batch_id BIGINT,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT uq_owner_import_fp UNIQUE (owner_id, import_type, fingerprint)
                )
            """))
            app_module.db.session.execute(app_module.text("DROP TABLE payment_audit_log"))
            app_module.db.session.execute(app_module.text("""
                CREATE TABLE payment_audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner_id VARCHAR(128) NOT NULL,
                    batch_id INTEGER NOT NULL,
                    row_id INTEGER,
                    action VARCHAR(32) NOT NULL,
                    status VARCHAR(32) NOT NULL,
                    details_json TEXT NOT NULL DEFAULT '{}',
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            """))
            app_module.db.session.add(app_module.User(
                id=self.owner_id,
                email="import-e2e@example.test",
                password_hash="not-used",
                role="user",
                display_name="Import E2E",
            ))
            app_module.db.session.add(app_module.KVStore(
                owner=self.owner_id,
                k="payment_sources_v1",
                v=json.dumps(["CUSTOMER_2009", "BANK"], ensure_ascii=False),
            ))
            app_module.db.session.add(app_module.KVStore(
                owner=self.owner_id,
                k="abonents_db_v1",
                v=json.dumps({
                    "abonents": {
                        self.account_number: {
                            "uid": self.account_uid,
                            "id": self.account_number,
                            "calcStartDate": "2025-01-01",
                        }
                    }
                }, ensure_ascii=False),
            ))
            app_module.db.session.commit()
        with self.client.session_transaction() as sess:
            sess["user_id"] = self.owner_id

    def tearDown(self):
        with app_module.app.app_context():
            app_module.db.session.remove()
            app_module.db.drop_all()

    def _upload_rows(self, payment_period="2026-01", include_account_number=True, rows=None):
        if rows is None:
            rows = [{
                "account_uid": self.account_uid,
                "payment_date": "2026-01-15",
                "payment_period": payment_period,
                "amount": 1000,
                "source_index": 1,
            }]
        if include_account_number:
            for row in rows:
                row.setdefault("account_number", self.account_number)
        return self.client.post("/api/import/payments/upload_rows", json={"rows": rows})

    def test_upload_rows_validate_apply_writes_payment_to_uid_ledger(self):
        with patch.object(app_module, "_import_schema_error_response", return_value=None):
            upload_resp = self._upload_rows()
            self.assertEqual(upload_resp.status_code, 200)
            batch_id = upload_resp.json["batch"]["id"]

            validate_resp = self.client.post(f"/api/import/{batch_id}/validate")
            self.assertEqual(validate_resp.status_code, 200)

            apply_resp = self.client.post(f"/api/import/{batch_id}/apply")
            self.assertEqual(apply_resp.status_code, 200)
            self.assertEqual(apply_resp.json["batch"]["status"], "applied")
            self.assertEqual(apply_resp.json["batch"]["rows_applied"], 1)
            self.assertEqual(apply_resp.json["summary"]["affected_uids"], [self.account_uid])

        with app_module.app.app_context():
            batch = app_module.ImportBatch.query.filter_by(id=batch_id).first()
            self.assertIsNotNone(batch)
            self.assertEqual(batch.status, "applied")
            self.assertEqual(batch.rows_applied, 1)
            kv = app_module.KVStore.query.filter_by(
                owner=self.owner_id,
                k=f"payments_{self.account_uid}",
            ).first()
            self.assertIsNotNone(kv)
            ledger = json.loads(kv.v)

        self.assertEqual(len(ledger), 1)
        self.assertEqual(ledger[0]["uid"], self.account_uid)
        self.assertEqual(ledger[0]["paid"], 1000.0)
        self.assertEqual(ledger[0]["paid_date"], "15.01.2026")
        self.assertEqual(ledger[0]["payment_period"], "2026-01")


    def test_upload_rows_missing_payment_period_is_invalid(self):
        rows = [{
            "account_uid": self.account_uid,
            "payment_date": "2026-01-15",
            "amount": 1000,
            "source_index": 1,
        }]
        with patch.object(app_module, "_import_schema_error_response", return_value=None):
            upload_resp = self._upload_rows(rows=rows)
            self.assertEqual(upload_resp.status_code, 200)
            batch_id = upload_resp.json["batch"]["id"]

            validate_resp = self.client.post(f"/api/import/{batch_id}/validate")
            self.assertEqual(validate_resp.status_code, 200)
            self.assertEqual(validate_resp.json["batch"]["rows_invalid"], 1)

        with app_module.app.app_context():
            row = app_module.ImportBatchRow.query.filter_by(batch_id=batch_id).first()
            self.assertEqual(row.status, "invalid")
            self.assertEqual(row.reason_code, "PAYMENT_PERIOD_REQUIRED")

    def test_upload_rows_non_iso_payment_period_is_invalid(self):
        with patch.object(app_module, "_import_schema_error_response", return_value=None):
            upload_resp = self._upload_rows(payment_period="01/2026")
            self.assertEqual(upload_resp.status_code, 200)
            batch_id = upload_resp.json["batch"]["id"]

            validate_resp = self.client.post(f"/api/import/{batch_id}/validate")
            self.assertEqual(validate_resp.status_code, 200)
            self.assertEqual(validate_resp.json["batch"]["rows_invalid"], 1)

        with app_module.app.app_context():
            row = app_module.ImportBatchRow.query.filter_by(batch_id=batch_id).first()
            self.assertEqual(row.status, "invalid")
            self.assertEqual(row.reason_code, "PAYMENT_PERIOD_INVALID")


    def test_same_uid_date_amount_with_different_source_indexes_applies_both_rows(self):
        rows = [
            {
                "account_uid": self.account_uid,
                "payment_date": "2026-01-15",
                "payment_period": "2026-01",
                "amount": 1000,
                "source_index": 1,
            },
            {
                "account_uid": self.account_uid,
                "payment_date": "2026-01-15",
                "payment_period": "2026-01",
                "amount": 1000,
                "source_index": 2,
            },
        ]
        with patch.object(app_module, "_import_schema_error_response", return_value=None):
            upload_resp = self._upload_rows(rows=rows)
            self.assertEqual(upload_resp.status_code, 200)
            batch_id = upload_resp.json["batch"]["id"]

            validate_resp = self.client.post(f"/api/import/{batch_id}/validate")
            self.assertEqual(validate_resp.status_code, 200)
            self.assertEqual(validate_resp.json["batch"]["rows_duplicate"], 0)

            apply_resp = self.client.post(f"/api/import/{batch_id}/apply")
            self.assertEqual(apply_resp.status_code, 200)
            self.assertEqual(apply_resp.json["batch"]["rows_applied"], 2)
            self.assertEqual(apply_resp.json["summary"]["duplicate_count"], 0)

        with app_module.app.app_context():
            ledger_row = app_module.KVStore.query.filter_by(
                owner=self.owner_id,
                k=f"payments_{self.account_uid}",
            ).first()
            self.assertIsNotNone(ledger_row)
            ledger = json.loads(ledger_row.v)
            self.assertEqual(len(ledger), 2)
            self.assertNotEqual(ledger[0]["fingerprint"], ledger[1]["fingerprint"])

    def test_reupload_same_rows_skips_duplicate_without_second_ledger_payment(self):
        with patch.object(app_module, "_import_schema_error_response", return_value=None):
            first_upload_resp = self._upload_rows()
            self.assertEqual(first_upload_resp.status_code, 200)
            first_batch_id = first_upload_resp.json["batch"]["id"]

            first_validate_resp = self.client.post(f"/api/import/{first_batch_id}/validate")
            self.assertEqual(first_validate_resp.status_code, 200)

            first_apply_resp = self.client.post(f"/api/import/{first_batch_id}/apply")
            self.assertEqual(first_apply_resp.status_code, 200)
            self.assertEqual(first_apply_resp.json["batch"]["rows_applied"], 1)

            second_upload_resp = self._upload_rows()
            self.assertEqual(second_upload_resp.status_code, 200)
            second_batch_id = second_upload_resp.json["batch"]["id"]

            second_validate_resp = self.client.post(f"/api/import/{second_batch_id}/validate")
            self.assertEqual(second_validate_resp.status_code, 200)
            self.assertEqual(second_validate_resp.json["batch"]["rows_duplicate"], 1)

            second_apply_resp = self.client.post(f"/api/import/{second_batch_id}/apply")
            self.assertEqual(second_apply_resp.status_code, 200)
            self.assertEqual(second_apply_resp.json["batch"]["rows_applied"], 0)
            self.assertEqual(second_apply_resp.json["batch"]["rows_skipped"], 1)
            self.assertEqual(second_apply_resp.json["summary"]["duplicate_count"], 1)
            self.assertEqual(second_apply_resp.json["summary"]["affected_uids"], [])

        with app_module.app.app_context():
            ledger_row = app_module.KVStore.query.filter_by(
                owner=self.owner_id,
                k=f"payments_{self.account_uid}",
            ).first()
            self.assertIsNotNone(ledger_row)
            ledger = json.loads(ledger_row.v)
            self.assertEqual(len(ledger), 1)

            audit_row = app_module.PaymentAuditLog.query.filter_by(
                owner_id=self.owner_id,
                batch_id=second_batch_id,
                action="DUPLICATE",
                status="SKIPPED",
            ).first()
            self.assertIsNotNone(audit_row)
            details = json.loads(audit_row.details_json)
            self.assertEqual(details["result"], "SKIPPED")
            self.assertEqual(details["reason_code"], "DUPLICATE")

    def test_upload_rows_with_2009_period_does_not_apply_invalid_batch(self):
        with patch.object(app_module, "_import_schema_error_response", return_value=None):
            upload_resp = self._upload_rows(payment_period="2009-01", include_account_number=False)
            self.assertEqual(upload_resp.status_code, 200)
            batch_id = upload_resp.json["batch"]["id"]

            validate_resp = self.client.post(f"/api/import/{batch_id}/validate")
            self.assertEqual(validate_resp.status_code, 200)
            self.assertGreater(validate_resp.json["batch"]["rows_invalid"], 0)
            self.assertNotEqual(validate_resp.json["batch"]["status"], "applied")

        with app_module.app.app_context():
            batch = app_module.ImportBatch.query.filter_by(id=batch_id).first()
            self.assertIsNotNone(batch)
            self.assertNotEqual(batch.status, "applied")
            self.assertEqual(batch.rows_applied, 0)
            kv = app_module.KVStore.query.filter_by(
                owner=self.owner_id,
                k=f"payments_{self.account_uid}",
            ).first()
            self.assertIsNone(kv)


    def test_validate_import_with_corrupted_existing_ledger_returns_ledger_json_invalid(self):
        with app_module.app.app_context():
            app_module.db.session.add(app_module.KVStore(
                owner=self.owner_id,
                k=f"payments_{self.account_uid}",
                v="{broken-json",
            ))
            app_module.db.session.commit()

        with patch.object(app_module, "_import_schema_error_response", return_value=None):
            upload_resp = self._upload_rows()
            self.assertEqual(upload_resp.status_code, 200)
            batch_id = upload_resp.json["batch"]["id"]

            validate_resp = self.client.post(f"/api/import/{batch_id}/validate")
            self.assertEqual(validate_resp.status_code, 200)
            self.assertEqual(validate_resp.json["batch"]["rows_invalid"], 1)

        with app_module.app.app_context():
            row = app_module.ImportBatchRow.query.filter_by(batch_id=batch_id).first()
            self.assertIsNotNone(row)
            self.assertEqual(row.status, "invalid")
            self.assertEqual(row.reason_code, "LEDGER_JSON_INVALID")
            ledger_row = app_module.KVStore.query.filter_by(
                owner=self.owner_id,
                k=f"payments_{self.account_uid}",
            ).first()
            self.assertIsNotNone(ledger_row)
            self.assertEqual(ledger_row.v, "{broken-json")

    def test_apply_import_with_corrupted_existing_ledger_fails_and_leaves_ledger_unchanged(self):
        with patch.object(app_module, "_import_schema_error_response", return_value=None):
            upload_resp = self._upload_rows()
            self.assertEqual(upload_resp.status_code, 200)
            batch_id = upload_resp.json["batch"]["id"]

            validate_resp = self.client.post(f"/api/import/{batch_id}/validate")
            self.assertEqual(validate_resp.status_code, 200)
            self.assertEqual(validate_resp.json["batch"]["rows_invalid"], 0)

        with app_module.app.app_context():
            app_module.db.session.add(app_module.KVStore(
                owner=self.owner_id,
                k=f"payments_{self.account_uid}",
                v="not-json",
            ))
            app_module.db.session.commit()

        with patch.object(app_module, "_import_schema_error_response", return_value=None):
            apply_resp = self.client.post(f"/api/import/{batch_id}/apply")
        self.assertEqual(apply_resp.status_code, 500)
        self.assertEqual(apply_resp.json["details"], "LEDGER_JSON_INVALID")

        with app_module.app.app_context():
            batch = app_module.ImportBatch.query.filter_by(id=batch_id).first()
            self.assertIsNotNone(batch)
            self.assertEqual(batch.status, "failed")
            self.assertEqual(batch.rows_applied, 0)
            ledger_row = app_module.KVStore.query.filter_by(
                owner=self.owner_id,
                k=f"payments_{self.account_uid}",
            ).first()
            self.assertIsNotNone(ledger_row)
            self.assertEqual(ledger_row.v, "not-json")

    def test_upload_rows_returns_503_when_import_batch_schema_is_missing_rows_skipped(self):
        schema_status = {
            "ok": False,
            "error": "import_batches_missing_columns",
            "missing_columns": ["rows_skipped"],
            "migration_sql": "migration required: ALTER TABLE import_batches ADD COLUMN rows_skipped INT NOT NULL DEFAULT 0",
        }
        with patch.object(app_module, "_import_batches_schema_status", return_value=schema_status):
            resp = self._upload_rows()

        self.assertEqual(resp.status_code, 503)
        body = resp.get_data(as_text=True).lower()
        self.assertTrue("schema mismatch" in body or "migration required" in body)


if __name__ == "__main__":
    unittest.main()
