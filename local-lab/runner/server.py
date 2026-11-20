"""Loopback-only, fixed-operation bridge to the LOCAL LAB Docker project."""

import hashlib
import ctypes
import hmac
import json
import os
import re
import stat
import subprocess
import tempfile
import threading
import uuid
import time
from collections import deque
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def _windows_api():
    if os.name != 'nt':
        raise RunnerBlocked('windows_security_required')
    from ctypes import wintypes as w
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    signatures = {
        'CreateFileW': (w.HANDLE, [w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE]),
        'CloseHandle': (w.BOOL, [w.HANDLE]),
        'CreateJobObjectW': (w.HANDLE, [w.LPVOID, w.LPCWSTR]),
        'SetInformationJobObject': (w.BOOL, [w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD]),
        'QueryInformationJobObject': (w.BOOL, [w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD, w.LPVOID]),
        'AssignProcessToJobObject': (w.BOOL, [w.HANDLE, w.HANDLE]),
        'TerminateJobObject': (w.BOOL, [w.HANDLE, w.UINT]),
        'ResumeThread': (w.DWORD, [w.HANDLE]),
        'WaitForSingleObject': (w.DWORD, [w.HANDLE, w.DWORD]),
        'GetExitCodeProcess': (w.BOOL, [w.HANDLE, ctypes.POINTER(w.DWORD)]),
        'TerminateProcess': (w.BOOL, [w.HANDLE, w.UINT]),
        'OpenProcess': (w.HANDLE, [w.DWORD, w.BOOL, w.DWORD]),
        'CreateProcessW': (w.BOOL, [w.LPCWSTR, w.LPWSTR, w.LPVOID, w.LPVOID, w.BOOL, w.DWORD, w.LPVOID, w.LPCWSTR, w.LPVOID, w.LPVOID]),
    }
    for name, (result, args) in signatures.items():
        fn = getattr(k, name); fn.restype = result; fn.argtypes = args
    return k


@contextmanager
def _locked_snapshot(path, contents):
    """Keep directories unrenamable and file read-only to all other handles."""
    k = _windows_api()
    handles = []
    try:
        for directory in reversed((path.parent, *path.parent.parents)):
            _ordinary_path(directory)
            handle = k.CreateFileW(str(directory), 0x80, 3, None, 3, 0x02000000, None)
            if handle == ctypes.c_void_p(-1).value:
                raise RunnerBlocked('snapshot_lock_failed')
            handles.append(handle)
            _ordinary_path(directory)
        handle = k.CreateFileW(str(path), 0x80000000, 1, None, 3, 0, None)
        if handle == ctypes.c_void_p(-1).value:
            raise RunnerBlocked('snapshot_lock_failed')
        handles.append(handle)
        _ordinary_path(path)
        if path.read_bytes() != contents:
            raise RunnerBlocked('snapshot_changed')
        yield path
    finally:
        for handle in reversed(handles):
            k.CloseHandle(handle)


