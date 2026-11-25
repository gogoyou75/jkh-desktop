"""Real isolated MySQL workflow checks plus unchanged v5.5 regressions."""
import hashlib
import json
from pathlib import Path
import time
from unittest.mock import patch
import sqlalchemy as sa
import schema_control as sc
from schema_workflow import Workflow
import backend.tests.test_legacy_schema_mysql as legacy


class WorkflowTest(legacy.LegacySchemaTest):
    def setUp(self):
        super().setUp();self.workflow=Workflow(self.controller)

    def proposal(self):
        return self.workflow.prepare()

    def approve_proposal(self):
        p=self.proposal();self.workflow.approve(p['plan_id'],'APPROVE LOCAL_LAB');return p

    def empty_restore(self):
        with self.restore_admin.begin() as c:
            c.exec_driver_sql('DROP DATABASE `'+self.restore_db+'`')
            c.exec_driver_sql('CREATE DATABASE `'+self.restore_db+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')

    def test_workflow_full_automatic_database_sequence(self):
        self.install_functional_history();self.approve_proposal()
        self.guard.begin();self.workflow.backup(self.restore);self.workflow.apply()
        self.assert_fenced();self.workflow.resume();self.workflow.complete()
        self.assertEqual(self.workflow.active()['phase'],'COMPLETE')
        with self.app_engine.connect() as c:
            self.assertEqual(c.exec_driver_sql('SELECT error_message,file_name,uploaded_by FROM import_batches').one(),(None,None,None))
            self.assertEqual(c.exec_driver_sql('SELECT amount FROM import_batch_rows').scalar_one(),'UNKNOWN')

    def test_workflow_noop_never_stops_writers_or_creates_backup(self):
        result=self.proposal();self.assertEqual(result['action'],'noop')
        with patch.object(self.controller,'maintenance_begin',side_effect=AssertionError('must not fence')):
            self.workflow.complete()
        self.assertFalse(self.guard.path.exists());self.assertFalse((Path(self.tmp.name)/'backups').exists())
        with self.app_engine.begin() as c:c.exec_driver_sql("UPDATE kv_store SET v='legitimate-noop-write'")

    def test_workflow_expired_plan_requires_new_approval(self):
        self.legacy();p=self.approve_proposal()
        with patch('schema_workflow.time.time',return_value=time.time()+901):
            with self.assertRaisesRegex(sc.Blocked,'plan_expired'):self.workflow.approved()
        self.assertFalse(self.guard.path.exists())

    def test_workflow_wrong_profile_or_changed_plan_approval_blocks(self):
        self.legacy();p=self.proposal()
        with self.assertRaisesRegex(sc.Blocked,'approval_required'):self.workflow.approve(p['plan_id'],'APPROVE PROD')
        with self.assertRaisesRegex(sc.Blocked,'approval_required'):self.workflow.approve('a'*64,'APPROVE LOCAL_LAB')
        self.assertFalse(self.guard.path.exists())

    def test_workflow_document_and_backup_integrity(self):
        self.legacy();self.approve_proposal();self.guard.begin();self.workflow.backup(self.restore)
        state=self.workflow.active();key=state['backup_id']
        data=Path(self.tmp.name)/'backups'/(key+'.jsonl')
        with data.open('ab') as f:f.write(b'synthetic-corruption')
        with self.assertRaisesRegex(sc.Blocked,'backup_integrity'):self.workflow.apply()
        self.assert_fenced()

    def test_workflow_foreign_backup_never_selected(self):
        self.legacy();self.approve_proposal();self.guard.begin();self.workflow.backup(self.restore)
        state=self.workflow.active();key=state['backup_id']
        path=self.workflow.root/'backups'/(key+'.json');doc=sc.read_json(path)
        doc['payload']['database_id']='a'*64;doc['sha256']=sc.digest(doc['payload']);path.write_text(json.dumps(doc))
        with self.assertRaisesRegex(sc.Blocked,'receipt_integrity|database_mismatch'):self.workflow.apply()
        self.assert_fenced()

    def test_workflow_ambiguous_saved_plans_block(self):
        self.legacy();p=self.proposal();saved=self.workflow.plan_document(p['plan_id']);other=dict(saved)
        other['created_at']-=1;other.pop('plan_id');other['plan_id']=sc.digest(other)
        self.workflow.save('plans',other['plan_id'],other);self.workflow.active_path.unlink()
        with self.assertRaisesRegex(sc.Blocked,'ambiguous_saved_plans'):self.workflow.resolve_plan()

    def test_workflow_backup_and_restore_failures_keep_fence(self):
        self.legacy();self.approve_proposal();self.guard.begin()
        with patch.object(self.controller,'backup',side_effect=RuntimeError('synthetic-backup-failure')):
            with self.assertRaises(RuntimeError):self.workflow.backup(self.restore)
        self.assert_fenced()
        with self.restore_admin.begin() as c:c.exec_driver_sql('CREATE TABLE `'+self.restore_db+'`.occupied(id INT PRIMARY KEY)')
        with self.assertRaisesRegex(sc.Blocked,'restore_target_must_be_empty'):self.workflow.backup(self.restore)
        self.assert_fenced();self.assertIsNone(self.workflow.active()['backup_id'])

    def test_workflow_partial_ddl_recovery_requires_fresh_approval_and_backup(self):
        self.install_functional_history();self.approve_proposal();self.guard.begin();self.workflow.backup(self.restore)
        original=sc.migrate_tables
        def interrupted(op,bulk,frozen_hash):
            if not bulk:return original(op,bulk,frozen_hash)
            op.execute(sa.text(sc.load_package()[1]['tables']['bulk_calc_verify_jobs']['ddl']))
            raise RuntimeError('synthetic-ddl-interruption')
        with patch('schema_control.migrate_tables',side_effect=interrupted):
            with self.assertRaises(RuntimeError):self.workflow.apply()
        self.assert_fenced();self.assertEqual(self.workflow.active()['phase'],'MIGRATING')
        p=self.proposal()
        with self.assertRaisesRegex(sc.Blocked,'owner_approval'):self.workflow.apply()
        self.workflow.approve(p['plan_id'],'APPROVE LOCAL_LAB');self.empty_restore()
        self.workflow.backup(self.restore);self.workflow.apply();self.workflow.resume();self.workflow.complete()

    def test_workflow_lost_connection_after_committed_migration_recovers(self):
        self.install_functional_history();self.approve_proposal();self.guard.begin();self.workflow.backup(self.restore)
        original=self.controller.apply
        def disconnected(*args,**kw):original(*args,**kw);raise ConnectionError('synthetic lost reply')
        with patch.object(self.controller,'apply',side_effect=disconnected):
            with self.assertRaises(ConnectionError):self.workflow.apply()
        self.assert_fenced();p=self.proposal();self.assertEqual(p['action'],'noop');self.assertTrue(p['needs_resume'])
        self.workflow.approve(p['plan_id'],'APPROVE LOCAL_LAB');self.assertEqual(self.workflow.apply()['phase'],'VERIFIED');self.workflow.resume();self.workflow.complete()

    def test_workflow_noop_cannot_bless_corrupted_post_failure_data(self):
        self.legacy();self.approve_proposal();self.guard.begin();self.workflow.backup(self.restore)
        self.workflow.apply()
        with self.controller.protected():
            with self.controller.engine.connect() as c:c.exec_driver_sql("UPDATE kv_store SET v='synthetic-corruption'");c.commit()
        with self.assertRaisesRegex(sc.Blocked,'baseline_mismatch'):self.workflow.prepare()
        with self.assertRaisesRegex(sc.Blocked,'baseline_mismatch'):self.workflow.resume()
        self.assert_fenced()

    def test_workflow_service_restart_retry_allows_legitimate_post_resume_writes(self):
        self.install_functional_history();self.approve_proposal();self.guard.begin();self.workflow.backup(self.restore);self.workflow.apply();self.workflow.resume()
        with self.app_engine.begin() as c:c.exec_driver_sql("UPDATE kv_store SET v='legitimate-after-resume'")
        p=self.proposal();self.assertEqual(p['action'],'resume-services')
        self.workflow.approve(p['plan_id'],'APPROVE LOCAL_LAB');self.workflow.resume();self.workflow.complete()

    def test_workflow_saved_receipt_cannot_override_matching_database_fingerprint(self):
        self.legacy();self.approve_proposal();self.guard.begin();self.workflow.backup(self.restore)
        p,state=self.workflow.approved();key=state['backup_id']
        wrong=dict(p);wrong['before_fingerprint']='a'*64
        with self.assertRaisesRegex(sc.Blocked,'backup_does_not_match_plan'):self.workflow.receipt(key,wrong)
        self.assert_fenced()

    def test_workflow_expired_after_backup_reuses_only_bound_verified_receipt(self):
        self.legacy();self.approve_proposal();self.guard.begin();self.workflow.backup(self.restore)
        key=self.workflow.active()['backup_id'];future=time.time()+901
        with patch('schema_workflow.time.time',return_value=future):
            p=self.proposal()
            with self.assertRaisesRegex(sc.Blocked,'owner_approval'):self.workflow.apply()
            self.workflow.approve(p['plan_id'],'APPROVE LOCAL_LAB')
            with patch.object(self.controller,'backup',side_effect=AssertionError('must reuse verified matching receipt')):
                self.assertTrue(self.workflow.backup(self.restore)['reused_verified_backup'])
            self.assertEqual(self.workflow.active()['backup_id'],key)
            self.workflow.apply();self.workflow.resume();self.workflow.complete()

    def test_workflow_ambiguous_matching_backups_block(self):
        self.legacy();self.approve_proposal();self.guard.begin();self.workflow.backup(self.restore)
        p,state=self.workflow.approved();key=state['backup_id'];receipt=self.workflow.receipt(key)
        duplicate=dict(receipt);duplicate['backup_id']='b'*24
        root=Path(self.tmp.name)/'backups'
        (root/(duplicate['backup_id']+'.jsonl')).write_bytes((root/(key+'.jsonl')).read_bytes())
        sc.private_write(root/(duplicate['backup_id']+'.receipt.json'),duplicate)
        self.workflow.save('backups',duplicate['backup_id'],duplicate)
        state['backup_id']=None;self.workflow.update(state)
        with self.assertRaisesRegex(sc.Blocked,'ambiguous_matching_backups'):self.workflow.apply()
        self.assert_fenced()

    def test_workflow_manual_noop_apply_and_resume_do_not_require_maintenance(self):
        self.approve_proposal()
        self.assertFalse(self.workflow.apply()['changed'])
        self.assertEqual(self.workflow.active()['phase'],'COMPLETE')
        self.assertEqual(self.workflow.resume()['phase'],'COMPLETE')
        self.assertFalse(self.guard.path.exists())

    def test_workflow_missing_operation_cannot_bless_existing_fence(self):
        self.guard.begin()
        for action in [self.workflow.prepare,self.workflow.verify,self.workflow.resume]:
            with self.assertRaisesRegex(sc.Blocked,'existing_fence_without_workflow'):action()
        self.assert_fenced();self.assertFalse(self.workflow.active_path.exists())

    def test_workflow_manual_current_schema_without_pending_operation_is_read_only(self):
        self.assertEqual(self.workflow.verify()['phase'],'CURRENT_NO_PENDING_OPERATION')
        self.assertEqual(self.workflow.resume()['phase'],'CURRENT_NO_PENDING_OPERATION')
        self.assertFalse(self.guard.path.exists());self.assertFalse(self.workflow.active_path.exists())
