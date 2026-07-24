#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import threading
import time
import unittest
from collections.abc import Sequence
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Protocol, TypedDict
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("vakra_official_native.py")
SPEC = importlib.util.spec_from_file_location("vakra_official_native", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
vakra = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = vakra
SPEC.loader.exec_module(vakra)


class DomainSpecLike(Protocol):
    capability: int
    capability_name: str
    domain: str
    expected_uuids: tuple[str, ...]
    relative_path: str
    row_count: int


class ManifestEntry(TypedDict):
    bytes: int
    capability: str
    path: str
    rowCount: int
    sha256: str


class VakraManifest(TypedDict):
    benchmark: str
    counts: dict[str, int]
    files: list[ManifestEntry]
    taskCount: int


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False) + "\n").encode()


def source_entry(
    root: Path, capability: int, domain: str, uuid: str
) -> ManifestEntry:
    capability_name = vakra.CAPABILITY_NAMES[capability]
    relative = f"test/{capability_name}/input/{domain}.json"
    payload = json_bytes([{"domain": domain, "uuid": uuid}])
    path = root / "data" / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return {
        "bytes": len(payload),
        "capability": capability_name,
        "path": relative,
        "rowCount": 1,
        "sha256": hashlib.sha256(payload).hexdigest(),
    }


def manifest_for(entries: Sequence[ManifestEntry]) -> VakraManifest:
    counts = {name: 0 for name in vakra.CAPABILITY_NAMES.values()}
    for entry in entries:
        counts[entry["capability"]] += entry["rowCount"]
    return {
        "benchmark": "VAKRA",
        "counts": counts,
        "files": list(entries),
        "taskCount": sum(counts.values()),
    }


def validated_specs() -> tuple[DomainSpecLike, ...]:
    return tuple(
        vakra.DomainSpec(
            capability=capability,
            capability_name=capability_name,
            domain=f"domain_{capability}",
            relative_path=(
                f"test/{capability_name}/input/domain_{capability}.json"
            ),
            row_count=1,
            expected_uuids=(f"uuid-{capability}",),
        )
        for capability, capability_name in vakra.CAPABILITY_NAMES.items()
    )


def write_shard(output_root: Path, spec: DomainSpecLike, arm: str) -> None:
    shard = vakra.shard_output_path(output_root, spec, arm)
    shard.mkdir(parents=True)
    rows = [
        {
            "domain": spec.domain,
            "status": "success",
            "uuid": uuid,
        }
        for uuid in spec.expected_uuids
    ]
    tools = [
        {
            "all_tools": ["lookup"],
            "domain": spec.domain,
            "query": "query",
            "shortlisted_tools": ["lookup"],
            "uuid": uuid,
        }
        for uuid in spec.expected_uuids
    ]
    (shard / f"{spec.domain}.json").write_bytes(json_bytes(rows))
    (shard / f"{spec.domain}_tools.json").write_bytes(json_bytes(tools))
    (shard / "run.log").write_text("complete\n", encoding="utf-8")


