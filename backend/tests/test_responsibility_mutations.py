"""Synthetic, local SQLite checks for atomic deletion and No Name assignment."""
import json
import os
import sys
import tempfile
import unittest
import threading
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from sqlalchemy import create_engine

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import app as app_module


class ResponsibilityMutationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.file = tempfile.NamedTemporaryFile(prefix="jkh_no_name_", suffix=".sqlite", delete=False)
        cls.file.close()
        cls.old_uri = app_module.app.config["SQLALCHEMY_DATABASE_URI"]
        app_module.app.config["TESTING"] = True
        app_module.app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///" + cls.file.name.replace("\\", "/")
        with app_module.app.app_context():
            app_module.db.session.remove()
            engines = app_module.app.extensions["sqlalchemy"].engines
            cls.old_engine = engines[None]
            for engine in list(engines.values()):
                engine.dispose()
            engines[None] = create_engine(app_module.app.config["SQLALCHEMY_DATABASE_URI"])
            app_module.db.create_all()

    @classmethod
    def tearDownClass(cls):
        with app_module.app.app_context():
            app_module.db.session.remove()
            app_module.db.engine.dispose()
            app_module.app.extensions["sqlalchemy"].engines[None] = cls.old_engine
        app_module.app.config["SQLALCHEMY_DATABASE_URI"] = cls.old_uri
        os.unlink(cls.file.name)

    def setUp(self):
        with app_module.app.app_context():
            app_module.db.session.query(app_module.KVStore).delete()
            app_module.db.session.query(app_module.AbonentSummary).delete()
            app_module.db.session.query(app_module.CardSnapshot).delete()
            app_module.db.session.query(app_module.RecalcUidLock).delete()
            app_module.db.session.query(app_module.PaymentLedgerStoreAudit).delete()
            app_module.db.session.commit()
        self.owner = patch.object(app_module, "_session_store_owner", return_value=(None, "owner1", None))
        self.access = patch.object(app_module, "_require_write_access_for_key", return_value=(None, None))
        self.owner.start()
        self.access.start()

    def tearDown(self):
        self.owner.stop()
        self.access.stop()

    def seed(self, abonents, links, extra=None):
        state = {"abonents": abonents, "links": links, "premises": {"p73": {"flat": "73"}}, "premiseEvents": []}
        values = {"abonents_db_v1": json.dumps(state), **(extra or {})}
        with app_module.app.app_context():
            for key, value in values.items():
                app_module.db.session.add(app_module.KVStore(owner="owner1", k=key, v=value, version=1))
            app_module.db.session.commit()

    def state(self):
        with app_module.app.app_context():
            rows = {row.k: row for row in app_module.KVStore.query.filter_by(owner="owner1").all()}
            return json.loads(rows["abonents_db_v1"].v), {key: row.v for key, row in rows.items()}, rows["abonents_db_v1"].version

    def delete(self, abonent_id="B", uid="uid_b", start="2025-02-01", end="", version=1, operation="delete-b"):
        with app_module.app.test_client() as client:
            return client.post("/api/abonent_delete", json={"operation_id": operation, "expected_version": version,
                "abonent_id": abonent_id, "uid": uid, "regnum": "p73", "date_from": start, "date_to": end})

    def assign(self, mode, version=2, operation="assign-c", start="2025-02-01", end=""):
        abonent = {"uid": "uid_c", "regnum": "p73", "fio": "C", "calcStartDate": start}
        with app_module.app.test_client() as client:
            return client.post("/api/no_name_assign", json={"operation_id": operation, "expected_version": version,
                "abonent_id": "C", "regnum": "p73", "date_from": start, "date_to": end,
                "mode": mode, "abonent": abonent, "initial_rows": []})

    def closed_base(self, gap=False, snapshot=False):
        rows = [{"id": "historical", "year": 2025, "month": 1, "accrued": 10000, "paid": 0}]
        links = [{"abonentId": "A", "regnum": "p73", "dateFrom": "2025-01-01", "dateTo": "2025-01-31"}]
        if gap:
            links.append({"technicalType": "NO_NAME", "abonentId": "", "regnum": "p73",
                          "dateFrom": "2025-02-01", "dateTo": ""})
        extra = {"payments_uid_a": json.dumps(rows), "jkh_freeze_to_v1:A": "2025-01-31"}
        if snapshot:
            extra["jkh_frozen_debt_v1:A:2025-01-31"] = json.dumps({
                "success": True, "principal": 10000, "penalty": 100, "calculatedAt": "2025-01-31"})
        self.seed({"A": {"uid": "uid_a", "regnum": "p73", "calcEndDate": "2025-01-31"}}, links, extra)

    def test_store_close_creates_one_open_no_name_atomically(self):
        self.seed({"A": {"uid": "uid_a", "regnum": "p73"}},
                  [{"abonentId": "A", "regnum": "p73", "dateFrom": "2025-01-01", "dateTo": ""}],
                  {"payments_uid_a": '[{"paid":100}]'})
        proposed, _, _ = self.state()
        proposed["links"][0]["dateTo"] = "2025-01-31"
        with app_module.app.test_client() as client:
            response = client.post("/api/store", json={"key": "abonents_db_v1",
                "value": json.dumps(proposed), "expected_version": 1})
        self.assertEqual(response.status_code, 200)
        state, values, version = self.state()
        self.assertEqual(version, 2)
        self.assertEqual(state["links"][1], {"technicalType": "NO_NAME", "abonentId": "",
                         "regnum": "p73", "dateFrom": "2025-02-01", "dateTo": ""})
        self.assertEqual(values["payments_uid_a"], '[{"paid":100}]')
        self.assertEqual(state["premiseEvents"], [])

    def test_store_close_with_successor_does_not_add_no_name(self):
        self.seed({"A": {"uid": "uid_a", "regnum": "p73"},
                   "B": {"uid": "uid_b", "regnum": "p73"}},
                  [{"abonentId": "A", "regnum": "p73", "dateFrom": "2025-01-01", "dateTo": ""}])
        proposed, _, _ = self.state()
        proposed["links"][0]["dateTo"] = "2025-01-31"
        proposed["links"].append({"abonentId": "B", "regnum": "p73",
                                  "dateFrom": "2025-02-01", "dateTo": ""})
        with app_module.app.test_client() as client:
            response = client.post("/api/store", json={"key": "abonents_db_v1",
                "value": json.dumps(proposed), "expected_version": 1})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.state()[0]["links"], proposed["links"])

    def test_store_close_fills_bounded_gap(self):
        self.seed({"A": {"uid": "uid_a", "regnum": "p73"},
                   "B": {"uid": "uid_b", "regnum": "p73"}},
                  [{"abonentId": "A", "regnum": "p73", "dateFrom": "2025-01-01", "dateTo": ""}])
        proposed, _, _ = self.state()
        proposed["links"][0]["dateTo"] = "2025-01-31"
        proposed["links"].append({"abonentId": "B", "regnum": "p73",
                                  "dateFrom": "2025-03-01", "dateTo": ""})
        with app_module.app.test_client() as client:
            response = client.post("/api/store", json={"key": "abonents_db_v1",
                "value": json.dumps(proposed), "expected_version": 1})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.state()[0]["links"][-1], {"technicalType": "NO_NAME",
            "abonentId": "", "regnum": "p73", "dateFrom": "2025-02-01", "dateTo": "2025-02-28"})

    def test_closed_tail_restore_73_replay_cas_and_ambiguity(self):
        regnum = "TEMP-20260501-5388"
        self.seed({"1073": {"uid": "uid_1073", "regnum": regnum}},
                  [{"abonentId": "1073", "regnum": regnum,
                    "dateFrom": "2007-06-01", "dateTo": "2007-12-31"}],
                  {"payments_uid_1073": '[{"paid":100}]'})
        with app_module.app.app_context():
            row = app_module.KVStore.query.filter_by(owner="owner1", k="abonents_db_v1").one()
            state = json.loads(row.v)
            state["premises"][regnum] = {"flat": "73", "status": "active"}
            row.v = json.dumps(state)
            app_module.db.session.commit()
        payload = {"operation_id": "restore-73", "expected_version": 1, "regnum": regnum,
                   "source_abonent_id": "1073", "source_close_date": "2007-12-31"}
        with app_module.app.test_client() as client:
            self.assertEqual(client.post("/api/no_name_restore_closed_tail", json=dict(payload, expected_version=0)).status_code, 409)
            self.assertEqual(client.post("/api/no_name_restore_closed_tail", json=payload).status_code, 200)
            replay = client.post("/api/no_name_restore_closed_tail", json=payload)
        self.assertEqual(replay.status_code, 200)
        self.assertTrue(replay.json["replay"])
        state, values, version = self.state()
        self.assertEqual(version, 2)
        self.assertEqual(state["links"][-1]["dateFrom"], "2008-01-01")
        self.assertEqual(state["links"][-1]["dateTo"], "")
        self.assertEqual(values["payments_uid_1073"], '[{"paid":100}]')
        self.assertEqual(len([e for e in state["premiseEvents"] if e["type"] == "NO_NAME_RESTORED"]), 1)

    def test_closed_tail_restore_rejects_historical_gap_without_write(self):
        self.seed({"A": {"uid": "uid_a", "regnum": "p73"},
                   "B": {"uid": "uid_b", "regnum": "p73"}},
                  [{"abonentId": "A", "regnum": "p73", "dateFrom": "2025-01-01", "dateTo": "2025-01-31"},
                   {"abonentId": "B", "regnum": "p73", "dateFrom": "2025-03-01", "dateTo": "2025-03-31"}])
        before = self.state()
        with app_module.app.test_client() as client:
            response = client.post("/api/no_name_restore_closed_tail", json={
                "operation_id": "ambiguous", "expected_version": 1, "regnum": "p73",
                "source_abonent_id": "B", "source_close_date": "2025-03-31"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.state(), before)

    def test_closed_tail_restore_commit_failure_rolls_back(self):
        self.closed_base()
        before = self.state()
        with patch.object(app_module.db.session, "commit", side_effect=app_module.SQLAlchemyError("synthetic failure")):
            with app_module.app.test_client() as client:
                response = client.post("/api/no_name_restore_closed_tail", json={
                    "operation_id": "restore-fail", "expected_version": 1, "regnum": "p73",
                    "source_abonent_id": "A", "source_close_date": "2025-01-31"})
        self.assertEqual(response.status_code, 500)
        self.assertEqual(self.state(), before)

    def test_restored_tail_assigns_with_explicit_debt_modes(self):
        for mode in ("WITH_DEBT", "NO_DEBT"):
            with self.subTest(mode=mode):
                self.closed_base()
                original_ledger = self.state()[1]["payments_uid_a"]
                with app_module.app.test_client() as client:
                    restored = client.post("/api/no_name_restore_closed_tail", json={
                        "operation_id": "restore-a", "expected_version": 1, "regnum": "p73",
                        "source_abonent_id": "A", "source_close_date": "2025-01-31"})
                self.assertEqual(restored.status_code, 200)
                self.assertEqual(self.closed_assign(mode=mode, version=2).status_code, 200)
                state, values, version = self.state()
                self.assertEqual(version, 3)
                self.assertEqual(values["payments_uid_a"], original_ledger)
                self.assertEqual(state["links"][1]["abonentId"], "C")
                if mode == "WITH_DEBT":
                    self.assertEqual(json.loads(values["jkh_transfer_balance_v1:C:p73"])["principal"], 10000)
                else:
                    self.assertNotIn("jkh_transfer_balance_v1:C:p73", values)
                with app_module.app.app_context():
                    app_module.KVStore.query.filter_by(owner="owner1").delete()
                    app_module.db.session.commit()

    def closed_assign(self, mode="WITH_DEBT", start="2025-02-01", operation="closed-a-c",
                      version=1, ledger_version=1, debt=None, source_id="A"):
        with app_module.app.test_client() as client:
            return client.post("/api/closed_responsibility_assign", json={
                "operation_id": operation, "expected_version": version,
                "abonent_id": "C", "regnum": "p73", "date_from": start, "date_to": "",
                "mode": mode, "abonent": {"uid": "uid_c", "regnum": "p73", "fio": "C",
                                               "calcStartDate": start}, "initial_rows": [],
                "source_abonent_id": source_id, "source_close_date": "2025-01-31",
                "source_ledger_version": ledger_version,
                "source_debt": debt if debt is not None else {"success": True, "principal": 10000,
                    "penalty": 100, "calculatedAt": "2025-01-31"}})

    def retry_base(self, mode="NO_DEBT", live=False, downstream=False):
        operation = "old-a-b"
        events = [{"type": "RESPONSIBILITY_TRANSFER", "operationId": operation,
                   "oldAbonentId": "A", "newAbonentId": "B", "transferMode": mode,
                   "date": "2025-02-01", "fromRegnums": ["p73"]}]
        if not live:
            events.append({"type": "ABONENT_DELETED", "operationId": "delete-b",
                           "abonentId": "B", "uid": "uid_b", "regnum": "p73",
                           "dateFrom": "2025-02-01", "dateTo": ""})
        financial = [{"type": "TRANSFER_WITHOUT_DEBT" if mode == "NO_DEBT" else "TRANSFER_WITH_DEBT",
                      "mode": "WITHOUT_DEBT" if mode == "NO_DEBT" else "WITH_DEBT",
                      "operationId": operation, "sourceAbonentId": "A", "targetAbonentId": "B",
                      "regnum": "p73", "date": "2025-02-01", "debtAmount": 0 if mode == "NO_DEBT" else 10000,
                      "balanceAmount": 0 if mode == "NO_DEBT" else 10000}]
        abonents = {"A": {"uid": "uid_a", "regnum": "p73", "calcEndDate": "2025-01-31"}}
        links = [{"abonentId": "A", "regnum": "p73", "dateFrom": "2025-01-01", "dateTo": "2025-01-31"}]
        if live:
            abonents["B"] = {"uid": "uid_b", "regnum": "p73"}
            links.append({"abonentId": "B", "regnum": "p73", "dateFrom": "2025-02-01", "dateTo": ""})
        else:
            links.append({"technicalType": "NO_NAME", "abonentId": "", "regnum": "p73",
                          "dateFrom": "2025-02-01", "dateTo": ""})
        if downstream:
            events.extend([
                {"type": "RESPONSIBILITY_TRANSFER", "operationId": "old-b-d", "oldAbonentId": "B",
                 "newAbonentId": "D", "transferMode": "NO_DEBT", "fromRegnums": ["p73"]},
                {"type": "ABONENT_DELETED", "operationId": "delete-d", "abonentId": "D",
                 "uid": "uid_d", "regnum": "p73"}])
            financial.append({"type": "TRANSFER_WITHOUT_DEBT", "mode": "WITHOUT_DEBT",
                              "operationId": "old-b-d", "sourceAbonentId": "B", "targetAbonentId": "D",
                              "regnum": "p73", "debtAmount": 0, "balanceAmount": 0})
        self.seed(abonents, links, {"payments_uid_a": json.dumps([{"id": "old", "year": 2025,
                  "month": 1, "accrued": 10000, "paid": 0}]),
                  "jkh_financial_events_v1": json.dumps(financial)})
        with app_module.app.app_context():
            row = app_module.KVStore.query.filter_by(owner="owner1", k="abonents_db_v1").first()
            state = json.loads(row.v)
            state["premiseEvents"] = events
            row.v = json.dumps(state)
            app_module.db.session.commit()

    def legacy_base(self, numeric=False):
        self.retry_base(downstream=True)
        with app_module.app.app_context():
            row = app_module.KVStore.query.filter_by(owner="owner1", k="abonents_db_v1").first()
            state = json.loads(row.v)
            state["premiseEvents"] = [event for event in state["premiseEvents"]
                                       if event["type"] != "ABONENT_DELETED"]
            if numeric:
                names = {"A": "1073", "B": "1088", "D": "1089"}
                state["abonents"] = {names.get(key, key): value
                                     for key, value in state["abonents"].items()}
                for link in state["links"]:
                    link["abonentId"] = names.get(link.get("abonentId"), link.get("abonentId"))
                for event in state["premiseEvents"]:
                    for field in ("oldAbonentId", "newAbonentId"):
                        if field in event:
                            event[field] = names.get(event[field], event[field])
                financial_row = app_module.KVStore.query.filter_by(
                    owner="owner1", k="jkh_financial_events_v1").first()
                financial = json.loads(financial_row.v)
                for event in financial:
                    for field in ("sourceAbonentId", "targetAbonentId"):
                        if field in event:
                            event[field] = names.get(event[field], event[field])
                financial_row.v = json.dumps(financial)
            row.v = json.dumps(state)
            for operation, source_uid, target_uid in (
                    ("old-a-b", "uid_a", "uid_b"), ("old-b-d", "uid_b", "uid_d")):
                for uid in (source_uid, target_uid):
                    app_module.db.session.add(app_module.PaymentLedgerStoreAudit(
                        owner_id="owner1", account_uid=uid, storage_key="payments_" + uid,
                        request_id=operation + "-" + uid, source="RESPONSIBILITY_TRANSFER",
                        action="POST", endpoint="/api/store", http_status=200,
                        guard_result="ALLOWED",
                        details_json=json.dumps({"operation_id": operation})))
            app_module.db.session.commit()

    def reconcile(self, abonent_id="B", uid="uid_b", historical="old-a-b",
                  operation="reconcile-b", version=1, regnum="p73"):
        with app_module.app.test_client() as client:
            return client.post("/api/legacy_deletion_reconcile", json={
                "operation_id": operation, "historical_operation_id": historical,
                "abonent_id": abonent_id, "uid": uid, "regnum": regnum,
                "expected_version": version})

    def base(self):
        self.seed({"A": {"uid": "uid_a", "regnum": "p73"}, "B": {"uid": "uid_b", "regnum": "p73"}},
            [{"abonentId": "A", "regnum": "p73", "dateFrom": "2025-01-01", "dateTo": "2025-01-31"},
             {"abonentId": "B", "regnum": "p73", "dateFrom": "2025-02-01", "dateTo": ""}],
            {"payments_uid_b": json.dumps([{"id": 1, "paid": 2000, "paid_date": "2025-02-10"}]),
             "jkh_transfer_balance_v1:B:p73": json.dumps({"fromAbonentId": "A", "principal": 10000}),
             "jkh_freeze_to_v1:A": "2025-01-31",
             "jkh_frozen_debt_v1:A:2025-01-31": json.dumps({"success": True, "principal": 10000, "penalty": 0, "calculatedAt": "2025-01-31"}),
             "card_snapshot_uid_b": "personal", "note_B": "personal"})

    def confirm_zero_transfer(self, source="B", target="D", operation="b-d"):
        with app_module.app.app_context():
            row = app_module.KVStore.query.filter_by(owner="owner1", k="abonents_db_v1").one()
            state = json.loads(row.v)
            state["premiseEvents"].append({"type": "RESPONSIBILITY_TRANSFER",
                "operationId": operation, "oldAbonentId": source, "newAbonentId": target,
                "transferMode": "NO_DEBT", "fromRegnums": ["p73"]})
            row.v = json.dumps(state)
            app_module.db.session.add(app_module.KVStore(owner="owner1", k="jkh_financial_events_v1",
                v=json.dumps([{"type": "TRANSFER_WITHOUT_DEBT", "mode": "WITHOUT_DEBT",
                    "operationId": operation, "sourceAbonentId": source, "targetAbonentId": target,
                    "regnum": "p73", "debtAmount": 0, "balanceAmount": 0}]), version=1))
            app_module.db.session.commit()

    def test_delete_and_assign_with_original_debt(self):
        self.base()
        with app_module.app.app_context():
            for key, value in {
                "payments_uid_a": '[{"id":"previous-payment","paid":500}]',
                "payments_B": '[{"id":"legacy-payment"}]',
                "calc_period_uid_b": '{"from":"2025-02-01"}',
                "calc_period_active_uid_b": "true",
                "report_period_uid_b": '{"from":"2025-02-01"}',
                "exclude_periods_uid_b": "[]",
                "payments_ui_collapsed_B": "{}",
                "moratorium_B": "true",
                "jkh_transfer_to_v1:B": '{"fromAbonentId":"A"}',
                "jkh_frozen_debt_v1:B:2025-02-28": '{"principal":1}',
                "jkh_financial_events_v1": json.dumps([
                    {"type": "TRANSFER_WITH_DEBT", "sourceAbonentId": "A"},
                    {"type": "CHARGE", "abonentId": "B", "uid": "uid_b", "amount": 227},
                    {"type": "CHARGE", "abonentId": "A", "uid": "uid_a", "amount": 50}]),
            }.items():
                app_module.db.session.add(app_module.KVStore(owner="owner1", k=key, v=value, version=1))
            app_module.db.session.add(app_module.AbonentSummary(owner_id="owner1", abonent_id="B", account_uid="uid_b"))
            app_module.db.session.add(app_module.CardSnapshot(owner_id="owner1", abonent_id="B", abonent_uid="uid_b"))
            app_module.db.session.commit()
        self.assertEqual(self.delete().status_code, 200)
        state, values, version = self.state()
        self.assertNotIn("B", state["abonents"])
        self.assertEqual(state["links"][1], {"technicalType": "NO_NAME", "abonentId": "", "regnum": "p73", "dateFrom": "2025-02-01", "dateTo": ""})
        self.assertEqual(values["payments_uid_b"], "")
        self.assertEqual(values["jkh_transfer_balance_v1:B:p73"], "")
        self.assertNotIn("note_B", values)
        for key in ("payments_B", "calc_period_uid_b", "calc_period_active_uid_b",
                    "report_period_uid_b", "payments_ui_collapsed_B", "moratorium_B"):
            self.assertNotIn(key, values)
        for key in ("exclude_periods_uid_b", "jkh_transfer_to_v1:B",
                    "jkh_frozen_debt_v1:B:2025-02-28"):
            self.assertEqual(values[key], "")
        self.assertEqual(values["payments_uid_a"], '[{"id":"previous-payment","paid":500}]')
        self.assertEqual(json.loads(values["jkh_financial_events_v1"]), [
            {"type": "TRANSFER_WITH_DEBT", "sourceAbonentId": "A"},
            {"type": "CHARGE", "abonentId": "A", "uid": "uid_a", "amount": 50}])
        with app_module.app.app_context():
            self.assertEqual(app_module.AbonentSummary.query.filter_by(owner_id="owner1", account_uid="uid_b").count(), 0)
            self.assertEqual(app_module.CardSnapshot.query.filter_by(owner_id="owner1", abonent_uid="uid_b").count(), 0)
        self.assertEqual(json.loads(values["jkh_frozen_debt_v1:A:2025-01-31"])["principal"], 10000)
        self.assertEqual(self.assign("WITH_DEBT", version=version).status_code, 200)
        state, values, version = self.state()
        self.assertEqual(state["links"][1]["abonentId"], "C")
        self.assertEqual(json.loads(values["jkh_transfer_balance_v1:C:p73"])["principal"], 10000)
        self.assertEqual(self.assign("WITH_DEBT", version=2).json["replay"], True)
        self.assertEqual(len([key for key in values if key.startswith("jkh_transfer_balance_v1:C:")]), 1)

    def test_no_debt_and_conflicts(self):
        self.base()
        self.assertEqual(self.delete(version=0).status_code, 409)
        self.assertEqual(self.delete().status_code, 200)
        self.assertEqual(self.delete(operation="delete-b-second").status_code, 409)
        self.assertEqual(self.delete(start="2025-02-02").status_code, 409)
        self.assertTrue(self.delete().json["replay"])
        self.assertEqual(self.assign("NO_DEBT").status_code, 200)
        state, values, version = self.state()
        self.assertNotIn("jkh_transfer_balance_v1:C:p73", values)
        self.assertEqual(values["jkh_freeze_to_v1:A"], "2025-01-31")

    def test_generic_store_cannot_erase_no_name_or_deletion_audit(self):
        self.base()
        self.assertEqual(self.delete().status_code, 200)
        state, values, version = self.state()
        for field in ("links", "premiseEvents"):
            proposed = json.loads(json.dumps(state))
            proposed[field] = []
            with app_module.app.test_client() as client:
                response = client.post("/api/store", json={"key": "abonents_db_v1",
                    "value": json.dumps(proposed), "expected_version": version})
            self.assertEqual(response.status_code, 409, response.json)
        with app_module.app.test_client() as client:
            response = client.delete("/api/store", json={"key": "abonents_db_v1",
                "expected_version": version})
        self.assertEqual(response.status_code, 409, response.json)
        self.assertEqual(self.state()[0], state)
        self.assertEqual(self.state()[2], version)

    def test_concurrent_delete_operation_ids_have_one_winner(self):
        self.base()
        barrier = threading.Barrier(2)

        def request_delete(operation):
            barrier.wait()
            response = self.delete(operation=operation)
            return response.status_code, response.json

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(request_delete, ("delete-b-one", "delete-b-two")))
        state, values, version = self.state()
        self.assertNotIn("B", state["abonents"])
        self.assertEqual(values["payments_uid_b"], "")
        self.assertEqual(len([e for e in state["premiseEvents"] if e["type"] == "ABONENT_DELETED"]), 1)
        self.assertEqual(version, 2)
        self.assertEqual(sorted(status for status, _ in results), [200, 409], results)

    def test_concurrent_retry_of_same_operation_is_replay(self):
        self.base()
        barrier = threading.Barrier(2)

        def retry():
            barrier.wait()
            response = self.delete(operation="same-delete")
            return response.status_code, response.json

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: retry(), range(2)))
        self.assertEqual([status for status, _ in results], [200, 200], results)
        self.assertEqual(sorted(data["replay"] for _, data in results), [False, True], results)
        state, values, version = self.state()
        self.assertEqual(version, 2)
        self.assertEqual(len([e for e in state["premiseEvents"] if e["type"] == "ABONENT_DELETED"]), 1)

    def test_assignment_requires_valid_original_snapshot_and_cas(self):
        self.base()
        self.assertEqual(self.delete().status_code, 200)
        self.assertEqual(self.assign("WITH_DEBT", version=1).status_code, 409)
        with app_module.app.app_context():
            debt = app_module.KVStore.query.filter_by(owner="owner1", k="jkh_frozen_debt_v1:A:2025-01-31").one()
            debt.v = ""
            app_module.db.session.commit()
        self.assertEqual(self.assign("WITH_DEBT").status_code, 409)
        state, values, version = self.state()
        self.assertNotIn("C", state["abonents"])
        self.assertNotIn("payments_uid_c", values)

    def test_assignment_commit_failure_is_atomic(self):
        self.base()
        self.assertEqual(self.delete().status_code, 200)
        with patch.object(app_module.db.session, "commit", side_effect=app_module.SQLAlchemyError("synthetic failure")):
            response = self.assign("WITH_DEBT")
        self.assertEqual(response.status_code, 500)
        state, values, version = self.state()
        self.assertNotIn("C", state["abonents"])
        self.assertNotIn("payments_uid_c", values)
        self.assertNotIn("jkh_transfer_balance_v1:C:p73", values)
        self.assertEqual(version, 2)

    def test_active_recalc_blocks_deletion(self):
        self.base()
        with app_module.app.app_context():
            app_module.db.session.add(app_module.RecalcUidLock(owner_id="owner1", abonent_uid="uid_b",
                lock_token="synthetic", status="running"))
            app_module.db.session.commit()
        response = self.delete()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json["error"], "abonent_recalc_active")
        self.assertIn("B", self.state()[0]["abonents"])

    def test_existing_atomic_transfer_route_still_commits_and_replays(self):
        self.seed({"A": {"uid": "uid_a", "regnum": "p73"}},
            [{"abonentId": "A", "regnum": "p73", "dateFrom": "2025-01-01", "dateTo": ""}],
            {"payments_uid_a": "[]"})
        before, values, version = self.state()
        event = {"type": "RESPONSIBILITY_TRANSFER", "operationId": "transfer-a-b",
                 "oldAbonentId": "A", "newAbonentId": "B", "date": "2025-02-01",
                 "transferMode": "WITH_DEBT", "oldRespTo": "2025-01-31"}
        proposed = json.loads(json.dumps(before))
        proposed["abonents"]["B"] = {"uid": "uid_b", "regnum": "p73"}
        proposed["links"][0]["dateTo"] = "2025-01-31"
        proposed["links"].append({"abonentId": "B", "regnum": "p73",
                                  "dateFrom": "2025-02-01", "dateTo": ""})
        proposed["premiseEvents"].append(event)
        transfer = {"fromAbonentId": "A", "regnum": "p73", "transferDate": "2025-02-01",
                    "transferMode": "WITH_DEBT"}
        transfer_balance = {"success": True, "startDate": "2025-02-01", "principal": 10000,
                            "penalty": 0, "regnum": "p73", "fromAbonentId": "A", "mode": "WITH_DEBT"}
        writes = {"abonents_db_v1": json.dumps(proposed), "payments_uid_a": "[]",
                  "payments_uid_b": "[]", "jkh_freeze_to_v1:A": "2025-01-31",
                  "jkh_frozen_debt_v1:A:2025-01-31": json.dumps({"success": True,
                      "principal": 10000, "penalty": 0, "calculatedAt": "2025-01-31"}),
                  "jkh_transfer_to_v1:B": json.dumps(transfer),
                  "jkh_transfer_balance_v1:B:p73": json.dumps(transfer_balance),
                  "exclude_periods_A": "[]", "exclude_periods_B": "[]",
                  "jkh_financial_events_v1": json.dumps([{"operationId": "transfer-a-b",
                      "type": "TRANSFER_WITH_DEBT"}])}
        payload = {"operation_id": "transfer-a-b", "old_id": "A", "new_id": "B",
                   "regnum": "p73", "transfer_date": "2025-02-01",
                   "freeze_date": "2025-01-31", "mode": "WITH_DEBT",
                   "writes": {key: {"expected_version": 1 if key in values else 0,
                                    "value": value} for key, value in writes.items()}}
        removed_source = json.loads(json.dumps(proposed))
        del removed_source["abonents"]["A"]
        unsafe_payload = json.loads(json.dumps(payload))
        unsafe_payload["writes"]["abonents_db_v1"]["value"] = json.dumps(removed_source)
        with app_module.app.test_client() as client:
            rejected = client.post("/api/responsibility_transfer", json=unsafe_payload)
        self.assertEqual(rejected.status_code, 409, rejected.json)
        self.assertEqual(rejected.json["error"], "old_abonent_removed")
        self.assertEqual(self.state()[2], 1)
        with app_module.app.test_client() as client:
            created = client.post("/api/responsibility_transfer", json=payload)
            replay = client.post("/api/responsibility_transfer", json=payload)
        self.assertEqual(created.status_code, 200, created.json)
        self.assertEqual(replay.status_code, 200, replay.json)
        self.assertFalse(created.json["replay"])
        self.assertTrue(replay.json["replay"])
        state, values, version = self.state()
        self.assertEqual(version, 2)
        self.assertEqual(state["links"][-1]["abonentId"], "B")
        self.assertEqual(json.loads(values["jkh_transfer_balance_v1:B:p73"])["principal"], 10000)

    def test_outgoing_recipient_blocks_deletion(self):
        self.base()
        with app_module.app.app_context():
            row = app_module.KVStore.query.filter_by(owner="owner1", k="abonents_db_v1").one()
            state = json.loads(row.v)
            state["abonents"]["D"] = {"uid": "uid_d", "regnum": "p73"}
            state["links"][1]["dateTo"] = "2025-02-28"
            state["links"].append({"abonentId": "D", "regnum": "p73", "dateFrom": "2025-03-01", "dateTo": ""})
            row.v = json.dumps(state)
            app_module.db.session.add(app_module.KVStore(owner="owner1", k="jkh_transfer_balance_v1:D:p73",
                v=json.dumps({"fromAbonentId": "B", "principal": 5000}), version=1))
            app_module.db.session.commit()
        response = self.delete(end="2025-02-28")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json["dependent_abonent_id"], "D")
        self.assertIn("B", self.state()[0]["abonents"])

    def test_manual_reverse_order_unblocks_source(self):
        self.seed({"B": {"uid": "uid_b", "regnum": "p73"}, "D": {"uid": "uid_d", "regnum": "p73"}},
            [{"abonentId": "B", "regnum": "p73", "dateFrom": "2025-02-01", "dateTo": "2025-02-28"},
             {"abonentId": "D", "regnum": "p73", "dateFrom": "2025-03-01", "dateTo": ""}],
            {"payments_uid_b": "[]", "payments_uid_d": "[]",
             "jkh_transfer_balance_v1:D:p73": json.dumps({"fromAbonentId": "B", "principal": 5000})})
        self.assertEqual(self.delete(end="2025-02-28").status_code, 409)
        self.assertEqual(self.delete("D", "uid_d", "2025-03-01", "", operation="delete-d").status_code, 200)
        self.assertEqual(self.delete(end="2025-02-28", version=2).status_code, 200)
        state, values, version = self.state()
        self.assertEqual([link["technicalType"] for link in state["links"]], ["NO_NAME", "NO_NAME"])
        self.assertEqual(values["jkh_transfer_balance_v1:D:p73"], "")

    def test_orphan_outgoing_balance_still_blocks_source_deletion(self):
        self.seed({"A": {"uid": "uid_a", "regnum": "p73"}},
            [{"abonentId": "A", "regnum": "p73", "dateFrom": "2025-01-01", "dateTo": ""}],
            {"payments_uid_a": "[]", "jkh_transfer_balance_v1:B:p73": json.dumps({
                "fromAbonentId": "A", "regnum": "p73", "principal": 10000})})
        with app_module.app.test_client() as client:
            response = client.post("/api/abonent_delete", json={"operation_id": "delete-a",
                "expected_version": 1, "abonent_id": "A", "uid": "uid_a", "regnum": "p73",
                "date_from": "2025-01-01", "date_to": ""})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json["dependent_abonent_id"], "B")
        self.assertEqual(self.state()[2], 1)

    def test_database_failure_rolls_back_all_changes(self):
        self.base()
        with patch.object(app_module.db.session, "commit", side_effect=app_module.SQLAlchemyError("synthetic failure")):
            response = self.delete()
        self.assertEqual(response.status_code, 500)
        state, values, version = self.state()
        self.assertIn("B", state["abonents"])
        self.assertTrue(values["payments_uid_b"])
        self.assertEqual(version, 1)

    def test_failure_after_first_personal_delete_rolls_back(self):
        self.base()
        real_delete = app_module.db.session.delete
        deleted = 0

        def fail_after_first(row):
            nonlocal deleted
            deleted += 1
            if deleted == 2:
                raise app_module.SQLAlchemyError("synthetic mid-transaction failure")
            return real_delete(row)

        with patch.object(app_module.db.session, "delete", side_effect=fail_after_first):
            response = self.delete()
        self.assertEqual(response.status_code, 500)
        self.assertGreaterEqual(deleted, 2)
        state, values, version = self.state()
        self.assertIn("B", state["abonents"])
        self.assertEqual(json.loads(values["payments_uid_b"])[0]["paid"], 2000)
        self.assertEqual(json.loads(values["jkh_transfer_balance_v1:B:p73"])["principal"], 10000)
        self.assertIn("note_B", values)
        self.assertIn("card_snapshot_uid_b", values)
        self.assertEqual(version, 1)

    def test_first_and_closed_middle_periods(self):
        for start, end, links in (
            ("2025-01-01", "2025-01-31", [{"abonentId": "B", "regnum": "p73", "dateFrom": "2025-01-01", "dateTo": "2025-01-31"}, {"abonentId": "D", "regnum": "p73", "dateFrom": "2025-02-01", "dateTo": ""}]),
            ("2025-02-01", "2025-02-28", [{"abonentId": "A", "regnum": "p73", "dateFrom": "2025-01-01", "dateTo": "2025-01-31"}, {"abonentId": "B", "regnum": "p73", "dateFrom": "2025-02-01", "dateTo": "2025-02-28"}, {"abonentId": "D", "regnum": "p73", "dateFrom": "2025-03-01", "dateTo": ""}]),
        ):
            with self.subTest(start=start):
                with app_module.app.app_context():
                    app_module.db.session.query(app_module.KVStore).delete()
                    app_module.db.session.commit()
                self.seed({key: {"uid": "uid_" + key.lower(), "regnum": "p73"} for key in {link["abonentId"] for link in links}}, links,
                    {"payments_uid_b": "[]"})
                self.confirm_zero_transfer()
                self.assertEqual(self.delete(start=start, end=end, operation="delete-" + start).status_code, 200)
                state, values, version = self.state()
                self.assertEqual([(l["dateFrom"], l["dateTo"]) for l in state["links"]],
                    [(l["dateFrom"], l["dateTo"]) for l in links])
                self.assertEqual(self.assign("NO_DEBT", version=version, operation="assign-" + start, start=start, end=end).status_code, 200)

    def test_closed_middle_gap_with_debt_preserves_neighbors(self):
        self.seed({"A": {"uid": "uid_a", "regnum": "p73"},
                   "B": {"uid": "uid_b", "regnum": "p73"},
                   "D": {"uid": "uid_d", "regnum": "p73"}},
            [{"abonentId": "A", "regnum": "p73", "dateFrom": "2025-01-01", "dateTo": "2025-01-31"},
             {"abonentId": "B", "regnum": "p73", "dateFrom": "2025-02-01", "dateTo": "2025-02-28"},
             {"abonentId": "D", "regnum": "p73", "dateFrom": "2025-03-01", "dateTo": ""}],
            {"payments_uid_b": "[]", "jkh_freeze_to_v1:A": "2025-01-31",
             "jkh_frozen_debt_v1:A:2025-01-31": json.dumps({"success": True, "principal": 10000,
                 "penalty": 100, "calculatedAt": "2025-01-31"})})
        self.confirm_zero_transfer()
        self.assertEqual(self.delete(end="2025-02-28").status_code, 200)
        self.assertEqual(self.assign("WITH_DEBT", start="2025-02-01", end="2025-02-28").status_code, 200)
        state, values, version = self.state()
        self.assertEqual([(l["abonentId"], l["dateFrom"], l["dateTo"]) for l in state["links"]],
            [("A", "2025-01-01", "2025-01-31"), ("C", "2025-02-01", "2025-02-28"),
             ("D", "2025-03-01", "")])
        self.assertEqual(json.loads(values["jkh_transfer_balance_v1:C:p73"])["penalty"], 100)

    def test_overlapping_period_blocks_delete_without_changes(self):
        self.seed({"A": {"uid": "uid_a", "regnum": "p73"},
                   "B": {"uid": "uid_b", "regnum": "p73"}},
            [{"abonentId": "A", "regnum": "p73", "dateFrom": "2025-01-01", "dateTo": "2025-02-05"},
             {"abonentId": "B", "regnum": "p73", "dateFrom": "2025-02-01", "dateTo": ""}],
            {"payments_uid_b": "[]"})
        response = self.delete()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json["error"], "delete_period_conflict")
        state, values, version = self.state()
        self.assertIn("B", state["abonents"])
        self.assertEqual(values["payments_uid_b"], "[]")
        self.assertEqual(version, 1)

    def test_closed_predecessor_with_debt_preserves_history(self):
        self.closed_base()
        original_ledger = self.state()[1]["payments_uid_a"]
        response = self.closed_assign()
        self.assertEqual(response.status_code, 200, response.json)
        state, values, version = self.state()
        self.assertEqual(version, 2)
        self.assertEqual(values["payments_uid_a"], original_ledger)
        self.assertEqual(state["links"][0]["dateTo"], "2025-01-31")
        self.assertEqual(state["links"][1]["dateFrom"], "2025-02-01")
        self.assertEqual(len(state["links"]), 2)
        incoming = json.loads(values["jkh_transfer_balance_v1:C:p73"])
        self.assertEqual((incoming["principal"], incoming["penalty"]), (10000, 100))
        self.assertEqual(json.loads(values["jkh_frozen_debt_v1:A:2025-01-31"])["principal"], 10000)
        event = json.loads(values["jkh_financial_events_v1"])[0]
        self.assertEqual((event["sourceAbonentId"], event["targetAbonentId"], event["freezeDate"]),
                         ("A", "C", "2025-01-31"))
        self.assertEqual(self.closed_assign().json["replay"], True)
        self.assertEqual(self.state()[2], 2)

    def test_closed_predecessor_no_debt_and_gap(self):
        self.closed_base()
        self.assertEqual(self.closed_assign(mode="NO_DEBT", start="2025-03-01").status_code, 200)
        state, values, version = self.state()
        self.assertEqual([(link["dateFrom"], link["dateTo"]) for link in state["links"]],
                         [("2025-01-01", "2025-01-31"), ("2025-02-01", "2025-02-28"),
                          ("2025-03-01", "")])
        self.assertEqual(state["links"][1]["technicalType"], "NO_NAME")
        self.assertNotIn("jkh_transfer_balance_v1:C:p73", values)
        self.assertEqual(json.loads(values["jkh_financial_events_v1"])[0]["mode"], "NO_DEBT")
        self.assertEqual(self.closed_assign(mode="NO_DEBT", start="2025-03-01",
                                           operation="other", version=version).status_code, 409)

    def test_closed_predecessor_splits_existing_no_name(self):
        self.closed_base(gap=True)
        self.assertEqual(self.closed_assign(start="2025-03-01").status_code, 200)
        state, _, _ = self.state()
        self.assertEqual(state["links"][1]["dateTo"], "2025-02-28")
        self.assertEqual(state["links"][2]["dateFrom"], "2025-03-01")

    def test_closed_predecessor_conflicts_and_rollback(self):
        self.closed_base(snapshot=True)
        self.assertEqual(self.closed_assign(version=0).status_code, 409)
        self.assertEqual(self.closed_assign(ledger_version=0).status_code, 409)
        self.assertEqual(self.closed_assign(debt={"success": True, "principal": 9999,
            "penalty": 100, "calculatedAt": "2025-01-31"}).status_code, 409)
        with patch.object(app_module.db.session, "commit", side_effect=app_module.SQLAlchemyError("synthetic failure")):
            self.assertEqual(self.closed_assign().status_code, 500)
        state, values, version = self.state()
        self.assertEqual(version, 1)
        self.assertNotIn("C", state["abonents"])
        self.assertNotIn("payments_uid_c", values)
        self.assertNotIn("jkh_transfer_balance_v1:C:p73", values)

    def test_closed_predecessor_blocks_post_close_payment_in_legacy_date_format(self):
        self.closed_base()
        with app_module.app.app_context():
            row = app_module.KVStore.query.filter_by(owner="owner1", k="payments_uid_a").first()
            row.v = json.dumps([{"id": "late", "paid": 100, "paid_date": "10.02.2025"}])
            app_module.db.session.commit()
        response = self.closed_assign()
        self.assertEqual(response.status_code, 409, response.json)
        state, values, version = self.state()
        self.assertEqual(version, 1)
        self.assertNotIn("C", state["abonents"])
        self.assertNotIn("jkh_transfer_balance_v1:C:p73", values)

    def test_closed_predecessor_concurrent_operations_have_one_winner(self):
        self.closed_base()
        barrier = threading.Barrier(2)
        def request(operation):
            barrier.wait(timeout=5)
            response = self.closed_assign(operation=operation)
            return response.status_code, response.json
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(request, ("closed-first", "closed-second")))
        self.assertEqual(sorted(status for status, _ in results), [200, 409], results)
        state, values, version = self.state()
        self.assertEqual(version, 2)
        self.assertEqual(len([event for event in state["premiseEvents"]
                              if event["type"] == "CLOSED_RESPONSIBILITY_ASSIGNED"]), 1)
        self.assertEqual(len(json.loads(values["jkh_financial_events_v1"])), 1)

    def test_closed_predecessor_concurrent_replay(self):
        self.closed_base()
        barrier = threading.Barrier(2)
        def request(_):
            barrier.wait(timeout=5)
            response = self.closed_assign(operation="same-closed-operation")
            return response.status_code, response.json
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(request, range(2)))
        self.assertEqual([status for status, _ in results], [200, 200], results)
        self.assertEqual(sorted(body["replay"] for _, body in results), [False, True])
        self.assertEqual(self.state()[2], 2)

    def test_retry_deleted_no_debt_with_debt_records_linked_event(self):
        self.retry_base()
        original = self.state()[1]["payments_uid_a"]
        self.assertEqual(self.closed_assign().status_code, 200)
        state, values, version = self.state()
        self.assertEqual(version, 2)
        self.assertEqual(values["payments_uid_a"], original)
        self.assertEqual(state["links"][0]["dateTo"], "2025-01-31")
        self.assertEqual(json.loads(values["jkh_transfer_balance_v1:C:p73"])["principal"], 10000)
        events = json.loads(values["jkh_financial_events_v1"])
        self.assertEqual(len(events), 2)
        self.assertEqual(events[1]["replacesOperationId"], "old-a-b")
        self.assertEqual((events[1]["sourcePrincipal"], events[1]["sourcePenalty"]), (10000, 100))
        self.assertEqual(self.closed_assign().json["replay"], True)

    def test_retry_deleted_no_debt_without_debt_keeps_old_obligation(self):
        self.retry_base(downstream=True)
        self.assertEqual(self.closed_assign(mode="NO_DEBT").status_code, 200)
        state, values, _ = self.state()
        self.assertNotIn("jkh_transfer_balance_v1:C:p73", values)
        self.assertEqual(len(json.loads(values["jkh_financial_events_v1"])), 3)
        self.assertEqual(json.loads(values["jkh_financial_events_v1"])[-1]["replacesOperationId"], "old-a-b")
        self.assertIn("A", state["abonents"])

    def test_retry_blocks_with_debt_history_and_live_recipient(self):
        for mode, live in (("WITH_DEBT", False), ("NO_DEBT", True)):
            with self.subTest(mode=mode, live=live):
                self.retry_base(mode=mode, live=live)
                before = self.state()
                self.assertEqual(self.closed_assign().status_code, 409)
                self.assertEqual(self.state(), before)
                with app_module.app.app_context():
                    app_module.KVStore.query.filter_by(owner="owner1").delete()
                    app_module.db.session.commit()

    def test_retry_rollback_keeps_historical_operation(self):
        self.retry_base()
        before = self.state()
        with patch.object(app_module.db.session, "commit", side_effect=app_module.SQLAlchemyError("synthetic retry failure")):
            self.assertEqual(self.closed_assign().status_code, 500)
        self.assertEqual(self.state(), before)

    def test_retry_requires_deletion_evidence(self):
        self.retry_base()
        with app_module.app.app_context():
            row = app_module.KVStore.query.filter_by(owner="owner1", k="abonents_db_v1").first()
            state = json.loads(row.v)
            state["premiseEvents"] = [e for e in state["premiseEvents"] if e["type"] != "ABONENT_DELETED"]
            row.v = json.dumps(state)
            app_module.db.session.commit()
        self.assertEqual(self.closed_assign().status_code, 409)
        self.assertEqual(self.state()[2], 1)

    def test_no_name_route_cannot_bypass_retry_review(self):
        self.retry_base()
        response = self.assign("NO_DEBT", version=1)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json["error"], "assignment_requires_closed_retry_review")
        self.assertEqual(self.state()[2], 1)

    def test_retry_concurrent_operations_have_one_winner(self):
        self.retry_base()
        barrier = threading.Barrier(2)
        def request(operation):
            barrier.wait(timeout=5)
            return self.closed_assign(operation=operation)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(request, ("retry-one", "retry-two")))
        self.assertEqual(sorted(response.status_code for response in results), [200, 409])
        self.assertEqual(len(json.loads(self.state()[1]["jkh_financial_events_v1"])), 2)

    def test_legacy_reconciliation_chain_allows_closed_retry(self):
        self.legacy_base(numeric=True)
        self.assertEqual(self.closed_assign(source_id="1073").status_code, 409)
        self.assertEqual(self.reconcile("1088").status_code, 200)
        self.assertEqual(self.closed_assign(version=2, source_id="1073").status_code, 409)
        self.assertEqual(self.reconcile("1089", "uid_d", "old-b-d", "reconcile-d", 2).status_code, 200)
        state, values, version = self.state()
        self.assertEqual(version, 3)
        reconciled = [e for e in state["premiseEvents"] if e["type"] == "LEGACY_DELETION_RECONCILED"]
        self.assertEqual([(e["abonentId"], e["uid"], e["historicalOperationId"], e["ownerId"])
                          for e in reconciled], [
                          ("1088", "uid_b", "old-a-b", "owner1"),
                          ("1089", "uid_d", "old-b-d", "owner1")])
        self.assertFalse(any(e["type"] == "ABONENT_DELETED" for e in state["premiseEvents"]))
        self.assertEqual(self.closed_assign(version=3, source_id="1073").status_code, 200)
        state, values, version = self.state()
        self.assertEqual(version, 4)
        self.assertEqual(json.loads(values["jkh_transfer_balance_v1:C:p73"])["principal"], 10000)
        self.assertEqual(json.loads(values["jkh_financial_events_v1"])[-1]["replacesOperationId"], "old-a-b")
        self.assertIn("1073", state["abonents"])

    def test_legacy_reconciliation_cleans_only_deleted_identity(self):
        self.legacy_base()
        with app_module.app.app_context():
            for key, value in (("payments_uid_b", "[]"),
                               ("note_B", "old note")):
                app_module.db.session.add(app_module.KVStore(owner="owner1", k=key, v=value, version=1))
            app_module.db.session.add(app_module.AbonentSummary(
                owner_id="owner1", account_uid="uid_b", abonent_id="B"))
            app_module.db.session.commit()
        self.assertEqual(self.reconcile().status_code, 200)
        state, values, _ = self.state()
        self.assertEqual(values["payments_uid_b"], "")
        self.assertNotIn("note_B", values)
        self.assertNotIn("B", state["abonents"])
        self.assertEqual(len(json.loads(values["jkh_financial_events_v1"])), 2)
        with app_module.app.app_context():
            self.assertIsNone(app_module.AbonentSummary.query.filter_by(
                owner_id="owner1", account_uid="uid_b").first())

    def test_legacy_reconciliation_does_not_infer_balance_from_zero_transfer(self):
        self.legacy_base()
        with app_module.app.app_context():
            app_module.db.session.add(app_module.KVStore(
                owner="owner1", k="payments_uid_b",
                v=json.dumps([{"accrued": 227, "paid": 0}]), version=1))
            app_module.db.session.commit()
        before = self.state()
        self.assertEqual(self.reconcile().status_code, 409)
        self.assertEqual(self.state(), before)

    def special_73_base(self, second_audit=True):
        import audit_legacy_deletion_73 as special
        owner = special.OWNER
        uid_a = "uid_1073"
        state = {"abonents": {"1073": {"uid": uid_a, "regnum": special.REGNUM,
                                          "fio": "Tarasenko"}},
                 "links": [{"abonentId": "1073", "regnum": special.REGNUM,
                            "dateFrom": "2007-06-01", "dateTo": "2007-12-31"},
                           {"technicalType": "NO_NAME", "abonentId": "",
                            "regnum": special.REGNUM, "dateFrom": "2008-01-01",
                            "dateTo": ""}],
                 "premises": {special.REGNUM: {"flat": "73"}, "other": {"flat": "74"}},
                 "premiseEvents": []}
        financial = []
        for source, target, _, operation in special.TRANSFERS:
            state["premiseEvents"].append({"type": "RESPONSIBILITY_TRANSFER",
                "operationId": operation, "oldAbonentId": source, "newAbonentId": target,
                "transferMode": "NO_DEBT", "fromRegnums": [special.REGNUM]})
            financial.append({"type": "TRANSFER_WITHOUT_DEBT", "mode": "WITHOUT_DEBT",
                "operationId": operation, "sourceAbonentId": source,
                "targetAbonentId": target, "regnum": special.REGNUM,
                "debtAmount": 0, "balanceAmount": 0})
        with app_module.app.app_context():
            for key, value in {
                "abonents_db_v1": json.dumps(state),
                "jkh_financial_events_v1": json.dumps(financial),
                "payments_" + uid_a: '[{"paid":500}]',
                "payments_" + special.TRANSFERS[0][2]: json.dumps([{"accrued": 1}] * 120),
                "payments_" + special.TRANSFERS[1][2]: json.dumps([{"accrued": 2}] * 107),
                "note_1088": "old note",
                "jkh_frozen_debt_v1:1088:2025-02-28": '{"principal": 100}',
            }.items():
                app_module.db.session.add(app_module.KVStore(
                    owner=owner, k=key, v=value, version=1))
            for index, (_, _, target_uid, operation) in enumerate(special.TRANSFERS):
                app_module.db.session.add(app_module.AbonentSummary(
                    owner_id=owner, account_uid=target_uid,
                    abonent_id=special.TRANSFERS[index][1],
                    total_accrued=227, total_debt=227))
                app_module.db.session.add(app_module.CardSnapshot(
                    owner_id=owner, abonent_uid=target_uid,
                    abonent_id=special.TRANSFERS[index][1]))
                if index == 1 and not second_audit:
                    continue
                source_uid = uid_a if index == 0 else special.TRANSFERS[0][2]
                for uid in (source_uid, target_uid):
                    app_module.db.session.add(app_module.PaymentLedgerStoreAudit(
                        owner_id=owner, account_uid=uid, storage_key="payments_" + uid,
                        request_id=operation + uid, source="RESPONSIBILITY_TRANSFER",
                        action="POST", endpoint="/api/store", http_status=200,
                        guard_result="ALLOWED",
                        details_json=json.dumps({"operation_id": operation})))
            app_module.db.session.commit()
        return special

    def test_special_73_reconciles_227_rows_without_claiming_zero_balance(self):
        special = self.special_73_base()
        with patch.object(app_module, "ENV_TYPE", "LAB"), patch.object(
                app_module, "_legacy_73_lab_target", return_value=True), patch.object(
                app_module, "_require_admin", return_value=(
                    SimpleNamespace(id=special.OWNER, role="admin"), None)), patch.object(
                app_module, "_resolve_owner", return_value=(special.OWNER, None)):
            with app_module.app.test_client() as client:
                response = client.post("/api/legacy_deletion_reconcile_73")
        self.assertEqual(response.status_code, 200, response.json)
        with app_module.app.app_context():
            rows = {row.k: row.v for row in app_module.KVStore.query.filter_by(
                owner=special.OWNER).all()}
            state = json.loads(rows["abonents_db_v1"])
            self.assertEqual(state["abonents"]["1073"]["fio"], "Tarasenko")
            self.assertEqual(json.loads(rows["payments_uid_1073"]), [{"paid": 500}])
            self.assertEqual(rows["payments_" + special.TRANSFERS[0][2]], "")
            self.assertEqual(rows["payments_" + special.TRANSFERS[1][2]], "")
            self.assertNotIn("note_1088", rows)
            self.assertEqual(rows["jkh_frozen_debt_v1:1088:2025-02-28"], "")
            self.assertEqual([e["type"] for e in state["premiseEvents"][-2:]],
                             ["LEGACY_DELETION_RECONCILED"] * 2)
            self.assertFalse(any(e["type"] == "ABONENT_DELETED"
                                 for e in state["premiseEvents"]))
            self.assertEqual(len(json.loads(rows["jkh_financial_events_v1"])), 2)
            self.assertEqual(app_module.AbonentSummary.query.filter_by(owner_id=special.OWNER).count(), 0)
            self.assertEqual(app_module.CardSnapshot.query.filter_by(owner_id=special.OWNER).count(), 0)

    def test_special_73_reconciles_already_removed_recipients_atomically(self):
        special = self.special_73_base()
        with app_module.app.app_context():
            for _, target, uid, _ in special.TRANSFERS:
                app_module.KVStore.query.filter_by(
                    owner=special.OWNER, k="payments_" + uid).delete()
                app_module.AbonentSummary.query.filter_by(
                    owner_id=special.OWNER, account_uid=uid).delete()
                app_module.CardSnapshot.query.filter_by(
                    owner_id=special.OWNER, abonent_uid=uid).delete()
            app_module.KVStore.query.filter_by(owner=special.OWNER, k="note_1088").delete()
            app_module.KVStore.query.filter_by(
                owner=special.OWNER, k="jkh_frozen_debt_v1:1088:2025-02-28").delete()
            app_module.db.session.commit()
            self.assertEqual(special.inspect_state()["ledger_rows_total"], 0)
        with patch.object(app_module, "ENV_TYPE", "LAB"), patch.object(
                app_module, "_legacy_73_lab_target", return_value=True), patch.object(
                app_module, "_require_admin", return_value=(
                    SimpleNamespace(id=special.OWNER, role="admin"), None)), patch.object(
                app_module, "_resolve_owner", return_value=(special.OWNER, None)):
            with app_module.app.test_client() as client:
                response = client.post("/api/legacy_deletion_reconcile_73")
                repeat = client.post("/api/legacy_deletion_reconcile_73")
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(repeat.status_code, 409)
        with app_module.app.app_context():
            state_row = app_module.KVStore.query.filter_by(
                owner=special.OWNER, k="abonents_db_v1").one()
            state = json.loads(state_row.v)
            self.assertEqual(state_row.version, 3)
            self.assertEqual(state["abonents"]["1073"]["fio"], "Tarasenko")
            self.assertEqual(state["links"][1]["technicalType"], "NO_NAME")
            self.assertEqual([e["abonentId"] for e in state["premiseEvents"][-2:]],
                             ["1088", "1089"])
            self.assertEqual(len(json.loads(app_module.KVStore.query.filter_by(
                owner=special.OWNER, k="jkh_financial_events_v1").one().v)), 2)

    def test_special_73_rejects_partial_prior_cleanup(self):
        special = self.special_73_base()
        with app_module.app.app_context():
            for _, _, uid, _ in special.TRANSFERS:
                app_module.KVStore.query.filter_by(
                    owner=special.OWNER, k="payments_" + uid).delete()
            app_module.db.session.commit()
            with self.assertRaisesRegex(ValueError, "historical_cleanup_incomplete"):
                special.inspect_state()

    def test_special_73_removed_recipients_roll_back_if_audit_missing(self):
        special = self.special_73_base(second_audit=False)
        with app_module.app.app_context():
            for _, _, uid, _ in special.TRANSFERS:
                app_module.KVStore.query.filter_by(
                    owner=special.OWNER, k="payments_" + uid).delete()
                app_module.AbonentSummary.query.filter_by(
                    owner_id=special.OWNER, account_uid=uid).delete()
                app_module.CardSnapshot.query.filter_by(
                    owner_id=special.OWNER, abonent_uid=uid).delete()
            app_module.KVStore.query.filter_by(owner=special.OWNER, k="note_1088").delete()
            app_module.KVStore.query.filter_by(
                owner=special.OWNER, k="jkh_frozen_debt_v1:1088:2025-02-28").delete()
            app_module.db.session.commit()
        with patch.object(app_module, "ENV_TYPE", "LAB"), patch.object(
                app_module, "_legacy_73_lab_target", return_value=True), patch.object(
                app_module, "_require_admin", return_value=(
                    SimpleNamespace(id=special.OWNER, role="admin"), None)), patch.object(
                app_module, "_resolve_owner", return_value=(special.OWNER, None)):
            with app_module.app.test_client() as client:
                response = client.post("/api/legacy_deletion_reconcile_73")
        self.assertEqual(response.status_code, 409)
        with app_module.app.app_context():
            row = app_module.KVStore.query.filter_by(
                owner=special.OWNER, k="abonents_db_v1").one()
            self.assertEqual(row.version, 1)
            self.assertFalse(any(e["type"] == "LEGACY_DELETION_RECONCILED"
                                 for e in json.loads(row.v)["premiseEvents"]))

    def test_special_73_rolls_back_both_when_second_identity_unverified(self):
        special = self.special_73_base(second_audit=False)
        with patch.object(app_module, "ENV_TYPE", "LAB"), patch.object(
                app_module, "_legacy_73_lab_target", return_value=True), patch.object(
                app_module, "_require_admin", return_value=(
                    SimpleNamespace(id=special.OWNER, role="admin"), None)), patch.object(
                app_module, "_resolve_owner", return_value=(special.OWNER, None)):
            with app_module.app.test_client() as client:
                response = client.post("/api/legacy_deletion_reconcile_73")
        self.assertEqual(response.status_code, 409)
        with app_module.app.app_context():
            rows = {row.k: row for row in app_module.KVStore.query.filter_by(
                owner=special.OWNER).all()}
            self.assertEqual(rows["abonents_db_v1"].version, 1)
            self.assertEqual(len(json.loads(rows["payments_" + special.TRANSFERS[0][2]].v)), 120)
            self.assertEqual(len(json.loads(rows["payments_" + special.TRANSFERS[1][2]].v)), 107)
            self.assertFalse(any(e["type"] == "LEGACY_DELETION_RECONCILED" for e in
                                 json.loads(rows["abonents_db_v1"].v)["premiseEvents"]))

    def test_special_73_ledger_content_conflict_rolls_back_both(self):
        special = self.special_73_base()
        with app_module.app.app_context():
            report = special.inspect_state()
            key = "payments_" + special.TRANSFERS[1][2]
            row = app_module.KVStore.query.filter_by(owner=special.OWNER, k=key).one()
            rows = json.loads(row.v)
            rows[0]["accrued"] = 999
            row.v = json.dumps(rows)
            app_module.db.session.commit()
            with self.assertRaisesRegex(ValueError, "reconciliation_failed:1089"):
                special.execute_cleanup(report, SimpleNamespace(id="test-admin"), special.OWNER)
            app_module.db.session.rollback()
            db_row = app_module.KVStore.query.filter_by(
                owner=special.OWNER, k="abonents_db_v1").one()
            self.assertEqual(db_row.version, 1)
            self.assertEqual(json.loads(app_module.KVStore.query.filter_by(
                owner=special.OWNER, k="payments_" + special.TRANSFERS[0][2]).one().v)[0]["accrued"], 1)
            self.assertEqual(json.loads(app_module.KVStore.query.filter_by(
                owner=special.OWNER, k=key).one().v)[0]["accrued"], 999)
            self.assertFalse(any(event["type"] == "LEGACY_DELETION_RECONCILED"
                                 for event in json.loads(db_row.v)["premiseEvents"]))

    def test_special_73_ledger_version_conflict_rolls_back_both(self):
        special = self.special_73_base()
        with app_module.app.app_context():
            report = special.inspect_state()
            row = app_module.KVStore.query.filter_by(
                owner=special.OWNER, k="payments_" + special.TRANSFERS[1][2]).one()
            row.version += 1
            app_module.db.session.commit()
            with self.assertRaisesRegex(ValueError, "reconciliation_failed:1089"):
                special.execute_cleanup(report, SimpleNamespace(id="test-admin"), special.OWNER)
            app_module.db.session.rollback()
            self.assertEqual(app_module.KVStore.query.filter_by(
                owner=special.OWNER, k="abonents_db_v1").one().version, 1)
            self.assertEqual(app_module.KVStore.query.filter_by(
                owner=special.OWNER, k="payments_" + special.TRANSFERS[0][2]).one().version, 1)

    def test_special_73_financial_journal_content_conflict_blocks(self):
        special = self.special_73_base()
        with app_module.app.app_context():
            report = special.inspect_state()
            row = app_module.KVStore.query.filter_by(
                owner=special.OWNER, k="jkh_financial_events_v1").one()
            events = json.loads(row.v)
            events[0]["date"] = "2008-01-01"
            row.v = json.dumps(events)
            app_module.db.session.commit()
            with self.assertRaisesRegex(ValueError, "reconciliation_failed:1088"):
                special.execute_cleanup(report, SimpleNamespace(id="test-admin"), special.OWNER)
            app_module.db.session.rollback()
            self.assertEqual(app_module.KVStore.query.filter_by(
                owner=special.OWNER, k="abonents_db_v1").one().version, 1)

    def test_special_73_requires_exact_no_name_start(self):
        special = self.special_73_base()
        with app_module.app.app_context():
            row = app_module.KVStore.query.filter_by(owner=special.OWNER, k="abonents_db_v1").one()
            state = json.loads(row.v)
            state["links"][1]["dateFrom"] = "2008-01-02"
            row.v = json.dumps(state)
            app_module.db.session.commit()
            with self.assertRaisesRegex(ValueError, "no_name_period_unverified"):
                special.inspect_state()
            self.assertEqual(row.version, 1)
            self.assertEqual(app_module.KVStore.query.filter_by(
                owner=special.OWNER, k="payments_" + special.TRANSFERS[0][2]).one().version, 1)

    def test_special_73_rejects_non_lab_database_even_with_lab_label(self):
        self.special_73_base()
        with patch.object(app_module, "ENV_TYPE", "LAB"), patch.object(
                app_module, "_require_admin",
                return_value=(SimpleNamespace(id="test-admin", role="admin"), None)):
            with app_module.app.test_client() as client:
                response = client.post("/api/legacy_deletion_reconcile_73",
                                       base_url="https://lab.valvera.ru")
        self.assertEqual(response.status_code, 403)

    def test_special_73_requires_real_lab_admin_session(self):
        special = self.special_73_base()
        with app_module.app.app_context():
            app_module.db.session.add(app_module.User(
                id=special.OWNER, email="local-test-73@example.invalid",
                password_hash=app_module.generate_password_hash("local-test-password"),
                role="user", display_name="Local test", disabled=False))
            app_module.db.session.commit()
        self.owner.stop()
        self.access.stop()
        try:
            with patch.object(app_module, "ENV_TYPE", "LAB"), patch.object(
                    app_module, "_legacy_73_lab_target", return_value=True):
                with app_module.app.test_client() as client:
                    self.assertEqual(client.post("/api/legacy_deletion_reconcile_73").status_code, 401)
                    login = client.post("/api/auth/login", json={
                        "email": "local-test-73@example.invalid",
                        "password": "local-test-password"})
                    self.assertEqual(login.status_code, 200)
                    self.assertEqual(client.post("/api/legacy_deletion_reconcile_73").status_code, 403)
                    with app_module.app.app_context():
                        user = app_module.User.query.filter_by(id=special.OWNER).one()
                        user.role = "admin"
                        app_module.db.session.commit()
                    result = client.post("/api/legacy_deletion_reconcile_73")
                    self.assertEqual(result.status_code, 200, result.json)
        finally:
            self.owner.start()
            self.access.start()
            with app_module.app.app_context():
                app_module.User.query.filter_by(id=special.OWNER).delete()
                app_module.db.session.commit()

    def test_legacy_reconciliation_requires_explicit_zero_transfer_fields(self):
        for field in ("debtAmount", "balanceAmount"):
            with self.subTest(field=field):
                self.legacy_base()
                with app_module.app.app_context():
                    row = app_module.KVStore.query.filter_by(owner="owner1", k="jkh_financial_events_v1").first()
                    events = json.loads(row.v)
                    events[0].pop(field)
                    row.v = json.dumps(events)
                    app_module.db.session.commit()
                self.assertEqual(self.reconcile().status_code, 409)
                self.assertEqual(self.state()[2], 1)
                with app_module.app.app_context():
                    app_module.PaymentLedgerStoreAudit.query.delete()
                    app_module.KVStore.query.filter_by(owner="owner1").delete()
                    app_module.db.session.commit()

    def test_delete_with_successor_requires_confirmed_zero_transfer(self):
        self.seed({"A": {"uid": "uid_a", "regnum": "p73"},
                   "B": {"uid": "uid_b", "regnum": "p73"}},
                  [{"abonentId": "A", "regnum": "p73", "dateFrom": "2025-01-01",
                    "dateTo": "2025-01-31"},
                   {"abonentId": "B", "regnum": "p73", "dateFrom": "2025-02-01",
                    "dateTo": ""}])
        self.assertEqual(self.delete(abonent_id="A", uid="uid_a", start="2025-01-01",
                                     end="2025-01-31").status_code, 409)
        with app_module.app.app_context():
            row = app_module.KVStore.query.filter_by(owner="owner1", k="abonents_db_v1").one()
            state = json.loads(row.v)
            state["premiseEvents"].append({"type": "RESPONSIBILITY_TRANSFER",
                "operationId": "a-b", "oldAbonentId": "A", "newAbonentId": "B",
                "transferMode": "NO_DEBT", "fromRegnums": ["p73"]})
            row.v = json.dumps(state)
            app_module.db.session.add(app_module.KVStore(owner="owner1", k="jkh_financial_events_v1",
                v=json.dumps([{"type": "TRANSFER_WITHOUT_DEBT", "mode": "WITHOUT_DEBT",
                    "operationId": "a-b", "sourceAbonentId": "A", "targetAbonentId": "B",
                    "regnum": "p73", "debtAmount": 0}]), version=1))
            app_module.db.session.commit()
        self.assertEqual(self.delete(abonent_id="A", uid="uid_a", start="2025-01-01",
                                     end="2025-01-31").status_code, 409)
        with app_module.app.app_context():
            row = app_module.KVStore.query.filter_by(owner="owner1", k="jkh_financial_events_v1").one()
            events = json.loads(row.v)
            events[0]["balanceAmount"] = 0
            row.v = json.dumps(events)
            app_module.db.session.commit()
        self.assertEqual(self.delete(abonent_id="A", uid="uid_a", start="2025-01-01",
                                     end="2025-01-31").status_code, 200)
        state, values, _ = self.state()
        self.assertIn("B", state["abonents"])
        self.assertEqual(json.loads(values["jkh_financial_events_v1"]), events)

    def test_legacy_reconciliation_requires_clean_verified_identity(self):
        for change in ("wrong_uid", "wrong_owner", "wrong_operation",
                       "debt_balance", "debt_event", "historical_with_debt",
                       "wrong_regnum", "missing_audit"):
            with self.subTest(change=change):
                self.legacy_base()
                with app_module.app.app_context():
                    if change == "debt_balance":
                        key, value = {
                            "debt_balance": ("jkh_transfer_balance_v1:X:p73",
                                             '{"fromAbonentId":"B","regnum":"p73","principal":500}')
                        }[change]
                        app_module.db.session.add(app_module.KVStore(
                            owner="owner1", k=key, v=value, version=1))
                    if change == "wrong_owner":
                        app_module.PaymentLedgerStoreAudit.query.filter_by(
                            owner_id="owner1", account_uid="uid_b").update({"owner_id": "other-owner"})
                    if change == "missing_audit":
                        app_module.PaymentLedgerStoreAudit.query.filter_by(
                            owner_id="owner1", account_uid="uid_b").delete()
                    if change == "debt_event":
                        row = app_module.KVStore.query.filter_by(
                            owner="owner1", k="jkh_financial_events_v1").first()
                        events = json.loads(row.v)
                        events.append({"type": "TRANSFER_WITH_DEBT", "mode": "WITH_DEBT",
                                       "operationId": "other-debt", "sourceAbonentId": "B",
                                       "targetAbonentId": "X", "regnum": "p73",
                                       "principal": 500})
                        row.v = json.dumps(events)
                    if change == "historical_with_debt":
                        row = app_module.KVStore.query.filter_by(
                            owner="owner1", k="jkh_financial_events_v1").first()
                        events = json.loads(row.v)
                        events[0]["type"] = "TRANSFER_WITH_DEBT"
                        events[0]["mode"] = "WITH_DEBT"
                        events[0]["principal"] = 10000
                        row.v = json.dumps(events)
                    app_module.db.session.commit()
                response = self.reconcile(
                    uid="uid_wrong" if change == "wrong_uid" else "uid_b",
                    historical="wrong-operation" if change == "wrong_operation" else "old-a-b",
                    regnum="other-flat" if change == "wrong_regnum" else "p73")
                self.assertEqual(response.status_code, 409, (change, response.json))
                self.assertEqual(self.state()[2], 1)
                with app_module.app.app_context():
                    app_module.PaymentLedgerStoreAudit.query.delete()
                    app_module.KVStore.query.filter_by(owner="owner1").delete()
                    app_module.db.session.commit()

    def test_legacy_reconciliation_cas_duplicate_and_store_forgery(self):
        self.legacy_base()
        self.assertEqual(self.reconcile(version=0).status_code, 409)
        state, _, _ = self.state()
        forged = json.loads(json.dumps(state))
        forged["premiseEvents"].append({"type": "LEGACY_DELETION_RECONCILED",
            "operationId": "forged", "historicalOperationId": "old-a-b",
            "ownerId": "owner1", "abonentId": "B", "uid": "uid_b", "regnum": "p73"})
        with app_module.app.test_client() as client:
            response = client.post("/api/store", json={"key": "abonents_db_v1",
                "value": json.dumps(forged), "expected_version": 1})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.reconcile().status_code, 200)
        self.assertEqual(self.reconcile().status_code, 409)
        self.assertEqual(self.reconcile(operation="second-reconciliation", version=2).status_code, 409)
        self.assertEqual(self.state()[2], 2)
        with app_module.app.app_context():
            app_module.db.session.add(app_module.KVStore(
                owner="owner1", k="payments_uid_b", v='[{"paid":100}]', version=1))
            app_module.db.session.commit()
        self.assertEqual(self.closed_assign(version=2).status_code, 409)
        self.assertEqual(self.state()[2], 2)

    def test_legacy_reconciliation_rollback(self):
        self.legacy_base()
        before = self.state()
        with patch.object(app_module.db.session, "commit",
                          side_effect=app_module.SQLAlchemyError("synthetic reconciliation failure")):
            self.assertEqual(self.reconcile().status_code, 500)
        self.assertEqual(self.state(), before)


if __name__ == "__main__":
    unittest.main()
