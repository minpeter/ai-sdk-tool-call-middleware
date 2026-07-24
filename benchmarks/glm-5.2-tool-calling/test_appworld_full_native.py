#!/usr/bin/env python3
"""Focused tests for the fresh AppWorld full runner."""

from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("appworld_full_native.py")
SPEC = importlib.util.spec_from_file_location("appworld_full_native", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
appworld_runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = appworld_runner
SPEC.loader.exec_module(appworld_runner)


def arguments(
    source_root: Path,
    output_root: Path,
    workers: int | None = None,
    *,
    dry_run: bool = False,
) -> list[str]:
    argv = [
        "--source-root",
        str(source_root),
        "--output-root",
        str(output_root),
        "--appworld",
        "/venv/bin/appworld",
        "--experiment-tag",
        "fresh-v12",
    ]
    if workers is not None:
        argv.extend(["--num-processes-per-experiment", str(workers)])
    if dry_run:
        argv.append("--dry-run")
    return argv


def prepare_fresh_run(base: Path) -> tuple[Path, Path]:
    source_root = base / "source"
    (source_root / "data").mkdir(parents=True)
    output_root = base / "output"
    output_root.mkdir()
    (output_root / "run-meta.json").write_text(
        json.dumps(
            {
                "bridgePort": 8863,
                "bridgeTransientRetryPolicy": {
                    "additionalAttempts": 2,
                    "delayMs": 5_000,
                    "timeoutMsPerAttempt": 180_000,
                    "validatorRequiresRecoveredByteIdenticalRequest": True,
                },
                "campaignAdmissionContract": {
                    "appWorld": 8,
                    "globalCeiling": 8,
                    "total": 8,
                },
                "configBaseSha256": "c" * 64,
                "configSetSha256": "d" * 64,
                "experimentNames": list(
                    appworld_runner.experiment_names("fresh-v12")
                ),
                "experimentTag": "fresh-v12",
                "runtimeFingerprintAggregateSha256": "a" * 64,
                "runtimeFingerprintFile": "runtime-fingerprint.json",
                "runtimeStartAttestation": {"parserSha256": "b" * 64},
                "providerTransientRetries": 2,
                "status": "running",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (output_root / "task-manifest.json").write_text("{}\n", encoding="utf-8")
    return source_root, output_root


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


class AppWorldFullNativeTest(unittest.TestCase):
    def validation_patches(self):
        return (
            patch.object(
                appworld_runner,
                "validate_experiment_configs",
                return_value={
                    "baseSha256": "c" * 64,
                    "files": [],
                    "port": 8863,
                    "setSha256": "d" * 64,
                    "tag": "fresh-v12",
                },
            ),
            patch.object(
                appworld_runner,
                "validate_runtime_fingerprint",
                return_value={
                    "aggregateSha256": "a" * 64,
                    "parserFileCount": 122,
                    "parserSha256": "b" * 64,
                },
            ),
        )

    def test_default_is_one_and_custom_value_reaches_official_command(self) -> None:
        parsed = appworld_runner.parse_args(
            arguments(Path("/source"), Path("/output"))
        )
        self.assertEqual(parsed.num_processes_per_experiment, 1)

        command = appworld_runner.experiment_command(
            Path("/venv/bin/appworld"),
            appworld_runner.experiments("fresh-v12")[0],
            Path("/fresh/root"),
            parsed.num_processes_per_experiment,
        )
        self.assertEqual(command.count("--num-processes"), 1)
        self.assertEqual(command[command.index("--num-processes") + 1], "1")

        custom = appworld_runner.parse_args(
            arguments(Path("/source"), Path("/output"), 3)
        )
        self.assertEqual(custom.num_processes_per_experiment, 3)

    def test_experiment_names_use_canonical_bridge_aliases(self) -> None:
        self.assertEqual(
            appworld_runner.experiment_names("fresh-v12"),
            (
                "glm52-native-fresh-v12",
                "glm52-prompt-only-fresh-v12",
            ),
        )

    def test_worker_count_must_be_positive(self) -> None:
        for value in ("0", "-1", "not-an-integer"):
            with self.subTest(value=value):
                with self.assertRaises(argparse.ArgumentTypeError):
                    appworld_runner.positive_int(value)

    def test_experiment_tag_is_bounded_and_path_safe(self) -> None:
        self.assertEqual(appworld_runner.experiment_tag("fresh-v12"), "fresh-v12")
        for value in ("Fresh-v12", "fresh_v12", "../fresh-v12", "-fresh-v12"):
            with self.subTest(value=value):
                with self.assertRaises(argparse.ArgumentTypeError):
                    appworld_runner.experiment_tag(value)

    def test_runtime_fingerprint_source_set_contains_fast_paths(self) -> None:
        repo_root = MODULE_PATH.resolve().parents[2]
        paths = set(appworld_runner.runtime_source_paths(repo_root))
        self.assertTrue(
            {
                Path("src/core/protocols/glm5-call-parsing.ts"),
                Path("src/core/utils/provider-options.ts"),
                Path("src/generate-handler.ts"),
                Path("src/stream-handler.ts"),
                Path("src/transform-handler.ts"),
            }.issubset(paths)
        )
        self.assertFalse(any("__tests__" in path.parts for path in paths))

    def test_concurrency_is_persisted_before_all_four_processes_launch(self) -> None:
        with TemporaryDirectory() as directory:
            source_root, output_root = prepare_fresh_run(Path(directory))
            commands: list[list[str]] = []

            def launch(command: list[str], **_kwargs: object) -> SuccessfulProcess:
                run_meta = json.loads(
                    (output_root / "run-meta.json").read_text(encoding="utf-8")
                )
                self.assertEqual(run_meta["numProcessesPerExperiment"], 2)
                commands.append(command)
                return SuccessfulProcess()

            config_patch, runtime_patch = self.validation_patches()
            with config_patch, runtime_patch, patch.object(
                appworld_runner.subprocess, "Popen", side_effect=launch
            ), patch.object(appworld_runner.signal, "signal"):
                appworld_runner.main(arguments(source_root, output_root, 2))

            selected = appworld_runner.experiments("fresh-v12")
            self.assertEqual(len(commands), len(selected))
            self.assertEqual(
                [command[2] for command in commands],
                list(selected),
            )
            self.assertEqual(
                [command[command.index("--num-processes") + 1] for command in commands],
                ["2"] * len(selected),
            )
            run_meta = json.loads(
                (output_root / "run-meta.json").read_text(encoding="utf-8")
            )
            self.assertEqual(run_meta["status"], "inference-complete")
            self.assertEqual(run_meta["numProcessesPerExperiment"], 2)

    def test_existing_root_still_fails_before_metadata_or_launch(self) -> None:
        with TemporaryDirectory() as directory:
            source_root, output_root = prepare_fresh_run(Path(directory))
            (output_root / "root").mkdir()
            original_meta = (output_root / "run-meta.json").read_text(encoding="utf-8")

            config_patch, runtime_patch = self.validation_patches()
            with config_patch, runtime_patch, patch.object(
                appworld_runner.subprocess, "Popen"
            ) as popen:
                with self.assertRaisesRegex(RuntimeError, "refusing existing"):
                    appworld_runner.main(arguments(source_root, output_root, 2))

            popen.assert_not_called()
            self.assertEqual(
                (output_root / "run-meta.json").read_text(encoding="utf-8"),
                original_meta,
            )

    def test_campaign_rejects_more_than_eight_admissions(self) -> None:
        with TemporaryDirectory() as directory:
            source_root, output_root = prepare_fresh_run(Path(directory))
            config_patch, runtime_patch = self.validation_patches()
            with config_patch, runtime_patch, patch.object(
                appworld_runner.subprocess, "Popen"
            ) as popen:
                with self.assertRaisesRegex(RuntimeError, "exactly 8/8"):
                    appworld_runner.main(arguments(source_root, output_root, 3))
            popen.assert_not_called()

    def test_dry_run_rejects_legacy_global_128_contract(self) -> None:
        with TemporaryDirectory() as directory:
            source_root, output_root = prepare_fresh_run(Path(directory))
            run_meta_path = output_root / "run-meta.json"
            run_meta = json.loads(run_meta_path.read_text(encoding="utf-8"))
            run_meta["campaignAdmissionContract"]["globalCeiling"] = 128
            run_meta["campaignAdmissionContract"]["total"] = 128
            run_meta_path.write_text(json.dumps(run_meta) + "\n", encoding="utf-8")

            config_patch, runtime_patch = self.validation_patches()
            with config_patch, runtime_patch:
                with self.assertRaisesRegex(RuntimeError, "exactly 8/8"):
                    appworld_runner.main(
                        arguments(source_root, output_root, 2, dry_run=True)
                    )

    def test_dry_run_rejects_more_than_two_bridge_retries(self) -> None:
        with TemporaryDirectory() as directory:
            source_root, output_root = prepare_fresh_run(Path(directory))
            run_meta_path = output_root / "run-meta.json"
            run_meta = json.loads(run_meta_path.read_text(encoding="utf-8"))
            run_meta["bridgeTransientRetryPolicy"]["additionalAttempts"] = 4
            run_meta["providerTransientRetries"] = 4
            run_meta_path.write_text(json.dumps(run_meta) + "\n", encoding="utf-8")

            config_patch, runtime_patch = self.validation_patches()
            with config_patch, runtime_patch:
                with self.assertRaisesRegex(RuntimeError, "bridge retry policy"):
                    appworld_runner.main(
                        arguments(source_root, output_root, 2, dry_run=True)
                    )

    def test_dry_run_validates_without_launching_or_creating_execution_root(self) -> None:
        with TemporaryDirectory() as directory:
            source_root, output_root = prepare_fresh_run(Path(directory))
            config_patch, runtime_patch = self.validation_patches()
            stdout = io.StringIO()
            with config_patch, runtime_patch, patch.object(
                appworld_runner.subprocess, "Popen"
            ) as popen, contextlib.redirect_stdout(stdout):
                appworld_runner.main(
                    arguments(source_root, output_root, 2, dry_run=True)
                )

            popen.assert_not_called()
            self.assertFalse((output_root / "root").exists())
            report = json.loads(stdout.getvalue())
            self.assertEqual(report["admission"], 8)
            self.assertEqual(report["status"], "valid-dry-run")


if __name__ == "__main__":
    unittest.main()
