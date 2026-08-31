#!/usr/bin/env python3

import json
from importlib import import_module
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


runner = import_module("terminalbench2_official_native")
validator = import_module("validate_terminalbench2_official")
host_boot_id = runner.host_boot_id
inspect_trial = runner.inspect_trial
trial_row = validator.trial_row
validate_bridge = validator.validate_bridge


SUITE = "terminalbench2-full-89-fresh-v5"
MODEL = "glm52-native"
TASK = "adaptive-rejection-sampler"
JOB = "tb2-001-glm52-native"
TRIAL = f"{TASK}__fresh"


def write_jsonl(path: Path, rows: list[dict[str, object]]) -> None:
    path.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )


def capture(attempt: int, status: int) -> dict[str, object]:
    return {
        "captureId": f"capture-{attempt}",
        "context": {
            "attempt": attempt,
            "jobKey": "request-1",
            "suite": SUITE,
        },
        "response": {"status": status},
    }


def write_verified_trial(root: Path, task_identity: str) -> Path:
    trial = root / TRIAL
    trajectory = trial / "agent/trajectory.json"
    trajectory.parent.mkdir(parents=True)
    (trial / "result.json").write_text(
        json.dumps(
            {
                "agent_info": {
                    "name": "mini-swe-agent",
                    "version": "2.4.5",
                    "model_info": {"name": MODEL},
                },
                "exception_info": None,
                "finished_at": "2026-07-19T00:01:00Z",
                "started_at": "2026-07-19T00:00:00Z",
                "task_name": task_identity,
                "verifier_result": {"rewards": {"reward": 1.0}},
            }
        ),
        encoding="utf-8",
    )
    trajectory.write_text(json.dumps({"steps": []}), encoding="utf-8")
    return trajectory


class TerminalBenchBridgeValidationTest(unittest.TestCase):
    def test_validator_uses_current_prompt_only_alias(self) -> None:
        self.assertEqual(
            validator.ARMS,
            ("glm52-native", "glm52-prompt-only"),
        )

    def test_host_boot_id_is_recorded_without_failing_on_missing_proc(self) -> None:
        with patch.object(Path, "read_text", return_value="boot-id\n"):
            self.assertEqual(host_boot_id(), "boot-id")
        with patch.object(Path, "read_text", side_effect=OSError):
            self.assertIsNone(host_boot_id())

    def test_accepts_fifth_attempt_recovery_when_run_policy_allows_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            captures = [capture(attempt, 503) for attempt in range(1, 5)]
            captures.append(capture(5, 200))
            write_jsonl(root / "provider-raw.jsonl", captures)
            write_jsonl(
                root / "requests.jsonl",
                [
                    {
                        "model": MODEL,
                        "parserErrors": [],
                        "requestId": "request-1",
                        "status": 200,
                        "suite": SUITE,
                        "upstreamCaptureIds": [
                            f"capture-{attempt}" for attempt in range(1, 6)
                        ],
                    }
                ],
            )

            summary = validate_bridge(root, {MODEL}, SUITE, 5, None)

            self.assertEqual(summary["requestCount"], 1)
            self.assertEqual(summary["captureCount"], 5)
            self.assertEqual(summary["retriedRequestsByModel"], {MODEL: 1})

    def test_rejects_attempt_count_above_run_policy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            captures = [capture(attempt, 503) for attempt in range(1, 6)]
            captures.append(capture(6, 200))
            write_jsonl(root / "provider-raw.jsonl", captures)
            write_jsonl(
                root / "requests.jsonl",
                [
                    {
                        "model": MODEL,
                        "parserErrors": [],
                        "requestId": "request-1",
                        "status": 200,
                        "suite": SUITE,
                        "upstreamCaptureIds": [
                            f"capture-{attempt}" for attempt in range(1, 7)
                        ],
                    }
                ],
            )

            with self.assertRaisesRegex(RuntimeError, "invalid retry attempt"):
                validate_bridge(root, {MODEL}, SUITE, 5, None)

    def test_accepts_harbor_namespaced_terminal_bench_task_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            jobs = Path(directory)
            job = jobs / "tb2-001-glm52-native"
            trial = job / "adaptive-rejection-sampler__fresh"
            trial.mkdir(parents=True)
            (trial / "agent").mkdir()
            (job / "result.json").write_text(
                json.dumps({"stats": {"n_completed_trials": 1}}), encoding="utf-8"
            )
            (trial / "result.json").write_text(
                json.dumps(
                    {
                        "agent_info": {"version": "2.4.5"},
                        "exception_info": None,
                        "task_name": "terminal-bench/adaptive-rejection-sampler",
                        "verifier_result": {"rewards": {"reward": 1.0}},
                    }
                ),
                encoding="utf-8",
            )
            (trial / "agent" / "trajectory.json").write_text(
                json.dumps({"steps": []}), encoding="utf-8"
            )

            result = inspect_trial(
                jobs, "tb2-001-glm52-native", "adaptive-rejection-sampler"
            )

            self.assertEqual(result["scoreContribution"], 1.0)


