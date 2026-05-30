import argparse
import json
import sys

from app import app, audit_abonent_summary_consistency


def main():
    parser = argparse.ArgumentParser(
        description="Audit and optionally repair abonent_summary columns from summary_json."
    )
    parser.add_argument("--apply", action="store_true", help="Apply column repairs. Dry-run is the default.")
    parser.add_argument("--owner", default="", help="Optional owner_id scope.")
    parser.add_argument("--sample-limit", type=int, default=20, help="How many mismatch samples to print.")
    args = parser.parse_args()

    if args.apply:
        print(
            "WARNING: --apply will update abonent_summary columns for mismatched rows. "
            "summary_json will not be rewritten.",
            file=sys.stderr,
        )
    else:
        print("DRY-RUN: no database changes will be written.", file=sys.stderr)

    with app.app_context():
        result = audit_abonent_summary_consistency(
            apply=args.apply,
            sample_limit=max(0, args.sample_limit),
            owner_id=args.owner,
        )

    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 1 if result["mismatch_count"] and not args.apply else 0


if __name__ == "__main__":
    raise SystemExit(main())
