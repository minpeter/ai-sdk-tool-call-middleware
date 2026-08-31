#!/usr/bin/env python3
"""Offline regression tests for the source-driven parser report renderer."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SCRIPT = ROOT / "render_parser_superiority_report.py"
SAME_BYTE_DIR = (
    ROOT / "results" / "2026-07-17-glm5-native-parser-same-byte-audit-v1"
)
REFERENCE_DIR = (
    ROOT / "results" / "2026-07-17-glm5-reference-parser-replay-v1"
)
TEST_TEMP_ROOT = (
    ROOT / "results" / "2026-07-17-glm5-parser-superiority-report-v1"
)


class ParserSuperiorityReportTest(unittest.TestCase):
    def run_cli(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *arguments],
            check=False,
            capture_output=True,
            text=True,
            timeout=180,
        )

    def test_publication_render_reads_real_reference_artifact(self) -> None:
        self.assertTrue((SAME_BYTE_DIR / "summary.json").is_file())
        self.assertTrue((REFERENCE_DIR / "summary.json").is_file())
        completed = self.run_cli()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertEqual(result["charts"], 6)
        self.assertTrue(result["publicationReady"])
        self.assertTrue(result["referenceDataLoaded"])

        svgs = sorted((TEST_TEMP_ROOT / "charts").glob("*.svg"))
        pngs = sorted((TEST_TEMP_ROOT / "charts").glob("*.png"))
        self.assertEqual(len(svgs), 6)
        self.assertEqual(len(pngs), 6)
        self.assertTrue(all(path.stat().st_size > 0 for path in (*svgs, *pngs)))
        report = ROOT / "REPORT-GLM5-PARSER-SUPERIORITY.ko.md"
        report_text = report.read_text(encoding="utf-8")
        self.assertNotIn("PENDING", report_text)
        self.assertIn("1,720/1,729", report_text)
        self.assertIn("5승·3중립·0패", report_text)

        manifest = json.loads(
            (TEST_TEMP_ROOT / "visual-manifest.json").read_text(encoding="utf-8")
        )
        self.assertTrue(manifest["publicationReady"])
        self.assertEqual(len(manifest["charts"]), 6)
        self.assertIsNotNone(manifest["referenceEvidence"])
        self.assertEqual(manifest["sameByteEvidence"]["structuredCalls"], 1729)

    def test_pending_layout_preview_is_explicit_and_not_publication_ready(
        self,
    ) -> None:
        TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            dir=TEST_TEMP_ROOT, prefix="test-"
        ) as temporary:
            base = Path(temporary)
            base.chmod(0o755)
            empty_reference = base / "empty-reference"
            empty_reference.mkdir()
            out = base / "preview"
            report = base / "preview.ko.md"
            completed = self.run_cli(
                "--reference-dir",
                str(empty_reference),
                "--out-dir",
                str(out),
                "--report",
                str(report),
                "--allow-pending-reference",
                "--svg-only",
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            result = json.loads(completed.stdout)
            self.assertFalse(result["publicationReady"])
            self.assertFalse(result["referenceDataLoaded"])
            self.assertIn("PENDING", report.read_text(encoding="utf-8"))
            manifest = json.loads(
                (out / "visual-manifest.json").read_text(encoding="utf-8")
            )
            self.assertFalse(manifest["publicationReady"])
            self.assertIsNone(manifest["referenceEvidence"])

    def test_missing_reference_fails_closed_without_preview_flag(self) -> None:
        TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            dir=TEST_TEMP_ROOT, prefix="test-"
        ) as temporary:
            base = Path(temporary)
            base.chmod(0o755)
            empty_reference = base / "empty-reference"
            empty_reference.mkdir()
            completed = self.run_cli(
                "--reference-dir",
                str(empty_reference),
                "--out-dir",
                str(base / "out"),
                "--report",
                str(base / "report.ko.md"),
                "--svg-only",
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("Reference replay summary is required", completed.stderr)


if __name__ == "__main__":
    unittest.main()
