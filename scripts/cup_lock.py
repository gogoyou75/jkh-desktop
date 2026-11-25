"""Cross-version CUP file lock. No database access, account unlock or SIGKILL."""
import argparse
from contextlib import contextmanager
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
import secrets
from datetime import datetime,timezone

FAMILY=re.compile(rb'jkh_server_menu_v5_[0-9_]+\.sh')

class Uncertain(RuntimeError):pass

def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'))
def checksum(v):return hashlib.sha256(v).hexdigest()

def bash(*args):
    exe=os.environ.get('CUP_GIT_BASH',r'C:\Program Files\Git\bin\bash.exe')
    return subprocess.run([exe,*args],capture_output=True,timeout=5)

def windows_pids():
    r=bash('-c','ps -W')
    if r.returncode:raise Uncertain('process_inventory_unavailable')
    rows={}
    for line in r.stdout.decode('utf8','replace').splitlines()[1:]:
        fields=line.split()
        if len(fields)>=8:
            try:rows[int(fields[0])]={'pid':int(fields[0]),'ppid':int(fields[1]),'pgid':int(fields[2]),'native':int(fields[3]),'uid':fields[5],'is_bash':'bash' in fields[7].lower()}
            except ValueError:pass
    return rows

def windows_birth(pid):
    from ctypes import wintypes
    k=ctypes.WinDLL('kernel32',use_last_error=True)
    k.OpenProcess.restype=wintypes.HANDLE;k.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD]
    k.GetProcessTimes.argtypes=[wintypes.HANDLE,*([ctypes.POINTER(wintypes.FILETIME)]*4)]
    k.CloseHandle.argtypes=[wintypes.HANDLE]
    handle=k.OpenProcess(0x1000,False,pid)
    if not handle:return None
    try:
        values=[wintypes.FILETIME() for _ in range(4)]
        if not k.GetProcessTimes(handle,*[ctypes.byref(x) for x in values]):raise Uncertain('process_start_unavailable')
        return str((values[0].dwHighDateTime<<32)|values[0].dwLowDateTime)
    finally:k.CloseHandle(handle)

def native_image(pid):
    from ctypes import wintypes
    k=ctypes.WinDLL('kernel32',use_last_error=True)
    k.OpenProcess.restype=wintypes.HANDLE;k.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD]
    k.QueryFullProcessImageNameW.argtypes=[wintypes.HANDLE,wintypes.DWORD,wintypes.LPWSTR,ctypes.POINTER(wintypes.DWORD)]
    k.CloseHandle.argtypes=[wintypes.HANDLE]
    handle=k.OpenProcess(0x1000,False,pid)
    if not handle:raise Uncertain('native_image_unavailable')
    try:
        value=ctypes.create_unicode_buffer(32768);length=wintypes.DWORD(len(value))
        if not k.QueryFullProcessImageNameW(handle,0,value,ctypes.byref(length)):raise Uncertain('native_image_unavailable')
        return Path(value.value).resolve()
    finally:k.CloseHandle(handle)


def windows_helper_parent(expected,caller):
    # MSYS forks a transient bash.exe native launcher before starting Python.
    # Accept only a direct child with the SAME executable as the proven CUP owner;
    # arbitrary native descendants or a different binary never prove ownership.
    if caller==expected:return True
    parents=native_parents()
    if parents.get(caller)!=expected:return False
    before=windows_birth(caller);owner_birth=windows_birth(expected)
    if not before or not owner_birth or int(before)<int(owner_birth):return False
    if native_image(caller)!=native_image(expected):return False
    return before==windows_birth(caller) and owner_birth==windows_birth(expected)


