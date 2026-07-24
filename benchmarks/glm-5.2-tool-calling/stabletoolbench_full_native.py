#!/usr/bin/env python3
"""Run all six pinned StableToolBench groups as fresh paired arms.

The default remains one group at a time against one caller-supplied service.
Parallel groups are allowed only with managed per-lane service isolation: each
``group x arm`` lane receives its own server process and mutable workspace,
while byte-verified tool/cache snapshots are shared read-only.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any, Final

from stabletoolbench_service_isolation import (
    SERVICE_MODE,
    ManagedServiceFarm,
    ServiceLane,
    assert_ports_available,
    build_service_lanes,
    fingerprint_tree,
    inspect_server_source,
    materialize_read_only_snapshot,
    materialize_server_code,
    sha256_file,
    verify_reusable_read_only_snapshot,
)


GROUPS = (
    "G1_category",
    "G1_instruction",
    "G1_tool",
    "G2_category",
    "G2_instruction",
    "G3_instruction",
)
GROUP_COUNTS = {
    "G1_category": 153,
    "G1_instruction": 163,
    "G1_tool": 158,
    "G2_category": 124,
    "G2_instruction": 106,
    "G3_instruction": 61,
}
ARMS: Final = ("gpt-native", "gpt-prompt-only")
MODELS: Final = {
    "gpt-native": "glm52-native",
    "gpt-prompt-only": "glm52-prompt-only",
}
PINNED_COMMIT = "aa4ed9f4737ad98bd706663f01d63623c3427812"
SHARED_SERVICE_MODE = "shared-sequential"
MAX_GROUP_CONCURRENCY = len(GROUPS)
MAX_THREADS_PER_ARM = 16
MAX_MODEL_REQUEST_THREADS = 96
DEFAULT_REQUEST_TIMEOUT_SECONDS = 960
MAX_REQUEST_TIMEOUT_SECONDS = 3600
REQUIRED_MAX_TOKENS = 16_384


def now() -> str:
    return datetime.now().astimezone().isoformat()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected a JSON object")
    return value


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--code-root", type=Path, required=True)
    parser.add_argument("--tool-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--service-url")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--max-tokens", type=int, default=REQUIRED_MAX_TOKENS)
    parser.add_argument(
        "--request-timeout-seconds",
        type=int,
        default=DEFAULT_REQUEST_TIMEOUT_SECONDS,
    )
    parser.add_argument("--group-concurrency", type=int, default=1)
    parser.add_argument(
        "--service-mode",
        choices=(SHARED_SERVICE_MODE, SERVICE_MODE),
        default=SHARED_SERVICE_MODE,
    )
    parser.add_argument("--service-server-root", type=Path)
    parser.add_argument("--service-cache-root", type=Path)
    parser.add_argument("--service-snapshot-root", type=Path)
    parser.add_argument("--service-start-port", type=int)
    parser.add_argument("--service-ready-timeout", type=float, default=60)
    parser.add_argument("--simulator-model", default="glm52-simulator")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def validate_concurrency(args: argparse.Namespace) -> None:
    if not 1 <= args.threads <= MAX_THREADS_PER_ARM:
        raise RuntimeError(
            f"StableToolBench threads must be within 1..{MAX_THREADS_PER_ARM}"
        )
    if args.max_tokens != REQUIRED_MAX_TOKENS:
        raise RuntimeError(
            f"StableToolBench max tokens must equal {REQUIRED_MAX_TOKENS}"
        )
    if not 1 <= args.request_timeout_seconds <= MAX_REQUEST_TIMEOUT_SECONDS:
        raise RuntimeError(
            "StableToolBench request timeout must be within "
            f"1..{MAX_REQUEST_TIMEOUT_SECONDS} seconds"
        )
    if not 1 <= args.group_concurrency <= MAX_GROUP_CONCURRENCY:
        raise RuntimeError(
            "StableToolBench group concurrency must be within "
            f"1..{MAX_GROUP_CONCURRENCY}"
        )
    request_threads = len(ARMS) * args.group_concurrency * args.threads
    if request_threads > MAX_MODEL_REQUEST_THREADS:
        raise RuntimeError(
            "StableToolBench configured model concurrency exceeds the safe bound: "
            f"{request_threads}>{MAX_MODEL_REQUEST_THREADS}"
        )
    if not 1 <= args.service_ready_timeout <= 300:
        raise RuntimeError("StableToolBench service ready timeout must be within 1..300")
    if args.service_mode == SHARED_SERVICE_MODE:
        if args.group_concurrency != 1:
            raise RuntimeError(
                "parallel StableToolBench groups require managed per-lane service isolation"
            )
        if not args.service_url:
            raise RuntimeError("shared StableToolBench service mode requires --service-url")
        if any(
            value is not None
            for value in (
                args.service_server_root,
                args.service_cache_root,
                args.service_snapshot_root,
                args.service_start_port,
            )
        ):
            raise RuntimeError(
                "managed StableToolBench service flags are invalid in shared mode"
            )
    else:
        if args.service_url:
            raise RuntimeError(
                "managed StableToolBench service mode rejects a shared --service-url"
            )
        if args.service_start_port is None:
            raise RuntimeError(
                "managed StableToolBench service mode requires --service-start-port"
            )


def validate_fresh_inputs(args: argparse.Namespace) -> dict[str, Any]:
    validate_concurrency(args)
    repo_root = args.repo_root.resolve()
    code_root = args.code_root.resolve()
    tool_root = args.tool_root.resolve()
    output_root = args.output_root.resolve()
    python = args.python.absolute()
    if not python.is_file():
        raise RuntimeError(f"StableToolBench Python is unavailable: {python}")
    if not tool_root.is_dir():
        raise RuntimeError(f"StableToolBench tool root is unavailable: {tool_root}")
    runner = repo_root / "benchmarks/glm-5.2-tool-calling/stabletoolbench_official_native.py"
    if not runner.is_file():
        raise RuntimeError(f"StableToolBench runner is unavailable: {runner}")
    official = output_root / "official"
    if official.exists():
        raise RuntimeError(f"refusing existing StableToolBench output: {official}")
    manifest_path = output_root / "task-manifest.json"
    if not manifest_path.is_file():
        raise RuntimeError("fresh StableToolBench task manifest is missing")
    manifest = read_object(manifest_path)
    if (
        manifest.get("commit") != PINNED_COMMIT
        or manifest.get("groupCounts") != GROUP_COUNTS
        or manifest.get("rowCount") != sum(GROUP_COUNTS.values())
    ):
        raise RuntimeError("fresh StableToolBench task manifest is not the pinned population")
    run_meta_path = output_root / "run-meta.json"
    run_meta = read_object(run_meta_path)
    if run_meta.get("status") != "running":
        raise RuntimeError("StableToolBench run metadata is not launchable")
    commit = subprocess.check_output(
        ["git", "-C", str(code_root), "rev-parse", "HEAD"], text=True
    ).strip()
    if commit != PINNED_COMMIT:
        raise RuntimeError(
            f"StableToolBench revision mismatch: expected {PINNED_COMMIT}, found {commit}"
        )
    for group in GROUPS:
        input_path = code_root / "solvable_queries/test_instruction" / f"{group}.json"
        if not input_path.is_file():
            raise RuntimeError(f"StableToolBench group input is unavailable: {input_path}")
    return {
        "codeRoot": code_root,
        "manifest": manifest,
        "official": official,
        "outputRoot": output_root,
        "python": python,
        "repoRoot": repo_root,
        "runMeta": run_meta,
        "runMetaPath": run_meta_path,
        "runner": runner,
        "toolRoot": tool_root,
    }


def implementation_metadata(repo_root: Path) -> dict[str, str]:
    benchmark_root = repo_root / "benchmarks/glm-5.2-tool-calling"
    names = (
        "stabletoolbench_full_native.py",
        "stabletoolbench_official_native.py",
        "stabletoolbench_service_isolation.py",
    )
    return {name: sha256_file(benchmark_root / name) for name in names}


def official_output_path(official: Path, *, arm: str, group: str) -> Path:
    return official / arm / group


def managed_source_plan(
    *, args: argparse.Namespace, context: dict[str, Any]
) -> tuple[list[ServiceLane], dict[str, Any]]:
    output_root: Path = context["outputRoot"]
    code_root: Path = context["codeRoot"]
    service_root = (
        args.service_server_root.resolve()
        if args.service_server_root is not None
        else (code_root / "server").resolve()
    )
    cache_root = (
        args.service_cache_root.resolve()
        if args.service_cache_root is not None
        else (service_root / "tool_response_cache").resolve()
    )
    isolation_root = output_root / "service-isolation"
    if isolation_root.exists():
        raise RuntimeError(
            f"refusing existing StableToolBench service isolation root: {isolation_root}"
        )
    lanes = build_service_lanes(
        groups=GROUPS,
        arms=ARMS,
        start_port=args.service_start_port,
        isolation_root=isolation_root,
    )
    toolbench_stub_port = args.service_start_port + len(lanes)
    if toolbench_stub_port > 65535:
        raise RuntimeError(
            "StableToolBench managed service range leaves no port for the unavailable-tool stub"
        )
    assert_ports_available(lanes)
    metadata = {
        "cacheSource": {**fingerprint_tree(cache_root), "path": str(cache_root)},
        "laneCount": len(lanes),
        "lanes": [lane.metadata() for lane in lanes],
        "mode": SERVICE_MODE,
        "serverSource": inspect_server_source(service_root),
        "toolbenchUnavailableStub": {
            "port": toolbench_stub_port,
            "purpose": "force-pinned-server-simulator-fallback-with-http-response",
            "ready": False,
            "status": 503,
            "url": f"http://127.0.0.1:{toolbench_stub_port}/unavailable",
        },
        "toolSource": {
            **fingerprint_tree(context["toolRoot"]),
            "path": str(context["toolRoot"]),
        },
    }
    return lanes, metadata


def base_execution_metadata(
    *, args: argparse.Namespace, context: dict[str, Any]
) -> dict[str, Any]:
    return {
        "configuredAt": now(),
        "formatVersion": 1,
        "groupConcurrency": args.group_concurrency,
        "groupOrder": list(GROUPS),
        "implementationSha256": implementation_metadata(context["repoRoot"]),
        "maxActiveArmProcesses": len(ARMS) * args.group_concurrency,
        "maxOutputTokens": args.max_tokens,
        "maxModelRequestThreads": len(ARMS)
        * args.group_concurrency
        * args.threads,
        "requestTimeoutSeconds": args.request_timeout_seconds,
        "threadsPerArm": args.threads,
    }


def dry_run_plan(args: argparse.Namespace, context: dict[str, Any]) -> dict[str, Any]:
    execution = base_execution_metadata(args=args, context=context)
    if args.service_mode == SERVICE_MODE:
        _lanes, isolation = managed_source_plan(args=args, context=context)
    else:
        isolation = {
            "laneCount": 1,
            "mode": SHARED_SERVICE_MODE,
            "serviceUrl": args.service_url,
        }
    execution["serviceIsolation"] = isolation
    return {
        "benchmark": "StableToolBench",
        "dryRun": True,
        "execution": execution,
        "populationPerArm": sum(GROUP_COUNTS.values()),
        "status": "valid-read-only",
        "taskSetSha256": context["manifest"].get("taskSetSha256"),
    }


def prepare_managed_services(
    *,
    args: argparse.Namespace,
    context: dict[str, Any],
    lanes: list[ServiceLane],
) -> tuple[ManagedServiceFarm, Path, dict[str, Any]]:
    isolation_root: Path = context["outputRoot"] / "service-isolation"
    isolation_root.mkdir(parents=False, exist_ok=False)
    service_root = (
        args.service_server_root.resolve()
        if args.service_server_root is not None
        else (context["codeRoot"] / "server").resolve()
    )
    cache_source = (
        args.service_cache_root.resolve()
        if args.service_cache_root is not None
        else (service_root / "tool_response_cache").resolve()
    )
    if args.service_snapshot_root is None:
        snapshot_root = isolation_root / "snapshots"
        cache_snapshot = snapshot_root / "tool-response-cache"
        tool_snapshot = snapshot_root / "tools"
        cache_metadata = materialize_read_only_snapshot(cache_source, cache_snapshot)
        tool_metadata = materialize_read_only_snapshot(
            context["toolRoot"], tool_snapshot
        )
        server_code = isolation_root / "server-code"
        server_metadata = materialize_server_code(
            service_root,
            server_code,
            simulator_max_tokens=args.max_tokens,
        )
        snapshot_reuse = None
    else:
        shared_root = args.service_snapshot_root.resolve()
        cache_snapshot = shared_root / "snapshots/tool-response-cache"
        tool_snapshot = shared_root / "snapshots/tools"
        server_code = isolation_root / "server-code"
        cache_metadata = verify_reusable_read_only_snapshot(
            cache_source, cache_snapshot
        )
        tool_metadata = verify_reusable_read_only_snapshot(
            context["toolRoot"], tool_snapshot
        )
        server_metadata = materialize_server_code(
            service_root,
            server_code,
            simulator_max_tokens=args.max_tokens,
        )
        if (
            isolation_root == shared_root
            or isolation_root in shared_root.parents
            or shared_root in isolation_root.parents
        ):
            raise RuntimeError(
                "StableToolBench shared snapshot must be outside fresh isolation root"
            )
        snapshot_reuse = {
            "freshLaneRoot": str((isolation_root / "lanes").resolve()),
            "mode": "external-readonly-content-addressed",
            "sharedSnapshotRoot": str(shared_root),
        }
    farm = ManagedServiceFarm(
        lanes=lanes,
        python=context["python"],
        server_code_root=server_code,
        cache_root=cache_snapshot,
        tool_root=tool_snapshot,
        simulator_base_url=args.base_url,
        simulator_model=args.simulator_model,
        ready_timeout=args.service_ready_timeout,
        toolbench_stub_port=args.service_start_port + len(lanes),
    )
    metadata = {
        "cacheSnapshot": cache_metadata,
        "laneCount": len(lanes),
        "lanes": [lane.metadata() for lane in lanes],
        "mode": SERVICE_MODE,
        "serverCodeSnapshot": server_metadata,
        "toolSnapshot": tool_metadata,
        **({} if snapshot_reuse is None else {"snapshotReuse": snapshot_reuse}),
    }
    return farm, tool_snapshot, metadata


def terminate_processes(processes: list[subprocess.Popen[bytes]]) -> None:
    for process in processes:
        if process.poll() is None:
            process.terminate()
    deadline = time.monotonic() + 15
    for process in processes:
        if process.poll() is not None:
            continue
        try:
            process.wait(timeout=max(0.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    context = validate_fresh_inputs(args)
    if args.dry_run:
        print(json.dumps(dry_run_plan(args, context), ensure_ascii=False, sort_keys=True))
        return

    run_meta: dict[str, Any] = context["runMeta"]
    run_meta_path: Path = context["runMetaPath"]
    official: Path = context["official"]
    output_root: Path = context["outputRoot"]
    code_root: Path = context["codeRoot"]
    runner: Path = context["runner"]
    python: Path = context["python"]
    logs = output_root / "logs"
    execution = base_execution_metadata(args=args, context=context)
    interruption: int | None = None
    abort = threading.Event()
    active_lock = threading.Lock()
    metadata_lock = threading.Lock()
    active: dict[tuple[str, str], subprocess.Popen[bytes]] = {}
    farm: ManagedServiceFarm | None = None

    def stop(signum: int, _frame: object) -> None:
        nonlocal interruption
        interruption = signum
        abort.set()
        raise RuntimeError(f"interrupted by {signal.Signals(signum).name}")

    def terminate_active() -> None:
        abort.set()
        with active_lock:
            processes = list(active.values())
        terminate_processes(processes)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    try:
        if args.service_mode == SERVICE_MODE:
            lanes, _source_plan = managed_source_plan(args=args, context=context)
            farm, runner_tool_root, isolation_metadata = prepare_managed_services(
                args=args, context=context, lanes=lanes
            )
            service_runtime = farm.start()
            isolation_metadata["lanes"] = service_runtime
            isolation_metadata["toolbenchUnavailableStub"] = (
                farm.toolbench_stub.metadata()
            )
            lane_urls = {(lane.group, lane.arm): lane.service_url for lane in lanes}
        else:
            runner_tool_root = context["toolRoot"]
            isolation_metadata = {
                "laneCount": 1,
                "mode": SHARED_SERVICE_MODE,
                "serviceUrl": args.service_url,
            }
            lane_urls = {
                (group, arm): args.service_url for group in GROUPS for arm in ARMS
            }
        execution["serviceIsolation"] = isolation_metadata
        execution["groups"] = {group: {"status": "pending"} for group in GROUPS}
        run_meta.update(
            {
                "groupConcurrency": args.group_concurrency,
                "serviceIsolationMode": args.service_mode,
                "stableToolBenchExecution": execution,
                "threadsPerArm": args.threads,
            }
        )
        atomic_json(run_meta_path, run_meta)
        official.mkdir(parents=True, exist_ok=False)
        logs.mkdir(exist_ok=False)

        def update_group_state(group: str, state: dict[str, Any]) -> None:
            with metadata_lock:
                execution["groups"][group] = state
                atomic_json(run_meta_path, run_meta)

        def run_group(group: str) -> dict[str, Any]:
            if abort.is_set():
                raise RuntimeError(f"{group}: cancelled before launch")
            started_at = now()
            started_monotonic = time.monotonic()
            processes: dict[str, subprocess.Popen[bytes]] = {}
            handles: dict[str, Any] = {}
            update_group_state(
                group,
                {
                    "startedAt": started_at,
                    "status": "launching",
                },
            )
            try:
                input_path = (
                    code_root / "solvable_queries/test_instruction" / f"{group}.json"
                )
                for arm in ARMS:
                    if abort.is_set():
                        raise RuntimeError(f"{group}: cancelled during launch")
                    output = official_output_path(
                        official,
                        arm=arm,
                        group=group,
                    )
                    output.parent.mkdir(parents=True, exist_ok=True)
                    handle = (logs / f"{group}-{arm}.log").open("xb")
                    handles[arm] = handle
                    command = [
                        str(python),
                        str(runner),
                        "--code-root",
                        str(code_root),
                        "--tool-root",
                        str(runner_tool_root),
                        "--input",
                        str(input_path),
                        "--out",
                        str(output),
                        "--base-url",
                        args.base_url,
                        "--model",
                        MODELS[arm],
                        "--max-tokens",
                        str(args.max_tokens),
                        "--threads",
                        str(args.threads),
                        "--request-timeout-seconds",
                        str(args.request_timeout_seconds),
                    ]
                    environment = dict(os.environ)
                    environment.update(
                        {
                            "PYTHONUNBUFFERED": "1",
                            "SERVICE_URL": lane_urls[(group, arm)],
                            "STABLETOOLBENCH_SERVICE_INSTANCE_ID": f"{group}--{arm}",
                        }
                    )
                    process = subprocess.Popen(
                        command,
                        cwd=code_root,
                        env=environment,
                        stdout=handle,
                        stderr=subprocess.STDOUT,
                    )
                    processes[arm] = process
                    with active_lock:
                        active[(group, arm)] = process
                update_group_state(
                    group,
                    {
                        "armPids": {
                            arm: process.pid for arm, process in processes.items()
                        },
                        "models": {arm: MODELS[arm] for arm in ARMS},
                        "serviceUrls": {
                            arm: lane_urls[(group, arm)] for arm in ARMS
                        },
                        "startedAt": started_at,
                        "status": "running",
                    },
                )
                failure: str | None = None
                while True:
                    return_codes = {
                        arm: process.poll() for arm, process in processes.items()
                    }
                    nonzero = {
                        arm: code
                        for arm, code in return_codes.items()
                        if code is not None and code != 0
                    }
                    if nonzero:
                        failure = "; ".join(
                            f"{group}/{arm}: exit {code}"
                            for arm, code in sorted(nonzero.items())
                        )
                        abort.set()
                        terminate_processes(list(processes.values()))
                        break
                    if abort.is_set():
                        terminate_processes(list(processes.values()))
                        failure = f"{group}: cancelled"
                        break
                    if all(code is not None for code in return_codes.values()):
                        break
                    time.sleep(0.2)
                final_codes = {arm: process.wait() for arm, process in processes.items()}
                if failure is not None:
                    raise RuntimeError(failure)
                return {
                    "completedAt": now(),
                    "durationSeconds": round(time.monotonic() - started_monotonic, 3),
                    "returnCodes": final_codes,
                    "serviceUrls": {arm: lane_urls[(group, arm)] for arm in ARMS},
                    "startedAt": started_at,
                    "status": "complete",
                }
            except BaseException as error:
                update_group_state(
                    group,
                    {
                        "failedAt": now(),
                        "failure": f"{type(error).__name__}: {error}",
                        "startedAt": started_at,
                        "status": "failed",
                    },
                )
                raise
            finally:
                with active_lock:
                    for arm in ARMS:
                        active.pop((group, arm), None)
                for handle in handles.values():
                    if not handle.closed:
                        handle.close()

        with ThreadPoolExecutor(max_workers=args.group_concurrency) as executor:
            future_groups = {
                executor.submit(run_group, group): group for group in GROUPS
            }
            for future in as_completed(future_groups):
                group = future_groups[future]
                try:
                    result = future.result()
                except BaseException:
                    terminate_active()
                    for other in future_groups:
                        other.cancel()
                    raise
                update_group_state(group, result)
        if interruption is not None:
            raise RuntimeError(f"interrupted by {signal.Signals(interruption).name}")
        run_meta.update({"completedAt": now(), "status": "inference-complete"})
        atomic_json(run_meta_path, run_meta)
    except BaseException as error:
        terminate_active()
        run_meta.update(
            {
                "completedAt": now(),
                "failure": f"{type(error).__name__}: {error}",
                "interruptionSignal": (
                    signal.Signals(interruption).name
                    if interruption is not None
                    else None
                ),
                "status": "invalid-incomplete",
                "includedInFinalScore": False,
                "populationContribution": 0,
                "reuseForbidden": True,
            }
        )
        atomic_json(run_meta_path, run_meta)
        raise
    finally:
        if farm is not None:
            farm.stop()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"StableToolBench full runner failed: {error}", file=sys.stderr)
        raise
