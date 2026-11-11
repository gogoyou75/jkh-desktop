import os
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from sqlalchemy import create_engine

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import app as app_module


class AbonentsDbCasTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.file = tempfile.NamedTemporaryFile(prefix="jkh_cas_", suffix=".sqlite", delete=False)
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
            engines[None] = create_engine(app_module.app.config["SQLALCHEMY_DATABASE_URI"], connect_args={"timeout": 10})
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
            app_module.db.session.commit()
        self.owner = patch.object(app_module, "_session_store_owner", return_value=(None, "owner1", None))
        self.owner.start()
        self.access = patch.object(app_module, "_require_write_access_for_key", return_value=(None, None))
        self.access.start()

    def tearDown(self):
        self.owner.stop()
        self.access.stop()

    def post(self, value, version=None):
        body = {"key": "abonents_db_v1", "value": value}
        if version is not None:
            body["expected_version"] = version
        with app_module.app.test_client() as client:
            return client.post("/api/store", json=body)

    def test_create_update_stale_and_dump(self):
        with app_module.app.test_client() as client:
            missing = client.get("/api/store?key=abonents_db_v1")
            self.assertEqual(missing.status_code, 404)
            self.assertEqual(missing.json["version"], 0)
        self.assertEqual(self.post("one").status_code, 428)
        self.assertEqual(self.post("one", 1).status_code, 409)
        created = self.post("one", 0)
        self.assertEqual(created.json["version"], 1)
        self.assertEqual(self.post("two", 0).status_code, 409)
        updated = self.post("two", 1)
        self.assertEqual(updated.json["version"], 2)
        with app_module.app.test_client() as client:
            dump = client.get("/api/store_dump").json
            self.assertEqual(dump["abonents_db_version"], 2)
            self.assertEqual(dump["data"]["abonents_db_v1"], "two")

    def test_delete_preserves_version_and_recreate(self):
        self.post("one", 0)
        with app_module.app.test_client() as client:
            self.assertEqual(client.delete("/api/store", json={"key": "abonents_db_v1"}).status_code, 428)
            self.assertEqual(client.delete("/api/store", json={"key": "abonents_db_v1", "expected_version": 0}).status_code, 409)
            deleted = client.delete("/api/store", json={"key": "abonents_db_v1", "expected_version": 1})
            self.assertEqual(deleted.json["version"], 2)
            missing = client.get("/api/store?key=abonents_db_v1")
            self.assertEqual(missing.status_code, 404)
            self.assertEqual(missing.json["version"], 2)
        self.assertEqual(self.post("stale", 0).status_code, 409)
        self.assertEqual(self.post("new", 2).json["version"], 3)

    def test_two_concurrent_posts_have_one_winner(self):
        self.post("base", 0)
        barrier = threading.Barrier(2)

        def writer(value):
            barrier.wait()
            return self.post(value, 1).status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(writer, ("from-a", "from-b")))
        self.assertEqual(sorted(results), [200, 409])
        with app_module.app.test_client() as client:
            current = client.get("/api/store?key=abonents_db_v1").json
            self.assertEqual(current["version"], 2)
            self.assertIn(current["value"], ("from-a", "from-b"))

    def test_two_concurrent_creates_have_one_winner(self):
        barrier = threading.Barrier(2)

        def writer(value):
            barrier.wait()
            return self.post(value, 0).status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(writer, ("first", "second")))
        self.assertEqual(sorted(results), [200, 409])
        with app_module.app.test_client() as client:
            self.assertEqual(client.get("/api/store?key=abonents_db_v1").json["version"], 1)


if __name__ == "__main__":
    unittest.main()
