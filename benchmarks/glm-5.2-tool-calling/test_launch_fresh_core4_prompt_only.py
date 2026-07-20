#!/usr/bin/env python3

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import unittest


SCRIPT = Path(__file__).with_name("launch_fresh_core4_prompt_only_20260720.sh")


class PromptOnlyCore4LauncherTest(unittest.TestCase):
    def test_launcher_is_syntax_valid_and_has_no_retired_alias(self) -> None:
        # Given: the active 2026-07-20 core4 launcher.
        source = SCRIPT.read_text(encoding="utf-8")

        # When: Bash parses the file without executing it.
        result = subprocess.run(
            ["bash", "-n", str(SCRIPT)],
            check=False,
            capture_output=True,
            text=True,
        )

        # Then: syntax is valid and Native-Plus cannot be selected.
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("native-plus", source.lower())
        self.assertNotIn("launchAuthorized", source)
        self.assertIn("set -euo pipefail", source)
        self.assertIn('BRIDGE_SUITE=$(jq -er .bridgeSuite', source)
        self.assertIn('[[ -e "$BRIDGE_OUT" || -L "$BRIDGE_OUT" ]]', source)
        self.assertNotIn('mkdir -p "$BRIDGE_OUT"', source)

    def test_plan_mode_is_zero_call_and_selects_only_one_suite(self) -> None:
        for suite in ("hammer", "bfcl", "stable", "tau3"):
            with self.subTest(suite=suite):
                # Given: one explicitly selected suite and no provider credential.
                environment = {
                    **os.environ,
                    "ACTIVE_SUITE": suite,
                    "LAUNCH_MODE": "plan",
                }
                environment.pop("FREEROUTER_API_KEY", None)

                # When: the launcher is driven through its plan surface.
                result = subprocess.run(
                    ["bash", str(SCRIPT)],
                    check=False,
                    capture_output=True,
                    text=True,
                    env=environment,
                )

                # Then: it emits a single-suite, zero-provider-call plan.
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"suite={suite}", result.stdout)
                self.assertIn("providerCalls=0", result.stdout)
                self.assertIn("coLaunch=false", result.stdout)


if __name__ == "__main__":
    unittest.main()
