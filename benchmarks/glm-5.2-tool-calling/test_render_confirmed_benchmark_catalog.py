#!/usr/bin/env python3

from __future__ import annotations

import json
from pathlib import Path
import unittest
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .audit_fresh_replacement_readiness import REPLACEMENTS
    from .render_confirmed_benchmark_catalog import BENCHMARKS
else:
    from audit_fresh_replacement_readiness import REPLACEMENTS
    from render_confirmed_benchmark_catalog import BENCHMARKS


class ConfirmedBenchmarkCatalogTest(unittest.TestCase):
    def test_catalog_resolves_primary9_and_expanded11_totals(self) -> None:
        # Given: every source-confirmed suite in the active campaign catalog.
        counts = {name: count for name, count, _, _ in BENCHMARKS}

        # When: the two supported campaign scopes are totaled.
        expanded = sum(counts.values())
        primary = expanded - counts["ToolSandbox"] - counts["ComplexFuncBench"]

        # Then: primary-9 and expanded-11 remain explicit and non-interchangeable.
        self.assertEqual(len(counts), 11)
        self.assertEqual(primary, 75480)
        self.assertEqual(expanded, 77512)

    def test_ledger_binds_canonical_arms_roots_and_artifacts(self) -> None:
        # Given: the canonical machine-readable campaign ledger.
        ledger_path = Path(__file__).with_name("fresh_campaign_ledger.json")

        # When: the ledger is loaded for launch orchestration.
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))

        # Then: its identities and roots match the active shared surfaces.
        self.assertEqual(
            ledger["arms"], ["glm52-native", "glm52-prompt-only"]
        )
        self.assertEqual(ledger["scopes"]["primary9"]["casesPerArm"], 75480)
        self.assertEqual(ledger["scopes"]["expanded11"]["casesPerArm"], 77512)
        self.assertEqual(
            {suite["outputRoot"] for suite in ledger["suites"]},
            {spec["relativeOutput"] for spec in REPLACEMENTS},
        )
        self.assertEqual(
            set(ledger["artifactContract"]),
            {
                "binding",
                "capture",
                "exactPopulation",
                "manifest",
                "retryProof",
                "runtimeFingerprint",
                "scoreRelease",
                "strictValidation",
            },
        )
        self.assertEqual(
            ledger["admission"]["configuredInitialGlobalCaps"],
            {"agenticStableMcpmark": 4, "shortSingleCompletion": 8},
        )
        self.assertEqual(ledger["admission"]["measuredMicroProbeCeiling"], 16)
        self.assertTrue(
            ledger["admission"]["microProbePromotionRequiresRepresentativeSoak"]
        )
        self.assertNotIn("configuredInitialGlobalCap", ledger["admission"])
        self.assertEqual(ledger["hostGate"]["status"], "NO_GO")
        self.assertEqual(ledger["hostGate"]["required"]["softNofile"], 65536)


if __name__ == "__main__":
    unittest.main()
