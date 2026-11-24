"""CUP schema interface. Inspection is read-only; all DDL runs through Alembic.

No application import, implicit database target, automatic stamp or downgrade.
"""
from __future__ import annotations
import argparse
import ast
import base64
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal
import sqlalchemy as sa
from sqlalchemy.pool import NullPool
from maintenance_control import MaintenanceBlocked
from alembic import command
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory

BASE = Path(__file__).resolve().parent
BULK_TABLES = {"bulk_calc_verify_jobs", "bulk_calc_verify_job_items"}
REVISIONS = ("cup_5501", "cup_5502")

class Blocked(RuntimeError):
    """A safe precondition failed. Messages contain codes, never SQL or credentials."""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def model_digest(source):
    tree = ast.parse(source)
    nodes = [n for n in tree.body if
             isinstance(n, ast.ClassDef) and any(isinstance(x, ast.Assign) and
                 any(isinstance(y, ast.Name) and y.id == "__tablename__" for y in x.targets)
                 for x in n.body) or
             isinstance(n, ast.FunctionDef) and n.name == "sqlite_autoincrement_bigint_pk"]
    def stable(node):
        if isinstance(node, ast.AST):
            return {"node": type(node).__name__, "fields": {k: stable(v) for k, v in ast.iter_fields(node)}}
        if isinstance(node, list):
            return [stable(x) for x in node]
        return node
    # ast.dump changed its treatment of empty fields between Python 3.12/3.13.
    return digest([stable(n) for n in nodes])


def git_bytes(ref, path):
    if not ref or ref.startswith("-") or any(c in ref for c in "\n\r:"):
        raise Blocked("invalid_target_ref")
    result = subprocess.run(["git", "--no-optional-locks", "-C", str(BASE.parent),
                             "show", f"{ref}:{path}"], capture_output=True)
    if result.returncode:
        raise Blocked("target_has_no_schema_contract")
    return result.stdout


def load_package(target_ref=None, target_package=None):
    read = (lambda p: git_bytes(target_ref, "backend/" + p)) if target_ref else (lambda p: (BASE / p).read_bytes())
    if target_package:
        directory = Path(target_package).resolve()
        read = lambda p: (directory / p).read_bytes()
    contract = json.loads(read("schema_contract.json"))
    raw = read("alembic/schema_snapshot.json")
    if contract.get("format") != 1 or hashlib.sha256(raw).hexdigest() != contract.get("snapshot_sha256"):
        raise Blocked("invalid_schema_contract")
    if model_digest(read("app.py").decode("utf8")) != contract.get("orm_sha256"):
        raise Blocked("orm_contract_mismatch")
    if contract.get("required_revision") not in REVISIONS:
        raise Blocked("unsupported_target_revision")
    return contract, json.loads(raw)


@dataclass(frozen=True)
class Settings:
    profile: str
    host: str
    port: int
    database: str
    user: str
    password: str = field(repr=False)

    @classmethod
    def from_env(cls, profile, prefix=""):
        if profile not in {"LOCAL_LAB", "VPS_LAB", "PROD"}:
            raise Blocked("unknown_profile")
        required = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "ENV_TYPE"]
        values = {k: os.environ.get(prefix + k, "") for k in required}
        if not all(values.values()):
            raise Blocked("explicit_database_configuration_required")
        expected_env = {"LOCAL_LAB": "LOCAL_LAB", "VPS_LAB": "LAB", "PROD": "PROD"}[profile]
        if values["ENV_TYPE"] != expected_env:
            raise Blocked("profile_environment_mismatch")
        host, name = values["DB_HOST"], values["DB_NAME"]
        if profile == "LOCAL_LAB":
            if host not in {"localhost", "127.0.0.1", "mysql", "cup-schema-mysql"}:
                raise Blocked("local_host_not_local")
            if not (name == "jkh_local_lab" or name.startswith(("cup_test_", "cup_restore_"))):
                raise Blocked("local_database_not_allowlisted")
        elif host != "mysql" or name != {"VPS_LAB": "jkh_lab", "PROD": "jkh"}[profile]:
            raise Blocked("server_database_identity_mismatch")
        try:
            port = int(values["DB_PORT"])
            if not 0 < port < 65536:
                raise ValueError
        except ValueError:
            raise Blocked("invalid_database_port") from None
        return cls(profile, host, port, name, values["DB_USER"], values["DB_PASSWORD"])

    def engine(self, select_database=True):
        url = sa.URL.create("mysql+pymysql", username=self.user, password=self.password,
                            host=self.host, port=self.port, database=self.database if select_database else None,
                            query={"charset": "utf8mb4"})
        return sa.create_engine(url, poolclass=NullPool, hide_parameters=True,
                                connect_args={"connect_timeout": 8, "read_timeout": 60, "write_timeout": 60})


