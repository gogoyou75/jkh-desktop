import os
import uuid
import secrets
import hashlib
import io
import json
import csv
import re
from decimal import Decimal, InvalidOperation
from datetime import datetime, date

from flask import Flask, jsonify, request, session, Response
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from werkzeug.security import generate_password_hash, check_password_hash
from openpyxl import load_workbook, Workbook

app = Flask(__name__)

DB_USER = os.getenv("DB_USER", "jkh")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_HOST = os.getenv("DB_HOST", "mysql")
DB_PORT = os.getenv("DB_PORT", "3306")
DB_NAME = os.getenv("DB_NAME", "jkh")

app.config["SQLALCHEMY_DATABASE_URI"] = (
    f"mysql+pymysql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}?charset=utf8mb4"
)
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "change-me-please")
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = os.getenv("SESSION_COOKIE_SAMESITE", "Lax")
app.config["SESSION_COOKIE_SECURE"] = os.getenv("SESSION_COOKIE_SECURE", "0") == "1"
app.config["IMPORT_MAX_UPLOAD_BYTES"] = int(os.getenv("IMPORT_MAX_UPLOAD_BYTES", str(10 * 1024 * 1024)))
app.config["IMPORT_UPLOAD_BLOB_TTL_DAYS"] = int(os.getenv("IMPORT_UPLOAD_BLOB_TTL_DAYS", "14"))

db = SQLAlchemy(app)

IMPORT_BATCH_CRITICAL_COLUMNS = (
    "rows_skipped",
    "file_name",
    "uploaded_by",
    "error_message",
)


ABONENT_SUMMARY_DIRTY_REASONS = {
    "PAYMENTS_CHANGED",
    "IMPORT_PAYMENTS_APPLIED",
    "CALC_PERIOD_CHANGED",
    "EXCLUDES_CHANGED",
    "MORATORIUM_CHANGED",
    "RESPONSIBILITY_CHANGED",
    "AUTOACCRUAL_CHANGED",
    "LEDGER_WRITE",
    "UNKNOWN_CHANGE",
}

IMPORT_BATCH_AUDIT_FIELDS_MIGRATION_SQL = (
    "ALTER TABLE import_batches "
    "ADD COLUMN rows_skipped INT NOT NULL DEFAULT 0, "
    "ADD COLUMN file_name VARCHAR(255) NULL, "
    "ADD COLUMN uploaded_by VARCHAR(255) NULL, "
    "ADD COLUMN error_message TEXT NULL;"
)



RECALC_BATCH_ACTIVE_STATUSES = {"queued", "running"}
RECALC_BATCH_FINAL_STATUSES = {"completed", "failed", "stale"}
RECALC_BATCH_RUNNING_TTL_SECONDS = 30 * 60
RECALC_BATCH_MAX_UIDS = 100
RECALC_BATCH_KEEP_PER_OWNER = 20
RECALC_BATCH_RETENTION_DAYS = 7

class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.String(64), primary_key=True)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(32), nullable=False, default="user")
    display_name = db.Column(db.String(255), nullable=False, default="")
    disabled = db.Column(db.Boolean, nullable=False, default=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    last_login = db.Column(db.DateTime, nullable=True)


class KVStore(db.Model):
    __tablename__ = "kv_store"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    owner = db.Column(db.String(128), nullable=False)
    k = db.Column(db.String(255), nullable=False)
    v = db.Column(db.Text, nullable=False)
    updated_at = db.Column(
        db.DateTime,
        server_default=text("CURRENT_TIMESTAMP"),
        onupdate=text("CURRENT_TIMESTAMP"),
    )

    __table_args__ = (db.UniqueConstraint("owner", "k", name="uq_owner_key"),)


class ImportBatch(db.Model):
    __tablename__ = "import_batches"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    owner_id = db.Column(db.String(128), nullable=False, index=True)
    created_by_user_id = db.Column(db.String(64), nullable=False, index=True)

    original_filename = db.Column(db.String(255), nullable=False)
    file_sha256 = db.Column(db.String(64), nullable=False, index=True)
    upload_blob = db.Column(db.LargeBinary, nullable=False)

    display_name = db.Column(db.String(255), nullable=False, default="")
    accounting_year = db.Column(db.String(16), nullable=False, default="")
    version_label = db.Column(db.String(64), nullable=False, default="")
    notes = db.Column(db.Text, nullable=False, default="")

    duplicate_of_batch_id = db.Column(db.Integer, nullable=True)
    supersedes_batch_id = db.Column(db.Integer, nullable=True)
    overlaps_with_batch_id = db.Column(db.Integer, nullable=True)

    is_exact_duplicate = db.Column(db.Boolean, nullable=False, default=False)
    has_period_overlap = db.Column(db.Boolean, nullable=False, default=False)

    rows_total = db.Column(db.Integer, nullable=False, default=0)
    rows_valid = db.Column(db.Integer, nullable=False, default=0)
    rows_invalid = db.Column(db.Integer, nullable=False, default=0)
    rows_duplicate = db.Column(db.Integer, nullable=False, default=0)
    rows_applied = db.Column(db.Integer, nullable=False, default=0)
    rows_skipped = db.Column(db.Integer, nullable=False, default=0)

    file_name = db.Column(db.String(255), nullable=False, default="")
    uploaded_by = db.Column(db.String(64), nullable=False, default="")
    error_message = db.Column(db.Text, nullable=False, default="")

    status = db.Column(db.String(32), nullable=False, default="uploaded", index=True)

    uploaded_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    started_at = db.Column(db.DateTime, nullable=True)
    finished_at = db.Column(db.DateTime, nullable=True)


class ImportBatchRow(db.Model):
    __tablename__ = "import_rows"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    batch_id = db.Column(db.Integer, db.ForeignKey("import_batches.id"), nullable=False, index=True)
    row_no = db.Column(db.Integer, nullable=False)
    excel_sheet_name = db.Column(db.String(255), nullable=False, default="")
    excel_row_ref = db.Column(db.String(64), nullable=False, default="")

    raw_payload_json = db.Column(db.Text, nullable=False, default="{}")
    normalized_payload_json = db.Column(db.Text, nullable=False, default="{}")

    account_uid = db.Column(db.String(128), nullable=False, default="", index=True)
    abonent_id = db.Column(db.String(128), nullable=False, default="")
    account_number = db.Column(db.String(128), nullable=False, default="")

    payment_date = db.Column(db.String(10), nullable=False, default="")
    payment_period = db.Column(db.String(7), nullable=False, default="")
    charge_year = db.Column(db.String(4), nullable=False, default="")
    charge_month = db.Column(db.String(2), nullable=False, default="")
    amount = db.Column(db.String(32), nullable=False, default="")
    paid_date = db.Column(db.String(10), nullable=False, default="")

    source_index = db.Column(db.Integer, nullable=True)
    source_label = db.Column(db.String(255), nullable=False, default="")

    fingerprint = db.Column(db.String(64), nullable=False, default="", index=True)
    matched_payment_id = db.Column(db.String(64), nullable=False, default="")
    applied_at = db.Column(db.DateTime, nullable=True)

    status = db.Column(db.String(32), nullable=False, default="parsed", index=True)
    reason_code = db.Column(db.String(64), nullable=False, default="")
    reason_text = db.Column(db.String(1024), nullable=False, default="")
    error_details_json = db.Column(db.Text, nullable=False, default="{}")


class ImportAppliedFingerprint(db.Model):
    __tablename__ = "import_applied_fingerprints"

    id = db.Column(db.BigInteger, primary_key=True, autoincrement=True)
    owner_id = db.Column(db.String(191), nullable=False, index=True)
    import_type = db.Column(db.String(32), nullable=False, default="payments")
    fingerprint = db.Column(db.String(255), nullable=False)
    account_uid = db.Column(db.String(191), nullable=True)
    account_number = db.Column(db.String(191), nullable=True)
    payment_period = db.Column(db.String(7), nullable=True)
    paid_date = db.Column(db.Date, nullable=True)
    amount = db.Column(db.Numeric(12, 2), nullable=False)
    source_index = db.Column(db.Integer, nullable=False, default=1)
    payment_id = db.Column(db.String(64), nullable=False, default="")
    batch_id = db.Column(db.BigInteger, nullable=True, index=True)
    created_at = db.Column(db.DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))

    __table_args__ = (
        db.UniqueConstraint("owner_id", "import_type", "fingerprint", name="uq_owner_import_fp"),
    )


class PaymentAuditLog(db.Model):
    __tablename__ = "payment_audit_log"

    id = db.Column(db.BigInteger, primary_key=True, autoincrement=True)
    owner_id = db.Column(db.String(128), nullable=False, index=True)
    batch_id = db.Column(db.Integer, nullable=False, index=True)
    row_id = db.Column(db.Integer, nullable=True, index=True)
    action = db.Column(db.String(32), nullable=False)
    status = db.Column(db.String(32), nullable=False)
    details_json = db.Column(db.Text, nullable=False, default="{}")
    created_at = db.Column(db.DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))


