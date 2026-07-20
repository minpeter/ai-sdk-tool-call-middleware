#!/usr/bin/env python3
"""Read-only readiness audit for zero-reuse fresh replacement campaigns.

The audit never creates an output root and never reads or prints credential
values.  It is intended to run immediately before a campaign launch and after
an unexpected host restart.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
from pathlib import Path
from typing import Any, NotRequired, TypedDict


class ReplacementSpec(TypedDict):
    name: str
    relativeOutput: str
    referenceManifest: str
    countPath: tuple[str, ...]
    expectedPerArm: int
    port: int
    additionalAbsent: NotRequired[tuple[str, ...]]
    expandedOnly: NotRequired[bool]
    fullPopulationBlocked: NotRequired[str]


REPLACEMENTS: tuple[ReplacementSpec, ...] = (
    {
        "name": "ACEBench EN+ZH",
        "relativeOutput": "results/2026-07-20-glm52-native-vs-prompt-only-acebench-2040-fresh-v1",
        "referenceManifest": "results/2026-07-18-acebench-full-2040-fresh-v4/task-manifest.json",
        "countPath": ("rowCount",),
        "expectedPerArm": 2040,
        "port": 8838,
    },
    {
        "name": "MCPMark Verified standard",
        "relativeOutput": "results/2026-07-20-glm52-native-vs-prompt-only-mcpmark-127-fresh-v1",
        "referenceManifest": "results/2026-07-18-mcpmark-verified-127-fresh-v5/task-manifest.json",
        "countPath": ("taskCount",),
        "expectedPerArm": 127,
        "port": 8837,
    },
    {
        "name": "BFCL V4 all_scoring",
        "relativeOutput": "results/2026-07-20-glm52-native-vs-prompt-only-bfcl-5217-fresh-v1",
        "referenceManifest": "results/2026-07-19-bfcl-v4-full-production-fresh-v1/task-manifest.json",
        "countPath": ("counts", "all_scoring"),
        "expectedPerArm": 5217,
        "port": 18865,
    },
    {
        "name": "HammerBench EN+ZH",
        "relativeOutput": "results/2026-07-20-glm52-native-vs-prompt-only-hammerbench-61075-fresh-v1",
        "referenceManifest": "results/2026-07-19-hammerbench-full-61075-production-fresh-v1/task-manifest.json",
        "countPath": ("rowCount",),
        "expectedPerArm": 61075,
        "port": 18864,
    },
    {
        "name": "StableToolBench six groups",
        "relativeOutput": "results/2026-07-20-glm52-native-vs-prompt-only-stabletoolbench-765-fresh-v1",
        "referenceManifest": "results/2026-07-19-stabletoolbench-full-765-production-fresh-v1/task-manifest.json",
        "countPath": ("rowCount",),
        "expectedPerArm": 765,
        "port": 18866,
    },
    {
        "name": "tau3-bench base",
        "relativeOutput": "results/2026-07-20-glm52-native-vs-prompt-only-tau3-375-fresh-v1",
        "referenceManifest": "results/2026-07-19-tau3-base-375-production-fresh-v1/task-manifest.json",
        "countPath": ("taskCount",),
        "expectedPerArm": 375,
        "port": 18867,
    },
    {
        "name": "AppWorld test_normal + test_challenge",
        "relativeOutput": "results/2026-07-20-glm52-native-vs-prompt-only-appworld-585-fresh-v1",
        "referenceManifest": "results/2026-07-19-appworld-full-585-production-fresh-v1/task-manifest.json",
        "countPath": ("taskCount",),
        "expectedPerArm": 585,
        "port": 8834,
    },
    {
        "name": "VAKRA public test",
        "relativeOutput": "results/2026-07-20-glm52-native-vs-prompt-only-vakra-5207-fresh-v1",
        "referenceManifest": "results/2026-07-19-vakra-full-5207-production-fresh-v1/task-manifest.json",
        "countPath": ("taskCount",),
        "expectedPerArm": 5207,
        "port": 8835,
    },
    {
        "name": "Terminal-Bench 2.1",
        "relativeOutput": "results/2026-07-20-glm52-native-vs-prompt-only-terminalbench21-89-fresh-v1",
        "referenceManifest": "results/2026-07-19-terminal-bench-2-1-full-89-fresh-restart-v2/task-manifest.json",
        "countPath": ("taskCount",),
        "expectedPerArm": 89,
        "port": 8836,
    },
    {
        "name": "ToolSandbox named_scenarios",
        "relativeOutput": "results/2026-07-20-glm52-native-vs-prompt-only-toolsandbox-1032-fresh-v1",
        "referenceManifest": "results/2026-07-18-toolsandbox-full-1032-fresh-v1/task-manifest.json",
        "countPath": ("rowCount",),
        "expectedPerArm": 1032,
        "port": 8839,
        "expandedOnly": True,
        "fullPopulationBlocked": "523 tasks require an isolated RapidAPI environment",
    },
    {
        "name": "ComplexFuncBench official rows",
        "relativeOutput": "results/2026-07-20-glm52-native-vs-prompt-only-complexfuncbench-1000-fresh-v1",
        "referenceManifest": "results/2026-07-18-complexfuncbench-full-1000-fresh-v1/task-manifest.json",
        "countPath": ("rowCount",),
        "expectedPerArm": 1000,
        "port": 8840,
        "expandedOnly": True,
        "fullPopulationBlocked": "all 1,000 rows require Booking APIs and final-response judging",
    },
)

WEBARENA_IMAGES = (
    "shopping_final_0712",
    "shopping_admin_final_0719",
    "postmill-populated-exposed-withimg",
)
PLAYWRIGHT_EXECUTABLE = Path(
    "/home/minpeter/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome"
)
DEFAULT_VAKRA_ROOT = Path("/home/minpeter/.cache/glm52-benchmarks/vakra")
VAKRA_CAPABILITY_CONTAINERS = (
    "capability_1_bi_apis",
    "capability_2_dashboard_apis",
    "capability_3_multihop_reasoning",
    "capability_4_multiturn",
)


def nested(value: object, path: tuple[str, ...]) -> object:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected a JSON object")
    return value


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def command_output(command: list[str]) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, ""
    return result.returncode == 0, result.stdout + result.stderr


def docker_image_present(name: str) -> bool:
    ok, _ = command_output(["docker", "image", "inspect", name])
    if ok:
        return True
    ok, _ = command_output(["docker", "image", "inspect", f"{name}:latest"])
    return ok


def playwright_executable_present() -> bool:
    return PLAYWRIGHT_EXECUTABLE.is_file()


def detached_key_source_present() -> bool:
    prefix = b"FREEROUTER_API_KEY="
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            command = (process / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        if not command or command[0] != b"glm52-key-source":
            continue
        try:
            environment = (process / "environ").read_bytes().split(b"\0")
        except OSError:
            continue
        if any(
            value.startswith(prefix) and len(value) > len(prefix)
            for value in environment
        ):
            return True
    return False


def github_scopes() -> list[str]:
    ok, output = command_output(["gh", "auth", "status"])
    if not ok:
        return []
    marker = "Token scopes:"
    for line in output.splitlines():
        if marker not in line:
            continue
        raw = line.split(marker, 1)[1].strip().strip("'")
        return sorted(item.strip().strip("'") for item in raw.split(",") if item.strip())
    return []


def terminalbench_containers(dataset_root: Path) -> list[str]:
    ok, ids_text = command_output(["docker", "ps", "-aq"])
    ids = [line for line in ids_text.splitlines() if line.strip()] if ok else []
    if not ids:
        return []
    ok, inspected = command_output(["docker", "inspect", *ids])
    if not ok:
        return ["__docker_inspect_failed__"]
    records = json.loads(inspected)
    matches: list[str] = []
    for record in records:
        labels = ((record.get("Config") or {}).get("Labels") or {})
        working_dir = labels.get("com.docker.compose.project.working_dir")
        if not isinstance(working_dir, str):
            continue
        try:
            if Path(working_dir).is_relative_to(dataset_root):
                matches.append(str(record.get("Name", "unknown")).removeprefix("/"))
        except ValueError:
            continue
    return sorted(matches)


def vakra_capability_containers(vakra_root: Path) -> dict[str, Any]:
    """Verify that all four official VAKRA compose services are usable.

    Container names alone are insufficient: an unrelated container can reuse a
    canonical name after a restart.  Require the expected compose service and
    working-directory labels, a running/non-paused state, and a responsive
    ``docker exec`` that can see the pinned MCP dispatcher.
    """

    expected_root = vakra_root.resolve()
    containers: dict[str, dict[str, Any]] = {}
    for name in VAKRA_CAPABILITY_CONTAINERS:
        ok, output = command_output(["docker", "inspect", name])
        record: dict[str, Any] | None = None
        if ok:
            try:
                decoded = json.loads(output)
            except json.JSONDecodeError:
                decoded = None
            if (
                isinstance(decoded, list)
                and len(decoded) == 1
                and isinstance(decoded[0], dict)
            ):
                record = decoded[0]

        state = (record.get("State") or {}) if record is not None else {}
        config = (record.get("Config") or {}) if record is not None else {}
        labels = config.get("Labels") or {}
        health = state.get("Health")
        health_status = health.get("Status") if isinstance(health, dict) else None
        working_dir = labels.get("com.docker.compose.project.working_dir")
        try:
            compose_root_matches = (
                isinstance(working_dir, str)
                and Path(working_dir).resolve() == expected_root
            )
        except OSError:
            compose_root_matches = False
        running = all(
            (
                state.get("Running") is True,
                state.get("Status") == "running",
                state.get("Paused") is not True,
                state.get("Restarting") is not True,
                state.get("Dead") is not True,
            )
        )
        health_ready = health_status in (None, "healthy")
        dispatcher_ready = False
        if running:
            dispatcher_ready, _ = command_output(
                ["docker", "exec", name, "test", "-r", "/app/mcp_dispatch.py"]
            )
        service_matches = labels.get("com.docker.compose.service") == name
        image_matches = config.get("Image") in {
            "benchmark_environ",
            "benchmark_environ:latest",
        }
        ready = all(
            (
                record is not None,
                running,
                health_ready,
                compose_root_matches,
                service_matches,
                image_matches,
                dispatcher_ready,
            )
        )
        containers[name] = {
            "composeRootMatches": compose_root_matches,
            "dispatcherReadable": dispatcher_ready,
            "health": health_status or "not-configured",
            "healthReady": health_ready,
            "imageMatches": image_matches,
            "present": record is not None,
            "ready": ready,
            "running": running,
            "serviceMatches": service_matches,
        }
    return {
        "allReady": all(item["ready"] for item in containers.values()),
        "composeRoot": str(expected_root),
        "containers": containers,
        "expectedCount": len(VAKRA_CAPABILITY_CONTAINERS),
        "readyCount": sum(item["ready"] for item in containers.values()),
    }


def audit(
    benchmark_root: Path,
    tb21_dataset_root: Path,
    vakra_root: Path = DEFAULT_VAKRA_ROOT,
) -> dict[str, Any]:
    suites: list[dict[str, Any]] = []
    for spec in REPLACEMENTS:
        output = benchmark_root / str(spec["relativeOutput"])
        manifest_path = benchmark_root / str(spec["referenceManifest"])
        manifest_ok = False
        task_set_sha256: str | None = None
        observed_count: object = None
        try:
            manifest = read_json(manifest_path)
            observed_count = nested(manifest, spec["countPath"])
            task_set_sha256 = manifest.get("taskSetSha256")
            manifest_ok = (
                observed_count == spec["expectedPerArm"]
                and isinstance(task_set_sha256, str)
                and len(task_set_sha256) == 64
            )
        except (OSError, json.JSONDecodeError, RuntimeError):
            pass
        absent_paths = [output]
        absent_paths.extend(
            benchmark_root / relative
            for relative in spec.get("additionalAbsent", ())
        )
        suites.append(
            {
                "name": spec["name"],
                "expectedPerArm": spec["expectedPerArm"],
                "expectedFreshTrajectories": int(spec["expectedPerArm"]) * 2,
                "manifestCount": observed_count,
                "manifestReady": manifest_ok,
                "outputRootsAbsent": all(not os.path.lexists(path) for path in absent_paths),
                "port": spec["port"],
                "portFree": port_is_free(int(spec["port"])),
                "taskSetSha256": task_set_sha256,
            }
        )

    docker_ok, _ = command_output(["docker", "info"])
    scopes = github_scopes()
    vakra_runtime = vakra_capability_containers(vakra_root)
    webarena_images = {name: docker_image_present(name) for name in WEBARENA_IMAGES}
    free_gib = shutil.disk_usage(benchmark_root).free / (1024**3)
    mcpmark_services = {
        "filesystem": True,
        "postgres": docker_ok,
        "playwright": playwright_executable_present(),
        "github": bool(os.getenv("GITHUB_TOKENS") and os.getenv("GITHUB_EVAL_ORG")),
        "notion": bool(
            os.getenv("SOURCE_NOTION_API_KEY")
            and os.getenv("EVAL_NOTION_API_KEY")
        ),
        "playwright_webarena": all(webarena_images.values()),
    }
    inherited_provider_key = bool(os.getenv("FREEROUTER_API_KEY"))
    detached_provider_key = detached_key_source_present()
    global_checks = {
        "providerCredentialPresent": inherited_provider_key or detached_provider_key,
        "providerCredentialSource": (
            "inherited-process-environment"
            if inherited_provider_key
            else "detached-key-source"
            if detached_provider_key
            else "absent"
        ),
        "dockerReady": docker_ok,
        "replacementRootsAbsent": all(item["outputRootsAbsent"] for item in suites),
        "portsFree": all(item["portFree"] for item in suites),
        "manifestsReady": all(item["manifestReady"] for item in suites),
        "terminalBenchTaskContainers": terminalbench_containers(tb21_dataset_root),
        "minimumTerminalBenchDiskReady": free_gib >= 25,
        "vakraContainersReady": vakra_runtime["allReady"],
    }
    common_core_ready = all(
        global_checks[key] is True
        for key in (
            "providerCredentialPresent",
            "dockerReady",
            "replacementRootsAbsent",
            "portsFree",
            "manifestsReady",
            "minimumTerminalBenchDiskReady",
        )
    ) and not global_checks["terminalBenchTaskContainers"]
    mcpmark_ready = common_core_ready and all(mcpmark_services.values())
    for suite, spec in zip(suites, REPLACEMENTS, strict=True):
        full_population_blocker = spec.get("fullPopulationBlocked")
        if full_population_blocker is not None:
            suite["launchReady"] = False
            suite["fullPopulationBlocker"] = full_population_blocker
        elif suite["name"] == "MCPMark Verified standard":
            suite["launchReady"] = mcpmark_ready
        elif suite["name"] == "VAKRA public test":
            suite["launchReady"] = (
                common_core_ready and vakra_runtime["allReady"]
            )
        else:
            suite["launchReady"] = common_core_ready
    if mcpmark_ready and vakra_runtime["allReady"]:
        status = "ready"
    elif common_core_ready and vakra_runtime["allReady"]:
        status = "core-ready-mcpmark-blocked"
    elif common_core_ready:
        status = "core-ready-vakra-blocked"
    else:
        status = "not-ready"
    primary_suites = [
        suite
        for suite, spec in zip(suites, REPLACEMENTS, strict=True)
        if not spec.get("expandedOnly")
    ]
    return {
        "status": status,
        "global": {**global_checks, "freeDiskGiB": round(free_gib, 2)},
        "suites": suites,
        "campaignScopes": {
            "expanded11": {
                "casesPerArm": sum(int(item["expectedPerArm"]) for item in suites),
                "freshTrajectories": sum(
                    int(item["expectedFreshTrajectories"]) for item in suites
                ),
                "launchReady": all(item["launchReady"] for item in suites),
                "suiteCount": len(suites),
            },
            "primary9": {
                "casesPerArm": sum(
                    int(item["expectedPerArm"]) for item in primary_suites
                ),
                "freshTrajectories": sum(
                    int(item["expectedFreshTrajectories"]) for item in primary_suites
                ),
                "launchReady": all(item["launchReady"] for item in primary_suites),
                "suiteCount": len(primary_suites),
            },
        },
        "mcpmark127": {
            "allServicesReady": all(mcpmark_services.values()),
            "launchReady": mcpmark_ready,
            "services": mcpmark_services,
            "github": {
                "currentCliScopes": scopes,
                "deleteRepoCapabilityObserved": "delete_repo" in scopes,
                "explicitEvalOrgAuthorizationRequired": True,
            },
            "notion": {
                "sourceCredentialPresent": bool(os.getenv("SOURCE_NOTION_API_KEY")),
                "evalCredentialPresent": bool(os.getenv("EVAL_NOTION_API_KEY")),
                "isolatedSourceAndEvalHubsRequired": True,
            },
            "webarena": {
                "images": webarena_images,
                "additionalDockerStorageRequired": not all(webarena_images.values()),
            },
        },
        "vakra": vakra_runtime,
        "security": {
            "credentialValuesPrinted": False,
            "credentialValuesPersistedByAudit": False,
            "credentialPresenceOnlyInspected": True,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--benchmark-root",
        type=Path,
        default=Path(__file__).resolve().parent,
    )
    parser.add_argument(
        "--tb21-dataset-root",
        type=Path,
        default=Path(
            "/home/minpeter/.cache/glm52-benchmarks/terminal-bench-2-1/tasks"
        ),
    )
    parser.add_argument(
        "--vakra-root",
        type=Path,
        default=DEFAULT_VAKRA_ROOT,
    )
    parser.add_argument(
        "--report-only",
        action="store_true",
        help="always exit zero after printing the readiness report",
    )
    parser.add_argument(
        "--out",
        type=Path,
        help="optionally persist the sanitized JSON report",
    )
    args = parser.parse_args()
    report = audit(
        args.benchmark_root.resolve(),
        args.tb21_dataset_root.resolve(),
        args.vakra_root.resolve(),
    )
    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    if report["status"] != "ready" and not args.report_only:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
