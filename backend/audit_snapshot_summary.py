import argparse
import json
import sys
from pathlib import Path


def _ensure_backend_on_path():
    here = Path(__file__).resolve()
    backend_dir = here.parent
    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))


def main():
    parser = argparse.ArgumentParser(description="Dry-run audit for card_snapshot and abonent_summary.")
    parser.add_argument("--owner", "--owner-id", dest="owner_id", default="", help="Optional owner_id scope.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    args = parser.parse_args()

    _ensure_backend_on_path()
    from sqlalchemy.exc import SQLAlchemyError
    from app import app, build_snapshot_summary_audit

    try:
        with app.app_context():
            payload = build_snapshot_summary_audit(args.owner_id)
    except SQLAlchemyError as exc:
        payload = {
            "ok": False,
            "dry_run": True,
            "error": "snapshot_summary_audit_failed",
            "details": str(exc),
        }
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2 if args.pretty else None, sort_keys=True)
        sys.stdout.write("\n")
        return 2

    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2 if args.pretty else None, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
