# CUP v5.5 schema management

The supported entry point is `scripts/jkh_server_menu_v5_5.sh`. Items 0–18 remain; item 19 delegates schema operations to `backend/schema_control.py`. v5.3/v5.4.1 remain historical/compatibility files and are not changed by this feature.

## Authority and contract

Only Alembic revisions perform DDL. Schema Control does not import/start the Flask application. A portable AST fingerprint binds the ORM definitions to the reviewed frozen schema snapshot and `schema_contract.json`. Table creation, indexes and known reconciliation are implemented in revisions `cup_5501` and `cup_5502`. Do not edit an existing frozen snapshot/revision to implement a future schema; add reviewed revisions and a new versioned snapshot instead.

`backend/migrations/001–008` remain historical evidence. They are never executed by the tool. The old 001/002 import naming and the newer 003 naming are distinct: the reviewed historical tables are retained alongside the current import tables; no data is transferred or renamed automatically. Unknown tables, columns, types/defaults, indexes, keys, check constraints, unsupported engines or collation are blockers. Supported adoption states are the exact contract, an empty database, the finite reviewed historical variants below, and these states missing the reviewed 006/007 tables and/or the technical `kv_store.version` column. That counter is BIGINT DEFAULT 0 per ORM/008; no financial values are backfilled or replaced. A versioned database at head with drift is blocked.

The legacy initdb endpoint returns HTTP 409/schema_control_required and performs no DDL. There is no stamp command. Adoption runs checked Alembic revisions; an existing correct table is verified before being retained. Automatic downgrade is prohibited.

## Profiles

`LOCAL_LAB`: explicit CUP_LOCAL_PROJECT_DIR, CUP_LOCAL_MYSQL_CONTAINER and loopback CUP_LOCAL_SITE_CHECK; no /root path. Use CUP_HOST_PYTHON=python on Windows Git Bash when python3 is not installed. Compose project/containers/volumes must have local names, ports bind to loopback, and the Docker engine must be local. The application connection uses DB_HOST=mysql, DB_NAME=jkh_local_lab, DB_USER=jkh_local and ENV_TYPE=LOCAL_LAB. No automatic fallback is permitted.

Existing VPS LAB and PROD directories/containers remain unchanged. Their schema profiles are VPS_LAB (ENV_TYPE=LAB, database jkh_lab) and PROD (ENV_TYPE=PROD, database jkh). Database host/user/password/port must be explicitly supplied by the selected Compose service. The read-only inspector uses Maintenance metadata privileges; an explicitly required non-NULL data precondition uses APP SELECT, or the fenced migration session, independently checks DATABASE() and binds plans/backups to the server UUID, database and profile. LOCAL cannot run the VPS cross-environment reports.

## Operator sequence

1. Diagnose with 19.1; inspect current/required revision (19.2), migration graph (19.3), and plan (19.4).
2. Review the exact target backend contract. Git gates export only model/contract/snapshot data, without executing target code. Cherry-pick gates derive a prospective three-way result; unknown/conflicting contracts block. Main updates and rollback use the exact validated SHA.
3. Explicitly configure an empty isolated restore database using exported RESTORE_ENV_TYPE=LOCAL_LAB, RESTORE_DB_HOST, RESTORE_DB_PORT, RESTORE_DB_NAME=cup_restore_<unique_id>, RESTORE_DB_USER and RESTORE_DB_PASSWORD. Never place credentials in Git or command arguments. No restore database is selected or created automatically. For VPS/PROD, restore validation must use a different MySQL server UUID.
4. Create backup with 19.5 and confirm RESTORE_TEST_DB. Private typed JSONL snapshots include **every accepted source table and column**, including import_batch, import_batch_rows, users.status and the original Alembic version table. They preserve decimal precision, large text/blob values, bytes, dates, SQL NULL versus JSON null, and AUTO_INCREMENT counters (including deleted high IDs). Verification first reproduces the **source DDL**, original revision state and data in the empty isolated restore database; it does not create the target snapshot before restoring. This controlled restore uses the existing Alembic operations context, without stamping or adopting the source. Full source/restored DDL, all rows, metadata fingerprint and counters must match before receipt format 2 is issued. Application data checks after migration exclude only the intentional Alembic revision change. Old format-1 receipts cannot authorize new operations. Routines/triggers/events/views and unknown structures block backup. An occupied restore target is rejected, never cleared. Allocate a fresh restore target for the next backup.
5. Item 19.5 stops all declared writer services and verifies they have stopped, then enters the durable account fence before any source backup. In 19.6 supply the verified backup ID and `APPLY <profile> <plan_id>`. WRITERS_STOPPED is removed; --maintenance-confirmed is rejected. PROD retains YES_PROD confirmation. Plans expire after 15 minutes and bind contract/revision, database identity, migration code and pre-migration schema. A protected plan can be regenerated with item 19.4 while access remains fenced.
6. After migration, actual structure/revision and original data must match. Access remains fenced. Item 19.7 requires RESUME, checks compatibility under the fence, atomically restores only accounts previously unlocked, and starts only writer services recorded as previously running. Item 19.8 reads a redacted journal. Updates, restart/build, technical checks, cherry-pick and rollback cannot continue with incompatible schema. Missing contracts in older targets intentionally block rollback; do not bypass the gate or downgrade automatically.

