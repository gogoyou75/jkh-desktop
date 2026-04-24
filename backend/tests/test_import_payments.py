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

    def test_state_machine_allows_apply_on_validated_for_partial_apply(self):
        with app_module.app.app_context():
            res = app_module._ensure_batch_transition(DummyBatch("validated"), "apply")
            self.assertIsNone(res)

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


if __name__ == "__main__":
    unittest.main()
