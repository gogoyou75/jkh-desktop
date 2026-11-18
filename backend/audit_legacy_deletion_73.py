"""Guarded LAB reconciliation for the two historical apartment 73 recipients.

The default mode is read-only. --execute cleans both recipients in one database
transaction after checking their identities and the zero outgoing transfer.
Their ledger rows are deleted as personal history, not classified as zero debt.
"""

import argparse
import getpass
import hashlib
import json
import os
import sys
from decimal import Decimal, InvalidOperation

from sqlalchemy import text

from app import (AbonentSummary, CardSnapshot, KVStore,
                 _legacy_deletion_reconcile_atomic, _personal_abonent_key, app, db)


OWNER = "u_6eb6bc0bef8d"
REGNUM = "TEMP-20260501-5388"
LAB_DATABASE = "jkh_lab"
TRANSFERS = (
    ("1073", "1088", "uid_mwjaxoki_xq8j3i",
     "responsibility:ae35bcc624dd2972e0a4377977479a61859995663c061359af7fe654755fb566"),
    ("1088", "1089", "uid_mwjb02xp_y4gm0e",
     "responsibility:7f6ecd4f89e8bd16c96283826439dcdae81cf9cdb8fa7e4d8f7e79acb847dab6"),
)


def _zero_amounts(event):
    try:
        return (all(field in event and Decimal(str(event[field])) == 0
                    for field in ("debtAmount", "balanceAmount")) and
                all(field not in event or Decimal(str(event[field])) == 0
                    for field in ("principal", "penalty")))
    except (InvalidOperation, TypeError, ValueError):
        return False


def assert_no_name_period(state):
    links = state.get("links")
    if not isinstance(links, list):
        raise ValueError("responsibility_links_invalid")
    source = [link for link in links if isinstance(link, dict) and
              link.get("regnum") == REGNUM and str(link.get("abonentId") or "") == "1073"]
    gaps = [link for link in links if isinstance(link, dict) and
            link.get("regnum") == REGNUM and link.get("technicalType") == "NO_NAME" and
            str(link.get("dateFrom") or "") == "2008-01-01"]
    if (len(source) != 1 or source[0].get("dateFrom") != "2007-06-01" or
            source[0].get("dateTo") != "2007-12-31" or len(gaps) != 1):
        raise ValueError("no_name_period_unverified")
    from app import _responsibility_periods_valid
    if not _responsibility_periods_valid(links, REGNUM):
        raise ValueError("responsibility_period_overlap")


def inspect_state():
    db_row = KVStore.query.filter_by(owner=OWNER, k="abonents_db_v1").first()
    financial_row = KVStore.query.filter_by(owner=OWNER, k="jkh_financial_events_v1").first()
    if not db_row or not financial_row:
        raise ValueError("required_owner_rows_missing")
    current = json.loads(db_row.v)
    financial = json.loads(financial_row.v)
    if (not isinstance(current, dict) or not isinstance(financial, list) or
            REGNUM not in current.get("premises", {})):
        raise ValueError("premise_or_financial_journal_invalid")
    abonents = current.get("abonents", {})
    links = current.get("links", [])
    events = current.get("premiseEvents", [])
    assert_no_name_period(current)
    if (not isinstance(abonents.get("1073"), dict) or
            "1088" in abonents or "1089" in abonents or
            any(isinstance(link, dict) and link.get("abonentId") in ("1088", "1089")
                for link in links)):
        raise ValueError("historical_identity_conflict")
    for source, target, uid, operation in TRANSFERS:
        steps = [event for event in events if isinstance(event, dict) and
                 event.get("type") == "RESPONSIBILITY_TRANSFER" and
                 event.get("operationId") == operation and
                 str(event.get("oldAbonentId")) == source and
                 str(event.get("newAbonentId")) == target and
                 REGNUM in (event.get("fromRegnums") or [event.get("regnum")]) and
                 event.get("transferMode") in ("NO_DEBT", "WITHOUT_DEBT")]
        proofs = [event for event in financial if isinstance(event, dict) and
                  event.get("type") == "TRANSFER_WITHOUT_DEBT" and
                  event.get("operationId") == operation and
                  str(event.get("sourceAbonentId")) == source and
                  str(event.get("targetAbonentId")) == target and
                  str(event.get("regnum") or event.get("premiseId")) == REGNUM and
                  event.get("mode") in ("NO_DEBT", "WITHOUT_DEBT") and
                  _zero_amounts(event)]
        if len(steps) != 1 or len(proofs) != 1:
            raise ValueError("historical_zero_transfer_unverified:" + target)
    result = {"owner": OWNER, "regnum": REGNUM, "db_version": db_row.version,
              "financial_version": financial_row.version,
              "financial_sha256": hashlib.sha256(financial_row.v.encode("utf-8")).hexdigest(),
              "transfer_operations_verified": [item[3] for item in TRANSFERS],
              "recipients": [], "ledger_balance_not_inferred": True,
              "writes_performed": False}
    for _, target, uid, _ in TRANSFERS:
        ledger = KVStore.query.filter_by(owner=OWNER, k="payments_" + uid).first()
        rows = json.loads(ledger.v) if ledger and ledger.v else []
        if not isinstance(rows, list):
            raise ValueError("ledger_invalid:" + target)
        summary = AbonentSummary.query.filter_by(owner_id=OWNER, account_uid=uid).first()
        snapshot = CardSnapshot.query.filter_by(owner_id=OWNER, abonent_uid=uid).first()
        result["recipients"].append({
            "abonent_id": target, "uid": uid, "ledger_rows": len(rows),
            "ledger_version": ledger.version if ledger else None,
            "ledger_sha256": hashlib.sha256(ledger.v.encode("utf-8")).hexdigest() if ledger else None,
            "summary_status": summary.summary_status if summary else "missing",
            "summary_total_debt": str(summary.total_debt) if summary and summary.total_debt is not None else None,
            "snapshot_status": snapshot.snapshot_status if snapshot else "missing",
        })
    result["ledger_rows_total"] = sum(item["ledger_rows"] for item in result["recipients"])
    if result["ledger_rows_total"] != 227:
        raise ValueError("ledger_row_count_changed:" + str(result["ledger_rows_total"]))
    return result


