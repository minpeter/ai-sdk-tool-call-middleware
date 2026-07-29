#!/usr/bin/env python3

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from typing import TYPE_CHECKING
from unittest.mock import patch

if TYPE_CHECKING:
    from .audit_fresh_replacement_readiness import (
        REPLACEMENTS, ReplacementSpec, VAKRA_CAPABILITY_CONTAINERS, audit,
        vakra_capability_containers,
    )
else:
    from audit_fresh_replacement_readiness import (
        REPLACEMENTS, ReplacementSpec, VAKRA_CAPABILITY_CONTAINERS, audit,
        vakra_capability_containers,
    )


def manifest_for(spec: ReplacementSpec) -> dict[str, object]:
    value: dict[str, object] = {
        "taskSetSha256": "a" * 64,
    }
    current = value
    path = tuple(spec["countPath"])
    for key in path[:-1]:
        child: dict[str, object] = {}
        current[key] = child
        current = child
    current[path[-1]] = spec["expectedPerArm"]
    return value


class FreshReplacementReadinessTest(unittest.TestCase):
    @staticmethod
    def ready_vakra() -> dict[str, object]:
        return {
            "allReady": True,
            "composeRoot": "/vakra",
            "containers": {},
            "expectedCount": 4,
            "readyCount": 4,
        }

    def create_manifests(self, root: Path) -> None:
        for spec in REPLACEMENTS:
            path = root / str(spec["referenceManifest"])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps(manifest_for(spec)) + "\n",
                encoding="utf-8",
            )

    def test_replacements_use_new_prompt_only_campaign_roots(self) -> None:
        # Given: the shared readiness inventory.
        expected_roots = {
            "2026-07-20-glm52-native-vs-prompt-only-acebench-2040-fresh-v1",
            "2026-07-20-glm52-native-vs-prompt-only-appworld-585-fresh-v1",
            "2026-07-20-glm52-native-vs-prompt-only-bfcl-5217-fresh-v1",
            "2026-07-20-glm52-native-vs-prompt-only-complexfuncbench-1000-fresh-v1",
            "2026-07-20-glm52-native-vs-prompt-only-hammerbench-61075-fresh-v1",
            "2026-07-20-glm52-native-vs-prompt-only-mcpmark-127-fresh-v1",
            "2026-07-20-glm52-native-vs-prompt-only-stabletoolbench-765-fresh-v1",
            "2026-07-20-glm52-native-vs-prompt-only-tau3-375-fresh-v1",
            "2026-07-20-glm52-native-vs-prompt-only-terminalbench21-89-fresh-v1",
            "2026-07-20-glm52-native-vs-prompt-only-toolsandbox-1032-fresh-v1",
            "2026-07-20-glm52-native-vs-prompt-only-vakra-5207-fresh-v1",
        }

        # When: output basenames are collected from every suite.
        actual_roots = {
            Path(str(spec["relativeOutput"])).name for spec in REPLACEMENTS
        }

        # Then: the expanded 11-suite campaign has unique, brand-new roots.
        self.assertEqual(actual_roots, expected_roots)
        self.assertEqual(len(actual_roots), len(REPLACEMENTS))

    def test_core4_readiness_ports_match_the_active_launcher(self) -> None:
        # Given: the shared readiness inventory used before a core4 launch.
        ports = {spec["name"]: spec["port"] for spec in REPLACEMENTS}

        # When/Then: every core4 suite uses its active isolated bridge port.
        self.assertEqual(ports["HammerBench EN+ZH"], 18864)
        self.assertEqual(ports["BFCL V4 all_scoring"], 18865)
        self.assertEqual(ports["StableToolBench six groups"], 18866)
        self.assertEqual(ports["tau3-bench base"], 18867)

    def test_core_suites_can_be_ready_while_mcpmark_services_are_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.create_manifests(root)
            disk = shutil._ntuple_diskusage(100 * 1024**3, 10, 90 * 1024**3)
            environment = {
                "FREEROUTER_API_KEY": "present-but-never-read",
            }
            with (
                patch.dict(os.environ, environment, clear=True),
                patch(
                    "audit_fresh_replacement_readiness.command_output",
                    return_value=(True, ""),
                ),
                patch(
                    "audit_fresh_replacement_readiness.port_is_free",
                    return_value=True,
                ),
                patch(
                    "audit_fresh_replacement_readiness.playwright_executable_present",
                    return_value=True,
                ),
                patch(
                    "audit_fresh_replacement_readiness.detached_key_source_present",
                    return_value=False,
                ),
                patch(
                    "audit_fresh_replacement_readiness.docker_image_present",
                    return_value=False,
                ),
                patch(
                    "audit_fresh_replacement_readiness.github_scopes",
                    return_value=["repo"],
                ),
                patch(
                    "audit_fresh_replacement_readiness.terminalbench_containers",
                    return_value=[],
                ),
                patch(
                    "audit_fresh_replacement_readiness.vakra_capability_containers",
                    return_value=self.ready_vakra(),
                ),
                patch(
                    "audit_fresh_replacement_readiness.shutil.disk_usage",
                    return_value=disk,
                ),
            ):
                report = audit(root, root / "tb21")
            self.assertEqual(report["status"], "core-ready-mcpmark-blocked")
            suites = {item["name"]: item for item in report["suites"]}
            self.assertFalse(suites["MCPMark Verified standard"]["launchReady"])
            self.assertTrue(suites["Terminal-Bench 2.1"]["launchReady"])
            self.assertFalse(report["mcpmark127"]["allServicesReady"])
            self.assertEqual(
                report["campaignScopes"],
                {
                    "expanded11": {
                        "casesPerArm": 77512,
                        "freshTrajectories": 155024,
                        "launchReady": False,
                        "suiteCount": 11,
                    },
                    "primary9": {
                        "casesPerArm": 75480,
                        "freshTrajectories": 150960,
                        "launchReady": False,
                        "suiteCount": 9,
                    },
                },
            )

    def test_existing_replacement_root_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.create_manifests(root)
            first = root / str(REPLACEMENTS[0]["relativeOutput"])
            first.mkdir(parents=True)
            disk = shutil._ntuple_diskusage(100 * 1024**3, 10, 90 * 1024**3)
            with (
                patch.dict(os.environ, {"FREEROUTER_API_KEY": "present"}, clear=True),
                patch(
                    "audit_fresh_replacement_readiness.command_output",
                    return_value=(True, ""),
                ),
                patch(
                    "audit_fresh_replacement_readiness.port_is_free",
                    return_value=True,
                ),
                patch(
                    "audit_fresh_replacement_readiness.playwright_executable_present",
                    return_value=True,
                ),
                patch(
                    "audit_fresh_replacement_readiness.detached_key_source_present",
                    return_value=False,
                ),
                patch(
                    "audit_fresh_replacement_readiness.docker_image_present",
                    return_value=True,
                ),
                patch(
                    "audit_fresh_replacement_readiness.github_scopes",
                    return_value=["delete_repo", "repo"],
                ),
                patch(
                    "audit_fresh_replacement_readiness.terminalbench_containers",
                    return_value=[],
                ),
                patch(
                    "audit_fresh_replacement_readiness.vakra_capability_containers",
                    return_value=self.ready_vakra(),
                ),
                patch(
                    "audit_fresh_replacement_readiness.shutil.disk_usage",
                    return_value=disk,
                ),
            ):
                report = audit(root, root / "tb21")
            self.assertEqual(report["status"], "not-ready")
            self.assertFalse(report["global"]["replacementRootsAbsent"])
            self.assertFalse(report["suites"][0]["launchReady"])

    def test_vakra_suite_fails_closed_when_one_container_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.create_manifests(root)
            disk = shutil._ntuple_diskusage(100 * 1024**3, 10, 90 * 1024**3)
            missing_vakra = self.ready_vakra()
            missing_vakra["allReady"] = False
            missing_vakra["readyCount"] = 3
            with (
                patch.dict(os.environ, {"FREEROUTER_API_KEY": "present"}, clear=True),
                patch(
                    "audit_fresh_replacement_readiness.command_output",
                    return_value=(True, ""),
                ),
                patch(
                    "audit_fresh_replacement_readiness.port_is_free",
                    return_value=True,
                ),
                patch(
                    "audit_fresh_replacement_readiness.playwright_executable_present",
                    return_value=True,
                ),
                patch(
                    "audit_fresh_replacement_readiness.detached_key_source_present",
                    return_value=False,
                ),
                patch(
                    "audit_fresh_replacement_readiness.docker_image_present",
                    return_value=False,
                ),
                patch(
                    "audit_fresh_replacement_readiness.github_scopes",
                    return_value=["repo"],
                ),
                patch(
                    "audit_fresh_replacement_readiness.terminalbench_containers",
                    return_value=[],
                ),
                patch(
                    "audit_fresh_replacement_readiness.vakra_capability_containers",
                    return_value=missing_vakra,
                ),
                patch(
                    "audit_fresh_replacement_readiness.shutil.disk_usage",
                    return_value=disk,
                ),
            ):
                report = audit(root, root / "tb21", root / "vakra")
            suites = {item["name"]: item for item in report["suites"]}
            self.assertEqual(report["status"], "core-ready-vakra-blocked")
            self.assertFalse(report["global"]["vakraContainersReady"])
            self.assertFalse(suites["VAKRA public test"]["launchReady"])
            self.assertTrue(suites["BFCL V4 all_scoring"]["launchReady"])

    def test_vakra_container_audit_requires_owned_running_dispatchers(self) -> None:
        root = Path("/tmp/pinned-vakra")

        def command(command: list[str]) -> tuple[bool, str]:
            name = command[2]
            if command[:2] == ["docker", "exec"]:
                return name != VAKRA_CAPABILITY_CONTAINERS[-1], ""
            record = {
                "State": {
                    "Status": "running",
                    "Running": True,
                    "Paused": False,
                    "Restarting": False,
                    "Dead": False,
                },
                "Config": {
                    "Image": "benchmark_environ",
                    "Labels": {
                        "com.docker.compose.project.working_dir": str(root),
                        "com.docker.compose.service": name,
                    },
                },
            }
            return True, json.dumps([record])

        with patch(
            "audit_fresh_replacement_readiness.command_output",
            side_effect=command,
        ):
            report = vakra_capability_containers(root)
        self.assertFalse(report["allReady"])
        self.assertEqual(report["readyCount"], 3)
        last = report["containers"][VAKRA_CAPABILITY_CONTAINERS[-1]]
        self.assertFalse(last["dispatcherReadable"])
        self.assertFalse(last["ready"])


if __name__ == "__main__":
    unittest.main()
