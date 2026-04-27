import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import app as app_module


class _DummyFilterBy:
    def first(self):
        return None


class _DummyQuery:
    def filter_by(self, **kwargs):
        return _DummyFilterBy()


class _DummySession:
    def __init__(self):
        self.added = []
        self.commits = 0

    def add(self, obj):
        self.added.append(obj)

    def commit(self):
        self.commits += 1


class StoreAclTest(unittest.TestCase):
    def _normalize_response(self, resp):
        if isinstance(resp, tuple):
            flask_resp, status = resp
            return flask_resp, status
        return resp, resp.status_code

    def _call_store_set(self, payload, user_id, role):
        user = type("U", (), {"id": user_id, "role": role})()
        dummy_session = _DummySession()
        with app_module.app.test_request_context("/api/store", method="POST", json=payload):
            with patch.object(app_module, "_require_user", return_value=(user, None)):
                with patch.object(
                    app_module,
                    "_resolve_owner",
                    side_effect=lambda explicit_owner=None, allow_admin_override=False: (
                        str(explicit_owner or "").strip() or user_id,
                        None,
                    ),
                ):
                    with patch.object(app_module.KVStore, "query", _DummyQuery()):
                        with patch.object(app_module, "db", type("DB", (), {"session": dummy_session})()):
                            return app_module.store_set(), dummy_session

    def test_user_can_post_store_for_own_tariffs(self):
        payload = {"owner": "u1", "key": "tariffs_u1", "value": "{}"}
        response, dummy_session = self._call_store_set(payload, user_id="u1", role="user")
        response, status_code = self._normalize_response(response)

        self.assertEqual(status_code, 200)
        self.assertEqual(dummy_session.commits, 1)

    def test_user_cannot_post_store_for_other_owner_tariffs(self):
        payload = {"owner": "u2", "key": "tariffs_u2", "value": "{}"}
        response, dummy_session = self._call_store_set(payload, user_id="u1", role="user")
        response, status_code = self._normalize_response(response)

        body = response.get_json()
        self.assertEqual(status_code, 403)
        self.assertEqual(body.get("error"), "forbidden")
        self.assertEqual(dummy_session.commits, 0)

    def test_guest_cannot_post_tariffs(self):
        with app_module.app.test_client() as client:
            response = client.post(
                "/api/store",
                json={"owner": "u1", "key": "tariffs_u1", "value": "{}"},
            )

        body = response.get_json()
        self.assertEqual(response.status_code, 401)
        self.assertEqual(body.get("error"), "not_authenticated")

    def test_ref_rates_stay_admin_only_for_user(self):
        payload = {"owner": "u1", "key": "ref_rates_u1", "value": "{}"}
        response, dummy_session = self._call_store_set(payload, user_id="u1", role="user")
        response, status_code = self._normalize_response(response)

        body = response.get_json()
        self.assertEqual(status_code, 403)
        self.assertEqual(body.get("error"), "forbidden")
        self.assertEqual(dummy_session.commits, 0)


if __name__ == "__main__":
    unittest.main()
