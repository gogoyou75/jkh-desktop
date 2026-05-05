import os
import sys
import unittest
from unittest.mock import patch
import json

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

    def test_fingerprint_does_not_depend_on_period_or_source(self):
        fp1 = app_module.build_payment_fingerprint(
            "owner1", "uid_1", "0001", "2025-02-10", "1500", 1, "2025-02"
        )
        fp2 = app_module.build_payment_fingerprint(
            "owner1", "uid_1", "0001", "2025-02-10", "1500", 99, "2025-03"
        )
        self.assertEqual(fp1, fp2)

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
        fingerprint = app_module.payment_fingerprint(account_uid, paid_date, amount)

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
        fp1 = app_module.payment_fingerprint("uid_1", "2025-02-10", "1500.00")
        fp2 = app_module.payment_fingerprint("uid_1", "10.02.2025", "1500")
        self.assertEqual(fp1, fp2)

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


if __name__ == "__main__":
    unittest.main()
