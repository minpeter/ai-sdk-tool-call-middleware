#!/usr/bin/env python3

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from start_secure_key_source import PROCESS_NAME, start_key_source


class SecureKeySourceTest(unittest.TestCase):
    def test_rejects_empty_secret(self) -> None:
        with self.assertRaisesRegex(ValueError, "must not be empty"):
            start_key_source("")

    def test_passes_secret_only_through_child_environment(self) -> None:
        child = MagicMock(pid=1234)
        with (
            patch("start_secure_key_source.shutil.which", return_value="/bin/sleep"),
            patch("start_secure_key_source.subprocess.Popen", return_value=child) as popen,
        ):
            pid = start_key_source("test-secret")
        self.assertEqual(pid, 1234)
        args, kwargs = popen.call_args
        self.assertEqual(args[0], [PROCESS_NAME, "infinity"])
        self.assertEqual(kwargs["executable"], "/bin/sleep")
        self.assertEqual(kwargs["env"]["FREEROUTER_API_KEY"], "test-secret")
        self.assertNotIn("test-secret", args[0])


if __name__ == "__main__":
    unittest.main()
