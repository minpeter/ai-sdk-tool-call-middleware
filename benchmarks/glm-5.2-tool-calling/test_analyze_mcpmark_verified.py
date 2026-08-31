#!/usr/bin/env python3
from __future__ import annotations

from collections.abc import Mapping
import importlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TYPE_CHECKING, TypeAlias
import unittest
from unittest.mock import patch

if TYPE_CHECKING:
    from . import analyze_mcpmark_verified as analyzer
else:
    module_name = (
        f"{__package__}.analyze_mcpmark_verified"
        if __package__
        else "analyze_mcpmark_verified"
    )
    analyzer = importlib.import_module(module_name)


JsonValue: TypeAlias = (
    str | int | bool | None | list["JsonValue"] | dict[str, "JsonValue"]
)


def write_json(path: Path, value: Mapping[str, JsonValue]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) + "\n", encoding="utf-8")


class MCPMarkVerifiedAnalyzerTest(unittest.TestCase):
    def test_discover_rows_reads_prompt_only_lane(self) -> None:
        # Given: a prompt-only result under the official lane layout.
        with TemporaryDirectory() as directory:
            official_root = Path(directory) / "official"
            meta_path = (
                official_root
                / "glm52-prompt-only__filesystem"
                / "run-1"
                / "file_context__uppercase"
                / "meta.json"
            )
            write_json(
                meta_path,
                {
                    "execution_result": {"success": True},
                    "model_name": "glm52-prompt-only",
                    "task_name": "file_context__uppercase",
                },
            )
            expected = {
                ("file_context", "uppercase"): {
                    "category": "file_context",
                    "service": "filesystem",
                    "taskId": "uppercase",
                }
            }

            # When: active MCPMark lanes are discovered.
            rows, duplicates = analyzer.discover_rows(official_root, expected)

        # Then: the prompt-only row is included exactly once.
        self.assertEqual(duplicates, [])
        self.assertEqual([row["arm"] for row in rows], ["glm52-prompt-only"])

    def test_paired_summary_uses_prompt_only_keys_for_all_outcomes(self) -> None:
        # Given: one task in each paired pass/fail cell.
        rows = [
            {"arm": arm, "passed": passed, "taskKey": task_key}
            for task_key, native, prompt_only in (
                ("filesystem/a/both-pass", True, True),
                ("filesystem/a/native-only", True, False),
                ("filesystem/a/prompt-only", False, True),
                ("filesystem/a/both-fail", False, False),
            )
            for arm, passed in (
                ("glm52-native", native),
                ("glm52-prompt-only", prompt_only),
            )
        ]

        # When: paired outcomes are summarized.
        paired = analyzer.paired_summary(rows)

        # Then: every cell and only current semantic keys are emitted.
        self.assertEqual(paired["bothPass"], 1)
        self.assertEqual(paired["bothFail"], 1)
        self.assertEqual(paired["nativeOnlyPass"], 1)
        self.assertEqual(paired["promptOnlyOnlyPass"], 1)
        self.assertEqual(paired["netPromptOnly"], 0)
        self.assertNotIn("nativePlusOnlyPass", paired)
        self.assertNotIn("netNativePlus", paired)

    def test_cli_rejects_retired_native_plus_as_complete(self) -> None:
        # Given: native and retired Native-Plus rows with no prompt-only row.
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = root / "task-manifest.json"
            official_root = root / "official"
            out_dir = root / "analysis"
            manifest: dict[str, JsonValue] = {
                "benchmark": "MCPMark Verified",
                "commit": "pinned",
                "population": "standard",
                "taskCount": 1,
                "taskSetSha256": "task-set",
                "tasks": [
                    {
                        "category": "file_context",
                        "service": "filesystem",
                        "taskId": "uppercase",
                    }
                ],
            }
            write_json(manifest_path, manifest)
            for arm in ("glm52-native", "glm52-native-plus"):
                write_json(
                    official_root
                    / f"{arm}__filesystem"
                    / "run-1"
                    / "file_context__uppercase"
                    / "meta.json",
                    {
                        "execution_result": {"success": True},
                        "model_name": arm,
                        "task_name": "file_context__uppercase",
                    },
                )

            # When: strict completeness validation runs.
            with (
                patch(
                    "sys.argv",
                    [
                        "analyze_mcpmark_verified.py",
                        "--official-root",
                        str(official_root),
                        "--manifest",
                        str(manifest_path),
                        "--out-dir",
                        str(out_dir),
                    ],
                ),
                self.assertRaisesRegex(
                    RuntimeError,
                    "glm52-prompt-only=0/1",
                ),
            ):
                analyzer.main()

    def test_cli_discovers_complete_native_and_prompt_only_tree(self) -> None:
        # Given: one official standard task completed by both current arms.
        manifest: dict[str, JsonValue] = {
            "benchmark": "MCPMark Verified",
            "commit": "pinned",
            "population": "standard",
            "taskCount": 1,
            "taskSetSha256": "task-set",
            "tasks": [
                {
                    "category": "file_context",
                    "service": "filesystem",
                    "taskId": "uppercase",
                }
            ],
        }
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = root / "task-manifest.json"
            official_root = root / "official"
            out_dir = root / "analysis"
            write_json(manifest_path, manifest)
            for arm, passed in (
                ("glm52-native", True),
                ("glm52-prompt-only", False),
            ):
                write_json(
                    official_root
                    / f"{arm}__filesystem"
                    / "run-1"
                    / "file_context__uppercase"
                    / "meta.json",
                    {
                        "execution_result": {"success": passed},
                        "model_name": arm,
                        "task_name": "file_context__uppercase",
                    },
                )

            # When: the strict full-tree analyzer runs without partial mode.
            with patch(
                "sys.argv",
                [
                    "analyze_mcpmark_verified.py",
                    "--official-root",
                    str(official_root),
                    "--manifest",
                    str(manifest_path),
                    "--out-dir",
                    str(out_dir),
                ],
            ):
                analyzer.main()

            # Then: prompt-only is discovered and paired under current keys.
            summary = json.loads((out_dir / "summary.json").read_text())
            self.assertTrue(summary["complete"])
            self.assertEqual(
                set(summary["arms"]),
                {"glm52-native", "glm52-prompt-only"},
            )
            self.assertEqual(summary["paired"]["promptOnlyOnlyPass"], 0)
            self.assertEqual(summary["paired"]["netPromptOnly"], -1)


if __name__ == "__main__":
    unittest.main()
