"""Fixed LOCAL LAB runner client; token is inherited from the launch environment."""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request


BASE = "http://127.0.0.1:8765"
OPERATIONS = {"status": ("GET", "/v1/status", 20), "logs": ("GET", "/v1/logs", 5),
              "test": ("POST", "/v1/test", 620)}
SAFE_REASONS = frozenset({
    "unauthorized", "request_origin_forbidden", "unknown_operation", "request_body_forbidden",
    "operation_busy", "untrusted_path", "mount_tree_unreadable", "mount_link_forbidden",
    "wrong_worktree", "trusted_file_changed", "unsafe_compose", "runtime_env_invalid",
    "snapshot_location_invalid", "snapshot_changed", "local_operation_failed",
    "docker_response_too_large", "wrong_docker_engine", "unexpected_docker_response",
    "docker_info_failed", "compose_ps_failed", "compose_plugin_untrusted",
    "internal_error", "auth_test_failed", "runner_paused", "snapshot_lock_failed",
})


def diagnostic(exc, operation="status"):
    """Return bounded, allowlisted diagnostics; never include exception text or headers."""
    if isinstance(exc, urllib.error.HTTPError):
        status = exc.code if isinstance(exc.code, int) and 100 <= exc.code <= 599 else "UNKNOWN"
        try:
            payload = json.loads(exc.read(4097))
            reason = payload.get("error") if isinstance(payload, dict) else None
            if reason == 'auth_test_failed' and isinstance(payload, dict):
                run_id = payload.get('run_id')
                if isinstance(run_id, str) and re.fullmatch(r'[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}', run_id):
                    exc.safe_run_id = run_id
        except (ValueError, UnicodeError, OSError):
            reason = None
        reason = reason if isinstance(reason, str) and reason in SAFE_REASONS else "unrecognized_response"
        category = {401: "authorization", 403: "request_origin", 409: "busy"}.get(status, "runner_error")
        if status == 503 and reason == 'auth_test_failed':
            category = 'auth_test'
        elif status == 503 and reason == "internal_error":
            category = "runner_internal"
        elif status == 503 and operation == "status" and reason in {
            "local_operation_failed", "docker_response_too_large", "wrong_docker_engine", "unexpected_docker_response",
            "docker_info_failed", "compose_ps_failed"
        }:
            category = "docker"
        elif status == 503 and reason in SAFE_REASONS:
            category = "workspace_guard"
        return status, category, reason
    if isinstance(exc, (urllib.error.URLError, TimeoutError, OSError)):
        return "NONE", "connection", "request_failed"
    if isinstance(exc, (ValueError, UnicodeError)):
        return "NONE", "client_response", "invalid_response"
    return "NONE", "client_internal", "unexpected_error"


def invoke(operation, token, opener=None):
    if operation not in OPERATIONS or not re.fullmatch(r"[0-9a-fA-F]{64}", token or ""):
        raise ValueError("invalid_runner_request")
    method, path, timeout = OPERATIONS[operation]
    request = urllib.request.Request(BASE + path, data=b"" if method == "POST" else None,
                                     headers={"Authorization": "Bearer " + token, "Host": "127.0.0.1:8765"},
                                     method=method)
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=timeout) as response:
        if response.status != 200:
            raise ValueError("runner_rejected_request")
        raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError("runner_response_too_large")
        return json.loads(raw)


def main():
    parser = argparse.ArgumentParser(description="LOCAL LAB runner client")
    parser.add_argument("operation", choices=tuple(OPERATIONS))
    args = parser.parse_args()
    try:
        result = invoke(args.operation, os.environ.get("JKH_RUNNER_TOKEN", ""))
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    except Exception as exc:
        status, category, reason = diagnostic(exc, args.operation)
        print(f"LOCAL_LAB_RUNNER_CLIENT=BLOCKED HTTP_STATUS={status} "
              f"ERROR_CATEGORY={category} REASON={reason}" +
              (f" RUN_ID={exc.safe_run_id}" if hasattr(exc, 'safe_run_id') else ''), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
