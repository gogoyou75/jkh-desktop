# LOCAL LAB

Run from the repository root on Windows 11 with PowerShell 7 and local Docker Desktop:

```powershell
pwsh -NoProfile -File .\scripts\local-test.ps1
```

The command prints `LOCAL_TEST_RESULT=PASS` only after the local stack, test database, Python and JavaScript tests, and Playwright smoke test pass. It exits nonzero on any failure. PLATFORMA can later invoke this command and read its exit code and result marker without changing PLATFORMA's architecture.

The script accepts only the `desktop-linux` Docker context with the local named pipe. It stops if Docker access is denied. It never changes Docker permissions or context. It creates random **test-only** credentials once in ignored `.local-lab/runtime.env`; it never prints them. Do not copy server credentials or database dumps into LOCAL LAB.

`docker-compose.local.yml` is independent of `docker-compose.yml`. Its MySQL uses the dedicated `jkh_local_lab_mysql_data` Compose volume and an internal network, with no host port. Nginx is published only on `127.0.0.1:8080`; Flask is published only on `127.0.0.1:5055`. The backend refuses `LOCAL_LAB` unless its MySQL host, port, database, and user are the expected local values. Unknown environment names fail at startup. The frontend stores LOCAL_LAB browser data in its own scope.

Nginx serves `web/` through a read-only bind mount with `no-store` responses, so changed web files appear on reload. Gunicorn uses `--reload` only in this local Compose file and watches the backend bind mount. Dependency changes are incorporated by the command's `--build` step. The command initializes schema only in `jkh_local_lab` after checking the target.

Manual check after a successful run: open `http://127.0.0.1:8080/premises.html`, confirm `/api/env` reports `LOCAL_LAB`, edit a harmless local web label and reload to observe the bind mount, then restore the label. Make a harmless local Python change and confirm Gunicorn reloads. The regression check is `pwsh -NoProfile -File .\scripts\local-test.ps1`; edge cases are an unavailable Engine, remote Docker context, occupied ports, corrupted test credentials, and an incorrect database target. Each must stop with a nonzero exit code.

Rollback: stop only this Compose project with `docker compose --env-file .local-lab/runtime.env -f docker-compose.local.yml -p jkh_local_lab stop`. This preserves the local MySQL volume. Do not run `down --volumes` or remove shared Docker resources.
