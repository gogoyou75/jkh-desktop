"""Real fencing tests; only the runner's internal, disposable MySQL servers."""
import json
import os
from pathlib import Path
import secrets
import threading
import time
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import sqlalchemy as sa
from sqlalchemy.pool import NullPool
from alembic import command
from schema_control import Settings, Controller, Blocked, alembic_config
from maintenance_control import Fence, MaintenanceBlocked


@unittest.skipUnless(os.environ.get('CUP_ISOLATED_MYSQL')=='1','isolated MySQL fixture required')
class MaintenanceTest(unittest.TestCase):
    def setUp(self):
        self.password=os.environ['DB_PASSWORD']
        self.root=sa.create_engine(sa.URL.create('mysql+pymysql',username='root',password=self.password,host='mysql'),poolclass=NullPool,hide_parameters=True)
        self.restore_admin=sa.create_engine(sa.URL.create('mysql+pymysql',username='root',password=self.password,host='cup-schema-mysql'),poolclass=NullPool,hide_parameters=True)
        self.db='cup_test_'+secrets.token_hex(6);self.restore_db='cup_restore_'+secrets.token_hex(6)
        self.names={k:'cup_'+k+'_'+secrets.token_hex(4) for k in ('app','migration','maintenance')}
        self.pw={k:secrets.token_hex(24) for k in self.names}
        with self.root.begin() as c:
            c.exec_driver_sql('CREATE DATABASE `'+self.db+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
            for role,user in self.names.items():c.exec_driver_sql("CREATE USER %s@'%%' IDENTIFIED BY %s",(user,self.pw[role]))
            escaped=self.db.replace('_',chr(92)+'_')
            c.exec_driver_sql("GRANT SELECT,INSERT,UPDATE,DELETE ON `"+escaped+"`.* TO %s@'%%'",(self.names['app'],))
            c.exec_driver_sql("GRANT SELECT,INSERT,UPDATE,DELETE,CREATE,DROP,ALTER,INDEX,REFERENCES ON `"+escaped+"`.* TO %s@'%%'",(self.names['migration'],))
            admin=self.names['maintenance']
            c.exec_driver_sql("GRANT CREATE USER,PROCESS,SHOW DATABASES ON *.* TO %s@'%%'",(admin,))
            c.exec_driver_sql("GRANT CONNECTION_ADMIN,SYSTEM_USER,SHOW_ROUTINE ON *.* TO %s@'%%'",(admin,))
            c.exec_driver_sql("GRANT TRIGGER,EVENT,REFERENCES ON `"+escaped+"`.* TO %s@'%%'",(admin,))
            fields='User,Host,account_locked,Select_priv,Insert_priv,Update_priv,Delete_priv,Create_priv,Drop_priv,Alter_priv,Index_priv,References_priv,Trigger_priv,Event_priv,Create_routine_priv,Alter_routine_priv,Execute_priv,Super_priv,Create_user_priv,Grant_priv,File_priv,Process_priv,Reload_priv,Shutdown_priv,Show_db_priv,Lock_tables_priv,Create_tmp_table_priv,Repl_slave_priv,Repl_client_priv,Create_view_priv,Show_view_priv,Create_tablespace_priv,Create_role_priv,Drop_role_priv'
            c.exec_driver_sql("GRANT SELECT("+fields+") ON mysql.user TO %s@'%%'",(admin,))
            for table in ['db','role_edges','proxies_priv','tables_priv','columns_priv','global_grants']:
                c.exec_driver_sql("GRANT SELECT ON mysql."+table+" TO %s@'%%'",(admin,))
            c.exec_driver_sql("GRANT SELECT ON performance_schema.replication_connection_configuration TO %s@'%%'",(admin,))
            c.exec_driver_sql("ALTER USER %s@'%%' ACCOUNT LOCK",(self.names['migration'],))
            roots=[list(r) for r in c.exec_driver_sql("SELECT User,Host FROM mysql.user WHERE User='root'")]
            server=c.exec_driver_sql('SELECT @@server_uuid').scalar_one()
            client_host=c.exec_driver_sql('SELECT USER()').scalar_one().split('@',1)[1]
        self.settings={k:Settings('LOCAL_LAB','mysql',3306,self.db,self.names[k],self.pw[k]) for k in self.names}
        self.tmp=tempfile.TemporaryDirectory(prefix='cup-fence-');self.addCleanup(self.tmp.cleanup)
        self.policy={'format':1,'profile':'LOCAL_LAB','database':self.db,'server_uuid':server,'writers':roots+[[self.names['app'],'%']], 'migration':[self.names['migration'],'%'],'maintenance':[admin,'%'],'services':['api']}
        self.policy['client_hosts']={a[0]:[client_host,'localhost','127.0.0.1'] for a in self.policy['writers']+[self.policy['migration'],self.policy['maintenance']]}
        self.guard=Fence(self.settings['app'],self.tmp.name,self.policy,self.settings['maintenance'],self.settings['migration'])
        self.controller=Controller(self.settings['app'],self.tmp.name,self.guard)
        self.app_engine=self.settings['app'].engine()
        # This is fixture preparation, through Alembic using the fixture DBA.
        source = sa.create_engine(self.root.url.set(database=self.db), poolclass=NullPool, hide_parameters=True)
        with source.connect() as c:
            command.upgrade(alembic_config(c),'cup_5502');c.commit()
            c.exec_driver_sql("INSERT INTO kv_store(owner,k,v) VALUES ('synthetic','preserve','123.45')");c.commit()
        source.dispose()
        with self.root.begin() as c:
            c.exec_driver_sql("GRANT SELECT ON `"+self.db+"`.alembic_version TO %s@'%%'",(admin,))
        with self.restore_admin.begin() as c:c.exec_driver_sql('CREATE DATABASE `'+self.restore_db+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
        self.restore=Settings('LOCAL_LAB','cup-schema-mysql',3306,self.restore_db,'root',self.password)

    def tearDown(self):
        # Explicit disposal of this test's disposable fixtures, never product recovery.
        with self.guard.admin_engine.connect() as c:
            self.guard.drain(c,{(self.names['app'],'%'),(self.names['migration'],'%')})
            for account in self.policy['writers']:
                if account[0]=='root': self.guard.alter(c,tuple(account),False)
        with self.root.begin() as c:
            c.exec_driver_sql('DROP DATABASE IF EXISTS `'+self.db+'`')
            for user in self.names.values():c.exec_driver_sql("DROP USER IF EXISTS %s@'%%'",(user,))
            c.exec_driver_sql("DROP USER IF EXISTS 'cup_unknown'@'%%'")
        with self.restore_admin.begin() as c:c.exec_driver_sql('DROP DATABASE IF EXISTS `'+self.restore_db+'`')
        self.controller.engine.dispose();self.app_engine.dispose();self.guard.dispose();self.root.dispose();self.restore_admin.dispose()

    def assert_fenced(self):
        with self.assertRaises(sa.exc.DBAPIError):
            with self.app_engine.connect() as c:c.exec_driver_sql("INSERT INTO kv_store(owner,k,v) VALUES ('synthetic','unsafe','0')")
        with self.assertRaises(sa.exc.DBAPIError):
            with self.settings['migration'].engine().connect():pass

    def legacy(self):
        with self.root.begin() as c:
            c.exec_driver_sql('USE `'+self.db+'`')
            for table in ['alembic_version','bulk_calc_verify_job_items','bulk_calc_verify_jobs']:c.exec_driver_sql('DROP TABLE '+table)

    def test_real_backup_migrate_verify_resume_and_repeat(self):
        self.legacy();plan=self.controller.plan();self.guard.begin();self.assert_fenced()
        receipt=self.controller.backup(self.restore);self.assert_fenced()
        self.controller.apply(plan,receipt['backup_id'],'APPLY LOCAL_LAB '+plan['plan_id'],True)
        self.assert_fenced();self.controller.maintenance_resume();self.controller.maintenance_resume()
        with self.app_engine.connect() as c:self.assertEqual(c.exec_driver_sql('SELECT v FROM kv_store').scalar_one(),'123.45')
        self.guard.begin();self.assert_fenced();self.controller.maintenance_resume()

    def test_live_transaction_is_killed_and_rolled_back(self):
        connection=self.app_engine.connect();connection.exec_driver_sql("INSERT INTO kv_store(owner,k,v) VALUES ('synthetic','uncommitted','1')")
        self.guard.begin()
        with self.assertRaises(sa.exc.DBAPIError):connection.commit()
        connection.close();self.assert_fenced()
        self.controller.maintenance_resume()
        with self.app_engine.connect() as c:self.assertEqual(c.exec_driver_sql("SELECT COUNT(*) FROM kv_store WHERE k='uncommitted'").scalar_one(),0)

    def test_unknown_writer_account_and_client_block(self):
        with self.root.begin() as c:
            c.exec_driver_sql("CREATE USER 'cup_unknown'@'%%' IDENTIFIED BY 'synthetic_only'")
            c.exec_driver_sql("GRANT INSERT ON `"+self.db.replace("_",chr(92)+"_")+"`.* TO cup_unknown")
        with self.assertRaisesRegex(MaintenanceBlocked,'unknown_writer_account'):self.guard.begin()
        self.assertFalse(self.guard.path.exists())

    def test_maintenance_confirmation_cannot_bypass(self):
        plan=self.controller.plan()
        with self.assertRaises((Blocked,MaintenanceBlocked)):self.controller.apply(plan,None,'APPLY LOCAL_LAB '+plan['plan_id'],True)
        with self.assertRaises((Blocked,MaintenanceBlocked)):self.controller.backup(self.restore)

    def test_migration_failure_retains_fence_and_blocks_resume(self):
        self.legacy();plan=self.controller.plan();self.guard.begin();receipt=self.controller.backup(self.restore)
        with patch('schema_control.command.upgrade',side_effect=RuntimeError('synthetic')):
            with self.assertRaises(RuntimeError):self.controller.apply(plan,receipt['backup_id'],'APPLY LOCAL_LAB '+plan['plan_id'])
        self.assert_fenced()
        with self.assertRaises(Blocked):self.controller.maintenance_resume()
        # Retry a reviewed plan while the durable fence is still active.
        with self.controller.protected():plan=self.controller.plan()
        self.controller.apply(plan,receipt['backup_id'],'APPLY LOCAL_LAB '+plan['plan_id'])
        self.controller.maintenance_resume()

    def test_connection_loss_fails_closed(self):
        self.guard.begin()
        with self.assertRaises(sa.exc.DBAPIError):
            with self.guard.session() as connection:
                identity=connection.exec_driver_sql('SELECT CONNECTION_ID()').scalar_one()
                with self.guard.admin_engine.connect() as c:c.exec_driver_sql('KILL CONNECTION '+str(identity))
                connection.exec_driver_sql('SELECT 1')
        self.assert_fenced();self.guard.begin();self.controller.maintenance_resume()

    def child(self, code):
        # Config and credentials travel in environment only, never argv/state/logs.
        env=os.environ.copy()
        for prefix,role in [('DB_','app'),('MAINT_DB_','maintenance'),('MIGRATION_DB_','migration')]:
            for key,value in [('HOST','mysql'),('PORT','3306'),('NAME',self.db),('USER',self.names[role]),('PASSWORD',self.pw[role])]:env[prefix+key]=value
        for prefix in ('','MAINT_','MIGRATION_'):env[prefix+'ENV_TYPE']='LOCAL_LAB'
        policy=Path(self.tmp.name)/'policy.json';policy.write_text(json.dumps(self.policy));env['CUP_MAINTENANCE_POLICY']=str(policy)
        env['STATE']=self.tmp.name
        return subprocess.Popen([sys.executable,'-c',code],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)

    def test_process_sigkill_does_not_unlock_and_restart_recovers(self):
        for attempt in range(3):
            self.guard.begin()
            child=self.child("from schema_control import *;import os,time; c=Controller(Settings.from_env('LOCAL_LAB'),os.environ['STATE']); context=c.protected();context.__enter__();print('READY',flush=True);time.sleep(60)")
            try:
                self.assertEqual(child.stdout.readline().strip(),'READY')
                child.kill();child.wait(timeout=10);child.communicate(timeout=5)
                self.assert_fenced();self.guard.begin();self.controller.maintenance_resume()
            finally:
                if child.poll() is None:child.kill();child.wait()

    def test_parallel_controller_is_blocked(self):
        self.guard.begin()
        with self.guard.coordinator():
            child=self.child("from schema_control import *;import os; c=Controller(Settings.from_env('LOCAL_LAB'),os.environ['STATE']);c.maintenance_begin()")
            # Start under an already-held lock; the child cannot alter account state.
            child.wait(timeout=15)
        child.communicate(timeout=5)
        self.assertNotEqual(child.returncode,0);self.assert_fenced()

    def test_application_and_maintenance_cannot_execute_ddl(self):
        with self.assertRaises(sa.exc.DBAPIError):
            with self.app_engine.connect() as c:c.exec_driver_sql('CREATE TABLE bypass(id INT)')
        with self.assertRaises(sa.exc.DBAPIError):
            with self.guard.admin_engine.connect() as c:c.exec_driver_sql('INSERT INTO `'+self.db+"`.kv_store(owner,k,v) VALUES ('x','x','x')")

    def test_continuous_direct_writes_blocked_through_backup_and_migration(self):
        self.legacy();plan=self.controller.plan();self.guard.begin()
        stop=threading.Event();outcomes=[]
        def writer():
            while not stop.is_set():
                try:
                    with self.app_engine.begin() as c:
                        c.exec_driver_sql("INSERT INTO kv_store(owner,k,v) VALUES ('synthetic','concurrent','value')")
                    outcomes.append(True)
                except sa.exc.DBAPIError:outcomes.append(False)
                time.sleep(.01)
        thread=threading.Thread(target=writer);thread.start()
        try:
            receipt=self.controller.backup(self.restore)
            self.controller.apply(plan,receipt['backup_id'],'APPLY LOCAL_LAB '+plan['plan_id'])
            with self.controller.protected():self.controller.check()
        finally:stop.set();thread.join(timeout=5)
        self.assertGreater(len(outcomes),3);self.assertFalse(any(outcomes));self.assert_fenced()
        self.controller.maintenance_resume()

    def test_unknown_connected_reader_blocks_before_fencing(self):
        with self.root.begin() as c:
            c.exec_driver_sql("CREATE USER cup_unknown IDENTIFIED BY 'synthetic_only'")
            c.exec_driver_sql("GRANT SELECT ON `"+self.db.replace('_',chr(92)+'_')+"`.* TO cup_unknown")
        engine=Settings('LOCAL_LAB','mysql',3306,self.db,'cup_unknown','synthetic_only').engine()
        try:
            with engine.connect():
                with self.assertRaisesRegex(MaintenanceBlocked,'unknown_database_client'):self.guard.begin()
        finally:engine.dispose()
        self.assertFalse(self.guard.path.exists())

    def test_sigkill_during_migration_admission_leaves_no_reusable_password(self):
        self.guard.begin()
        code="""from schema_control import *
from maintenance_control import Fence
import os,time
original=Fence.alter
def delay(self,c,account,locked):
 if account[0]==self.migration_settings.user and locked:
  print('READY',flush=True);time.sleep(60)
 return original(self,c,account,locked)
Fence.alter=delay
controller=Controller(Settings.from_env('LOCAL_LAB'),os.environ['STATE'])
with controller.protected():pass
"""
        child=self.child(code)
        try:
            self.assertEqual(child.stdout.readline().strip(),'READY')
            child.kill();child.communicate(timeout=10)
            self.assert_fenced();self.guard.begin();self.controller.maintenance_resume()
        finally:
            if child.poll() is None:child.kill();child.communicate(timeout=10)

    def test_partial_ddl_failure_cannot_resume(self):
        from schema_control import load_package
        self.legacy();plan=self.controller.plan();self.guard.begin();receipt=self.controller.backup(self.restore)
        def partial(config,revision):
            c=config.attributes['connection']
            c.exec_driver_sql(load_package()[1]['tables']['bulk_calc_verify_jobs']['ddl'])
            raise RuntimeError('synthetic partial DDL')
        with patch('schema_control.command.upgrade',side_effect=partial):
            with self.assertRaises(RuntimeError):self.controller.apply(plan,receipt['backup_id'],'APPLY LOCAL_LAB '+plan['plan_id'])
        self.assert_fenced()
        with self.assertRaises(Blocked):self.controller.maintenance_resume()

    def test_missing_state_and_changed_policy_cannot_unlock(self):
        self.guard.begin();self.guard.path.unlink()
        with self.assertRaises(MaintenanceBlocked):self.controller.maintenance_resume()
        self.assert_fenced()

    def test_legacy_flag_cli_is_blocked(self):
        from schema_control import main
        import contextlib,io
        with contextlib.redirect_stdout(io.StringIO()) as output:
            code=main(['apply','--profile','LOCAL_LAB','--maintenance-confirmed'])
        self.assertEqual(code,2);self.assertIn('legacy_maintenance_confirmation_not_accepted',output.getvalue())

    def test_hidden_database_programs_block_even_with_unprivileged_app(self):
        cases=[("CREATE TRIGGER cup_hidden BEFORE INSERT ON kv_store FOR EACH ROW SET NEW.v='synthetic'",'DROP TRIGGER cup_hidden'),
               ("CREATE EVENT cup_hidden ON SCHEDULE EVERY 1 DAY DO SET @cup_synthetic=1",'DROP EVENT cup_hidden'),
               ('CREATE PROCEDURE cup_hidden() SELECT 1','DROP PROCEDURE cup_hidden')]
        for create,drop in cases:
            with self.subTest(create=create):
                with self.root.begin() as c:
                    c.exec_driver_sql('USE `'+self.db+'`');c.exec_driver_sql(create)
                with self.assertRaises((Blocked,MaintenanceBlocked)):self.controller.diagnose()
                with self.root.begin() as c:
                    c.exec_driver_sql('USE `'+self.db+'`');c.exec_driver_sql(drop)

    def test_audit_and_diagnostics_do_not_change_database_or_accounts(self):
        with self.root.connect() as c:
            before=list(c.exec_driver_sql('SELECT User,Host,account_locked FROM mysql.user ORDER BY User,Host'))
        self.controller.diagnose();self.controller.plan()
        with self.root.connect() as c:
            self.assertEqual(before,list(c.exec_driver_sql('SELECT User,Host,account_locked FROM mysql.user ORDER BY User,Host')))
        self.assertFalse(self.guard.path.exists())
        self.guard.begin()
        # Even while app/migrator accounts are locked, diagnostics remain read-only.
        self.assertEqual(self.controller.diagnose()['current_revision'],'cup_5502')
        self.assert_fenced()

    def test_overprivileged_application_is_blocked(self):
        with self.root.begin() as c:
            c.exec_driver_sql("GRANT CREATE ON `"+self.db.replace('_',chr(92)+'_')+"`.* TO %s@'%%'",(self.names['app'],))
        with self.assertRaisesRegex(MaintenanceBlocked,'application_grant_mismatch'):self.guard.begin()
        self.assertFalse(self.guard.path.exists())
        with self.root.begin() as c:
            c.exec_driver_sql("REVOKE CREATE ON `"+self.db.replace('_',chr(92)+'_')+"`.* FROM %s@'%%'",(self.names['app'],))
            c.exec_driver_sql("GRANT PROCESS ON *.* TO %s@'%%'",(self.names['app'],))
        with self.assertRaisesRegex(MaintenanceBlocked,'application_global_privileges'):self.guard.begin()


    def test_known_account_from_unlisted_client_host_is_blocked(self):
        self.policy['client_hosts'][self.names['app']]=['192.0.2.55']
        with self.app_engine.connect():
            with self.assertRaisesRegex(MaintenanceBlocked,'unknown_writer_client'):self.guard.begin()
        self.assertFalse(self.guard.path.exists())

    def test_empty_application_schema_with_bootstrapped_version_metadata(self):
        from schema_control import ordered_tables,load_package
        with self.root.begin() as c:
            c.exec_driver_sql('USE `'+self.db+'`')
            for name in reversed(ordered_tables(load_package()[1])):c.exec_driver_sql('DROP TABLE `'+name+'`')
            c.exec_driver_sql('DELETE FROM alembic_version')
        plan=self.controller.plan();self.guard.begin();receipt=self.controller.backup(self.restore)
        self.controller.apply(plan,receipt['backup_id'],'APPLY LOCAL_LAB '+plan['plan_id'])
        self.assertEqual(len(self.controller.diagnose()['table_names']),14)
        self.controller.maintenance_resume()

    def test_missing_provisioned_account_blocks_without_key_error(self):
        with self.root.begin() as c:
            c.exec_driver_sql("DROP USER %s@'%%'",(self.names['migration'],))
        with self.assertRaisesRegex(MaintenanceBlocked,'policy_account_missing'):self.guard.begin()
        self.assertFalse(self.guard.path.exists())

    def test_live_unknown_maintenance_peer_is_not_admitted_or_killed(self):
        with self.guard.admin_engine.connect() as peer:
            with self.assertRaisesRegex(MaintenanceBlocked,'unknown_maintenance_client'):self.guard.begin()
            self.assertEqual(peer.exec_driver_sql('SELECT 1').scalar_one(),1)
        self.assertFalse(self.guard.path.exists())
