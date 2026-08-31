#!/usr/bin/env python3
"""Safety and isolation tests for the StableToolBench full runner."""

from __future__ import annotations

import json
import os
import socket
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import stabletoolbench_full_native as full  # noqa: E402
import stabletoolbench_service_isolation as isolation  # noqa: E402


def arguments(**overrides: object) -> SimpleNamespace:
    values: dict[str, object] = {
        "group_concurrency": 1,
        "max_tokens": full.REQUIRED_MAX_TOKENS,
        "request_timeout_seconds": full.DEFAULT_REQUEST_TIMEOUT_SECONDS,
        "service_cache_root": None,
        "service_mode": full.SHARED_SERVICE_MODE,
        "service_ready_timeout": 60,
        "service_server_root": None,
        "service_snapshot_root": None,
        "service_start_port": None,
        "service_url": "http://127.0.0.1:9999/virtual",
        "threads": 4,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def restore_write_permissions(root: Path) -> None:
    for path in [root, *root.rglob("*")]:
        if path.is_dir():
            path.chmod(0o755)
        elif path.is_file():
            path.chmod(0o644)


class StableToolBenchConcurrencyTest(unittest.TestCase):
    def test_arm_models_use_canonical_bridge_aliases(self) -> None:
        self.assertEqual(full.ARMS, ("gpt-native", "gpt-prompt-only"))
        self.assertEqual(
            full.MODELS,
            {
                "gpt-native": "glm52-native",
                "gpt-prompt-only": "glm52-prompt-only",
            },
        )

    def test_official_output_topology_matches_validator_and_evaluator(self) -> None:
        official = Path("/fresh/official")
        self.assertEqual(
            full.official_output_path(
                official,
                arm="gpt-prompt-only",
                group="G1_category",
            ),
            official / "gpt-prompt-only/G1_category",
        )

    def test_model_output_cap_is_exactly_16384(self) -> None:
        full.validate_concurrency(arguments(max_tokens=16_384))
        with self.assertRaisesRegex(RuntimeError, "max tokens"):
            full.validate_concurrency(arguments(max_tokens=1024))

    def test_request_timeout_covers_the_bridge_retry_window(self) -> None:
        full.validate_concurrency(arguments(request_timeout_seconds=960))
        with self.assertRaisesRegex(RuntimeError, "request timeout"):
            full.validate_concurrency(arguments(request_timeout_seconds=3601))

    def test_shared_service_fails_closed_for_parallel_groups(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "require managed per-lane"):
            full.validate_concurrency(arguments(group_concurrency=2))

    def test_managed_mode_allows_the_bounded_maximum(self) -> None:
        full.validate_concurrency(
            arguments(
                group_concurrency=6,
                service_mode=isolation.SERVICE_MODE,
                service_start_port=12000,
                service_url=None,
                threads=8,
            )
        )

    def test_aggregate_model_concurrency_is_capped(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "exceeds the safe bound"):
            full.validate_concurrency(
                arguments(
                    group_concurrency=6,
                    service_mode=isolation.SERVICE_MODE,
                    service_start_port=12000,
                    service_url=None,
                    threads=9,
                )
            )

    def test_managed_mode_rejects_ambiguous_shared_url(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "rejects a shared"):
            full.validate_concurrency(
                arguments(
                    service_mode=isolation.SERVICE_MODE,
                    service_start_port=12000,
                )
            )


class StableToolBenchIsolationTest(unittest.TestCase):
    def test_reuses_byte_identical_read_only_snapshot_without_copy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            (source / "value.json").write_text('{"value": 1}\n', encoding="utf-8")
            snapshot = root / "snapshot"
            isolation.materialize_read_only_snapshot(source, snapshot)
            with patch.object(
                isolation.shutil,
                "copytree",
                side_effect=AssertionError("reuse must not copy"),
            ):
                metadata = isolation.verify_reusable_read_only_snapshot(
                    source, snapshot
                )
            self.assertTrue(metadata["reused"])
            self.assertTrue(metadata["sealedReadOnly"])
            self.assertEqual(
                metadata["sha256"], isolation.fingerprint_tree(source)["sha256"]
            )

    def test_reusable_snapshot_rejects_source_drift_and_writable_tree(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            value = source / "value.json"
            value.write_text('{"value": 1}\n', encoding="utf-8")
            snapshot = root / "snapshot"
            isolation.materialize_read_only_snapshot(source, snapshot)
            value.write_text('{"value": 2}\n', encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "does not match"):
                isolation.verify_reusable_read_only_snapshot(source, snapshot)
            (snapshot / "value.json").chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, "writable"):
                isolation.verify_reusable_read_only_snapshot(source, snapshot)

    def test_fresh_lane_root_is_separate_from_shared_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shared = root / "invalid-v13/service-isolation"
            fresh = root / "fresh-v14/service-isolation"
            lanes = isolation.build_service_lanes(
                groups=("G1_category",),
                arms=("gpt-native",),
                start_port=12000,
                isolation_root=fresh,
            )
            self.assertTrue(lanes[0].workspace.is_relative_to(fresh))
            self.assertFalse(lanes[0].workspace.is_relative_to(shared))

    def test_unavailable_tool_stub_returns_http_miss_and_stops_cleanly(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            lanes = isolation.build_service_lanes(
                groups=("G1_category",),
                arms=("gpt-native",),
                start_port=12000,
                isolation_root=Path(directory),
            )
            isolation.assert_ports_available(lanes)
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            stub = isolation.UnavailableToolBenchStub(port)
            metadata = stub.start()
            try:
                request = urllib.request.Request(
                    stub.url, data=b'{"query":"fresh"}', method="POST"
                )
                with self.assertRaises(urllib.error.HTTPError) as raised:
                    urllib.request.urlopen(request, timeout=2)
                try:
                    self.assertEqual(
                        raised.exception.code,
                        isolation.TOOLBENCH_UNAVAILABLE_STATUS,
                    )
                finally:
                    raised.exception.close()
                self.assertTrue(metadata["ready"])
                self.assertEqual(metadata["status"], 503)
            finally:
                stub.stop()
            self.assertFalse(stub.metadata()["ready"])

    def test_lane_plan_is_unique_for_every_group_and_arm(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            lanes = isolation.build_service_lanes(
                groups=full.GROUPS,
                arms=full.ARMS,
                start_port=12000,
                isolation_root=Path(directory),
            )
        self.assertEqual(len(lanes), 12)
        self.assertEqual(len({lane.port for lane in lanes}), 12)
        self.assertEqual(len({lane.workspace for lane in lanes}), 12)
        self.assertEqual(len({lane.service_url for lane in lanes}), 12)
        self.assertEqual(
            {(lane.group, lane.arm) for lane in lanes},
            {(group, arm) for group in full.GROUPS for arm in full.ARMS},
        )

    def test_snapshot_is_byte_identical_and_read_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            (source / "nested").mkdir()
            (source / "a.json").write_text('{"a": 1}\n', encoding="utf-8")
            (source / "nested" / "b.json").write_text(
                '{"b": 2}\n', encoding="utf-8"
            )
            destination = root / "snapshot"
            metadata = isolation.materialize_read_only_snapshot(source, destination)
            try:
                self.assertEqual(
                    isolation.fingerprint_tree(source),
                    isolation.fingerprint_tree(destination),
                )
                self.assertTrue(metadata["sealedReadOnly"])
                isolation.verify_read_only_tree(destination)
                for path in [destination, *destination.rglob("*")]:
                    self.assertEqual(path.stat().st_mode & 0o222, 0)
            finally:
                restore_write_permissions(destination)

    def test_snapshot_rejects_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            target = source / "target.json"
            target.write_text("{}\n", encoding="utf-8")
            try:
                os.symlink(target, source / "alias.json")
            except OSError as error:
                self.skipTest(f"symlinks unavailable: {error}")
            with self.assertRaisesRegex(RuntimeError, "contains a symlink"):
                isolation.fingerprint_tree(source)

    def test_lane_configuration_disables_cache_writes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "cache"
            tools = root / "tools"
            cache.mkdir()
            tools.mkdir()
            lane = isolation.ServiceLane(
                arm="gpt-native",
                group="G1_category",
                port=12000,
                workspace=root / "lane",
            )
            metadata = isolation.write_service_config(
                lane=lane,
                cache_root=cache,
                tool_root=tools,
                simulator_base_url="http://127.0.0.1:8832/v1",
                simulator_model="glm52-simulator",
                toolbench_url="http://127.0.0.1:12012/unavailable",
            )
            configuration = json.loads(
                (lane.workspace / "config.yml").read_text(encoding="utf-8")
            )
            self.assertFalse(configuration["is_save"])
            self.assertEqual(configuration["cache_folder"], str(cache.resolve()))
            self.assertEqual(configuration["tools_folder"], str(tools.resolve()))
            self.assertEqual(
                configuration["log_file"],
                str((lane.workspace / "server-events.log").resolve()),
            )
            self.assertEqual(
                configuration["toolbench_url"],
                "http://127.0.0.1:12012/unavailable",
            )
            self.assertEqual(len(metadata["configSha256"]), 64)


if __name__ == "__main__":
    unittest.main()
