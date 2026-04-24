import os
import sys
import unittest

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

    def test_normalize_source_index_rejects_non_positive(self):
        with self.assertRaises(ValueError):
            app_module.normalize_source_index(0)

    def test_normalize_account_number_is_required(self):
        with self.assertRaises(ValueError):
            app_module.normalize_account_number(" ")

    def test_to_ledger_paid_date_uses_legacy_format(self):
        self.assertEqual(app_module.to_ledger_paid_date("2026-02-01"), "01.02.2026")


if __name__ == "__main__":
    unittest.main()