class TerminalBenchTrialValidationTest(unittest.TestCase):
    def test_accepts_harbor_namespaced_task_identity(self) -> None:
        # Given a valid Harbor 0.18 trial whose task has the canonical namespace.
        with tempfile.TemporaryDirectory() as directory:
            trajectory = write_verified_trial(
                Path(directory), f"terminal-bench/{TASK}"
            )
            progress = {
                "arm": MODEL,
                "jobName": JOB,
                "officialReward": 1.0,
                "scoreContribution": 1.0,
                "steps": 0,
                "taskIndex": 1,
                "taskName": TASK,
                "toolCalls": 0,
                "trajectory": str(trajectory),
                "trialStatus": "verified",
            }

            # When the official result row is validated.
            row = trial_row(progress, {TASK})

            # Then the manifest's bare task identity remains canonical.
            self.assertEqual(row["taskName"], TASK)

    def test_rejects_unrelated_namespaced_task_identity(self) -> None:
        # Given a trial whose namespace is not the pinned Terminal-Bench namespace.
        with tempfile.TemporaryDirectory() as directory:
            trajectory = write_verified_trial(Path(directory), f"other/{TASK}")
            progress = {
                "arm": MODEL,
                "jobName": JOB,
                "officialReward": 1.0,
                "scoreContribution": 1.0,
                "steps": 0,
                "taskIndex": 1,
                "taskName": TASK,
                "toolCalls": 0,
                "trajectory": str(trajectory),
                "trialStatus": "verified",
            }

            # When and then the official result row is validated, it fails closed.
            with self.assertRaisesRegex(RuntimeError, "task mismatch"):
                trial_row(progress, {TASK})

    def test_accepts_absent_trajectory_for_explicit_scorable_zero(self) -> None:
        # Given the robust runner's explicit missing-ATIF timeout-zero topology.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            job_root = root / JOB
            trial = job_root / JOB / TRIAL
            trial.mkdir(parents=True)
            (trial / "result.json").write_text(
                json.dumps(
                    {
                        "agent_info": {
                            "name": "mini-swe-agent",
                            "version": "2.4.5",
                            "model_info": {"name": MODEL},
                        },
                        "exception_info": {"exception_type": "AgentTimeoutError"},
                        "finished_at": "2026-07-19T00:01:00Z",
                        "started_at": "2026-07-19T00:00:00Z",
                        "task_name": f"terminal-bench/{TASK}",
                        "verifier_result": {"rewards": {"reward": 0.0}},
                    }
                ),
                encoding="utf-8",
            )
            progress = {
                "arm": MODEL,
                "exceptionType": "AgentTimeoutError",
                "jobName": JOB,
                "jobRoot": str(job_root),
                "officialReward": 0.0,
                "scoreContribution": 0.0,
                "steps": 0,
                "taskIndex": 1,
                "taskName": TASK,
                "toolCalls": 0,
                "trajectory": None,
                "trajectoryStatus": "absent-scorable-agent-exception",
                "trial": TRIAL,
                "trialStatus": "verified",
            }

            # When the official result row is validated.
            row = trial_row(progress, {TASK})

            # Then the zero row is retained without synthesizing a trajectory.
            self.assertEqual(
                (
                    row["trajectory"],
                    row["scoreContribution"],
                    row["steps"],
                    row["toolCalls"],
                ),
                (None, 0.0, 0, 0),
            )


if __name__ == "__main__":
    unittest.main()
