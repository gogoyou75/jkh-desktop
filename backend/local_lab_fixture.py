"""LOCAL_LAB-only synthetic account lifecycle. No HTTP routes are registered."""

import argparse
import json
import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, MetaData, String, Table, delete, inspect, select, text
from sqlalchemy.sql.sqltypes import Text
from werkzeug.security import generate_password_hash

from app import ENV_TYPE, User, app, db


EXPECTED_TARGET = ("mysql", 3306, "jkh_local_lab", "jkh_local")
REGISTRY = Table(
    "local_lab_fixture_runs",
    MetaData(),
    Column("run_id", String(32), primary_key=True),
    Column("user_id", String(64), nullable=False, unique=True),
    Column("email", String(255), nullable=False, unique=True),
    Column("created_at", DateTime(), nullable=False),
)
REFERENCE_COLUMNS = {
    "owner", "owner_id", "user_id", "created_by_user_id", "actor_id",
    "requested_by", "uploaded_by", "created_by", "updated_by", "email", "run_id",
}


class FixtureBlocked(RuntimeError):
    """A safety condition could not be proven."""


def normalize_run_id(value):
    try:
        parsed = uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError) as exc:
        raise FixtureBlocked("invalid_run_id") from exc
    if parsed.version != 4 or parsed.hex != str(value).lower().replace("-", ""):
        raise FixtureBlocked("invalid_run_id")
    return parsed.hex


def validate_config(env_type, url):
    if env_type != "LOCAL_LAB":
        raise FixtureBlocked("environment_is_not_LOCAL_LAB")
    target = (url.host, url.port, url.database, url.username)
    if target != EXPECTED_TARGET or url.drivername != "mysql+pymysql":
        raise FixtureBlocked("database_target_mismatch")


def validate_database_result(database, port):
    try:
        actual_port = int(port)
    except (TypeError, ValueError) as exc:
        raise FixtureBlocked("connected_database_mismatch") from exc
    if (database, actual_port) != ("jkh_local_lab", 3306):
        raise FixtureBlocked("connected_database_mismatch")


def guard_connection(connection):
    row = connection.execute(text("SELECT DATABASE(), @@port")).one()
    validate_database_result(row[0], row[1])


def guarded_engine():
    if ENV_TYPE != "LOCAL_LAB":
        raise FixtureBlocked("environment_is_not_LOCAL_LAB")
    with app.app_context():
        engine = db.engine
        validate_config(ENV_TYPE, engine.url)  # before opening any connection
        return engine


def fixture_identity(run_id):
    return {
        "id": "u_fixture_" + run_id,
        "email": "fixture-" + run_id + "@example.invalid",
        "display_name": "LOCAL_LAB fixture " + run_id,
    }


def create_records(connection, run_id, password):
    identity = fixture_identity(run_id)
    created_at = datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)
    if connection.execute(select(REGISTRY.c.run_id).where(REGISTRY.c.run_id == run_id)).first():
        raise FixtureBlocked("run_id_already_exists")
    connection.execute(User.__table__.insert().values(
        id=identity["id"],
        email=identity["email"],
        password_hash=generate_password_hash(password),
        role="user",
        display_name=identity["display_name"],
        disabled=False,
        created_at=created_at,
        last_login=None,
    ))
    connection.execute(REGISTRY.insert().values(
        run_id=run_id,
        user_id=identity["id"],
        email=identity["email"],
        created_at=created_at,
    ))
    return identity


def create_fixture(run_id):
    run_id = normalize_run_id(run_id)
    engine = guarded_engine()
    with engine.begin() as connection:
        guard_connection(connection)
        REGISTRY.create(connection, checkfirst=True)
    password = secrets.token_urlsafe(32)
    with engine.begin() as connection:
        guard_connection(connection)
        identity = create_records(connection, run_id, password)
    return {"run_id": run_id, "user_id": identity["id"], "email": identity["email"], "password": password}


def registry_exists(connection):
    return inspect(connection).has_table(REGISTRY.name)


