import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import app as app_module


class EnvironmentOwnerIsolationTest(unittest.TestCase):
    def test_prod_owner_is_unchanged(self):
        with patch.object(app_module, "ENV_TYPE", "PROD"):
            self.assertEqual(app_module._environment_owner_id("user-1"), "user-1")

    def test_missing_env_keeps_prod_compatibility(self):
        with patch.object(app_module, "ENV_TYPE", None):
            self.assertEqual(app_module._environment_owner_id("user-1"), "user-1")

    def test_lab_owner_is_namespaced_and_idempotent(self):
        with patch.object(app_module, "ENV_TYPE", "LAB"):
            self.assertEqual(app_module._environment_owner_id("user-1"), "LAB:user-1")
            self.assertEqual(app_module._environment_owner_id("LAB:user-1"), "LAB:user-1")

    def test_resolve_owner_namespaces_admin_override_in_lab(self):
        admin = type("U", (), {"id": "admin-1", "role": "admin"})()
        with app_module.app.test_request_context("/"):
            with patch.object(app_module, "ENV_TYPE", "LAB"):
                with patch.object(app_module, "_require_user", return_value=(admin, None)):
                    owner, error = app_module._resolve_owner("user-2", allow_admin_override=True)
        self.assertIsNone(error)
        self.assertEqual(owner, "LAB:user-2")

    def test_direct_owner_access_cannot_cross_environment(self):
        admin = type("U", (), {"id": "admin-1", "role": "admin"})()
        with patch.object(app_module, "ENV_TYPE", "LAB"):
            self.assertFalse(app_module._user_can_access_owner(admin, "user-1"))
            self.assertTrue(app_module._user_can_access_owner(admin, "LAB:user-1"))
        with patch.object(app_module, "ENV_TYPE", "PROD"):
            self.assertTrue(app_module._user_can_access_owner(admin, "user-1"))
            self.assertFalse(app_module._user_can_access_owner(admin, "LAB:user-1"))


if __name__ == "__main__":
    unittest.main()
