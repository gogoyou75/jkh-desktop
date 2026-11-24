# No Name: environment admission

One implementation serves LOCAL_LAB, LAB and PROD. This change does not deploy or enable PROD.

## Server configuration

- NO_NAME_ENABLED accepts exactly 1 (enabled) or 0 (disabled). Other values deny admission.
- When unset: LOCAL_LAB and LAB default to 1; PROD defaults to 0.
- A nonempty DB_PASSWORD and a nondefault, nonempty SECRET_KEY are required.
- LOCAL_LAB retains the existing fixed DB_HOST=mysql, DB_PORT=3306,
  DB_NAME=jkh_local_lab, DB_USER=jkh_local and existing startup checks.
- LAB and PROD additionally require NO_NAME_DB_TARGETS: a JSON object containing both
  LAB and PROD, each with exactly host, port, name, user (nonempty strings).
  Port must be a decimal integer in 1..65535. Values must exactly match DB_HOST,
  DB_PORT, DB_NAME and DB_USER for the current environment.
- LAB, PROD and LOCAL_LAB must have three distinct schema names (case-insensitive),
  even if hosts differ. Missing, malformed, shared or mismatched targets deny admission.
- Existing LAB ALLOWED_DB_HOST startup validation remains in effect.
- The active database is checked with SELECT DATABASE() before new API operations
  and related writes when enabled. /api/env and successful auth responses expose
  only features.no_name, after the same database-name check. No target or credential
  is returned to the browser. Unauthenticated requests and existing write ACLs remain enforced.

NO_NAME_DB_TARGETS format (placeholders, not deployment values):

    {"LAB":{"host":"<verified LAB DB_HOST>","port":"<verified LAB DB_PORT>","name":"<verified LAB DB_NAME>","user":"<verified LAB DB_USER>"},"PROD":{"host":"<verified PROD DB_HOST>","port":"<verified PROD DB_PORT>","name":"<verified PROD DB_NAME>","user":"<verified PROD DB_USER>"}}

Obtain the real identities from the deployment owner; do not copy synthetic test targets.
An allowlist is an operator assertion, not a discovery service. The owner must verify
separate actual databases, credentials/grants and infrastructure. Database aliases
and server identity cannot be established from schema names alone.
Pass the environment variables to the backend process/container using the existing
deployment configuration mechanism. No production compose or secret file is changed here.

## Feature-off behavior and transaction protection

The flag gates deletion previews/status and new mutation routes:
/api/abonent_delete, /api/no_name_assign, /api/closed_responsibility_assign,
/api/no_name_restore_closed_tail, plus automatic No Name creation when closing a period.
The browser hides deletion and blocks No Name/closed-period assignment when capability
is absent. Server checks remain authoritative regardless of browser values.
Ordinary creation, store edits, imports and responsibility transfer retain their existing
handlers. Related writes share the registry row lock in every recognized environment.
CAS, transaction boundaries, rollback, idempotency, financial checks and write ACLs
are unchanged. Existing deletion evidence and No Name history remain protected when
NO_NAME_ENABLED=0, including stale imports and writes to a deleted UID.

## Enabling and disabling PROD (future authorized operation)

1. Validate this exact code on VPS LAB in a separate deployment task.
2. Obtain explicit owner authorization for PROD. Verify backups and the real database
   isolation/allowlist without reusing LAB data or credentials.
3. Supply verified NO_NAME_DB_TARGETS, existing DB_* and SECRET_KEY; keep NO_NAME_ENABLED=0
   during code publication. This does not require changing application source.
4. After authorization set NO_NAME_ENABLED=1 and restart/recreate all backend workers
   through the normal deployment procedure; refresh browser sessions to obtain capability.
5. Confirm /api/env features.no_name and authenticated/write-authorized access. A capability
   indicates configuration/database admission, not user authorization.
6. To stop new operations set NO_NAME_ENABLED=0 and restart/recreate all workers, then
   refresh browsers. Allow in-flight transactions to complete before claiming a full stop.
   Existing history protections remain; disabling is not a data rollback.

Before any real deletion, follow the established backup and approval process. Committed
deletions cannot be undone by toggling the flag or rolling back source code. Do not roll
back to code that ignores stored No Name/deletion evidence.

## Isolated verification

From this repository root:

    python -B -m unittest backend.tests.test_responsibility_mutations backend.tests.test_responsibility_profiles.LocalProfile backend.tests.test_responsibility_profiles.LabProfile backend.tests.test_responsibility_profiles.ProdEnabledProfile
    node scripts/test_no_name_ui.js

SQLite tests create only temporary synthetic databases; DATABASE() simulates the deployment
probe, while handlers/CAS/transactions execute normally. MySQLProfile classes additionally
run the same cases on a disposable MySQL instance when NO_NAME_TEST_MYSQL_URL is supplied.
The fixture accepts only the documented synthetic root credentials on a loopback URL,
creates its own three schemas and drops only those schemas after its tests.
Never supply a deployment database URL. MySQL testing here used a separate mysql:8.4
container with tmpfs storage and a random loopback port; no existing LAB volumes.

Manual UI checks on a separate test deployment: log in with flag off/on, inspect deletion
visibility, try No Name assignment with both debt modes, reject stale versions, verify
ordinary creation/edit/import/transfer when disabled, and recheck deletion-history protection
after disabling. No manual VPS/PROD checks are performed by this local preparation task.