def process(pid):
    if os.name=='nt':
        rows=windows_pids();p=rows.get(pid)
        if not p:return None
        birth=windows_birth(p['native'])
        if not birth:raise Uncertain('process_identity_unavailable')
        cmd=bash('-c','cat /proc/"$1"/cmdline','--',str(pid))
        cwd=bash('-c','p=$(readlink /proc/"$1"/cwd) && cygpath -m "$p"','--',str(pid))
        if cmd.returncode or cwd.returncode:raise Uncertain('process_identity_unavailable')
        return {**p,'start':birth,'boot':'windows','cmd_hash':checksum(cmd.stdout),'cup':bool(FAMILY.search(cmd.stdout)),'version':(FAMILY.search(cmd.stdout).group().decode() if FAMILY.search(cmd.stdout) else ''),
                'cwd':str(Path(cwd.stdout.decode().strip()).resolve()),'waiting':False,'state':'?'}
    root=Path('/proc')/str(pid)
    try:
        raw=(root/'stat').read_text();tail=raw[raw.rfind(')')+2:].split()
        cmd=(root/'cmdline').read_bytes()
        p={'pid':pid,'ppid':int(tail[1]),'pgid':int(tail[2]),'uid':str(root.stat().st_uid),
           'start':tail[19],'boot':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
           'cmd_hash':checksum(cmd),'cup':bool(FAMILY.search(cmd)),'version':(FAMILY.search(cmd).group().decode() if FAMILY.search(cmd) else ''),'state':tail[0]}
        boot_time=int(next(x.split()[1] for x in Path('/proc/stat').read_text().splitlines() if x.startswith('btime ')))
        p['start_epoch']=boot_time+int(tail[19])/os.sysconf('SC_CLK_TCK')
        p['cwd']=str((root/'cwd').resolve(strict=True)) if p['state']!='Z' else ''
        p['waiting']=False
        try:
            call=(root/'syscall').read_text().split()
            # Linux x86-64 read(0,...) and AArch64 read(0,...).
            p['waiting']=len(call)>1 and call[0] in {'0','63'} and int(call[1],0)==0
        except (OSError,ValueError):pass
        return p
    except FileNotFoundError:return None
    except (OSError,ValueError,IndexError):raise Uncertain('process_identity_unavailable')

def native_parents():
    from ctypes import wintypes
    class Entry(ctypes.Structure):
        _fields_=[('dwSize',wintypes.DWORD),('cntUsage',wintypes.DWORD),('pid',wintypes.DWORD),('heap',ctypes.c_size_t),
                  ('module',wintypes.DWORD),('threads',wintypes.DWORD),('parent',wintypes.DWORD),('priority',wintypes.LONG),('flags',wintypes.DWORD),('exe',wintypes.WCHAR*260)]
    k=ctypes.WinDLL('kernel32',use_last_error=True)
    k.CreateToolhelp32Snapshot.restype=wintypes.HANDLE
    k.Process32FirstW.argtypes=[wintypes.HANDLE,ctypes.POINTER(Entry)];k.Process32NextW.argtypes=k.Process32FirstW.argtypes
    k.CloseHandle.argtypes=[wintypes.HANDLE]
    handle=k.CreateToolhelp32Snapshot(2,0)
    if handle in (None,ctypes.c_void_p(-1).value):raise Uncertain('native_process_inventory_unavailable')
    result={}
    try:
        entry=Entry();entry.dwSize=ctypes.sizeof(entry);ok=k.Process32FirstW(handle,ctypes.byref(entry))
        while ok:
            result[int(entry.pid)]=int(entry.parent);ok=k.Process32NextW(handle,ctypes.byref(entry))
        return result
    finally:k.CloseHandle(handle)


def current_key(allp):
    if os.name!='nt':return os.getpid()
    return next((pid for pid,p in allp.items() if p.get('native')==os.getpid()),-os.getpid())


def processes():
    if os.name=='nt':
        rows=windows_pids();parents=native_parents();mapping={p['native']:pid for pid,p in rows.items()};out={}
        for native,parent in parents.items():
            pid=mapping.get(native,-native)
            try:p=process(pid) if pid>0 and rows[pid].get('is_bash') else None
            except Uncertain:p=None
            p=p or {'pid':pid,'native':native,'unknown':True,'start':windows_birth(native)}
            p['ppid']=mapping.get(parent,-parent);out[pid]=p
        return out
    out={}
    for root in Path('/proc').iterdir():
        if not root.name.isdigit():continue
        pid=int(root.name)
        try:p=process(pid)
        except Uncertain:out[pid]={'pid':pid,'unknown':True};continue
        if p:out[pid]=p
    return out


def ancestors(pid,allp):
    found=set()
    while pid in allp and pid not in found:
        found.add(pid);pid=allp[pid].get('ppid',0)
    return found

def children(pid,allp):
    found=set();front={pid}
    while front:
        batch={p for p,x in allp.items() if x.get('ppid') in front and p not in found and p!=pid}
        found|=batch;front=batch
    return found

