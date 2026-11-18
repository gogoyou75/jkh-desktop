"""Synthetic, local SQLite checks for atomic deletion and No Name assignment."""
import json
import os
import sys
import tempfile
import unittest
import threading
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

    def closed_assign(self, mode="WITH_DEBT", start="2025-02-01", operation="closed-a-c",
                      version=1, ledger_version=1, debt=None):
        with app_module.app.test_client() as client:
            return client.post("/api/closed_responsibility_assign", json={
                "operation_id": operation, "expected_version": version,
                "abonent_id": "C", "regnum": "p73", "date_from": start, "date_to": "",
                "mode": mode, "abonent": {"uid": "uid_c", "regnum": "p73", "fio": "C",
                                               "calcStartDate": start}, "initial_rows": [],
                "source_abonent_id": "A", "source_close_date": "2025-01-31",
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
                      "regnum": "p73", "date": "2025-02-01", "debtAmount": 0 if mode == "NO_DEBT" else 10000}]
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
                              "regnum": "p73", "debtAmount": 0})
        self.seed(abonents, links, {"payments_uid_a": json.dumps([{"id": "old", "year": 2025,
                  "month": 1, "accrued": 10000, "paid": 0}]),
                  "jkh_financial_events_v1": json.dumps(financial)})
        with app_module.app.app_context():
            row = app_module.KVStore.query.filter_by(owner="owner1", k="abonents_db_v1").first()
            state = json.loads(row.v)
            state["premiseEvents"] = events
            row.v = json.dumps(state)
            app_module.db.session.commit()

    def base(self):
        self.seed({"A": {"uid": "uid_a", "regnum": "p73"}, "B": {"uid": "uid_b", "regnum": "p73"}},
            [{"abonentId": "A", "regnum": "p73", "dateFrom": "2025-01-01", "dateTo": "2025-01-31"},
             {"abonentId": "B", "regnum": "p73", "dateFrom": "2025-02-01", "dateTo": ""}],
            {"payments_uid_b": json.dumps([{"id": 1, "paid": 2000, "paid_date": "2025-02-10"}]),
             "jkh_transfer_balance_v1:B:p73": json.dumps({"fromAbonentId": "A", "principal": 10000}),
             "jkh_freeze_to_v1:A": "2025-01-31",
             "jkh_frozen_debt_v1:A:2025-01-31": json.dumps({"success": True, "principal": 10000, "penalty": 0, "calculatedAt": "2025-01-31"}),
             "card_snapshot_uid_b": "personal", "note_B": "personal"})

    def test_delete_and_assign_with_original_debt(self):
        self.base()
        with app_module.app.app_context():
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


if __name__ == "__main__":
    unittest.main()