def norm_type(value):
    import re
    t = str(value).upper().replace("INTEGER", "INT").replace("NUMERIC", "DECIMAL")
    t = re.sub(r"\s+COLLATE\s+[A-Z0-9_]+", "", t)
    t = re.sub(r"\s+", "", t)
    t = re.sub(r"\b(INT|BIGINT|SMALLINT|MEDIUMINT)\(\d+\)", r"\1", t)
    return "BOOLEAN" if t in {"BOOL", "BOOLEAN", "TINYINT(1)"} else t


def norm_default(value):
    if value is None:
        return None
    s = str(value).strip()
    if s.upper() in {"CURRENT_TIMESTAMP", "CURRENT_TIMESTAMP()"}:
        return "CURRENT_TIMESTAMP"
    return s.strip("()'")


def index_signature(index):
    return (tuple(index.get("column_names", index.get("columns", []))), bool(index.get("unique")))


def fk_signature(fk):
    return (tuple(fk.get("constrained_columns", fk.get("columns", []))), fk["referred_table"],
            tuple(fk["referred_columns"]), (fk.get("options", {}).get("ondelete") or fk.get("ondelete") or "").upper())


def identity(connection, settings):
    if connection.dialect.name != "mysql":
        raise Blocked("mysql_required")
    name, server = connection.execute(sa.text("SELECT DATABASE(), @@server_uuid")).one()
    if name != settings.database:
        raise Blocked("connected_database_mismatch")
    return digest({"server": server, "database": name, "profile": settings.profile})


