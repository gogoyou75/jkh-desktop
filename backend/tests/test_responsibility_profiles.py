"""Temporary SQLite profiles simulate only DATABASE(); optional disposable MySQL profiles
execute the real probe. Both run real handlers, CAS, commits, rollback and concurrency.
"""
import json
import os
from unittest.mock import patch
from sqlalchemy import event, create_engine, text
import unittest
from types import SimpleNamespace
from backend.tests.test_responsibility_mutations import ResponsibilityMutationTest as _Base
import app as app_module

TARGETS = {
    "LAB": {"host": "synthetic-lab.invalid", "port": "3306", "name": "synthetic_lab", "user": "synthetic_lab_user"},
    "PROD": {"host": "synthetic-prod.invalid", "port": "3306", "name": "synthetic_prod", "user": "synthetic_prod_user"},
}


class LocalProfile(_Base):
    profile = "LOCAL_LAB"

    def setUp(self):
        super().setUp()
        self.guard.stop()
        self.env.stop()
        self.policy.stop()
        target = TARGETS.get(self.profile, {"host": "mysql", "port": "3306", "name": "jkh_local_lab", "user": "jkh_local"})
        self.enterContext(patch.object(app_module, "ENV_TYPE", self.profile))
        self.enterContext(patch.multiple(app_module, DB_HOST=target["host"], DB_PORT=target["port"],
                                         DB_NAME=target["name"], DB_USER=target["user"], DB_PASSWORD="synthetic_only"))
        self.enterContext(patch.dict(os.environ, {"NO_NAME_ENABLED": "1", "NO_NAME_DB_TARGETS": json.dumps(TARGETS)}))
        self.actual_database = target["name"]
        with app_module.app.app_context():
            if app_module.db.engine.dialect.name == "mysql":
                return
        def register(connection, record):
            connection.create_function("DATABASE", 0, lambda: self.actual_database)
        with app_module.app.app_context():
            engine = app_module.db.engine
            app_module.db.session.remove()
            engine.dispose()
            event.listen(engine, "connect", register)
            app_module.db.session.connection().connection.driver_connection.create_function("DATABASE", 0, lambda: self.actual_database)
        self.addCleanup(event.remove, engine, "connect", register)

    def test_environment_default(self):
        with patch.dict(os.environ):
            os.environ.pop('NO_NAME_ENABLED', None)
            self.assertEqual(app_module._responsibility_feature_enabled(), self.profile != 'PROD')

    def test_profile_capability(self):
        with app_module.app.test_client() as client:
            self.assertTrue(client.get('/api/env').get_json()['features']['no_name'])
            self.assertEqual(client.post('/api/abonent_delete', json={}).status_code, 400)

    def test_wrong_actual_database(self):
        target = dict(app_module._responsibility_target(), name='wrong_synthetic_database')
        with patch.object(app_module, '_responsibility_target', return_value=target), app_module.app.test_client() as client:
            self.assertFalse(client.get('/api/env').get_json()['features']['no_name'])
            for route in ('abonent_delete', 'no_name_assign', 'closed_responsibility_assign', 'no_name_restore_closed_tail'):
                response = client.post('/api/' + route, json={})
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.get_json()['error'], 'responsibility_database_mismatch')

    def test_unsafe_configuration_and_unknown_environment(self):
        for field, value in [('DB_HOST', 'wrong.invalid'), ('DB_PORT', '1'), ('DB_NAME', 'wrong'), ('DB_USER', 'wrong'), ('DB_PASSWORD', ''), ('ENV_TYPE', 'UNKNOWN')]:
            with patch.object(app_module, field, value), app_module.app.test_client() as client:
                self.assertFalse(client.get('/api/env').get_json()['features']['no_name'])
                self.assertEqual(client.post('/api/abonent_delete', json={}).status_code, 403)

    def test_default_session_secret_is_unsafe(self):
        with patch.dict(app_module.app.config, {'SECRET_KEY': 'change-me-please'}), app_module.app.test_client() as client:
            self.assertFalse(client.get('/api/env').get_json()['features']['no_name'])
            self.assertEqual(client.post('/api/abonent_delete', json={}).status_code, 403)

    def test_disabled_and_invalid_flags_preserve_ordinary_writes(self):
        self.seed({'A': {'uid': 'uid_a'}}, [])
        for flag in ('0', 'true', 'invalid', ''):
            with patch.dict(os.environ, {'NO_NAME_ENABLED': flag}), app_module.app.test_client() as client:
                self.assertFalse(client.get('/api/env').get_json()['features']['no_name'])
                for route in ('abonent_delete', 'no_name_assign', 'closed_responsibility_assign', 'no_name_restore_closed_tail'):
                    self.assertEqual(client.post('/api/' + route, json={}).status_code, 403)
                self.assertEqual(client.post('/api/store', json={'key': 'ordinary_note', 'value': flag}).status_code, 200)
                state, _, version = self.state()
                state['abonents']['A']['fio'] = flag
                self.assertEqual(client.post('/api/store', json={'key': 'abonents_db_v1', 'value': json.dumps(state), 'expected_version': version}).status_code, 200)

    def test_disabled_existing_transfer_still_commits(self):
        with patch.dict(os.environ, {'NO_NAME_ENABLED': '0'}):
            self.test_existing_atomic_transfer_route_still_commits_and_replays()

    def test_disabled_ordinary_import_still_applies(self):
        self.imported_beta()
        with app_module.app.app_context():
            batch = app_module.ImportBatch.query.one()
            batch.status = 'validated'
            batch_id = batch.id
            app_module.db.session.add(app_module.ImportBatchRow(batch_id=batch.id, row_no=99,
                account_uid='uid_b', account_number='B', status='ready', amount='30.00',
                paid_date='2025-02-10', payment_date='2025-02-10', payment_period='2025-02',
                source_index=1, source_label='synthetic', raw_payload_json='{}'))
            app_module.db.session.commit()
        with patch.dict(os.environ, {'NO_NAME_ENABLED': '0'}), \
             patch.object(app_module, '_require_user', return_value=(SimpleNamespace(id='owner1', role='user'), None)), \
             patch.object(app_module, '_user_can_access_owner', return_value=True), \
             patch.object(app_module, '_import_schema_error_response', return_value=None), \
             app_module.app.test_client() as client:
            response = client.post('/api/import/%d/apply' % batch_id)
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()['summary']['applied_count'], 1)
        self.assertTrue(any(float(row.get('paid') or 0) == 30 for row in json.loads(self.state()[1]['payments_uid_b'])))

    def test_disabled_stale_import_cannot_restore_deleted_uid(self):
        self.imported_beta()
        self.assertEqual(self.delete().status_code, 200)
        with app_module.app.app_context():
            batch = app_module.ImportBatch.query.one()
            batch.status = 'validated'
            batch_id = batch.id
            app_module.db.session.add(app_module.ImportBatchRow(batch_id=batch.id, row_no=99,
                account_uid='uid_b', status='ready', amount='25'))
            app_module.db.session.commit()
        with patch.dict(os.environ, {'NO_NAME_ENABLED': '0'}), \
             patch.object(app_module, '_require_user', return_value=(SimpleNamespace(id='owner1', role='user'), None)), \
             patch.object(app_module, '_user_can_access_owner', return_value=True), \
             patch.object(app_module, '_import_schema_error_response', return_value=None), \
             app_module.app.test_client() as client:
            response = client.post('/api/import/%d/apply' % batch_id)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()['error'], 'import_abonent_no_longer_exists')
        self.assertEqual(self.state()[1]['payments_uid_b'], '')

    def test_disabling_keeps_deleted_uid_and_history_protected(self):
        self.imported_beta()
        self.assertEqual(self.delete().status_code, 200)
        with patch.dict(os.environ, {'NO_NAME_ENABLED': '0'}), app_module.app.test_client() as client:
            self.assertEqual(client.post('/api/store', json={'key': 'payments_uid_b', 'value': '[]', 'expected_version': 2}).status_code, 409)
            state, _, version = self.state()
            self.assertEqual(client.post('/api/store', json={'key': 'ordinary_note', 'value': 'still allowed'}).status_code, 200)
            state['links'] = []
            self.assertEqual(client.post('/api/store', json={'key': 'abonents_db_v1', 'value': json.dumps(state), 'expected_version': version}).status_code, 409)
            self.assertEqual(client.delete('/api/store', json={'key': 'abonents_db_v1', 'expected_version': version}).status_code, 409)

    def test_no_authentication_and_no_write_permission(self):
        self.owner.stop()
        try:
            with app_module.app.test_client() as client:
                for route in ('abonent_delete', 'no_name_assign', 'closed_responsibility_assign', 'no_name_restore_closed_tail'):
                    self.assertEqual(client.post('/api/' + route, json={}).status_code, 401)
        finally:
            self.owner.start()
        self.seed({'B': {'uid': 'uid_b', 'regnum': 'p73'}},
                  [{'abonentId': 'B', 'regnum': 'p73', 'dateFrom': '2025-02-01', 'dateTo': ''}])
        with app_module.app.app_context():
            denied = app_module._json_error('forbidden', 403)
            with patch.object(app_module, '_require_write_access_for_key', return_value=(denied, 'forbidden')):
                self.assertEqual(self.delete().status_code, 403)