def oneoffs(directory):
    host=os.environ.get('DOCKER_HOST','')
    if not host:
        r=subprocess.run(['docker','context','inspect','--format','{{.Endpoints.docker.Host}}'],capture_output=True,timeout=5)
        if r.returncode:raise Uncertain('container_inventory_unavailable')
        host=r.stdout.decode().strip()
    if not host.startswith(('unix:','npipe:')):raise Uncertain('container_engine_not_local')
    r=subprocess.run(['docker','--host',host,'ps','--filter','label=com.docker.compose.oneoff=True','--format','{{.ID}}'],capture_output=True,timeout=5)
    if r.returncode:raise Uncertain('container_inventory_unavailable')
    ids=r.stdout.decode().split()
    if not ids:return []
    r=subprocess.run(['docker','--host',host,'inspect','--format','{{json .Config.Labels}}',*ids],capture_output=True,timeout=5)
    if r.returncode:raise Uncertain('container_inventory_unavailable')
    found=[]
    lines=r.stdout.decode().splitlines()
    if len(lines)!=len(ids):raise Uncertain('container_inventory_incomplete')
    for identifier,line in zip(ids,lines):
        labels=json.loads(line)
        if not isinstance(labels,dict):raise Uncertain('container_labels_unavailable')
        work=labels.get('com.docker.compose.project.working_dir')
        if not work:raise Uncertain('unattributed_oneoff_container')
        if Path(work).resolve()==Path(directory).resolve():found.append(identifier)
    return found

@contextmanager
def guard(path):
    guard_path=Path(str(path)+'.guard')
    if guard_path.is_symlink():raise Uncertain('unsafe_lock_guard')
    fd=os.open(guard_path,os.O_CREAT|os.O_RDWR|getattr(os,'O_NOFOLLOW',0),0o600)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or (os.name!='nt' and info.st_uid!=os.getuid()):raise Uncertain('unsafe_lock_guard')
        if not info.st_size:os.write(fd,b'0')
        deadline=time.monotonic()+5
        while True:
            try:
                if os.name=='nt':
                    import msvcrt
                    os.lseek(fd,0,0);msvcrt.locking(fd,msvcrt.LK_NBLCK,1)
                else:
                    import fcntl
                    fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic()>deadline:raise Uncertain('lock_guard_busy')
                time.sleep(.05)
        yield
    finally:os.close(fd)


def read_lock(path):
    if path.is_symlink():raise Uncertain('lock_is_symlink')
    fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_BINARY',0))
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size>32768 or (os.name!='nt' and info.st_uid!=os.getuid()):raise Uncertain('invalid_lock_file')
        raw=os.read(fd,32769)
        try:meta=json.loads(raw)
        except ValueError:
            match=re.fullmatch(r'pid=(\d+) env=(LOCAL_LAB|LAB|PROD) dir=(.*?) date=(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s*',raw.decode('utf8'))
            if not match:raise Uncertain('unrecognized_legacy_lock')
            meta={'format':1,'pid':int(match[1]),'env':match[2],'directory':match[3]}
        if meta.get('format') not in {1,2} or not isinstance(meta.get('pid'),int):raise Uncertain('invalid_lock_metadata')
        return meta,(info.st_dev,info.st_ino),checksum(raw),info.st_mtime
    finally:os.close(fd)


def registry_path(p,directory):
    key=checksum(canonical({k:p.get(k) for k in ('pid','start','boot','cmd_hash','uid')}).encode())
    return Path(directory)/'.schema-state'/'instances'/('instance-'+key+'.json')


def registry(p,directory):
    path=registry_path(p,directory)
    try:
        if path.is_symlink() or path.stat().st_size>32768:return None
        data=json.loads(path.read_text())
        if all(data['owner'].get(k)==p.get(k) for k in ('pid','start','boot','cmd_hash','uid')) and Path(data['directory']).resolve()==Path(directory).resolve():return data
    except (OSError,ValueError,KeyError):pass
    return None


def register(pid,environment,directory,phase):
    p=process(pid)
    if not p or not p['cup']:raise Uncertain('instance_identity_not_proven')
    if (p['pid']!=os.getppid() if os.name!='nt' else not windows_helper_parent(p['native'],os.getppid())):
        # The helper is always invoked directly by the instance being registered.
        raise Uncertain('instance_not_helper_parent')
    if phase not in {'MENU_WAIT','SUBMENU_WAIT','RUNNING','WAITING_CONFIRM'}:raise Uncertain('invalid_instance_phase')
    target=registry_path(p,directory);target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temporary=target.with_name(target.name+'.'+secrets.token_hex(6))
    fd=os.open(temporary,os.O_CREAT|os.O_EXCL|os.O_WRONLY|getattr(os,'O_BINARY',0),0o600)
    try:
        os.write(fd,canonical({'owner':p,'env':environment,'directory':str(Path(directory).resolve()),'phase':phase}).encode());os.fsync(fd)
    finally:os.close(fd)
    os.replace(temporary,target)
    return {'state':'REGISTERED','reason':phase}