Schema-tool containers are one-off Compose `run --no-deps --build` jobs with source mounted read-only. They do not start/restart the API service. Private plans, receipts, backups and journal are bind-mounted from `<project>/.schema-state/<environment>` and survive API rebuilds. Keep that ignored host directory private and backed up. Existing native backup item 16 is retained separately; only the validated schema backup receipt authorizes migration.

MySQL DDL implicitly commits. A transaction rollback cannot undo all structural changes. Failure stops the operation and releases the advisory lock; retain the backup and inspect the partial schema before a separately approved recovery. Writer account locks survive controller termination and lost connections. No error/exit handler unlocks them or restarts writers. A migration admission rotates the service password to a random value held only in memory; even a kill before re-locking that account leaves no reusable password in environment, argv, logs or files.

## Local verification

Working directory: the repository root.

```powershell
python scripts/test_schema_mysql.py
```

This builds an isolated test image and a uniquely labelled MySQL 8 container on an internal network, with tmpfs data and no published ports; it never uses application containers/data. Cleanup removes only the exact labelled resources it created. `.var` contains ignored private test artifacts. SQLite API regressions are supplementary and never count as MySQL DDL evidence.

Bash fixture tests: `bash scripts/test_server_menu_v5_5.sh`. These stub all real Docker/Git effects of the new UI and reuse the proven isolation/error-handling suite against v5.5. Real CLI diagnose/plan/check/no-op is additionally exercised on the disposable MySQL before release. Testing order remains LOCAL LAB, separately approved VPS LAB, then separately approved PROD.


Validated locally on 2026-11-24: MySQL 8.0.46, Docker Desktop Linux containers, Python 3.12 and Git Bash. The final MySQL suite passed 27/27 cases, including empty schema, legacy adoption, missing 006 tables, precise/NULL data and AUTO_INCREMENT backup/restore, partial DDL failure, concurrency, unknown drift and the unchanged No Name deletion endpoint. Bash fixtures passed 4 existing LAB-checkout cases, 61 existing v5.3/v5.4.1 cases and 72 v5.5 checkpoints (the latter reuses the existing suite). Backend regressions passed 272 cases; 207 environment-specific cases were skipped. Five real schema-tool calls (diagnose, migrations, plan, check, apply-noop) passed against the disposable fixture. Syntax checks passed for six Bash and seven Python files. These results do not validate an actual VPS/PROD schema or operational configuration.


## Durable maintenance and privilege boundary

`backend/maintenance_control.py` enforces account fencing independently of shell acknowledgements. Source backup and migration cannot run unless the durable fence is present, the complete privilege/client inventory is approved, and writer accounts are locked. Existing writer sessions are killed and InnoDB transactions are drained. The controller serializes all privileged operations with a server-side advisory lock; account locks, rather than that connection-scoped lock, provide the durable safety boundary.

Known write paths are the API/Gunicorn workers (including import, bulk verification, recalculation, No Name, store/auth/audit writes), the optional summary repair CLI, LOCAL fixture tooling and direct SQL clients. Nginx and desktop/browser/Playwright clients call the API; they have no independent MySQL role. All Compose services other than mysql/nginx must be explicitly declared and stopped. Direct clients are fenced by their accounts. A writer process/account introduced later must be reviewed; an unknown writer grant or unlisted connected database client blocks the operation. Root/DBA writer accounts are included in the policy and fenced too. A malicious holder of Maintenance credentials or host/DBA administrative control is outside this protection boundary.

A reviewed, secret-free `<project>/.schema-state/<environment>/policy.json` is mandatory. It contains format=1, profile, database, the exact MySQL server_uuid, writers as [[user,host],...], migration and maintenance as [user,host], services as [service_name,...], and client_hosts mapping every declared username to reviewed exact client addresses/hostnames or CIDRs. An active connection outside that allowlist blocks maintenance even when its username is known. The MySQL authenticated account plus source-host allowlist is the client identity boundary; do not share those credentials with untrusted processes. Every account variant must be enumerated. The maintenance/migration usernames must be unambiguous. Policy changes during an active maintenance cycle are rejected. Policies and persistent state are not source-controlled.

