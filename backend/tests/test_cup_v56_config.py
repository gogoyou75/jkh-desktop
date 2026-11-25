"""Private launcher/redaction tests inside the disposable Linux worker."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('cup_config',Path('/work/scripts/cup_config.py'))
config=importlib.util.module_from_spec(spec);spec.loader.exec_module(config)

class ConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='cup-config-');self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);state=self.root/'.schema-state/LOCAL_LAB';state.mkdir(parents=True);state.chmod(0o700);(state/'policy.json').write_text('{}');(state/'policy.json').chmod(0o600);(self.root/'backend').mkdir();(self.root/'backend/schema_workflow.py').write_text('# fixture')
        self.db=self.root/'db.env';self.admin=self.root/'admin.env';self.compose=self.root/'compose.json';self.file=self.root/'launch.json'
        for p in [self.db,self.admin]:p.write_text('ENV_TYPE=LOCAL_LAB');p.chmod(0o600)
        self.compose.write_text('{}')
        self.value={'format':1,'profile':'LOCAL_LAB','project_dir':str(self.root),'db_env_file':str(self.db),'admin_env_file':str(self.admin),'compose_files':[str(self.compose)],'mysql_container':'cup_fixture_mysql','site_check':'http://127.0.0.1:18080'}
        self.write()
    def write(self):self.file.write_text(json.dumps(self.value));self.file.chmod(0o600)
    def test_private_configuration_exports_only_nonsecret_paths(self):
        values=config.configuration(self.file,'LOCAL_LAB')
        self.assertNotIn('DB_PASSWORD',values);self.assertEqual(values['CUP_SCHEMA_ADMIN_ENV_FILE'],str(self.admin))
    def test_insecure_credentials_and_configuration_block(self):
        for file in [self.file,self.admin]:
            file.chmod(0o644)
            with self.assertRaisesRegex(ValueError,'permissions'):config.configuration(self.file,'LOCAL_LAB')
            file.chmod(0o600)
    def test_profile_secret_keys_and_external_compose_block(self):
        with self.assertRaises(ValueError):config.configuration(self.file,'PROD')
        self.value['DB_PASSWORD']='synthetic-only';self.write()
        with self.assertRaises(ValueError):config.configuration(self.file,'LOCAL_LAB')
    def test_symlink_credentials_block(self):
        link=self.root/'link.env';link.symlink_to(self.admin);self.value['admin_env_file']=str(link);self.write()
        with self.assertRaises(ValueError):config.configuration(self.file,'LOCAL_LAB')
    def test_remote_local_health_url_and_credentials_block(self):
        for url in ['http://remote.invalid','http://user:secret@127.0.0.1','http://127.0.0.1/?token=hidden']:
            self.value['site_check']=url;self.write()
            with self.assertRaises(ValueError):config.configuration(self.file,'LOCAL_LAB')
    def test_json_redaction_remains_valid_and_preserves_metadata(self):
        data={'status':'SUCCESS','password':'other-secret','tables':{'users':{'password_hash':{'name':'password_hash','type':'VARCHAR(255)'}}}}
        value=json.loads(config.sanitize(json.dumps(data)))
        self.assertEqual(value['password'],'[REDACTED]');self.assertIn('password_hash',value['tables']['users'])
    def test_redaction_hides_environment_url_and_bearer(self):
        with patch.dict(os.environ,{'MAINT_DB_PASSWORD':'synthetic private'}):
            result=config.sanitize('synthetic private https://u:unknown-pw@host Authorization: Bearer unknown-token')
        for forbidden in ['synthetic private','unknown-pw','unknown-token']:self.assertNotIn(forbidden,result)
    def test_fingerprint_tracks_application_source(self):
        before=config.fingerprint(self.root/'backend');(self.root/'backend/schema_workflow.py').write_text('# changed')
        self.assertNotEqual(before,config.fingerprint(self.root/'backend'))

    def test_windows_acl_failures_block_without_exposing_file_contents(self):
        from types import SimpleNamespace
        with patch.object(config,'WINDOWS',True),patch.object(config.subprocess,'run',return_value=SimpleNamespace(returncode=2)) as check:
            with self.assertRaisesRegex(ValueError,'private_windows_acl_required'):config.private_file(self.file)
            self.assertEqual(check.call_args.kwargs['env']['CUP_CONFIG_CHECK_PATH'],str(self.file))
            self.assertNotIn('synthetic-only',' '.join(check.call_args.args[0]))

    def test_private_maintenance_policy_and_state_directory_required(self):
        policy=self.root/'.schema-state/LOCAL_LAB/policy.json';policy.chmod(0o644)
        with self.assertRaisesRegex(ValueError,'permissions'):config.configuration(self.file,'LOCAL_LAB')
