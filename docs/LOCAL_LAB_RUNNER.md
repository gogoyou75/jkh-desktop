# LOCAL LAB Runner v1

The Windows host process exposes only `GET /v1/status`, `GET /v1/logs`, and `POST /v1/test` on `127.0.0.1:8765`. Every request needs `Authorization: Bearer <64 hex characters>`. Requests with any `Origin`, an unexpected `Host`, a request body, or an unknown operation are rejected. There is no CORS or cookie authentication. `logs` returns at most 50 sanitized runner events, not container logs.

`status` checks the local Linux Docker Engine through the fixed `dockerDesktopLinuxEngine` named pipe, then lists only the `jkh_local_lab` Compose project. `test` runs the existing `scripts/local-auth-test.ps1` suite with a fixed executable and no request arguments. The runner creates a UUID4 run ID and passes it to the script through a child-only environment variable. That suite creates a temporary fixture user, runs the Playwright authentication test, and verifies cleanup. The result and sanitized runner event include the run ID so an interrupted run can be recovered through the existing fixture procedure. Both Docker operations require the exact worktree and SHA-256 hashes recorded in `server.py` for the reviewed Compose file, fixture, test script, and browser tests. The runner rejects symlinks and junctions in the target paths, unexpected runtime environment entries, and dangerous Compose fields. Any approved change to a pinned file requires a fresh review and hash update.

For each Docker operation the runner hashes the Compose bytes it read, writes those exact bytes to an exclusive temporary file below `%LOCALAPPDATA%\JKH_LOCAL_LAB_RUNNER`, verifies the copy, and passes only that private path to Docker. Codex's workspace sandbox cannot write there. `--project-directory` remains fixed to the reviewed worktree so relative bind mounts still resolve to the intended project. The temporary Compose copy has no secrets and is removed after the operation. The LOCAL LAB secrets are read once from the validated `runtime.env` and passed only as child-process environment variables; no temporary secret file is created. `COMPOSE_DISABLE_ENV_FILE=1` prevents an additional project `.env` file from influencing Compose. The source Compose file and `runtime.env` can change later without changing the bytes already passed to the Docker command. The runner checks mounted source trees for symlinks and junctions and pins the nginx configuration hash.

The runner must run as the normal Windows user with access to local Docker Desktop. It must not be run inside Codex's sandbox. It is not a Docker Engine authorization layer: a compromise of the host runner process or its Windows account can use the account's ordinary Docker privileges. Keep the token private and use a dedicated shell session. No token is stored in this repository.

## Executables, snapshots and diagnostics

Compose is invoked directly at `C:\Program Files\Docker\Docker\resources\cli-plugins\docker-compose.exe`; it is not discovered through PATH or `docker compose`. The plugin must be a regular file without symlink/junction ancestors and match `COMPOSE_PLUGIN_SHA256` in `server.py`. Docker Desktop updates can invalidate that hash: review the new binary before updating the pin. `docker.exe info` uses the fixed local named pipe; direct Compose inherits that same `DOCKER_HOST` and the fixed `jkh_local_lab` project. The child environment is allowlisted; `SystemDrive` is derived from a local existing `SystemRoot`, rather than copied from an arbitrary environment value.

`TRUSTED_HASHES` pins Compose, the PowerShell script, fixture module, browser scenario/config/setup, and nginx configuration. After any approved edit, update the corresponding SHA-256 and rerun the isolated tests. Both Compose and PowerShell execute verified byte snapshots outside the worktree. PowerShell retains the project working directory, so moving the script does not change relative paths. Windows handles keep snapshot ancestors unrenamable and the snapshot file unavailable for writing/deletion from verification through consumer completion. The snapshot is hashed again while held, permits read access to PowerShell/Compose, and is cleaned after the handles are released. No Windows ACL is changed. The snapshot base ACL was inspected on this host: OWNER RIGHTS, SYSTEM and Administrators have access. This is a local-user security boundary, not protection against a compromised administrator.

Responses and bounded in-memory `logs` events contain `run_id`, stage states, numeric exit codes, allowlisted error categories/IDs and line numbers. Raw stdout/stderr, fixture JSON, credentials and exception messages are not written to diagnostics. Fixture JSON exists only transiently to transfer the synthetic credentials to the browser process. Successful completion of the pinned browser scenario proves both login and logout; failed scenarios leave those results BLOCKED. Logs are lost when the runner exits, so record the safe structured response and run ID before stopping it.