Provisioning is a separate DBA stage; the tool never creates/grants accounts on a deployment. The least-privilege fixture is executable evidence in `backend/tests/test_maintenance_mysql.py`:

| Identity | Required privileges |
| --- | --- |
| Application | SELECT, INSERT, UPDATE, DELETE on the exact application schema only; no DDL, dynamic/global privileges or GRANT OPTION. |
| Alembic | SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES on that schema only; no global/dynamic privileges or GRANT OPTION. Initially ACCOUNT LOCK. Each admitted connection gets an in-memory one-use password and the account is immediately re-locked. |
| Maintenance | CREATE USER (account locking/password rotation), PROCESS, SHOW DATABASES; CONNECTION_ADMIN and SYSTEM_USER (disconnect privileged declared writers), SHOW_ROUTINE (complete stored-program visibility); narrowly scoped SELECT on the mysql privilege metadata and performance_schema.replication_connection_configuration. Source-schema REFERENCES enables column/foreign-key metadata visibility without SELECT of business rows; TRIGGER and EVENT privileges are necessary to inspect their definitions: MySQL otherwise hides them. SELECT on alembic_version only (technical revision metadata), no financial/application-row SELECT, DML, CREATE, ALTER or DROP, and no GRANT OPTION. |
| Restore | Separate isolated server/database and a separately provisioned schema-scoped account with schema creation and data restore rights. It has no source-server credentials. |

Read-only diagnostics use the Maintenance metadata connection, including while writer accounts are locked; they neither rotate credentials nor create version tables. Before granting table-specific SELECT, a DBA explicitly bootstraps the empty alembic_version metadata table using Alembic ensure_version (no revision is stamped and no application table/data is changed). This is an account-provisioning prerequisite, not an implicit diagnostic operation. The empty-application-schema integration test covers this bootstrap state.

The metadata SELECT on mysql.user excludes authentication_string and covers only User, Host, account_locked and privilege flags. Other read-only catalog tables are mysql.db, role_edges, proxies_priv, tables_priv, columns_priv and global_grants. Source table metadata is visible through the required TRIGGER/EVENT privileges; ordinary application CRUD privileges would hide some definitions. Read-only diagnostics use that inspector connection even while writer accounts are locked, without rotating credentials or changing accounts/schema/data. Before granting SELECT on alembic_version, the DBA must bootstrap that empty technical table using Alembic ensure_version (no stamp/revision adoption). This is an explicit provisioning operation, never part of diagnostics. A new database still has no application tables until the guarded migration creates them. Existing unversioned application data remains unmodified during this bootstrap. Use escaped underscores in database GRANT patterns (for example `jkh\_local\_lab`) so privileges cannot match another schema. Roles are currently unsupported and block maintenance. Proxy grantees must themselves be explicitly fenced writers.

The source MySQL instance must be dedicated to the selected application schema, with event_scheduler OFF/DISABLED and no replication channels, application triggers, routines or events. These conditions are checked; the tool does not change server-wide settings. A shared instance or unsupported stored programs are blocked rather than fenced speculatively. The restore fixture uses a second isolated MySQL server. No application/container environment may contain Maintenance, migration, or MySQL root credentials: the shell rejects those Compose configurations. Export MAINT_ENV_TYPE and MAINT_DB_HOST/PORT/NAME/USER/PASSWORD only in the operator process; they are forwarded by environment names only to the one-off schema tool. Never add them to the API's shared env_file. The migration identity comes from the policy and has no exported reusable password. The operator needs no MIGRATION_DB_PASSWORD.

## Failure and recovery

On migration/backup failure, lost connection or SIGKILL, leave writers stopped and account locks in place. Do not delete maintenance.json, unlock accounts manually, downgrade or stamp. Re-enter item 19.5 to reconcile interrupted admission (it preserves the original account/service states); allocate a new empty restore database when a new backup is needed. For partial DDL, inspect the reported schema, generate a fresh protected plan via 19.4, obtain a newly verified backup/restore receipt, and apply only a reviewed known reconciliation. Unknown drift requires a separately reviewed Alembic recovery revision. Item 19.7 can restore access only after the actual schema and Alembic revision match the current backend. Missing state or changed policy blocks automatic recovery. If the state is lost, preserve account locks and recover the original state from the protected host backup through a separately approved DBA procedure.

