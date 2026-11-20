import hashlib
import ctypes
import http.client
import importlib.util
import io
import json
import os
import threading
import unittest
import urllib.error
from contextlib import redirect_stderr
from contextlib import contextmanager
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("local_lab_runner_server", Path(__file__).with_name("server.py"))
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)
CLIENT_SPEC = importlib.util.spec_from_file_location("local_lab_runner_client", Path(__file__).with_name("client.py"))
client = importlib.util.module_from_spec(CLIENT_SPEC)
CLIENT_SPEC.loader.exec_module(client)
TOKEN = "a" * 64


class FakeExecutor:
    def __init__(self):
        self.calls = []
        self.entered = threading.Event()
        self.release = threading.Event()
        self.pause = False

    def status(self, _verified):
        self.calls.append("status")
        return {"project": server.PROJECT, "containers": []}

    def test(self, _verified):
        self.calls.append("test")
        self.entered.set()
        if self.pause:
            self.release.wait(3)
        return {"suite": "auth", "passed": True}


class HttpSecurityTests(unittest.TestCase):
    def setUp(self):
        self.executor = FakeExecutor()
        self.service = server.RunnerService(TOKEN, self.executor, verify=lambda: (b"mock compose", {}))
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), server.handler_for(self.service, 0))
        self.port = self.http.server_address[1]
        # Handler uses a fixed Host value; adapt only the mock listener's port.
        self.http.RequestHandlerClass = server.handler_for(self.service, self.port)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.executor.release.set()
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(2)

    def call(self, method, path, token=TOKEN, extra=None, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Host": f"127.0.0.1:{self.port}"}
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        headers.update(extra or {})
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        data = json.loads(response.read())
        cors = response.getheader("Access-Control-Allow-Origin")
        connection.close()
        return response.status, data, cors

    def test_authorization_on_every_operation(self):
        for method, path in (("GET", "/v1/status"), ("GET", "/v1/logs"), ("POST", "/v1/test")):
            for token in (None, "b" * 64):
                self.assertEqual(self.call(method, path, token)[0], 401)
        self.assertEqual(self.executor.calls, [])
        self.assertEqual(self.call("PATCH", "/v1/test", None)[0], 401)

    def test_host_origin_and_cors(self):
        self.assertEqual(self.call("GET", "/v1/status", extra={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.call("GET", "/v1/status", extra={"Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.call("OPTIONS", "/v1/test")[0], 404)
        self.assertIsNone(self.call("GET", "/v1/logs")[2])
        self.assertEqual(self.executor.calls, [])

    def test_fixed_operations_and_body_limit(self):
        self.assertEqual(self.call("POST", "/v1/exec")[0], 404)
        self.assertEqual(self.call("POST", "/v1/start")[0], 404)
        self.assertEqual(self.call("PUT", "/v1/test")[0], 404)
        self.assertEqual(self.call("POST", "/v1/test", body=b'{"command":"docker ps"}')[0], 413)
        self.assertEqual(self.executor.calls, [])
        self.assertEqual(self.call("GET", "/v1/status")[0], 200)
        self.assertEqual(self.call("POST", "/v1/test")[0], 200)
        self.assertEqual(self.executor.calls, ["status", "test"])

    def test_parallel_test_is_rejected(self):
        self.executor.pause = True
        result = []
        first = threading.Thread(target=lambda: result.append(self.call("POST", "/v1/test")[0]))
        first.start()
        self.assertTrue(self.executor.entered.wait(2))
        self.assertEqual(self.call("POST", "/v1/test")[0], 409)
        self.assertEqual(self.call("GET", "/v1/status")[0], 409)
        self.executor.release.set()
        first.join(3)
        self.assertEqual(result, [200])
        self.assertEqual(self.executor.calls, ["test"])

    def test_logs_are_bounded_and_sanitized(self):
        self.call("GET", "/v1/status")
        status, payload, _ = self.call("GET", "/v1/logs")
        self.assertEqual(status, 200)
        self.assertEqual(payload["events"][0]["operation"], "status")
        self.assertNotIn(TOKEN, json.dumps(payload))

    def test_workspace_guard_blocks_before_executor(self):
        self.service.verify = lambda: (_ for _ in ()).throw(server.RunnerBlocked("unsafe_compose"))
        status, payload, _ = self.call("POST", "/v1/test")
        self.assertEqual(status, 503)
        self.assertEqual(payload["error"], "unsafe_compose")
        self.assertEqual(self.executor.calls, [])

    def test_internal_exception_has_generic_safe_code(self):
        self.service.verify = lambda: (_ for _ in ()).throw(RuntimeError("private internal detail"))
        status, payload, _ = self.call("GET", "/v1/status")
        self.assertEqual(status, 503)
        self.assertEqual(payload["error"], "internal_error")
        self.assertNotIn("private internal detail", json.dumps(payload))


class ClientDiagnosticTests(unittest.TestCase):
    def http_error(self, status, payload):
        return urllib.error.HTTPError(client.BASE + "/v1/status", status, "private detail", {},
                                      io.BytesIO(json.dumps(payload).encode()))

    def test_authorization_and_docker_error_categories(self):
        self.assertEqual(client.diagnostic(self.http_error(401, {"error": "unauthorized"})),
                         (401, "authorization", "unauthorized"))
        self.assertEqual(client.diagnostic(self.http_error(503, {"error": "wrong_docker_engine"})),
                         (503, "docker", "wrong_docker_engine"))
        self.assertEqual(client.diagnostic(self.http_error(503, {"error": "internal_error"})),
                         (503, "runner_internal", "internal_error"))
        for reason in ("docker_info_failed", "compose_ps_failed"):
            self.assertEqual(client.diagnostic(self.http_error(503, {"error": reason})),
                             (503, "docker", reason))

    def test_connection_and_untrusted_response_are_redacted(self):
        secret = "a" * 64
        error = urllib.error.URLError("private network detail " + secret)
        self.assertEqual(client.diagnostic(error), ("NONE", "connection", "request_failed"))
        self.assertEqual(client.diagnostic(self.http_error(503, {"error": secret})),
                         (503, "runner_error", "unrecognized_response"))
        self.assertEqual(client.diagnostic(ValueError(secret)),
                         ("NONE", "client_response", "invalid_response"))

    def test_main_reports_status_without_token(self):
        output = io.StringIO()
        with patch.object(client.sys, "argv", ["client.py", "status"]), \
             patch.dict(os.environ, {"JKH_RUNNER_TOKEN": "a" * 64}), \
             patch.object(client, "invoke", side_effect=self.http_error(503, {"error": "local_operation_failed"})), \
             redirect_stderr(output):
            self.assertEqual(client.main(), 2)
        self.assertIn("HTTP_STATUS=503 ERROR_CATEGORY=docker REASON=local_operation_failed", output.getvalue())
        self.assertNotIn("a" * 64, output.getvalue())


class WorkspaceGuardTests(unittest.TestCase):
    def setUp(self):
        self.root = server.ROOT
        self.compose = self.root / "docker-compose.local.yml"
        self.env_path = self.root / ".local-lab/runtime.env"

    def test_trusted_files_and_wrong_worktree(self):
        hashes = {"docker-compose.local.yml": "0" * 64}
        with self.assertRaisesRegex(server.RunnerBlocked, "trusted_file_changed"):
            server.verify_workspace(self.root, hashes)
        with self.assertRaisesRegex(server.RunnerBlocked, "wrong_worktree"):
            server.verify_workspace(self.root / "local-lab", hashes)

    def test_modified_auth_script_is_rejected_before_test_executor(self):
        script = self.root / "scripts/local-auth-test.ps1"
        original_read = Path.read_bytes
        def changed_script(path):
            return b"tampered" if path == script else original_read(path)
        executor = FakeExecutor()
        service = server.RunnerService(TOKEN, executor=executor)
        with patch.object(Path, "read_bytes", changed_script):
            with self.assertRaisesRegex(server.RunnerBlocked, "^trusted_file_changed$"):
                service.handle("test")
        self.assertEqual(executor.calls, [])

    def test_dangerous_compose_keys_and_socket_mount(self):
        for addition in ("privileged: true\n", "devices: []\n", "volumes: [/var/run/docker.sock]\n"):
            contents = ("name: jkh_local_lab\n" + addition).encode()
            hashes = {"docker-compose.local.yml": hashlib.sha256(contents).hexdigest()}
            original = Path.read_bytes
            def read_bytes(path):
                return contents if path == self.compose else original(path)
            with patch.object(Path, "read_bytes", read_bytes):
                with self.assertRaisesRegex(server.RunnerBlocked, "unsafe_compose"):
                    server.verify_workspace(self.root, hashes)

    def test_runtime_env_additions_and_symlinks(self):
        original = Path.read_bytes
        def read_bytes(path):
            if path == self.env_path:
                return ("JKH_LOCAL_LAB_MARKER=LOCAL_LAB_ONLY\n" +
                        "\n".join(key + "=" + "a" * 64 for key in
                                  ("JKH_LOCAL_DB_PASSWORD", "JKH_LOCAL_ROOT_PASSWORD", "JKH_LOCAL_SESSION_SECRET")) +
                        "\nDOCKER_HOST=tcp://remote\n").encode()
            return original(path)
        hashes = {"docker-compose.local.yml": hashlib.sha256(self.compose.read_bytes()).hexdigest()}
        with patch.object(Path, "read_bytes", read_bytes):
            with self.assertRaisesRegex(server.RunnerBlocked, "runtime_env_invalid"):
                server.verify_workspace(self.root, hashes)
        original_path = server._ordinary_path
        def reject_path(path):
            if Path(path) == self.env_path:
                raise server.RunnerBlocked("untrusted_path")
            return original_path(path)
        with patch.object(server, "_ordinary_path", side_effect=reject_path):
            with self.assertRaisesRegex(server.RunnerBlocked, "untrusted_path"):
                server.verify_workspace(self.root, hashes)

    def test_source_compose_change_after_verification_is_not_used(self):
        original_compose = self.compose.read_bytes()
        valid_env = ("JKH_LOCAL_LAB_MARKER=LOCAL_LAB_ONLY\n" +
                     "\n".join(key + "=" + "a" * 64 for key in
                               ("JKH_LOCAL_DB_PASSWORD", "JKH_LOCAL_ROOT_PASSWORD", "JKH_LOCAL_SESSION_SECRET")) + "\n").encode()
        hashes = {"docker-compose.local.yml": hashlib.sha256(original_compose).hexdigest(),
                  "scripts/local-auth-test.ps1": server.TRUSTED_HASHES["scripts/local-auth-test.ps1"]}
        reads = []
        original_read = Path.read_bytes
        def changed_source(path):
            if path == self.compose:
                reads.append(path)
                return original_compose if len(reads) == 1 else b"name: other_project\n"
            if path == self.env_path:
                return valid_env
            return original_read(path)
        with patch.object(Path, "read_bytes", changed_source):
            verified = server.verify_workspace(self.root, hashes)
            self.assertEqual(verified[0], original_compose)
            with patch.object(server, "protected_compose_snapshot") as snapshot, patch.object(server.DockerExecutor, "_preflight"):
                snapshot.return_value.__enter__.return_value = Path(r"C:\private-runner\compose-fixed.yml")
                with patch.object(server.DockerExecutor, "_run", return_value=b""):
                    server.DockerExecutor().status(verified)
                snapshot.assert_called_once_with(original_compose)
        self.assertEqual(len(reads), 1)

    def test_source_script_change_after_verification_is_not_used(self):
        script_path = self.root / "scripts/local-auth-test.ps1"
        original_script = script_path.read_bytes()
        verified = server.verify_workspace()
        self.assertEqual(verified[2], original_script)
        reads = []
        original_read = Path.read_bytes
        def changed_source(path):
            if path == script_path:
                reads.append(path)
                return b"tampered after verification"
            return original_read(path)
        with patch.object(Path, "read_bytes", changed_source), \
             patch.object(server.DockerExecutor, "_preflight"), \
             patch.object(server, "protected_compose_snapshot") as compose_snapshot, \
             patch.object(server, "protected_script_snapshot") as script_snapshot, \
             patch.object(server.DockerExecutor, "_run_test", return_value=None) as run:
            compose_snapshot.return_value.__enter__.return_value = Path(r"C:\private-runner\compose.yml")
            script_snapshot.return_value.__enter__.return_value = Path(r"C:\private-runner\auth.ps1")
            server.DockerExecutor().test(verified)
            script_snapshot.assert_called_once_with(original_script)
            self.assertEqual(run.call_args.args[0][-1], str(Path(r"C:\private-runner\auth.ps1")))
        self.assertEqual(reads, [])

    def test_mount_tree_rejects_nested_link(self):
        root = self.root / "backend"
        original = Path.is_symlink
        def is_link(path):
            return path == root / "nested_link" or original(path)
        with patch.object(server.os, "walk", return_value=[(str(root), ["nested_link"], [])]), \
             patch.object(Path, "is_symlink", is_link):
            with self.assertRaisesRegex(server.RunnerBlocked, "mount_link_forbidden"):
                server._verify_mount_tree(root)


class SnapshotSecurityTests(unittest.TestCase):
    def setUp(self):
        @contextmanager
        def mock_lock(path, contents):
            yield path
        self.lock_patch = patch.object(server, '_locked_snapshot', mock_lock)
        self.lock_patch.start()
        self.addCleanup(self.lock_patch.stop)
    def test_script_snapshot_rejects_wrong_bytes(self):
        with self.assertRaisesRegex(server.RunnerBlocked, "^trusted_file_changed$"):
            with server.protected_script_snapshot(b"tampered"):
                pass

    def test_script_snapshot_cleanup_on_success_and_error(self):
        contents = (server.ROOT / "scripts/local-auth-test.ps1").read_bytes()
        private = Path(r"C:\private-runner\JKH_LOCAL_LAB_RUNNER\snapshot-random")
        stream = unittest.mock.MagicMock()
        stream.__enter__.return_value = stream
        with patch.dict(os.environ, {"LOCALAPPDATA": r"C:\private-runner"}), \
             patch.object(server, "_ordinary_path", side_effect=lambda path: Path(path)), \
             patch.object(Path, "mkdir"), \
             patch.object(server.tempfile, "TemporaryDirectory") as temporary, \
             patch.object(server.os, "open", return_value=9), \
             patch.object(server.os, "fdopen", return_value=stream), \
             patch.object(server.os, "fsync"), \
             patch.object(Path, "read_bytes", return_value=contents):
            temporary.return_value.__enter__.return_value = str(private)
            with server.protected_script_snapshot(contents) as snapshot:
                self.assertEqual(snapshot, private / "local-auth-test.ps1")
            self.assertTrue(temporary.return_value.__exit__.called)
            temporary.reset_mock()
            with self.assertRaisesRegex(RuntimeError, "synthetic failure"):
                with server.protected_script_snapshot(contents):
                    raise RuntimeError("synthetic failure")
            self.assertTrue(temporary.return_value.__exit__.called)

    def test_script_snapshot_rejects_tamper_and_link(self):
        contents = (server.ROOT / "scripts/local-auth-test.ps1").read_bytes()
        private = Path(r"C:\private-runner\JKH_LOCAL_LAB_RUNNER\snapshot-random")
        snapshot_path = private / "local-auth-test.ps1"
        stream = unittest.mock.MagicMock()
        stream.__enter__.return_value = stream
        with patch.dict(os.environ, {"LOCALAPPDATA": r"C:\private-runner"}), \
             patch.object(Path, "mkdir"), \
             patch.object(server.tempfile, "TemporaryDirectory") as temporary, \
             patch.object(server.os, "open", return_value=9), \
             patch.object(server.os, "fdopen", return_value=stream), \
             patch.object(server.os, "fsync"), \
             patch.object(Path, "read_bytes", return_value=b"tampered"), \
             patch.object(server, "_ordinary_path", side_effect=lambda path: Path(path)):
            temporary.return_value.__enter__.return_value = str(private)
            with self.assertRaisesRegex(server.RunnerBlocked, "^snapshot_changed$"):
                with server.protected_script_snapshot(contents):
                    pass
            self.assertTrue(temporary.return_value.__exit__.called)
        with patch.dict(os.environ, {"LOCALAPPDATA": r"C:\private-runner"}), \
             patch.object(Path, "mkdir"), \
             patch.object(server.tempfile, "TemporaryDirectory") as temporary, \
             patch.object(server.os, "open", return_value=9), \
             patch.object(server.os, "fdopen", return_value=stream), \
             patch.object(server.os, "fsync"), \
             patch.object(server, "_ordinary_path", side_effect=lambda path: (_ for _ in ()).throw(server.RunnerBlocked("untrusted_path"))
                          if Path(path) == snapshot_path else Path(path)):
            temporary.return_value.__enter__.return_value = str(private)
            with self.assertRaisesRegex(server.RunnerBlocked, "^untrusted_path$"):
                with server.protected_script_snapshot(contents):
                    pass
            self.assertTrue(temporary.return_value.__exit__.called)

    def test_snapshot_refuses_workspace_location(self):
        contents = server.ROOT.joinpath("docker-compose.local.yml").read_bytes()
        with patch.dict(os.environ, {"LOCALAPPDATA": str(server.ROOT)}):
            with self.assertRaisesRegex(server.RunnerBlocked, "snapshot_location_invalid"):
                with server.protected_compose_snapshot(contents):
                    pass

    def test_snapshot_rejects_tampered_copy_and_uses_exclusive_creation(self):
        contents = server.ROOT.joinpath("docker-compose.local.yml").read_bytes()
        private = Path(r"C:\private-runner\JKH_LOCAL_LAB_RUNNER\compose-random")
        written = []
        stream = unittest.mock.MagicMock()
        stream.__enter__.return_value = stream
        stream.fileno.return_value = 9
        stream.write.side_effect = lambda data: written.append(data)
        with patch.dict(os.environ, {"LOCALAPPDATA": r"C:\private-runner"}), \
             patch.object(server, "_ordinary_path", side_effect=lambda path: Path(path)), \
             patch.object(Path, "mkdir"), \
             patch.object(server.tempfile, "TemporaryDirectory") as temporary, \
             patch.object(server.os, "open", return_value=9) as opened, \
             patch.object(server.os, "fdopen", return_value=stream), \
             patch.object(server.os, "fsync"), \
             patch.object(Path, "read_bytes", return_value=b"tampered"):
            temporary.return_value.__enter__.return_value = str(private)
            with self.assertRaisesRegex(server.RunnerBlocked, "snapshot_changed"):
                with server.protected_compose_snapshot(contents):
                    pass
        self.assertEqual(written, [contents])
        self.assertTrue(opened.call_args.args[1] & os.O_EXCL)

    def test_snapshot_rejects_symlink_path_before_docker(self):
        contents = server.ROOT.joinpath("docker-compose.local.yml").read_bytes()
        private = Path(r"C:\private-runner\JKH_LOCAL_LAB_RUNNER\compose-random")
        snapshot_path = private / "docker-compose.local.yml"
        def check_path(path):
            if Path(path) == snapshot_path:
                raise server.RunnerBlocked("untrusted_path")
            return Path(path)
        stream = unittest.mock.MagicMock()
        stream.__enter__.return_value = stream
        with patch.dict(os.environ, {"LOCALAPPDATA": r"C:\private-runner"}), \
             patch.object(server, "_ordinary_path", side_effect=check_path), \
             patch.object(Path, "mkdir"), \
             patch.object(server.tempfile, "TemporaryDirectory") as temporary, \
             patch.object(server.os, "open", return_value=9), \
             patch.object(server.os, "fdopen", return_value=stream), \
             patch.object(server.os, "fsync"):
            temporary.return_value.__enter__.return_value = str(private)
            with self.assertRaisesRegex(server.RunnerBlocked, "untrusted_path"):
                with server.protected_compose_snapshot(contents):
                    pass


class StructuredDiagnosticTests(unittest.TestCase):
    def test_unconfirmed_tree_retains_lock_and_blocks_further_operations(self):
        import subprocess
        process = unittest.mock.MagicMock()
        process.stdout = io.BytesIO(b'FIXTURE_CREATE=PASS\n')
        process.wait.side_effect = subprocess.TimeoutExpired('fixed', 600)
        process.terminate_tree.return_value = False
        executor = server.DockerExecutor()
        report = {'stages': {name: 'NOT_RUN' for name in server.STAGES}, 'exit_codes': {}}
        with patch.object(server, 'WindowsProcessTree', return_value=process):
            with self.assertRaises(server.RunnerBlocked):
                executor._run_test(['fixed'], {}, report)
        self.assertTrue(executor.paused)
        self.assertEqual(report['runner_state'], 'PAUSED')
        service = server.RunnerService(TOKEN, executor=executor, verify=lambda: None)
        # Simulate an operation becoming paused while the service owns its lock.
        executor.paused = False
        def fail(_verified):
            executor.paused = True
            error = server.RunnerBlocked('auth_test_failed')
            error.details = {'run_id': 'ea349d63c404498ebd1d9370f65f5b89', 'diagnostics': report}
            raise error
        with patch.object(executor, 'test', side_effect=fail):
            with self.assertRaises(server.RunnerBlocked):
                service.handle('test')
        self.assertTrue(service.lock.locked())
        with self.assertRaisesRegex(server.RunnerBlocked, '^runner_paused$'):
            service.handle('test')
        self.assertEqual(service.handle('logs')['events'][0]['run_id'], 'ea349d63c404498ebd1d9370f65f5b89')

    def test_native_exception_fields_are_allowlisted(self):
        report = {'stages': {}, 'exit_codes': {}}
        for line in ('FIXTURE_CREATE_ERROR_CATEGORY=process_start',
                     'FIXTURE_CLEANUP_ERROR_CATEGORY=response_invalid',
                     'FIXTURE_CREATE_ERROR_LINE=35', 'FIXTURE_CREATE_ERROR_ID=Other',
                     'FIXTURE_CREATE_ERROR_ID=password-secret',
                     'FIXTURE_CREATE_ERROR_LINE=process_start'):
            server.accept_marker(report, line)
        self.assertEqual(report['errors']['FIXTURE_CREATE'], {'category': 'process_start', 'line': 35, 'id': 'Other'})
        self.assertNotIn('secret', json.dumps(report))

    def test_only_allowlisted_markers_survive(self):
        report = {'stages': {}, 'exit_codes': {}}
        for line in ('FIXTURE_CREATE=PASS', 'PLAYWRIGHT_AUTH_EXIT_CODE=7',
                     'FAILED_STAGE=PLAYWRIGHT_AUTH', 'password=secret', 'FIXTURE_CREATE=secret',
                     'COOKIE=secret', 'RUN_REGISTRY_CLEANUP=BLOCKED'):
            server.accept_marker(report, line)
        self.assertEqual(report['stages'], {'FIXTURE_CREATE': 'PASS', 'RUN_REGISTRY_CLEANUP': 'BLOCKED'})
        self.assertEqual(report['exit_codes'], {'PLAYWRIGHT_AUTH': 7})
        self.assertNotIn('secret', json.dumps(report))

    def test_process_failure_and_timeout_preserve_partial_diagnostics(self):
        import subprocess
        for timeout in (False, True):
            report = {'stages': {}, 'exit_codes': {}}
            process = unittest.mock.MagicMock()
            process.stdout = io.BytesIO(b'FIXTURE_CREATE=PASS\npassword=secret\nFIXTURE_CLEANUP=BLOCKED\n')
            process.wait.side_effect = [subprocess.TimeoutExpired('private', 600), 0] if timeout else [1]
            process.terminate_tree.return_value = True
            with patch.object(server, 'WindowsProcessTree', return_value=process):
                with self.assertRaises(server.RunnerBlocked):
                    server.DockerExecutor()._run_test(['fixed'], {}, report)
            self.assertEqual(report['category'], 'timeout' if timeout else 'process_failed')
            self.assertEqual(report['stages']['FIXTURE_CREATE'], 'PASS')
            self.assertEqual(report['stages']['FIXTURE_CLEANUP'], 'BLOCKED')
            self.assertNotIn('secret', json.dumps(report))
            if timeout:
                process.terminate_tree.assert_called_once()

    def test_structured_failure_exposes_only_valid_run_id(self):
        rid = '74e2bacf6cbd4ef080f5aa04ee296f5c'
        error = urllib.error.HTTPError(client.BASE, 503, 'private', {},
                  io.BytesIO(json.dumps({'error': 'auth_test_failed', 'run_id': rid}).encode()))
        self.assertEqual(client.diagnostic(error)[2], 'auth_test_failed')
        self.assertEqual(error.safe_run_id, rid)

    def test_systemdrive_is_derived_not_inherited(self):
        with patch.dict(os.environ, {'SystemDrive': 'remote-invalid'}):
            env = server._child_env()
        self.assertNotEqual(env.get('SystemDrive'), 'remote-invalid')
        self.assertRegex(env['SystemDrive'], r'^[A-Za-z]:$')


class FixedDockerCallTests(unittest.TestCase):
    def test_test_route_rejects_changed_plugin_before_docker(self):
        original_open = Path.open
        with patch.object(Path, "open", lambda path, *args, **kwargs: io.BytesIO(b"tampered")
                          if path == server.COMPOSE_PLUGIN else original_open(path, *args, **kwargs)), \
             patch.object(server.subprocess, "run") as run:
            with self.assertRaisesRegex(server.RunnerBlocked, "^compose_plugin_untrusted$"):
                server.DockerExecutor().test((b"reviewed compose bytes", {}, b"trusted script"))
            run.assert_not_called()

    def test_compose_plugin_is_fixed_regular_file_with_expected_hash(self):
        self.assertEqual(server._verified_compose_plugin(), server.COMPOSE_PLUGIN)
        self.assertTrue(server.COMPOSE_PLUGIN.is_absolute())

    def test_compose_plugin_missing_link_or_changed_is_rejected_before_docker(self):
        with patch.object(server, "COMPOSE_PLUGIN", server.ROOT / "missing-compose-plugin.exe"), \
             patch.object(server.subprocess, "run") as run:
            with self.assertRaises(server.RunnerBlocked):
                server.DockerExecutor().status((b"reviewed compose bytes", {}))
            run.assert_not_called()
        original_is_symlink = Path.is_symlink
        with patch.object(Path, "is_symlink", lambda path: path == server.COMPOSE_PLUGIN or original_is_symlink(path)), \
             patch.object(server.subprocess, "run") as run:
            with self.assertRaises(server.RunnerBlocked):
                server.DockerExecutor().status((b"reviewed compose bytes", {}))
            run.assert_not_called()
        original_open = Path.open
        with patch.object(Path, "open", lambda path, *args, **kwargs: io.BytesIO(b"tampered")
                          if path == server.COMPOSE_PLUGIN else original_open(path, *args, **kwargs)), \
             patch.object(server.subprocess, "run") as run:
            with self.assertRaisesRegex(server.RunnerBlocked, "^compose_plugin_untrusted$"):
                server.DockerExecutor().status((b"reviewed compose bytes", {}))
            run.assert_not_called()

    def test_status_distinguishes_docker_info_failure(self):
        class Failed:
            returncode = 1
            stdout = b""
        with patch.object(server.subprocess, "run", return_value=Failed()) as run:
            with self.assertRaisesRegex(server.RunnerBlocked, "^docker_info_failed$"):
                server.DockerExecutor().status((b"reviewed compose bytes", {}))
        self.assertIn("info", run.call_args.args[0])

    def test_status_distinguishes_compose_ps_failure(self):
        class Result:
            def __init__(self, argv):
                self.returncode = 1 if "ps" in argv else 0
                self.stdout = b"" if self.returncode else b"linux\n"
        with patch.object(server.subprocess, "run", side_effect=lambda argv, **_kwargs: Result(argv)) as run, \
             patch.object(server, "protected_compose_snapshot") as snapshot:
            snapshot.return_value.__enter__.return_value = Path(r"C:\private-runner\snapshot.yml")
            with self.assertRaisesRegex(server.RunnerBlocked, "^compose_ps_failed$"):
                server.DockerExecutor().status((b"reviewed compose bytes", {}))
        self.assertEqual(run.call_count, 2)
        self.assertIn("ps", run.call_args.args[0])

    def test_status_process_launch_error_is_stage_specific(self):
        with patch.object(server.subprocess, "run", side_effect=OSError("private detail")):
            with self.assertRaisesRegex(server.RunnerBlocked, "^docker_info_failed$"):
                server.DockerExecutor().status((b"reviewed compose bytes", {}))

    def test_docker_scope_and_no_shell(self):
        seen = []
        trusted = (b"reviewed compose bytes", {"JKH_LOCAL_DB_PASSWORD": "a" * 64})
        snapshot_path = Path(r"C:\private-runner\compose-unique\docker-compose.local.yml")
        def fake_run(argv, **kwargs):
            seen.append((argv, kwargs))
            class Result:
                returncode = 0
                stdout = b"linux\n" if "info" in argv else b""
            return Result()
        with patch.object(server.subprocess, "run", side_effect=fake_run), patch.object(server, "protected_compose_snapshot") as snapshot:
            snapshot.return_value.__enter__.return_value = snapshot_path
            executor = server.DockerExecutor()
            self.assertEqual(executor.status(trusted)["project"], server.PROJECT)
            snapshot.assert_called_once_with(trusted[0])
        self.assertEqual(len(seen), 2)
        self.assertTrue(all(call[1]["shell"] is False for call in seen))
        self.assertEqual(seen[1][0][0], str(server.COMPOSE_PLUGIN))
        self.assertNotIn("compose", seen[1][0])
        self.assertEqual(seen[1][0][seen[1][0].index("-p") + 1], server.PROJECT)
        self.assertEqual(seen[1][0][seen[1][0].index("-f") + 1], str(snapshot_path))
        self.assertEqual(seen[1][0][seen[1][0].index("--project-directory") + 1], str(server.ROOT))
        self.assertEqual(seen[1][1]["env"]["DOCKER_HOST"], server.PIPE)
        self.assertEqual(seen[1][1]["env"]["COMPOSE_DISABLE_ENV_FILE"], "1")
        self.assertEqual(seen[1][1]["env"]["JKH_LOCAL_DB_PASSWORD"], "a" * 64)

    def test_auth_suite_receives_runner_owned_run_id(self):
        seen = []
        def fake_run(argv, **kwargs):
            seen.append((argv, kwargs))
            class Result:
                returncode = 0
                stdout = b"linux\n"
            return Result()
        with patch.object(server.subprocess, "run", side_effect=fake_run), patch.object(server.DockerExecutor, "_run_test", side_effect=lambda argv, env, report: seen.append((argv, {"env": env, "cwd": server.ROOT}))), patch.object(server, "_ordinary_path", side_effect=lambda path: path), \
             patch.object(server, "protected_compose_snapshot") as snapshot, patch.object(server, "protected_script_snapshot") as script_snapshot:
            snapshot.return_value.__enter__.return_value = Path(r"C:\private-runner\snapshot.yml")
            script_snapshot.return_value.__enter__.return_value = Path(r"C:\private-runner\auth.ps1")
            result = server.DockerExecutor().test((b"reviewed compose bytes", {}, b"trusted script"))
            script_snapshot.assert_called_once_with(b"trusted script")
        self.assertRegex(result["run_id"], r"^[0-9a-f]{32}$")
        self.assertEqual(seen[1][1]["env"]["JKH_FIXTURE_RUN_ID"], result["run_id"])
        self.assertNotIn("JKH_RUNNER_TOKEN", seen[1][1]["env"])
        self.assertEqual(seen[1][1]["env"]["DOCKER_HOST"], server.PIPE)
        self.assertEqual(seen[1][1]["env"]["COMPOSE_PROJECT_NAME"], server.PROJECT)
        self.assertEqual(seen[1][1]["env"]["JKH_RUNNER_COMPOSE_SNAPSHOT"], str(Path(r"C:\private-runner\snapshot.yml")))
        self.assertEqual(seen[1][0][-1], str(Path(r"C:\private-runner\auth.ps1")))
        self.assertEqual(seen[1][1]["cwd"], server.ROOT)

    def test_failed_auth_suite_reports_recovery_run_id(self):
        def fake_run(argv, **_kwargs):
            class Result:
                returncode = 2 if "-File" in argv else 0
                stdout = b"linux\n"
            return Result()
        with patch.object(server.subprocess, "run", side_effect=fake_run), patch.object(server.DockerExecutor, "_run_test", side_effect=server.RunnerBlocked("auth_test_failed")), patch.object(server, "_ordinary_path", side_effect=lambda path: path), \
             patch.object(server, "protected_compose_snapshot") as snapshot, patch.object(server, "protected_script_snapshot") as script_snapshot:
            snapshot.return_value.__enter__.return_value = Path(r"C:\private-runner\snapshot.yml")
            script_snapshot.return_value.__enter__.return_value = Path(r"C:\private-runner\auth.ps1")
            with self.assertRaisesRegex(server.RunnerBlocked, "auth_test_failed"):
                server.DockerExecutor().test((b"reviewed compose bytes", {}, b"trusted script"))
            self.assertTrue(snapshot.return_value.__exit__.called)
            self.assertTrue(script_snapshot.return_value.__exit__.called)

    def test_client_rejects_arbitrary_operation_before_network(self):
        class NoNetwork:
            def open(self, *_args, **_kwargs):
                raise AssertionError("network must not be used")
        with self.assertRaises(ValueError):
            client.invoke("exec", TOKEN, NoNetwork())
        with self.assertRaises(ValueError):
            client.invoke("status", "short", NoNetwork())


@unittest.skipUnless(os.environ.get('RUNNER_WINDOWS_SECURITY') == '1', 'explicit isolated Windows runtime check')
class WindowsRuntimeSecurityTests(unittest.TestCase):
    def test_job_terminates_child_and_grandchild(self):
        import subprocess
        child = "import subprocess,sys,os,json,time; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(90)']); print(json.dumps([os.getpid(),p.pid]),flush=True); time.sleep(90)"
        root = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c'," + repr(child) + "]); time.sleep(90)"
        tree = server.WindowsProcessTree([sys.executable, '-B', '-c', root], server._child_env())
        handles = []
        k = tree.k
        k.OpenProcess.restype = ctypes.c_void_p
        k.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        try:
            pids = json.loads(tree.stdout.readline())
            for pid in pids:
                handle = k.OpenProcess(0x100000, False, pid)
                self.assertTrue(handle)
                handles.append(handle)
            with self.assertRaises(subprocess.TimeoutExpired):
                tree.wait(.05)
            self.assertTrue(tree.terminate_tree())
            for handle in handles:
                self.assertEqual(k.WaitForSingleObject(handle, 0), 0)
        finally:
            tree.terminate_tree()
            tree.stdout.close(); tree.close()
            for handle in handles: k.CloseHandle(handle)

    def test_snapshot_cannot_be_written_replaced_deleted_or_directory_renamed(self):
        import subprocess
        contents = (server.ROOT / 'scripts/local-auth-test.ps1').read_bytes()
        with server.protected_script_snapshot(contents) as snapshot:
            self.assertEqual(snapshot.read_bytes(), contents)
            parser = "$t=$null; $e=$null; [System.Management.Automation.Language.Parser]::ParseFile('" + str(snapshot).replace("'", "''") + "',[ref]$t,[ref]$e)|Out-Null; if($e.Count){exit 1}"
            result = subprocess.run([str(server.PWSH), '-NoProfile', '-NonInteractive', '-Command', parser],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            self.assertEqual(result.returncode, 0)
            with self.assertRaises(OSError):
                snapshot.write_bytes(b'tampered')
            with self.assertRaises(OSError):
                snapshot.unlink()
            with self.assertRaises(OSError):
                snapshot.parent.rename(snapshot.parent.with_name(snapshot.parent.name + '-renamed'))
            replacement = snapshot.parent / 'replacement.ps1'
            try:
                replacement.write_bytes(b'tampered')
                with self.assertRaises(OSError):
                    os.replace(replacement, snapshot)
            finally:
                replacement.unlink(missing_ok=True)
            self.assertEqual(snapshot.read_bytes(), contents)
        self.assertFalse(snapshot.exists())
        with self.assertRaisesRegex(RuntimeError, 'isolated failure'):
            with server.protected_script_snapshot(contents) as snapshot:
                raise RuntimeError('isolated failure')
        self.assertFalse(snapshot.exists())


if __name__ == "__main__":
    unittest.main()
