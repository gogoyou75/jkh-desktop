# Database migrations

`db.create_all()` must not be used as production migration for import tables.

Apply `001_import_subsystem.sql` with your regular migration/deploy mechanism before enabling payment import endpoints.
If import tables already exist from previous release, also apply `002_import_fingerprint_lock.sql`.

## Canonical payment-ledger store audit

Apply `007_payment_ledger_store_audit.sql` before deploying the payment-ledger store audit.
It creates only the `payment_ledger_store_audit` metadata table; it does not copy,
rewrite, or reconstruct any `payments_<uid>` value.

## Upload blob policy

- Max upload size is controlled by `IMPORT_MAX_UPLOAD_BYTES` (default: `10485760`, 10 MiB).
- Blob retention marker is stored in batch notes (`upload_blob_policy: ttl_days=..., max_bytes=...`).
- TTL is controlled by `IMPORT_UPLOAD_BLOB_TTL_DAYS` (default: `14`).