def assert_no_unregistered_records(connection, run_id, user_id, email):
    """Never delete an account if another table refers to this fixture identity."""
    inspector = inspect(connection)
    quote = connection.dialect.identifier_preparer.quote
    for table_name in inspector.get_table_names():
        if table_name in {"users", REGISTRY.name}:
            continue
        columns = inspector.get_columns(table_name)
        foreign_keys = inspector.get_foreign_keys(table_name)
        user_fk_columns = {
            column
            for fk in foreign_keys if fk.get("referred_table") == "users"
            for column in fk.get("constrained_columns", [])
        }
        for column in columns:
            name = column["name"]
            if name not in REFERENCE_COLUMNS and name not in user_fk_columns:
                continue
            if not isinstance(column["type"], (String, Text)):
                raise FixtureBlocked("ownership_column_type_unknown")
            values = (email,) if name == "email" else (run_id,) if name == "run_id" else (
                user_id, "LAB:" + user_id, "PROD:" + user_id,
            )
            params = {"v" + str(index): value for index, value in enumerate(values)}
            placeholders = ", ".join(":" + key for key in params)
            statement = text(
                f"SELECT 1 FROM {quote(table_name)} WHERE {quote(name)} IN ({placeholders}) LIMIT 1"
            )
            if connection.execute(statement, params).first():
                raise FixtureBlocked("unregistered_owned_records")


def cleanup_records(connection, run_id):
    record = connection.execute(
        select(REGISTRY).where(REGISTRY.c.run_id == run_id).with_for_update()
    ).mappings().first()
    if record is None:
        return "absent"
    identity = fixture_identity(run_id)
    if record["user_id"] != identity["id"] or record["email"] != identity["email"]:
        raise FixtureBlocked("registry_identity_mismatch")
    user = connection.execute(
        select(User.__table__).where(User.id == record["user_id"]).with_for_update()
    ).mappings().first()
    if user is None or any((
        user["email"] != identity["email"],
        user["display_name"] != identity["display_name"],
        user["role"] != "user",
        user["created_at"] != record["created_at"],
    )):
        raise FixtureBlocked("user_ownership_unproven")
    assert_no_unregistered_records(connection, run_id, identity["id"], identity["email"])
    connection.execute(delete(User.__table__).where(User.id == identity["id"]))
    connection.execute(delete(REGISTRY).where(REGISTRY.c.run_id == run_id))
    return "deleted"


def cleanup_fixture(run_id):
    run_id = normalize_run_id(run_id)
    engine = guarded_engine()
    with engine.begin() as connection:
        guard_connection(connection)
        if not registry_exists(connection):
            return "absent"
        return cleanup_records(connection, run_id)


def fixture_status(run_id):
    run_id = normalize_run_id(run_id)
    engine = guarded_engine()
    with engine.connect() as connection:
        guard_connection(connection)
        if not registry_exists(connection):
            return "absent"
        exists = connection.execute(select(REGISTRY.c.run_id).where(REGISTRY.c.run_id == run_id)).first()
        return "present" if exists else "absent"


def pending_runs():
    engine = guarded_engine()
    with engine.connect() as connection:
        guard_connection(connection)
        if not registry_exists(connection):
            return []
        return [row[0] for row in connection.execute(select(REGISTRY.c.run_id).order_by(REGISTRY.c.created_at))]


def main():
    parser = argparse.ArgumentParser(description="LOCAL_LAB synthetic user fixture")
    parser.add_argument("action", choices=("create", "cleanup", "recover", "status", "pending"))
    parser.add_argument("--run-id")
    args = parser.parse_args()
    try:
        if args.action == "pending":
            result = {"pending_run_ids": pending_runs()}
        else:
            if not args.run_id:
                raise FixtureBlocked("run_id_required")
            if args.action == "create":
                result = create_fixture(args.run_id)
            elif args.action in ("cleanup", "recover"):
                result = {"run_id": normalize_run_id(args.run_id), "status": cleanup_fixture(args.run_id)}
            else:
                result = {"run_id": normalize_run_id(args.run_id), "status": fixture_status(args.run_id)}
        print("FIXTURE_JSON=" + json.dumps(result, separators=(",", ":")))
    except FixtureBlocked as exc:
        print("FIXTURE_BLOCKED=" + str(exc))
        return 2
    except Exception:
        # Exception details can contain SQL parameters; never print them here.
        print("FIXTURE_BLOCKED=unexpected_error")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
