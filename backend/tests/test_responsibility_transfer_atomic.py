import copy
import json
import os
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import app as app_module


class ResponsibilityTransferAtomicTest(unittest.TestCase):
    owner = "synthetic-transfer-owner"
    old_id = "100"
    new_id = "101"
    regnum = "synthetic-80"
    old_uid = "uid_synthetic_old"
    new_uid = "uid_synthetic_new"
    old_key = "payments_uid_synthetic_old"
    new_key = "payments_uid_synthetic_new"

    @classmethod
    def setUpClass(cls):
        test_uri = os.getenv("JKH_TRANSFER_TEST_DATABASE_URL")
        if test_uri:
            url = make_url(test_uri)
            if url.drivername != "mysql+pymysql" or url.host != "127.0.0.1" or not url.database.startswith("transfer_synthetic_"):
                raise ValueError("transfer tests require isolated localhost synthetic MySQL")
            cls.file = None
        else:
            cls.file = tempfile.NamedTemporaryFile(prefix="jkh_transfer_atomic_", suffix=".sqlite", delete=False)
            cls.file.close()
            test_uri = "sqlite:///" + cls.file.name.replace("\\", "/")
        cls.old_uri = app_module.app.config["SQLALCHEMY_DATABASE_URI"]
        app_module.app.config["TESTING"] = True
        app_module.app.config["SQLALCHEMY_DATABASE_URI"] = test_uri
        with app_module.app.app_context():
            app_module.db.session.remove()
            engines = app_module.app.extensions["sqlalchemy"].engines
            cls.old_engine = engines[None]
            for engine in list(engines.values()):
                engine.dispose()
            engines[None] = create_engine(test_uri, **({"connect_args": {"timeout": 10}} if cls.file else {}))

    @classmethod
    def tearDownClass(cls):
        with app_module.app.app_context():
            app_module.db.session.remove()
            app_module.db.engine.dispose()
            app_module.app.extensions["sqlalchemy"].engines[None] = cls.old_engine
        app_module.app.config["SQLALCHEMY_DATABASE_URI"] = cls.old_uri
        if cls.file:
            os.unlink(cls.file.name)

    def setUp(self):
        self.db_before = {
            "abonents": {self.old_id: {"uid": self.old_uid, "fio": "Synthetic Old"}},
            "premises": {self.regnum: {"regnum": self.regnum, "flat": "80"}},
            "links": [{"abonentId": self.old_id, "regnum": self.regnum, "dateFrom": "2000-01-01", "dateTo": ""}],
            "premiseEvents": [],
        }
        self.old_rows = [{"id": i + 1, "year": 2000 + i // 12, "month": i % 12 + 1,
                          "accrued": 100, "paid": 25 if i % 10 == 0 else 0,
                          "paid_date": "2001-01-01" if i % 10 == 0 else ""} for i in range(227)]
        with app_module.app.app_context():
            app_module.db.session.remove()
            app_module.db.drop_all()
            app_module.db.create_all()
            app_module.db.session.add(app_module.User(id=self.owner, email="transfer@example.test", password_hash="x", role="user"))
            app_module.db.session.add(app_module.KVStore(owner=self.owner, k="abonents_db_v1", v=json.dumps(self.db_before), version=1))
            app_module.db.session.add(app_module.KVStore(owner=self.owner, k=self.old_key, v=json.dumps(self.old_rows), version=1))
            app_module.db.session.commit()

    def client(self):
        client = app_module.app.test_client()
        with client.session_transaction() as session:
            session["user_id"] = self.owner
        return client

    def request_body(self, mode="WITHOUT_DEBT", operation_id="synthetic-operation"):
        next_db = copy.deepcopy(self.db_before)
        next_db["abonents"][self.old_id]["calcEndDate"] = "2007-12-31"
        next_db["abonents"][self.new_id] = {"uid": self.new_uid, "fio": "Synthetic New", "calcStartDate": "2008-01-01"}
        next_db["links"][0]["dateTo"] = "2007-12-31"
        next_db["links"].append({"abonentId": self.new_id, "regnum": self.regnum, "dateFrom": "2008-01-01", "dateTo": ""})
        next_db["premiseEvents"].append({"operationId": operation_id, "type": "RESPONSIBILITY_TRANSFER", "oldAbonentId": self.old_id,
                                          "newAbonentId": self.new_id, "date": "2008-01-01", "oldRespTo": "2007-12-31", "transferMode": mode})
        values = {
            "abonents_db_v1": json.dumps(next_db),
            self.old_key: json.dumps(self.old_rows),
            self.new_key: json.dumps([{"id": 1, "year": 2008, "month": 1, "accrued": 50, "paid": 0}]),
            "jkh_freeze_to_v1:" + self.old_id: "2007-12-31",
            "jkh_frozen_debt_v1:" + self.old_id + ":2007-12-31": json.dumps({"success": True, "principal": 10, "penalty": 0, "calculatedAt": "2007-12-31"}) if mode == "WITH_DEBT" else None,
            "jkh_transfer_to_v1:" + self.new_id: json.dumps({"fromAbonentId": self.old_id}) if mode == "WITH_DEBT" else None,
            "jkh_transfer_balance_v1:" + self.new_id + ":" + self.regnum: json.dumps({"success": True, "principal": 10, "penalty": 0}) if mode == "WITH_DEBT" else None,
            "exclude_periods_" + self.old_id: None,
            "exclude_periods_" + self.new_id: "[]",
            "jkh_financial_events_v1": json.dumps([{"operationId": operation_id, "type": "TRANSFER_WITH_DEBT" if mode == "WITH_DEBT" else "TRANSFER_WITHOUT_DEBT"}]),
        }
        with app_module.app.app_context():
            writes = {}
            for key, value in values.items():
                row = app_module.KVStore.query.filter_by(owner=self.owner, k=key).first()
                writes[key] = {"expected_version": row.version if row else 0, "value": value}
        return {"client_owner_hint": self.owner, "operation_id": operation_id, "old_id": self.old_id,
                "new_id": self.new_id, "regnum": self.regnum, "transfer_date": "2008-01-01",
                "freeze_date": "2007-12-31", "mode": mode, "writes": writes}

    def test_227_rows_no_debt_commit_and_idempotent_replay(self):
        body = self.request_body()
        client = self.client()
        first = client.post("/api/responsibility_transfer", json=body)
        self.assertEqual(first.status_code, 200, first.get_json())
        self.assertTrue(first.get_json()["committed"])
        with app_module.app.app_context():
            rows = json.loads(app_module.KVStore.query.filter_by(owner=self.owner, k=self.old_key).first().v)
            self.assertEqual(rows, self.old_rows)
            self.assertEqual(app_module.KVStore.query.filter_by(owner=self.owner, k=self.new_key).count(), 1)
            audits = app_module.PaymentLedgerStoreAudit.query.order_by(app_module.PaymentLedgerStoreAudit.id).all()
            self.assertEqual(len(audits), 2)
            self.assertEqual(len({audit.request_id for audit in audits}), 2)
            self.assertEqual({audit.storage_key for audit in audits}, {self.old_key, self.new_key})
            self.assertEqual({json.loads(audit.details_json)["operation_id"] for audit in audits}, {body["operation_id"]})
        status = client.get("/api/responsibility_transfer", query_string={"operation_id": body["operation_id"]})
        self.assertEqual(status.status_code, 200)
        self.assertTrue(status.get_json()["committed"])
        replay = client.post("/api/responsibility_transfer", json=body)
        self.assertEqual(replay.status_code, 200)
        self.assertTrue(replay.get_json()["replay"])
        with app_module.app.app_context():
            db_value = json.loads(app_module.KVStore.query.filter_by(owner=self.owner, k="abonents_db_v1").first().v)
            self.assertEqual(len(db_value["premiseEvents"]), 1)
            self.assertEqual(app_module.PaymentLedgerStoreAudit.query.count(), 2)

    def test_stale_upload_cannot_replace_committed_financial_keys(self):
        body = self.request_body()
        client = self.client()
        self.assertEqual(client.post("/api/responsibility_transfer", json=body).status_code, 200)
        stale = client.post("/api/store", json={"key": self.old_key, "value": json.dumps(self.old_rows), "expected_version": 1})
        self.assertEqual(stale.status_code, 409)
        missing_version = client.post("/api/store", json={"key": self.new_key, "value": "[]"})
        self.assertEqual(missing_version.status_code, 428)
        with app_module.app.app_context():
            self.assertEqual(app_module.KVStore.query.filter_by(owner=self.owner, k=self.old_key).first().version, 2)
            self.assertEqual(app_module.KVStore.query.filter_by(owner=self.owner, k=self.new_key).first().version, 1)

    def test_with_debt_commits_transfer_balance(self):
        response = self.client().post("/api/responsibility_transfer", json=self.request_body("WITH_DEBT"))
        self.assertEqual(response.status_code, 200, response.get_json())
        with app_module.app.app_context():
            row = app_module.KVStore.query.filter_by(owner=self.owner, k="jkh_transfer_balance_v1:" + self.new_id + ":" + self.regnum).first()
            self.assertEqual(json.loads(row.v)["principal"], 10)

    def test_conflict_and_invalid_ledger_leave_all_keys_unchanged(self):
        body = self.request_body()
        body["writes"][self.old_key]["expected_version"] = 99
        self.assertEqual(self.client().post("/api/responsibility_transfer", json=body).status_code, 409)
        with app_module.app.app_context():
            self.assertIsNone(app_module.KVStore.query.filter_by(owner=self.owner, k=self.new_key).first())
            self.assertEqual(app_module.KVStore.query.filter_by(owner=self.owner, k="abonents_db_v1").first().version, 1)
        body = self.request_body()
        body["writes"][self.old_key]["value"] = "[]"
        self.assertEqual(self.client().post("/api/responsibility_transfer", json=body).status_code, 422)
        with app_module.app.app_context():
            self.assertIsNone(app_module.KVStore.query.filter_by(owner=self.owner, k=self.new_key).first())

    def test_old_client_without_version_is_rejected(self):
        client = self.client()
        response = client.post("/api/store", json={"key": self.old_key, "value": "[]"})
        self.assertEqual(response.status_code, 428)
        response = client.post("/api/store", json={"key": "abonents_db_v1", "value": "{}"})
        self.assertEqual(response.status_code, 428)
        response = client.post("/api/store", json={"key": "jkh_financial_events_v1", "value": "[]"})
        self.assertEqual(response.status_code, 428)
        with app_module.app.app_context():
            self.assertEqual(app_module.KVStore.query.filter_by(owner=self.owner, k=self.old_key).first().version, 1)
            self.assertEqual(app_module.KVStore.query.filter_by(owner=self.owner, k="abonents_db_v1").first().version, 1)
            self.assertIsNone(app_module.KVStore.query.filter_by(owner=self.owner, k="jkh_financial_events_v1").first())

    def test_dump_versions_support_cas_and_reject_stale_retry(self):
        client = self.client()
        dump = client.get("/api/store_dump").get_json()
        self.assertEqual(dump["abonents_db_version"], 1)
        self.assertEqual(dump["key_versions"][self.old_key], 1)
        next_value = json.dumps(self.old_rows + [{"id": 228, "paid": 1}])
        body = {"key": self.old_key, "value": next_value, "expected_version": dump["key_versions"][self.old_key]}
        saved = client.post("/api/store", json=body)
        self.assertEqual(saved.status_code, 200, saved.get_json())
        self.assertEqual(saved.get_json()["version"], 2)
        self.assertEqual(client.post("/api/store", json=body).status_code, 409)
        with app_module.app.app_context():
            row = app_module.KVStore.query.filter_by(owner=self.owner, k=self.old_key).first()
            self.assertEqual(row.version, 2)
            self.assertEqual(row.v, next_value)

    def test_two_requests_from_same_snapshot_have_one_winner(self):
        first = self.request_body(operation_id="first")
        second = self.request_body(operation_id="second")
        def send(body):
            return self.client().post("/api/responsibility_transfer", json=body).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = sorted(pool.map(send, (first, second)))
        self.assertEqual(statuses, [200, 409])


    def test_stale_snapshot_conflicts_before_state_validation(self):
        first = self.request_body(operation_id="first")
        second = self.request_body(operation_id="second")
        client = self.client()
        self.assertEqual(client.post("/api/responsibility_transfer", json=first).status_code, 200)
        response = client.post("/api/responsibility_transfer", json=second)
        self.assertEqual(response.status_code, 409, response.get_json())
        self.assertEqual(response.get_json()["key"], "abonents_db_v1")
        with app_module.app.app_context():
            self.assertEqual(app_module.PaymentLedgerStoreAudit.query.count(), 2)

    def test_invalid_state_and_version_still_return_422(self):
        body = self.request_body()
        body["writes"]["abonents_db_v1"]["expected_version"] = "invalid"
        self.assertEqual(self.client().post("/api/responsibility_transfer", json=body).status_code, 422)
        body = self.request_body()
        proposed = json.loads(body["writes"]["abonents_db_v1"]["value"])
        proposed["links"][-1]["abonentId"] = self.old_id
        body["writes"]["abonents_db_v1"]["value"] = json.dumps(proposed)
        self.assertEqual(self.client().post("/api/responsibility_transfer", json=body).status_code, 422)


if __name__ == "__main__":
    unittest.main()
