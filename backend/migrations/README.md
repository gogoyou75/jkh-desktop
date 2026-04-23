# Import subsystem DB migration

`db.create_all()` must not be used as production migration for import tables.

Apply `001_import_subsystem.sql` with your regular migration/deploy mechanism before enabling payment import endpoints.

## Upload blob policy

- Max upload size is controlled by `IMPORT_MAX_UPLOAD_BYTES` (default: `10485760`, 10 MiB).
- Blob retention marker is stored in batch notes (`upload_blob_policy: ttl_days=..., max_bytes=...`).
- TTL is controlled by `IMPORT_UPLOAD_BLOB_TTL_DAYS` (default: `14`).