def describe(path):
    if not path.exists() and not path.is_symlink():return {'state':'FREE','reason':'no_operational_lock'}
    try:
        meta,inode,fingerprint,mtime=read_lock(path);owner=process(meta['pid'])
        base={'pid':meta['pid'],'env':meta.get('env'),'directory':meta.get('directory'),'fingerprint':fingerprint,'format':meta['format']}
        allp=processes();ignored=ancestors(current_key(allp),allp)|children(current_key(allp),allp)
        if owner:
            if meta['format']==1 and owner.get('start_epoch',0)>mtime+1:return {**base,'state':'UNDETERMINED','reason':'legacy_pid_reused'}
            if meta['format']==2 and any(owner.get(k)!=meta['owner'].get(k) for k in ('start','boot','cmd_hash','uid')):
                return {**base,'state':'UNDETERMINED','reason':'pid_reused_or_owner_identity_changed'}
            if not owner['cup'] or Path(owner['cwd']).resolve()!=Path(meta['directory']).resolve():
                return {**base,'state':'UNDETERMINED','reason':'owner_identity_or_environment_not_proven'}
            descendants=children(owner['pid'],allp)-ignored
            instance=registry(owner,meta['directory'])
            state='WAITING_CONFIRM' if instance and instance['phase']=='WAITING_CONFIRM' else ('WAITING_INSTANCE' if owner['waiting'] and not descendants else ('ACTIVE_OPERATION' if descendants or meta['format']==2 else 'UNDETERMINED'))
            return {**base,'state':state,'reason':'live_owner_never_reclaimed','children':len(descendants),'start':owner['start'],'owner_version':owner.get('version','unknown'),'start_utc':datetime.fromtimestamp(owner.get('start_epoch',int(owner['start'])/10000000-11644473600 if os.name=='nt' else 0),timezone.utc).isoformat()}
        if meta['format']==1 and os.name=='nt':return {**base,'state':'UNDETERMINED','reason':'legacy_windows_pid_and_children_not_proven'}
        related=[]
        for pid,p in allp.items():
            if pid in ignored or p.get('state')=='Z':continue
            if p.get('unknown'):raise Uncertain('process_inventory_incomplete')
            same_directory=p.get('cwd') and Path(p['cwd']).resolve()==Path(meta['directory']).resolve()
            same_group=meta['format']==2 and p.get('pgid')==meta['owner'].get('pgid')
            idle=registry(p,meta['directory']) if same_directory or same_group else None
            if idle and idle.get('phase') in {'MENU_WAIT','SUBMENU_WAIT'}:continue
            if same_directory or same_group:related.append(pid)
        containers=oneoffs(meta['directory'])
        if related or containers:return {**base,'state':'UNDETERMINED','reason':'associated_processes_or_oneoff_containers_remain','children':len(related),'containers':len(containers)}
        return {**base,'state':'CONFIRMED_STALE','reason':'owner_absent_no_associated_processes_or_containers'}
    except (OSError,ValueError,KeyError,Uncertain,subprocess.SubprocessError) as exc:
        return {'state':'UNDETERMINED','reason':str(exc) if isinstance(exc,Uncertain) else 'lock_evidence_unavailable','error_type':type(exc).__name__,'errno':getattr(exc,'errno',None)}


def acquire(path,pid,token,environment,directory):
    owner=process(pid)
    if not owner or not owner['cup'] or Path(owner['cwd']).resolve()!=Path(directory).resolve():raise Uncertain('new_owner_identity_not_proven')
    with guard(path):
        if path.exists() or path.is_symlink():return describe(path)
        meta={'format':2,'pid':pid,'env':environment,'directory':str(Path(directory).resolve()),'owner':owner,'token':token,'created_at':time.time()}
        fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_BINARY',0),0o600)
        try:os.write(fd,canonical(meta).encode()+b'\n');os.fsync(fd)
        finally:os.close(fd)
        return {'state':'ACQUIRED','reason':'exclusive_operational_lock','pid':pid}


