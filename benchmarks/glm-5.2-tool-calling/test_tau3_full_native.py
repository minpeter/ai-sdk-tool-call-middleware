#!/usr/bin/env python3
"""Focused tests for the fresh, bounded-concurrency tau3 full runner."""

from __future__ import annotations

import contextlib
from collections.abc import Callable
import importlib.util
import io
import json
import os
import signal
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("tau3_full_native.py")
SPEC = importlib.util.spec_from_file_location("tau3_full_native", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
tau3 = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = tau3
SPEC.loader.exec_module(tau3)


def manifest() -> dict[str, object]:
    tasks = [
        {"domain": domain, "id": f"{domain}-{index:03d}"}
        for domain, count in tau3.EXPECTED_DOMAIN_COUNTS.items()
        for index in range(count)
    ]
    return {
        "benchmark": "tau3-bench",
        "commit": tau3.PINNED_COMMIT,
        "domainCounts": tau3.EXPECTED_DOMAIN_COUNTS,
        "taskCount": tau3.EXPECTED_TASKS,
        "taskSetSha256": "pinned-task-set",
        "tasks": tasks,
    }


def prepare_fresh_run(base: Path) -> tuple[Path, Path, Path, Path]:
    repo_root = base / "repo"
    cli = repo_root / "benchmarks/glm-5.2-tool-calling/tau2/tau2_cli.py"
    cli.parent.mkdir(parents=True)
    cli.write_text("# test wrapper\n", encoding="utf-8")

    tau_root = base / "tau3"
    (tau_root / "data/tau2").mkdir(parents=True)
    python = tau_root / ".venv/bin/python"
    python.parent.mkdir(parents=True)
    python.write_text("", encoding="utf-8")

    output_root = base / "output"
    output_root.mkdir()
    task_manifest = manifest()
    (output_root / "task-manifest.json").write_text(
        json.dumps(task_manifest) + "\n", encoding="utf-8"
    )
    (output_root / "run-meta.json").write_text(
        json.dumps(
            {
                "benchmarkCommit": tau3.PINNED_COMMIT,
                "bridgeTransientRetryPolicy": {
                    "additionalAttempts": 2,
                    "delayMs": 5_000,
                    "timeoutMsPerAttempt": 180_000,
                    "validatorRequiresRecoveredByteIdenticalRequest": True,
                },
                "campaignAdmissionContract": {
                    "globalCeiling": 4,
                    "tau3": 4,
                    "total": 4,
                },
                "freshness": {
                    "historicalRawInput": False,
                    "historicalScoreInput": False,
                    "outputRootAbsentBeforeCreation": True,
                    "preseed": False,
                    "resumeFromPriorRun": False,
                },
                "savePrefix": "fresh-test",
                "status": "running",
                "taskCountPerArm": tau3.EXPECTED_TASKS,
                "taskSetSha256": task_manifest["taskSetSha256"],
                "providerTransientRetries": 2,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    return repo_root, tau_root, output_root, python


def arguments(
    repo_root: Path,
    tau_root: Path,
    output_root: Path,
    python: Path,
    *,
    domain_workers: int | None = None,
    task_concurrency: int | None = None,
    request_timeout: int | None = None,
    max_tokens: int | None = None,
    dry_run: bool = False,
) -> list[str]:
    argv = [
        "--repo-root",
        str(repo_root),
        "--tau-root",
        str(tau_root),
        "--output-root",
        str(output_root),
        "--python",
        str(python),
        "--base-url",
        "http://127.0.0.1:9999/v1",
        "--save-prefix",
        "fresh-test",
    ]
    if domain_workers is not None:
        argv.extend(["--domain-workers", str(domain_workers)])
    if task_concurrency is not None:
        argv.extend(["--task-concurrency-per-run", str(task_concurrency)])
    if request_timeout is not None:
        argv.extend(["--request-timeout-seconds", str(request_timeout)])
    if max_tokens is not None:
        argv.extend(["--max-tokens", str(max_tokens)])
    if dry_run:
        argv.append("--dry-run")
    return argv


class SuccessfulProcess:
    def poll(self) -> int:
        return 0

    def wait(self, timeout: int | None = None) -> int:
        del timeout
        return 0

    def terminate(self) -> None:
        raise AssertionError("a completed fake process must not be terminated")

    def kill(self) -> None:
        raise AssertionError("a completed fake process must not be killed")


class PendingProcess:
    def __init__(self, failure: int | None = None) -> None:
        self.failure = failure
        self.terminated = False
        self.killed = False

    def poll(self) -> int | None:
        if self.killed:
            return -signal.SIGKILL
        if self.terminated:
            return -signal.SIGTERM
        return self.failure

    def wait(self, timeout: int | None = None) -> int:
        del timeout
        value = self.poll()
        return 0 if value is None else value

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.killed = True


class UnresponsiveProcess(PendingProcess):
    def poll(self) -> int | None:
        if self.killed:
            return -signal.SIGKILL
        return None

    def wait(self, timeout: int | float | None = None) -> int:
        del timeout
        if not self.killed:
            raise tau3.subprocess.TimeoutExpired("test-child", 0)
        return -signal.SIGKILL


class Tau3FullNativeTest(unittest.TestCase):
    def test_model_output_cap_is_exactly_16384(self) -> None:
        parsed = tau3.parse_args(
            arguments(Path("/repo"), Path("/tau3"), Path("/output"), Path("/python"))
        )
        self.assertEqual(parsed.max_tokens, 16_384)
        with self.assertRaises(SystemExit):
            tau3.parse_args(
                arguments(
                    Path("/repo"),
                    Path("/tau3"),
                    Path("/output"),
                    Path("/python"),
                    max_tokens=1024,
                )
            )

    def test_defaults_preserve_sequential_pairs_and_one_task_per_run(self) -> None:
        parsed = tau3.parse_args(
            arguments(Path("/repo"), Path("/tau3"), Path("/output"), Path("/python"))
        )
        self.assertEqual(parsed.domain_workers, 1)
        self.assertEqual(parsed.task_concurrency_per_run, 1)
        self.assertEqual(
            parsed.request_timeout_seconds, tau3.DEFAULT_REQUEST_TIMEOUT_SECONDS
        )
        self.assertEqual(parsed.concurrency.max_concurrent_child_runs, 2)
        self.assertEqual(parsed.concurrency.max_concurrent_simulation_tasks, 2)

        command = tau3.run_command(
            Path("/python"),
            Path("/repo/tau2_cli.py"),
            "airline",
            "native",
            save_prefix="fresh-test",
            agent_args="{}",
            user_args="{}",
            task_concurrency_per_run=1,
        )
        self.assertEqual(command[command.index("--max-concurrency") + 1], "1")
        self.assertEqual(
            command[command.index("--save-to") + 1],
            "fresh-test-airline-native",
        )
        self.assertEqual(command[command.index("--max-retries") + 1], "0")
        self.assertNotIn("--auto-resume", command)

    def test_bridge_client_timeout_is_bounded_and_recorded_in_dry_run(self) -> None:
        with TemporaryDirectory() as directory:
            repo_root, tau_root, output_root, python = prepare_fresh_run(
                Path(directory)
            )
            output = io.StringIO()
            with (
                patch.object(tau3, "git_revision", return_value=tau3.PINNED_COMMIT),
                contextlib.redirect_stdout(output),
            ):
                tau3.main(
                    arguments(
                        repo_root,
                        tau_root,
                        output_root,
                        python,
                        request_timeout=1200,
                        dry_run=True,
                    )
                )
            value = json.loads(output.getvalue())
            self.assertEqual(value["requestTimeoutSeconds"], 1200)
            agent_args = json.loads(
                value["commands"][0]["command"][
                    value["commands"][0]["command"].index("--agent-llm-args") + 1
                ]
            )
            self.assertEqual(agent_args["timeout_seconds"], 1200)
            self.assertEqual(agent_args["max_tokens"], 16_384)

    def test_dry_run_rejects_more_than_two_bridge_retries(self) -> None:
        with TemporaryDirectory() as directory:
            repo_root, tau_root, output_root, python = prepare_fresh_run(
                Path(directory)
            )
            run_meta_path = output_root / "run-meta.json"
            run_meta = json.loads(run_meta_path.read_text(encoding="utf-8"))
            run_meta["bridgeTransientRetryPolicy"]["additionalAttempts"] = 4
            run_meta["providerTransientRetries"] = 4
            run_meta_path.write_text(json.dumps(run_meta) + "\n", encoding="utf-8")

            with patch.object(
                tau3, "git_revision", return_value=tau3.PINNED_COMMIT
            ):
                with self.assertRaisesRegex(RuntimeError, "bridge retry policy"):
                    tau3.main(
                        arguments(
                            repo_root,
                            tau_root,
                            output_root,
                            python,
                            dry_run=True,
                        )
                    )

        with self.assertRaises(SystemExit):
            tau3.parse_args(
                arguments(
                    Path("/repo"),
                    Path("/tau3"),
                    Path("/output"),
                    Path("/python"),
                    request_timeout=tau3.MAX_REQUEST_TIMEOUT_SECONDS + 1,
                )
            )

    def test_global_admission_bound_is_exact(self) -> None:
        plan = tau3.concurrency_plan(2, 1)
        self.assertEqual(plan.max_concurrent_child_runs, 4)
        self.assertEqual(plan.max_concurrent_simulation_tasks, 4)
        with self.assertRaisesRegex(ValueError, "4"):
            tau3.concurrency_plan(3, 1)
        with self.assertRaisesRegex(ValueError, "between 1 and 4"):
            tau3.concurrency_plan(5, 1)

    def test_concurrency_metadata_precedes_eight_isolated_launches(self) -> None:
        with TemporaryDirectory() as directory:
            repo_root, tau_root, output_root, python = prepare_fresh_run(
                Path(directory)
            )
            commands: list[list[str]] = []
            logs: list[str] = []

            def launch(command: list[str], **kwargs: object) -> SuccessfulProcess:
                recorded = json.loads(
                    (output_root / "run-meta.json").read_text(encoding="utf-8")
                )["tau3Concurrency"]
                self.assertEqual(recorded["domainWorkers"], 2)
                self.assertEqual(recorded["taskConcurrencyPerRun"], 1)
                self.assertEqual(recorded["maxConcurrentSimulationTasks"], 4)
                commands.append(command)
                logs.append(str(getattr(kwargs["stdout"], "name")))
                return SuccessfulProcess()

            with (
                patch.object(tau3, "git_revision", return_value=tau3.PINNED_COMMIT),
                patch.object(tau3.subprocess, "Popen", side_effect=launch),
                patch.object(tau3.signal, "signal"),
                patch.dict(os.environ, {"FREEROUTER_API_KEY": "test-only"}),
            ):
                tau3.main(
                    arguments(
                        repo_root,
                        tau_root,
                        output_root,
                        python,
                        domain_workers=2,
                        task_concurrency=1,
                    )
                )

            self.assertEqual(len(commands), len(tau3.DOMAINS) * len(tau3.ARMS))
            self.assertEqual(len(set(logs)), len(logs))
            save_names = [
                command[command.index("--save-to") + 1] for command in commands
            ]
            self.assertEqual(len(set(save_names)), len(save_names))
            self.assertEqual(
                [
                    command[command.index("--max-concurrency") + 1]
                    for command in commands
                ],
                ["1"] * len(commands),
            )
            run_meta = json.loads(
                (output_root / "run-meta.json").read_text(encoding="utf-8")
            )
            self.assertEqual(run_meta["status"], "inference-complete")
            self.assertEqual(run_meta["tau3Concurrency"]["maxConcurrentChildRuns"], 4)

    def test_child_failure_terminates_every_active_peer_and_seals_root(self) -> None:
        with TemporaryDirectory() as directory:
            repo_root, tau_root, output_root, python = prepare_fresh_run(
                Path(directory)
            )
            processes: list[PendingProcess] = []
            handles: list[object] = []

            def launch(_command: list[str], **kwargs: object) -> PendingProcess:
                process = PendingProcess(failure=9 if not processes else None)
                processes.append(process)
                handles.append(kwargs["stdout"])
                return process

            with (
                patch.object(tau3, "git_revision", return_value=tau3.PINNED_COMMIT),
                patch.object(tau3.subprocess, "Popen", side_effect=launch),
                patch.object(tau3.signal, "signal"),
                patch.dict(os.environ, {"FREEROUTER_API_KEY": "test-only"}),
            ):
                with self.assertRaisesRegex(RuntimeError, "exit 9"):
                    tau3.main(
                        arguments(
                            repo_root,
                            tau_root,
                            output_root,
                            python,
                            domain_workers=2,
                            task_concurrency=1,
                        )
                    )

            self.assertEqual(len(processes), 4)
            self.assertFalse(processes[0].terminated)
            self.assertTrue(all(process.terminated for process in processes[1:]))
            run_meta = json.loads(
                (output_root / "run-meta.json").read_text(encoding="utf-8")
            )
            self.assertEqual(run_meta["status"], "invalid-incomplete")
            self.assertFalse(run_meta["includedInFinalScore"])
            self.assertEqual(run_meta["populationContribution"], 0)
            self.assertTrue(run_meta["reuseForbidden"])
            self.assertIn("exit 9", run_meta["failure"])
            self.assertIsNone(run_meta["interruptionSignal"])
            self.assertTrue(all(getattr(handle, "closed") for handle in handles))

    def test_signal_terminates_all_active_children_and_records_signal(self) -> None:
        with TemporaryDirectory() as directory:
            repo_root, tau_root, output_root, python = prepare_fresh_run(
                Path(directory)
            )
            handlers: dict[int, Callable[[int, None], None]] = {}
            processes: list[PendingProcess] = []

            def register(
                signum: int, handler: Callable[[int, None], None]
            ) -> None:
                handlers[signum] = handler

            def launch(_command: list[str], **_kwargs: object) -> PendingProcess:
                process = PendingProcess()
                processes.append(process)
                if len(processes) == 4:
                    handlers[signal.SIGTERM](signal.SIGTERM, None)
                return process

            with (
                patch.object(tau3, "git_revision", return_value=tau3.PINNED_COMMIT),
                patch.object(tau3.subprocess, "Popen", side_effect=launch),
                patch.object(tau3.signal, "signal", side_effect=register),
                patch.dict(os.environ, {"FREEROUTER_API_KEY": "test-only"}),
            ):
                with self.assertRaisesRegex(RuntimeError, "SIGTERM"):
                    tau3.main(
                        arguments(
                            repo_root,
                            tau_root,
                            output_root,
                            python,
                            domain_workers=2,
                            task_concurrency=1,
                        )
                    )

            self.assertEqual(len(processes), 4)
            self.assertTrue(all(process.terminated for process in processes))
            run_meta = json.loads(
                (output_root / "run-meta.json").read_text(encoding="utf-8")
            )
            self.assertEqual(run_meta["status"], "invalid-incomplete")
            self.assertEqual(run_meta["interruptionSignal"], "SIGTERM")

    def test_reap_kills_a_child_that_ignores_termination(self) -> None:
        process = UnresponsiveProcess()
        handle = io.BytesIO()
        child = tau3.ChildRun("native", "airline", handle, process)

        tau3.terminate_children([child])
        tau3.reap_children([child])
        tau3.close_handles([child])

        self.assertTrue(process.terminated)
        self.assertTrue(process.killed)
        self.assertTrue(handle.closed)

    def test_execution_path_creation_error_seals_root_before_launch(self) -> None:
        with TemporaryDirectory() as directory:
            repo_root, tau_root, output_root, python = prepare_fresh_run(
                Path(directory)
            )
            original_mkdir = Path.mkdir

            def fail_logs(
                path: Path,
                mode: int = 0o777,
                parents: bool = False,
                exist_ok: bool = False,
            ) -> None:
                if path == output_root / "logs":
                    raise OSError("synthetic log root failure")
                original_mkdir(
                    path,
                    mode=mode,
                    parents=parents,
                    exist_ok=exist_ok,
                )

            with (
                patch.object(tau3, "git_revision", return_value=tau3.PINNED_COMMIT),
                patch.object(tau3.Path, "mkdir", autospec=True, side_effect=fail_logs),
                patch.object(tau3.subprocess, "Popen") as popen,
                patch.object(tau3.signal, "signal"),
                patch.dict(os.environ, {"FREEROUTER_API_KEY": "test-only"}),
            ):
                with self.assertRaisesRegex(OSError, "synthetic log root failure"):
                    tau3.main(arguments(repo_root, tau_root, output_root, python))

            popen.assert_not_called()
            run_meta = json.loads(
                (output_root / "run-meta.json").read_text(encoding="utf-8")
            )
            self.assertEqual(run_meta["status"], "invalid-incomplete")
            self.assertIn("synthetic log root failure", run_meta["failure"])
            self.assertEqual(run_meta["tau3Concurrency"]["domainWorkers"], 1)

    def test_dry_run_validates_without_key_or_filesystem_mutation(self) -> None:
        with TemporaryDirectory() as directory:
            repo_root, tau_root, output_root, python = prepare_fresh_run(
                Path(directory)
            )
            original_meta = (output_root / "run-meta.json").read_bytes()
            output = io.StringIO()
            with (
                patch.object(tau3, "git_revision", return_value=tau3.PINNED_COMMIT),
                contextlib.redirect_stdout(output),
            ):
                tau3.main(
                    arguments(
                        repo_root,
                        tau_root,
                        output_root,
                        python,
                        domain_workers=2,
                        task_concurrency=1,
                        dry_run=True,
                    )
                )

            value = json.loads(output.getvalue())
            self.assertEqual(value["status"], "dry-run-valid")
            self.assertEqual(value["concurrency"]["maxConcurrentSimulationTasks"], 4)
            self.assertEqual(len(value["commands"]), 8)
            self.assertFalse((output_root / "data").exists())
            self.assertFalse((output_root / "logs").exists())
            self.assertEqual(
                (output_root / "run-meta.json").read_bytes(), original_meta
            )


if __name__ == "__main__":
    unittest.main()
