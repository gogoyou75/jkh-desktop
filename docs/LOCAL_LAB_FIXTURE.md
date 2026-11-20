# LOCAL LAB authentication fixture

Run from the repository root in PowerShell 7 after the LOCAL LAB stack is running:

```powershell
pwsh -NoProfile -File .\scripts\local-auth-test.ps1
```

The runner checks `/api/health`, creates one synthetic `user` account through `backend/local_lab_fixture.py`, sends its temporary credentials to the Playwright container through standard input, tests the ordinary login form and logout, and cleans up in `finally`. It prints the `FIXTURE_RUN_ID` but never prints the temporary password. The browser test disables traces, screenshots, and video.

The fixture has no HTTP route. Before creating its registry table or account, and again before any cleanup, it requires `ENV_TYPE=LOCAL_LAB`, the configured MySQL target `mysql:3306/jkh_local_lab` with user `jkh_local`, and a live SQL response from `SELECT DATABASE(), @@port`. An error stops the operation. The first-user registration path is never used.

Each run has a unique UUID4 `run_id`. The `local_lab_fixture_runs` table records only the run ID and synthetic user's ID, email, and creation time. It contains no password. Cleanup checks the registry and the exact synthetic user identity. If any other database table refers to that user or run, cleanup stops with `BLOCKED` and retains the account for investigation; it does not delete unregistered records. A second cleanup after a completed cleanup returns `absent`.

If the runner is interrupted before `finally` completes, use the printed run ID to retry cleanup. From the repository root:

```powershell
docker compose --env-file .\.local-lab\runtime.env -f .\docker-compose.local.yml -p jkh_local_lab exec -T api python -B local_lab_fixture.py recover --run-id <RUN_ID>
```

If the run ID was lost, list pending fixture IDs first:

```powershell
docker compose --env-file .\.local-lab\runtime.env -f .\docker-compose.local.yml -p jkh_local_lab exec -T api python -B local_lab_fixture.py pending
```

Recovery uses the same environment, database, and ownership guards as normal cleanup. A `FIXTURE_BLOCKED` response requires investigation; do not delete the user or database volume by hand. The fixture deliberately creates no abonents, charges, or payments.

The runner reports `LOCAL_AUTH_TEST_RESULT=PASS` only after the browser test and verified cleanup both pass. On failure, keep the `FIXTURE_RUN_ID` for recovery. To roll back the code change, remove only the new fixture, runner, test, and this document after checking that `pending` is empty. Never remove the LOCAL LAB MySQL volume as a rollback step.
