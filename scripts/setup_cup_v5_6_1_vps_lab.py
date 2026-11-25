"""Owner-run metadata-only setup. Never connects to Docker, MySQL, SSH or VPS."""
import argparse
import json
import os
from pathlib import Path
import tempfile
import re
from cup_config import configuration, private_file

PROJECT=Path('/root/jkh-lab')
SOURCES={'db_env_file':Path('/root/jkh-lab/.env.api'),
         'admin_env_file':Path('/root/jkh-lab-backups/v55-maintenance.env'),
         'restore_env_file':Path('/root/jkh-lab-backups/v55-restore-cup.env')}

def setup(write=False):
    if os.name!='posix' or os.getuid()!=0:raise ValueError('owner_root_linux_required')
    if PROJECT.resolve()!=Path('/root/jkh-lab'):raise ValueError('project_identity_mismatch')
    for key,path in SOURCES.items():
        private_file(path)
        names=set(re.findall(r'(?m)^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=',path.read_text(encoding='utf8')))
        prefix={'db_env_file':'','admin_env_file':'MAINT_','restore_env_file':'RESTORE_'}[key]
        required={prefix+k for k in ['ENV_TYPE','DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD']}
        if required-names:raise ValueError('required_variable_names_missing:'+','.join(sorted(required-names))+'; file='+str(path))
    state=PROJECT/'.schema-state/LAB'
    private_file(state/'policy.json')
    compose=PROJECT/'docker-compose.yml'
    if not compose.is_file():raise ValueError('existing_compose_file_required')
    payload={'format':1,'profile':'VPS_LAB','project_dir':str(PROJECT),
             **{key:str(value) for key,value in SOURCES.items()},'compose_files':[str(compose)]}
    target=state/'launch.json'
    if target.exists():
        private_file(target)
        if json.loads(target.read_text())!=payload:raise ValueError('existing_launch_differs_review_it_no_automatic_overwrite')
        configuration(target,'VPS_LAB')
        return {'status':'SUCCESS','action':'already_configured','expected_path':str(target),'restore_target':'NOT_CHECKED_USED_TARGET_IS_NOT_CLEARED'}
    fd,name=tempfile.mkstemp(prefix='.launch-check-',suffix='.json',dir=state)
    temp=Path(name)
    try:
        with os.fdopen(fd,'w',encoding='utf8') as file:json.dump(payload,file,indent=2);file.write('\n')
        configuration(temp,'VPS_LAB')
        if write:os.link(temp,target) # exclusive publication; never overwrite an existing launch
        return {'status':'SUCCESS','action':'created' if write else 'validated_dry_run','expected_path':str(target),
                'restore_target':'NOT_CHECKED_PROVIDE_SEPARATE_VERIFIED_EMPTY_TARGET_FOR_NEW_MIGRATION'}
    finally:
        if temp.parent.resolve()==state.resolve() and temp.name.startswith('.launch-check-'):temp.unlink(missing_ok=True)

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--write',action='store_true');args=parser.parse_args()
    try:
        result=setup(args.write)
        print('RESULT: SUCCESS\nКонфигурация: '+result['expected_path']+'\nДействие: '+result['action'])
        print('Существующие credentials, policy и restore-БД не изменены. Для новой миграции нужен отдельный проверенный пустой restore-target. БД не проверялась.')
        return 0
    except Exception as exc:
        reason=str(exc) if isinstance(exc,ValueError) else 'metadata_setup_failed'
        print('RESULT: BLOCKED\nПричина: '+reason+'\nНикакие рабочие БД или существующие файлы не изменены.')
        return 2

if __name__=='__main__':raise SystemExit(main())
