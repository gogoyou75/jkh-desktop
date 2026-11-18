"""Opt-in MySQL 8.4 integration checks for responsibility mutations.

Run this file explicitly in an isolated runner attached to the local test
MySQL network. It deliberately is not named test_*.py, so ordinary SQLite
test discovery cannot report these checks as passed.
"""

import json
import os
import sys
import threading
from types import SimpleNamespace
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from urllib.parse import quote

from sqlalchemy import inspect, select, text


EXPECTED_HOST = "jkh-mysql-test-20261117"
if (
    os.environ.get("JKH_MYSQL_INTEGRATION") != "1"
    or os.environ.get("ENV_TYPE") != "LAB"
    or os.environ.get("DB_HOST") != EXPECTED_HOST
    or os.environ.get("ALLOWED_DB_HOST") != EXPECTED_HOST
    or os.environ.get("DB_NAME") != "jkh_test"
    or not os.environ.get("DB_USER")
    or not os.environ.get("DB_PASSWORD")
):
    raise RuntimeError("MySQL integration requires the isolated jkh_test runner environment")

# app.py constructs its URL from environment strings. Encode test-only
# credentials here so punctuation cannot change the URL's host or database.
os.environ["DB_USER"] = quote(os.environ["DB_USER"], safe="")
os.environ["DB_PASSWORD"] = quote(os.environ["DB_PASSWORD"], safe="")

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import app as app_module  # noqa: E402


class MySQLResponsibilityMutationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.context = app_module.app.app_context()
        cls.context.push()
        cls.engine = app_module.db.engine
        url = cls.engine.url
        if (
            url.get_backend_name() != "mysql"
            or url.get_driver_name() != "pymysql"
            or url.host != EXPECTED_HOST
            or url.database != "jkh_test"
        ):
            cls.context.pop()
            raise RuntimeError("Refusing non-MySQL or non-test database")
        try:
            with cls.engine.connect() as connection:
                database, version = connection.execute(
                    text("SELECT DATABASE(), VERSION()")
                ).one()
            if database != "jkh_test" or not str(version).startswith("8.4."):
                raise RuntimeError("Expected jkh_test on MySQL 8.4")
            with cls.engine.connect() as first, cls.engine.connect() as second:
                first_id = first.execute(text("SELECT CONNECTION_ID()")).scalar_one()
                second_id = second.execute(text("SELECT CONNECTION_ID()")).scalar_one()
                if first_id == second_id:
                    raise RuntimeError("Concurrent requests require independent MySQL connections")

            # Refuse a populated schema, including tables unrelated to this test.
            # The integration run must never erase pre-existing data.
            preparer = cls.engine.dialect.identifier_preparer
            with cls.engine.connect() as connection:
                for table_name in inspect(cls.engine).get_table_names():
                    quoted = preparer.quote_identifier(table_name)
                    if connection.execute(text(f"SELECT 1 FROM {quoted} LIMIT 1")).first():
                        raise RuntimeError("jkh_test is not empty; refusing to run")

            models = (
                app_module.KVStore,
                app_module.AbonentSummary,
                app_module.CardSnapshot,
                app_module.RecalcUidLock,
                app_module.RecalcBatchJob,
                app_module.RecalcBatchJobItem,
                app_module.PaymentLedgerStoreAudit,
            )
            app_module.db.metadata.create_all(
                bind=cls.engine, tables=[model.__table__ for model in models]
            )
            app_module.app.config["TESTING"] = True
        except Exception:
            cls.context.pop()
            raise

    @classmethod
    def tearDownClass(cls):
        app_module.db.session.remove()
        cls.context.pop()

    def setUp(self):
        self.owner_id = "it_" + uuid.uuid4().hex
        self.owner_patch = patch.object(
            app_module, "_session_store_owner", return_value=(None, self.owner_id, None)
        )
        self.access_patch = patch.object(
            app_module, "_require_write_access_for_key", return_value=(None, None)
        )
        self.owner_patch.start()
        self.access_patch.start()

    def tearDown(self):
        self.access_patch.stop()
        self.owner_patch.stop()
        app_module.db.session.remove()
        # Each owner is unique. Never truncate a table or delete another owner.
        with self.engine.begin() as connection:
            for table, owner_column in (
                (app_module.RecalcBatchJobItem.__table__, "owner_id"),
                (app_module.RecalcBatchJob.__table__, "owner_id"),
                (app_module.PaymentLedgerStoreAudit.__table__, "owner_id"),
                (app_module.RecalcUidLock.__table__, "owner_id"),
                (app_module.CardSnapshot.__table__, "owner_id"),
                (app_module.AbonentSummary.__table__, "owner_id"),
                (app_module.KVStore.__table__, "owner"),
            ):
                connection.execute(
                    table.delete().where(table.c[owner_column] == self.owner_id)
                )

    def seed(self, abonents, links, extra=None):
        state = {
            "abonents": abonents,
            "links": links,
            "premises": {"p73": {"flat": "73"}},
            "premiseEvents": [],
        }
        values = {"abonents_db_v1": json.dumps(state), **(extra or {})}
        with self.engine.begin() as connection:
            connection.execute(
                app_module.KVStore.__table__.insert(),
                [
                    {"owner": self.owner_id, "k": key, "v": value, "version": 1}
                    for key, value in values.items()
                ],
            )

    def seed_base(self):
        self.seed(
            {"A": {"uid": "uid_a", "regnum": "p73"},
             "B": {"uid": "uid_b", "regnum": "p73"}},
            [{"abonentId": "A", "regnum": "p73", "dateFrom": "2025-01-01", "dateTo": "2025-01-31"},
             {"abonentId": "B", "regnum": "p73", "dateFrom": "2025-02-01", "dateTo": ""}],
            {"payments_uid_b": json.dumps([{"id": 1, "paid": 2000, "paid_date": "2025-02-10"}]),
             "jkh_transfer_balance_v1:B:p73": json.dumps({"fromAbonentId": "A", "principal": 10000}),
             "jkh_freeze_to_v1:A": "2025-01-31",
             "jkh_frozen_debt_v1:A:2025-01-31": json.dumps({
                 "success": True, "principal": 10000, "penalty": 0,
                 "calculatedAt": "2025-01-31"}),
             "card_snapshot_uid_b": "personal", "note_B": "personal"},
        )

    def committed(self):
        """Read committed state with a new engine connection, not an ORM identity map."""
        with self.engine.connect() as connection:
            rows = connection.execute(
                select(app_module.KVStore.k, app_module.KVStore.v, app_module.KVStore.version)
                .where(app_module.KVStore.owner == self.owner_id)
            ).all()
            values = {row.k: row.v for row in rows}
            versions = {row.k: row.version for row in rows}
            summary_count = connection.execute(
                select(app_module.AbonentSummary.id)
                .where(app_module.AbonentSummary.owner_id == self.owner_id)
            ).all()
            snapshot_count = connection.execute(
                select(app_module.CardSnapshot.id)
                .where(app_module.CardSnapshot.owner_id == self.owner_id)
            ).all()
            audit_count = connection.execute(
                select(app_module.PaymentLedgerStoreAudit.id)
                .where(app_module.PaymentLedgerStoreAudit.owner_id == self.owner_id)
            ).all()
        return json.loads(values["abonents_db_v1"]), values, versions, len(summary_count), len(snapshot_count), len(audit_count)

    def delete(self, *, version=1, operation="delete-b", end=""):
        with app_module.app.test_client() as client:
            response = client.post("/api/abonent_delete", json={
                "operation_id": operation, "expected_version": version,
                "abonent_id": "B", "uid": "uid_b", "regnum": "p73",
                "date_from": "2025-02-01", "date_to": end,
            })
            return response.status_code, response.get_json()

    def assign(self, mode, *, version=2, operation="assign-c"):
        with app_module.app.test_client() as client:
            response = client.post("/api/no_name_assign", json={
                "operation_id": operation, "expected_version": version,
                "abonent_id": "C", "regnum": "p73",
                "date_from": "2025-02-01", "date_to": "", "mode": mode,
                "abonent": {"uid": "uid_c", "regnum": "p73", "fio": "C",
                            "calcStartDate": "2025-02-01"},
                "initial_rows": [],
            })
            return response.status_code, response.get_json()

    def test_atomic_delete_removes_personal_data_and_keeps_history(self):
        self.seed_base()
        with self.engine.begin() as connection:
            connection.execute(app_module.AbonentSummary.__table__.insert().values(
                owner_id=self.owner_id, abonent_id="B", account_uid="uid_b"))
            connection.execute(app_module.CardSnapshot.__table__.insert().values(
                owner_id=self.owner_id, abonent_id="B", abonent_uid="uid_b"))
        status, response = self.delete()
        self.assertEqual(status, 200, response)
        state, values, versions, summaries, snapshots, audits = self.committed()
        self.assertNotIn("B", state["abonents"])
        self.assertEqual(state["links"][1], {
            "technicalType": "NO_NAME", "abonentId": "", "regnum": "p73",
            "dateFrom": "2025-02-01", "dateTo": ""})
        self.assertEqual(values["payments_uid_b"], "")
        self.assertEqual(values["jkh_transfer_balance_v1:B:p73"], "")
        self.assertNotIn("note_B", values)
        self.assertNotIn("card_snapshot_uid_b", values)
        self.assertEqual((summaries, snapshots, audits), (0, 0, 1))
        self.assertEqual(versions["abonents_db_v1"], 2)
        self.assertEqual(json.loads(values["jkh_frozen_debt_v1:A:2025-01-31"])["principal"], 10000)

    def test_cas_and_replay(self):
        self.seed_base()
        self.assertEqual(self.delete(version=0)[0], 409)
        self.assertEqual(self.committed()[2]["abonents_db_v1"], 1)
        self.assertEqual(self.delete()[0], 200)
        status, replay = self.delete()
        self.assertEqual((status, replay["replay"]), (200, True))
        self.assertEqual(self.delete(operation="different-delete")[0], 409)
        state, values, versions, _, _, audits = self.committed()
        self.assertEqual(versions["abonents_db_v1"], 2)
        self.assertEqual(len([event for event in state["premiseEvents"]
                              if event["type"] == "ABONENT_DELETED"]), 1)
        self.assertEqual(audits, 1)
        self.assertEqual(values["payments_uid_b"], "")

    def test_rollback_after_partial_delete(self):
        self.seed_base()
        real_delete = app_module.db.session.delete
        calls = 0

        def fail_after_first(row):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise app_module.SQLAlchemyError("synthetic failure after first delete")
            return real_delete(row)

        with patch.object(app_module.db.session, "delete", side_effect=fail_after_first):
            self.assertEqual(self.delete()[0], 500)
        self.assertGreaterEqual(calls, 2)
        state, values, versions, _, _, audits = self.committed()
        self.assertIn("B", state["abonents"])
        self.assertEqual(versions["abonents_db_v1"], 1)
        self.assertEqual(json.loads(values["payments_uid_b"])[0]["paid"], 2000)
        self.assertEqual(json.loads(values["jkh_transfer_balance_v1:B:p73"])["principal"], 10000)
        self.assertIn("note_B", values)
        self.assertIn("card_snapshot_uid_b", values)
        self.assertEqual(audits, 0)

    def test_concurrent_different_operations_have_one_winner(self):
        self.seed_base()
        barrier = threading.Barrier(2)

        def request(operation):
            barrier.wait(timeout=10)
            return self.delete(operation=operation)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(request, ("delete-one", "delete-two")))
        self.assertEqual(sorted(status for status, _ in results), [200, 409], results)
        state, values, versions, _, _, audits = self.committed()
        self.assertEqual(versions["abonents_db_v1"], 2)
        self.assertEqual(len([e for e in state["premiseEvents"]
                              if e["type"] == "ABONENT_DELETED"]), 1)
        self.assertEqual(values["payments_uid_b"], "")
        self.assertEqual(audits, 1)

    def test_concurrent_same_operation_replays(self):
        self.seed_base()
        barrier = threading.Barrier(2)

        def request(_):
            barrier.wait(timeout=10)
            return self.delete(operation="same-delete")

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(request, (0, 1)))
        self.assertEqual([status for status, _ in results], [200, 200], results)
        self.assertEqual(sorted(body["replay"] for _, body in results), [False, True])
        self.assertEqual(self.committed()[2]["abonents_db_v1"], 2)

    def test_outgoing_debt_blocks_deletion(self):
        self.seed(
            {"A": {"uid": "uid_a", "regnum": "p73"},
             "B": {"uid": "uid_b", "regnum": "p73"},
             "D": {"uid": "uid_d", "regnum": "p73"}},
            [{"abonentId": "A", "regnum": "p73", "dateFrom": "2025-01-01", "dateTo": "2025-01-31"},
             {"abonentId": "B", "regnum": "p73", "dateFrom": "2025-02-01", "dateTo": "2025-02-28"},
             {"abonentId": "D", "regnum": "p73", "dateFrom": "2025-03-01", "dateTo": ""}],
            {"payments_uid_b": "[]",
             "jkh_transfer_balance_v1:D:p73": json.dumps({
                 "fromAbonentId": "B", "principal": 5000})},
        )
        status, response = self.delete(end="2025-02-28")
        self.assertEqual(status, 409, response)
        self.assertEqual(response["dependent_abonent_id"], "D")
        state, _, versions, _, _, _ = self.committed()
        self.assertIn("B", state["abonents"])
        self.assertEqual(versions["abonents_db_v1"], 1)

    def seed_special_73(self):
        import audit_legacy_deletion_73 as special
        self.owner_id = special.OWNER
        events = []
        financial = []
        for source, target, _, operation in special.TRANSFERS:
            events.append({"type": "RESPONSIBILITY_TRANSFER", "operationId": operation,
                "oldAbonentId": source, "newAbonentId": target,
                "transferMode": "NO_DEBT", "fromRegnums": [special.REGNUM]})
            financial.append({"type": "TRANSFER_WITHOUT_DEBT", "mode": "WITHOUT_DEBT",
                "operationId": operation, "sourceAbonentId": source,
                "targetAbonentId": target, "regnum": special.REGNUM,
                "debtAmount": 0, "balanceAmount": 0})
        state = {"abonents": {"1073": {"uid": "uid_1073", "regnum": special.REGNUM}},
                 "links": [{"abonentId": "1073", "regnum": special.REGNUM,
                            "dateFrom": "2007-06-01", "dateTo": "2007-12-31"},
                           {"technicalType": "NO_NAME", "abonentId": "",
                            "regnum": special.REGNUM, "dateFrom": "2008-01-01", "dateTo": ""}],
                 "premises": {special.REGNUM: {"flat": "73"}}, "premiseEvents": events}
        self.seed({}, [], {"jkh_financial_events_v1": json.dumps(financial),
                         "payments_uid_1073": '[{"paid":1}]',
                         "payments_" + special.TRANSFERS[0][2]: json.dumps([{"accrued":1}] * 120),
                         "payments_" + special.TRANSFERS[1][2]: json.dumps([{"accrued":2}] * 107)})
        with self.engine.begin() as connection:
            connection.execute(app_module.KVStore.__table__.update().where(
                app_module.KVStore.owner == self.owner_id,
                app_module.KVStore.k == "abonents_db_v1").values(v=json.dumps(state)))
            for index, (_, _, uid, operation) in enumerate(special.TRANSFERS):
                for audit_uid in (("uid_1073" if index == 0 else special.TRANSFERS[0][2]), uid):
                    connection.execute(app_module.PaymentLedgerStoreAudit.__table__.insert().values(
                        owner_id=self.owner_id, account_uid=audit_uid,
                        storage_key="payments_" + audit_uid,
                        request_id=uuid.uuid4().hex, source="RESPONSIBILITY_TRANSFER",
                        action="POST", endpoint="/api/store", http_status=200,
                        guard_result="ALLOWED",
                        details_json=json.dumps({"operation_id": operation})))
        return special

    def test_historical_73_reconciles_nonempty_ledgers_atomically(self):
        special = self.seed_special_73()
        with patch.object(app_module, "ENV_TYPE", "LAB"), patch.object(
                app_module, "_legacy_73_lab_target", return_value=True), patch.object(
                app_module, "_require_admin", return_value=(
                    SimpleNamespace(id=self.owner_id, role="admin"), None)), patch.object(
                app_module, "_resolve_owner", return_value=(self.owner_id, None)):
            with app_module.app.test_client() as client:
                response = client.post("/api/legacy_deletion_reconcile_73")
        self.assertEqual(response.status_code, 200, response.get_json())
        committed, values, versions, _, _, _ = self.committed()
        self.assertIn("1073", committed["abonents"])
        self.assertEqual(values["payments_uid_1073"], '[{"paid":1}]')
        self.assertEqual(values["payments_" + special.TRANSFERS[0][2]], "")
        self.assertEqual(values["payments_" + special.TRANSFERS[1][2]], "")
        self.assertEqual(versions["abonents_db_v1"], 3)
        self.assertEqual(len(json.loads(values["jkh_financial_events_v1"])), 2)

    def test_historical_73_changed_ledger_same_count_rolls_back(self):
        special = self.seed_special_73()
        report = special.inspect_state()
        key = "payments_" + special.TRANSFERS[1][2]
        with self.engine.begin() as connection:
            row = connection.execute(select(app_module.KVStore.v).where(
                app_module.KVStore.owner == self.owner_id,
                app_module.KVStore.k == key)).scalar_one()
            changed = json.loads(row)
            changed[0]["accrued"] = 999
            connection.execute(app_module.KVStore.__table__.update().where(
                app_module.KVStore.owner == self.owner_id,
                app_module.KVStore.k == key).values(v=json.dumps(changed)))
        with self.assertRaisesRegex(ValueError, "reconciliation_failed:1089"):
            special.execute_cleanup(report, SimpleNamespace(id="synthetic-admin"), self.owner_id)
        app_module.db.session.rollback()
        _, values, versions, _, _, audits = self.committed()
        self.assertEqual(versions["abonents_db_v1"], 1)
        self.assertEqual(len(json.loads(values["payments_" + special.TRANSFERS[0][2]])), 120)
        self.assertEqual(json.loads(values[key])[0]["accrued"], 999)
        self.assertEqual(audits, 4)

    def test_historical_73_wrong_no_name_start_blocks(self):
        special = self.seed_special_73()
        with self.engine.begin() as connection:
            row = connection.execute(select(app_module.KVStore.v).where(
                app_module.KVStore.owner == self.owner_id,
                app_module.KVStore.k == "abonents_db_v1")).scalar_one()
            state = json.loads(row)
            state["links"][1]["dateFrom"] = "2008-01-02"
            connection.execute(app_module.KVStore.__table__.update().where(
                app_module.KVStore.owner == self.owner_id,
                app_module.KVStore.k == "abonents_db_v1").values(v=json.dumps(state)))
        with self.assertRaisesRegex(ValueError, "no_name_period_unverified"):
            special.inspect_state()
        self.assertEqual(self.committed()[2]["abonents_db_v1"], 1)

    def test_historical_73_rejects_test_database_even_with_lab_label(self):
        with patch.object(app_module, "ENV_TYPE", "LAB"), patch.object(
                app_module, "_require_admin", return_value=(
                    SimpleNamespace(id="synthetic-admin", role="admin"), None)):
            with app_module.app.test_client() as client:
                response = client.post("/api/legacy_deletion_reconcile_73",
                                       base_url="https://lab.valvera.ru")
        self.assertEqual(response.status_code, 403)

    def test_with_debt_uses_original_frozen_debt_once(self):
        self.seed_base()
        self.assertEqual(self.delete()[0], 200)
        status, response = self.assign("WITH_DEBT")
        self.assertEqual(status, 200, response)
        state, values, versions, _, _, _ = self.committed()
        self.assertEqual(state["links"][1]["abonentId"], "C")
        self.assertEqual(versions["abonents_db_v1"], 3)
        transfer = json.loads(values["jkh_transfer_balance_v1:C:p73"])
        self.assertEqual((transfer["principal"], transfer["penalty"]), (10000, 0))
        self.assertEqual(transfer["fromAbonentId"], "A")
        self.assertEqual(json.loads(values["payments_uid_c"]), [])
        self.assertEqual(values["payments_uid_b"], "")
        self.assertEqual(values["jkh_freeze_to_v1:A"], "2025-01-31")
        self.assertEqual(json.loads(values["jkh_frozen_debt_v1:A:2025-01-31"])["principal"], 10000)
        self.assertEqual(len([e for e in json.loads(values["jkh_financial_events_v1"])
                              if e["type"] == "TRANSFER_WITH_DEBT"]), 1)
        self.assertEqual(self.assign("WITH_DEBT")[1]["replay"], True)
        self.assertEqual(self.committed()[2]["abonents_db_v1"], 3)

    def test_no_debt_keeps_snapshot_without_incoming_balance(self):
        self.seed_base()
        self.assertEqual(self.delete()[0], 200)
        status, response = self.assign("NO_DEBT")
        self.assertEqual(status, 200, response)
        state, values, versions, _, _, _ = self.committed()
        self.assertEqual(state["links"][1]["abonentId"], "C")
        self.assertEqual(versions["abonents_db_v1"], 3)
        self.assertNotIn("jkh_transfer_balance_v1:C:p73", values)
        self.assertEqual(json.loads(values["payments_uid_c"]), [])
        self.assertEqual(values["jkh_freeze_to_v1:A"], "2025-01-31")
        self.assertEqual(json.loads(values["jkh_frozen_debt_v1:A:2025-01-31"])["principal"], 10000)

    def test_assignment_cas_and_rollback(self):
        self.seed_base()
        self.assertEqual(self.delete()[0], 200)
        before = self.committed()
        self.assertEqual(self.assign("WITH_DEBT", version=1)[0], 409)
        self.assertEqual(self.committed(), before)
        with patch.object(
            app_module.db.session, "commit",
            side_effect=app_module.SQLAlchemyError("synthetic assignment commit failure"),
        ):
            self.assertEqual(self.assign("WITH_DEBT")[0], 500)
        self.assertEqual(self.committed(), before)


if __name__ == "__main__":
    unittest.main()
