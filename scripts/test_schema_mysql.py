"""Run disposable MySQL tests from repository root; no application DB is selected."""
from pathlib import Path
import argparse
import json
import os
import secrets
import subprocess
import time
import re

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / ".var/cup-v55"

def docker(*args, **kwargs):
    endpoint = "npipe:////./pipe/dockerDesktopLinuxEngine" if os.name == "nt" else "unix:///var/run/docker.sock"
    if not os.environ.get("DOCKER_HOST", endpoint).startswith(("npipe:", "unix:")):
        raise RuntimeError("Only local Docker is permitted")
    return subprocess.run(["docker", "--host", endpoint, *args], check=True, capture_output=True, **kwargs)


def verify(f):
    if not f["container"].startswith("cup-v55-mysql-") or not f["network"].startswith("cup-v55-net-"):
        raise RuntimeError("Not a CUP fixture")
    c = json.loads(docker("inspect", f["container"]).stdout)[0]
    n = json.loads(docker("network", "inspect", f["network"]).stdout)[0]
    if c["Config"].get("Labels", {}).get("cup.test") != "v55" or n.get("Labels", {}).get("cup.test") != "v55":
        raise RuntimeError("Fixture labels mismatch")
    if not n.get("Internal") or c["HostConfig"].get("PortBindings") or not c["HostConfig"].get("Tmpfs", {}).get("/var/lib/mysql"):
        raise RuntimeError("Fixture not isolated")
    return c["Id"], n["Id"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-config", type=Path)
    parser.add_argument("--suite", choices=["schema", "maintenance", "profiles", "legacy", "workflow"], default="schema")
    parser.add_argument("--case")
    parser.add_argument("--mysql-image", choices=["mysql:8.0", "mysql:8.0.45"], default="mysql:8.0.45")
    args = parser.parse_args()
    if args.case and (args.suite not in {'maintenance','legacy','workflow'} or not re.fullmatch(r'test_[a-z0-9_]+',args.case)): parser.error('case must select a maintenance test method')
    STATE.mkdir(parents=True, exist_ok=True)
    created = args.fixture_config is None
    if created:
        suffix = secrets.token_hex(4)
        f = dict(container="cup-v55-mysql-" + suffix, network="cup-v55-net-" + suffix,
                 image="cup-v55-api:" + suffix, password="synthetic_only" if args.suite == "profiles" else secrets.token_hex(24))
        env_file = STATE / ("mysql-" + suffix + ".env")
        initial = "MYSQL_ROOT_PASSWORD=" + f["password"] + "\n"
        if args.suite == "schema": initial += "MYSQL_DATABASE=jkh_local_lab\nMYSQL_USER=jkh_local\nMYSQL_PASSWORD=" + f["password"] + "\n"
        env_file.write_text(initial, encoding="utf8")
        os.chmod(env_file, 0o600)
        docker("network", "create", "--internal", "--label", "cup.test=v55", f["network"])
        docker("run", "-d", "--name", f["container"], "--label", "cup.test=v55", "--network", f["network"], "--network-alias", "mysql",
               "--tmpfs", "/var/lib/mysql:rw,nosuid,size=1073741824", "--env-file", str(env_file), args.mysql_image, "--skip-log-bin", "--event-scheduler=DISABLED", "--innodb-buffer-pool-size=64M")
    else:
        path = args.fixture_config.resolve()
        if not path.is_relative_to(STATE.resolve()):
            raise RuntimeError("Fixture config must be in ignored CUP state directory")
        f = json.loads(path.read_text(encoding="utf8"))
    container_id, network_id = verify(f)
    restore_id = None
    try:
        if args.suite in {"maintenance", "legacy", "workflow"}:
            restored = docker("run", "-d", "--name", f["container"] + "-restore", "--label", "cup.test=v55", "--network", f["network"], "--network-alias", "cup-schema-mysql",
                              "--tmpfs", "/var/lib/mysql:rw,nosuid,size=1073741824", "--env-file", str(env_file), args.mysql_image, "--skip-log-bin", "--event-scheduler=DISABLED", "--innodb-buffer-pool-size=64M")
            restore_id = restored.stdout.decode().strip()
        if created:
            print("Building disposable Python test image", flush=True)
            docker("build", "-t", f["image"], "-f", "backend/Dockerfile", "backend", cwd=ROOT)
        for attempt in range(60):
            try:
                docker("exec", f["container"], "sh", "-c", 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqladmin --host=127.0.0.1 --protocol=TCP --user=root ping --silent')
                if restore_id:
                    docker("exec", restore_id, "sh", "-c", 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqladmin --host=127.0.0.1 --protocol=TCP --user=root ping --silent')
                break
            except subprocess.CalledProcessError:
                time.sleep(1)
        else:
            raise RuntimeError("Disposable MySQL not ready")
        env = STATE / ("test-" + container_id[:12] + ".env")
        env.write_text("DB_HOST=mysql\nDB_PORT=3306\nDB_NAME=jkh_local_lab\nDB_USER=jkh_local\nDB_PASSWORD=" + f["password"] +
                       "\nENV_TYPE=LOCAL_LAB\nSECRET_KEY=" + secrets.token_hex(32) + "\nCUP_ISOLATED_MYSQL=1\nPYTHONPATH=/work/backend:/work\nPYTHONDONTWRITEBYTECODE=1\n", encoding="utf8")
        if args.suite == "profiles":
            with env.open("a", encoding="utf8") as file:
                file.write("ENV_TYPE=PROD\nNO_NAME_TEST_MYSQL_URL=mysql+pymysql://root:synthetic_only@127.0.0.1:3306/\n")
        os.chmod(env, 0o600)
        tests = {"schema": ["backend.tests.test_schema_control_mysql"],
                 "maintenance": ["backend.tests.test_maintenance_mysql"],
                 "legacy": ["backend.tests.test_legacy_schema_mysql"],
                 "workflow": ["backend.tests.test_schema_workflow_mysql", "backend.tests.test_cup_v56_config"],
                 "profiles": ["backend.tests.test_responsibility_profiles." + name for name in ("MySQLLocalProfile", "MySQLLabProfile", "MySQLProdProfile")]}[args.suite]
        if args.case: tests = [('backend.tests.test_schema_workflow_mysql.WorkflowTest.' if args.suite=='workflow' else 'backend.tests.test_legacy_schema_mysql.LegacySchemaTest.' if args.suite == 'legacy' else 'backend.tests.test_maintenance_mysql.MaintenanceTest.') + args.case]
        network = "container:" + container_id if args.suite == "profiles" else f["network"]
        command = ["run", "--rm", "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=268435456", "--network", network, "--env-file", str(env),
                   "-v", str(ROOT / "backend") + ":/work/backend:ro", "-v", str(ROOT / "scripts") + ":/work/scripts:ro", "-w", "/work", "--entrypoint", "python", f["image"],
                   "-m", "unittest", *tests, "-v"]
        try:
            result = docker(*command)
            output, code = result.stdout + result.stderr, 0
        except subprocess.CalledProcessError as exc:
            output, code = exc.stdout + exc.stderr, exc.returncode
        (STATE / ((args.suite+"-"+args.case+".log") if args.case else ("mysql-tests.log" if args.suite == "schema" else args.suite + "-tests.log"))).write_bytes(output)
        print(output.decode("utf8", "replace"))
        return code
    finally:
        if restore_id:
            inspected = json.loads(docker("inspect", restore_id).stdout)[0]
            if inspected["Config"].get("Labels", {}).get("cup.test") != "v55": raise RuntimeError("Restore fixture ownership changed")
            docker("rm", "-f", restore_id)
        if created and verify(f) == (container_id, network_id):
            docker("rm", "-f", container_id)
            docker("network", "rm", network_id)

if __name__ == "__main__":
    raise SystemExit(main())