class AbonentSummary(db.Model):
    __tablename__ = "abonent_summary"

    id = db.Column(db.BigInteger, primary_key=True, autoincrement=True)
    owner_id = db.Column(db.String(128), nullable=False, index=True)
    abonent_id = db.Column(db.String(128), nullable=False, default="", index=True)
    account_uid = db.Column(db.String(128), nullable=False, default="", index=True)
    account_number = db.Column(db.String(128), nullable=False, default="", index=True)
    summary_json = db.Column(db.Text, nullable=False, default="{}")
    created_at = db.Column(db.DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at = db.Column(
        db.DateTime,
        server_default=text("CURRENT_TIMESTAMP"),
        onupdate=text("CURRENT_TIMESTAMP"),
    )


class RecalcBatchJob(db.Model):
    __tablename__ = "recalc_batch_jobs"
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    owner_id = db.Column(db.String(128), nullable=False, index=True)
    requested_by = db.Column(db.String(64), nullable=False, default="")
    reason = db.Column(db.String(64), nullable=False, default="")
    status = db.Column(db.String(32), nullable=False, default="queued", index=True)
    total_count = db.Column(db.Integer, nullable=False, default=0)
    processed_count = db.Column(db.Integer, nullable=False, default=0)
    fresh_count = db.Column(db.Integer, nullable=False, default=0)
    error_count = db.Column(db.Integer, nullable=False, default=0)
    skipped_count = db.Column(db.Integer, nullable=False, default=0)
    created_at = db.Column(db.DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    started_at = db.Column(db.DateTime, nullable=True)
    finished_at = db.Column(db.DateTime, nullable=True)
    error_message = db.Column(db.Text, nullable=False, default="")


class RecalcBatchJobItem(db.Model):
    __tablename__ = "recalc_batch_job_items"
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    job_id = db.Column(db.Integer, db.ForeignKey("recalc_batch_jobs.id"), nullable=False, index=True)
    owner_id = db.Column(db.String(128), nullable=False, index=True)
    account_uid = db.Column(db.String(128), nullable=False, default="", index=True)
    status = db.Column(db.String(32), nullable=False, default="queued", index=True)
    summary_status = db.Column(db.String(32), nullable=False, default="")
    summary_reason = db.Column(db.String(128), nullable=False, default="")
    started_at = db.Column(db.DateTime, nullable=True)
    finished_at = db.Column(db.DateTime, nullable=True)
    error_message = db.Column(db.Text, nullable=False, default="")


def _json_error(error: str, code: int):
    return jsonify(ok=False, error=error), code


def _parse_pagination_args(default_per_page: int = 50, max_per_page: int = 200):
    try:
        page = int(request.args.get("page", "1"))
    except (TypeError, ValueError):
        page = 1
    try:
        per_page = int(request.args.get("per_page", request.args.get("limit", str(default_per_page))))
    except (TypeError, ValueError):
        per_page = default_per_page

    page = max(1, page)
    per_page = max(1, min(max_per_page, per_page))
    return page, per_page


def _pagination_payload(page: int, per_page: int, total: int):
    pages = (total + per_page - 1) // per_page if per_page else 0
    return {
        "page": page,
        "per_page": per_page,
        "total": total,
        "pages": pages,
        "has_next": page < pages,
        "has_prev": page > 1,
    }


def _abonent_summary_payload(row: AbonentSummary):
    try:
        summary = json.loads(row.summary_json or "{}")
    except (TypeError, ValueError):
        summary = {}

    return {
        "id": row.id,
        "owner_id": row.owner_id,
        "abonent_id": row.abonent_id or "",
        "account_uid": row.account_uid or "",
        "account_number": row.account_number or "",
        "summary": summary,
        "created_at": row.created_at.isoformat() + "Z" if row.created_at else None,
        "updated_at": row.updated_at.isoformat() + "Z" if row.updated_at else None,
    }


def _normalize_email(value: str) -> str:
    return str(value or "").strip().lower()


def _user_payload(user: User):
    return {
        "id": user.id,
        "email": user.email,
        "role": user.role,
        "displayName": user.display_name or "",
        "disabled": bool(user.disabled),
        "createdAt": int(user.created_at.timestamp() * 1000) if user.created_at else 0,
        "lastLogin": int(user.last_login.timestamp() * 1000) if user.last_login else 0,
    }


def _current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    user = User.query.filter_by(id=user_id).first()
    if not user or user.disabled:
        session.clear()
        return None
    return user


def _require_user():
    user = _current_user()
    if not user:
        return None, _json_error("not_authenticated", 401)
    return user, None


def _require_admin():
    user, err = _require_user()
    if err:
        return None, err
    if user.role != "admin":
        return None, _json_error("forbidden", 403)
    return user, None


def _resolve_owner(explicit_owner: str | None = None, allow_admin_override: bool = False):
    user, err = _require_user()
    if err:
        return None, err
    wanted = str(explicit_owner or "").strip()
    if allow_admin_override and user.role == "admin" and wanted:
        return wanted, None
    return user.id, None


def _sync_log(action: str, owner: str, **extra):
    parts = [f"action={action}", f"owner={owner}"]
    for k, v in extra.items():
        parts.append(f"{k}={v}")
    app.logger.info("[JKH sync] %s", " ".join(parts))


GLOBAL_OWNER = "GLOBAL"
GLOBAL_KEYS = {
    "refinancing_rates_normal_v1",
    "refinancing_rates_moratorium_v1",
}

PROTECTED_OWNER_LEVEL_KEYS = {
    "tariffs_dynamic_v1",  # legacy read-only / migration only / excluded from upload
    "tariffs_content_repair_v1",  # legacy read-only / migration only / excluded from upload
    "tariffs_content_repair_v1_backup",  # legacy read-only / migration only / excluded from upload
}
PROTECTED_OWNER_LEVEL_PREFIXES = (
    "tariffs_",
    "ref_rates_",
)

IMPORT_BATCH_STATUSES = {
    "uploaded",
    "parsed",
    "validated",
    "ready_to_apply",
    "applying",
    "applied",
    "failed",
    "cancelled",
}

ROW_STATUSES = {
    "parsed",
    "validated",
    "invalid",
    "duplicate",
    "conflict",
    "ready",
    "applied",
    "skipped",
    "failed",
}

IMPORT_ALLOWED_TRANSITIONS = {
    "parse": {"uploaded", "failed"},
    "validate": {"parsed", "validated"},
    "apply": {"ready_to_apply"},
}

IMPORT_REQUIRED_COLUMNS = {"account_uid", "account_number", "payment_date", "payment_period", "amount", "source_index"}

HEADER_ALIASES = {
    "account_uid": {"account_uid", "uid", "уид", "лс uid", "лицевой uid"},
    "abonent_id": {"abonent_id", "абонент", "abonent"},
    "account_number": {"account_number", "лицевой счет", "лицевой счёт", "лс", "лицевой_счет"},
    "payment_date": {"payment_date", "paid_date", "дата", "дата платежа", "дата оплаты"},
    "payment_period": {"payment_period", "period", "период", "расчетный период", "месяц"},
    "amount": {"amount", "sum", "сумма", "сумма оплаты", "оплата"},
    "source_index": {"source_index", "source", "источник", "источник платежа", "индекс источника"},
}


def _is_protected_owner_level_key(base_key: str) -> bool:
    k = str(base_key or "").strip()
    if not k:
        return False
    if k in PROTECTED_OWNER_LEVEL_KEYS:
        return True
    return any(k.startswith(pref) for pref in PROTECTED_OWNER_LEVEL_PREFIXES)


def _effective_owner_for_key(owner: str, base_key: str) -> str:
    key = str(base_key or "").strip()
    if key in GLOBAL_KEYS:
        return GLOBAL_OWNER
    return owner


def _check_store_write_access(user: User, owner: str, base_key: str):
    key = str(base_key or "").strip()
    target_owner = str(owner or "").strip()

    if key in GLOBAL_KEYS and user.role != "admin":
        return False, "global_admin_only"

    if _is_protected_owner_level_key(key):
        if key.startswith("tariffs_") and user.role == "user":
            expected_key = f"tariffs_{target_owner}"
            if target_owner == user.id and key == expected_key:
                return True, "ok"
            return False, "tariffs_owner_mismatch"
        if user.role != "admin":
            return False, "protected_key_admin_only"

    return True, "ok"


def _require_write_access_for_key(owner: str, base_key: str):
    user, err = _require_user()
    if err:
        return err, None
    allowed, reason = _check_store_write_access(user, owner, base_key)
    if not allowed:
        if reason == "global_admin_only":
            return _json_error("global_admin_only", 403), reason
        return _json_error("forbidden", 403), reason
    return None, None


def _log_store_forbidden(user: User | None, owner: str, key: str, reason: str):
    app.logger.warning(
        "[store][forbidden] user_id=%s role=%s owner=%s key=%s reason=%s",
        getattr(user, "id", ""),
        getattr(user, "role", ""),
        owner,
        key,
        reason,
    )
    return None


def _norm_text(v):
    return str(v or "").strip()


def _norm_amount(v):
    if v is None:
        return None
    if isinstance(v, (int, float, Decimal)):
        try:
            return str(Decimal(str(v)).quantize(Decimal("0.01")))
        except InvalidOperation:
            return None
    s = _norm_text(v).replace(" ", "").replace(",", ".")
    if not s:
        return None
    try:
        return str(Decimal(s).quantize(Decimal("0.01")))
    except InvalidOperation:
        return None


def _norm_date(v):
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    s = _norm_text(v)
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _norm_iso_date(v):
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    s = _norm_text(v)
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d").date().isoformat()
    except ValueError:
        return None


def _norm_period(v):
    s = _norm_text(v)
    if not s:
        return None
    m = re.match(r"^(\d{4})[-./](\d{1,2})$", s)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}"
    m = re.match(r"^(\d{1,2})[-./](\d{4})$", s)
    if m:
        return f"{m.group(2)}-{int(m.group(1)):02d}"
    return None


def _norm_upload_payment_period(v):
    s = _norm_text(v)
    if not s:
        return None
    m = re.match(r"^(\d{4})-(\d{2})$", s)
    if not m:
        return None
    month = int(m.group(2))
    if month < 1 or month > 12:
        return None
    return s


def _raw_upload_payment_period_present(row):
    try:
        payload = json.loads(row.raw_payload_json or "{}")
    except Exception:
        payload = {}
    if isinstance(payload, dict) and "payment_period" in payload:
        return _norm_text(payload.get("payment_period")) != ""
    return False


def normalize_paid_date(v):
    value = _norm_date(v)
    if not value:
        raise ValueError("paid_date_invalid")
    return value


def normalize_payment_period(v):
    value = _norm_period(v)
    if not value:
        raise ValueError("payment_period_invalid")
    return value


def normalize_amount(v):
    value = _norm_amount(v)
    if not value:
        raise ValueError("amount_invalid")
    return value


def normalize_source_index(v):
    if v is None or _norm_text(v) == "":
        raise ValueError("source_index_required")
    try:
        idx = int(v)
    except Exception as ex:
        raise ValueError("source_index_invalid") from ex
    if idx < 1:
        raise ValueError("source_index_invalid")
    return idx


def normalize_account_number(v):
    value = _norm_text(v)
    if not value:
        raise ValueError("account_number_required")
    return value


def normalize_uid(v):
    value = _norm_text(v)
    if not value:
        raise ValueError("account_uid_required")
    return value


def to_ledger_paid_date(paid_date_iso: str) -> str:
    d = datetime.strptime(paid_date_iso, "%Y-%m-%d").date()
    return d.strftime("%d.%m.%Y")


def payment_fingerprint(account_uid, paid_date, amount, source_index):
    uid_norm = normalize_uid(account_uid)
    paid_date_norm = normalize_paid_date(paid_date)
    amount_norm = normalize_amount(amount)
    source_index_norm = normalize_source_index(source_index)
    raw = "|".join([
        uid_norm,
        paid_date_norm,
        amount_norm,
        str(source_index_norm),
    ])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def build_payment_fingerprint(owner_id, account_uid, account_number, paid_date, amount, source_index, payment_period):
    return payment_fingerprint(account_uid, paid_date, amount, source_index)



class LedgerJsonInvalidError(ValueError):
    pass


def _load_existing_payment_ledger_or_raise(kv):
    if not kv:
        return []
    raw = kv.v
    try:
        ledger = json.loads(raw)
    except Exception as exc:
        raise LedgerJsonInvalidError("LEDGER_JSON_INVALID") from exc
    if not isinstance(ledger, list):
        raise LedgerJsonInvalidError("LEDGER_JSON_INVALID")
    return ledger

def _classify_payment(account_uid, paid_date, amount, ledger_items):
    paid_date_norm = normalize_paid_date(paid_date)
    amount_norm = normalize_amount(amount)
    account_uid_norm = normalize_uid(account_uid)
    for item in ledger_items:
        item_date = _norm_date(item.get("paid_date"))
        if not item_date:
            continue
        if item_date != paid_date_norm:
            continue

        item_uid = _norm_text(item.get("uid"))
        if item_uid and item_uid != account_uid_norm:
            continue

        item_amount = _norm_amount(item.get("paid"))
        if item_amount == amount_norm:
            return "DUPLICATE"
        return "CONFLICT"
    return "NEW_PAYMENT"


def _classify_import_payment(account_uid, paid_date, amount, fingerprint, ledger_items):
    paid_date_norm = normalize_paid_date(paid_date)
    amount_norm = normalize_amount(amount)
    account_uid_norm = normalize_uid(account_uid)
    fingerprint_norm = _norm_text(fingerprint)
    for item in ledger_items:
        item_date = _norm_date(item.get("paid_date"))
        if not item_date or item_date != paid_date_norm:
            continue

        item_uid = _norm_text(item.get("uid"))
        if item_uid and item_uid != account_uid_norm:
            continue

        item_amount = _norm_amount(item.get("paid"))
        if item_amount is None:
            continue
        if item_amount == amount_norm:
            item_fingerprint = _norm_text(item.get("fingerprint"))
            if item_fingerprint:
                if item_fingerprint == fingerprint_norm:
                    return "DUPLICATE"
                continue
            return "DUPLICATE"
        return "CONFLICT"
    return "NEW_PAYMENT"


def _extract_year_month(period):
    if not period:
        return "", ""
    yy, mm = period.split("-", 1)
    return yy, mm


def _batch_payload(batch: ImportBatch):
    return {
        "id": batch.id,
        "owner_id": batch.owner_id,
        "created_by_user_id": batch.created_by_user_id,
        "display_name": batch.display_name,
        "original_filename": batch.original_filename,
        "accounting_year": batch.accounting_year,
        "version_label": batch.version_label,
        "notes": batch.notes,
        "status": batch.status,
        "is_exact_duplicate": bool(batch.is_exact_duplicate),
        "has_period_overlap": bool(batch.has_period_overlap),
        "rows_total": batch.rows_total,
        "rows_valid": batch.rows_valid,
        "rows_invalid": batch.rows_invalid,
        "rows_duplicate": batch.rows_duplicate,
        "rows_applied": batch.rows_applied,
        "rows_skipped": batch.rows_skipped,
        "file_name": batch.file_name,
        "uploaded_by": batch.uploaded_by,
        "error_message": batch.error_message,
        "uploaded_at": int(batch.uploaded_at.timestamp() * 1000) if batch.uploaded_at else 0,
    }


def _row_payload(r: ImportBatchRow):
    return {
        "id": r.id,
        "batch_id": r.batch_id,
        "row_no": r.row_no,
        "excel_sheet_name": r.excel_sheet_name,
        "excel_row_ref": r.excel_row_ref,
        "raw_payload_json": json.loads(r.raw_payload_json or "{}"),
        "normalized_payload_json": json.loads(r.normalized_payload_json or "{}"),
        "account_uid": r.account_uid,
        "abonent_id": r.abonent_id,
        "account_number": r.account_number,
        "payment_date": r.payment_date,
        "paid_date": r.paid_date,
        "payment_period": r.payment_period,
        "charge_year": r.charge_year,
        "charge_month": r.charge_month,
        "amount": r.amount,
        "source_index": r.source_index,
        "source_label": r.source_label,
        "fingerprint": r.fingerprint,
        "matched_payment_id": r.matched_payment_id,
        "applied_at": int(r.applied_at.timestamp() * 1000) if r.applied_at else 0,
        "status": r.status,
        "reason_code": r.reason_code,
        "reason_text": r.reason_text,
        "error_details_json": json.loads(r.error_details_json or "{}"),
    }


def _find_cell(header_map, row_values, *keys):
    for k in keys:
        if k in header_map:
            return row_values[header_map[k]] if header_map[k] < len(row_values) else None
    return None


def _parse_header_map(values):
    out = {}
    for i, v in enumerate(values):
        key = _norm_text(v).lower()
        if not key:
            continue
        normalized = re.sub(r"[^\wа-яА-ЯёЁ]+", " ", key, flags=re.UNICODE)
        normalized = re.sub(r"\s+", " ", normalized).strip()
        for canonical, aliases in HEADER_ALIASES.items():
            if normalized in aliases:
                out[canonical] = i
                break
        if normalized not in out:
            out[normalized] = i
    return out


def _parse_strict_header_map(values):
    out = {}
    for i, v in enumerate(values):
        key = _norm_text(v).lower()
        if not key:
            continue
        normalized = re.sub(r"[^\wа-яА-ЯёЁ]+", "_", key, flags=re.UNICODE)
        normalized = re.sub(r"_+", "_", normalized).strip("_")
        if normalized in IMPORT_REQUIRED_COLUMNS:
            out[normalized] = i
    return out


def _ensure_batch_transition(batch: ImportBatch, operation: str):
    allowed = IMPORT_ALLOWED_TRANSITIONS.get(operation, set())
    if batch.status not in allowed:
        return jsonify(
            ok=False,
            error="state_transition_forbidden",
            details={
                "operation": operation,
                "from_status": batch.status,
                "allowed_from": sorted(allowed),
            },
        ), 409
    return None


def _load_owner_sources(owner_id: str):
    row = KVStore.query.filter_by(owner=owner_id, k="payment_sources_v1").first()
    if not row or not row.v:
        return {}
    try:
        arr = json.loads(row.v)
    except Exception:
        return {}
    if not isinstance(arr, list):
        return {}
    out = {}
    for i, label in enumerate(arr, start=1):
        clean = _norm_text(label)
        if clean:
            out[i] = clean
    return out


def _extract_abonents_values(obj):
    if not isinstance(obj, dict):
        return []
    nested = obj.get("abonents")
    if isinstance(nested, dict):
        return nested.values()
    return obj.values()


def _extract_abonents_items(obj):
    if not isinstance(obj, dict):
        return []
    nested = obj.get("abonents")
    if isinstance(nested, dict):
        return list(nested.items())
    return list(obj.items())


def _find_owner_accounts(owner_id: str, account_uid: str, account_number: str):
    uid_norm = _norm_text(account_uid).lower()
    ls_norm = _norm_text(account_number)
    if not uid_norm:
        return {"matches": [], "uid_found": False}

    uid_hits = []
    matches = []
    for key in ("abonents_db_v1", "abonents_v1"):
        row = KVStore.query.filter_by(owner=owner_id, k=key).first()
        if not row or not row.v:
            continue
        try:
            obj = json.loads(row.v)
        except Exception:
            continue

        for ls_key, abonent in _extract_abonents_items(obj):
            if not isinstance(abonent, dict):
                continue
            candidate_uid = _norm_text(abonent.get("uid")).lower()
            if candidate_uid != uid_norm:
                continue
            uid_hits.append(abonent)
            key_ls = _norm_text(ls_key)
            fallback_ls = _norm_text(abonent.get("id"))
            if ls_norm and key_ls and key_ls == ls_norm:
                matches.append(abonent)
                continue
            if ls_norm and fallback_ls and fallback_ls == ls_norm:
                matches.append(abonent)
                continue
            if ls_norm:
                continue
            matches.append(abonent)

        if uid_hits:
            break

    return {"matches": matches, "uid_found": bool(uid_hits)}



def _summary_identity_value(abonent: dict, keys, fallback: str = ""):
    if not isinstance(abonent, dict):
        return fallback
    for key in keys:
        value = _norm_text(abonent.get(key))
        if value:
            return value
    return fallback




def _owner_abonents_db_v1_summary_targets(owner_id: str):
    targets = []
    seen_uids = set()

    row = KVStore.query.filter_by(owner=owner_id, k="abonents_db_v1").first()
    if not row or not row.v:
        return targets

    try:
        obj = json.loads(row.v)
    except Exception:
        return targets

    for ls_key, abonent in _extract_abonents_items(obj):
        if not isinstance(abonent, dict):
            continue
        account_uid = _norm_text(abonent.get("uid"))
        if not account_uid or account_uid in seen_uids:
            continue
        seen_uids.add(account_uid)

        key_account_number = _norm_text(ls_key)
        account_number = _summary_identity_value(
            abonent,
            ("account_number", "accountNumber", "ls", "id"),
            key_account_number,
        )
        abonent_id = _summary_identity_value(
            abonent,
            ("abonent_id", "abonentId", "id"),
            key_account_number or account_number,
        )

        targets.append({
            "abonent_id": abonent_id,
            "account_uid": account_uid,
            "account_number": account_number,
            "identity": {
                "abonent_id": abonent_id,
                "account_uid": account_uid,
                "account_number": account_number,
                "fio": _summary_identity_value(abonent, ("fio", "fullName", "full_name")),
                "address": _summary_identity_value(abonent, ("address", "addr")),
            },
        })

    return targets


def _dirty_abonent_summary_payload(existing_summary: dict | None, reason: str):
    payload = existing_summary.copy() if isinstance(existing_summary, dict) else {}
    for key in (
        "totals",
        "total",
        "total_debt",
        "total_penalty",
        "total_accrued",
        "total_paid",
        "total_principal",
        "debt",
        "penalty",
        "principal",
    ):
        payload.pop(key, None)
    payload.update({
        "summary_status": "dirty",
        "summary_reason": reason,
        "status": "dirty",
        "reason": reason,
        "dirty_at": datetime.utcnow().isoformat() + "Z",
    })
    if "period" not in payload or not isinstance(payload.get("period"), dict):
        payload["period"] = {"from": None, "to": None}
    return payload

def _owner_abonent_summary_targets(owner_id: str):
    targets = []
    seen_uids = set()

    for key in ("abonents_db_v1", "abonents_v1"):
        row = KVStore.query.filter_by(owner=owner_id, k=key).first()
        if not row or not row.v:
            continue
        try:
            obj = json.loads(row.v)
        except Exception:
            continue

        for ls_key, abonent in _extract_abonents_items(obj):
            if not isinstance(abonent, dict):
                continue
            account_uid = _norm_text(abonent.get("uid"))
            if not account_uid or account_uid in seen_uids:
                continue
            seen_uids.add(account_uid)

            key_account_number = _norm_text(ls_key)
            account_number = _summary_identity_value(
                abonent,
                ("account_number", "accountNumber", "ls", "id"),
                key_account_number,
            )
            abonent_id = _summary_identity_value(
                abonent,
                ("abonent_id", "abonentId", "id"),
                key_account_number or account_number,
            )

            targets.append({
                "abonent_id": abonent_id,
                "account_uid": account_uid,
                "account_number": account_number,
                "identity": {
                    "abonent_id": abonent_id,
                    "account_uid": account_uid,
                    "account_number": account_number,
                    "fio": _summary_identity_value(abonent, ("fio", "fullName", "full_name")),
                    "address": _summary_identity_value(abonent, ("address", "addr")),
                },
            })

        if targets:
            break

    return targets


def _build_missing_abonent_summary(target: dict):
    identity = target.get("identity") if isinstance(target.get("identity"), dict) else {}
    return {
        "status": "missing",
        "reason": "SUMMARY_NOT_BUILT",
        "summary_status": "missing",
        "summary_reason": "SUMMARY_NOT_BUILT",
        "abonent": {
            "abonent_id": _norm_text(identity.get("abonent_id") or target.get("abonent_id")),
            "account_uid": _norm_text(identity.get("account_uid") or target.get("account_uid")),
            "account_number": _norm_text(identity.get("account_number") or target.get("account_number")),
            "fio": _norm_text(identity.get("fio")),
            "address": _norm_text(identity.get("address")),
        },
        "period": {
            "from": None,
            "to": None,
        },
    }

def _summary_status_from_payload(summary: dict | None):
    if not isinstance(summary, dict):
        return "missing"
    status = _norm_text(summary.get("summary_status") or summary.get("status")).lower()
    if status in {"fresh", "dirty", "missing", "error"}:
        return status
    return "missing"


def _summary_without_stale_totals(summary: dict | None):
    payload = summary.copy() if isinstance(summary, dict) else {}
    status = _summary_status_from_payload(payload)
    payload["summary_status"] = status
    payload["status"] = status
    if status != "fresh":
        for key in (
            "totals",
            "total",
            "total_debt",
            "total_penalty",
            "total_accrued",
            "total_paid",
            "total_principal",
            "debt",
            "penalty",
            "principal",
            "nachisleno",
            "oplacheno",
            "accrued",
            "paid",
            "accrued_total",
            "paid_total",
            "accruedTotal",
            "paidTotal",
        ):
            payload.pop(key, None)
    return payload


def _summary_from_row_or_missing(row: AbonentSummary | None, target: dict):
    if not row:
        return _build_missing_abonent_summary(target)
    try:
        summary = json.loads(row.summary_json or "{}")
    except (TypeError, ValueError):
        summary = {"summary_status": "error", "summary_reason": "SUMMARY_JSON_INVALID"}
    return _summary_without_stale_totals(summary)


def _batch_job_payload(job: RecalcBatchJob):
    status = _norm_text(job.status) or "queued"
    done = int(job.processed_count or 0)
    total = int(job.total_count or 0)
    errors = int(job.error_count or 0) + int(job.skipped_count or 0)
    return {
        "id": int(job.id),
        "status": status,
        "reason": _norm_text(job.reason),
        "total_count": total,
        "processed_count": done,
        "fresh_count": int(job.fresh_count or 0),
        "error_count": int(job.error_count or 0),
        "skipped_count": int(job.skipped_count or 0),
        "started_at": job.started_at.isoformat() + "Z" if job.started_at else None,
        "finished_at": job.finished_at.isoformat() + "Z" if job.finished_at else None,
        "total": total,
        "done": done,
        "errors": errors,
    }


def _recalc_normalize_uids(raw_uids):
    out = []
    seen = set()
    for value in (raw_uids or []):
        uid = _norm_text(value)
        if not uid or uid in seen:
            continue
        seen.add(uid)
        out.append(uid)
    out.sort()
    return out


def _recalc_job_fingerprint(owner_id: str, reason: str, normalized_uids):
    raw = "|".join([_norm_text(owner_id), _norm_text(reason) or "MANUAL_RECALC", ",".join(normalized_uids)])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _recalc_recover_stale_running_jobs(owner_id: str):
    now = datetime.utcnow()
    jobs = RecalcBatchJob.query.filter_by(owner_id=owner_id).filter(RecalcBatchJob.status.in_(["queued", "running"])).all()
    for job in jobs:
        anchor = job.started_at or job.created_at
        if not anchor:
            continue
        age = (now - anchor).total_seconds()
        if age <= RECALC_BATCH_RUNNING_TTL_SECONDS:
            continue
        job.status = "stale"
        job.error_message = "STALE_RUNNING_RECOVERED"
        job.finished_at = now
    db.session.flush()


def _recalc_cleanup_old_jobs(owner_id: str):
    now = datetime.utcnow()
    threshold = now.timestamp() - (RECALC_BATCH_RETENTION_DAYS * 86400)
    final_jobs = RecalcBatchJob.query.filter_by(owner_id=owner_id).filter(RecalcBatchJob.status.in_(["completed", "failed", "stale"])).order_by(RecalcBatchJob.id.desc()).all()
    keep_ids = set(j.id for j in final_jobs[:RECALC_BATCH_KEEP_PER_OWNER])
    for job in final_jobs[RECALC_BATCH_KEEP_PER_OWNER:]:
        finished_ts = (job.finished_at or job.created_at)
        should_delete = True
        if finished_ts:
            should_delete = finished_ts.timestamp() < threshold
        if not should_delete:
            continue
        db.session.query(RecalcBatchJobItem).filter_by(job_id=job.id, owner_id=owner_id).delete()
        db.session.delete(job)


def _recalc_batch_create_job(owner_id: str, user_id: str, raw_uids, reason: str):
    requested = _recalc_normalize_uids(raw_uids)
    if not requested:
        return None, {"requested": 0, "accepted": 0, "skipped": 0}
    if len(requested) > RECALC_BATCH_MAX_UIDS:
        return "TOO_MANY_UIDS", {"max_uids": RECALC_BATCH_MAX_UIDS, "requested": len(requested)}
    reason_norm = _norm_text(reason) or "MANUAL_RECALC"

    _recalc_recover_stale_running_jobs(owner_id)

    fp = _recalc_job_fingerprint(owner_id, reason_norm, requested)
    active_jobs = RecalcBatchJob.query.filter_by(owner_id=owner_id, reason=reason_norm).filter(RecalcBatchJob.status.in_(["queued", "running"])).order_by(RecalcBatchJob.id.desc()).all()
    for active_job in active_jobs:
        item_uids = [
            _norm_text(x.account_uid)
            for x in RecalcBatchJobItem.query.filter_by(job_id=active_job.id, owner_id=owner_id).all()
            if _norm_text(x.account_uid)
        ]
        if _recalc_job_fingerprint(owner_id, reason_norm, sorted(set(item_uids))) == fp:
            db.session.commit()
            return active_job, {"requested": len(requested), "accepted": int(active_job.total_count or 0), "skipped": int(active_job.skipped_count or 0)}

    targets = _owner_abonent_summary_targets(owner_id)
    targets_by_uid = {_norm_text(t.get("account_uid")): t for t in targets if _norm_text(t.get("account_uid"))}
    accepted = [uid for uid in requested if uid in targets_by_uid]
    skipped = len(requested) - len(accepted)
    job = RecalcBatchJob(owner_id=owner_id, requested_by=user_id, reason=reason_norm, status="queued", total_count=len(accepted), skipped_count=skipped)
    db.session.add(job)
    db.session.flush()
    for uid in accepted:
        db.session.add(RecalcBatchJobItem(job_id=job.id, owner_id=owner_id, account_uid=uid, status="queued"))

    _recalc_cleanup_old_jobs(owner_id)
    db.session.commit()
    return job, {"requested": len(requested), "accepted": len(accepted), "skipped": skipped}



def _parse_summary_status_filter(raw_value: str):
    raw = _norm_text(raw_value).lower()
    if not raw:
        return None
    parts = [x.strip() for x in re.split(r"[,\s]+", raw) if x.strip()]
    statuses = set()
    for part in parts:
        if part in {"stale", "устаревшие", "устаревший"}:
            statuses.update({"dirty", "missing", "error"})
        elif part in {"fresh", "dirty", "missing", "error"}:
            statuses.add(part)
    return statuses if statuses else None


def _target_matches_abonent_query(target: dict, query_text: str):
    q = _norm_text(query_text).lower()
    if not q:
        return True
    identity = target.get("identity") if isinstance(target.get("identity"), dict) else {}
    values = [
        target.get("abonent_id"),
        target.get("account_uid"),
        target.get("account_number"),
        identity.get("fio"),
        identity.get("address"),
    ]
    haystack = " ".join(_norm_text(value).lower() for value in values)
    tokens = [x for x in re.split(r"\s+", q) if x]
    return all(token in haystack for token in tokens)


def _abonent_index_payload(target: dict, summary: dict):
    identity = target.get("identity") if isinstance(target.get("identity"), dict) else {}
    summary_payload = _summary_without_stale_totals(summary)
    if "abonent" not in summary_payload or not isinstance(summary_payload.get("abonent"), dict):
        summary_payload["abonent"] = {
            "abonent_id": _norm_text(identity.get("abonent_id") or target.get("abonent_id")),
            "account_uid": _norm_text(identity.get("account_uid") or target.get("account_uid")),
            "account_number": _norm_text(identity.get("account_number") or target.get("account_number")),
            "fio": _norm_text(identity.get("fio")),
            "address": _norm_text(identity.get("address")),
        }
    if not _norm_text(summary_payload.get("fio")) and _norm_text(identity.get("fio")):
        summary_payload["fio"] = _norm_text(identity.get("fio"))
    if not _norm_text(summary_payload.get("address")) and _norm_text(identity.get("address")):
        summary_payload["address"] = _norm_text(identity.get("address"))
    return {
        "abonent_id": _norm_text(target.get("abonent_id")),
        "account_uid": _norm_text(target.get("account_uid")),
        "account_number": _norm_text(target.get("account_number")),
        "summary_status": _summary_status_from_payload(summary_payload),
        "summary": summary_payload,
    }


def _row_human_error_payload(r: ImportBatchRow):
    return {
        "excel_row_ref": r.excel_row_ref,
        "excel_sheet_name": r.excel_sheet_name,
        "account_uid": r.account_uid,
        "account_number": r.account_number,
        "payment_date": r.payment_date,
        "payment_period": r.payment_period,
        "amount": r.amount,
        "source_index": r.source_index,
        "source_label": r.source_label,
        "reason_code": r.reason_code,
        "reason_text": r.reason_text,
        "recommendation": json.loads(r.error_details_json or "{}").get("recommendation", ""),
    }


def _import_batches_schema_status():
    try:
        rows = db.session.execute(text("DESCRIBE import_batches")).all()
    except SQLAlchemyError as exc:
        db.session.rollback()
        app.logger.error(
            "Import DB schema check failed for import_batches. Run initdb/migrations before import. error=%s",
            exc,
        )
        return {
            "ok": False,
            "error": "import_batches_schema_check_failed",
            "missing_columns": list(IMPORT_BATCH_CRITICAL_COLUMNS),
            "migration_sql": IMPORT_BATCH_AUDIT_FIELDS_MIGRATION_SQL,
        }

    existing = {row[0] for row in rows}
    missing = [col for col in IMPORT_BATCH_CRITICAL_COLUMNS if col not in existing]
    if missing:
        app.logger.error(
            "Import DB schema mismatch: import_batches is missing critical columns %s. Required migration: %s",
            ", ".join(missing),
            IMPORT_BATCH_AUDIT_FIELDS_MIGRATION_SQL,
        )
    return {
        "ok": not missing,
        "error": "import_batches_missing_columns" if missing else "",
        "missing_columns": missing,
        "migration_sql": IMPORT_BATCH_AUDIT_FIELDS_MIGRATION_SQL if missing else "",
    }


def _import_schema_error_response():
    schema = _import_batches_schema_status()
    if schema["ok"]:
        return None
    return jsonify(
        ok=False,
        error=schema["error"],
        details={
            "table": "import_batches",
            "missing_columns": schema["missing_columns"],
            "migration_sql": schema["migration_sql"],
        },
    ), 503


@app.before_request
def _guard_import_batches_schema():
    if request.path.startswith("/api/import"):
        return _import_schema_error_response()
    return None


@app.get("/health")
def health():
    schema = _import_batches_schema_status()
    status = "ok" if schema["ok"] else "degraded"
    code = 200 if schema["ok"] else 503
    return jsonify(
        status=status,
        checks={
            "import_batches_schema": {
                "ok": schema["ok"],
                "missing_columns": schema["missing_columns"],
            },
        },
    ), code


@app.get("/")
def index():
    return "JKH API: ok\n"


@app.post("/api/admin/initdb")
def initdb():
    db.create_all()
    return jsonify(ok=True, message="users + kv_store ready")


@app.get("/api/abonents")
def abonents_index_list():
    # CRITICAL GUARD: lightweight index endpoint is a read-only list transport.
    # Owner is always taken from session; never trust owner/query owner from client.
    # Do not read payments_<uid>, do not run recalculation, and do not expose stale totals.
    user, err = _require_user()
    if err:
        return err

    owner = user.id
    page, per_page = _parse_pagination_args()
    query_text = request.args.get("query", "")
    status_filter = _parse_summary_status_filter(
        request.args.get("summary_status") or request.args.get("status") or ""
    )

    targets = [t for t in _owner_abonent_summary_targets(owner) if _target_matches_abonent_query(t, query_text)]
    start = (page - 1) * per_page

    def load_summaries_by_uid(page_targets):
        uids = [_norm_text(t.get("account_uid")) for t in page_targets if _norm_text(t.get("account_uid"))]
        if not uids:
            return {}
        summary_rows = (
            AbonentSummary.query
            .filter_by(owner_id=owner)
            .filter(AbonentSummary.account_uid.in_(uids))
            .order_by(AbonentSummary.updated_at.desc(), AbonentSummary.id.desc())
            .all()
        )
        summaries = {}
        for row in summary_rows:
            uid = _norm_text(row.account_uid)
            if uid and uid not in summaries:
                summaries[uid] = row
        return summaries

    if status_filter is None:
        total = len(targets)
        page_targets = targets[start:start + per_page]
        summaries_by_uid = load_summaries_by_uid(page_targets)
        page_pairs = [
            (target, _summary_from_row_or_missing(summaries_by_uid.get(_norm_text(target.get("account_uid"))), target))
            for target in page_targets
        ]
    else:
        # summary_status filtering must include missing summaries. Therefore only
        # this branch inspects summaries for all query-matched targets; the
        # default list path joins summaries for the requested page only.
        summaries_by_uid = load_summaries_by_uid(targets)
        filtered = []
        for target in targets:
            uid = _norm_text(target.get("account_uid"))
            summary = _summary_from_row_or_missing(summaries_by_uid.get(uid), target)
            status = _summary_status_from_payload(summary)
            if status not in status_filter:
                continue
            filtered.append((target, summary))

        total = len(filtered)
        page_pairs = filtered[start:start + per_page]

    return jsonify(
        ok=True,
        items=[_abonent_index_payload(target, summary) for target, summary in page_pairs],
        pagination=_pagination_payload(page, per_page, total),
    )


@app.get("/api/abonent_summary")
def abonent_summary_list():
    # CRITICAL GUARD: Summary API is read-only derived-cache transport.
    # Do not add recalculation, ledger rebuild, autoaccrual, fallback totals,
    # hidden writes, implicit refresh, repair of missing summary rows, or
    # payments_<uid> reads inside GET /api/abonent_summary.
    user, err = _require_user()
    if err:
        return err

    owner = request.args.get("owner") if user.role == "admin" else user.id
    page, per_page = _parse_pagination_args()

    q = AbonentSummary.query
    if owner:
        q = q.filter_by(owner_id=owner)

    abonent_id = str(request.args.get("abonent_id") or "").strip()
    account_uid = str(request.args.get("account_uid") or "").strip()
    account_number = str(request.args.get("account_number") or "").strip()

    if abonent_id:
        q = q.filter_by(abonent_id=abonent_id)
    if account_uid:
        q = q.filter_by(account_uid=account_uid)
    if account_number:
        q = q.filter_by(account_number=account_number)

    total = q.count()
    items = (
        q.order_by(AbonentSummary.updated_at.desc(), AbonentSummary.id.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )

    return jsonify(
        ok=True,
        items=[_abonent_summary_payload(x) for x in items],
        pagination=_pagination_payload(page, per_page, total),
    )


@app.post("/api/abonent_summary/mark_dirty")
def abonent_summary_mark_dirty():
    user, err = _require_user()
    if err:
        return err

    owner = user.id
    counters = {"created": 0, "updated": 0, "skipped": 0, "errors": 0}
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return jsonify(ok=False, error="summary_invalid", counters=counters), 400

    account_uid = _norm_text(body.get("account_uid"))
    if not account_uid:
        return jsonify(ok=False, error="account_uid_required", counters=counters), 400

    reason = _norm_text(body.get("reason")) or "UNKNOWN_CHANGE"
    if reason not in ABONENT_SUMMARY_DIRTY_REASONS:
        return jsonify(ok=False, error="invalid_reason", counters=counters), 400

    try:
        targets = _owner_abonents_db_v1_summary_targets(owner)
        target = next((t for t in targets if _norm_text(t.get("account_uid")) == account_uid), None)
        if not target:
            return jsonify(ok=False, error="uid_not_found"), 404

        row = AbonentSummary.query.filter_by(owner_id=owner, account_uid=account_uid).order_by(AbonentSummary.id.asc()).first()
        if row:
            try:
                existing_summary = json.loads(row.summary_json or "{}")
            except (TypeError, ValueError):
                existing_summary = {}
            row.abonent_id = _norm_text(target.get("abonent_id"))
            row.account_number = _norm_text(target.get("account_number"))
            row.summary_json = json.dumps(_dirty_abonent_summary_payload(existing_summary, reason), ensure_ascii=False, sort_keys=True)
            counters["updated"] += 1
        else:
            db.session.add(AbonentSummary(
                owner_id=owner,
                abonent_id=_norm_text(target.get("abonent_id")),
                account_uid=account_uid,
                account_number=_norm_text(target.get("account_number")),
                summary_json=json.dumps(_dirty_abonent_summary_payload(None, reason), ensure_ascii=False, sort_keys=True),
            ))
            counters["created"] += 1

        db.session.commit()
    except SQLAlchemyError as exc:
        db.session.rollback()
        app.logger.exception("abonent_summary mark_dirty failed for owner=%s", owner)
        return jsonify(ok=False, error="summary_mark_dirty_failed", counters=counters, details=str(exc)), 500

    return jsonify(
        ok=True,
        account_uid=account_uid,
        status="dirty",
        reason=reason,
        counters=counters,
    )


@app.post("/api/abonent_summary/recalc_batch")
def abonent_summary_recalc_batch():
    user, err = _require_user()
    if err:
        return err

    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return jsonify(ok=False, error="summary_invalid"), 400

    raw_uids = body.get("account_uids")
    if raw_uids is None:
        raw_uids = body.get("uids")
    if raw_uids is None:
        raw_uids = body.get("account_uid")
    if isinstance(raw_uids, str):
        raw_uids = [raw_uids]
    if not isinstance(raw_uids, list):
        return jsonify(ok=False, error="account_uids_required"), 400

    requested = []
    seen = set()
    for value in raw_uids:
        uid = _norm_text(value)
        if not uid or uid in seen:
            continue
        seen.add(uid)
        requested.append(uid)

    if not requested:
        return jsonify(ok=False, error="account_uids_required"), 400

    targets = _owner_abonent_summary_targets(user.id)
    targets_by_uid = {_norm_text(t.get("account_uid")): t for t in targets if _norm_text(t.get("account_uid"))}

    items = []
    for uid in requested:
        target = targets_by_uid.get(uid)
        items.append({
            "account_uid": uid,
            "allowed": bool(target),
            "status": "allowed" if target else "not_found",
        })

    return jsonify(ok=True, allowed_uids=[i["account_uid"] for i in items if i["allowed"]], items=items)


@app.post("/api/abonent_summary/recalc_batch_job")
def abonent_summary_recalc_batch_job_create():
    user, err = _require_user()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    raw_uids = body.get("uids")
    if raw_uids is None:
        raw_uids = body.get("account_uids")
    if isinstance(raw_uids, str):
        raw_uids = [raw_uids]
    if not isinstance(raw_uids, list):
        return jsonify(ok=False, error="account_uids_required"), 400
    job, counters = _recalc_batch_create_job(user.id, user.id, raw_uids, body.get("reason"))
    if job == "TOO_MANY_UIDS":
        return jsonify(ok=False, error="TOO_MANY_UIDS", details={"max_uids": counters.get("max_uids"), "requested": counters.get("requested")}), 400
    if not job:
        return jsonify(ok=False, error="account_uids_required"), 400
    return jsonify(ok=True, job_id=int(job.id), status="queued", **counters)


@app.post("/api/abonent_summary/recalc_batch_job/<int:job_id>/run")
def abonent_summary_recalc_batch_job_run(job_id: int):
    user, err = _require_user()
    if err:
        return err
    job = RecalcBatchJob.query.filter_by(id=job_id, owner_id=user.id).first()
    if not job:
        return jsonify(ok=False, error="job_not_found"), 404
    if job.status == "running":
        return jsonify(ok=False, error="job_already_running"), 409
    now = datetime.utcnow()
    job.status = "running"
    job.started_at = now
    db.session.commit()
    items = RecalcBatchJobItem.query.filter_by(job_id=job.id, owner_id=user.id).order_by(RecalcBatchJobItem.id.asc()).all()
    for item in items:
        item.status = "running"
        item.started_at = datetime.utcnow()
        db.session.commit()
        row = AbonentSummary.query.filter_by(owner_id=user.id, account_uid=item.account_uid).order_by(AbonentSummary.id.asc()).first()
        summary = _summary_from_row_or_missing(row, {"account_uid": item.account_uid, "abonent_id": "", "account_number": "", "identity": {}})
        s_status = _summary_status_from_payload(summary)
        s_reason = _norm_text(summary.get("summary_reason") or summary.get("reason") or "")
        if s_status == "fresh":
            item.status = "fresh"
            job.fresh_count += 1
        else:
            item.status = "error"
            item.error_message = s_reason or s_status
            job.error_count += 1
        item.summary_status = s_status
        item.summary_reason = s_reason
        item.finished_at = datetime.utcnow()
        job.processed_count += 1
        db.session.commit()
    job.status = "completed"
    job.finished_at = datetime.utcnow()
    db.session.commit()
    return jsonify(ok=True, job=_batch_job_payload(job))


@app.get("/api/abonent_summary/recalc_batch_job/latest")
def abonent_summary_recalc_batch_job_latest():
    user, err = _require_user()
    if err:
        return err
    job = RecalcBatchJob.query.filter_by(owner_id=user.id).order_by(RecalcBatchJob.id.desc()).first()
    if not job:
        return jsonify(ok=True, job=None)
    return jsonify(ok=True, job=_batch_job_payload(job))


@app.get("/api/abonent_summary/recalc_batch_job/<int:job_id>")
def abonent_summary_recalc_batch_job_status(job_id: int):
    user, err = _require_user()
    if err:
        return err
    job = RecalcBatchJob.query.filter_by(id=job_id, owner_id=user.id).first()
    if not job:
        return jsonify(ok=False, error="job_not_found"), 404
    items = RecalcBatchJobItem.query.filter_by(job_id=job.id, owner_id=user.id).order_by(RecalcBatchJobItem.id.asc()).all()
    return jsonify(ok=True, job=_batch_job_payload(job), items=[{
        "account_uid": _norm_text(x.account_uid),
        "status": _norm_text(x.status),
        "summary_status": _norm_text(x.summary_status),
        "summary_reason": _norm_text(x.summary_reason),
    } for x in items])


@app.post("/api/abonent_summary/rebuild")
def abonent_summary_rebuild():
    user, err = _require_user()
    if err:
        return err

    owner = user.id
    counters = {"created": 0, "updated": 0, "skipped": 0, "errors": 0}
    body = request.get_json(silent=True)

    try:
        if body:
            if not isinstance(body, dict):
                return jsonify(ok=False, error="summary_invalid", counters=counters), 400

            account_uid = _norm_text(body.get("account_uid"))
            if not account_uid:
                return jsonify(ok=False, error="account_uid_required", counters=counters), 400

            summary = body.get("summary")
            if not isinstance(summary, dict):
                return jsonify(ok=False, error="summary_invalid", counters=counters), 400

            targets = _owner_abonent_summary_targets(owner)
            target = next((t for t in targets if _norm_text(t.get("account_uid")) == account_uid), None)
            if not target:
                return jsonify(ok=False, error="uid_not_found", counters=counters), 404

            abonent_id = _norm_text(body.get("abonent_id")) or _norm_text(target.get("abonent_id"))
            account_number = _norm_text(body.get("account_number")) or _norm_text(target.get("account_number"))
            summary_json = json.dumps(summary, ensure_ascii=False, sort_keys=True)
            row = AbonentSummary.query.filter_by(owner_id=owner, account_uid=account_uid).order_by(AbonentSummary.id.asc()).first()
            if row:
                row.abonent_id = abonent_id
                row.account_number = account_number
                row.summary_json = summary_json
                counters["updated"] += 1
            else:
                db.session.add(AbonentSummary(
                    owner_id=owner,
                    abonent_id=abonent_id,
                    account_uid=account_uid,
                    account_number=account_number,
                    summary_json=summary_json,
                ))
                counters["created"] += 1

            db.session.commit()
            return jsonify(ok=True, counters=counters)

        targets = _owner_abonent_summary_targets(owner)
        for target in targets:
            account_uid = _norm_text(target.get("account_uid"))
            if not account_uid:
                counters["skipped"] += 1
                continue

            summary_json = json.dumps(_build_missing_abonent_summary(target), ensure_ascii=False, sort_keys=True)
            row = AbonentSummary.query.filter_by(owner_id=owner, account_uid=account_uid).order_by(AbonentSummary.id.asc()).first()
            if row:
                row.abonent_id = _norm_text(target.get("abonent_id"))
                row.account_number = _norm_text(target.get("account_number"))
                row.summary_json = summary_json
                counters["updated"] += 1
            else:
                db.session.add(AbonentSummary(
                    owner_id=owner,
                    abonent_id=_norm_text(target.get("abonent_id")),
                    account_uid=account_uid,
                    account_number=_norm_text(target.get("account_number")),
                    summary_json=summary_json,
                ))
                counters["created"] += 1

        db.session.commit()
    except SQLAlchemyError as exc:
        db.session.rollback()
        app.logger.exception("abonent_summary rebuild failed for owner=%s", owner)
        return jsonify(ok=False, error="summary_rebuild_failed", counters=counters, details=str(exc)), 500

    return jsonify(ok=True, counters=counters)


@app.post("/api/auth/register")
def auth_register():
    data = request.get_json(silent=True) or {}
    email = _normalize_email(data.get("email"))
    password = str(data.get("password") or "")
    display_name = str(data.get("displayName") or "").strip()

    if not email:
        return _json_error("email_required", 400)
    if len(password) < 4:
        return _json_error("password_too_short", 400)
    if User.query.filter_by(email=email).first():
        return _json_error("email_exists", 409)

    role = "admin" if User.query.count() == 0 else "user"
    user = User(
        id="u_" + uuid.uuid4().hex[:12],
        email=email,
        password_hash=generate_password_hash(password),
        role=role,
        display_name=display_name,
        disabled=False,
        created_at=datetime.utcnow(),
        last_login=datetime.utcnow(),
    )
    db.session.add(user)
    db.session.commit()

    session.clear()
    session["user_id"] = user.id
    return jsonify(ok=True, user=_user_payload(user))


@app.post("/api/auth/login")
def auth_login():
    data = request.get_json(silent=True) or {}
    email = _normalize_email(data.get("email"))
    password = str(data.get("password") or "")

    if not email:
        return _json_error("email_required", 400)
    if not password:
        return _json_error("password_required", 400)

    user = User.query.filter_by(email=email).first()
    if not user:
        return _json_error("user_not_found", 404)
    if user.disabled:
        return _json_error("user_disabled", 403)
    if not check_password_hash(user.password_hash, password):
        return _json_error("invalid_password", 401)

    user.last_login = datetime.utcnow()
    db.session.commit()

    session.clear()
    session["user_id"] = user.id
    app.logger.info("[auth] login_ok user_id=%s email=%s role=%s", user.id, user.email, user.role)
    return jsonify(ok=True, user=_user_payload(user))


@app.get("/api/auth/me")
def auth_me():
    user = _current_user()
    if not user:
        return _json_error("not_authenticated", 401)
    app.logger.info("[auth] me_ok user_id=%s email=%s role=%s", user.id, user.email, user.role)
    return jsonify(ok=True, user=_user_payload(user))


@app.post("/api/auth/logout")
def auth_logout():
    user = _current_user()
    if user:
        app.logger.info("[auth] logout user_id=%s email=%s", user.id, user.email)
    session.clear()
    return jsonify(ok=True)


@app.get("/api/admin/users")
def admin_users_list():
    _admin, err = _require_admin()
    if err:
        return err
    users = User.query.order_by(User.created_at.asc(), User.email.asc()).all()
    return jsonify(ok=True, users=[_user_payload(u) for u in users])


@app.post("/api/admin/users")
def admin_users_create():
    _admin, err = _require_admin()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    email = _normalize_email(data.get("email"))
    password = str(data.get("password") or "")
    display_name = str(data.get("displayName") or "").strip()
    role = str(data.get("role") or "user").strip().lower()
    if role not in {"user", "admin", "moderator"}:
        role = "user"

    if not email:
        return _json_error("email_required", 400)
    if len(password) < 4:
        return _json_error("password_too_short", 400)
    if User.query.filter_by(email=email).first():
        return _json_error("email_exists", 409)

    user = User(
        id="u_" + uuid.uuid4().hex[:12],
        email=email,
        password_hash=generate_password_hash(password),
        role=role,
        display_name=display_name,
        disabled=False,
        created_at=datetime.utcnow(),
        last_login=None,
    )
    db.session.add(user)
    db.session.commit()
    return jsonify(ok=True, user=_user_payload(user))


@app.post("/api/admin/users/<user_id>/disable")
def admin_users_disable(user_id):
    admin, err = _require_admin()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    disabled = bool(data.get("disabled"))
    user = User.query.filter_by(id=user_id).first()
    if not user:
        return _json_error("user_not_found", 404)
    if admin.id == user.id and disabled:
        return _json_error("cannot_disable_self", 400)

    user.disabled = disabled
    db.session.commit()
    return jsonify(ok=True, user=_user_payload(user))


@app.post("/api/admin/users/<user_id>/password")
def admin_users_reset_password(user_id):
    _admin, err = _require_admin()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    new_password = str(data.get("password") or "")
    if len(new_password) < 4:
        return _json_error("password_too_short", 400)

    user = User.query.filter_by(id=user_id).first()
    if not user:
        return _json_error("user_not_found", 404)

    user.password_hash = generate_password_hash(new_password)
    db.session.commit()
    return jsonify(ok=True)


@app.delete("/api/admin/users/<user_id>")
def admin_users_delete(user_id):
    admin, err = _require_admin()
    if err:
        return err

    user = User.query.filter_by(id=user_id).first()
    if not user:
        return _json_error("user_not_found", 404)
    if user.id == admin.id:
        return _json_error("cannot_delete_self", 400)

    active_admins = User.query.filter_by(role="admin", disabled=False).count()
    if user.role == "admin" and active_admins <= 1:
        return _json_error("cannot_delete_last_admin", 400)

    db.session.delete(user)
    db.session.commit()
    return jsonify(ok=True)


@app.post("/api/import/payments/upload")
def import_payments_upload():
    user, err = _require_user()
    if err:
        return err

    owner, owner_err = _resolve_owner(request.form.get("owner"), allow_admin_override=True)
    if owner_err:
        return owner_err

    upload = request.files.get("file")
    if not upload:
        return _json_error("file_required", 400)

    file_bytes = upload.read()
    if not file_bytes:
        return _json_error("file_empty", 400)
    if len(file_bytes) > app.config["IMPORT_MAX_UPLOAD_BYTES"]:
        return jsonify(
            ok=False,
            error="file_too_large",
            details={"max_bytes": app.config["IMPORT_MAX_UPLOAD_BYTES"]},
        ), 400

    file_sha = hashlib.sha256(file_bytes).hexdigest()
    accounting_year = _norm_text(request.form.get("accounting_year"))
    display_name = _norm_text(request.form.get("display_name")) or _norm_text(upload.filename)

    existing_exact = ImportBatch.query.filter_by(owner_id=owner, file_sha256=file_sha).order_by(ImportBatch.id.asc()).first()
    existing_year = None
    if accounting_year:
        existing_year = ImportBatch.query.filter_by(owner_id=owner, accounting_year=accounting_year).order_by(ImportBatch.id.desc()).first()

    batch = ImportBatch(
        owner_id=owner,
        created_by_user_id=user.id,
        original_filename=_norm_text(upload.filename),
        file_sha256=file_sha,
        upload_blob=file_bytes,
        display_name=display_name,
        accounting_year=accounting_year,
        version_label=_norm_text(request.form.get("version_label")),
        duplicate_of_batch_id=existing_exact.id if existing_exact else None,
        supersedes_batch_id=int(request.form.get("supersedes_batch_id")) if _norm_text(request.form.get("supersedes_batch_id")) else None,
        overlaps_with_batch_id=existing_year.id if existing_year else None,
        is_exact_duplicate=bool(existing_exact),
        has_period_overlap=bool(existing_year),
        status="uploaded",
        uploaded_at=datetime.utcnow(),
        notes=(
            (_norm_text(request.form.get("notes")) + "\n") if _norm_text(request.form.get("notes")) else ""
        ) + f"upload_blob_policy: ttl_days={app.config['IMPORT_UPLOAD_BLOB_TTL_DAYS']}, max_bytes={app.config['IMPORT_MAX_UPLOAD_BYTES']}",
    )
    db.session.add(batch)
    db.session.commit()
    return jsonify(ok=True, batch=_batch_payload(batch))


@app.post("/api/import/payments/upload_rows")
def import_payments_upload_rows():
    user, err = _require_user()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    rows = data.get("rows")
    if not isinstance(rows, list) or not rows:
        return _json_error("rows_required", 400)

    owner, owner_err = _resolve_owner(data.get("owner"), allow_admin_override=True)
    if owner_err:
        return owner_err

    payload_dump = json.dumps(rows, ensure_ascii=False, sort_keys=True)
    payload_bytes = payload_dump.encode("utf-8")
    if len(payload_bytes) > app.config["IMPORT_MAX_UPLOAD_BYTES"]:
        return jsonify(
            ok=False,
            error="file_too_large",
            details={"max_bytes": app.config["IMPORT_MAX_UPLOAD_BYTES"]},
        ), 400

    file_sha = hashlib.sha256(payload_bytes).hexdigest()
    accounting_year = _norm_text(data.get("accounting_year"))
    display_name = _norm_text(data.get("display_name")) or "payments_rows.json"

    existing_exact = ImportBatch.query.filter_by(owner_id=owner, file_sha256=file_sha).order_by(ImportBatch.id.asc()).first()
    existing_year = None
    if accounting_year:
        existing_year = ImportBatch.query.filter_by(owner_id=owner, accounting_year=accounting_year).order_by(ImportBatch.id.desc()).first()

    batch = ImportBatch(
        owner_id=owner,
        created_by_user_id=user.id,
        original_filename="payments_rows.json",
        file_sha256=file_sha,
        upload_blob=b"",
        display_name=display_name,
        accounting_year=accounting_year,
        version_label=_norm_text(data.get("version_label")),
        duplicate_of_batch_id=existing_exact.id if existing_exact else None,
        supersedes_batch_id=int(data.get("supersedes_batch_id")) if _norm_text(data.get("supersedes_batch_id")) else None,
        overlaps_with_batch_id=existing_year.id if existing_year else None,
        is_exact_duplicate=bool(existing_exact),
        has_period_overlap=bool(existing_year),
        status="parsed",
        uploaded_at=datetime.utcnow(),
        started_at=datetime.utcnow(),
        file_name=_norm_text(data.get("file_name")) or "payments_rows.json",
        uploaded_by=user.id,
        notes=(
            (_norm_text(data.get("notes")) + "\n") if _norm_text(data.get("notes")) else ""
        ) + "source=upload_rows",
    )
    db.session.add(batch)
    db.session.flush()

    parsed_rows = []
    row_no = 0
    for idx, raw_row in enumerate(rows, start=1):
        row_no += 1
        src = raw_row if isinstance(raw_row, dict) else {}
        account_uid = _norm_text(src.get("account_uid"))
        abonent_id = _norm_text(src.get("abonent_id"))
        account_number = _norm_text(src.get("account_number"))
        payment_date = _norm_iso_date(src.get("payment_date"))
        payment_period = _norm_upload_payment_period(src.get("payment_period"))
        amount = _norm_amount(src.get("amount"))
        src_index_raw = src.get("source_index")
        try:
            source_index = int(src_index_raw) if src_index_raw is not None and _norm_text(src_index_raw) != "" else None
        except Exception:
            source_index = None

        charge_year, charge_month = _extract_year_month(payment_period)
        normalized_payload = {
            "account_uid": account_uid,
            "abonent_id": abonent_id,
            "account_number": account_number,
            "payment_date": payment_date,
            "payment_period": payment_period,
            "amount": amount,
            "source_index": source_index,
        }

        parsed_rows.append(ImportBatchRow(
            batch_id=batch.id,
            row_no=row_no,
            excel_sheet_name="upload_rows",
            excel_row_ref=f"row:{idx}",
            raw_payload_json=json.dumps(src, ensure_ascii=False),
            normalized_payload_json=json.dumps(normalized_payload, ensure_ascii=False),
            account_uid=account_uid,
            abonent_id=abonent_id,
            account_number=account_number,
            payment_date=payment_date or "",
            paid_date=payment_date or "",
            payment_period=payment_period or "",
            charge_year=charge_year,
            charge_month=charge_month,
            amount=amount or "",
            source_index=source_index,
            source_label=f"Платёж {source_index}" if source_index else "",
            fingerprint="",
            status="parsed",
            reason_code="",
            reason_text="",
            error_details_json="{}",
        ))

    db.session.bulk_save_objects(parsed_rows)
    batch.rows_total = row_no
    batch.started_at = datetime.utcnow()
    db.session.commit()
    return jsonify(ok=True, batch=_batch_payload(batch), parsed_rows=row_no)


@app.post("/api/import/<int:batch_id>/parse")
def import_payments_parse(batch_id):
    user, err = _require_user()
    if err:
        return err

    batch = ImportBatch.query.filter_by(id=batch_id).first()
    if not batch:
        return _json_error("batch_not_found", 404)
    if user.role != "admin" and batch.owner_id != user.id:
        return _json_error("forbidden", 403)
    transition_err = _ensure_batch_transition(batch, "parse")
    if transition_err:
        return transition_err

    try:
        wb = load_workbook(io.BytesIO(batch.upload_blob), data_only=True)
    except Exception as ex:
        batch.status = "failed"
        batch.finished_at = datetime.utcnow()
        batch.error_message = "fingerprint_conflict"
        db.session.commit()
        return jsonify(ok=False, error="parse_failed", details=str(ex)), 400

    ImportBatchRow.query.filter_by(batch_id=batch.id).delete()
    row_no = 0
    parsed_rows = []

    missing_columns = set()
    for ws in wb.worksheets:
        values = list(ws.iter_rows(values_only=True))
        if not values:
            continue
        header_map = _parse_strict_header_map(values[0])
        missing = sorted(IMPORT_REQUIRED_COLUMNS.difference(set(header_map.keys())))
        if missing:
            missing_columns.update(missing)
            continue
        for idx in range(2, len(values) + 1):
            line = values[idx - 1]
            if all(_norm_text(v) == "" for v in line if v is not None):
                continue
            row_no += 1
            account_uid = _norm_text(_find_cell(header_map, line, "account_uid"))
            abonent_id = _norm_text(_find_cell(header_map, line, "abonent_id"))
            account_number = _norm_text(_find_cell(header_map, line, "account_number"))
            payment_date = _norm_date(_find_cell(header_map, line, "payment_date"))
            payment_period = _norm_period(_find_cell(header_map, line, "payment_period"))
            amount = _norm_amount(_find_cell(header_map, line, "amount"))
            src_index_raw = _find_cell(header_map, line, "source_index")
            try:
                source_index = int(src_index_raw) if src_index_raw is not None and _norm_text(src_index_raw) != "" else None
            except Exception:
                source_index = None

            charge_year, charge_month = _extract_year_month(payment_period)
            normalized_payload = {
                "account_uid": account_uid,
                "abonent_id": abonent_id,
                "account_number": account_number,
                "payment_date": payment_date,
                "payment_period": payment_period,
                "amount": amount,
                "source_index": source_index,
            }
            parsed_rows.append(ImportBatchRow(
                batch_id=batch.id,
                row_no=row_no,
                excel_sheet_name=ws.title,
                excel_row_ref=f"{ws.title}:{idx}",
                raw_payload_json=json.dumps({"values": ["" if v is None else str(v) for v in line]}, ensure_ascii=False),
                normalized_payload_json=json.dumps(normalized_payload, ensure_ascii=False),
                account_uid=account_uid,
                abonent_id=abonent_id,
                account_number=account_number,
                payment_date=payment_date or "",
                paid_date=payment_date or "",
                payment_period=payment_period or "",
                charge_year=charge_year,
                charge_month=charge_month,
                amount=amount or "",
                source_index=source_index,
                source_label=f"Платёж {source_index}" if source_index else "",
                fingerprint="",
                status="parsed",
                reason_code="",
                reason_text="",
                error_details_json="{}",
            ))

    if missing_columns:
        batch.status = "failed"
        batch.finished_at = datetime.utcnow()
        db.session.commit()
        return jsonify(
            ok=False,
            error="template_header_mismatch",
            details={"missing_required_columns": sorted(missing_columns)},
        ), 400

    db.session.bulk_save_objects(parsed_rows)
    batch.rows_total = row_no
    batch.status = "parsed"
    batch.started_at = datetime.utcnow()
    db.session.commit()
    return jsonify(ok=True, batch=_batch_payload(batch), parsed_rows=row_no, summary={"missing_required_columns": []})


@app.post("/api/import/<int:batch_id>/validate")
def import_payments_validate(batch_id):
    user, err = _require_user()
    if err:
        return err

    batch = ImportBatch.query.filter_by(id=batch_id).first()
    if not batch:
        return _json_error("batch_not_found", 404)
    if user.role != "admin" and batch.owner_id != user.id:
        return _json_error("forbidden", 403)
    transition_err = _ensure_batch_transition(batch, "validate")
    if transition_err:
        return transition_err

    rows = ImportBatchRow.query.filter_by(batch_id=batch.id).order_by(ImportBatchRow.row_no.asc()).all()
    if not rows:
        return _json_error("rows_not_found", 400)

    seen = set()
    seen_uid_date = {}
    sources_map = _load_owner_sources(batch.owner_id)
    valid = invalid = duplicate = 0

    for r in rows:
        details = {}
        if not r.account_uid:
            r.status = "invalid"
            r.reason_code = "ACCOUNT_UID_REQUIRED"
            r.reason_text = "Платежи могут учитываться только при наличии UID"
            details["field"] = "account_uid"
            details["recommendation"] = "Заполните account_uid существующим UID абонента."
            invalid += 1
        elif not r.account_number:
            r.status = "invalid"
            r.reason_code = "ACCOUNT_NUMBER_REQUIRED"
            r.reason_text = "Для записи оплаты в ledger нужен лицевой счёт"
            details["field"] = "account_number"
            details["recommendation"] = "Заполните лицевой счёт (account_number)."
            invalid += 1
        elif not r.payment_date:
            r.status = "invalid"
            r.reason_code = "PAYMENT_DATE_INVALID"
            r.reason_text = "Некорректная дата платежа"
            details["field"] = "payment_date"
            details["recommendation"] = "Проверьте дату платежа, ожидается YYYY-MM-DD."
            invalid += 1
        elif not r.payment_period:
            r.status = "invalid"
            r.reason_code = "PAYMENT_PERIOD_INVALID" if _raw_upload_payment_period_present(r) else "PAYMENT_PERIOD_REQUIRED"
            r.reason_text = "Не найден год/период платежа. Импорт строки остановлен, чтобы не записать платёж не в тот год."
            details["field"] = "payment_period"
            details["recommendation"] = "Проверьте период платежа, ожидается YYYY-MM."
            invalid += 1
        elif not r.amount:
            r.status = "invalid"
            r.reason_code = "AMOUNT_INVALID"
            r.reason_text = "Некорректная сумма"
            details["field"] = "amount"
            details["recommendation"] = "Проверьте сумму, ожидается число > 0."
            invalid += 1
        elif r.source_index is None:
            r.status = "invalid"
            r.reason_code = "SOURCE_INDEX_INVALID"
            r.reason_text = "source_index обязателен"
            details["field"] = "source_index"
            details["recommendation"] = "Укажите индекс источника платежа."
            invalid += 1
        elif r.source_index not in sources_map:
            r.status = "invalid"
            r.reason_code = "SOURCE_INDEX_INVALID"
            r.reason_text = "source_index отсутствует в справочнике payment_sources"
            details["field"] = "source_index"
            details["recommendation"] = "Используйте source_index из справочника источников оплаты."
            invalid += 1
        else:
            lookup = _find_owner_accounts(batch.owner_id, r.account_uid, r.account_number)
            matches = lookup["matches"]
            if not matches and lookup["uid_found"]:
                r.status = "invalid"
                r.reason_code = "UID_LS_MISMATCH"
                r.reason_text = "UID найден, но лицевой счёт не совпадает"
                details["field"] = "account_number"
                details["recommendation"] = "Проверьте соответствие UID и лицевого счёта."
                invalid += 1
            elif not matches:
                r.status = "invalid"
                r.reason_code = "ACCOUNT_NOT_FOUND"
                r.reason_text = "account_uid не найден у текущего owner"
                details["field"] = "account_uid"
                details["recommendation"] = "Проверьте UID/ЛС и загрузите корректные данные абонента."
                invalid += 1
            elif len(matches) > 1:
                r.status = "invalid"
                r.reason_code = "AMBIGUOUS_ACCOUNT_MATCH"
                r.reason_text = "Найдено несколько совпадений account_uid/account_number"
                details["field"] = "account_uid"
                details["recommendation"] = "Уточните ЛС/UID для однозначного сопоставления."
                invalid += 1
            else:
                r.source_label = sources_map.get(r.source_index, r.source_label)
                try:
                    normalized_uid = normalize_uid(r.account_uid)
                    normalized_account_number = normalize_account_number(r.account_number)
                    normalized_paid_date = normalize_paid_date(r.payment_date)
                    normalized_period = normalize_payment_period(r.payment_period)
                    normalized_amount = normalize_amount(r.amount)
                    normalized_source_index = normalize_source_index(r.source_index)
                except ValueError as ex:
                    r.status = "invalid"
                    r.reason_code = str(ex)
                    r.reason_text = "Некорректные данные строки для fingerprint"
                    details["field"] = "fingerprint"
                    details["recommendation"] = "Исправьте обязательные поля и повторите валидацию."
                    invalid += 1
                    r.error_details_json = json.dumps(details, ensure_ascii=False)
                    continue

                r.account_uid = normalized_uid
                r.account_number = normalized_account_number
                r.payment_date = normalized_paid_date
                r.paid_date = normalized_paid_date
                r.payment_period = normalized_period
                r.amount = normalized_amount
                r.source_index = normalized_source_index
                r.fingerprint = build_payment_fingerprint(
                    batch.owner_id,
                    r.account_uid,
                    r.account_number,
                    r.paid_date,
                    r.amount,
                    r.source_index,
                    r.payment_period,
                )
                uid_date_key = f"{r.account_uid}|{r.paid_date}"
                if uid_date_key in seen_uid_date and seen_uid_date[uid_date_key] != r.amount:
                    r.status = "conflict"
                    r.reason_code = "CONFLICT"
                    r.reason_text = "Найден платёж с тем же UID+paid_date, но другой суммой"
                    duplicate += 1
                elif r.fingerprint in seen:
                    r.status = "duplicate"
                    r.reason_code = "DUPLICATE"
                    r.reason_text = "Дубликат в текущем батче"
                    duplicate += 1
                else:
                    key = f"payments_{r.account_uid}"
                    legacy_key = f"payments_{r.account_number}"
                    kv = KVStore.query.filter_by(owner=batch.owner_id, k=key).first()
                    if not kv:
                        kv = KVStore.query.filter_by(owner=batch.owner_id, k=legacy_key).first()
                    try:
                        ledger = _load_existing_payment_ledger_or_raise(kv)
                    except LedgerJsonInvalidError:
                        r.status = "invalid"
                        r.reason_code = "LEDGER_JSON_INVALID"
                        r.reason_text = "Данные платежей повреждены. Расчёт/импорт остановлен, чтобы не потерять историю платежей."
                        invalid += 1
                        continue

                    classification = _classify_import_payment(r.account_uid, r.paid_date, r.amount, r.fingerprint, ledger)
                    if classification == "NEW_PAYMENT":
                        seen.add(r.fingerprint)
                        seen_uid_date[uid_date_key] = r.amount
                        r.status = "ready"
                        r.reason_code = "NEW_PAYMENT"
                        r.reason_text = ""
                        valid += 1
                    elif classification == "DUPLICATE":
                        r.status = "duplicate"
                        r.reason_code = "DUPLICATE"
                        r.reason_text = "Платёж уже существует"
                        duplicate += 1
                    else:
                        r.status = "conflict"
                        r.reason_code = "CONFLICT"
                        r.reason_text = "Найден платёж с тем же UID+paid_date, но другой суммой"
                        duplicate += 1
        r.error_details_json = json.dumps(details, ensure_ascii=False)

    batch.rows_valid = valid
    batch.rows_invalid = invalid
    batch.rows_duplicate = duplicate
    batch.status = "ready_to_apply" if invalid == 0 else "validated"
    db.session.commit()
    return jsonify(ok=True, batch=_batch_payload(batch))


@app.get("/api/import/<int:batch_id>/rows")
def import_payments_rows(batch_id):
    user, err = _require_user()
    if err:
        return err
    batch = ImportBatch.query.filter_by(id=batch_id).first()
    if not batch:
        return _json_error("batch_not_found", 404)
    if user.role != "admin" and batch.owner_id != user.id:
        return _json_error("forbidden", 403)

    q = ImportBatchRow.query.filter_by(batch_id=batch.id)
    status = _norm_text(request.args.get("status"))
    if status:
        q = q.filter_by(status=status)
    rows = q.order_by(ImportBatchRow.row_no.asc()).all()
    return jsonify(ok=True, rows=[_row_payload(r) for r in rows])


@app.post("/api/import/<int:batch_id>/apply")
def import_payments_apply(batch_id):
    user, err = _require_user()
    if err:
        return err
    batch = ImportBatch.query.filter_by(id=batch_id).first()
    if not batch:
        return _json_error("batch_not_found", 404)
    if user.role != "admin" and batch.owner_id != user.id:
        return _json_error("forbidden", 403)
    transition_err = _ensure_batch_transition(batch, "apply")
    if transition_err:
        return transition_err

    if batch.status == "failed":
        return jsonify(
            ok=False,
            error="batch_failed_restart_required",
            details={
                "message": "Батч завершился с ошибкой. Требуется повторная загрузка."
            }
        ), 400

    if batch.rows_invalid > 0:
        return jsonify(
            ok=False,
            error="invalid_rows_present",
            details={
                "rows_invalid": batch.rows_invalid,
                "message": "Импорт невозможен: в батче есть строки с ошибками. Исправьте их и повторите валидацию.",
            },
        ), 400

    rows = ImportBatchRow.query.filter_by(batch_id=batch.id).order_by(ImportBatchRow.row_no.asc()).all()
    applicable_statuses = {"ready", "duplicate"}
    not_ready = [r for r in rows if r.status not in applicable_statuses]
    if not_ready:
        return jsonify(
            ok=False,
            error="non_ready_rows_present",
            details={"count": len(not_ready)},
        ), 400
    applied_count = skipped_count = duplicate_count = conflict_count = failed_count = 0
    affected_uids = set()
    sources_map = _load_owner_sources(batch.owner_id)
    current_row_id = None
    try:
        batch.status = "applying"
        db.session.flush()

        for r in rows:
            current_row_id = r.id
            if r.status != "ready":
                action = r.reason_code or "SKIPPED"
                if r.reason_code == "DUPLICATE":
                    duplicate_count += 1
                elif r.reason_code == "CONFLICT":
                    conflict_count += 1
                else:
                    skipped_count += 1
                db.session.add(PaymentAuditLog(
                    owner_id=batch.owner_id,
                    batch_id=batch.id,
                    row_id=r.id,
                    action=action,
                    status="SKIPPED",
                    details_json=json.dumps({"account_uid": r.account_uid, "payment_date": r.paid_date or r.payment_date, "amount": r.amount, "source_index": r.source_index, "result": "SKIPPED", "reason_code": r.reason_code, "reason_text": r.reason_text, "fingerprint": r.fingerprint}, ensure_ascii=False),
                ))
                continue

            normalized_uid = normalize_uid(r.account_uid)
            normalized_account_number = normalize_account_number(r.account_number)
            normalized_paid_date = normalize_paid_date(r.paid_date or r.payment_date)
            normalized_period = normalize_payment_period(r.payment_period)
            normalized_amount = normalize_amount(r.amount)
            normalized_source_index = normalize_source_index(r.source_index)
            fingerprint = payment_fingerprint(normalized_uid, normalized_paid_date, normalized_amount, normalized_source_index)

            key = f"payments_{normalized_uid}"
            legacy_key = f"payments_{normalized_account_number}"
            existing_fingerprint = ImportAppliedFingerprint.query.filter_by(
                owner_id=batch.owner_id,
                import_type="payments",
                fingerprint=fingerprint,
            ).first()
            if existing_fingerprint:
                r.status = "duplicate"
                r.reason_code = "DUPLICATE"
                r.reason_text = "Платёж уже применён ранее"
                r.matched_payment_id = existing_fingerprint.payment_id or ""
                duplicate_count += 1
                db.session.add(PaymentAuditLog(
                    owner_id=batch.owner_id,
                    batch_id=batch.id,
                    row_id=r.id,
                    action="DUPLICATE",
                    status="SKIPPED",
                    details_json=json.dumps({"account_uid": normalized_uid, "payment_date": normalized_paid_date, "amount": normalized_amount, "source_index": normalized_source_index, "result": "DUPLICATE", "reason_code": r.reason_code, "fingerprint": fingerprint}, ensure_ascii=False),
                ))
                continue

            fingerprint_row = ImportAppliedFingerprint(
                owner_id=batch.owner_id,
                import_type="payments",
                fingerprint=fingerprint,
                account_uid=normalized_uid,
                account_number=normalized_account_number,
                payment_period=normalized_period,
                paid_date=datetime.strptime(normalized_paid_date, "%Y-%m-%d").date(),
                amount=Decimal(normalized_amount),
                source_index=normalized_source_index,
                batch_id=batch.id,
            )
            db.session.add(fingerprint_row)

            kv = KVStore.query.filter_by(owner=batch.owner_id, k=key).with_for_update().first()
            legacy_kv = None
            ledger = []
            source_kv = kv
            if not source_kv:
                legacy_kv = KVStore.query.filter_by(owner=batch.owner_id, k=legacy_key).first()
                source_kv = legacy_kv
            try:
                ledger = _load_existing_payment_ledger_or_raise(source_kv)
            except LedgerJsonInvalidError:
                raise LedgerJsonInvalidError("LEDGER_JSON_INVALID")

            max_id = 0
            for x in ledger:
                try:
                    max_id = max(max_id, int(x.get("id") or 0))
                except Exception:
                    continue
            next_id = max_id + 1
            yy, mm = _extract_year_month(normalized_period)
            ledger_item = {
                "id": next_id,
                "uid": normalized_uid,
                "year": yy,
                "month": mm,
                "accrued": 0,
                "paid": float(normalized_amount),
                "paid_date": to_ledger_paid_date(normalized_paid_date),
                "source": sources_map.get(normalized_source_index) or r.source_label or f"Платёж {normalized_source_index}",
                "payment_period": normalized_period,
                "fingerprint": fingerprint,
            }
            ledger.append(ledger_item)
            if kv:
                kv.v = json.dumps(ledger, ensure_ascii=False)
            else:
                db.session.add(KVStore(owner=batch.owner_id, k=key, v=json.dumps(ledger, ensure_ascii=False)))

            payment_id = f"{normalized_account_number}:{next_id}"
            fingerprint_row.payment_id = payment_id
            r.account_uid = normalized_uid
            r.account_number = normalized_account_number
            r.payment_date = normalized_paid_date
            r.paid_date = normalized_paid_date
            r.payment_period = normalized_period
            r.amount = normalized_amount
            r.source_index = normalized_source_index
            r.fingerprint = fingerprint
            r.matched_payment_id = payment_id
            r.applied_at = datetime.utcnow()
            r.status = "applied"
            r.reason_code = ""
            r.reason_text = ""
            db.session.add(PaymentAuditLog(
                owner_id=batch.owner_id,
                batch_id=batch.id,
                row_id=r.id,
                action="APPLIED",
                status="APPLIED",
                details_json=json.dumps({"account_uid": normalized_uid, "payment_date": normalized_paid_date, "amount": normalized_amount, "source_index": normalized_source_index, "result": "APPLIED", "payment_id": payment_id, "fingerprint": fingerprint}, ensure_ascii=False),
            ))
            applied_count += 1
            affected_uids.add(normalized_uid)

        batch.rows_applied = applied_count
        batch.rows_skipped = duplicate_count + conflict_count + skipped_count
        batch.error_message = ""
        batch.status = "applied"
        batch.finished_at = datetime.utcnow()
        if batch.uploaded_at and app.config["IMPORT_UPLOAD_BLOB_TTL_DAYS"] <= 0:
            batch.upload_blob = b""
        db.session.commit()
    except LedgerJsonInvalidError as ex:
        db.session.rollback()
        batch = ImportBatch.query.filter_by(id=batch.id).first()
        if batch:
            batch.status = "failed"
            batch.finished_at = datetime.utcnow()
            batch.error_message = "LEDGER_JSON_INVALID"
            db.session.execute(
                text("UPDATE import_rows SET status = 'failed', reason_code = 'LEDGER_JSON_INVALID', reason_text = :reason_text WHERE batch_id = :batch_id"),
                {"batch_id": batch.id, "reason_text": "Данные платежей повреждены. Расчёт/импорт остановлен, чтобы не потерять историю платежей."},
            )
            db.session.add(PaymentAuditLog(
                owner_id=batch.owner_id,
                batch_id=batch.id,
                action="FAILED",
                status="FAILED",
                details_json=json.dumps({"error": "LEDGER_JSON_INVALID", "row_id": current_row_id}, ensure_ascii=False),
            ))
            db.session.commit()
        failed_count = 1
        return jsonify(ok=False, error="apply_failed", details="LEDGER_JSON_INVALID"), 500
    except IntegrityError as e:
        db.session.rollback()
        batch = ImportBatch.query.filter_by(id=batch.id).first()
        if batch:
            batch.status = "failed"
            batch.finished_at = datetime.utcnow()
            batch.error_message = "fingerprint_conflict"
            db.session.execute(
                text("UPDATE import_rows SET status = 'failed' WHERE batch_id = :batch_id"),
                {"batch_id": batch.id},
            )
            db.session.add(PaymentAuditLog(
                owner_id=batch.owner_id,
                batch_id=batch.id,
                action="FAILED",
                status="FAILED",
                details_json=json.dumps({"error": str(e)}, ensure_ascii=False),
            ))
            db.session.commit()
        failed_count = 1
        return jsonify(ok=False, error="apply_failed", details="fingerprint_conflict"), 500
    except Exception as ex:
        db.session.rollback()
        batch = ImportBatch.query.filter_by(id=batch.id).first()
        if batch:
            batch.status = "failed"
            batch.finished_at = datetime.utcnow()
            batch.error_message = str(ex)
            db.session.execute(
                text("UPDATE import_rows SET status = 'failed' WHERE batch_id = :batch_id"),
                {"batch_id": batch.id},
            )
            db.session.add(PaymentAuditLog(
                owner_id=batch.owner_id,
                batch_id=batch.id,
                action="FAILED",
                status="FAILED",
                details_json=json.dumps({"error": str(ex), "row_id": current_row_id}, ensure_ascii=False),
            ))
            db.session.commit()
        failed_count = 1
        return jsonify(ok=False, error="apply_failed", details=str(ex)), 500

    summary = {
        "applied_count": applied_count,
        "skipped_count": skipped_count,
        "duplicate_count": duplicate_count,
        "conflict_count": conflict_count,
        "failed_count": failed_count,
        "affected_uids": sorted(affected_uids),
    }
    return jsonify(ok=True, batch=_batch_payload(batch), summary=summary)


@app.get("/api/import/payments/batches")
def import_payments_batches():
    user, err = _require_user()
    if err:
        return err
    owner = request.args.get("owner") if user.role == "admin" else user.id
    q = ImportBatch.query
    if owner:
        q = q.filter_by(owner_id=owner)
    items = q.order_by(ImportBatch.uploaded_at.desc()).limit(200).all()
    return jsonify(ok=True, batches=[_batch_payload(x) for x in items])


@app.get("/api/import/<int:batch_id>/summary")
def import_payments_summary(batch_id):
    user, err = _require_user()
    if err:
        return err
    batch = ImportBatch.query.filter_by(id=batch_id).first()
    if not batch:
        return _json_error("batch_not_found", 404)
    if user.role != "admin" and batch.owner_id != user.id:
        return _json_error("forbidden", 403)

    return jsonify(
        ok=True,
        summary={
            "batch_id": batch.id,
            "status": batch.status,
            "file_name": batch.file_name or batch.original_filename,
            "rows_total": batch.rows_total,
            "rows_valid": batch.rows_valid,
            "rows_invalid": batch.rows_invalid,
            "rows_applied": batch.rows_applied,
            "rows_skipped": batch.rows_skipped,
            "started_at": batch.started_at.isoformat() + "Z" if batch.started_at else None,
            "finished_at": batch.finished_at.isoformat() + "Z" if batch.finished_at else None,
        },
    )


@app.get("/api/import/<int:batch_id>/errors")
def import_payments_errors(batch_id):
    user, err = _require_user()
    if err:
        return err
    batch = ImportBatch.query.filter_by(id=batch_id).first()
    if not batch:
        return _json_error("batch_not_found", 404)
    if user.role != "admin" and batch.owner_id != user.id:
        return _json_error("forbidden", 403)

    bad = ImportBatchRow.query.filter(
        ImportBatchRow.batch_id == batch.id,
        ImportBatchRow.status.in_(["invalid", "failed", "duplicate", "conflict"]),
    ).order_by(ImportBatchRow.row_no.asc()).all()
    by_reason = {}
    for r in bad:
        by_reason[r.reason_code or "unknown"] = by_reason.get(r.reason_code or "unknown", 0) + 1
    return jsonify(
        ok=True,
        errors=[_row_human_error_payload(r) for r in bad],
        summary={"total": len(bad), "by_reason": by_reason},
    )


@app.get("/api/import/<int:batch_id>/errors/export")
def import_payments_errors_export(batch_id):
    user, err = _require_user()
    if err:
        return err
    batch = ImportBatch.query.filter_by(id=batch_id).first()
    if not batch:
        return _json_error("batch_not_found", 404)
    if user.role != "admin" and batch.owner_id != user.id:
        return _json_error("forbidden", 403)

    bad = ImportBatchRow.query.filter(
        ImportBatchRow.batch_id == batch.id,
        ImportBatchRow.status.in_(["invalid", "failed", "duplicate", "conflict"]),
    ).order_by(ImportBatchRow.row_no.asc()).all()

    fmt = _norm_text(request.args.get("format")).lower() or "csv"
    headers = [
        "excel_row_ref",
        "excel_sheet_name",
        "account_uid",
        "account_number",
        "payment_date",
        "payment_period",
        "amount",
        "source_index",
        "source_label",
        "reason_code",
        "reason_text",
        "recommendation",
    ]

    if fmt == "xlsx":
        wb = Workbook()
        ws = wb.active
        ws.title = "errors"
        ws.append(headers)
        for r in bad:
            ws.append([
                r.excel_row_ref,
                r.excel_sheet_name,
                r.account_uid,
                r.account_number,
                r.payment_date,
                r.payment_period,
                r.amount,
                r.source_index,
                r.source_label,
                r.reason_code,
                r.reason_text,
                json.loads(r.error_details_json or "{}").get("recommendation", ""),
            ])
        bio = io.BytesIO()
        wb.save(bio)
        bio.seek(0)
        return Response(
            bio.read(),
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename=import_errors_{batch.id}.xlsx"},
        )

    sio = io.StringIO()
    writer = csv.writer(sio)
    writer.writerow(headers)
    for r in bad:
        writer.writerow([
            r.excel_row_ref,
            r.excel_sheet_name,
            r.account_uid,
            r.account_number,
            r.payment_date,
            r.payment_period,
            r.amount,
            r.source_index,
            r.source_label,
            r.reason_code,
            r.reason_text,
            json.loads(r.error_details_json or "{}").get("recommendation", ""),
        ])
    return Response(
        sio.getvalue().encode("utf-8-sig"),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename=import_errors_{batch.id}.csv"},
    )


@app.get("/api/store_keys")
def store_keys():
    requested_owner = request.args.get("owner") or request.args.get("owner_id")
    owner, err = _resolve_owner(requested_owner, allow_admin_override=True)
    if err:
        return err

    rows_owner = db.session.execute(
        text("SELECT k FROM kv_store WHERE owner=:owner ORDER BY k"),
        {"owner": owner},
    ).all()
    rows_global = db.session.execute(
        text(
            "SELECT k FROM kv_store WHERE owner=:owner "
            "AND k IN ('refinancing_rates_normal_v1','refinancing_rates_moratorium_v1') ORDER BY k"
        ),
        {"owner": GLOBAL_OWNER},
    ).all()
    keys = sorted({r[0] for r in rows_owner}.union({r[0] for r in rows_global}))
    _sync_log("list_keys", owner, count=len(keys))
    return jsonify(ok=True, keys=keys, owner=owner)


@app.get("/api/store")
def store_get():
    requested_owner = request.args.get("owner") or request.args.get("owner_id")
    owner, err = _resolve_owner(requested_owner, allow_admin_override=True)
    if err:
        return err

    key = (request.args.get("key") or "").strip()
    if not key:
        return _json_error("key_required", 400)

    owner_eff = _effective_owner_for_key(owner, key)
    row = KVStore.query.filter_by(owner=owner_eff, k=key).first()
    if not row:
        _sync_log("load", owner_eff, key=key, status="not_found")
        return jsonify(ok=False, error="not_found", value=None), 404
    _sync_log("load", owner_eff, key=key, size=len(row.v or ""), status="ok")
    return jsonify(ok=True, value=row.v, owner=owner_eff)


@app.post("/api/store")
def store_set():
    data = request.get_json(silent=True) or {}
    user, user_err = _require_user()
    if user_err:
        return user_err
    owner, err = _resolve_owner(data.get("owner"), allow_admin_override=True)
    if err:
        return err

    key = (data.get("key") or "").strip()
    value = data.get("value")
    if not key:
        return _json_error("key_required", 400)
    if value is None:
        value = ""
    if not isinstance(value, str):
        return _json_error("value_must_be_string", 400)
    access_err, reason = _require_write_access_for_key(owner, key)
    if access_err:
        _log_store_forbidden(user, owner, key, reason or "forbidden")
        return access_err

    owner_eff = _effective_owner_for_key(owner, key)
    row = KVStore.query.filter_by(owner=owner_eff, k=key).first()
    if row:
        row.v = value
    else:
        db.session.add(KVStore(owner=owner_eff, k=key, v=value))
    db.session.commit()
    _sync_log("save", owner_eff, key=key, size=len(value or ""), status="ok")
    return jsonify(ok=True, owner=owner_eff)


@app.delete("/api/store")
def store_delete():
    data = request.get_json(silent=True) or {}
    user, user_err = _require_user()
    if user_err:
        return user_err
    owner, err = _resolve_owner(data.get("owner"), allow_admin_override=True)
    if err:
        return err

    key = (data.get("key") or "").strip()
    if not key:
        return _json_error("key_required", 400)
    access_err, reason = _require_write_access_for_key(owner, key)
    if access_err:
        _log_store_forbidden(user, owner, key, reason or "forbidden")
        return access_err

    owner_eff = _effective_owner_for_key(owner, key)
    row = KVStore.query.filter_by(owner=owner_eff, k=key).first()
    if not row:
        _sync_log("delete", owner_eff, key=key, status="not_found")
        return jsonify(ok=True, deleted=False)

    db.session.delete(row)
    db.session.commit()
    _sync_log("delete", owner_eff, key=key, status="ok")
    return jsonify(ok=True, deleted=True)


@app.get("/api/store_dump")
def store_dump():
    requested_owner = request.args.get("owner") or request.args.get("owner_id")
    owner, err = _resolve_owner(requested_owner, allow_admin_override=True)
    if err:
        return err

    rows_owner = db.session.execute(
        text("SELECT k, v FROM kv_store WHERE owner=:owner ORDER BY k"),
        {"owner": owner},
    ).all()
    rows_global = db.session.execute(
        text(
            "SELECT k, v FROM kv_store WHERE owner=:owner "
            "AND k IN ('refinancing_rates_normal_v1','refinancing_rates_moratorium_v1') ORDER BY k"
        ),
        {"owner": GLOBAL_OWNER},
    ).all()
    data = {r[0]: r[1] for r in rows_owner}
    for r in rows_global:
        data[r[0]] = r[1]
    _sync_log("dump", owner, keys=len(data), status="ok")
    return jsonify(ok=True, owner=owner, data=data)


@app.get("/api/admin/session_debug")
def admin_session_debug():
    user = _current_user()
    return jsonify(ok=True, session_user_id=session.get("user_id"), user=_user_payload(user) if user else None)


@app.post("/api/ref_rates/error_report")
def ref_rates_error_report():
    user, err = _require_user()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    message = str(data.get("message") or "").strip()
    if not message:
        return _json_error("message_required", 400)
    if len(message) > 2000:
        return _json_error("message_too_long", 400)

    owner, owner_err = _resolve_owner(data.get("owner"))
    if owner_err:
        return owner_err

    app.logger.warning(
        "[ref_rates][error_report] owner=%s user_id=%s role=%s message=%s",
        owner,
        user.id,
        user.role,
        message,
    )
    return jsonify(ok=True, owner=owner)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
