#!/usr/bin/env python3
"""Offline smoke tests for report_native_plus.py."""

from __future__ import annotations

import csv
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SCRIPT = ROOT / "report_native_plus.py"
FIXTURES = ROOT / "fixtures"


class NativePlusReportTest(unittest.TestCase):
    def run_cli(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *arguments],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )

    def test_help_describes_inputs_and_offline_pricing_policy(self) -> None:
        completed = self.run_cli("--help")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("--bfcl-dir", completed.stdout)
        self.assertIn("--ace-dir", completed.stdout)
        self.assertIn("--mcpmark-dir", completed.stdout)
        self.assertIn("hybrid, repair-only", completed.stdout)
        self.assertIn("never inferred from tokens", completed.stdout)

    @unittest.skipUnless(
        shutil.which("rsvg-convert")
        or shutil.which("magick")
        or shutil.which("convert"),
        "PNG smoke test requires rsvg-convert or ImageMagick",
    )
    def test_fixture_smoke_emits_all_artifacts_without_cost_inference(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            bfcl_dir = base / "bfcl"
            ace_dir = base / "ace"
            mcpmark_dir = base / "mcpmark"
            out_dir = base / "report"
            for directory in (bfcl_dir, ace_dir, mcpmark_dir):
                directory.mkdir()

            shutil.copy(
                FIXTURES / "two-arm-bfcl-scored.jsonl",
                bfcl_dir / "scored.jsonl",
            )
            shutil.copy(
                FIXTURES / "two-arm-ace-scored.jsonl",
                ace_dir / "scored.jsonl",
            )
            shutil.copy(
                FIXTURES / "two-arm-mcpmark-raw.jsonl",
                mcpmark_dir / "raw.jsonl",
            )

            (bfcl_dir / "summary.json").write_text(
                json.dumps(
                    {
                        "arms": [
                            {"arm": "native", "correct": 1, "total": 2},
                            {"arm": "glm5", "correct": 2, "total": 2},
                        ],
                        "failureTaxonomy": [
                            {"arm": "native", "wrongValue": 1},
                            {"arm": "glm5", "wrongValue": 0},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            (ace_dir / "ace-summary.json").write_text(
                json.dumps(
                    {
                        "protocols": [
                            {"arm": "native", "correct": 1, "eligible": 2},
                            {"arm": "glm5", "correct": 2, "eligible": 2},
                        ],
                        "failures": [
                            {"arm": "native", "wrongValue": 1},
                            {"arm": "glm5", "wrongValue": 0},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            (mcpmark_dir / "mcpmark-summary.json").write_text(
                json.dumps(
                    {
                        "protocols": [
                            {
                                "arm": "native",
                                "jobs": 2,
                                "passed": 1,
                                "primaryOutcomeCounts": {
                                    "passed": 1,
                                    "verification": 1,
                                },
                            },
                            {
                                "arm": "glm5",
                                "jobs": 2,
                                "passed": 2,
                                "primaryOutcomeCounts": {"passed": 2},
                            },
                        ]
                    }
                ),
                encoding="utf-8",
            )

            completed = self.run_cli(
                "--bfcl-dir",
                str(bfcl_dir),
                "--ace-dir",
                str(ace_dir),
                "--mcpmark-dir",
                str(mcpmark_dir),
                "--out-dir",
                str(out_dir),
                "--plus-arm",
                "glm5",
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            command_result = json.loads(completed.stdout)
            self.assertEqual(command_result["artifactCount"], 10)

            chart_stems = (
                "native-plus-three-suite-accuracy",
                "native-plus-paired-wins-losses",
                "native-plus-latency-tokens",
            )
            for stem in chart_stems:
                for suffix in (".svg", ".png"):
                    artifact = out_dir / f"{stem}{suffix}"
                    self.assertTrue(artifact.is_file(), artifact)
                    self.assertGreater(artifact.stat().st_size, 0)

            study = json.loads(
                (out_dir / "native-plus-cross-suite.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(study["nativePlusProtocol"], "hybrid/repair-only")
            self.assertIsNone(study["pooledScore"])
            self.assertFalse(study["pricing"]["hasExplicitCost"])
            self.assertEqual(
                [suite["pair"]["wins"] for suite in study["suites"]],
                [1, 1, 1],
            )
            self.assertEqual(
                [suite["pair"]["losses"] for suite in study["suites"]],
                [0, 0, 0],
            )
            self.assertEqual(study["suites"][2]["pair"]["comparable"], 2)

            with (out_dir / "native-plus-cross-suite.csv").open(
                encoding="utf-8", newline=""
            ) as handle:
                csv_rows = list(csv.DictReader(handle))
            self.assertEqual(len(csv_rows), 6)
            self.assertTrue(all(row["explicitCostUsd"] == "" for row in csv_rows))

            notion = (out_dir / "native-plus-notion-summary.md").read_text(
                encoding="utf-8"
            )
            self.assertIn("하이브리드 repair-only", notion)
            self.assertIn("토큰 수로 비용을 추정하지 않았다", notion)
            self.assertNotIn("$", notion)


if __name__ == "__main__":
    unittest.main()