## Timeout and recovery

The Windows test process starts suspended and is assigned to a non-breakaway, kill-on-close Job Object before its first instruction. Descendants inherit job membership. The runner enforces a 600-second wait, terminates the job and confirms process-handle completion and zero active job members before releasing the operation lock. This also prevents descendants from surviving normal script completion. It affects host child processes, not Docker Engine containers.

If termination or output-reader completion cannot be confirmed, the runner enters PAUSED, keeps the execution lock and rejects subsequent status/test operations with `runner_paused`; authenticated `logs` remains available with the run ID. There is no HTTP resume or automatic retry. Do not restart the runner merely to clear this state: first confirm the old process tree has stopped, inspect only that run's fixture records with the guarded LOCAL LAB procedure, and if needed perform ownership-safe `recover --run-id <that UUID4>` as documented in `LOCAL_LAB_FIXTURE.md`. Independently verify the exact user's and registry row's absence before restarting. Timeout never proves database cleanup, and killing a host Docker client does not cancel an operation already accepted by the Engine. Keep snapshots and run evidence under review if cleanup fails.

The service is exclusively for local LOCAL LAB. Never point it at VPS, remote LAB/PROD, or a different Docker host/project. It accepts no caller-provided command, path, environment or Compose arguments and exposes no start/up/down operation.

## Local start

Working directory: `C:\Users\SERGIO TOBETO\.codex\worktrees\80f7\jkh-desktop`. In PowerShell 7, set a fresh token and launch the runner from the same shell that will launch Codex, so both inherit the token:

```powershell
$env:JKH_RUNNER_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$runner = Start-Process -FilePath (Get-Command python).Source -ArgumentList @('-B', '.\local-lab\runner\server.py') -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -PassThru
python -B .\local-lab\runner\client.py status
```

The expected status response names only `jkh_local_lab` and its known services. The runner does not start containers. Launch Codex from this shell to let its sandbox client inherit `JKH_RUNNER_TOKEN`. If the environment policy does not forward that variable, client access is blocked until a separately reviewed secret delivery method is provided.

After testing, stop only the process returned in `$runner`, then clear the shell token:

```powershell
Stop-Process -Id $runner.Id
Remove-Item Env:JKH_RUNNER_TOKEN
```

Client commands are `python -B .\local-lab\runner\client.py status`, `logs`, and `test`. `test` runs the entire existing authorization cycle and may write only LOCAL LAB fixture records as described in `LOCAL_LAB_FIXTURE.md`. It is not part of the unit checks in this change.

## Verification and rollback

Run the mock-only checks from the repository root:

```powershell
python -B -m unittest discover -s local-lab/runner -p test_runner.py -v
pwsh -NoProfile -File .\local-lab\runner\test_native.ps1
```

The Python suite runs mock tests and skips two explicitly opt-in Windows runtime tests. Run these from a normal Windows shell, with the same LOCALAPPDATA as the runner:

```powershell
$env:RUNNER_WINDOWS_SECURITY = '1'
try {
    python -B -m unittest local-lab.runner.test_runner.WindowsRuntimeSecurityTests -v
} finally {
    Remove-Item Env:RUNNER_WINDOWS_SECURITY
}
```

These two tests create only a temporary snapshot and a Python process tree. They attempt snapshot write/delete/replace/directory rename, verify read access, terminate child/grandchild processes and remove only their own temporary objects. They do not invoke Docker, fixture or Playwright, and do not change ACLs. The PowerShell test extracts the script functions and exercises its try/finally with mock processes and synthetic response text.

The tests use an injected Docker executor and a loopback mock HTTP listener. They do not invoke Docker or touch MySQL. Before any Docker integration, review the pinned files, Windows executable locations, token delivery, local pipe and Compose project isolation. Bind mount source directories remain live worktree paths; a concurrent rename by a process with write access to those directories remains a separate risk. If a guard cannot be confirmed, keep the operation blocked. Rollback is stopping the runner process and removing only the runner files after review; do not remove LOCAL LAB volumes or fixture records as a rollback step.