def inspect_schema(connection, package=None):
    contract, snapshot = package or load_package()
    inspector = sa.inspect(connection)
    actual_tables = set(inspector.get_table_names()) - {"alembic_version"}
    desired = snapshot["tables"]
    issues, actual = [], {}
    for name in sorted(set(desired) - actual_tables):
        issues.append({"kind": "missing_table", "table": name})
    for name in sorted(actual_tables - set(desired)):
        issues.append({"kind": "unknown_table", "table": name})
    for name in sorted(actual_tables & set(desired)):
        wanted = desired[name]
        reflected_columns = inspector.get_columns(name)
        for column in reflected_columns:
            if column.get("computed"):
                issues.append({"kind": "unknown_computed_column", "table": name, "column": column["name"]})
            collation = getattr(column["type"], "collation", None)
            if collation and collation.lower() not in contract["allowed_collations"]:
                issues.append({"kind": "unknown_collation", "table": name, "column": column["name"]})
        cols = {c["name"]: {"name": c["name"], "type": norm_type(c["type"].compile(dialect=connection.dialect)),
                "nullable": bool(c["nullable"]), "default": norm_default(c.get("default")), "autoincrement": bool(c.get("autoincrement"))}
                for c in reflected_columns}
        desired_cols = {c["name"]: {"name": c["name"], "type": norm_type(c["type"]),
                        "nullable": bool(c["nullable"]), "default": norm_default(c["default"]),
                        "autoincrement": bool(re.search(r"(?im)^\s*`?" + re.escape(c["name"]) + r"`?\s+[^,\n]*\bAUTO_INCREMENT\b", wanted["ddl"]))} for c in wanted["columns"]}
        for col in sorted(set(desired_cols) - set(cols)):
            issues.append({"kind": "missing_column", "table": name, "column": col})
        for col in sorted(set(cols) - set(desired_cols)):
            issues.append({"kind": "unknown_column", "table": name, "column": col})
        for col in sorted(set(cols) & set(desired_cols)):
            if cols[col] != desired_cols[col]:
                issues.append({"kind": "column_mismatch", "table": name, "column": col})
        options = inspector.get_table_options(name)
        engine = options.get("mysql_engine", "")
        if engine.lower() != "innodb":
            issues.append({"kind": "unsupported_engine", "table": name})
        checks = inspector.get_check_constraints(name)
        if checks:
            issues.append({"kind": "unknown_check_constraint", "table": name})
        pk = inspector.get_pk_constraint(name).get("constrained_columns") or []
        if pk != wanted["pk"]:
            issues.append({"kind": "primary_key_mismatch", "table": name})
        reflected_indexes = inspector.get_indexes(name)
        for index in reflected_indexes:
            options = index.get("dialect_options", {})
            if options.get("mysql_length") or options.get("mysql_prefix") or index.get("column_sorting"):
                issues.append({"kind": "unsupported_index_details", "table": name})
        indexes = set(index_signature(x) for x in reflected_indexes)
        expected_indexes = set(index_signature(x) for x in wanted["indexes"])
        for signature in expected_indexes - indexes:
            issues.append({"kind": "missing_index", "table": name, "columns": list(signature[0])})
        reflected_fks = inspector.get_foreign_keys(name)
        for fk in reflected_fks:
            if fk.get("referred_schema") not in {None, connection.engine.url.database}:
                issues.append({"kind": "cross_schema_foreign_key", "table": name})
            if (fk.get("options", {}).get("onupdate") or "RESTRICT").upper() not in {"RESTRICT", "NO ACTION"}:
                issues.append({"kind": "unknown_foreign_key_rule", "table": name})
        fks = set(fk_signature(x) for x in reflected_fks)
        expected_fks = set(fk_signature(x) for x in wanted["foreign_keys"])
        if fks != expected_fks:
            issues.append({"kind": "foreign_key_mismatch", "table": name})
        # MySQL creates supporting indexes for foreign keys automatically.
        permitted_implicit = {tuple(x[0]) for x in expected_fks}
        for signature in indexes - expected_indexes:
            if signature[0] not in permitted_implicit or signature[1]:
                issues.append({"kind": "unknown_index", "table": name, "columns": list(signature[0])})
        actual[name] = {"columns": cols, "engine": engine, "collations": {c["name"]: getattr(c["type"], "collation", None) for c in reflected_columns}, "checks": checks, "pk": pk, "indexes": sorted((list(k), v) for k, v in indexes),
                        "foreign_keys": sorted((list(a), b, list(c), d) for a, b, c, d in fks)}
    if inspector.get_view_names():
        issues.append({"kind": "unsupported_views"})
    for source in ("TRIGGERS", "ROUTINES"):
        schema_column = "TRIGGER_SCHEMA" if source == "TRIGGERS" else "ROUTINE_SCHEMA"
        if connection.execute(sa.text(f"SELECT COUNT(*) FROM information_schema.{source} WHERE {schema_column}=DATABASE()")).scalar_one():
            issues.append({"kind": "unsupported_" + source.lower()})
    heads = list(MigrationContext.configure(connection).get_current_heads())
    state = {"tables": actual, "table_names": sorted(actual_tables), "revisions": heads, "issues": issues}
    return {**state, "fingerprint": digest(state), "required_revision": contract["required_revision"],
            "current_revision": heads[0] if len(heads) == 1 else ("UNVERSIONED" if not heads else "MULTIPLE_HEADS")}


def approved_variant(state, contract):
    empty = not state["table_names"]
    for issue in state["issues"]:
        if issue["kind"] == "missing_table" and (empty or issue["table"] in contract["known_missing_tables"]):
            continue
        if issue["kind"] == "missing_column" and issue["column"] in contract["known_missing_columns"].get(issue["table"], []):
            continue
        return False
    return True