After successful resume the migration account remains locked, and accounts originally locked remain locked. A subsequent maintenance cycle archives the prior secret-free state and records a fresh original state. A service-start failure occurs only after successful schema verification; its recorded prior state is retained for retry. A repeated 19.7 rechecks schema compatibility and retries that recorded service start without re-opening the migration account. Missing prior service state during an active fence blocks unlock. Repeating 19.7 rechecks the schema and resumes only the remaining recorded services, without re-unlocking accounts or guessing lost prior state. No automatic SQL rollback or broad container restart is used.

## Additional isolated test commands

Working directory: `C:\DEV\CONTROL_CENTER\jkh-cup-v54-release-20261124`.

```powershell
python scripts/test_schema_mysql.py --suite maintenance
python scripts/test_schema_mysql.py --suite schema
python scripts/test_schema_mysql.py --suite profiles
```

The maintenance suite uses two uniquely labelled, internal-network, tmpfs MySQL containers without published ports. The profile suite runs exactly the formerly skipped 207 tests (69 x LOCAL/LAB/PROD simulations); the Python worker shares only the disposable MySQL container's network namespace, so its loopback URL never points at a host database. All three profiles are synthetic. The older schema suite isolates migration logic using an explicit fencing mock; the separate maintenance suite performs real account fencing and end-to-end backup/migration/resume without that mock. No production role/configuration readiness is inferred from these fixtures.


Maintenance validation includes authenticated-user/source-host allowlists, read-only inspection while accounts are locked, legacy acknowledgement rejection, rollback of a killed live transaction, continuous direct writes throughout backup/migration/check, unknown account/client/host rejection, partial DDL failure, loss of the migration connection, SIGKILL of an active tool and SIGKILL during one-use credential admission, repeated admission/resume, lost state, excessive application grants, hidden stored programs and guarded creation of an empty application schema. The original No Name business code is unchanged; all formerly skipped 207 MySQL profile cases pass on synthetic databases.


## Итог проверки maintenance safety — 2026-11-24

Итоговые прогоны: 22/22 интеграционных сценария maintenance на MySQL 8.0.46; 27/27 сценариев схемы/Alembic; 207/207 ранее пропущенных MySQL No Name (69 на каждый локально имитируемый профиль, без SKIP); 79 контрольных сценариев Bash, включая прежние регрессии. Синтаксис: 6 Bash и 9 Python. Прежний журнал 479 backend-тестов с 207 SKIP сохранён как исторический; эти пропуски закрыты отдельным успешным запуском всех трёх MySQL-классов.

Проверены прямые конкурентные записи на протяжении backup/migration/check, остановка открытой транзакции, неизвестные аккаунты/адреса клиентов и служебные сессии, лишние права, недостаточная конфигурация, частичный DDL, потеря соединения, повторные SIGKILL, авария при допуске служебного соединения, повторный запуск и безопасное возобновление. Живая посторонняя служебная сессия не уничтожается: после ограниченного ожидания операция блокируется. Ожидание устраняет гонку завершения TCP после SIGKILL и не разрешает работу при активном постороннем соединении.

После ошибки не разблокировать аккаунты и не удалять maintenance.json вручную. Сохранить состояние, проверить диагностику 19.1, восстановить согласованный план через 19.4, при необходимости получить новый backup с проверкой в новой пустой restore-БД (19.5), затем применить план (19.6). Неизвестное расхождение требует отдельной проверенной Alembic-миграции восстановления. Доступ возвращает только 19.7 после проверки фактической схемы. Бизнес-логика No Name и расчётного движка не изменялась.

Все проверки проведены на одноразовых локальных контейнерах без опубликованных портов и реальных данных. Проверки Docker-оркестрации меню используют изолированные фикстуры; реальные MySQL account locks, транзакции и процессные аварии проверяются отдельным интеграционным набором. VPS LAB и PROD не проверялись и не изменялись. Для этих сред ещё нужны отдельно согласованные DBA provisioning, политика аккаунтов/клиентов/сервисов, безопасная конфигурация Compose и испытания. Файлы и индекс MAIN/основного репозитория сохранены; Commit/Push/Merge не выполнялись.


## Reviewed historical schema compatibility

`schema_contract.json` contains the owner-supplied exact import_batch/import_batch_rows definitions, their columns, nonunique indexes, primary keys and CASCADE relationship. Both tables must be present together or both absent. Additional unknown archive columns/constraints are blockers. The reviewed users.status is VARCHAR(20), nullable, utf8mb4_unicode_ci, DEFAULT active; it is preserved, not moved into the ORM. Runtime AUTO_INCREMENT values are not hardcoded from the historical dump.

