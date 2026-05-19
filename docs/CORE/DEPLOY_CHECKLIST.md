# DEPLOY_CHECKLIST

## Backend DB schema checks

После обновления backend и любых изменений backend-моделей БД обязательно сверять фактическую схему MySQL с ожидаемой моделью.

### import_batches audit fields

Перед проверкой импорта платежей выполнить миграцию:

```sql
ALTER TABLE import_batches
ADD COLUMN rows_skipped INT NOT NULL DEFAULT 0,
ADD COLUMN file_name VARCHAR(255) NULL,
ADD COLUMN uploaded_by VARCHAR(255) NULL,
ADD COLUMN error_message TEXT NULL;
```

После обновления backend выполнить:

```sql
DESCRIBE import_batches;
```

В результате должны присутствовать колонки:

- `rows_skipped`
- `file_name`
- `uploaded_by`
- `error_message`


### Stage 9 recalc batch orchestration

После Stage 9 deploy выполнить:

```sql
SHOW TABLES LIKE 'recalc_batch%';
DESCRIBE recalc_batch_jobs;
DESCRIBE recalc_batch_job_items;
```