def alembic_config(connection, restore_counters=None):
    cfg = Config(str(BASE / "alembic.ini"))
    cfg.set_main_option("script_location", str(BASE / "alembic"))
    cfg.attributes.update(connection=connection, schema_control_authorized=True, restore_counters=restore_counters or {})
    return cfg


def migration_fingerprint():
    cfg = Config(str(BASE / "alembic.ini"))
    cfg.set_main_option("script_location", str(BASE / "alembic"))
    script = ScriptDirectory.from_config(cfg)
    revisions = {r.revision: r.down_revision for r in script.walk_revisions()}
    if script.get_heads() != ["cup_5502"] or revisions != {"cup_5501": None, "cup_5502": "cup_5501"}:
        raise Blocked("migration_graph_invalid")
    paths = [BASE / "schema_control.py", BASE / "maintenance_control.py", BASE / "alembic.ini", BASE / "alembic/env.py", *sorted((BASE / "alembic/versions").glob("*.py"))]
    return digest({str(p.relative_to(BASE)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths})


def ordered_tables(snapshot):
    remaining = dict(snapshot["tables"])
    done = []
    while remaining:
        ready = sorted(n for n, t in remaining.items() if all(f["referred_table"] == n or f["referred_table"] in done for f in t["foreign_keys"]))
        if not ready:
            raise Blocked("snapshot_dependency_cycle")
        for n in ready:
            done.append(n)
            remaining.pop(n)
    return done


def migrate_tables(op, bulk, frozen_hash):
    raw = (BASE / "alembic/schema_snapshot.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != frozen_hash:
        raise Blocked("historical_snapshot_modified")
    package = load_package()
    state = inspect_schema(op.get_bind(), package)
    if not approved_variant(state, package[0]):
        raise Blocked("unknown_schema_drift")
    snapshot = package[1]
    for name in ordered_tables(snapshot):
        if (name in BULK_TABLES) != bulk:
            continue
        if name not in state["table_names"]:
            table = snapshot["tables"][name]
            op.execute(sa.text(table["ddl"]))
            for ddl in table["index_ddl"]:
                op.execute(sa.text(ddl))
            # Only the explicitly empty restore database receives backup counters.
            counter = op.get_context().config.attributes.get("restore_counters", {}).get(name)
            if counter is not None:
                if type(counter) is not int or counter < 1 or not re.search(r"\bAUTO_INCREMENT\b", table["ddl"]):
                    raise Blocked("invalid_restore_counter")
                op.execute(sa.text("ALTER TABLE `" + name + "` AUTO_INCREMENT=" + str(counter)))
    if not bulk and any(x == {"kind": "missing_column", "table": "kv_store", "column": "version"} for x in state["issues"]):
        op.add_column("kv_store", sa.Column("version", sa.BigInteger(), nullable=False, server_default=sa.text("0")))


@contextmanager
def migration_lock(connection, settings):
    key = "cup-schema:" + settings.database
    if connection.execute(sa.text("SELECT GET_LOCK(:key, 0)"), {"key": key}).scalar_one() != 1:
        raise Blocked("migration_lock_busy")
    failed = False
    try:
        yield
    except BaseException:
        failed = True
        connection.rollback()
        raise
    finally:
        try:
            released = connection.execute(sa.text("SELECT RELEASE_LOCK(:key)"), {"key": key}).scalar_one()
            connection.commit()
            if released != 1:
                raise Blocked("migration_lock_release_failed")
        except Exception:
            connection.invalidate()
            if not failed:
                raise


def private_write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    data = (canonical(value) + "\n").encode()
    with path.open("xb") as file:
        os.chmod(path, 0o600)
        file.write(data)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf8"))


def encode_value(value):
    if isinstance(value, (dict, list)):
        return {"$json": value}
    if isinstance(value, bytes):
        return {"$bytes": base64.b64encode(value).decode()}
    if isinstance(value, Decimal):
        return {"$decimal": str(value)}
    if isinstance(value, datetime):
        return {"$datetime": value.isoformat()}
    if isinstance(value, date):
        return {"$date": value.isoformat()}
    return value


def decode_value(value):
    if isinstance(value, dict) and len(value) == 1:
        key, raw = next(iter(value.items()))
        if key == "$json": return raw
        if key == "$sql_null": return sa.null()
        if key == "$json_null": return sa.JSON.NULL
        if key == "$bytes": return base64.b64decode(raw)
        if key == "$decimal": return Decimal(raw)
        if key == "$datetime": return datetime.fromisoformat(raw)
        if key == "$date": return date.fromisoformat(raw)
    return value


def auto_increment_counters(connection, table_names):
    counters = {}
    for name in table_names:
        # Names come from the verified frozen contract, never user input.
        ddl = connection.exec_driver_sql("SHOW CREATE TABLE `" + name + "`").one()[1]
        if re.search(r"\bAUTO_INCREMENT\b", ddl):
            match = re.search(r"\bAUTO_INCREMENT=(\d+)", ddl)
            counters[name] = int(match.group(1)) if match else 1
    return counters


def data_records(connection, table_names, columns=None):
    for name in table_names:
        table = sa.Table(name, sa.MetaData(), autoload_with=connection)
        selected = [table.c[n] for n in columns[name]] if columns else list(table.columns)
        json_columns = [column for column in selected if isinstance(column.type, sa.JSON)]
        markers = [column.is_(None).label("__cup_null_" + column.name) for column in json_columns]
        statement = sa.select(*selected, *markers).order_by(*table.primary_key.columns)
        for row in connection.execute(statement).mappings():
            values = {column.name: encode_value(row[column.name]) for column in selected}
            for column in json_columns:
                if row[column.name] is None:
                    values[column.name] = {"$sql_null": True} if row["__cup_null_" + column.name] else {"$json_null": True}
            yield {"table": name, "row": values}


class Controller:
    def __init__(self, settings, state_dir=None, fence=None):
        self.fence_override = fence
        self.settings = settings
        self.engine = settings.engine()
        self.state_dir = Path(state_dir or os.environ.get("CUP_SCHEMA_STATE_DIR", str(BASE.parent / ".schema-state")))

    def fence(self):
        from maintenance_control import Fence
        return self.fence_override or Fence(self.settings, self.state_dir)

    @contextmanager
    def protected(self):
        from maintenance_control import Borrowed, MaintenanceBlocked
        guard = None
        original = self.engine
        try:
            guard = self.fence()
            with guard.session() as connection:
                self.engine = Borrowed(connection)
                yield
        except MaintenanceBlocked as exc:
            raise Blocked(str(exc)) from None
        finally:
            self.engine = original
            if self.fence_override is None and guard is not None: guard.dispose()

    def maintenance_begin(self):
        guard = self.fence()
        try: return guard.begin()
        finally:
            if self.fence_override is None and guard is not None: guard.dispose()

    def maintenance_resume(self):
        guard = self.fence()
        original = self.engine
        def verify(engine):
            self.engine = engine
            return self.check()
        try: return guard.resume(verify)
        finally:
            self.engine = original
            if self.fence_override is None and guard is not None: guard.dispose()

    def journal(self, event, status, **fields):
        allowed = {"plan_id", "revision", "error_type", "backup_id"}
        for key in ("plan_id", "backup_id"):
            if key in fields:
                value = fields[key]
                size = 64 if key == "plan_id" else 24
                if not isinstance(value, str) or len(value) != size or any(c not in "0123456789abcdef" for c in value):
                    fields[key] = "invalid"
        record = {"time": datetime.now(timezone.utc).isoformat(), "profile": self.settings.profile,
                  "event": event, "status": status, **{k: v for k, v in fields.items() if k in allowed}}
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (self.state_dir / "journal.jsonl").open("a", encoding="utf8") as file:
            os.chmod(file.name, 0o600)
            file.write(canonical(record) + "\n")

    @contextmanager
    def diagnostic_connection(self):
        from maintenance_control import Borrowed
        if isinstance(self.engine, Borrowed):
            with self.engine.connect() as c: yield c
            return
        guard = self.fence()
        try:
            with guard.inspection() as c: yield c
        except MaintenanceBlocked as exc:
            raise Blocked(str(exc)) from None
        finally:
            if self.fence_override is None: guard.dispose()

    def diagnose(self, target_ref=None, target_package=None):
        package = load_package(target_ref, target_package)
        with self.diagnostic_connection() as connection:
            database_id = identity(connection, self.settings)
            state = inspect_schema(connection, package)
        return {**state, "database_id": database_id, "profile": self.settings.profile}

    def check(self, target_ref=None, target_package=None):
        state = self.diagnose(target_ref, target_package)
        if state["issues"] or state["revisions"] != [state["required_revision"]]:
            raise Blocked("backend_schema_incompatible")
        return {"status": "SUCCESS", "revision": state["required_revision"]}

    def plan(self):
        contract, snapshot = load_package()
        state = self.diagnose()
        heads = state["revisions"]
        if len(heads) > 1 or any(x not in REVISIONS for x in heads):
            raise Blocked("unknown_revision")
        if not approved_variant(state, contract):
            raise Blocked("unknown_schema_drift")
        if heads == [contract["required_revision"]] and state["issues"]:
            raise Blocked("revision_schema_mismatch")
        action = "noop" if heads == [contract["required_revision"]] else ("upgrade" if heads else "adopt-or-create")
        plan = {"format": 1, "profile": self.settings.profile, "database_id": state["database_id"],
                "before_fingerprint": state["fingerprint"], "required_revision": contract["required_revision"],
                "contract_id": digest(contract), "migration_id": migration_fingerprint(), "created_at": int(time.time()), "action": action,
                "missing_objects": state["issues"]}
        plan["plan_id"] = digest(plan)
        return plan

    def backup(self, restore_settings):
        try:
            with self.protected():
                return self._backup(restore_settings)
        except Exception as exc:
            self.journal("backup", "BLOCKED" if isinstance(exc, (Blocked, MaintenanceBlocked)) else "ERROR", error_type=type(exc).__name__)
            raise

    def _backup(self, restore_settings):
        if restore_settings.profile != "LOCAL_LAB" or not restore_settings.database.startswith("cup_restore_"):
            raise Blocked("explicit_isolated_restore_database_required")
        contract, snapshot = load_package()
        source = self.diagnose()
        if not approved_variant(source, contract):
            raise Blocked("unknown_schema_drift")
        backup_id = hashlib.sha256(os.urandom(32)).hexdigest()[:24]
        path = self.state_dir / "backups" / (backup_id + ".jsonl")
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tables = [t for t in ordered_tables(snapshot) if t in source["table_names"]]
        source_columns = {name: sorted(source["tables"][name]["columns"]) for name in tables}
        records_hash = hashlib.sha256()
        with self.engine.connect().execution_options(isolation_level="REPEATABLE READ") as connection:
            if identity(connection, self.settings) != source["database_id"]:
                raise Blocked("backup_identity_changed")
            source_server = connection.execute(sa.text("SELECT @@server_uuid")).scalar_one()
            counters = auto_increment_counters(connection, tables)
            with path.open("xb") as file:
                os.chmod(path, 0o600)
                file.write((canonical({"format": 1, "database_id": source["database_id"], "tables": tables,
                                       "before_fingerprint": source["fingerprint"], "columns": source_columns, "auto_increment": counters}) + "\n").encode())
                for record in data_records(connection, tables, source_columns):
                    data = (canonical(record) + "\n").encode()
                    records_hash.update(data)
                    file.write(data)
            if inspect_schema(connection)["fingerprint"] != source["fingerprint"] or auto_increment_counters(connection, tables) != counters:
                raise Blocked("schema_changed_during_backup")
        restore_engine = restore_settings.engine()
        try:
            with restore_engine.connect() as connection:
                restore_id = identity(connection, restore_settings)
                restore_server = connection.execute(sa.text("SELECT @@server_uuid")).scalar_one()
                if self.settings.profile != "LOCAL_LAB" and source_server == restore_server:
                    raise Blocked("server_backup_requires_separate_restore_server")
                if restore_id == source["database_id"] or sa.inspect(connection).get_table_names():
                    raise Blocked("restore_target_must_be_empty_and_distinct")
                command.upgrade(alembic_config(connection, restore_counters=counters), contract["required_revision"])
                connection.commit()
                metadata = sa.MetaData()
                with path.open(encoding="utf8") as file:
                    next(file)
                    for line in file:
                        record = json.loads(line)
                        table = metadata.tables.get(record["table"])
                        if table is None:
                            table = sa.Table(record["table"], metadata, autoload_with=connection)
                        connection.execute(table.insert().values(**{k: decode_value(v) for k, v in record["row"].items()}))
                connection.commit()
                restored_hash = hashlib.sha256()
                for record in data_records(connection, tables, source_columns):
                    restored_hash.update((canonical(record) + "\n").encode())
                if restored_hash.hexdigest() != records_hash.hexdigest() or inspect_schema(connection)["issues"] or auto_increment_counters(connection, tables) != counters:
                    raise Blocked("backup_restore_verification_failed")
        finally:
            restore_engine.dispose()
        receipt = {"format": 1, "backup_id": backup_id, "database_id": source["database_id"],
                   "before_fingerprint": source["fingerprint"], "data_sha256": records_hash.hexdigest(),
                   "tables": tables, "columns": source_columns, "auto_increment": counters, "file_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                   "validated_restore": True, "created_at": int(time.time())}
        private_write(path.with_suffix(".receipt.json"), receipt)
        self.journal("backup", "SUCCESS", backup_id=backup_id)
        return receipt

    def apply(self, plan, backup_id, confirmation, maintenance=False):
        try:
            with self.protected():
                return self._apply(plan, backup_id, confirmation, maintenance)
        except Exception as exc:
            self.journal("migration", "BLOCKED" if isinstance(exc, (Blocked, MaintenanceBlocked)) else "ERROR",
                         plan_id=plan.get("plan_id", "invalid"), error_type=type(exc).__name__)
            raise

    def _apply(self, plan, backup_id, confirmation, maintenance):
        check_plan = dict(plan)
        identifier = check_plan.pop("plan_id", None)
        contract, snapshot = load_package()
        if identifier != digest(check_plan) or plan.get("contract_id") != digest(contract) or plan.get("migration_id") != migration_fingerprint():
            raise Blocked("plan_modified_or_contract_changed")
        if plan["profile"] != self.settings.profile or plan["required_revision"] != contract["required_revision"]:
            raise Blocked("plan_profile_or_revision_mismatch")
        if not 0 <= time.time() - plan["created_at"] <= 900:
            raise Blocked("plan_expired")
        if confirmation != f"APPLY {self.settings.profile} {identifier}":
            raise Blocked("owner_confirmation_required")
        with self.engine.connect() as connection:
            database_id = identity(connection, self.settings)
            if database_id != plan["database_id"]:
                raise Blocked("plan_database_mismatch")
            with migration_lock(connection, self.settings):
                state = inspect_schema(connection)
                if state["fingerprint"] != plan["before_fingerprint"]:
                    raise Blocked("schema_changed_since_plan")
                if plan["action"] == "noop":
                    if state["issues"] or state["revisions"] != [contract["required_revision"]]:
                        raise Blocked("invalid_noop")
                    self.journal("migration", "SUCCESS", plan_id=identifier, revision=contract["required_revision"])
                    return {"status": "SUCCESS", "revision": contract["required_revision"], "changed": False}
                if not approved_variant(state, contract):
                    raise Blocked("unknown_schema_drift")
                if not backup_id or not all(c in "0123456789abcdef" for c in backup_id) or len(backup_id) != 24:
                    raise Blocked("validated_backup_required")
                path = self.state_dir / "backups" / (backup_id + ".jsonl")
                receipt = read_json(path.with_suffix(".receipt.json"))
                if not receipt.get("validated_restore") or receipt["database_id"] != database_id or receipt["before_fingerprint"] != state["fingerprint"] or hashlib.sha256(path.read_bytes()).hexdigest() != receipt["file_sha256"]:
                    raise Blocked("backup_does_not_match_plan")
                original_hash = hashlib.sha256()
                for record in data_records(connection, receipt["tables"], receipt["columns"]):
                    original_hash.update((canonical(record) + "\n").encode())
                if original_hash.hexdigest() != receipt["data_sha256"] or auto_increment_counters(connection, receipt["tables"]) != receipt["auto_increment"]:
                    raise Blocked("data_changed_since_backup")
                connection.commit()
                command.upgrade(alembic_config(connection), contract["required_revision"])
                connection.commit()
                after = inspect_schema(connection)
                if after["issues"] or after["revisions"] != [contract["required_revision"]]:
                    raise Blocked("post_migration_schema_mismatch")
                after_hash = hashlib.sha256()
                for record in data_records(connection, receipt["tables"], receipt["columns"]):
                    after_hash.update((canonical(record) + "\n").encode())
                if after_hash.hexdigest() != receipt["data_sha256"] or auto_increment_counters(connection, receipt["tables"]) != receipt["auto_increment"]:
                    raise Blocked("post_migration_data_changed")
        self.journal("migration", "SUCCESS", plan_id=identifier, revision=contract["required_revision"])
        return {"status": "SUCCESS", "revision": contract["required_revision"], "changed": True}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["diagnose", "versions", "migrations", "plan", "backup", "apply", "check", "journal", "maintenance-begin", "maintenance-plan", "maintenance-resume"])
    parser.add_argument("--profile", required=True, choices=["LOCAL_LAB", "VPS_LAB", "PROD"])
    parser.add_argument("--target-ref")
    parser.add_argument("--target-package")
    parser.add_argument("--output")
    parser.add_argument("--plan")
    parser.add_argument("--backup-id")
    parser.add_argument("--confirmation")
    parser.add_argument("--maintenance-confirmed", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.maintenance_confirmed:
            raise Blocked("legacy_maintenance_confirmation_not_accepted")
        if args.action == "migrations":
            cfg = Config(str(BASE / "alembic.ini"))
            cfg.set_main_option("script_location", str(BASE / "alembic"))
            script = ScriptDirectory.from_config(cfg)
            result = {"status": "SUCCESS", "revisions": [r.revision for r in script.walk_revisions()]}
        else:
            controller = Controller(Settings.from_env(args.profile))
            if args.action == "maintenance-begin":
                if args.confirmation != "FENCE " + args.profile: raise Blocked("owner_confirmation_required")
                result = controller.maintenance_begin()
            elif args.action == "maintenance-resume":
                if args.confirmation != "RESUME " + args.profile: raise Blocked("owner_confirmation_required")
                result = controller.maintenance_resume()
            elif args.action == "maintenance-plan":
                with controller.protected(): result = controller.plan()
                if args.output: private_write(args.output, result)
            elif args.action in {"diagnose", "versions"}:
                result = controller.diagnose(args.target_ref, args.target_package)
            elif args.action == "check": result = controller.check(args.target_ref, args.target_package)
            elif args.action == "plan":
                result = controller.plan()
                if args.output: private_write(args.output, result)
            elif args.action == "backup":
                result = controller.backup(Settings.from_env("LOCAL_LAB", "RESTORE_"))
            elif args.action == "apply":
                if not args.plan: raise Blocked("plan_file_required")
                result = controller.apply(read_json(args.plan), args.backup_id, args.confirmation, args.maintenance_confirmed)
            else:
                path = controller.state_dir / "journal.jsonl"
                result = {"events": [json.loads(x) for x in path.read_text(encoding="utf8").splitlines()] if path.exists() else []}
        print(canonical(result))
        return 0
    except (Blocked, MaintenanceBlocked) as exc:
        print(canonical({"status": "BLOCKED", "reason": str(exc)}))
        return 2
    except Exception as exc:
        # SQLAlchemy exception strings may contain SQL parameters or credentials.
        print(canonical({"status": "ERROR", "reason": "operation_failed", "error_type": type(exc).__name__}))
        return 1

if __name__ == "__main__":
    # Alembic revisions must share the same exception class and policy module.
    sys.modules.setdefault("schema_control", sys.modules[__name__])
    raise SystemExit(main())
