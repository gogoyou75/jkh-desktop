"""Real embedded Python regression; backend replies and service health are synthetic.
No SQL, Docker socket, SSH or working database is accessed by these tests.
"""
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
from backend.tests import test_cup_v561_runtime as rt

MENU=rt.SCRIPTS/'jkh_server_menu_v5_6_2.sh'

class ExecutionTest(unittest.TestCase):
    def setUp(self):
        self.fixture=rt.RuntimeTest(methodName='runTest');self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.actions=self.fixture.root/'actions'

    def body(self,extra='',fail_action=''):
        return r'''v561_load_profile LOCAL_LAB || exit 2
LOCK_FILE=LOCKPATH
go_project(){ cd ROOTPATH; }
show_final_status(){ return 0; }
v56_prepare_tool(){ v56_private_dir; }
v56_health(){ echo health >> ACTIONPATH;V56_APP_STATE=HEALTHY;return 0; }
schema_cli_scoped(){
 echo "$1" >> ACTIONPATH
 if [ "$1" = FAILACTION ];then printf '%s' '{"status":"SUCCESS"}' > "$V56_LAST_JSON";return 0;fi
 case "$1" in
 workflow-plan) printf '%s' '{"status":"SUCCESS","plan_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"noop","revision":"cup_5502","needs_resume":false,"required_changes":[],"recommendations":[]}' ;;
 check) printf '%s' '{"status":"SUCCESS","revision":"cup_5502"}' ;;
 workflow-complete) printf '%s' '{"status":"SUCCESS","phase":"COMPLETE"}' ;;
 *) echo '{"status":"BLOCKED","reason":"unexpected_fixture_action"}';return 2 ;;
 esac > "$V56_LAST_JSON"
}
EXTRA
run_case 19
'''.replace('LOCKPATH',rt.shlex.quote(str(self.fixture.lock))).replace('ROOTPATH',rt.shlex.quote(str(self.fixture.root))).replace('ACTIONPATH',rt.shlex.quote(str(self.actions))).replace('FAILACTION',rt.shlex.quote(fail_action)).replace('EXTRA',extra)

    def run_menu(self,body,menu=MENU):
        with patch.object(rt,'MENU',menu):
            return self.fixture.run_shell(body,'19.9\n',timeout=20)

    def test_561_reproduces_three_python_errors_and_false_success(self):
        r=self.run_menu(self.body(),rt.SCRIPTS/'jkh_server_menu_v5_6_1.sh')
        self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertEqual(r.stderr.count('IndentationError: unexpected indent'),3,r.stderr)
        self.assertIn('code=1',r.stderr);self.assertIn('RESULT: SUCCESS',r.stdout)
        print('REPRODUCED v5.6.1: 3 real stdin IndentationError failures and false SUCCESS')

    def test_562_actual_embedded_python_and_noop_199_succeed(self):
        r=self.run_menu(self.body());self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertIn('RESULT: SUCCESS',r.stdout);self.assertNotIn('IndentationError',r.stdout+r.stderr)
        self.assertEqual(self.actions.read_text().splitlines(),['workflow-plan','check','health','workflow-complete'])
        logs=list((self.fixture.state/'logs').glob('*.validation.log'))
        self.assertEqual(len(logs),3);self.assertTrue(all(not p.read_bytes() for p in logs))
        self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in logs))
        self.assertFalse(self.fixture.lock.exists())

    def test_invalid_mandatory_documents_stop_each_noop_stage(self):
        for action in ['workflow-plan','check','workflow-complete']:
            with self.subTest(action=action):
                self.actions.unlink(missing_ok=True)
                r=self.run_menu(self.body(fail_action=action))
                self.assertNotEqual(r.returncode,0,r.stdout+r.stderr)
                self.assertIn('RESULT: FAILED',r.stdout);self.assertNotIn('RESULT: SUCCESS',r.stdout)
                self.assertIn(action+': mandatory_result_validation_failed',r.stdout)
                self.assertIn('NOT_VERIFIED',r.stdout)
                self.assertEqual(self.actions.read_text().splitlines()[-1],action)
                logs=''.join(p.read_text() for p in (self.fixture.state/'logs').glob('*.validation.log'))
                self.assertTrue('AssertionError' in logs or 'KeyError' in logs)
                self.assertNotIn('synthetic-private',r.stdout+r.stderr+logs)
                self.assertFalse(self.fixture.lock.exists())

    def test_python_nonzero_status_is_preserved_in_report_and_log(self):
        extra=r'''real_python="$CUP_HOST_PYTHON"
required_python_failure(){
 if [ "${1:-}" = - ] && [ "${3:-}" = workflow-plan ];then
  cat > "$PROJECT_DIR/actual-validation-input.py"
  echo synthetic_required_python_failure >&2
  return 37
 fi
 "$real_python" "$@"
}
CUP_HOST_PYTHON=required_python_failure
'''
        r=self.run_menu(self.body(extra));self.assertNotEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertIn('RESULT: FAILED',r.stdout);self.assertIn('synthetic_required_python_failure',r.stdout)
        self.assertIn('python=37',r.stdout);self.assertNotIn('RESULT: SUCCESS',r.stdout)
        self.assertIn('assert isinstance(r,dict)',(self.fixture.root/'actual-validation-input.py').read_text())
        logs=''.join(p.read_text() for p in (self.fixture.state/'logs').glob('*.validation.log'))
        self.assertIn('synthetic_required_python_failure',logs)

    def test_sanitizer_failure_is_also_mandatory(self):
        r=self.run_menu(self.body('v56_sanitize(){ cat;return 31; }'))
        self.assertNotEqual(r.returncode,0,r.stdout+r.stderr);self.assertIn('sanitizer=31',r.stdout)
        self.assertIn('RESULT: FAILED',r.stdout);self.assertNotIn('RESULT: SUCCESS',r.stdout)

    def test_optional_diagnostic_cleanup_warns_without_failing_noop(self):
        extra=r'''optional_probe(){ return 0; }
v56_prepare_tool(){ v56_private_dir && v561_guard optional_probe; }
rm(){ return 29; }
'''
        r=self.run_menu(self.body(extra));self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertIn('RESULT: SUCCESS',r.stdout);self.assertIn('WARNING: temporary_diagnostic_cleanup_failed: exit=29',r.stdout)
        self.assertIn('temporary_diagnostic_cleanup_failed',(self.fixture.state/'logs/warnings.log').read_text())
        self.assertNotIn('synthetic-private',r.stdout+r.stderr)

    def test_optional_archive_failure_keeps_original_blocked_reason(self):
        extra=r'''guard_failure(){ echo '{"status":"BLOCKED","reason":"synthetic_infrastructure_rejected"}';return 2; }
v56_prepare_tool(){ v56_private_dir && v561_guard guard_failure; }
cp(){ return 28; }
'''
        r=self.run_menu(self.body(extra));self.assertNotEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertIn('RESULT: BLOCKED',r.stdout);self.assertIn('synthetic_infrastructure_rejected',r.stdout)
        self.assertIn('diagnostic_archive_failed: exit=28',r.stdout)
        self.assertIn('diagnostic_archive_failed',(self.fixture.state/'logs/warnings.log').read_text())

    def test_existing_launch_json_direct_start_requires_no_reconfiguration(self):
        before=self.fixture.cfg.read_bytes()
        r=subprocess.run(['bash',str(MENU)],input='3\n0\n',text=True,capture_output=True,env=self.fixture.env,cwd=self.fixture.root,timeout=15)
        self.assertEqual(r.returncode,0,r.stdout+r.stderr);self.assertIn('v5.6.2',r.stdout)
        self.assertEqual(before,self.fixture.cfg.read_bytes())


class V562Regression(rt.RuntimeTest):
    """Run existing menu/config/lock/signal scenarios against the new script too."""
    def setUp(self):
        super().setUp()
        menu_patch=patch.object(rt,'MENU',MENU);menu_patch.start();self.addCleanup(menu_patch.stop)

    def test_direct_menu_loads_private_profile_after_selection(self):
        r=subprocess.run(['bash',str(MENU)],input='3\n0\n',text=True,capture_output=True,env=self.env,cwd=self.root,timeout=15)
        self.assertEqual(r.returncode,0,r.stdout+r.stderr);self.assertIn('v5.6.2',r.stdout)
        self.assertFalse(Path('/tmp/jkh_server_menu_v5_3.lock').exists())
