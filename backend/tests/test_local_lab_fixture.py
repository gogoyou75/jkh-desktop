import os
import secrets
import sys
import unittest
import uuid

from sqlalchemy import create_engine, select
from sqlalchemy.engine import URL

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import KVStore, User
from local_lab_fixture import (
    FixtureBlocked,
    REGISTRY,
    cleanup_records,
    create_records,
    normalize_run_id,
    validate_config,
    validate_database_result,
)


class LocalLabFixtureGuardTest(unittest.TestCase):
    def setUp(self):
        self.url = URL.create(
            "mysql+pymysql", username="jkh_local", host="mysql",
            port=3306, database="jkh_local_lab",
        )

    def test_rejects_non_local_environment(self):
        for environment in ("LAB", "PROD", "LOCAL_LAB_TYPO"):
            with self.subTest(environment=environment), self.assertRaises(FixtureBlocked):
                validate_config(environment, self.url)

    def test_rejects_wrong_database_target(self):
        for change in ({"host": "remote.invalid"}, {"port": 3307}, {"database": "jkh"}, {"username": "root"}):
            with self.subTest(change=change), self.assertRaises(FixtureBlocked):
                validate_config("LOCAL_LAB", self.url.set(**change))

    def test_rejects_wrong_sql_database_or_port(self):
        for database, port in (("jkh", 3306), ("jkh_local_lab", 3307)):
            with self.subTest(database=database, port=port), self.assertRaises(FixtureBlocked):
                validate_database_result(database, port)

    def test_accepts_only_uuid4_run_id(self):
        run_id = uuid.uuid4().hex
        self.assertEqual(normalize_run_id(run_id), run_id)
        with self.assertRaises(FixtureBlocked):
            normalize_run_id("existing-owner")


class LocalLabFixtureLifecycleTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite+pysqlite:///:memory:")
        User.__table__.create(self.engine)
        REGISTRY.create(self.engine)

    def tearDown(self):
        self.engine.dispose()

    def create(self, run_id=None):
        run_id = run_id or uuid.uuid4().hex
        with self.engine.begin() as connection:
            identity = create_records(connection, run_id, secrets.token_urlsafe(32))
        return run_id, identity

    def test_user_role_and_unique_run_identity(self):
        first_run, first = self.create()
        second_run, second = self.create()
        self.assertNotEqual(first_run, second_run)
        self.assertNotEqual(first["id"], second["id"])
        self.assertNotEqual(first["email"], second["email"])
        with self.engine.connect() as connection:
            rows = connection.execute(select(User.id, User.role)).all()
        self.assertEqual(rows, [(first["id"], "user"), (second["id"], "user")])
        with self.engine.begin() as connection, self.assertRaises(FixtureBlocked):
            create_records(connection, first_run, secrets.token_urlsafe(32))

    def test_cleanup_is_owned_and_repeatable(self):
        run_id, identity = self.create()
        with self.engine.begin() as connection:
            self.assertEqual(cleanup_records(connection, run_id), "deleted")
        with self.engine.begin() as connection:
            self.assertEqual(cleanup_records(connection, run_id), "absent")
            self.assertIsNone(connection.execute(select(User.id).where(User.id == identity["id"])).first())

    def test_cleanup_rejects_changed_user_identity(self):
        run_id, identity = self.create()
        with self.engine.begin() as connection:
            connection.execute(User.__table__.update().where(User.id == identity["id"]).values(display_name="changed"))
        with self.engine.begin() as connection, self.assertRaises(FixtureBlocked):
            cleanup_records(connection, run_id)
        with self.engine.connect() as connection:
            self.assertIsNotNone(connection.execute(select(User.id).where(User.id == identity["id"])).first())

    def test_cleanup_rejects_changed_registry_identity(self):
        run_id, identity = self.create()
        with self.engine.begin() as connection:
            connection.execute(REGISTRY.update().where(REGISTRY.c.run_id == run_id).values(email="other@example.invalid"))
        with self.engine.begin() as connection, self.assertRaises(FixtureBlocked):
            cleanup_records(connection, run_id)
        with self.engine.connect() as connection:
            self.assertIsNotNone(connection.execute(select(User.id).where(User.id == identity["id"])).first())

    def test_cleanup_rejects_unregistered_owned_data(self):
        KVStore.__table__.create(self.engine)
        run_id, identity = self.create()
        with self.engine.begin() as connection:
            connection.execute(KVStore.__table__.insert().values(owner=identity["id"], k="fixture_check", v="{}"))
        with self.engine.begin() as connection, self.assertRaises(FixtureBlocked):
            cleanup_records(connection, run_id)
        with self.engine.connect() as connection:
            self.assertIsNotNone(connection.execute(select(User.id).where(User.id == identity["id"])).first())

    def test_cleanup_never_touches_other_run(self):
        first_run, _ = self.create()
        _, second = self.create()
        with self.engine.begin() as connection:
            self.assertEqual(cleanup_records(connection, first_run), "deleted")
        with self.engine.connect() as connection:
            self.assertIsNotNone(connection.execute(select(User.id).where(User.id == second["id"])).first())


if __name__ == "__main__":
    unittest.main()