class WindowsProcessTree:
    """Suspended process assigned to a non-breakaway kill-on-close Job Object."""
    def __init__(self, argv, env):
        import msvcrt
        from ctypes import wintypes as w
        class Startup(ctypes.Structure):
            _fields_ = [('cb', w.DWORD), ('reserved', w.LPWSTR), ('desktop', w.LPWSTR), ('title', w.LPWSTR),
                        ('x', w.DWORD), ('y', w.DWORD), ('xs', w.DWORD), ('ys', w.DWORD),
                        ('xc', w.DWORD), ('yc', w.DWORD), ('fill', w.DWORD), ('flags', w.DWORD),
                        ('show', w.WORD), ('reserved2', w.WORD), ('bytes', w.LPVOID),
                        ('stdin', w.HANDLE), ('stdout', w.HANDLE), ('stderr', w.HANDLE)]
        class ProcessInfo(ctypes.Structure):
            _fields_ = [('process', w.HANDLE), ('thread', w.HANDLE), ('pid', w.DWORD), ('tid', w.DWORD)]
        class Limits(ctypes.Structure):
            _fields_ = [('process_time', ctypes.c_int64), ('job_time', ctypes.c_int64), ('flags', w.DWORD),
                        ('min_ws', ctypes.c_size_t), ('max_ws', ctypes.c_size_t), ('active_limit', w.DWORD),
                        ('affinity', ctypes.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]
        class Extended(ctypes.Structure):
            _fields_ = [('basic', Limits), ('io', ctypes.c_uint64 * 6),
                        ('process_mem', ctypes.c_size_t), ('job_mem', ctypes.c_size_t),
                        ('peak_process', ctypes.c_size_t), ('peak_job', ctypes.c_size_t)]
        self.k = _windows_api(); self.process = None; self.stdout = None
        self.job = self.k.CreateJobObjectW(None, None)
        if not self.job:
            raise RunnerBlocked('process_job_failed')
        limits = Extended(); limits.basic.flags = 0x2000
        if not self.k.SetInformationJobObject(self.job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            self.close(); raise RunnerBlocked('process_job_failed')
        read_fd, write_fd = os.pipe()
        pi = ProcessInfo()
        try:
            with open(os.devnull, 'r+b') as null:
                write_handle = msvcrt.get_osfhandle(write_fd); null_handle = msvcrt.get_osfhandle(null.fileno())
                os.set_handle_inheritable(write_handle, True); os.set_handle_inheritable(null_handle, True)
                startup = Startup(); startup.cb = ctypes.sizeof(startup); startup.flags = 0x100
                startup.stdin = null_handle; startup.stdout = write_handle; startup.stderr = null_handle
                command = ctypes.create_unicode_buffer(subprocess.list2cmdline(argv))
                block = ctypes.create_unicode_buffer('\0'.join(key + '=' + value for key, value in sorted(env.items())) + '\0\0')
                if not self.k.CreateProcessW(argv[0], command, None, None, True, 0x08000404, block, str(ROOT), ctypes.byref(startup), ctypes.byref(pi)):
                    raise RunnerBlocked('process_start_failed')
                self.process = pi.process
                if not self.k.AssignProcessToJobObject(self.job, self.process):
                    self.k.TerminateProcess(self.process, 1)
                    self.k.WaitForSingleObject(self.process, 10000)
                    raise RunnerBlocked('process_job_failed')
                if self.k.ResumeThread(pi.thread) == 0xffffffff:
                    raise RunnerBlocked('process_start_failed')
            self.stdout = os.fdopen(read_fd, 'rb'); read_fd = None
        except BaseException:
            self.close(); raise
        finally:
            if pi.thread: self.k.CloseHandle(pi.thread)
            os.close(write_fd)
            if read_fd is not None: os.close(read_fd)

    def wait(self, timeout=600):
        from ctypes import wintypes as w
        result = self.k.WaitForSingleObject(self.process, int(timeout * 1000))
        if result == 258:
            raise subprocess.TimeoutExpired('fixed_runner_process', timeout)
        code = w.DWORD()
        if result != 0 or not self.k.GetExitCodeProcess(self.process, ctypes.byref(code)):
            raise RunnerBlocked('process_wait_failed')
        return code.value

    def terminate_tree(self):
        class Accounting(ctypes.Structure):
            _fields_ = [('times', ctypes.c_int64 * 4), ('faults', ctypes.c_uint32), ('total', ctypes.c_uint32),
                        ('active', ctypes.c_uint32), ('terminated', ctypes.c_uint32)]
        class ProcessIds(ctypes.Structure):
            _fields_ = [('assigned', ctypes.c_uint32), ('count', ctypes.c_uint32),
                        ('ids', ctypes.c_size_t * 4096)]
        ids = ProcessIds()
        handles = []
        confirmed = bool(self.k.QueryInformationJobObject(self.job, 3, ctypes.byref(ids), ctypes.sizeof(ids), None))
        if confirmed:
            for pid in ids.ids[:ids.count]:
                handle = self.k.OpenProcess(0x100000, False, pid)
                if handle:
                    handles.append(handle)
                else:
                    confirmed = False
        if not self.k.TerminateJobObject(self.job, 1):
            confirmed = False
        deadline = time.monotonic() + 10
        try:
            for handle in handles:
                if self.k.WaitForSingleObject(handle, max(0, int((deadline - time.monotonic()) * 1000))) != 0:
                    confirmed = False
            while time.monotonic() < deadline:
                accounting = Accounting()
                if not self.k.QueryInformationJobObject(self.job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None):
                    return False
                if accounting.active == 0:
                    return confirmed
                time.sleep(.02)
            return False
        finally:
            for handle in handles:
                self.k.CloseHandle(handle)

    def close(self):
        if self.job: self.k.CloseHandle(self.job); self.job = None
        if self.process: self.k.CloseHandle(self.process); self.process = None


ROOT = Path(r"C:\Users\SERGIO TOBETO\.codex\worktrees\80f7\jkh-desktop")
HOST = "127.0.0.1"
PORT = 8765
PIPE = "npipe:////./pipe/dockerDesktopLinuxEngine"
PROJECT = "jkh_local_lab"
DOCKER = Path(r"C:\Program Files\Docker\Docker\resources\bin\docker.exe")
COMPOSE_PLUGIN = Path(r"C:\Program Files\Docker\Docker\resources\cli-plugins\docker-compose.exe")
COMPOSE_PLUGIN_SHA256 = "18b6393f8006a07aba46ed0ea27e880389e8cb8741581d9b0f97c978c1529501"
PWSH = Path(r"C:\Users\SERGIO TOBETO\AppData\Local\Microsoft\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe")
TRUSTED_HASHES = {
    "docker-compose.local.yml": "34659c71df25d9aa4aa7e474b65938174ec270f3e9562902082a931ec3be9833",
    "scripts/local-auth-test.ps1": "22eef52c271d3f35703cd756fcead58d8d32fd28b229850bb9abce3faba57da7",
    "backend/local_lab_fixture.py": "2f494e8bd1407a957f2795a33ffede4addca1437c7dd77e37fbbdd39e2d0a11a",
    "local-lab/playwright/tests/auth.spec.js": "97bae859b6212f9ce66c5176749d7c6de7a286ca3554364f3855b8fe3e31c157",
    "local-lab/playwright/tests/auth.config.js": "2899899b6e2740f25d70e13c02287f84a3880099094ff577c33ba4de1c3ff52a",
    "local-lab/playwright/tests/auth.global-setup.js": "b5751428b45b33071c3683c1198044a7095896e199aed7294aae50dd76c1112c",
    "nginx/local.conf": "a6104105fedf9a0a721eab10b851d594d8d67f93719b6a780ea19f3503365034",
}
SERVICES = frozenset({"mysql", "api", "nginx", "playwright"})
FORBIDDEN_COMPOSE = re.compile(
    rb"(?im)^\s*(privileged|network_mode|pid|ipc|userns_mode|devices|cap_add|security_opt|"
    rb"extra_hosts|container_name|extends|include|develop|secrets|configs):\s*"
)


class RunnerBlocked(Exception):
    pass


STAGES = ('FIXTURE_CREATE', 'PLAYWRIGHT_AUTH', 'PLAYWRIGHT_LOGOUT', 'FIXTURE_CLEANUP', 'RUN_REGISTRY_CLEANUP')


def accept_marker(report, line):
    match = re.fullmatch(r'(FIXTURE_CREATE|PLAYWRIGHT_AUTH|PLAYWRIGHT_LOGOUT|FIXTURE_CLEANUP|RUN_REGISTRY_CLEANUP)=(PASS|FAIL|BLOCKED|NOT_RUN)', line)
    if match:
        report['stages'][match[1]] = match[2]
    match = re.fullmatch(r'(FIXTURE_CREATE|PLAYWRIGHT_AUTH|FIXTURE_CLEANUP|RUN_REGISTRY_CLEANUP)_EXIT_CODE=(-?[0-9]{1,10})', line)
    if match:
        report['exit_codes'][match[1]] = int(match[2])
    if line.startswith('FAILED_STAGE=') and line[13:] in STAGES:
        report['failed_stage'] = line[13:]
    match = re.fullmatch(r'(FIXTURE_CREATE|PLAYWRIGHT_AUTH|FIXTURE_CLEANUP|RUN_REGISTRY_CLEANUP)_ERROR_(CATEGORY|ID|LINE)=(process_start|process_io|process_output|native_exit|response_invalid|ConvertFromJsonInvalidJson|CommandNotFoundException|NativeCommandFailed|Other|[0-9]{1,8})', line)
    if match:
        kind, value = match[2], match[3]
        allowed = {'CATEGORY': {'process_start', 'process_io', 'process_output', 'native_exit', 'response_invalid'},
                   'ID': {'ConvertFromJsonInvalidJson', 'CommandNotFoundException', 'NativeCommandFailed', 'Other'}}
        if (kind == 'LINE' and value.isdecimal()) or value in allowed.get(kind, set()):
            report.setdefault('errors', {}).setdefault(match[1], {})[kind.lower()] = int(value) if kind == 'LINE' else value


def _ordinary_path(path):
    path = Path(path)
    if not path.is_absolute() or not path.exists():
        raise RunnerBlocked("untrusted_path")
    for part in (path, *path.parents):
        if part.is_symlink() or (hasattr(part, "is_junction") and part.is_junction()):
            raise RunnerBlocked("untrusted_path")
    return path


def _verify_mount_tree(path):
    def reject_error(_error):
        raise RunnerBlocked("mount_tree_unreadable")

    for directory, dirs, files in os.walk(path, followlinks=False, onerror=reject_error):
        for name in dirs + files:
            entry = Path(directory) / name
            if entry.is_symlink() or (hasattr(entry, "is_junction") and entry.is_junction()):
                raise RunnerBlocked("mount_link_forbidden")


def verify_workspace(root=ROOT, hashes=TRUSTED_HASHES):
    root = _ordinary_path(root)
    if root.resolve() != ROOT:
        raise RunnerBlocked("wrong_worktree")
    mounts = ("backend", "web", "nginx", "local-lab/playwright/tests")
    for relative in (*mounts, ".local-lab"):
        _ordinary_path(root / relative)
    for relative in mounts:
        _verify_mount_tree(root / relative)
    trusted_bytes = {}
    for relative, expected in hashes.items():
        path = _ordinary_path(root / relative)
        if path.resolve().is_relative_to(root) is False:
            raise RunnerBlocked("untrusted_path")
        contents = path.read_bytes()
        if hashlib.sha256(contents).hexdigest() != expected:
            raise RunnerBlocked("trusted_file_changed")
        trusted_bytes[relative] = contents
    compose = trusted_bytes["docker-compose.local.yml"]
    if FORBIDDEN_COMPOSE.search(compose) or b"/var/run/docker.sock" in compose.lower() or b"docker_engine" in compose.lower():
        raise RunnerBlocked("unsafe_compose")
    env_path = _ordinary_path(root / ".local-lab" / "runtime.env")
    env_bytes = env_path.read_bytes()
    if len(env_bytes) > 1024:
        raise RunnerBlocked("runtime_env_invalid")
    try:
        entries = env_bytes.decode("utf-8-sig").splitlines()
    except UnicodeError as exc:
        raise RunnerBlocked("runtime_env_invalid") from exc
    names = [line.split("=", 1)[0] for line in entries]
    if set(names) != {"JKH_LOCAL_LAB_MARKER", "JKH_LOCAL_DB_PASSWORD", "JKH_LOCAL_ROOT_PASSWORD", "JKH_LOCAL_SESSION_SECRET"} or len(names) != 4:
        raise RunnerBlocked("runtime_env_invalid")
    if "JKH_LOCAL_LAB_MARKER=LOCAL_LAB_ONLY" not in entries:
        raise RunnerBlocked("runtime_env_invalid")
    for line in entries:
        if line.startswith("JKH_LOCAL_LAB_MARKER="):
            continue
        if not re.fullmatch(r"JKH_LOCAL_(?:DB_PASSWORD|ROOT_PASSWORD|SESSION_SECRET)=[0-9a-f]{64}", line):
            raise RunnerBlocked("runtime_env_invalid")
    return (compose,
            {line.split("=", 1)[0]: line.split("=", 1)[1] for line in entries if not line.startswith("JKH_LOCAL_LAB_MARKER=")},
            trusted_bytes["scripts/local-auth-test.ps1"])


def _child_env(local_secrets=None):
    keep = ("SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "ComSpec")
    env = {key: os.environ[key] for key in keep if key in os.environ}
    env["PATH"] = str(DOCKER.parent) + os.pathsep + str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32")
    env["DOCKER_HOST"] = PIPE
    env["COMPOSE_PROJECT_NAME"] = PROJECT
    env["COMPOSE_DISABLE_ENV_FILE"] = "1"
    system_root = os.environ.get('SystemRoot', '')
    drive = os.path.splitdrive(system_root)[0]
    if re.fullmatch(r'[A-Za-z]:', drive) and Path(system_root).is_dir():
        env['SystemDrive'] = drive
    if local_secrets:
        env.update(local_secrets)
    return env


def _verified_compose_plugin():
    path = _ordinary_path(COMPOSE_PLUGIN)
    try:
        if not stat.S_ISREG(path.stat().st_mode):
            raise RunnerBlocked("compose_plugin_untrusted")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != COMPOSE_PLUGIN_SHA256:
            raise RunnerBlocked("compose_plugin_untrusted")
    except OSError as exc:
        raise RunnerBlocked("compose_plugin_untrusted") from exc
    return path


@contextmanager
def _protected_snapshot(contents, filename, expected_hash):
    if hashlib.sha256(contents).hexdigest() != expected_hash:
        raise RunnerBlocked("trusted_file_changed")
    local_appdata = os.environ.get("LOCALAPPDATA", "")
    base_parent = Path(local_appdata)
    if not base_parent.is_absolute() or base_parent.is_relative_to(ROOT):
        raise RunnerBlocked("snapshot_location_invalid")
    _ordinary_path(base_parent)
    base = base_parent / "JKH_LOCAL_LAB_RUNNER"
    base.mkdir(mode=0o700, exist_ok=True)
    _ordinary_path(base)
    with tempfile.TemporaryDirectory(prefix="snapshot-", dir=base) as temporary:
        private_dir = _ordinary_path(temporary)
        if private_dir.is_relative_to(ROOT) or private_dir.parent != base:
            raise RunnerBlocked("snapshot_location_invalid")
        path = private_dir / filename
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
        descriptor = os.open(path, flags, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        _ordinary_path(path)
        if path.read_bytes() != contents:
            raise RunnerBlocked("snapshot_changed")
        with _locked_snapshot(path, contents):
            yield path


@contextmanager
def protected_compose_snapshot(contents):
    with _protected_snapshot(contents, "docker-compose.local.yml", TRUSTED_HASHES["docker-compose.local.yml"]) as path:
        yield path


@contextmanager
def protected_script_snapshot(contents):
    with _protected_snapshot(contents, "local-auth-test.ps1", TRUSTED_HASHES["scripts/local-auth-test.ps1"]) as path:
        yield path


class DockerExecutor:
    paused = False

    def _run_test(self, argv, env, report):
        # Only allowlisted markers survive this reader; stderr is never captured.
        process = WindowsProcessTree(argv, env)
        def consume():
            overflow = False
            while True:
                line = process.stdout.readline(513)
                if not line:
                    break
                if len(line) > 512 or overflow:
                    overflow = not line.endswith(b'\n')
                    continue
                accept_marker(report, line.decode('ascii', errors='replace').rstrip('\r\n'))
        reader = threading.Thread(target=consume, daemon=True)
        reader.start()
        try:
            code = process.wait(timeout=600)
            report['process_exit_code'] = code
            report['category'] = 'success' if code == 0 else 'process_failed'
        except subprocess.TimeoutExpired:
            report['category'] = 'timeout'
            for name in STAGES:
                if report['stages'].get(name) == 'NOT_RUN':
                    report['stages'][name] = 'BLOCKED'
            raise RunnerBlocked('auth_test_failed') from None
        finally:
            try:
                terminated = process.terminate_tree()
            except Exception:
                terminated = False
            report['process_tree'] = 'terminated' if terminated else 'unconfirmed'
            if not terminated:
                self.paused = True
                report['runner_state'] = 'PAUSED'
            reader.join(2)
            if not reader.is_alive():
                process.stdout.close()
            else:
                self.paused = True
                report['runner_state'] = 'PAUSED'
            process.close()
        if self.paused:
            raise RunnerBlocked('process_tree_unconfirmed')
        if code != 0:
            raise RunnerBlocked('auth_test_failed')

    def _run(self, argv, timeout, capture=False, env=None, failure_code="local_operation_failed"):
        try:
            result = subprocess.run(
                argv, cwd=ROOT, env=env if env is not None else _child_env(), shell=False, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=timeout, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RunnerBlocked(failure_code) from exc
        if result.returncode:
            raise RunnerBlocked(failure_code)
        if capture and len(result.stdout) > 65536:
            raise RunnerBlocked("docker_response_too_large")
        return result.stdout if capture else b""

    def _preflight(self):
        _ordinary_path(DOCKER)
        result = self._run([str(DOCKER), "--host", PIPE, "info", "--format", "{{.OSType}}"], 8, True,
                           failure_code="docker_info_failed")
        if result.strip() != b"linux":
            raise RunnerBlocked("wrong_docker_engine")

    def status(self, verified):
        compose, local_secrets = verified[:2]
        plugin = _verified_compose_plugin()
        self._preflight()
        with protected_compose_snapshot(compose) as snapshot:
            argv = [str(plugin), "--project-directory", str(ROOT),
                    "-f", str(snapshot), "-p", PROJECT, "ps", "--format", "json"]
            raw = self._run(argv, 12, True, env=_child_env(local_secrets),
                            failure_code="compose_ps_failed").decode("utf-8")
        try:
            objects = json.loads(raw) if raw.lstrip().startswith("[") else [json.loads(line) for line in raw.splitlines() if line.strip()]
            if not isinstance(objects, list):
                raise ValueError("not_list")
            result = []
            for item in objects:
                if item.get("Project") != PROJECT or item.get("Service") not in SERVICES:
                    raise ValueError("unexpected_container")
                result.append({"service": item["Service"], "state": item.get("State", "unknown"),
                               "health": item.get("Health", "unknown")})
        except (ValueError, TypeError, AttributeError, KeyError) as exc:
            raise RunnerBlocked("unexpected_docker_response") from exc
        return {"project": PROJECT, "containers": result}

    def test(self, verified):
        if len(verified) != 3:
            raise RunnerBlocked("trusted_file_missing")
        compose, local_secrets, script = verified
        _ordinary_path(PWSH)
        _verified_compose_plugin()
        self._preflight()
        run_id = uuid.uuid4().hex
        env = _child_env(local_secrets)
        env["JKH_FIXTURE_RUN_ID"] = run_id
        report = {'stages': {name: 'NOT_RUN' for name in STAGES}, 'exit_codes': {}, 'category': 'setup_failed'}
        try:
            with protected_compose_snapshot(compose) as compose_snapshot, protected_script_snapshot(script) as script_snapshot:
                env["JKH_RUNNER_COMPOSE_SNAPSHOT"] = str(compose_snapshot)
                self._run_test([str(PWSH), "-NoProfile", "-NonInteractive", "-File", str(script_snapshot)], env, report)
        except (RunnerBlocked, subprocess.TimeoutExpired, OSError) as exc:
            # The ID is safe to report and needed for manual fixture recovery.
            error = RunnerBlocked('auth_test_failed')
            error.details = {'run_id': run_id, 'diagnostics': report}
            raise error from None
        return {"suite": "auth", "passed": True, "run_id": run_id, 'diagnostics': report}


class RunnerService:
    def __init__(self, token, executor=None, verify=verify_workspace):
        if not re.fullmatch(r"[0-9a-fA-F]{64}", token or ""):
            raise RunnerBlocked("runner_token_required")
        self.token = token.encode("ascii")
        self.executor = executor or DockerExecutor()
        self.verify = verify
        self.lock = threading.Lock()
        self.events = deque(maxlen=100)

    def authorize(self, value):
        prefix = "Bearer "
        return bool(value and value.startswith(prefix) and hmac.compare_digest(value[len(prefix):].encode("utf-8"), self.token))

    def handle(self, operation):
        if operation == "logs":
            return {"events": list(self.events)[-50:]}
        if getattr(self.executor, 'paused', False):
            raise RunnerBlocked('runner_paused')
        if not self.lock.acquire(blocking=False):
            raise RunnerBlocked("operation_busy")
        try:
            verified = self.verify()
            result = self.executor.status(verified) if operation == "status" else self.executor.test(verified)
            event = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "operation": operation, "result": "pass"}
            if operation == "test" and re.fullmatch(r"[0-9a-f]{32}", result.get("run_id", "")):
                event["run_id"] = result["run_id"]
                event['diagnostics'] = result['diagnostics']
            self.events.append(event)
            return result
        except Exception as exc:
            event = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "operation": operation, "result": "blocked"}
            match = re.fullmatch(r"auth_test_blocked_run_([0-9a-f]{32})", str(exc))
            if match:
                event["run_id"] = match.group(1)
            if isinstance(exc, RunnerBlocked) and hasattr(exc, 'details'):
                event.update(exc.details)
            self.events.append(event)
            raise
        finally:
            if not getattr(self.executor, 'paused', False):
                self.lock.release()


class LimitedHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, handler):
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


def handler_for(service, port=PORT):
    class Handler(BaseHTTPRequestHandler):
        def __getattr__(self, name):
            if name.startswith("do_"):
                return self._dispatch
            raise AttributeError(name)

        def log_message(self, *args):
            pass  # HTTP paths and headers must never enter logs.

        def _reply(self, status, payload):
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _dispatch(self):
            if self.headers.get("Host") != f"{HOST}:{port}" or self.headers.get("Origin") is not None:
                return self._reply(403, {"error": "request_origin_forbidden"})
            if not service.authorize(self.headers.get("Authorization")):
                return self._reply(401, {"error": "unauthorized"})
            allowed = {("GET", "/v1/status"): "status", ("GET", "/v1/logs"): "logs", ("POST", "/v1/test"): "test"}
            operation = allowed.get((self.command, self.path))
            if operation is None:
                return self._reply(404, {"error": "unknown_operation"})
            length = self.headers.get("Content-Length", "0")
            if not length.isdecimal() or int(length) != 0 or self.headers.get("Transfer-Encoding"):
                return self._reply(413, {"error": "request_body_forbidden"})
            try:
                result = service.handle(operation)
                return self._reply(200, {"ok": True, **result})
            except RunnerBlocked as exc:
                status = 409 if str(exc) == "operation_busy" else 503
                return self._reply(status, {"ok": False, "error": str(exc), **getattr(exc, 'details', {})})
            except Exception:
                return self._reply(503, {"ok": False, "error": "internal_error"})

        do_GET = _dispatch
        do_POST = _dispatch
        do_PUT = _dispatch
        do_DELETE = _dispatch
        do_OPTIONS = _dispatch

    return Handler


def main():
    token = os.environ.get("JKH_RUNNER_TOKEN", "")
    service = RunnerService(token)
    _ordinary_path(ROOT)
    server = LimitedHTTPServer((HOST, PORT), handler_for(service))
    print("LOCAL_LAB_RUNNER_LISTENING=127.0.0.1:8765", flush=True)
    server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