The inspector resolves charset, collation, DEFAULT and EXTRA from information_schema. Explicit/inherited UTF8MB4, integer display width and BOOLEAN/TINYINT(1) representations are normalized; actual collation values are retained and checked. Only the named legacy fields accept LONGTEXT, MEDIUMTEXT, LONGBLOB, CHAR(7) or TIMESTAMP alternatives. No text/blob narrowing is performed. The reviewed nullable kv_store.v is compatible only after a SELECT proves zero NULLs; an unavailable check blocks planning. No financial data is filled with zero or any other value. The TIMESTAMP alternative requires a UTC session (or SYSTEM with system_time_zone UTC). The three reviewed ON UPDATE CURRENT_TIMESTAMP clauses are retained. Server literals equivalent to the frozen ORM's literal client defaults are accepted without ALTER or backfill. Other expressions/defaults are blocked.

The 16 reviewed missing nonunique singleton indexes are advisory performance differences, not lost uniqueness. Existing composite indexes are preserved; their leftmost-prefix coverage does not imply coverage of later columns. Missing unique indexes, changed FK columns/targets, new constraints and unreviewed index details block. The four reviewed extra nonunique composite indexes and import_rows.batch_id CASCADE are retained. No indexes are removed or historic tables rebuilt to match the snapshot.

All accepted and unknown physical tables participate in the schema fingerprint, including their full DDL. MySQL's redundant explicit CHARACTER SET next to an utf8mb4 collation is made explicit on both sides when comparing SHOW CREATE. Collation itself is never discarded. Source/restored sequence counters are checked separately.

No new schema revision is required to create the two missing bulk verification tables: cup_5502 already specifies them. If MySQL committed a CREATE TABLE but interrupted before its indexes, the same revision completes only missing frozen bulk indexes. An incompatible existing bulk table remains blocked. Missing bulk indexes at an already recorded cup_5502 remain drift, not a silent repair. After interruption, keep the fence, generate a new protected plan and a new verified backup in a fresh restore DB; never stamp, downgrade automatically or reuse an obsolete receipt.

## Scoped environment for menu 19

The owner can select trusted local environment files with CUP_SCHEMA_DB_ENV_FILE and CUP_SCHEMA_ADMIN_ENV_FILE. The first supplies ENV_TYPE and the five DB_* connection fields; the second supplies the six MAINT_* fields and, for backup, the six RESTORE_* fields. Already assigned shell variables also work: all required names are explicitly exported inside the short-lived tool subshell. Missing values/files or a mismatch between application and Maintenance database identity return BLOCKED without printing values. There are no MIGRATION_* requirements: Maintenance controls the migration account.

File paths are explicit, with no guessed server filenames or fallback database. File loading and export happen before Compose inspection, build and run; service stop/start/config operations use the same scoped preparation. Database values are passed using bare `-e NAME`, never password values in argv. No administrative variables are exported into the persistent menu process or added to the API's Compose service environment. Existing writer policy guards still reject administrative credentials exposed to persistent writer services. Use trusted private environment files outside Git; do not turn on shell tracing. The --build option does not supply a different database configuration.

Local validation commands, from the repository root (only disposable synthetic databases):

```powershell
python scripts/test_schema_mysql.py --suite schema --mysql-image mysql:8.0.45
python scripts/test_schema_mysql.py --suite legacy --mysql-image mysql:8.0.45
$env:CUP_HOST_PYTHON=(Get-Command python).Source
& 'C:\Program Files\Git\bin\bash.exe' scripts/test_server_menu_v5_5.sh
```

The legacy suite includes the real Maintenance concurrency/crash regressions, reviewed historical DDL and synthetic large values, exact backup/restore, interrupted cup_5502 continuation, unknown drift rejection and the unchanged No Name endpoint. These fixtures do not claim to be a complete dump of VPS LAB or authorize any VPS/PROD operation. A previously unknown source difference still blocks safely.


## Verification of historical compatibility fixes — 2026-11-25

Final runs on disposable MySQL 8.0.45: 27/27 schema/Alembic tests and 35/35 real Maintenance/historical-schema tests, with no failures or skips. The latter include source/restored historical data and large values, forbidden NULL data, full DDL fingerprints, table/column collation checks, old-receipt rejection, a real subprocess CLI without MIGRATION variables, partial-DDL completion without duplicate equivalent indexes, and the unchanged No Name handler. Bash fixtures passed 80/80 checkpoints, including scoped environment export, identity rejection, all 0–18 routing/error/lock regressions and submenu routing. Menu Docker orchestration is simulated; actual CLI/MySQL/fencing is tested separately. No VPS/PROD readiness is inferred. MAIN, primary checkout, business code, SQL 001–008 and frozen revisions/snapshot remain unchanged. No Commit or Push was performed.
