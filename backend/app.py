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
from sqlalchemy.exc import IntegrityError
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


def _json_error(error: str, code: int):
    return jsonify(ok=False, error=error), code


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


def payment_fingerprint(account_uid, paid_date, amount):
    uid_norm = normalize_uid(account_uid)
    paid_date_norm = normalize_paid_date(paid_date)
    amount_norm = normalize_amount(amount)
    raw = "|".join([
        uid_norm,
        paid_date_norm,
        amount_norm,
    ])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def build_payment_fingerprint(owner_id, account_uid, account_number, paid_date, amount, source_index, payment_period):
    return payment_fingerprint(account_uid, paid_date, amount)


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


@app.get("/health")
def health():
    return jsonify(status="ok")


@app.get("/")
def index():
    return "JKH API: ok\n"


@app.post("/api/admin/initdb")
def initdb():
    db.create_all()
    return jsonify(ok=True, message="users + kv_store ready")


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
        payment_period = _norm_period(src.get("payment_period"))
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
        header_map = _parse_header_map(values[0])
        missing = sorted(IMPORT_REQUIRED_COLUMNS.difference(set(header_map.keys())))
        if missing:
            missing_columns.update(missing)
            continue
        for idx in range(2, len(values) + 1):
            line = values[idx - 1]
            if all(_norm_text(v) == "" for v in line if v is not None):
                continue
            row_no += 1
            account_uid = _norm_text(_find_cell(header_map, line, "account_uid", "uid", "лс", "ls"))
            abonent_id = _norm_text(_find_cell(header_map, line, "abonent_id", "абонент"))
            account_number = _norm_text(_find_cell(header_map, line, "account_number", "лицевой счет", "лицевой_счет"))
            payment_date = _norm_date(_find_cell(header_map, line, "payment_date", "paid_date", "дата"))
            payment_period = _norm_period(_find_cell(header_map, line, "payment_period", "period", "период"))
            amount = _norm_amount(_find_cell(header_map, line, "amount", "sum", "сумма"))
            src_index_raw = _find_cell(header_map, line, "source_index", "source")
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
            r.reason_code = "PAYMENT_PERIOD_INVALID"
            r.reason_text = "Некорректный период платежа"
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
                    ledger = []
                    if kv and kv.v:
                        try:
                            loaded = json.loads(kv.v)
                            ledger = loaded if isinstance(loaded, list) else []
                        except Exception:
                            ledger = []

                    classification = _classify_payment(r.account_uid, r.paid_date, r.amount, ledger)
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
    not_ready = [r for r in rows if r.status != "ready"]
    if not_ready:
        return jsonify(
            ok=False,
            error="non_ready_rows_present",
            details={"count": len(not_ready)},
        ), 400
    applied_count = skipped_count = duplicate_count = conflict_count = failed_count = 0
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
                    details_json=json.dumps({"account_uid": r.account_uid, "payment_date": r.paid_date or r.payment_date, "amount": r.amount, "result": "SKIPPED", "reason_code": r.reason_code, "reason_text": r.reason_text}, ensure_ascii=False),
                ))
                continue

            normalized_uid = normalize_uid(r.account_uid)
            normalized_account_number = normalize_account_number(r.account_number)
            normalized_paid_date = normalize_paid_date(r.paid_date or r.payment_date)
            normalized_period = normalize_payment_period(r.payment_period)
            normalized_amount = normalize_amount(r.amount)
            normalized_source_index = normalize_source_index(r.source_index)
            fingerprint = payment_fingerprint(normalized_uid, normalized_paid_date, normalized_amount)

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
                    details_json=json.dumps({"account_uid": normalized_uid, "payment_date": normalized_paid_date, "amount": normalized_amount, "result": "DUPLICATE", "reason_code": r.reason_code, "fingerprint": fingerprint}, ensure_ascii=False),
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
            if source_kv and source_kv.v:
                try:
                    ledger = json.loads(source_kv.v)
                    if not isinstance(ledger, list):
                        ledger = []
                except Exception:
                    ledger = []

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
                details_json=json.dumps({"account_uid": normalized_uid, "payment_date": normalized_paid_date, "amount": normalized_amount, "result": "APPLIED", "payment_id": payment_id, "fingerprint": fingerprint}, ensure_ascii=False),
            ))
            applied_count += 1

        batch.rows_applied = applied_count
        batch.rows_skipped = duplicate_count + conflict_count + skipped_count
        batch.error_message = ""
        batch.status = "applied"
        batch.finished_at = datetime.utcnow()
        if batch.uploaded_at and app.config["IMPORT_UPLOAD_BLOB_TTL_DAYS"] <= 0:
            batch.upload_blob = b""
        db.session.commit()
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
