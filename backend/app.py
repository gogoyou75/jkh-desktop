import os
from flask import Flask, jsonify, request
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text

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
db = SQLAlchemy(app)


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


@app.get("/health")
def health():
    return jsonify(status="ok")


@app.get("/")
def index():
    return "JKH API: ok\n"


# ==========================================================
# ADMIN: init db  (создать таблицы)
# ==========================================================
@app.post("/api/admin/initdb")
def initdb():
    db.create_all()
    # фронту это не нужно, но пусть будет красиво
    return jsonify(ok=True, message="kv_store ready")


# ==========================================================
# KV API: list keys  (фронт ждёт: {ok:true, keys:[...]} )
# ==========================================================
@app.get("/api/store_keys")
def store_keys():
    owner = (request.args.get("owner") or "").strip()
    if not owner:
        return jsonify(ok=False, error="owner_required"), 400

    rows = db.session.execute(
        text("SELECT k FROM kv_store WHERE owner=:owner ORDER BY k"),
        {"owner": owner},
    ).all()

    keys = [r[0] for r in rows]
    return jsonify(ok=True, keys=keys)


# ==========================================================
# KV API: get  (фронт ждёт: {ok:true, value:"..."} )
# ==========================================================
@app.get("/api/store")
def store_get():
    owner = (request.args.get("owner") or "").strip()
    key = (request.args.get("key") or "").strip()
    if not owner:
        return jsonify(ok=False, error="owner_required"), 400
    if not key:
        return jsonify(ok=False, error="key_required"), 400

    row = KVStore.query.filter_by(owner=owner, k=key).first()
    if not row:
        return jsonify(ok=False, error="not_found", value=None), 404

    return jsonify(ok=True, value=row.v)


# ==========================================================
# KV API: set (upsert)  (фронт ждёт: {ok:true})
# ==========================================================
@app.post("/api/store")
def store_set():
    data = request.get_json(silent=True) or {}
    owner = (data.get("owner") or "").strip()
    key = (data.get("key") or "").strip()
    value = data.get("value")

    if not owner:
        return jsonify(ok=False, error="owner_required"), 400
    if not key:
        return jsonify(ok=False, error="key_required"), 400
    if value is None:
        return jsonify(ok=False, error="value_required"), 400

    # фронт шлёт raw строку (JSON-string) или null.
    # В нашей схеме v NOT NULL, поэтому null превращаем в "".
    if value is None:
        value = ""
    if not isinstance(value, str):
        return jsonify(ok=False, error="value_must_be_string"), 400

    row = KVStore.query.filter_by(owner=owner, k=key).first()
    if row:
        row.v = value
    else:
        db.session.add(KVStore(owner=owner, k=key, v=value))

    db.session.commit()
    return jsonify(ok=True)


# ==========================================================
# KV API: delete  (не обязательно, но полезно)
# ==========================================================
@app.delete("/api/store")
def store_delete():
    data = request.get_json(silent=True) or {}
    owner = (data.get("owner") or "").strip()
    key = (data.get("key") or "").strip()

    if not owner:
        return jsonify(ok=False, error="owner_required"), 400
    if not key:
        return jsonify(ok=False, error="key_required"), 400

    row = KVStore.query.filter_by(owner=owner, k=key).first()
    if not row:
        return jsonify(ok=True, deleted=False)

    db.session.delete(row)
    db.session.commit()
    return jsonify(ok=True, deleted=True)
