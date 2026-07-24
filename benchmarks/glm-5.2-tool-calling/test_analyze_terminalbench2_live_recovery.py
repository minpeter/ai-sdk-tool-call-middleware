#!/usr/bin/env python3

from datetime import datetime, timezone
from importlib import import_module
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Callable, cast
import unittest

RECOVERY = import_module("analyze_terminalbench2_live_recovery")
analyze = cast(Callable[[Path], dict[str, Any]], getattr(RECOVERY, "analyze"))
task_active_at = cast(
    Callable[[datetime, list[dict[str, Any]]], dict[str, Any] | None],
    getattr(RECOVERY, "task_active_at"),
)
unlinked_response_class = cast(
    Callable[[datetime, dict[str, Any] | None], str],
    getattr(RECOVERY, "unlinked_response_class"),
)

TASK = {
    "startedAt": "2026-07-17T22:51:14.535799Z",
    "finishedAt": "2026-07-17T23:07:37.780337Z",
    "taskName": "adaptive-rejection-sampler",
}


def at(second: int) -> datetime:
    return datetime(2026, 7, 17, 23, 7, second, tzinfo=timezone.utc)


class LateResponseClassificationTest(unittest.TestCase):
    def test_request_started_in_task_but_completed_late(self) -> None:
        active = task_active_at(at(31), [TASK])
        self.assertIs(active, TASK)
        self.assertEqual(
            unlinked_response_class(at(59), active),
            "late-response-after-task-end",
        )

    def test_unlinked_response_completed_while_task_active(self) -> None:
        active = task_active_at(at(31), [TASK])
        self.assertEqual(
            unlinked_response_class(at(35), active),
            "unlinked-in-task-response",
        )

    def test_request_outside_completed_task_is_unassigned(self) -> None:
        active = task_active_at(at(59), [TASK])
        self.assertIsNone(active)
        self.assertEqual(
            unlinked_response_class(at(59), active), "unassigned-response"
        )


class BenchmarkIdentityTest(unittest.TestCase):
    def test_live_analysis_accepts_no_completed_progress_yet(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "bridge").mkdir()
            (root / "bridge/requests.jsonl").write_text("", encoding="utf-8")
            (root / "bridge/provider-raw.jsonl").write_text("", encoding="utf-8")

            result = analyze(root)

            self.assertEqual(result["completeTrajectoriesInspected"], 0)
            self.assertEqual(result["recoveryEvents"], 0)

    def test_analysis_uses_exact_terminal_bench_release_from_run_meta(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "bridge").mkdir()
            (root / "bridge/requests.jsonl").write_text("", encoding="utf-8")
            (root / "bridge/provider-raw.jsonl").write_text("", encoding="utf-8")
            (root / "progress.jsonl").write_text("", encoding="utf-8")
            (root / "run-meta.json").write_text(
                json.dumps({"benchmark": "Terminal-Bench 2.1"}) + "\n",
                encoding="utf-8",
            )

            result = analyze(root)

            self.assertEqual(result["benchmark"], "Terminal-Bench 2.1")

    def test_analysis_falls_back_to_unambiguous_2x_label(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "bridge").mkdir()
            (root / "bridge/requests.jsonl").write_text("", encoding="utf-8")
            (root / "bridge/provider-raw.jsonl").write_text("", encoding="utf-8")
            (root / "progress.jsonl").write_text("", encoding="utf-8")

            result = analyze(root)

            self.assertEqual(result["benchmark"], "Terminal-Bench 2.x")


if __name__ == "__main__":
    unittest.main()
