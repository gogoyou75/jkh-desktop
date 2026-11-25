"""Reviewed historic extensions; real isolated MySQL, real Maintenance fence.
Core fixture changes use only supplied facts, not a fabricated VPS schema dump.
"""
import json
from datetime import datetime
from unittest.mock import patch
import sqlalchemy as sa
from alembic import command
import schema_control as sc
import backend.tests.test_maintenance_mysql as maintenance


class LegacySchemaTest(maintenance.MaintenanceTest):
    def install_legacy(self):
        self.legacy()
        contract, _ = sc.load_package()
        with self.root.begin() as c:
            c.exec_driver_sql('USE `'+self.db+'`')
            for name, spec in contract['compatibility']['historical_tables'].items():
                c.exec_driver_sql(spec['ddl'])
            for ddl in [
                'ALTER TABLE kv_store MODIFY v LONGTEXT NULL',
                'ALTER TABLE card_snapshot MODIFY snapshot_json MEDIUMTEXT NOT NULL',
                'ALTER TABLE import_batches MODIFY upload_blob LONGBLOB NOT NULL',
                "ALTER TABLE users ADD status VARCHAR(20) NULL DEFAULT 'active'",
                'ALTER TABLE import_applied_fingerprints MODIFY created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',
                'ALTER TABLE import_applied_fingerprints MODIFY payment_period CHAR(7) NULL',
                'ALTER TABLE import_applied_fingerprints MODIFY source_index INT NOT NULL DEFAULT 1',
            ]: c.exec_driver_sql(ddl)
            for name in ['abonent_summary','card_snapshot','recalc_uid_locks']:
                c.exec_driver_sql('ALTER TABLE '+name+' MODIFY updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
            c.exec_driver_sql('ALTER TABLE abonent_summary CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci')
            fk=sa.inspect(c).get_foreign_keys('import_rows',schema=self.db)[0]
            c.exec_driver_sql('ALTER TABLE import_rows DROP FOREIGN KEY `'+fk['name']+'`')
            c.exec_driver_sql('ALTER TABLE import_rows ADD CONSTRAINT legacy_import_rows_batch FOREIGN KEY(batch_id) REFERENCES import_batches(id) ON DELETE CASCADE')
            for table, keys in contract['compatibility']['extra_nonunique_indexes'].items():
                for i,columns in enumerate(keys): c.exec_driver_sql('CREATE INDEX legacy_'+str(i)+' ON '+table+' ('+','.join(columns)+')')
            for table, columns in contract['compatibility']['optional_nonunique_indexes'].items():
                for index in sa.inspect(c).get_indexes(table,schema=self.db):
                    if not index['unique'] and index['column_names'] in columns:
                        c.exec_driver_sql('DROP INDEX `'+index['name']+'` ON '+table)
            # Known synthetic values only; unknown financial strings stay strings.
            c.exec_driver_sql("UPDATE kv_store SET v=%s", ('synthetic-large-'+('x'*90000),))
            self.insert_required(c,'import_batch', {'id':5,'upload_blob':b'archive'+b'x'*90000})
            self.insert_required(c,'import_batch_rows', {'id':699,'batch_id':5,'row_no':1,'amount':'UNKNOWN','raw_payload_json':'historical-preserve'})
            self.insert_required(c,'card_snapshot', {'owner_id':'synthetic','abonent_uid':'archive-uid','snapshot_json':'x'*90000})
            self.insert_required(c,'import_batches', {'upload_blob':b'x'*90000})
            self.insert_required(c,'users', {'id':'synthetic-history','email':'synthetic@invalid.test','status':'archived'})
            c.exec_driver_sql('ALTER TABLE import_batch AUTO_INCREMENT=6')
            c.exec_driver_sql('ALTER TABLE import_batch_rows AUTO_INCREMENT=700')

    def insert_required(self,c,name,overrides):
        table=sa.Table(name,sa.MetaData(),autoload_with=c,schema=self.db)
        values={}
        for col in table.columns:
            if col.name in overrides: values[col.name]=overrides[col.name]
            elif col.nullable or col.server_default is not None or col.autoincrement is True: continue
            elif isinstance(col.type,sa.DateTime): values[col.name]=datetime(2026,1,2,3,4,5)
            elif isinstance(col.type,sa.LargeBinary): values[col.name]=b'synthetic'
            elif isinstance(col.type,sa.Integer): values[col.name]=1
            else: values[col.name]='synthetic'
        c.execute(table.insert().values(**values))

    def migrated(self):
        plan=self.controller.plan()
        self.guard.begin()
        receipt=self.controller.backup(self.restore)
        self.controller.apply(plan,receipt['backup_id'],'APPLY LOCAL_LAB '+plan['plan_id'])
        self.controller.maintenance_resume()
        return receipt

    def test_reviewed_history_full_backup_migration_and_repeat(self):
        self.install_legacy()
        before=self.controller.diagnose()
        self.assertTrue(sc.approved_variant(before,sc.load_package()[0]),before['issues'])
        self.assertEqual(len(before['advisories']),16)
        receipt=self.migrated()
        self.assertIn('import_batch',receipt['tables']); self.assertIn('status',receipt['columns']['users'])
        with self.app_engine.connect() as c:
            self.assertEqual(c.exec_driver_sql('SELECT amount FROM import_batch_rows').scalar_one(),'UNKNOWN')
            self.assertEqual(c.exec_driver_sql('SELECT status FROM users').scalar_one(),'archived')
            self.assertEqual(c.exec_driver_sql('SELECT LENGTH(upload_blob) FROM import_batch').scalar_one(),90007)
        with self.restore.engine().connect() as c:
            self.assertEqual(c.exec_driver_sql('SELECT amount FROM import_batch_rows').scalar_one(),'UNKNOWN')
            self.assertNotIn('bulk_calc_verify_jobs',sa.inspect(c).get_table_names())
        plan=self.controller.plan();self.assertEqual(plan['action'],'noop')
        self.guard.begin();self.controller.apply(plan,None,'APPLY LOCAL_LAB '+plan['plan_id']);self.controller.maintenance_resume()

    def test_nullable_financial_store_requires_proven_non_null_data(self):
        self.install_legacy()
        with self.app_engine.begin() as c:c.exec_driver_sql('UPDATE kv_store SET v=NULL')
        self.assertTrue(any(i['kind']=='incompatible_null_data' for i in self.controller.diagnose()['issues']))
        with self.assertRaisesRegex(sc.Blocked,'unknown_schema_drift'):self.controller.plan()
        with self.app_engine.connect() as c:self.assertIsNone(c.exec_driver_sql('SELECT v FROM kv_store').scalar_one())

    def test_unknown_historical_definition_blocks(self):
        self.install_legacy()
        with self.root.begin() as c:
            c.exec_driver_sql('USE `'+self.db+'`');c.exec_driver_sql('ALTER TABLE import_batch_rows ADD unknown_value INT NULL')
        with self.assertRaisesRegex(sc.Blocked,'unknown_schema_drift'):self.controller.plan()

    def test_historical_cascade_is_preserved_but_unknown_rule_blocks(self):
        self.install_legacy()
        with self.root.begin() as c:
            c.exec_driver_sql('USE `'+self.db+'`')
            c.exec_driver_sql('ALTER TABLE import_batch_rows DROP FOREIGN KEY fk_import_batch_rows_batch')
            c.exec_driver_sql('ALTER TABLE import_batch_rows ADD FOREIGN KEY(batch_id) REFERENCES import_batch(id)')
        with self.assertRaisesRegex(sc.Blocked,'unknown_schema_drift'):self.controller.plan()

    def test_partial_bulk_ddl_is_completed_and_head_drift_still_blocks(self):
        self.install_legacy();plan=self.controller.plan();self.guard.begin();receipt=self.controller.backup(self.restore)
        original=sc.migrate_tables
        def interrupted(op,bulk,frozen_hash):
            if not bulk:return original(op,bulk,frozen_hash)
            _,snapshot=sc.load_package()
            op.execute(sa.text(snapshot['tables']['bulk_calc_verify_jobs']['ddl']))
            raise RuntimeError('synthetic_interruption_after_create_before_indexes')
        with patch('schema_control.migrate_tables',side_effect=interrupted):
            with self.assertRaisesRegex(RuntimeError,'synthetic_interruption'):self.controller.apply(plan,receipt['backup_id'],'APPLY LOCAL_LAB '+plan['plan_id'])
        self.assert_fenced()
        with self.controller.protected():
            with self.controller.engine.connect() as c:
                c.exec_driver_sql('CREATE INDEX reviewed_bulk_status ON bulk_calc_verify_jobs(status)');c.commit()
            plan=self.controller.plan()
        # A changed schema needs a new verified backup and an empty restore DB.
        with self.restore_admin.begin() as c:
            c.exec_driver_sql('DROP DATABASE `'+self.restore_db+'`');c.exec_driver_sql('CREATE DATABASE `'+self.restore_db+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
        receipt=self.controller.backup(self.restore)
        self.controller.apply(plan,receipt['backup_id'],'APPLY LOCAL_LAB '+plan['plan_id']);self.controller.maintenance_resume()
        with self.root.begin() as c:
            c.exec_driver_sql('USE `'+self.db+'`');self.assertEqual(sum(x['column_names']==['status'] for x in sa.inspect(c).get_indexes('bulk_calc_verify_jobs',schema=self.db)),1)
            c.exec_driver_sql('DROP INDEX reviewed_bulk_status ON bulk_calc_verify_jobs')
        with self.assertRaisesRegex(sc.Blocked,'revision_schema_mismatch'):self.controller.plan()

    def test_no_name_real_endpoint_after_historical_adoption(self):
        self.install_legacy();self.migrated()
        import app as application
        import backend.tests.test_responsibility_profiles as profiles
        target={'host':'mysql','port':'3306','name':self.db,'user':self.names['app']}
        with application.app.app_context():
            old=application.app.extensions['sqlalchemy'].engines[None]
            application.app.extensions['sqlalchemy'].engines[None]=self.app_engine
        case=profiles.LabProfile('test_delete_and_assign_with_original_debt')
        try:
            with patch.dict(profiles.TARGETS,{'LAB':target}):
                case.setUp();case.test_delete_and_assign_with_original_debt()
        finally:
            case.tearDown();case.doCleanups()
            with application.app.app_context():
                application.db.session.remove();application.app.extensions['sqlalchemy'].engines[None]=old
        with self.app_engine.connect() as c:self.assertEqual(c.exec_driver_sql('SELECT amount FROM import_batch_rows').scalar_one(),'UNKNOWN')

    def test_exact_source_restore_ddl(self):
        self.legacy();self.guard.begin();seen={};original=sc.schema_ddl
        def capture(c,name):
            ddl=original(c,name)
            seen.setdefault(name,[]).append(ddl)
            return ddl
        with patch('schema_control.schema_ddl',side_effect=capture):
            receipt=self.controller.backup(self.restore)
        self.assertTrue(receipt['validated_restore'])
        for name,ddls in seen.items():self.assertEqual(ddls[0],ddls[-1],name)

    def test_unknown_defaults_charset_and_unique_keys_are_not_whitelisted(self):
        self.install_legacy()
        with self.root.begin() as c:
            c.exec_driver_sql('USE `'+self.db+'`')
            c.exec_driver_sql("ALTER TABLE users MODIFY status VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT 'active'")
        with self.assertRaisesRegex(sc.Blocked,'unknown_schema_drift'):self.controller.plan()
        with self.root.begin() as c:
            c.exec_driver_sql('USE `'+self.db+'`')
            c.exec_driver_sql("ALTER TABLE users MODIFY status VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT 'active'")
            c.exec_driver_sql("ALTER TABLE import_batch_rows ALTER COLUMN amount SET DEFAULT '0'")
        with self.assertRaisesRegex(sc.Blocked,'unknown_schema_drift'):self.controller.plan()

    def test_non_utc_timestamp_session_blocks(self):
        self.install_legacy()
        with self.app_engine.connect() as c:
            c.exec_driver_sql("SET SESSION time_zone='+03:00'")
            state=sc.inspect_schema(c)
        self.assertTrue(any(i['kind']=='timestamp_timezone_not_utc' for i in state['issues']))

    def test_historical_fingerprint_includes_full_definition(self):
        self.install_legacy();before=self.controller.diagnose()['fingerprint']
        with self.root.begin() as c:
            c.exec_driver_sql('USE `'+self.db+'`');c.exec_driver_sql('ALTER TABLE import_batch_rows ADD unknown_archive_column INT NULL')
        self.assertNotEqual(before,self.controller.diagnose()['fingerprint'])

    def test_real_cli_child_uses_explicit_groups_without_migration_env(self):
        import os,sys,subprocess
        from pathlib import Path
        self.install_legacy()
        policy=Path(self.tmp.name)/'operator-policy.json'
        policy.write_text(json.dumps(self.policy),encoding='utf8')
        env={k:v for k,v in os.environ.items() if not k.startswith(('DB_','MAINT_','RESTORE_','MIGRATION_'))}
        for prefix,settings in [('',self.settings['app']),('MAINT_',self.settings['maintenance']),('RESTORE_',self.restore)]:
            for key,value in {'ENV_TYPE':'LOCAL_LAB','DB_HOST':settings.host,'DB_PORT':str(settings.port),
                              'DB_NAME':settings.database,'DB_USER':settings.user,'DB_PASSWORD':settings.password}.items():env[prefix+key]=value
        env.update(CUP_MAINTENANCE_POLICY=str(policy),CUP_SCHEMA_STATE_DIR=self.tmp.name)
        args=[sys.executable,str(sc.BASE/'schema_control.py'),'diagnose','--profile','LOCAL_LAB']
        result=subprocess.run(args,env=env,capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,0,result.stdout)
        state=json.loads(result.stdout);self.assertTrue(sc.approved_variant(state,sc.load_package()[0]),state['issues'])
        for value in self.pw.values():self.assertNotIn(value,result.stdout+result.stderr)
        del env['DB_PASSWORD']
        result=subprocess.run(args,env=env,capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,2)
        self.assertEqual(json.loads(result.stdout)['reason'],'explicit_database_configuration_required')

    def test_legacy_incomplete_receipt_cannot_authorize_migration(self):
        from pathlib import Path
        self.legacy();plan=self.controller.plan();self.guard.begin();receipt=self.controller.backup(self.restore)
        path=Path(self.tmp.name)/'backups'/(receipt['backup_id']+'.receipt.json')
        receipt['format']=1
        path.write_text(json.dumps(receipt),encoding='utf8')
        with self.assertRaisesRegex(sc.Blocked,'backup_does_not_match_plan'):
            self.controller.apply(plan,receipt['backup_id'],'APPLY LOCAL_LAB '+plan['plan_id'])
        self.assert_fenced()

    def test_historical_table_default_collation_is_checked(self):
        self.install_legacy()
        with self.root.begin() as c:
            c.exec_driver_sql('USE `'+self.db+'`')
            c.exec_driver_sql('ALTER TABLE import_batch DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci')
        with self.assertRaisesRegex(sc.Blocked,'unknown_schema_drift'):self.controller.plan()
