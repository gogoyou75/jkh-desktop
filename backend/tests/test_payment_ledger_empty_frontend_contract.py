import os
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class PaymentLedgerEmptyFrontendContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data_source = (ROOT / "web" / "data.js").read_text(encoding="utf-8")
        cls.payment_source = (ROOT / "web" / "payment_table.js").read_text(encoding="utf-8")

    def test_nonempty_full_recalc_stays_on_server_backed_writer(self):
        body = self.payment_source.split("async function applyControlledAutoAccrualForManualRecalc", 1)[1].split("window.fullRecalcForCurrentAbonent", 1)[0]
        self.assertIn("Data.writePaymentLedgerServerBacked(abonentId, proposedRows", body)
        self.assertIn('source:"manual_full_recalc"', body)
        self.assertIn("calculatedFinalEmpty: explicitCompletedEmptyLedger", body)

    def test_unconfirmed_empty_dry_run_never_reaches_writer(self):
        body = self.payment_source.split("async function applyControlledAutoAccrualForManualRecalc", 1)[1].split("window.fullRecalcForCurrentAbonent", 1)[0]
        guard = body.index("AUTOACCRUAL_EMPTY_FINAL_NOT_CONFIRMED")
        writer = body.index("Data.writePaymentLedgerServerBacked(abonentId, proposedRows")
        self.assertLess(guard, writer)
        self.assertIn("result.completed === true && result.finalLedgerEmpty === true", body)

    def test_only_verified_full_recalc_builds_calculated_empty_contract(self):
        writer = self.data_source.split("async function writePaymentLedgerServerBacked", 1)[1].split("function createEmptyPaymentLedger", 1)[0]
        self.assertIn("opts.calculatedFinalEmpty === true", writer)
        self.assertIn('String(opts.source || "") === "manual_full_recalc"', writer)
        self.assertIn("opts.recalcLockToken", writer)
        self.assertIn('action: "CALCULATED_FINAL_EMPTY"', writer)
        self.assertIn("payment_ledger_contract", self.data_source)

    def test_payment_table_and_generic_sync_cannot_receive_calculated_empty_contract(self):
        save_body = self.payment_source.split("async function savePaymentsAndFlush", 1)[1].split("async function", 1)[0]
        self.assertNotIn("calculatedFinalEmpty", save_body)
        self.assertNotIn("recalcLockToken", save_body)
        flush_body = self.data_source.split("flushDbToServer: async function ()", 1)[1].split("},\n    ", 1)[0]
        self.assertNotIn("paymentLedgerContract", flush_body)
        self.assertNotIn("CALCULATED_FINAL_EMPTY", flush_body)

    def test_passive_snapshot_restore_and_temporary_period_do_not_write_ledger(self):
        restore = self.payment_source.split("window.JKH_restoreCanonicalSnapshotRowsForPassiveDisplay", 1)[1].split("async function loadPaymentTableImpl", 1)[0]
        for forbidden in ("writePaymentLedger", "savePaymentsAndFlush", "flushDbToServer"):
            self.assertNotIn(forbidden, restore)
        period = self.data_source.split("async function resetCalcPeriodKeysForAbonent", 1)[1].split("function resolvePaymentLedgerKey", 1)[0]
        self.assertNotIn("writePaymentLedger", period)


if __name__ == "__main__":
    unittest.main()
