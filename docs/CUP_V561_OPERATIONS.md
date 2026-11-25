# CUP v5.6.1 operations

## Startup and one-time VPS LAB configuration

The following commands are for the owner to run on VPS LAB, after installing the
reviewed files. They are not executed by the local development/test workflow.
Working directory: `/root/jkh-lab`.

```bash
cd /root/jkh-lab
python3 scripts/setup_cup_v5_6_1_vps_lab.py
python3 scripts/setup_cup_v5_6_1_vps_lab.py --write
bash scripts/jkh_server_menu_v5_6_1.sh
```

The first command checks existing metadata and prints `validated_dry_run`. The
second exclusively creates `.schema-state/LAB/launch.json` with private permissions;
it never overwrites an existing different configuration. An identical existing
configuration is accepted. Select **VPS LAB** in the menu, then `19` and `19.1` for
diagnosis. Python 3.11+ is required on the menu host.

The script uses the existing protected files without printing their contents:

- `/root/jkh-lab/.env.api` (application connection names `ENV_TYPE`, `DB_*`).
- `/root/jkh-lab-backups/v55-maintenance.env` (`MAINT_ENV_TYPE`, `MAINT_DB_*`).
- `/root/jkh-lab-backups/v55-restore-cup.env` (`RESTORE_ENV_TYPE`, `RESTORE_DB_*`).
- `/root/jkh-lab/.schema-state/LAB/policy.json`.
- `/root/jkh-lab/docker-compose.yml`.

The setup performs **no Docker or database operations**, permission changes,
credential changes, service restarts or restore-target cleanup. It validates the
variable names and reuses `cup_config.py` for path/profile/permission validation.
Actual connection values, policy and target identity are verified by the existing
Schema Control/Maintenance operations before database work. If a source file or
permission check fails, review the reported exact path; do not bypass validation.
Shell environment files must contain trusted owner-controlled shell assignments.

**The previously used restore database is preserved.** A new migration requires a
separate, verified empty restore target provisioned through the existing approved
Restore role procedure. The owner must update the existing restore credentials
file/policy as required by that procedure, then diagnose/plan again. These setup
commands neither create that database nor certify that the existing target is
empty. `restore_target_must_be_empty` blocks backup validation; do not clear a used
target automatically or point Restore at a working database.

Normal subsequent launch needs no manual exports:

```bash
cd /root/jkh-lab
bash scripts/jkh_server_menu_v5_6_1.sh
# Equivalent launcher; selects profile explicitly:
bash scripts/cup.sh VPS_LAB
```

On Windows, from the project directory: `scripts\cup.cmd LOCAL_LAB`. LOCAL LAB
uses `<project>/.schema-state/LOCAL_LAB/launch.json`; PROD uses
`/root/jkh/.schema-state/PROD/launch.json`. Configure each profile independently as
described in CUP_V56_AUTOMATION.md. `CUP_V56_CONFIG` can explicitly select a launch
file; a profile mismatch blocks rather than falling back. Selecting another
profile clears connection and schema configuration variables first. Only paths
are loaded in the menu parent; credentials are sourced in scoped child operations
and passed to one-off tools, never added to the permanent API environment.
`cup.sh` and `cup.cmd` launch v5.6.1; explicit v5.5/v5.6 filenames remain available.

## Operational lock and recovery

All versions share `/tmp/jkh_server_menu_v5_3.lock`. v5.6.1 acquires it for an
operation, not while waiting in the main menu or choosing a submenu. A permanent
`.guard` file serializes v5.6.1 acquire/release/recovery using OS locks; never
manually remove either file to bypass a live owner. `L` displays the evidence:

- `ACTIVE_OPERATION`: live verified operation/children; recovery forbidden.
- `WAITING_CONFIRM`: verified v5.6.1 operation awaiting plan approval; lock retained.
- `WAITING_INSTANCE`: legacy owner positively observed waiting on stdin with no
  child operation; the owner must close that menu normally. It is never reclaimed.
- `CONFIRMED_STALE`: owner absent, process/one-off container inventory checked.
  Only this state permits explicit `RECOVER <environment>` confirmation. Identity,
  environment, fingerprint and inventory are checked again before file removal.
- `UNDETERMINED`: PID reuse, missing identity/inventory, unrecognized metadata or
  associated processes/containers; operation blocked. Investigate before retrying.

PID birth time, boot identity, command fingerprint, cwd, owner, process tree and
local Docker Compose one-off container labels contribute to the decision. Idle
v5.6.1 instances register their current phase with their process birth identity.
Old versions with insufficient evidence, especially legacy Windows locks, remain
blocked. A locally inaccessible Docker engine also prevents stale proof.
SIGINT/SIGTERM terminate the waiting menu or signal only its verified own operation
tree, then exit with 130/143. No automatic SIGKILL or foreign-process termination is
used. A surviving child/container retains the lock for later investigation.

**File-lock recovery never resumes MySQL writers, unlocks accounts, removes
persistent Maintenance or certifies database integrity.** After an interrupted
migration use `19.1`/`19.4`, review the preserved operation and follow the existing
`19.7`/`19.9` recovery protocol. Resume only after schema/data checks succeed.

## Reports and logs

```text
RESULT: BLOCKED
Среда: VPS LAB
Операция: STARTUP
Причина: отсутствует защищённый файл конфигурации/credentials
Ожидаемый файл: /root/jkh-lab/.schema-state/LAB/launch.json
Миграция: не начата в этой операции
Приложение: NOT_CHECKED
БД: NOT_CHECKED
Далее: Настроить указанный файл по docs/CUP_V561_OPERATIONS.md и повторить выбранную операцию
```

Operation reports preserve the lower-level reason and distinguish SUCCESS, FAILED,
BLOCKED. Entering a scenario does not prove completion. A requested migration is
reported as unconfirmed until the workflow verifies it. Sanitized detailed logs
are under `.schema-state/<environment>/logs`; `19.8` remains available. Do not
publish private state/credentials/backups. Profile and Restore errors must be
resolved for that profile, never by falling back to another database.

## Local validation and rollback

Runtime tests use synthetic private files, real disposable Linux processes and
mocked local container inventory; Docker-container inventory failures remain
fail-closed in production. Existing workflow tests additionally use isolated
MySQL 8.0.45 and Restore fixtures. No VPS or working database is used. Native Windows tests cover the MSYS native
launcher parent chain, binary lock fingerprints and fail-closed cup.cmd startup.
A successful cup.cmd launch with a genuinely private Windows configuration must
also be checked on a host whose existing ACLs satisfy the validator. The current
local runner denies tightening the fixture DACL; this is not bypassed, and no
Windows system security settings are changed.

To revert only the menu after review, invoke the preserved v5.6/v5.5 script
explicitly. Do not revert database migrations, delete operation state or remove
Maintenance as part of a menu rollback. Legacy lock owners still require manual
owner attention. Database copying (future item 20) remains a separate, explicitly
approved operation and is not implemented here.