class LabProfile(LocalProfile):
    profile = 'LAB'


class ProdEnabledProfile(LocalProfile):
    profile = 'PROD'

    def test_prod_default_is_off(self):
        with patch.dict(os.environ):
            os.environ.pop('NO_NAME_ENABLED', None)
            with app_module.app.test_client() as client:
                self.assertFalse(client.get('/api/env').get_json()['features']['no_name'])
                self.assertEqual(client.post('/api/abonent_delete', json={}).status_code, 403)

    def test_shared_or_missing_database_allowlist_is_rejected(self):
        for targets in ({}, {'LAB': TARGETS['LAB']}, {'LAB': TARGETS['LAB'], 'PROD': TARGETS['LAB']}):
            with patch.dict(os.environ, {'NO_NAME_DB_TARGETS': json.dumps(targets)}), app_module.app.test_client() as client:
                self.assertEqual(client.post('/api/no_name_assign', json={}).status_code, 403)


@unittest.skipUnless(os.getenv('NO_NAME_TEST_MYSQL_URL'), 'isolated MySQL URL not supplied')
class MySQLLocalProfile(LocalProfile):
    @classmethod
    def setUpClass(cls):
        # Caller supplies a disposable MySQL server, never a deployment database.
        cls.url = os.environ['NO_NAME_TEST_MYSQL_URL']
        if not cls.url.startswith('mysql+pymysql://root:synthetic_only@127.0.0.1:') or cls.url.rsplit('/', 1)[-1] != '':
            raise RuntimeError('Only the disposable loopback MySQL fixture is allowed')
        name = TARGETS.get(cls.profile, {'name': 'jkh_local_lab'})['name']
        cls.schema = name
        admin = create_engine(cls.url, connect_args={"ssl": {"check_hostname": False}})
        with admin.begin() as connection:
            connection.execute(text('CREATE DATABASE ' + name))
        admin.dispose()
        cls.old_uri = app_module.app.config['SQLALCHEMY_DATABASE_URI']
        app_module.app.config['TESTING'] = True
        with app_module.app.app_context():
            app_module.db.session.remove()
            cls.old_engine = app_module.app.extensions['sqlalchemy'].engines[None]
            app_module.app.extensions['sqlalchemy'].engines[None] = create_engine(cls.url + name, connect_args={"ssl": {"check_hostname": False}})
            app_module.db.create_all()

    @classmethod
    def tearDownClass(cls):
        with app_module.app.app_context():
            app_module.db.session.remove()
            app_module.db.engine.dispose()
            app_module.app.extensions['sqlalchemy'].engines[None] = cls.old_engine
        admin = create_engine(cls.url, connect_args={"ssl": {"check_hostname": False}})
        with admin.begin() as connection:
            connection.execute(text('DROP DATABASE ' + cls.schema))
        admin.dispose()


class MySQLLabProfile(MySQLLocalProfile):
    profile = 'LAB'


class MySQLProdProfile(MySQLLocalProfile):
    profile = 'PROD'


del _Base
