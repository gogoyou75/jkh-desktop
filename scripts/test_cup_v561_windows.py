"""Native Windows/Git Bash regression checks; no DB connections or ACL changes."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import cup_lock

ROOT=Path(__file__).resolve().parents[1]
BASH=Path(os.environ.get('ProgramFiles',r'C:\Program Files'))/'Git/bin/bash.exe'

@unittest.skipUnless(os.name=='nt' and BASH.is_file(),'Windows Git Bash required')
class WindowsRuntimeTest(unittest.TestCase):
    def setUp(self):
        state=ROOT/'.var/cup-v561';state.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(prefix='native-',dir=state);self.addCleanup(self.temp.cleanup)
        self.directory=Path(self.temp.name)
        self.env=dict(os.environ,CUP_HOST_PYTHON=sys.executable,PYTHONIOENCODING='utf8')
    def test_native_instance_acquire_and_release_preserve_binary_fingerprint(self):
        driver=self.directory/'jkh_server_menu_v5_6_1.sh'
        driver.write_text('''set -u
root="$(pwd)"
helper="$root/scripts/cup_lock.py"
project="$(cd "$(dirname "$(cygpath -u "$0")")" && pwd)"
cd "$project" || exit 1
path="$project/operation.lock"
"$CUP_HOST_PYTHON" "$helper" register --pid "$BASHPID" --env LOCAL_LAB --directory "$project" --phase MENU_WAIT || exit $?
"$CUP_HOST_PYTHON" "$helper" acquire --path "$path" --pid "$BASHPID" --token synthetic-test --env LOCAL_LAB --directory "$project" || exit $?
"$CUP_HOST_PYTHON" "$helper" release --path "$path" --pid "$BASHPID" --token synthetic-test || exit $?
echo PASS_NATIVE_LOCK
''',encoding='utf8',newline='\n')
        r=subprocess.run([str(BASH),str(driver)],cwd=ROOT,env=self.env,text=True,capture_output=True,timeout=40)
        self.assertEqual(r.returncode,0,r.stdout+r.stderr);self.assertIn('PASS_NATIVE_LOCK',r.stdout)
        self.assertFalse((self.directory/'operation.lock').exists())
    def test_cup_cmd_missing_config_blocks_before_database_access(self):
        self.env['CUP_V56_CONFIG']=str(self.directory/'missing-launch.json')
        r=subprocess.run(['cmd','/d','/c',str(ROOT/'scripts/cup.cmd'),'LOCAL_LAB'],cwd=ROOT,env=self.env,text=True,capture_output=True,encoding='utf8',timeout=25)
        self.assertEqual(r.returncode,2,r.stdout+r.stderr);self.assertIn('RESULT: BLOCKED',r.stdout)
        self.assertIn('missing-launch.json',r.stderr);self.assertIn('NOT_CHECKED',r.stdout)
    def test_msys_launcher_requires_same_executable_and_direct_parent(self):
        with patch.object(cup_lock,'native_parents',return_value={22:11}), patch.object(cup_lock,'windows_birth',return_value='100'), patch.object(cup_lock,'native_image',side_effect=[Path('foreign.exe'),Path('bash.exe')]):
            self.assertFalse(cup_lock.windows_helper_parent(11,22))
        with patch.object(cup_lock,'native_parents',return_value={22:99}):
            self.assertFalse(cup_lock.windows_helper_parent(11,22))
    def test_arbitrary_parent_cannot_register_cup_identity(self):
        r=subprocess.run([sys.executable,str(ROOT/'scripts/cup_lock.py'),'register','--pid',str(os.getpid()),'--env','LOCAL_LAB','--directory',str(ROOT),'--phase','MENU_WAIT'],cwd=ROOT,text=True,capture_output=True,timeout=15)
        self.assertEqual(r.returncode,2);self.assertEqual(json.loads(r.stdout)['state'],'UNDETERMINED')

if __name__=='__main__':unittest.main(verbosity=2)
