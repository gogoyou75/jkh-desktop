import os
import uuid
import secrets
from datetime import datetime

from flask import Flask, jsonify, request, session
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text
from werkzeug.security import generate_password_hash, check_password_hash

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


def _resolve_owner(explicit_owner: str | None = None):
    user, err = _require_user()
    if err:
        return None, err
    # SECURITY: owner всегда берётся только из серверной сессии.
    # Любые owner из query/body намеренно игнорируем.
    _ = explicit_owner
    return user.id, None


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
    db.create_all()

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
    return jsonify(ok=True, user=_user_payload(user))


@app.get("/api/auth/me")
def auth_me():
    user = _current_user()
    if not user:
        return _json_error("not_authenticated", 401)
    return jsonify(ok=True, user=_user_payload(user))


@app.post("/api/auth/logout")
def auth_logout():
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


@app.get("/api/store_keys")
def store_keys():
    owner, err = _resolve_owner(request.args.get("owner"))
    if err:
        return err

    rows = db.session.execute(
        text("SELECT k FROM kv_store WHERE owner=:owner ORDER BY k"),
        {"owner": owner},
    ).all()
    app.logger.info("store_keys owner=%s count=%s", owner, len(rows))
    return jsonify(ok=True, keys=[r[0] for r in rows], owner=owner)


@app.get("/api/store")
def store_get():
    owner, err = _resolve_owner(request.args.get("owner"))
    if err:
        return err

    key = (request.args.get("key") or "").strip()
    if not key:
        return _json_error("key_required", 400)

    row = KVStore.query.filter_by(owner=owner, k=key).first()
    if not row:
        app.logger.info("store_get owner=%s key=%s status=not_found", owner, key)
        return jsonify(ok=False, error="not_found", value=None), 404
    app.logger.info("store_get owner=%s key=%s size=%s status=ok", owner, key, len(row.v or ""))
    return jsonify(ok=True, value=row.v, owner=owner)


@app.post("/api/store")
def store_set():
    data = request.get_json(silent=True) or {}
    owner, err = _resolve_owner(data.get("owner"))
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

    row = KVStore.query.filter_by(owner=owner, k=key).first()
    if row:
        row.v = value
    else:
        db.session.add(KVStore(owner=owner, k=key, v=value))
    db.session.commit()
    app.logger.info("store_set owner=%s key=%s size=%s status=ok", owner, key, len(value or ""))
    return jsonify(ok=True, owner=owner)


@app.delete("/api/store")
def store_delete():
    data = request.get_json(silent=True) or {}
    owner, err = _resolve_owner(data.get("owner"))
    if err:
        return err

    key = (data.get("key") or "").strip()
    if not key:
        return _json_error("key_required", 400)

    row = KVStore.query.filter_by(owner=owner, k=key).first()
    if not row:
        return jsonify(ok=True, deleted=False)

    db.session.delete(row)
    db.session.commit()
    return jsonify(ok=True, deleted=True)


@app.get("/api/admin/session_debug")
def admin_session_debug():
    user = _current_user()
    return jsonify(ok=True, session_user_id=session.get("user_id"), user=_user_payload(user) if user else None)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