class VakraOfficialNativeTest(unittest.TestCase):
    def test_active_vakra_pipeline_uses_current_prompt_only_alias(self) -> None:
        expected = ("glm52-native", "glm52-prompt-only")
        for module_name in (
            "vakra_official_native",
            "validate_vakra_official",
            "vakra_official_evaluate",
            "validate_vakra_scores",
        ):
            with self.subTest(module=module_name):
                module = __import__(module_name)
                self.assertEqual(module.ARMS, expected)

    def test_arms_use_current_prompt_only_alias(self) -> None:
        self.assertEqual(
            vakra.ARMS,
            ("glm52-native", "glm52-prompt-only"),
        )

    def test_default_command_remains_legacy_compatible(self) -> None:
        python = Path("/venv/bin/python")
        code_root = Path("/vakra")
        arm_root = Path("/fresh/outputs/glm52-native")
        command = vakra.command_for(
            python, code_root, 1, "glm52-native", arm_root, 128, None
        )
        self.assertEqual(
            command,
            [
                "/venv/bin/python",
                "/vakra/benchmark_runner.py",
                "--capability_id",
                "1",
                "--provider",
                "litellm",
                "--model",
                "glm52-native",
                "--output",
                "/fresh/outputs/glm52-native/capability-1",
                "--top-k-tools",
                "128",
                "--temperature",
                "0",
            ],
        )
        self.assertNotIn("--parallel", command)
        self.assertNotIn("--domain", command)

    def test_shard_command_has_one_domain_and_unique_output(self) -> None:
        spec = validated_specs()[0]
        output_root = Path("/fresh")
        commands = vakra.shard_commands(
            (spec,),
            Path("/venv/bin/python"),
            Path("/vakra"),
            output_root,
            128,
            9,
        )
        command = commands[
            f"capability-{spec.capability}/{spec.domain}/glm52-native"
        ]
        self.assertEqual(command.count("--domain"), 1)
        self.assertEqual(command[command.index("--domain") + 1], spec.domain)
        self.assertEqual(
            command[command.index("--output") + 1],
            str(vakra.shard_output_path(output_root, spec, "glm52-native")),
        )
        self.assertNotIn("--parallel", command)

    def test_manifest_inventory_is_sorted_and_duplicate_fails_closed(self) -> None:
        entries: list[ManifestEntry] = [
            {
                "bytes": 1,
                "capability": name,
                "path": f"test/{name}/input/domain_{capability}.json",
                "rowCount": 1,
                "sha256": "hash",
            }
            for capability, name in reversed(vakra.CAPABILITY_NAMES.items())
        ]
        manifest = manifest_for(entries)
        with patch.object(vakra, "EXPECTED_TASKS", 4):
            specs = vakra.domain_specs_from_manifest(manifest)
            self.assertEqual([spec.capability for spec in specs], [1, 2, 3, 4])
            duplicate = manifest_for([*entries, entries[-1]])
            with self.assertRaisesRegex(RuntimeError, "duplicated"):
                vakra.domain_specs_from_manifest(duplicate)

    def test_dataset_validation_pins_domain_uuid_and_bytes(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            entries = [
                source_entry(
                    root,
                    capability,
                    f"domain_{capability}",
                    f"uuid-{capability}",
                )
                for capability in vakra.CAPABILITIES
            ]
            with patch.object(vakra, "EXPECTED_TASKS", 4):
                specs = vakra.validate_dataset(manifest_for(entries), root)
            self.assertEqual(
                [spec.expected_uuids for spec in specs],
                [("uuid-1",), ("uuid-2",), ("uuid-3",), ("uuid-4",)],
            )

            source = root / "data" / str(entries[0]["path"])
            source.write_bytes(json_bytes([{"domain": "wrong", "uuid": "uuid-1"}]))
            entries[0]["bytes"] = source.stat().st_size
            entries[0]["sha256"] = hashlib.sha256(source.read_bytes()).hexdigest()
            with patch.object(vakra, "EXPECTED_TASKS", 4):
                with self.assertRaisesRegex(RuntimeError, "domain drift"):
                    vakra.validate_dataset(manifest_for(entries), root)

    def test_capability_worker_bound_is_enforced(self) -> None:
        specs = tuple(
            vakra.DomainSpec(1, f"domain_{index}", "capability_1_bi_apis", "x", 1)
            for index in range(8)
        )
        lock = threading.Lock()
        active = 0
        peak = 0

        def run_pair(_spec: DomainSpecLike) -> tuple[object, ...]:
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.02)
            with lock:
                active -= 1
            return ()

        vakra.run_capability_shards(specs, 2, run_pair)
        self.assertEqual(peak, 2)
        with self.assertRaisesRegex(RuntimeError, "between 1 and 2"):
            vakra.run_capability_shards(specs, 3, run_pair)

    def test_parallel_capabilities_keep_independent_bounds(self) -> None:
        specs = tuple(
            vakra.DomainSpec(
                capability,
                f"domain_{capability}_{index}",
                vakra.CAPABILITY_NAMES[capability],
                "x",
                1,
            )
            for capability in vakra.CAPABILITIES
            for index in range(4)
        )
        lock = threading.Lock()
        active = {capability: 0 for capability in vakra.CAPABILITIES}
        peak = {capability: 0 for capability in vakra.CAPABILITIES}
        total_peak = 0

        def run_pair(spec: DomainSpecLike) -> tuple[object, ...]:
            nonlocal total_peak
            with lock:
                active[spec.capability] += 1
                peak[spec.capability] = max(
                    peak[spec.capability], active[spec.capability]
                )
                total_peak = max(total_peak, sum(active.values()))
            time.sleep(0.03)
            with lock:
                active[spec.capability] -= 1
            return ()

        vakra.run_domain_shards(
            specs,
            workers_per_capability=2,
            parallel_capabilities=True,
            run_pair=run_pair,
        )
        self.assertEqual(peak, {1: 2, 2: 2, 3: 2, 4: 2})
        self.assertEqual(total_peak, 8)

    def test_domain_scheduler_uses_largest_processing_time_first(self) -> None:
        specs = tuple(
            vakra.DomainSpec(
                1,
                domain,
                vakra.CAPABILITY_NAMES[1],
                "x",
                row_count,
            )
            for domain, row_count in (
                ("small", 2),
                ("largest_b", 9),
                ("medium", 5),
                ("largest_a", 9),
            )
        )
        observed: list[str] = []

        def run_pair(spec: DomainSpecLike) -> tuple[object, ...]:
            observed.append(spec.domain)
            return ()

        vakra.run_domain_shards(
            specs,
            workers_per_capability=1,
            parallel_capabilities=False,
            run_pair=run_pair,
        )
        self.assertEqual(observed, ["largest_a", "largest_b", "medium", "small"])

    def test_shard_validation_and_atomic_canonical_aggregate(self) -> None:
        specs = validated_specs()
        with TemporaryDirectory() as directory:
            output_root = Path(directory)
            for arm in vakra.ARMS:
                for spec in specs:
                    write_shard(output_root, spec, arm)

            with patch.object(vakra, "EXPECTED_TASKS", 4):
                manifest = vakra.aggregate_shards(output_root, specs)
            self.assertEqual(
                manifest["taskCountPerArm"],
                {"glm52-native": 4, "glm52-prompt-only": 4},
            )
            self.assertEqual(manifest["domainShardCount"], 8)
            self.assertEqual(manifest["itemConcurrencyWithinShard"], 1)
            self.assertFalse((output_root / ".outputs.aggregate.tmp").exists())
            canonical_manifest = json.loads(
                (output_root / "outputs/aggregate-manifest.json").read_text()
            )
            self.assertEqual(canonical_manifest, manifest)
            self.assertEqual(
                [
                    (entry["arm"], entry["capability"], entry["domain"])
                    for entry in manifest["files"]
                ],
                sorted(
                    (
                        (arm, spec.capability, spec.domain)
                        for arm in vakra.ARMS
                        for spec in specs
                    ),
                    key=lambda item: (
                        vakra.ARMS.index(item[0]),
                        item[1],
                        item[2],
                    ),
                ),
            )
            with patch.object(vakra, "EXPECTED_TASKS", 4):
                with self.assertRaisesRegex(RuntimeError, "existing.*canonical"):
                    vakra.aggregate_shards(output_root, specs)

    def test_shard_uuid_drift_fails_closed_before_aggregate(self) -> None:
        spec = validated_specs()[0]
        with TemporaryDirectory() as directory:
            output_root = Path(directory)
            write_shard(output_root, spec, vakra.ARMS[0])
            result = vakra.shard_output_path(output_root, spec, vakra.ARMS[0]) / (
                f"{spec.domain}.json"
            )
            value = json.loads(result.read_text())
            value[0]["uuid"] = "wrong"
            result.write_bytes(json_bytes(value))
            with self.assertRaisesRegex(RuntimeError, "UUID/order mismatch"):
                vakra.validate_shard_output(output_root, spec, vakra.ARMS[0])

    def test_existing_shard_refuses_launch(self) -> None:
        spec = validated_specs()[0]
        with TemporaryDirectory() as directory:
            output_root = Path(directory)
            vakra.shard_output_path(output_root, spec, vakra.ARMS[1]).mkdir(
                parents=True
            )
            with patch.object(vakra.subprocess, "Popen") as popen:
                with self.assertRaisesRegex(RuntimeError, "existing.*shard output"):
                    vakra.run_domain_pair(
                        spec,
                        commands={},
                        output_root=output_root,
                        code_root=Path("/vakra"),
                        environment={},
                        child_log_mode="discard",
                    )
                popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