def release(path,pid,token):
    with guard(path):
        if not path.exists():raise Uncertain('owned_lock_disappeared')
        meta,inode,fingerprint,mtime=read_lock(path);owner=process(pid)
        if meta.get('format')!=2 or meta['pid']!=pid or meta.get('token')!=token or not owner or owner['start']!=meta['owner']['start']:raise Uncertain('lock_ownership_not_proven')
        allp=processes();remaining=children(pid,allp)-ancestors(current_key(allp),allp)-children(current_key(allp),allp)
        remaining={p for p in remaining if allp[p].get('state')!='Z'}
        if remaining or oneoffs(meta['directory']):raise Uncertain('owned_children_or_container_still_active_lock_retained')
        info=path.lstat()
        if (info.st_dev,info.st_ino)!=inode or checksum(path.read_bytes())!=fingerprint:raise Uncertain('lock_changed_during_release')
        path.unlink()
        return {'state':'RELEASED','reason':'owned_operation_finished'}


def recover(path,expected,environment,directory,confirmation):
    with guard(path):
        before=describe(path)
        if before['state']!='CONFIRMED_STALE':raise Uncertain(before['reason'])
        if before['fingerprint']!=expected:raise Uncertain('lock_changed_new_confirmation_required')
        if before['env']!=environment or Path(before['directory']).resolve()!=Path(directory).resolve():raise Uncertain('lock_environment_mismatch')
        if confirmation!='RECOVER '+environment:raise Uncertain('owner_confirmation_required')
        meta,inode,fingerprint,mtime=read_lock(path)
        # Revalidate AFTER confirmation while holding the non-replaced guard.
        if describe(path)['state']!='CONFIRMED_STALE':raise Uncertain('lock_state_changed')
        info=path.lstat()
        if (info.st_dev,info.st_ino)!=inode or checksum(path.read_bytes())!=fingerprint:raise Uncertain('lock_changed_during_recovery')
        path.unlink();return {'state':'RECOVERED','reason':'confirmed_stale_file_only_maintenance_unchanged'}


def stop_tree(pid,expected):
    root=process(pid);allp=processes()
    caller=os.getppid()
    if not root or root['start']!=expected:raise Uncertain('signal_target_identity_changed')
    if os.name!='nt' and root['ppid']!=caller:raise Uncertain('signal_target_not_own_child')
    if os.name=='nt':
        parent=process(root['ppid'])
        if not parent or not windows_helper_parent(parent['native'],caller):raise Uncertain('signal_target_not_own_child')
    if not root['cup']:raise Uncertain('signal_target_not_cup')
    targets=children(pid,allp)
    for target in [*sorted(targets,reverse=True),pid]:
        if target<1:continue
        known=allp.get(target);now=process(target)
        if not known or not now or known.get('start')!=now.get('start'):continue
        try:
            if os.name=='nt':bash('-c','kill -TERM "$1"','--',str(target))
            else:os.kill(target,signal.SIGTERM)
        except ProcessLookupError:pass
    return {'state':'SIGNALLED','reason':'SIGTERM_to_own_verified_tree_only'}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['status','acquire','release','recover','identity','stop-tree','register'])
    parser.add_argument('--path',type=Path);parser.add_argument('--pid',type=int);parser.add_argument('--token')
    parser.add_argument('--env');parser.add_argument('--directory');parser.add_argument('--expected');parser.add_argument('--confirmation')
    parser.add_argument('--phase')
    args=parser.parse_args()
    try:
        if args.action=='identity':
            p=process(args.pid)
            if not p:raise Uncertain('process_absent')
            print(p['start']);return 0
        if args.action=='register':result=register(args.pid,args.env,args.directory,args.phase)
        elif args.action=='status':result=describe(args.path)
        elif args.action=='acquire':result=acquire(args.path,args.pid,args.token,args.env,args.directory)
        elif args.action=='release':result=release(args.path,args.pid,args.token)
        elif args.action=='recover':result=recover(args.path,args.expected,args.env,args.directory,args.confirmation)
        else:result=stop_tree(args.pid,args.expected)
        print(canonical(result))
        return 0 if result['state'] in {'FREE','ACQUIRED','RELEASED','RECOVERED','SIGNALLED','REGISTERED'} else 2
    except (OSError,ValueError,KeyError,Uncertain,subprocess.SubprocessError) as exc:
        print(canonical({'state':'UNDETERMINED','reason':str(exc) if isinstance(exc,Uncertain) else 'lock_operation_failed','error_type':type(exc).__name__,'errno':getattr(exc,'errno',None)}));return 2

if __name__=='__main__':raise SystemExit(main())
