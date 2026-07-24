#!/usr/bin/env python3

import argparse
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
import json
from pathlib import Path
from threading import Barrier, Lock, RLock
import tempfile
import unittest
from unittest.mock import patch

runner = import_module("terminalbench2_official_native")
ARMS = runner.ARMS
PARALLEL_DISK_FLOOR_GIB = runner.PARALLEL_DISK_FLOOR_GIB
append_jsonl = runner.append_jsonl
bounded_max_output_tokens = runner.bounded_max_output_tokens
bounded_task_pairs = runner.bounded_task_pairs
effective_minimum_free_gb = runner.effective_minimum_free_gb
harbor_command = runner.harbor_command
job_specs_for_batch = runner.job_specs_for_batch
remove_new_batch_images = runner.remove_new_batch_images
require_fresh_output_root = runner.require_fresh_output_root
run_job_specs = runner.run_job_specs
task_batches = runner.task_batches
validate_completed_task_pairs = runner.validate_completed_task_pairs


def task(name: str) -> dict[str, object]:
    return {"dockerImage": f"image/{name}:latest", "name": name, "path": name}


class TerminalBenchPairSchedulingTest(unittest.TestCase):
    def test_arms_use_current_prompt_only_alias(self) -> None:
        self.assertEqual(ARMS, ("glm52-native", "glm52-prompt-only"))

    def test_max_output_tokens_are_bounded(self) -> None:
        self.assertEqual(bounded_max_output_tokens("16384"), 16384)
        for raw in ("0", "131073", "many"):
            with self.subTest(raw=raw), self.assertRaises(argparse.ArgumentTypeError):
                bounded_max_output_tokens(raw)

    def test_harbor_uses_the_selected_output_limit(self) -> None:
        command = harbor_command(
            Path("harbor"),
            Path("jobs"),
            Path("overlay.yaml"),
            task("sample"),
            ARMS[0],
            "job",
            18851,
            16384,
        )

        self.assertIn("max_tokens=16384", command)

    def test_harbor_uses_the_canonical_prompt_only_model_alias(self) -> None:
        command = harbor_command(
            Path("harbor"),
            Path("jobs"),
            Path("overlay.yaml"),
            task("sample"),
            "glm52-prompt-only",
            "job",
            18851,
            16384,
        )

        self.assertIn("openai/glm52-prompt-only", command)
        self.assertNotIn("openai/glm52-native-plus", command)

    def test_task_pairs_are_bounded_to_one_or_two(self) -> None:
        self.assertEqual(bounded_task_pairs("1"), 1)
        self.assertEqual(bounded_task_pairs("2"), 2)
        for raw in ("0", "3", "many"):
            with self.subTest(raw=raw), self.assertRaises(argparse.ArgumentTypeError):
                bounded_task_pairs(raw)

    def test_parallel_mode_enforces_45_gib_floor(self) -> None:
        self.assertEqual(effective_minimum_free_gb(8.0, 1), 8.0)
        self.assertEqual(
            effective_minimum_free_gb(8.0, 2), PARALLEL_DISK_FLOOR_GIB
        )
        self.assertEqual(effective_minimum_free_gb(52.0, 2), 52.0)
        for invalid in (-1.0, float("nan"), float("inf")):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                effective_minimum_free_gb(invalid, 2)

    def test_task_batches_preserve_manifest_order(self) -> None:
        tasks = [task("a"), task("b"), task("c")]

        serial = list(task_batches(tasks, 1))
        paired = list(task_batches(tasks, 2))

        self.assertEqual(
            [[(index, row["name"]) for index, row in batch] for batch in serial],
            [[(1, "a")], [(2, "b")], [(3, "c")]],
        )
        self.assertEqual(
            [[(index, row["name"]) for index, row in batch] for batch in paired],
            [[(1, "a"), (2, "b")], [(3, "c")]],
        )

    def test_each_parallel_job_has_unique_root_and_log(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            batch = [(1, task("a")), (2, task("b"))]

            specs = job_specs_for_batch(batch, root / "jobs", root / "logs")

            self.assertEqual(len(specs), 4)
            self.assertEqual(len({spec.job_name for spec in specs}), 4)
            self.assertEqual(len({spec.job_root for spec in specs}), 4)
            self.assertEqual(len({spec.console_path for spec in specs}), 4)
            self.assertEqual(
                {(spec.task_index, spec.arm) for spec in specs},
                {(index, arm) for index in (1, 2) for arm in ARMS},
            )

    def test_existing_output_root_is_never_resumed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "refusing existing output root"):
                require_fresh_output_root(Path(directory))
            require_fresh_output_root(Path(directory) / "absent")

    def test_default_mode_preserves_serial_arm_order(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            specs = job_specs_for_batch(
                [(1, task("a"))], root / "jobs", root / "logs"
            )
            observed: list[str] = []

            def runner(spec):
                observed.append(spec.arm)
                return {"arm": spec.arm, "taskIndex": spec.task_index}

            rows = run_job_specs(specs, 1, runner)

            self.assertEqual(observed, list(ARMS))
            self.assertEqual([row["arm"] for row in rows], list(ARMS))

    def test_two_task_pairs_run_four_jobs_concurrently(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            specs = job_specs_for_batch(
                [(1, task("a")), (2, task("b"))],
                root / "jobs",
                root / "logs",
            )
            barrier = Barrier(4, timeout=3)
            state_lock = Lock()
            active = 0
            maximum_active = 0

            def runner(spec):
                nonlocal active, maximum_active
                with state_lock:
                    active += 1
                    maximum_active = max(maximum_active, active)
                try:
                    barrier.wait()
                    return {"arm": spec.arm, "taskIndex": spec.task_index}
                finally:
                    with state_lock:
                        active -= 1

            rows = run_job_specs(specs, 2, runner)

            self.assertEqual(maximum_active, 4)
            validate_completed_task_pairs([(1, task("a")), (2, task("b"))], rows)

    def test_cleanup_gate_rejects_a_missing_or_duplicate_arm(self) -> None:
        batch = [(1, task("a"))]
        with self.assertRaisesRegex(RuntimeError, "both arms exactly once"):
            validate_completed_task_pairs(
                batch, [{"arm": ARMS[0], "taskIndex": 1}]
            )
        with self.assertRaisesRegex(RuntimeError, "both arms exactly once"):
            validate_completed_task_pairs(
                batch,
                [
                    {"arm": ARMS[0], "taskIndex": 1},
                    {"arm": ARMS[0], "taskIndex": 1},
                ],
            )


class TerminalBenchConcurrentOutputTest(unittest.TestCase):
    def test_progress_append_is_thread_safe_and_json_complete(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "progress.jsonl"
            lock = RLock()

            with ThreadPoolExecutor(max_workers=8) as executor:
                futures = [
                    executor.submit(append_jsonl, path, {"index": index}, lock=lock)
                    for index in range(200)
                ]
                for future in futures:
                    future.result()

            rows = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual(len(rows), 200)
            self.assertEqual({row["index"] for row in rows}, set(range(200)))

    @patch("terminalbench2_official_native.subprocess.run")
    @patch("terminalbench2_official_native.docker_image_container_references")
    @patch("terminalbench2_official_native.docker_refs")
    def test_image_cleanup_skips_preexisting_and_referenced_images(
        self, docker_refs, container_references, run
    ) -> None:
        docker_refs.return_value = {
            "base:latest",
            "hb__old:latest",
            "hb__free:latest",
            "hb__busy:latest",
            "task/new:latest",
        }
        container_references.side_effect = lambda ref: (
            ["container-id"] if ref == "hb__busy:latest" else []
        )
        run.return_value.returncode = 0

        result = remove_new_batch_images(
            {"base:latest", "hb__old:latest"},
            ["task/new:latest"],
            enabled=True,
        )

        self.assertEqual(result["referenced"], ["hb__busy:latest"])
        self.assertEqual(
            result["removed"], ["hb__free:latest", "task/new:latest"]
        )
        removed_refs = [call.args[0][-1] for call in run.call_args_list]
        self.assertEqual(removed_refs, ["hb__free:latest", "task/new:latest"])


if __name__ == "__main__":
    unittest.main()
