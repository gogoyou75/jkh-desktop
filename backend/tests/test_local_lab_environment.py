import os
import subprocess
import sys
import unittest
from pathlib import Path


BACKEND = Path(__file__).resolve().parents[1]


def import_with_environment(**changes):
    env = os.environ.copy()
    env.update({
        "ENV_TYPE": "LOCAL_LAB",
        "DB_HOST": "mysql",
        "DB_PORT": "3306",
        "DB_NAME": "jkh_local_lab",
        "DB_USER": "jkh_local",
        "DB_PASSWORD": "synthetic-test-password",
        "SECRET_KEY": "synthetic-test-session-key",
    })
    env.update(changes)
    return subprocess.run(
        [sys.executable, "-c", "import app; print(app.ENV_TYPE)"],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


class LocalLabEnvironmentTest(unittest.TestCase):
    def test_local_lab_is_explicitly_supported(self):
        result = import_with_environment()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "LOCAL_LAB")

    def test_unknown_environment_does_not_fall_back_to_prod(self):
        result = import_with_environment(ENV_TYPE="LOCAL_LAB_TYPO")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unsupported ENV_TYPE", result.stderr)

    def test_remote_database_host_is_rejected(self):
        result = import_with_environment(DB_HOST="example.invalid")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("LOCAL_LAB SECURITY BLOCK", result.stderr)

    def test_other_database_is_rejected(self):
        result = import_with_environment(DB_NAME="jkh")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("LOCAL_LAB SECURITY BLOCK", result.stderr)

    def test_other_port_or_user_is_rejected(self):
        for changes in ({"DB_PORT": "3307"}, {"DB_USER": "root"}):
            with self.subTest(changes=changes):
                result = import_with_environment(**changes)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("LOCAL_LAB SECURITY BLOCK", result.stderr)

    def test_missing_test_credentials_are_rejected(self):
        for changes in ({"DB_PASSWORD": ""}, {"SECRET_KEY": ""}):
            with self.subTest(changes=changes):
                result = import_with_environment(**changes)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("LOCAL_LAB SECURITY BLOCK", result.stderr)


if __name__ == "__main__":
    unittest.main()
