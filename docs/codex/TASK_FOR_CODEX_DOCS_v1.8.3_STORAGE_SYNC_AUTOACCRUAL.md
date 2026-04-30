# TASK_FOR_CODEX_DOCS_v1.8.3_STORAGE_SYNC_AUTOACCRUAL

Цель: заменить документацию проекта на v1.8.3 и закрепить канон Storage Sync + Autoaccrual Hardening.

Заменить/добавить файлы из архива `papajkh_logic_spec_v1.8.3_docs_patch.zip` строго по путям.

Обязательные проверки:
```bash
rg -n "STORAGE SYNC \+ AUTOACCRUAL HARDENING v1.8.3|_isUploadAllowedKey|skip-upload-not-allowed" docs CANON_VERSION.md PROMPT_CANON.md README.md UPDATED_FILES.md
```

Ожидаемый результат:
- новый LOGIC_SPEC v1.8.3 присутствует;
- STORAGE_BOUNDARY содержит upload whitelist;
- CRITICAL_CHANGELOG содержит запись 2026-04-30;
- PROMPT_CANON запрещает нарушение storage/autoaccrual правил.

Кодовые файлы в рамках этой задачи не менять.
