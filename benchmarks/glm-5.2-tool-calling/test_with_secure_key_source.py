#!/usr/bin/env python3

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from with_secure_key_source import provider_key


class WithSecureKeySourceTest(unittest.TestCase):
    def test_prefers_inherited_process_environment(self) -> None:
        with (
            patch.dict(os.environ, {"FREEROUTER_API_KEY": "inherited"}, clear=True),
            patch(
                "with_secure_key_source.detached_key_sources",
                return_value=[(1, "detached")],
            ),
        ):
            self.assertEqual(provider_key(), "inherited")

    def test_requires_exactly_one_detached_source(self) -> None:
        with (
            patch.dict(os.environ, {}, clear=True),
            patch(
                "with_secure_key_source.detached_key_sources",
                return_value=[(123, "detached")],
            ),
        ):
            self.assertEqual(provider_key(), "detached")
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("with_secure_key_source.detached_key_sources", return_value=[]),
            self.assertRaisesRegex(RuntimeError, "exactly one"),
        ):
            provider_key()


if __name__ == "__main__":
    unittest.main()
