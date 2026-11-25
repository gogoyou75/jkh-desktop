"""Private launcher configuration and redacted tool output; never prints credentials."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
from urllib.parse import quote, urlsplit

ROOT=Path(__file__).resolve().parents[1]
WINDOWS=os.name=='nt'

class ConfigError(ValueError):
    def __init__(self,code,path):
        super().__init__(code);self.expected=str(Path(path).absolute())

def default_config(profile,root):
    environment={'LOCAL_LAB':'LOCAL_LAB','VPS_LAB':'LAB','PROD':'PROD'}[profile]
    project=Path(root) if profile=='LOCAL_LAB' else Path('/root/jkh-lab' if profile=='VPS_LAB' else '/root/jkh')
    return (project/'.schema-state'/environment/'launch.json').as_posix()

def private_file(path):
    path=Path(path).absolute()
    if path.is_symlink() or not path.is_file():raise ConfigError('private_configuration_file_required',path)
    if WINDOWS:
        env=dict(os.environ,CUP_CONFIG_CHECK_PATH=str(path))
        script="""$ErrorActionPreference='Stop'; $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $ok=@($me,'S-1-5-18','S-1-5-32-544'); foreach($p in @($env:CUP_CONFIG_CHECK_PATH,([System.IO.Path]::GetDirectoryName($env:CUP_CONFIG_CHECK_PATH)))){if([System.IO.Directory]::Exists($p)){$a=[System.IO.Directory]::GetAccessControl($p)}else{$a=[System.IO.File]::GetAccessControl($p)}; if($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $ok){exit 2}; foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){$sid=$r.IdentityReference.Value; if($r.AccessControlType -eq 'Allow' -and $sid -notin $ok -and $sid -ne 'S-1-3-0'){exit 2}}}; exit 0"""
        if subprocess.run(['powershell','-NoProfile','-NonInteractive','-Command',script],env=env,capture_output=True).returncode:raise ConfigError('private_windows_acl_required',path)
    else:
        info=path.stat()
        if info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)&0o077 or path.parent.stat().st_uid!=os.getuid() or stat.S_IMODE(path.parent.stat().st_mode)&0o022:raise ConfigError('owner_only_configuration_permissions_required',path)
    return path


def configuration(path,profile):
    path=private_file(path)
    try:c=json.loads(path.read_text(encoding='utf8'))
    except (ValueError,UnicodeError):raise ConfigError('launch_json_invalid',path)
    allowed={'format','profile','project_dir','db_env_file','admin_env_file','compose_files','mysql_container','site_check','restore_env_file'}
    if set(c)-allowed or c.get('format')!=1 or c.get('profile')!=profile:raise ValueError('configuration_profile_or_fields_invalid')
    project=Path(c['project_dir']).resolve()
    expected={'VPS_LAB':'/root/jkh-lab','PROD':'/root/jkh'}
    if profile in expected and str(project)!=expected[profile]:raise ValueError('server_project_identity_mismatch')
    if profile=='LOCAL_LAB' and str(project).replace('\\','/').startswith('/root/'):raise ValueError('local_project_cannot_be_server_path')
    environment={'LOCAL_LAB':'LOCAL_LAB','VPS_LAB':'LAB','PROD':'PROD'}[profile]
    private_file(project/'.schema-state'/environment/'policy.json')
    if not (project/'backend/schema_workflow.py').is_file():raise ValueError('project_has_no_v56_workflow')
    values={'CUP_V56_PROFILE':profile,'CUP_SCHEMA_DB_ENV_FILE':private_file(c['db_env_file']).as_posix(),
            'CUP_SCHEMA_ADMIN_ENV_FILE':private_file(c['admin_env_file']).as_posix(),'CUP_V56_PROJECT':project.as_posix()}
    if c.get('restore_env_file'):values['CUP_SCHEMA_RESTORE_ENV_FILE']=private_file(c['restore_env_file']).as_posix()
    compose=[Path(p).resolve().as_posix() for p in c['compose_files']]
    if not compose or any(not Path(p).is_file() or not Path(p).is_relative_to(project) for p in compose):raise ValueError('explicit_project_compose_files_required')
    if any('|' in p for p in compose):raise ValueError('unsupported_compose_path')
    values.update(COMPOSE_FILE='|'.join(compose),COMPOSE_PATH_SEPARATOR='|')
    if profile=='LOCAL_LAB':
        url=urlsplit(c['site_check'])
        if url.scheme not in {'http','https'} or url.hostname not in {'127.0.0.1','localhost','::1'} or url.username or url.password or url.query or url.fragment:raise ValueError('local_health_url_must_be_loopback_without_credentials')
        if not re.fullmatch(r'(cup_|jkh_local)[a-zA-Z0-9_-]*',c['mysql_container']):raise ValueError('local_container_identity_required')
        values.update(CUP_LOCAL_PROJECT_DIR=project.as_posix(),CUP_LOCAL_MYSQL_CONTAINER=c['mysql_container'],CUP_LOCAL_SITE_CHECK=c['site_check'])
    return values


def fingerprint(directory):
    directory=Path(directory)
    files=[p for p in directory.rglob('*') if p.is_file() and not any(x in p.parts for x in ('__pycache__','.git','tests','.pytest_cache','.schema-state')) and p.suffix not in {'.pyc','.env'}]
    # Never include local credentials, backups or test artifacts in a build token.
    files=[p for p in files if p.suffix in {'.py','.json','.ini','.txt','.sql','.mako'} or p.name=='Dockerfile']
    digest=hashlib.sha256()
    for p in sorted(files):digest.update(str(p.relative_to(directory)).replace('\\','/').encode()+b'\0'+hashlib.sha256(p.read_bytes()).digest())
    return digest.hexdigest()


def sanitize(value):
    secrets=[v for k,v in os.environ.items() if v and re.search(r'PASSWORD|SECRET|TOKEN|AUTHORIZATION',k,re.I)]
    for secret in sorted(secrets,key=len,reverse=True):
        for form in {secret,json.dumps(secret)[1:-1],quote(secret,safe='')}:value=value.replace(form,'[REDACTED]')
    def clean(obj):
        if isinstance(obj,dict):return {k:('[REDACTED]' if re.search(r'password|secret|token|authorization',k,re.I) and isinstance(v,str) else clean(v)) for k,v in obj.items()}
        if isinstance(obj,list):return [clean(x) for x in obj]
        return obj
    result=[]
    for line in value.splitlines(keepends=True):
        try:result.append(json.dumps(clean(json.loads(line)),ensure_ascii=False)+('\n' if line.endswith('\n') else ''));continue
        except (ValueError,TypeError):pass
        line=re.sub(r'(?i)(authorization\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s]+',r'\1[REDACTED]',line)
        line=re.sub(r'([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@\s]+:[^/@\s]+@',r'\1[REDACTED]@',line)
        line=re.sub(r'(?i)((?:password|secret|token)[a-z_]*[\"\']?\s*[:=]\s*)(?:\"[^\"]*\"|\'[^\']*\'|[^\s,}]+)',r'\1[REDACTED]',line)
        result.append(line)
    return ''.join(result)


def main():
    if hasattr(sys.stdin,'reconfigure'):sys.stdin.reconfigure(encoding='utf8',errors='replace')
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf8')
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['config','fingerprint','sanitize','locate'])
    parser.add_argument('path',nargs='?');parser.add_argument('--profile',choices=['LOCAL_LAB','VPS_LAB','PROD'])
    parser.add_argument('--error-format',choices=['text','json'],default='text')
    args=parser.parse_args()
    try:
        if args.action=='config':
            for key,value in configuration(args.path,args.profile).items():print('export '+key+'='+shlex.quote(value))
        elif args.action=='locate':print(default_config(args.profile,args.path))
        elif args.action=='fingerprint':print(fingerprint(args.path))
        else:print(sanitize(sys.stdin.read()),end='')
        return 0
    except Exception as exc:
        reason=str(exc) if isinstance(exc,ValueError) else 'configuration_unavailable'
        if args.error_format=='json':print(json.dumps({'status':'BLOCKED','reason':reason,'expected_path':getattr(exc,'expected',args.path),'next':'configure_private_launch_json_and_existing_credential_files'}),file=sys.stderr)
        else:print('BLOCKED: '+reason+'; expected: '+str(getattr(exc,'expected',args.path))+'; configure private launch.json (docs/CUP_V561_OPERATIONS.md)',file=sys.stderr)
        return 2

if __name__=='__main__':raise SystemExit(main())
