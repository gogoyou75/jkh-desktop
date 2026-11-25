"""Synthetic runtime/process tests. No working DB, remote Docker or VPS access."""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPTS=Path('/work/scripts');sys.path.insert(0,str(SCRIPTS))
import cup_lock as locks
import cup_config as config
import setup_cup_v5_6_1_vps_lab as setup
MENU=SCRIPTS/'jkh_server_menu_v5_6_1.sh'

class RuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='cup-v561-');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.state=self.root/'.schema-state/LOCAL_LAB';self.state.mkdir(parents=True);self.state.chmod(0o700)
        (self.root/'backend').mkdir();(self.root/'backend/schema_workflow.py').write_text('# synthetic')
        self.policy=self.state/'policy.json';self.policy.write_text('{}');self.policy.chmod(0o600)
        self.compose=self.root/'compose.json';self.compose.write_text('{}')
        self.db=self.root/'db.env';self.admin=self.root/'maint.env';self.restore=self.root/'restore.env'
        for path,prefix in [(self.db,''),(self.admin,'MAINT_'),(self.restore,'RESTORE_')]:
            path.write_text('\n'.join(prefix+k+'='+v for k,v in {'ENV_TYPE':'LOCAL_LAB','DB_HOST':'mysql','DB_PORT':'3306','DB_NAME':'cup_test_runtime','DB_USER':'synthetic','DB_PASSWORD':'synthetic-private'}.items())+'\n');path.chmod(0o600)
        self.cfg=self.state/'launch.json';self.write_config()
        self.bin=self.root/'bin';self.bin.mkdir()
        docker=self.bin/'docker';docker.write_text('#!/bin/sh\ncase " $* " in *" context inspect "*) echo unix:///fixture.sock ;; *) exit 0 ;; esac\n');docker.chmod(0o700)
        self.env=dict(os.environ,CUP_V56_CONFIG=str(self.cfg),CUP561_SCRIPTS=str(SCRIPTS),CUP_V56_HELPER=str(SCRIPTS/'cup_config.py'),CUP_HOST_PYTHON=sys.executable,PATH=str(self.bin)+os.pathsep+os.environ['PATH'],TERM='dumb',PYTHONIOENCODING='utf8')
        self.lock=self.root/'shared.lock'
        self.proxy=self.root/'lock-fixture.py'
        self.proxy.write_text("import sys;sys.path.insert(0,'/work/scripts');import cup_lock;cup_lock.oneoffs=lambda directory:[];raise SystemExit(cup_lock.main())\n")

    def write_config(self):
        payload={'format':1,'profile':'LOCAL_LAB','project_dir':str(self.root),'db_env_file':str(self.db),'admin_env_file':str(self.admin),'restore_env_file':str(self.restore),'compose_files':[str(self.compose)],'mysql_container':'cup_fixture_mysql','site_check':'http://127.0.0.1:18080'}
        self.cfg.write_text(json.dumps(payload));self.cfg.chmod(0o600)

    def run_shell(self,body,stdin='',timeout=15):
        driver=self.root/'jkh_server_menu_v5_6_1.sh'
        driver.write_text('source <(sed \'$d\' '+shlex.quote(str(MENU))+')\ndefault_python\n'+body)
        driver.write_text(driver.read_text().replace('\ndefault_python\n','\ndefault_python\nCUP561_LOCK_HELPER='+shlex.quote(str(self.proxy))+'\n'))
        return subprocess.run(['bash',str(driver)],input=stdin,text=True,capture_output=True,env=self.env,cwd=self.root,timeout=timeout)

    def cli(self,action,*extra):
        r=subprocess.run([sys.executable,str(self.proxy),action,'--path',str(self.lock),*map(str,extra)],capture_output=True,text=True,env=self.env,cwd=self.root,timeout=15)
        return r.returncode,json.loads(r.stdout)

    def old_owner(self,body='read -r line'):
        file=self.root/'jkh_server_menu_v5_5.sh';file.write_text(body+'\n')
        p=subprocess.Popen(['bash',str(file)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,cwd=self.root,start_new_session=True,env=self.env)
        self.addCleanup(self.close_process,p);time.sleep(.1)
        self.lock.write_text('pid='+str(p.pid)+' env=LOCAL_LAB dir='+str(self.root)+' date='+time.strftime('%F %T')+'\n')
        return p

    def close_process(self,p):
        if p.poll() is None:
            try:p.stdin.close()
            except (OSError,AttributeError):pass
            try:p.wait(timeout=3)
            except subprocess.TimeoutExpired:p.terminate();p.wait(timeout=5)
        for stream in (p.stdout,p.stderr):
            if stream:stream.close()

    def test_direct_menu_loads_private_profile_after_selection(self):
        r=subprocess.run(['bash',str(MENU)],input='3\n0\n',text=True,capture_output=True,env=self.env,cwd=self.root,timeout=15)
        self.assertEqual(r.returncode,0,r.stdout+r.stderr);self.assertIn('v5.6.1',r.stdout)
        self.assertFalse(Path('/tmp/jkh_server_menu_v5_3.lock').exists())

    def test_exit_before_environment_selection_needs_no_configuration(self):
        env=dict(self.env,CUP_V56_CONFIG=str(self.root/'absent.json'))
        r=subprocess.run(['bash',str(MENU)],input='0\n',text=True,capture_output=True,env=env,cwd=self.root,timeout=15)
        self.assertEqual(r.returncode,0,r.stdout+r.stderr);self.assertNotIn('RESULT: BLOCKED',r.stdout)

    def test_cup_sh_loads_same_profile_and_opens_new_menu(self):
        r=subprocess.run(['bash',str(SCRIPTS/'cup.sh'),'LOCAL_LAB'],input='0\n',text=True,capture_output=True,env=self.env,cwd=self.root,timeout=15)
        self.assertEqual(r.returncode,0,r.stdout+r.stderr);self.assertIn('v5.6.1',r.stdout)

    def test_missing_corrupt_and_unsafe_config_report_exact_path(self):
        for mode in ['missing','corrupt','unsafe']:
            self.write_config()
            if mode=='missing':self.cfg.unlink()
            elif mode=='corrupt':self.cfg.write_text('{invalid')
            else:self.cfg.chmod(0o644)
            r=subprocess.run(['bash',str(MENU),'--profile','LOCAL_LAB'],input='',text=True,capture_output=True,env=self.env,cwd=self.root,timeout=15)
            self.assertEqual(r.returncode,2);self.assertIn('RESULT: BLOCKED',r.stdout);self.assertIn(str(self.cfg),r.stdout)
            self.assertIn('NOT_CHECKED',r.stdout);self.assertNotIn('synthetic-private',r.stdout+r.stderr)

    def test_switching_profile_clears_old_credentials_even_when_new_profile_fails(self):
        r=self.run_shell('DB_PASSWORD=prior-secret;MAINT_DB_PASSWORD=prior-admin;RESTORE_DB_PASSWORD=prior-restore\nv561_load_profile LOCAL_LAB || exit 3\n[[ -z "${DB_PASSWORD+x}" && -z "${MAINT_DB_PASSWORD+x}" && -z "${RESTORE_DB_PASSWORD+x}" ]] || exit 4\nv561_load_profile PROD || :\n[[ -z "${CUP_SCHEMA_DB_ENV_FILE+x}" && -z "${DB_PASSWORD+x}" ]]\n')
        self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        for secret in ['prior-secret','prior-admin','prior-restore']:self.assertNotIn(secret,r.stdout+r.stderr)

    def test_three_existing_environment_files_are_loaded_without_export_by_owner(self):
        r=self.run_shell('v561_load_profile LOCAL_LAB || exit 2\n(schema_environment backup;[[ "$RESTORE_DB_PASSWORD" == synthetic-private && "$MAINT_DB_PASSWORD" == synthetic-private && "$DB_PASSWORD" == synthetic-private ]])\n[[ -z "${DB_PASSWORD+x}" ]]\n')
        self.assertEqual(r.returncode,0,r.stdout+r.stderr);self.assertNotIn('synthetic-private',r.stdout+r.stderr)

    def test_lower_guard_reason_is_not_overwritten_or_secret_leaked(self):
        body=r"""
v561_load_profile LOCAL_LAB || exit 2
export MAINT_DB_PASSWORD=synthetic-private
precise_guard(){ echo "BLOCKED: compose_file_missing; password=synthetic-private";return 2; }
v561_guard precise_guard || :
v56_report BLOCKED
schema_compose_guard(){ return 0; }
schema_writer_services(){ echo '{"status":"BLOCKED","reason":"reviewed_writer_policy_missing"}';return 2; }
v56_prepare_tool || :
v56_report BLOCKED
writer_ok(){ printf 'api\nworker\n'; }
v561_guard writer_ok || exit 9
[[ "$CUP561_GUARD_OUTPUT" == $'api\nworker' ]]
"""
        r=self.run_shell(body)
        self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertIn('compose_file_missing',r.stdout);self.assertIn('reviewed_writer_policy_missing',r.stdout)
        self.assertNotIn('environment or infrastructure rejected',r.stdout)
        self.assertNotIn('synthetic-private',r.stdout+r.stderr);self.assertIn('RESULT: BLOCKED',r.stdout)

    def test_real_writer_policy_rejection_preserves_exact_safe_reason(self):
        self.policy.write_text(json.dumps({'services':['api','worker']}))
        body=r"""
v561_load_profile LOCAL_LAB || exit 2
schema_compose(){ printf '%s' '{"services":{"api":{"environment":{}},"mysql":{},"nginx":{}}}'; }
v561_guard schema_writer_services && exit 9
v56_report BLOCKED
V56_LAST_JSON="$PROJECT_DIR/.schema-state/LOCAL_LAB/logs/scoped.json"
v561_scoped_guard schema_writer_services && exit 10
[[ "$(v56_value reason)" == writer_services_do_not_match_policy ]]
"""
        r=self.run_shell(body)
        self.assertEqual(r.returncode,0,r.stdout+r.stderr);self.assertIn('writer_services_do_not_match_policy',r.stdout)
        self.assertNotIn('synthetic-private',r.stdout+r.stderr)

    def test_live_previous_version_is_never_recovered_or_killed(self):
        p=self.old_owner();code,state=self.cli('status')
        self.assertEqual(code,2);self.assertNotEqual(state['state'],'CONFIRMED_STALE')
        before=self.lock.read_bytes();code,result=self.cli('recover','--expected',state['fingerprint'],'--env','LOCAL_LAB','--directory',self.root,'--confirmation','RECOVER LOCAL_LAB')
        self.assertEqual(code,2);self.assertIsNone(p.poll());self.assertEqual(self.lock.read_bytes(),before)

    def test_confirmed_stale_legacy_requires_confirmation_and_preserves_maintenance(self):
        p=self.old_owner();p.stdin.close();p.wait(timeout=3)
        maintenance=self.state/'maintenance.json';maintenance.write_text('{"phase":"FENCED","synthetic":true}')
        before=maintenance.read_bytes();code,state=self.cli('status');self.assertEqual(state['state'],'CONFIRMED_STALE',state)
        code,_=self.cli('recover','--expected',state['fingerprint'],'--env','LOCAL_LAB','--directory',self.root,'--confirmation','wrong')
        self.assertEqual(code,2);self.assertTrue(self.lock.exists())
        code,result=self.cli('recover','--expected',state['fingerprint'],'--env','LOCAL_LAB','--directory',self.root,'--confirmation','RECOVER LOCAL_LAB')
        self.assertEqual(code,0,result);self.assertFalse(self.lock.exists());self.assertEqual(maintenance.read_bytes(),before)

    def test_pid_reuse_and_unreadable_metadata_block(self):
        p=self.old_owner();meta=locks.process(p.pid)
        # A version-2 record has an exact birth identity; changing it simulates reuse.
        self.lock.write_text(json.dumps({'format':2,'pid':p.pid,'directory':str(self.root),'env':'LOCAL_LAB','owner':dict(meta,start='reused'),'token':'a'}))
        code,result=self.cli('status');self.assertEqual(result['state'],'UNDETERMINED');self.assertIn('pid_reused',result['reason'])
        self.lock.write_text('unparseable')
        code,result=self.cli('status');self.assertEqual(result['state'],'UNDETERMINED')

    def test_stale_recovery_rechecks_fingerprint_environment_and_children(self):
        p=self.old_owner();p.stdin.close();p.wait(timeout=3);code,state=self.cli('status')
        for extra in [('--expected','wrong'),('--env','PROD')]:
            args={'--expected':state['fingerprint'],'--env':'LOCAL_LAB','--directory':str(self.root),'--confirmation':'RECOVER LOCAL_LAB'};args[extra[0]]=extra[1]
            code,_=self.cli('recover',*[part for pair in args.items() for part in pair]);self.assertEqual(code,2)
        with patch.object(locks,'oneoffs',return_value=['synthetic-container']):
            self.assertEqual(locks.describe(self.lock)['state'],'UNDETERMINED')

    def harness(self,operation='sleep 30'):
        started=self.root/'started';driver=self.root/'jkh_server_menu_v5_6_1.sh'
        driver.write_text('source <(sed \'$d\' '+shlex.quote(str(MENU))+')\ndefault_python\nv561_load_profile LOCAL_LAB || exit 2\nLOCK_FILE='+shlex.quote(str(self.lock))+'\ngo_project(){ cd '+shlex.quote(str(self.root))+'; }\nshow_final_status(){ return 0; }\nschema_menu(){ echo started > '+shlex.quote(str(started))+'; '+operation+'; }\nrun_case 19\n')
        driver.write_text(driver.read_text().replace('\ndefault_python\n','\ndefault_python\nCUP561_LOCK_HELPER='+shlex.quote(str(self.proxy))+'\n'))
        p=subprocess.Popen(['bash',str(driver)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=self.env,cwd=self.root,start_new_session=True)
        p.stdin.write('19.9\n');p.stdin.flush();self.addCleanup(self.close_process,p)
        deadline=time.monotonic()+12
        while not started.exists() and p.poll() is None and time.monotonic()<deadline:time.sleep(.05)
        self.assertTrue(started.exists(),'operation did not start')
        return p

    def test_normal_exit_releases_only_own_operation_lock(self):
        p=self.harness('sleep .15');out,err=p.communicate(timeout=15)
        self.assertEqual(p.returncode,0,out+err+'\nLOCK_LOGS='+str([p.read_text() for p in self.state.glob('logs/lock.*.json')]));self.assertFalse(self.lock.exists());self.assertIn('RESULT: SUCCESS',out)

    def test_sigterm_and_sigint_exit_and_do_not_unlock_maintenance(self):
        for sig,expected in [(signal.SIGTERM,143),(signal.SIGINT,130)]:
            (self.root/'started').unlink(missing_ok=True)
            maintenance=self.state/'maintenance.json';maintenance.write_text('{"phase":"FENCED"}');before=maintenance.read_bytes()
            p=self.harness();os.kill(p.pid,sig);out,err=p.communicate(timeout=15)
            self.assertEqual(p.returncode,expected,out+err);self.assertNotIn('RESULT: SUCCESS',out)
            self.assertEqual(maintenance.read_bytes(),before)
            # Child cleanup is asynchronous, but no live owner is forcibly cleared.
            deadline=time.monotonic()+5
            while self.lock.exists() and time.monotonic()<deadline:time.sleep(.05)
            self.assertFalse(self.lock.exists(),out+err)

    def test_concurrent_instances_do_not_run_second_operation(self):
        first=self.harness();marker=self.root/'started';first_pid=first.pid
        second=subprocess.run(['bash',str(self.root/'jkh_server_menu_v5_6_1.sh')],input='19.9\n',text=True,capture_output=True,env=self.env,cwd=self.root,timeout=15)
        self.assertNotEqual(second.returncode,0);self.assertIn('RESULT: BLOCKED',second.stdout)
        self.assertIsNone(first.poll());os.kill(first_pid,signal.SIGTERM);first.communicate(timeout=15)

    def test_idle_main_and_submenu_hold_no_operational_lock(self):
        p=subprocess.Popen(['bash',str(MENU)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=self.env,cwd=self.root,start_new_session=True)
        self.addCleanup(self.close_process,p);p.stdin.write('3\n');p.stdin.flush()
        def phase(value):
            deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                records=list((self.root/'.schema-state/instances').glob('*.json'))
                if any(json.loads(f.read_text())['phase']==value for f in records):return
                time.sleep(.05)
            self.fail('instance did not reach '+value)
        phase('MENU_WAIT');self.assertFalse(Path('/tmp/jkh_server_menu_v5_3.lock').exists())
        p.stdin.write('19\n');p.stdin.flush();phase('SUBMENU_WAIT')
        self.assertFalse(Path('/tmp/jkh_server_menu_v5_3.lock').exists())
        os.kill(p.pid,signal.SIGTERM);p.communicate(timeout=15);self.assertEqual(p.returncode,143)

    def test_menu_workflow_reports_full_noop_and_failure_without_false_success(self):
        for mode in ['full','noop','backup-failure','resume-only']:
            with self.subTest(mode=mode):
                actions=self.root/('actions-'+mode)
                body=r"""
v561_load_profile LOCAL_LAB || exit 2
LOCK_FILE=LOCKPATH
go_project(){ cd ROOTPATH; }
show_final_status(){ return 0; }
require_prod_confirmation(){ return 0; }
schema_cli(){
 echo "$1" >> ACTIONPATH
 if [ "$MODE" = backup-failure ] && [ "$1" = workflow-backup ];then V56_REASON=synthetic_backup_failed;return 1;fi
 case "$1" in
 workflow-plan) V56_DB_STATE=PLANNED;V56_DONE='Plan checked';;
 workflow-apply) CUP561_MIGRATION_STATE=VERIFIED;V56_DB_STATE=VERIFIED;V56_DONE="$V56_DONE; Backup and migration verified" ;;
 esac
 return 0
}
v56_value(){
 case "$1" in
 plan_id) printf '%064d\n' 0 ;;
 action) case "$MODE" in noop) echo noop ;; resume-only) echo resume-services ;; *) echo upgrade ;; esac ;;
 needs_resume) [ "$MODE" = noop ] && echo false || echo true ;;
 revision) echo cup_5502 ;;
 *) echo '[]' ;;
 esac
}
v56_preview(){ schema_cli workflow-plan;V56_PREVIEW_PLAN=$(v56_value plan_id);V56_PLAN_ACTION=$(v56_value action);V56_NEEDS_RESUME=$(v56_value needs_resume); }
schema_maintenance_begin(){ echo fence >> ACTIONPATH;V56_APP_STATE=STOPPED;V56_DB_STATE=FENCED; }
schema_maintenance_resume(){ echo resume >> ACTIONPATH;V56_APP_STATE=STARTED; }
v56_health(){ echo health >> ACTIONPATH;V56_APP_STATE=HEALTHY; }
MODE=MODEVALUE
run_case 19
""".replace('LOCKPATH',shlex.quote(str(self.lock))).replace('ROOTPATH',shlex.quote(str(self.root))).replace('ACTIONPATH',shlex.quote(str(actions))).replace('MODEVALUE',shlex.quote(mode))
                r=self.run_shell(body,'19.9\nAPPROVE LOCAL_LAB\n')
                steps=actions.read_text().splitlines()
                if mode=='backup-failure':
                    self.assertNotEqual(r.returncode,0,r.stdout+r.stderr);self.assertIn('RESULT: FAILED',r.stdout);self.assertIn('synthetic_backup_failed',r.stdout)
                    self.assertNotIn('workflow-apply',steps);self.assertNotIn('resume',steps);self.assertNotIn('RESULT: SUCCESS',r.stdout)
                else:
                    self.assertEqual(r.returncode,0,r.stdout+r.stderr);self.assertIn('RESULT: SUCCESS',r.stdout);self.assertIn('health',steps)
                    if mode=='noop':self.assertNotIn('fence',steps);self.assertNotIn('workflow-backup',steps)
                    if mode=='resume-only':self.assertNotIn('workflow-backup',steps);self.assertNotIn('Backup and migration verified',r.stdout)
                self.assertFalse(self.lock.exists())

    def test_apply_without_verified_changed_result_cannot_be_success(self):
        r=self.run_shell('v561_load_profile LOCAL_LAB || exit 2\nv561_original_schema_cli(){ return 0; }\nv56_value(){ echo unconfirmed; }\nif schema_cli workflow-apply;then exit 9;fi\nv56_report FAILED\n')
        self.assertEqual(r.returncode,0,r.stdout+r.stderr);self.assertIn('RESULT: FAILED',r.stdout)
        self.assertNotIn('RESULT: SUCCESS',r.stdout);self.assertNotIn('Р СљР С‘Р С–РЎР‚Р В°РЎвЂ Р С‘РЎРЏ: Р Р†РЎвЂ№Р С—Р С•Р В»Р Р…Р ВµР Р…Р В° Р С‘ Р С—РЎР‚Р С•Р Р†Р ВµРЎР‚Р ВµР Р…Р В°',r.stdout)

    def test_manual_schema_items_keep_original_routes(self):
        for choice,expected in [('19.1','diagnose'),('19.2','versions'),('19.3','migrations'),('19.4','workflow-plan'),('19.5','workflow-backup'),('19.6','workflow-apply'),('19.7','workflow-verify'),('19.8','journal-ui')]:
            with self.subTest(choice=choice):
                body=r"""
v561_load_profile LOCAL_LAB || exit 2
LOCK_FILE=LOCKPATH
go_project(){ cd ROOTPATH; }
show_final_status(){ return 0; }
schema_cli(){ echo "ROUTE:$1";return 0; }
v56_preview(){ schema_cli workflow-plan; }
v56_approve(){ return 0; }
schema_maintenance_begin(){ return 0; }
schema_maintenance_resume(){ return 0; }
v56_health(){ return 0; }
v56_value(){ echo CURRENT_NO_PENDING_OPERATION; }
v56_view_logs(){ echo ROUTE:journal-ui; }
run_case 19
""".replace('LOCKPATH',shlex.quote(str(self.lock))).replace('ROOTPATH',shlex.quote(str(self.root)))
                r=self.run_shell(body,choice+'\nRESUME\n');self.assertEqual(r.returncode,0,r.stdout+r.stderr)
                self.assertIn('ROUTE:'+expected,r.stdout);self.assertIn('RESULT: SUCCESS',r.stdout);self.assertFalse(self.lock.exists())

    def test_foreign_lock_replacement_is_not_removed(self):
        p=self.old_owner();owner=locks.process(p.pid)
        self.lock.write_text(json.dumps({'format':2,'pid':p.pid,'env':'LOCAL_LAB','directory':str(self.root),'owner':owner,'token':'foreign'}))
        code,result=self.cli('release','--pid',p.pid,'--token','not-owner');self.assertEqual(code,2);self.assertTrue(self.lock.exists())

class OwnerSetupTest(unittest.TestCase):
    def setUp(self):
        # /root is a test-only tmpfs in this read-only disposable worker.
        self.project=Path('/root/jkh-lab');self.state=self.project/'.schema-state/LAB';self.state.mkdir(parents=True,exist_ok=True);self.state.chmod(0o700)
        (self.project/'backend').mkdir(exist_ok=True);(self.project/'backend/schema_workflow.py').write_text('# fixture')
        (self.project/'docker-compose.yml').write_text('{}')
        (self.state/'policy.json').write_text('{}');(self.state/'policy.json').chmod(0o600)
        for key,path in setup.SOURCES.items():
            path.parent.mkdir(parents=True,exist_ok=True);path.parent.chmod(0o700)
            prefix={'db_env_file':'','admin_env_file':'MAINT_','restore_env_file':'RESTORE_'}[key]
            path.write_text('\n'.join(prefix+n+'=synthetic' for n in ['ENV_TYPE','DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'])+'\n');path.chmod(0o600)
        (self.state/'launch.json').unlink(missing_ok=True)
    def test_owner_setup_dry_run_write_idempotence_and_used_restore_unchanged(self):
        before={p:p.read_bytes() for p in setup.SOURCES.values()}
        result=setup.setup();self.assertEqual(result['action'],'validated_dry_run');self.assertFalse((self.state/'launch.json').exists())
        self.assertEqual(setup.setup(True)['action'],'created');self.assertEqual(setup.setup(True)['action'],'already_configured')
        values=config.configuration(self.state/'launch.json','VPS_LAB');self.assertIn('CUP_SCHEMA_RESTORE_ENV_FILE',values)
        for p,raw in before.items():self.assertEqual(p.read_bytes(),raw)
    def test_owner_setup_never_overwrites_different_launch(self):
        path=self.state/'launch.json';path.write_text('{}');path.chmod(0o600)
        with self.assertRaisesRegex(ValueError,'existing_launch_differs'):setup.setup(True)
        self.assertEqual(path.read_text(),'{}')
