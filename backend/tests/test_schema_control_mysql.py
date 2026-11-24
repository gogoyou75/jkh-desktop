"""Only runs against the disposable MySQL network created by the CUP runner."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch
import sqlalchemy as sa
from alembic import command
from schema_control import (Settings, Controller, Blocked, load_package, inspect_schema,
                            alembic_config, migration_lock, main)

@unittest.skipUnless(os.environ.get("CUP_ISOLATED_MYSQL") == "1", "disposable MySQL fixture required")
class MySQLSchemaTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        @contextlib.contextmanager
        def schema_unit_connection(controller):
            yield
        cls.fencing_stub = patch.object(Controller, "protected", schema_unit_connection)
        cls.fencing_stub.start()
        @contextlib.contextmanager
        def schema_unit_inspection(controller):
            with controller.engine.connect() as connection: yield connection
        cls.audit_stub = patch.object(Controller, "diagnostic_connection", schema_unit_inspection)
        cls.audit_stub.start()
        cls.addClassCleanup(cls.audit_stub.stop)
        cls.addClassCleanup(cls.fencing_stub.stop)
        assert os.environ["DB_HOST"] == "mysql"
        cls.password = os.environ["DB_PASSWORD"]
        cls.admin = sa.create_engine(sa.URL.create("mysql+pymysql", username="root", password=cls.password,
                                                  host="mysql", database="mysql"), hide_parameters=True)
        with cls.admin.connect() as c:
            version = c.execute(sa.text("SELECT VERSION()")).scalar_one()
            assert version.startswith("8."), "MySQL 8 fixture required"
        print("MYSQL_FIXTURE_VERSION=" + version, flush=True)

    def setUp(self):
        suffix = uuid.uuid4().hex[:16]
        self.name, self.restore_name = "cup_test_" + suffix, "cup_restore_" + suffix
        for name in [self.name, self.restore_name]:
            with self.admin.begin() as c:
                c.exec_driver_sql("CREATE DATABASE `" + name + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
        self.settings = Settings("LOCAL_LAB", "mysql", 3306, self.name, "root", self.password)
        self.restore = Settings("LOCAL_LAB", "mysql", 3306, self.restore_name, "root", self.password)
        self.directory = tempfile.TemporaryDirectory(prefix="cup-schema-")
        self.addCleanup(self.directory.cleanup)
        self.controller = Controller(self.settings, self.directory.name)
        self.addCleanup(self.controller.engine.dispose)

    def prepare_schema(self):
        # Fixture setup uses the real Alembic revisions, never create_all or old SQL.
        with self.controller.engine.connect() as c:
            command.upgrade(alembic_config(c), "cup_5502")
            c.commit()
        self.assertEqual(self.controller.check()["status"], "SUCCESS")

    def apply_plan(self, plan=None):
        plan = plan or self.controller.plan()
        receipt = None if plan["action"] == "noop" else self.controller.backup(self.restore)
        return self.controller.apply(plan, receipt["backup_id"] if receipt else None,
                                     "APPLY LOCAL_LAB " + plan["plan_id"], True)

    def unversion(self, missing_bulk=False):
        with self.controller.engine.begin() as c:
            c.exec_driver_sql("DROP TABLE alembic_version")
            if missing_bulk:
                c.exec_driver_sql("DROP TABLE bulk_calc_verify_job_items")
                c.exec_driver_sql("DROP TABLE bulk_calc_verify_jobs")

    def test_empty_database_full_schema_backup_restore_and_repeat(self):
        self.assertEqual(self.controller.diagnose()["current_revision"], "UNVERSIONED")
        result = self.apply_plan()
        self.assertTrue(result["changed"])
        self.assertEqual(len(self.controller.diagnose()["table_names"]), 14)
        self.assertFalse(self.apply_plan()["changed"])

    def test_diagnostics_do_not_create_version_table(self):
        self.controller.diagnose()
        self.controller.plan()
        with self.controller.engine.connect() as c:
            self.assertEqual(sa.inspect(c).get_table_names(), [])

    def test_backup_preserves_deleted_high_id_counter(self):
        self.prepare_schema()
        with self.controller.engine.begin() as c:
            c.exec_driver_sql("INSERT INTO kv_store(id,owner,k,v) VALUES (9000,'synthetic','deleted','value')")
            c.exec_driver_sql("DELETE FROM kv_store WHERE id=9000")
        self.unversion()
        receipt = self.controller.backup(self.restore)
        self.assertEqual(receipt["auto_increment"]["kv_store"], 9001)
        plan = self.controller.plan()
        self.controller.apply(plan, receipt["backup_id"], "APPLY LOCAL_LAB " + plan["plan_id"], True)
        engine = self.restore.engine()
        try:
            with engine.begin() as c:
                c.exec_driver_sql("INSERT INTO kv_store(owner,k,v) VALUES ('synthetic','new','value')")
                self.assertEqual(c.exec_driver_sql("SELECT id FROM kv_store").scalar_one(), 9001)
        finally:
            engine.dispose()

    def test_backup_records_distinguish_sql_null_from_json_null(self):
        from schema_control import data_records, decode_value
        # This auxiliary codec fixture is deliberately outside the managed contract.
        # The controller would block adopting it; it is never a migration target.
        with self.controller.engine.begin() as c:
            c.exec_driver_sql("CREATE TABLE codec_fixture(id INT PRIMARY KEY, payload JSON NULL)")
            c.exec_driver_sql("INSERT INTO codec_fixture VALUES (1,NULL),(2,CAST('null' AS JSON))")
            records = list(data_records(c, ["codec_fixture"]))
            self.assertEqual(records[0]["row"]["payload"], {"$sql_null": True})
            self.assertEqual(records[1]["row"]["payload"], {"$json_null": True})
            table = sa.Table("codec_fixture", sa.MetaData(), autoload_with=c)
            c.exec_driver_sql("DELETE FROM codec_fixture")
            for record in records:
                c.execute(table.insert().values(**{k: decode_value(v) for k, v in record["row"].items()}))
            self.assertEqual(c.exec_driver_sql("SELECT payload IS NULL FROM codec_fixture ORDER BY id").scalars().all(), [1, 0])

    def test_complete_legacy_adoption_preserves_data(self):
        self.prepare_schema()
        with self.controller.engine.begin() as c:
            c.execute(sa.text("INSERT INTO kv_store(owner,k,v,version) VALUES ('synthetic','money','123.45',7)"))
        self.unversion()
        self.apply_plan()
        with self.controller.engine.connect() as c:
            self.assertEqual(c.execute(sa.text("SELECT v,version FROM kv_store")).one(), ("123.45", 7))

    def test_missing_006_reconciled_without_changing_existing_values(self):
        self.prepare_schema()
        with self.controller.engine.begin() as c:
            c.execute(sa.text("INSERT INTO kv_store(owner,k,v,version) VALUES ('synthetic','unknown','not-zero',3)"))
        self.unversion(True)
        with self.assertRaises(Blocked): self.controller.check()
        self.apply_plan()
        self.assertEqual(self.controller.check()["status"], "SUCCESS")
        with self.controller.engine.connect() as c:
            self.assertEqual(c.execute(sa.text("SELECT v FROM kv_store")).scalar_one(), "not-zero")

    def test_known_version_column_and_audit_table_reconciliation(self):
        self.prepare_schema()
        self.unversion()
        with self.controller.engine.begin() as c:
            c.execute(sa.text("INSERT INTO kv_store(owner,k,v,version) VALUES ('synthetic','old','123.45',9)"))
            c.exec_driver_sql("ALTER TABLE kv_store DROP COLUMN version")
            c.exec_driver_sql("DROP TABLE payment_ledger_store_audit")
        self.apply_plan()
        self.assertEqual(self.controller.check()["status"], "SUCCESS")

    def test_unknown_table_blocks_before_writes(self):
        with self.controller.engine.begin() as c:
            c.exec_driver_sql("CREATE TABLE unknown_finance(id INT PRIMARY KEY)")
        with self.assertRaises(Blocked): self.controller.plan()
        with self.controller.engine.connect() as c:
            self.assertNotIn("alembic_version", sa.inspect(c).get_table_names())

    def test_unknown_column_blocks(self):
        self.prepare_schema()
        with self.controller.engine.begin() as c: c.exec_driver_sql("ALTER TABLE kv_store ADD COLUMN unknown_extra INT")
        with self.assertRaises(Blocked): self.controller.plan()

    def test_missing_index_and_foreign_key_are_reported(self):
        self.prepare_schema()
        with self.controller.engine.begin() as c:
            idx = next(x for x in sa.inspect(c).get_indexes("kv_store") if x["unique"])
            c.exec_driver_sql("ALTER TABLE kv_store DROP INDEX `" + idx["name"] + "`")
            fk = sa.inspect(c).get_foreign_keys("bulk_calc_verify_job_items")[0]
            c.exec_driver_sql("ALTER TABLE bulk_calc_verify_job_items DROP FOREIGN KEY `" + fk["name"] + "`")
        kinds = {x["kind"] for x in self.controller.diagnose()["issues"]}
        self.assertIn("missing_index", kinds)
        self.assertIn("foreign_key_mismatch", kinds)
        with self.assertRaises(Blocked): self.controller.plan()

    def test_head_revision_does_not_hide_drift(self):
        self.prepare_schema()
        with self.controller.engine.begin() as c: c.exec_driver_sql("DROP TABLE bulk_calc_verify_job_items")
        with self.assertRaises(Blocked): self.controller.plan()
        with self.assertRaises(Blocked): self.controller.check()

    def test_parallel_migrations_blocked(self):
        plan = self.controller.plan()
        receipt = self.controller.backup(self.restore)
        with self.controller.engine.connect() as first, migration_lock(first, self.settings):
            with self.assertRaisesRegex(Blocked, "migration_lock_busy"):
                self.controller.apply(plan, receipt["backup_id"], "APPLY LOCAL_LAB " + plan["plan_id"], True)
        self.assertTrue(self.controller.apply(plan, receipt["backup_id"], "APPLY LOCAL_LAB " + plan["plan_id"], True)["changed"])

    def test_bad_confirmation_and_missing_backup_cannot_write(self):
        plan = self.controller.plan()
        with self.assertRaises(Blocked): self.controller.apply(plan, None, "YES", True)
        with self.assertRaises(Blocked): self.controller.apply(plan, None, "APPLY LOCAL_LAB " + plan["plan_id"], True)
        self.assertEqual(self.controller.diagnose()["table_names"], [])

    def test_stale_plan_and_altered_backup_blocked(self):
        plan = self.controller.plan()
        receipt = self.controller.backup(self.restore)
        backup = Path(self.directory.name) / "backups" / (receipt["backup_id"] + ".jsonl")
        backup.write_text("tampered", encoding="utf8")
        with self.assertRaises(Blocked): self.controller.apply(plan, receipt["backup_id"], "APPLY LOCAL_LAB " + plan["plan_id"], True)
        with self.controller.engine.begin() as c: c.exec_driver_sql("CREATE TABLE unknown_extra(id INT)")
        with self.assertRaises(Blocked): self.controller.apply(plan, receipt["backup_id"], "APPLY LOCAL_LAB " + plan["plan_id"], True)

    def test_migration_failure_no_false_success_and_lock_released(self):
        plan = self.controller.plan()
        receipt = self.controller.backup(self.restore)
        with patch("schema_control.command.upgrade", side_effect=RuntimeError("synthetic private parameter")):
            with self.assertRaises(RuntimeError): self.controller.apply(plan, receipt["backup_id"], "APPLY LOCAL_LAB " + plan["plan_id"], True)
        with self.controller.engine.connect() as c, migration_lock(c, self.settings): pass
        journal = (Path(self.directory.name) / "journal.jsonl").read_text()
        self.assertIn('"status":"ERROR"', journal)
        self.assertNotIn("synthetic private parameter", journal)
        self.assertNotIn(self.password, journal)

    def test_partial_mysql_ddl_failure_requires_reviewed_recovery(self):
        plan = self.controller.plan()
        receipt = self.controller.backup(self.restore)
        import schema_control
        original = schema_control.migrate_tables
        def fail_after_core(op, bulk, frozen_hash):
            if bulk:
                raise RuntimeError("synthetic failure after committed MySQL core DDL")
            return original(op, bulk, frozen_hash)
        with patch("schema_control.migrate_tables", side_effect=fail_after_core):
            with self.assertRaises(RuntimeError):
                self.controller.apply(plan, receipt["backup_id"], "APPLY LOCAL_LAB " + plan["plan_id"], True)
        state = self.controller.diagnose()
        self.assertIn("kv_store", state["table_names"])
        self.assertNotIn("bulk_calc_verify_job_items", state["table_names"])
        with self.assertRaises(Blocked): self.controller.check()
        with self.controller.engine.connect() as c, migration_lock(c, self.settings): pass

    def test_unknown_check_constraint_blocks(self):
        self.prepare_schema()
        with self.controller.engine.begin() as c:
            c.exec_driver_sql("ALTER TABLE users ADD CONSTRAINT cup_unknown_check CHECK (length(email)>0)")
        self.assertIn("unknown_check_constraint", {x["kind"] for x in self.controller.diagnose()["issues"]})
        with self.assertRaises(Blocked): self.controller.plan()

    def test_changed_data_after_backup_blocks(self):
        self.prepare_schema()
        self.unversion(True)
        plan = self.controller.plan()
        receipt = self.controller.backup(self.restore)
        with self.controller.engine.begin() as c:
            c.execute(sa.text("INSERT INTO kv_store(owner,k,v,version) VALUES ('synthetic','after-backup','91.23',1)"))
        with self.assertRaisesRegex(Blocked, "data_changed_since_backup"):
            self.controller.apply(plan, receipt["backup_id"], "APPLY LOCAL_LAB " + plan["plan_id"], True)

    def test_backup_codec_preserves_unknown_and_precise_values(self):
        from schema_control import encode_value, decode_value
        from decimal import Decimal
        from datetime import datetime, date
        values = [None, Decimal("123.4500"), b"synthetic-bytes", datetime(2026, 1, 2, 3, 4, 5), date(2026, 1, 2), {"$decimal": "unknown-not-zero"}, [None, "123.45"]]
        for value in values:
            self.assertEqual(decode_value(json.loads(json.dumps(encode_value(value)))), value)

    def test_changed_migration_artifacts_block_approved_plan(self):
        plan = self.controller.plan()
        with patch("schema_control.migration_fingerprint", return_value="changed"):
            with self.assertRaises(Blocked):
                self.controller.apply(plan, None, "APPLY LOCAL_LAB " + plan["plan_id"], True)
        self.assertEqual(self.controller.diagnose()["table_names"], [])

    def test_legacy_initdb_cannot_create_unversioned_schema(self):
        import app as application
        with patch.object(application.db, "create_all") as create, application.app.test_request_context("/api/initdb", method="POST"):
            response, status = application.initdb()
            self.assertEqual(status, 409)
            self.assertEqual(response.get_json()["error"], "schema_control_required")
            create.assert_not_called()
        self.assertEqual(self.controller.diagnose()["table_names"], [])

    def test_cross_database_constraint_is_not_accepted_as_local(self):
        self.prepare_schema()
        with self.controller.engine.begin() as c:
            id_type = next(x["type"] for x in sa.inspect(c).get_columns("bulk_calc_verify_jobs") if x["name"] == "id").compile(dialect=c.dialect)
            c.exec_driver_sql("CREATE TABLE `" + self.restore_name + "`.bulk_calc_verify_jobs(id " + id_type + " PRIMARY KEY)")
            fk = sa.inspect(c).get_foreign_keys("bulk_calc_verify_job_items")[0]
            c.exec_driver_sql("ALTER TABLE bulk_calc_verify_job_items DROP FOREIGN KEY `" + fk["name"] + "`")
            c.exec_driver_sql("ALTER TABLE bulk_calc_verify_job_items ADD CONSTRAINT cup_cross_db FOREIGN KEY(job_id) REFERENCES `" + self.restore_name + "`.bulk_calc_verify_jobs(id) ON DELETE CASCADE")
        self.assertIn("cross_schema_foreign_key", {x["kind"] for x in self.controller.diagnose()["issues"]})
        with self.assertRaises(Blocked): self.controller.plan()

    def test_missing_autoincrement_is_schema_drift(self):
        self.prepare_schema()
        with self.controller.engine.begin() as c:
            c.exec_driver_sql("ALTER TABLE kv_store MODIFY id INTEGER NOT NULL")
        self.assertIn("column_mismatch", {x["kind"] for x in self.controller.diagnose()["issues"]})
        with self.assertRaises(Blocked): self.controller.plan()

    def test_direct_alembic_cli_cannot_bypass_controller(self):
        from alembic.config import Config
        with self.assertRaises(RuntimeError): command.upgrade(Config(str(Path(__file__).resolve().parents[1] / "alembic.ini")), "head")

    def test_three_profiles_have_no_fallback(self):
        common = dict(DB_HOST="mysql", DB_PORT="3306", DB_NAME="jkh_local_lab", DB_USER="synthetic", DB_PASSWORD="synthetic", ENV_TYPE="LOCAL_LAB")
        with patch.dict(os.environ, common, clear=True):
            self.assertEqual(Settings.from_env("LOCAL_LAB").database, "jkh_local_lab")
            with self.assertRaises(Blocked): Settings.from_env("PROD")
        for profile, env_type, name in [("VPS_LAB", "LAB", "jkh_lab"), ("PROD", "PROD", "jkh")]:
            with patch.dict(os.environ, dict(common, ENV_TYPE=env_type, DB_NAME=name), clear=True):
                self.assertEqual(Settings.from_env(profile).profile, profile)
        with patch.dict(os.environ, dict(common, DB_HOST="remote.invalid"), clear=True):
            with self.assertRaises(Blocked): Settings.from_env("LOCAL_LAB")

    def test_current_backend_contract_is_verified_without_import(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d);(root / "alembic").mkdir()
            from schema_control import BASE
            for rel in ["schema_contract.json", "alembic/schema_snapshot.json", "app.py"]:
                (root / rel).write_bytes((BASE / rel).read_bytes())
            self.prepare_schema()
            self.controller.check(target_package=d)
            (root / "app.py").write_text((root / "app.py").read_text()+"\nclass Drift:\n    __tablename__='unknown'\n", encoding="utf8")
            with self.assertRaises(Blocked): self.controller.check(target_package=d)

    def test_no_name_delete_on_mysql_after_006_reconciliation(self):
        # Use the real unchanged endpoint with synthetic auth/data, not a mock DELETE.
        # Exercise the actual LOCAL_LAB allowlist and DATABASE(), not a mocked guard.
        self.controller = Controller(Settings("LOCAL_LAB", "mysql", 3306, "jkh_local_lab", "jkh_local", self.password), self.directory.name)
        self.addCleanup(self.controller.engine.dispose)
        self.prepare_schema()
        self.unversion(True)
        self.apply_plan()
        import app as application
        import backend.tests.test_responsibility_mutations as existing
        with application.app.app_context():
            old = application.app.extensions["sqlalchemy"].engines[None]
            application.app.extensions["sqlalchemy"].engines[None] = self.controller.engine
        case = existing.ResponsibilityMutationTest("test_delete_and_assign_with_original_debt")
        try:
            case.setUp()
            case.guard.stop()
            case.test_delete_and_assign_with_original_debt()
        finally:
            case.tearDown()
            case.doCleanups()
            with application.app.app_context():
                application.db.session.remove()
                application.app.extensions["sqlalchemy"].engines[None] = old

if __name__ == "__main__":
    unittest.main(verbosity=2)