def _source_values():
    row = KVStore.query.filter_by(owner=OWNER, k="abonents_db_v1").one()
    state = json.loads(row.v)
    source = state["abonents"]["1073"]
    uid = str(source.get("uid") or "")
    if not uid:
        raise ValueError("source_uid_missing")
    return {item.k: item.v for item in KVStore.query.filter_by(owner=OWNER).all()
            if _personal_abonent_key(item.k, "1073", uid)}


def execute_cleanup(report, user, owner):
    if owner != OWNER:
        raise ValueError("owner_mismatch")
    before_source = _source_values()
    before_row = KVStore.query.filter_by(owner=OWNER, k="abonents_db_v1").one()
    before = json.loads(before_row.v)
    financial_row = KVStore.query.filter_by(
        owner=OWNER, k="jkh_financial_events_v1").one()
    before_financial = json.loads(financial_row.v)
    transfer_types = ("TRANSFER_WITH_DEBT", "TRANSFER_WITHOUT_DEBT")
    protected_financial = [event for event in before_financial if isinstance(event, dict)
                           and event.get("type") in transfer_types]
    for index, (_, target, uid, historical) in enumerate(TRANSFERS):
        result = _legacy_deletion_reconcile_atomic({
            "operation_id": "legacy-reconcile-73-" + target + "-v1",
            "historical_operation_id": historical,
            "abonent_id": target, "uid": uid, "regnum": REGNUM,
            "expected_version": report["db_version"] + index,
        }, user, OWNER, commit=False,
            expected_ledger_rows=report["recipients"][index]["ledger_rows"],
            expected_ledger_version=report["recipients"][index]["ledger_version"],
            expected_ledger_sha256=report["recipients"][index]["ledger_sha256"],
            expected_financial_version=report["financial_version"] if index == 0 else None,
            expected_financial_sha256=report["financial_sha256"] if index == 0 else None)
        if isinstance(result, tuple) or result.get_json().get("ok") is not True:
            raise ValueError("reconciliation_failed:" + target)
    after = json.loads(KVStore.query.filter_by(owner=OWNER, k="abonents_db_v1").one().v)
    after_financial = json.loads(KVStore.query.filter_by(
        owner=OWNER, k="jkh_financial_events_v1").one().v)
    assert_no_name_period(after)
    if (after.get("abonents") != before.get("abonents") or
            after.get("links") != before.get("links") or
            after.get("premises") != before.get("premises") or
            _source_values() != before_source or
            [event for event in after_financial if isinstance(event, dict)
             and event.get("type") in transfer_types] != protected_financial):
        raise ValueError("neighbor_or_transfer_history_changed")
    old_events = before.get("premiseEvents", [])
    new_events = after.get("premiseEvents", [])
    additions = new_events[len(old_events):]
    if (new_events[:len(old_events)] != old_events or len(additions) != 2 or
            [(event.get("type"), event.get("abonentId"), event.get("uid"))
             for event in additions] != [
                 ("LEGACY_DELETION_RECONCILED", target, uid)
                 for _, target, uid, _ in TRANSFERS] or
            any(event.get("type") == "ABONENT_DELETED" and
                event.get("abonentId") in ("1088", "1089") for event in additions)):
        raise ValueError("historical_audit_changed")
    db.session.commit()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true",
                        help="atomically reconcile both identities after all checks")
    args = parser.parse_args()
    if (os.environ.get("ENV_TYPE", "").upper() != "LAB" or
            not os.environ.get("DB_HOST") or
            os.environ.get("DB_HOST") != os.environ.get("ALLOWED_DB_HOST")):
        raise RuntimeError("Refusing non-LAB or unapproved database host")
    with app.app_context():
        url = db.engine.url
        if (url.get_backend_name() != "mysql" or url.host != os.environ["DB_HOST"] or
                url.database != LAB_DATABASE):
            raise RuntimeError("Refusing non-MySQL or unexpected database")
        try:
            actual_db = db.session.execute(text("SELECT DATABASE()")).scalar_one()
            if actual_db != LAB_DATABASE:
                raise RuntimeError("Database name mismatch")
            report = inspect_state()
            print(json.dumps(report, ensure_ascii=False, indent=2))
        finally:
            db.session.rollback()
    if not args.execute:
        print("DRY_RUN: no records changed; pass --execute to reconcile")
        return
    email = input("LAB account email: ").strip()
    password = getpass.getpass("LAB account password: ")
    with app.test_client() as client:
        login = client.post("/api/auth/login", json={"email": email, "password": password})
        password = ""
        login_data = login.get_json() or {}
        login_user = login_data.get("user") or {}
        if login.status_code != 200 or login_user.get("role") != "admin":
            raise RuntimeError("LAB admin authentication failed")
        response = client.post("/api/legacy_deletion_reconcile_73",
                               base_url="https://lab.valvera.ru")
        result = response.get_json() or {}
        if response.status_code != 200 or result.get("committed") is not True:
            raise RuntimeError("Atomic reconciliation rejected: " + str(result.get("error")))
        print("PASS: both historical recipients reconciled atomically")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("PREFLIGHT_FAILED: " + str(exc), file=sys.stderr)
        sys.exit(1)
