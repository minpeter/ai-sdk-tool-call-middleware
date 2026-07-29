#!/usr/bin/env python3
"""Run a pinned Terminal-Bench 2.x population with native tool calls.

The runner deliberately has no resume mode.  A failed or interrupted run must
be retained as invalid evidence and restarted in a brand-new output root.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import signal
import subprocess
import time
import tomllib
from collections.abc import Callable, Iterator, Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime
from importlib import import_module
from pathlib import Path
from threading import Event, RLock
from typing import Any, cast
from urllib.request import urlopen

_runtime_fingerprint = import_module("capture_runtime_fingerprint")
build_runtime_fingerprint = cast(
    Callable[..., dict[str, Any]],
    getattr(_runtime_fingerprint, "build_runtime_fingerprint"),
)
write_json_exclusive = cast(
    Callable[[Path, object], None],
    getattr(_runtime_fingerprint, "write_json_exclusive"),
)


ARMS = ("glm52-native", "glm52-prompt-only")
EXPECTED_TASKS = 89
DEFAULT_BRIDGE_SUITE = "terminalbench2-full-89-fresh-v5"
PINNED_AGENT_VERSION = "2.4.5"
MAX_TASK_PAIRS = 2
DEFAULT_MAX_OUTPUT_TOKENS = 4096
MAX_OUTPUT_TOKENS_LIMIT = 131072
PARALLEL_DISK_FLOOR_GIB = 45.0
SCORABLE_AGENT_EXCEPTIONS = {
    "AgentTimeoutError",
    "NonZeroAgentExitCodeError",
}
FINAL_PARSER_PATH = Path("src/core/protocols/glm5-call-parsing.ts")
RUNTIME_BRIDGE_PATHS = (
    Path("benchmarks/glm-5.2-tool-calling/src/benchmark-model-call.ts"),
    Path("benchmarks/glm-5.2-tool-calling/src/openai-compat-bridge.ts"),
    Path("benchmarks/glm-5.2-tool-calling/src/provider-capture.ts"),
)
BRIDGE_AUDIT_FILES = ("requests.jsonl", "provider-raw.jsonl")


def now() -> str:
    return datetime.now().astimezone().isoformat()


def host_boot_id() -> str | None:
    try:
        value = Path("/proc/sys/kernel/random/boot_id").read_text(encoding="utf-8")
    except OSError:
        return None
    return value.strip() or None


def canonical_sha256(value: object) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def runtime_parser_paths(repo_root: Path) -> tuple[Path, ...]:
    source_root = repo_root / "src"
    paths = tuple(
        path.relative_to(repo_root)
        for path in sorted(source_root.rglob("*.ts"))
        if "__tests__" not in path.relative_to(source_root).parts
    )
    if FINAL_PARSER_PATH not in paths:
        raise RuntimeError("final parser is absent from the runtime source closure")
    return paths


def write_json(path: Path, value: object) -> None:
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def append_jsonl(path: Path, value: object, *, lock: Any | None = None) -> None:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n"

    def append() -> None:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(encoded)

    if lock is None:
        append()
    else:
        with lock:
            append()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected a JSON object")
    return value


def require_fresh_output_root(path: Path) -> None:
    if path.exists():
        raise RuntimeError(f"refusing existing output root: {path}")


def task_rows(dataset_root: Path) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for task_dir in sorted(dataset_root.iterdir()):
        task_toml = task_dir / "task.toml"
        if not task_dir.is_dir() or not task_toml.is_file():
            continue
        with task_toml.open("rb") as handle:
            config = tomllib.load(handle)
        environment = config.get("environment")
        if not isinstance(environment, dict):
            environment = {}
        docker_image = environment.get("docker_image")
        rows.append(
            {
                "name": task_dir.name,
                "path": str(task_dir.resolve()),
                "dockerImage": docker_image if isinstance(docker_image, str) else None,
                "taskIdSha256": hashlib.sha256(task_dir.name.encode()).hexdigest(),
            }
        )
    if len(rows) != EXPECTED_TASKS:
        raise RuntimeError(f"expected {EXPECTED_TASKS} tasks, found {len(rows)}")
    return rows


def validate_manifest(
    repo_root: Path,
    dataset_root: Path,
    harbor_root: Path,
    manifest_path: Path,
    benchmark_version: str,
) -> dict[str, Any]:
    builder_name = (
        "build_terminalbench21_full_manifest.py"
        if benchmark_version == "2.1"
        else "build_terminalbench2_full_manifest.py"
    )
    command = [
        "python3",
        str(repo_root / "benchmarks/glm-5.2-tool-calling" / builder_name),
        "--dataset-root",
        str(dataset_root),
        "--harbor-root",
        str(harbor_root),
        "--out",
        str(manifest_path),
        "--validate",
    ]
    subprocess.run(command, check=True, cwd=repo_root)
    manifest = read_json(manifest_path)
    if manifest.get("taskCount") != EXPECTED_TASKS:
        raise RuntimeError("Terminal-Bench manifest task count mismatch")
    return manifest


def bridge_command(repo_root: Path) -> list[str]:
    loader = (
        repo_root / "node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/loader.mjs"
    )
    bridge = repo_root / "benchmarks/glm-5.2-tool-calling/src/openai-compat-bridge.ts"
    if not loader.is_file() or not bridge.is_file():
        raise RuntimeError("local OpenAI compatibility bridge is unavailable")
    return ["node", "--import", str(loader), str(bridge)]


def capture_runtime_identity(repo_root: Path, output_root: Path) -> dict[str, object]:
    loader = (
        repo_root / "node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/loader.mjs"
    )
    fingerprint = build_runtime_fingerprint(
        repo_root=repo_root,
        parser_paths=runtime_parser_paths(repo_root),
        bridge_paths=RUNTIME_BRIDGE_PATHS,
        runner_paths=[Path(__file__).resolve()],
        loader_path=loader,
    )
    fingerprint_path = output_root / "runtime-fingerprint.json"
    write_json_exclusive(fingerprint_path, fingerprint)
    runtime = fingerprint.get("runtimeFingerprint")
    if not isinstance(runtime, dict):
        raise RuntimeError("runtime fingerprint object is missing")
    aggregate = runtime.get("aggregateSha256")
    files = runtime.get("files")
    parser_records = files.get("parser") if isinstance(files, dict) else None
    if not isinstance(aggregate, str) or len(aggregate) != 64:
        raise RuntimeError("runtime fingerprint aggregate is invalid")
    if not isinstance(parser_records, list):
        raise RuntimeError("runtime parser fingerprint records are missing")
    parser_source = repo_root / FINAL_PARSER_PATH
    parser_sha256 = hashlib.sha256(parser_source.read_bytes()).hexdigest()
    matching = [
        record
        for record in parser_records
        if isinstance(record, dict)
        and record.get("path") == FINAL_PARSER_PATH.as_posix()
    ]
    if len(matching) != 1 or matching[0].get("sha256") != parser_sha256:
        raise RuntimeError("runtime fingerprint does not contain the final parser")
    parser_mtime = datetime.fromtimestamp(parser_source.stat().st_mtime).astimezone()
    return {
        "runtimeFingerprintAggregateSha256": aggregate,
        "runtimeFingerprintFile": fingerprint_path.name,
        "runtimeStartAttestation": {
            "finalParserSourceMtime": parser_mtime.isoformat(),
            "metadataPreparedAfterFinalParserPatch": True,
            "parserSha256": parser_sha256,
        },
    }


def require_attested_parser(repo_root: Path, run_meta: dict[str, object]) -> str:
    attestation = run_meta.get("runtimeStartAttestation")
    expected = (
        attestation.get("parserSha256") if isinstance(attestation, dict) else None
    )
    actual = hashlib.sha256((repo_root / FINAL_PARSER_PATH).read_bytes()).hexdigest()
    if expected != actual:
        raise RuntimeError("final parser changed after runtime attestation")
    return actual


def require_zero_bridge_audit_rows(bridge_root: Path) -> dict[str, int]:
    rows: dict[str, int] = {}
    for filename in BRIDGE_AUDIT_FILES:
        path = bridge_root / filename
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"bridge audit file is missing or unsafe: {filename}")
        if path.stat().st_size != 0:
            raise RuntimeError(f"bridge audit file is not fresh 0-row: {filename}")
        rows[filename] = 0
    return rows


def wait_for_bridge(port: int, process: subprocess.Popen[str]) -> None:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"bridge exited before readiness: {process.returncode}")
        try:
            with urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(0.5)
    raise RuntimeError("bridge did not become ready")


def disk_free_gb(path: Path) -> float:
    return shutil.disk_usage(path).free / (1024**3)


def wait_for_disk(path: Path, minimum_gb: float) -> None:
    announced = False
    while disk_free_gb(path) < minimum_gb:
        if not announced:
            print(
                json.dumps(
                    {
                        "availableGiB": round(disk_free_gb(path), 2),
                        "minimumGiB": minimum_gb,
                        "status": "waiting-for-disk",
                    },
                    sort_keys=True,
                ),
                flush=True,
            )
            announced = True
        time.sleep(30)


def bounded_task_pairs(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError as error:
        raise argparse.ArgumentTypeError("task pairs must be an integer") from error
    if not 1 <= value <= MAX_TASK_PAIRS:
        raise argparse.ArgumentTypeError(
            f"task pairs must be between 1 and {MAX_TASK_PAIRS}"
        )
    return value


def bounded_max_output_tokens(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError as error:
        raise argparse.ArgumentTypeError("max output tokens must be an integer") from error
    if not 1 <= value <= MAX_OUTPUT_TOKENS_LIMIT:
        raise argparse.ArgumentTypeError(
            f"max output tokens must be between 1 and {MAX_OUTPUT_TOKENS_LIMIT}"
        )
    return value


def effective_minimum_free_gb(requested_gb: float, task_pairs: int) -> float:
    if not 1 <= task_pairs <= MAX_TASK_PAIRS:
        raise ValueError(f"task_pairs must be between 1 and {MAX_TASK_PAIRS}")
    if not math.isfinite(requested_gb) or requested_gb < 0:
        raise ValueError("minimum free disk must be finite and non-negative")
    if task_pairs > 1:
        return max(requested_gb, PARALLEL_DISK_FLOOR_GIB)
    return requested_gb


def task_batches(
    tasks: Sequence[dict[str, object]], task_pairs: int
) -> Iterator[list[tuple[int, dict[str, object]]]]:
    if not 1 <= task_pairs <= MAX_TASK_PAIRS:
        raise ValueError(f"task_pairs must be between 1 and {MAX_TASK_PAIRS}")
    for start in range(0, len(tasks), task_pairs):
        yield [
            (index + 1, tasks[index])
            for index in range(start, min(start + task_pairs, len(tasks)))
        ]


def docker_refs() -> set[str]:
    result = subprocess.run(
        ["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"],
        check=True,
        capture_output=True,
        text=True,
    )
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def terminal_task_containers(dataset_root: Path) -> list[str]:
    result = subprocess.run(
        ["docker", "ps", "-aq"],
        check=True,
        capture_output=True,
        text=True,
    )
    container_ids = [
        line.strip() for line in result.stdout.splitlines() if line.strip()
    ]
    if not container_ids:
        return []
    inspected = subprocess.run(
        ["docker", "inspect", *container_ids],
        check=True,
        capture_output=True,
        text=True,
    )
    records = json.loads(inspected.stdout)
    matches: list[str] = []
    for record in records:
        config = record.get("Config") if isinstance(record, dict) else None
        labels = config.get("Labels") if isinstance(config, dict) else None
        working_dir = (
            labels.get("com.docker.compose.project.working_dir")
            if isinstance(labels, dict)
            else None
        )
        if isinstance(working_dir, str) and Path(working_dir).is_relative_to(
            dataset_root
        ):
            matches.append(str(record.get("Name", "unknown")).removeprefix("/"))
    return sorted(matches)


def docker_image_container_references(ref: str) -> list[str]:
    result = subprocess.run(
        ["docker", "ps", "-aq", "--filter", f"ancestor={ref}"],
        check=True,
        capture_output=True,
        text=True,
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def remove_new_batch_images(
    before: set[str], task_images: Sequence[object], *, enabled: bool
) -> dict[str, list[str]]:
    if not enabled:
        return {"referenced": [], "removed": []}
    after = docker_refs()
    declared_images = {image for image in task_images if isinstance(image, str)}
    candidates = {
        ref
        for ref in after - before
        if ref.startswith("hb__") or ref in declared_images
    }
    referenced: list[str] = []
    removed: list[str] = []
    for ref in sorted(candidates):
        if docker_image_container_references(ref):
            referenced.append(ref)
            continue
        result = subprocess.run(
            ["docker", "image", "rm", ref],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            removed.append(ref)
    return {"referenced": referenced, "removed": removed}


def remove_new_task_images(
    before: set[str], task_image: object, *, enabled: bool
) -> list[str]:
    """Backward-compatible single-task wrapper around batch-safe cleanup."""

    return remove_new_batch_images(before, [task_image], enabled=enabled)["removed"]


@dataclass(frozen=True)
class JobSpec:
    arm: str
    console_path: Path
    job_name: str
    job_root: Path
    task: dict[str, object]
    task_index: int


def job_specs_for_batch(
    batch: Sequence[tuple[int, dict[str, object]]],
    jobs_root: Path,
    logs_root: Path,
) -> list[JobSpec]:
    specs: list[JobSpec] = []
    for task_index, task in batch:
        for arm in ARMS:
            job_name = f"tb2-{task_index:03d}-{arm}"
            specs.append(
                JobSpec(
                    arm=arm,
                    console_path=logs_root / f"{job_name}.log",
                    job_name=job_name,
                    job_root=jobs_root / job_name,
                    task=task,
                    task_index=task_index,
                )
            )
    return specs


def run_job_specs(
    specs: Sequence[JobSpec],
    task_pairs: int,
    runner: Callable[[JobSpec], dict[str, object]],
    *,
    on_error: Callable[[], None] | None = None,
) -> list[dict[str, object]]:
    """Run one task batch, preserving the historical serial default."""

    if not 1 <= task_pairs <= MAX_TASK_PAIRS:
        raise ValueError(f"task_pairs must be between 1 and {MAX_TASK_PAIRS}")
    if not specs:
        return []
    if task_pairs == 1:
        return [runner(spec) for spec in specs]

    results: list[dict[str, object]] = []
    with ThreadPoolExecutor(
        max_workers=min(len(specs), task_pairs * len(ARMS)),
        thread_name_prefix="terminalbench-job",
    ) as executor:
        futures = [executor.submit(runner, spec) for spec in specs]
        try:
            for future in as_completed(futures):
                results.append(future.result())
        except BaseException:
            if on_error is not None:
                on_error()
            for future in futures:
                future.cancel()
            raise
    return results


def validate_completed_task_pairs(
    batch: Sequence[tuple[int, dict[str, object]]],
    completed: Sequence[dict[str, object]],
) -> None:
    expected = {(task_index, arm) for task_index, _task in batch for arm in ARMS}
    observed: set[tuple[int, str]] = set()
    for row in completed:
        task_index = row.get("taskIndex")
        arm = row.get("arm")
        if not isinstance(task_index, int) or not isinstance(arm, str):
            raise RuntimeError("task-pair batch returned invalid job identity")
        observed.add((task_index, arm))
    if observed != expected or len(completed) != len(expected):
        raise RuntimeError("task-pair batch did not complete both arms exactly once")


def harbor_command(
    harbor_cli: Path,
    jobs_dir: Path,
    overlay: Path,
    task: dict[str, object],
    arm: str,
    job_name: str,
    port: int,
    max_output_tokens: int,
    agent_setup_timeout_multiplier: float = 1.0,
) -> list[str]:
    return [
        str(harbor_cli),
        "run",
        "--job-name",
        job_name,
        "--jobs-dir",
        str(jobs_dir),
        "--path",
        str(task["path"]),
        "--agent",
        "mini-swe-agent",
        "--model",
        f"openai/{arm}",
        "--ak",
        f"version={PINNED_AGENT_VERSION}",
        "--ak",
        f"max_tokens={max_output_tokens}",
        "--ae",
        "OPENAI_API_KEY=bridge-local",
        "--ae",
        f"OPENAI_BASE_URL=http://127.0.0.1:{port}/v1",
        "--n-attempts",
        "1",
        "--n-concurrent",
        "1",
        "--max-retries",
        "0",
        "--agent-setup-timeout-multiplier",
        str(agent_setup_timeout_multiplier),
        "--no-force-build",
        "--delete",
        "--extra-docker-compose",
        str(overlay),
        "--yes",
    ]


def inspect_trial(jobs_dir: Path, job_name: str, task_name: str) -> dict[str, object]:
    job_dir = jobs_dir / job_name
    job_result = read_json(job_dir / "result.json")
    stats = job_result.get("stats")
    if not isinstance(stats, dict) or stats.get("n_completed_trials") != 1:
        raise RuntimeError(f"{job_name}: Harbor did not complete exactly one trial")
    trial_dirs = [
        path
        for path in job_dir.iterdir()
        if path.is_dir() and path.name.startswith(f"{task_name}__")
    ]
    if len(trial_dirs) != 1:
        raise RuntimeError(f"{job_name}: expected one trial directory")
    trial_dir = trial_dirs[0]
    result = read_json(trial_dir / "result.json")
    # Harbor 0.1.52 records path-backed Terminal-Bench 2.1 tasks with the
    # canonical namespace prefix, while older path-backed jobs used the bare
    # directory name. The trial directory and manifest already pin the bare
    # task ID; accept only these two byte-exact representations.
    if result.get("task_name") not in {task_name, f"terminal-bench/{task_name}"}:
        raise RuntimeError(f"{job_name}: task identity mismatch")
    agent_info = result.get("agent_info")
    if (
        not isinstance(agent_info, dict)
        or agent_info.get("version") != PINNED_AGENT_VERSION
    ):
        raise RuntimeError(f"{job_name}: MiniSweAgent version drift")
    verifier = result.get("verifier_result")
    rewards = verifier.get("rewards") if isinstance(verifier, dict) else None
    reward = rewards.get("reward") if isinstance(rewards, dict) else None
    exception = result.get("exception_info")
    exception_type = (
        exception.get("exception_type") if isinstance(exception, dict) else None
    )
    if isinstance(reward, (int, float)) and 0 <= reward <= 1:
        official_reward: float | None = float(reward)
        score_contribution = float(reward)
        trial_status = "verified"
    elif exception_type in SCORABLE_AGENT_EXCEPTIONS:
        # Harbor records task-constrained agent exits/timeouts as completed errored
        # trials and returns a non-zero CLI status. They remain in the official
        # denominator as zero; provider/auth/environment exceptions are rejected.
        official_reward = None
        score_contribution = 0.0
        trial_status = "errored-zero"
    else:
        raise RuntimeError(
            f"{job_name}: official verifier reward is missing without a "
            "scorable agent exception"
        )
    trajectory_path = trial_dir / "agent/trajectory.json"
    trajectory = read_json(trajectory_path)
    steps = trajectory.get("steps")
    if not isinstance(steps, list):
        raise RuntimeError(f"{job_name}: ATIF trajectory steps are missing")
    tool_calls = sum(
        len(step.get("tool_calls") or []) for step in steps if isinstance(step, dict)
    )
    return {
        "exceptionType": exception_type,
        "finishedAt": result.get("finished_at"),
        "jobName": job_name,
        "officialReward": official_reward,
        "scoreContribution": score_contribution,
        "startedAt": result.get("started_at"),
        "steps": len(steps),
        "toolCalls": tool_calls,
        "trajectory": str(trajectory_path.resolve()),
        "trialStatus": trial_status,
        "trial": trial_dir.name,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--dataset-root", type=Path, required=True)
    parser.add_argument("--harbor-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--overlay", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8814)
    parser.add_argument("--minimum-free-gb", type=float, default=8.0)
    parser.add_argument(
        "--max-output-tokens",
        type=bounded_max_output_tokens,
        default=DEFAULT_MAX_OUTPUT_TOKENS,
    )
    parser.add_argument(
        "--task-pairs",
        type=bounded_task_pairs,
        default=1,
        help=(
            "task pairs to execute per batch; 1 preserves serial arm execution, "
            "2 runs two paired tasks with four isolated jobs"
        ),
    )
    parser.add_argument(
        "--agent-setup-timeout-multiplier",
        type=float,
        default=1.0,
        help="Harbor agent install/setup timeout multiplier (1.0-10.0)",
    )
    parser.add_argument("--cleanup-task-images", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--benchmark-version", choices=("2.0", "2.1"), default="2.0")
    parser.add_argument("--bridge-suite", default=DEFAULT_BRIDGE_SUITE)
    args = parser.parse_args()

    if not 1.0 <= args.agent_setup_timeout_multiplier <= 10.0:
        parser.error("--agent-setup-timeout-multiplier must be within 1.0..10.0")

    repo_root = args.repo_root.resolve()
    dataset_root = args.dataset_root.resolve()
    harbor_root = args.harbor_root.resolve()
    manifest_path = args.manifest.resolve()
    output_root = args.output_root.resolve()
    overlay = args.overlay.resolve()
    minimum_free_gb = effective_minimum_free_gb(args.minimum_free_gb, args.task_pairs)
    harbor_cli = harbor_root / ".venv/bin/harbor"
    if not harbor_cli.is_file() or not overlay.is_file():
        raise RuntimeError("Harbor CLI or host-network overlay is missing")

    manifest = validate_manifest(
        repo_root,
        dataset_root,
        harbor_root,
        manifest_path,
        args.benchmark_version,
    )
    tasks = task_rows(dataset_root)
    if canonical_sha256([row["name"] for row in tasks]) != manifest.get(
        "taskIdSetSha256"
    ):
        raise RuntimeError("task order does not match the pinned manifest")
    if args.dry_run:
        print(
            json.dumps(
                {
                    "arms": list(ARMS),
                    "benchmarkVersion": args.benchmark_version,
                    "bridgeSuite": args.bridge_suite,
                    "expectedFreshTrajectories": len(tasks) * len(ARMS),
                    "firstTask": tasks[0]["name"],
                    "lastTask": tasks[-1]["name"],
                    "maximumConcurrentJobs": (
                        1 if args.task_pairs == 1 else args.task_pairs * len(ARMS)
                    ),
                    "maxOutputTokens": args.max_output_tokens,
                    "agentSetupTimeoutMultiplier": args.agent_setup_timeout_multiplier,
                    "minimumFreeGiB": minimum_free_gb,
                    "status": "valid-dry-run",
                    "taskPairs": args.task_pairs,
                    "taskCountPerArm": len(tasks),
                    "taskSetSha256": manifest["taskSetSha256"],
                },
                sort_keys=True,
            )
        )
        return
    require_fresh_output_root(output_root)
    if not os.getenv("FREEROUTER_API_KEY"):
        raise RuntimeError("FREEROUTER_API_KEY is required in the process environment")
    preexisting_task_containers = terminal_task_containers(dataset_root)
    if preexisting_task_containers:
        raise RuntimeError(
            "refusing pre-existing Terminal-Bench task containers: "
            + ", ".join(preexisting_task_containers)
        )

    output_root.mkdir(parents=True)
    jobs_root = output_root / "jobs"
    logs_dir = output_root / "logs"
    bridge_dir = output_root / "bridge"
    jobs_root.mkdir()
    logs_dir.mkdir()
    write_json(output_root / "task-order.json", {"tasks": tasks})
    runtime_identity = capture_runtime_identity(repo_root, output_root)
    run_meta: dict[str, object] = {
        "agent": {"name": "mini-swe-agent", "version": PINNED_AGENT_VERSION},
        "agentSetupTimeoutMultiplier": args.agent_setup_timeout_multiplier,
        "arms": list(ARMS),
        "benchmark": f"Terminal-Bench {args.benchmark_version}",
        "benchmarkVersion": args.benchmark_version,
        "bridgePort": args.port,
        "bridgeIsolation": {
            "neverReusePredecessorPort": True,
            "preexistingTerminalTaskContainersAtStart": 0,
        },
        "bridgeSuite": args.bridge_suite,
        "bridgeTransientRetryPolicy": {
            "additionalAttempts": 4,
            "delayMs": 5000,
            "retryable": "HTTP 408/425/429/5xx and transport errors only",
        },
        "cleanupTaskImages": args.cleanup_task_images,
        "campaignAdmissionContract": {
            "appWorld": 8,
            "bfcl": 24,
            "globalCeiling": 128,
            "hammer": 64,
            "stableToolBench": 4,
            "tau3": 8,
            "terminalBench21": 4,
            "total": 128,
            "vakra": 16,
        },
        "completedAt": None,
        "expectedFreshTrajectories": EXPECTED_TASKS * len(ARMS),
        "freshness": {
            "emptyOutputRootAtStart": True,
            "historicalRawInput": False,
            "historicalResultInput": False,
            "historicalRowReuseForbidden": True,
            "historicalScoreInput": False,
            "importedRows": 0,
            "resumeFromPriorRun": False,
            "sourceRunRoots": [],
        },
        "hostBootId": host_boot_id(),
        "includedInFinalScore": False,
        "launchSecurity": {
            "credentialInArtifact": False,
            "credentialInCommandLine": False,
            "providerCommandWrapper": (
                "python3 benchmarks/glm-5.2-tool-calling/"
                "with_secure_key_source.py --"
            ),
            "secureWrapperRequired": True,
        },
        "manifestTaskSetSha256": manifest["taskSetSha256"],
        "maxOutputTokens": args.max_output_tokens,
        "pairScheduling": {
            "batchBarrierBeforeImageCleanup": True,
            "maximumConcurrentJobs": (
                1 if args.task_pairs == 1 else args.task_pairs * len(ARMS)
            ),
            "serialCompatibilityDefault": args.task_pairs == 1,
            "taskPairs": args.task_pairs,
        },
        "populationContribution": 0,
        "populationPerArm": EXPECTED_TASKS,
        "reuseForbidden": False,
        "minimumFreeGiB": {
            "effective": minimum_free_gb,
            "parallelFloor": (PARALLEL_DISK_FLOOR_GIB if args.task_pairs > 1 else None),
            "requested": args.minimum_free_gb,
        },
        "launchGate": {"status": "pending-bridge-health"},
        **runtime_identity,
        "startedAt": now(),
        "status": "running",
        "scoreDisclosure": "forbidden-until-exact-denominator-and-official-validator",
        "taskCountPerArm": EXPECTED_TASKS,
        "totalAdmission": 4,
    }
    write_json(output_root / "run-meta.json", run_meta)

    bridge_log = (output_root / "bridge-console.log").open("w", encoding="utf-8")
    bridge_env = {
        **os.environ,
        "OPENAI_BRIDGE_MAX_OUTPUT_TOKENS": str(args.max_output_tokens),
        "OPENAI_BRIDGE_OUTPUT": str(bridge_dir),
        "OPENAI_BRIDGE_PORT": str(args.port),
        "OPENAI_BRIDGE_SUITE": args.bridge_suite,
        "OPENAI_BRIDGE_TIMEOUT_MS": "180000",
        "OPENAI_BRIDGE_TRANSIENT_RETRIES": "4",
        "OPENAI_BRIDGE_TRANSIENT_RETRY_DELAY_MS": "5000",
        "OPENAI_BRIDGE_TRANSPORT": "generate",
    }
    bridge = subprocess.Popen(
        bridge_command(repo_root),
        cwd=repo_root,
        env=bridge_env,
        stdout=bridge_log,
        stderr=subprocess.STDOUT,
        text=True,
    )
    active_harbors: dict[str, subprocess.Popen[str]] = {}
    active_lock = RLock()
    progress_lock = RLock()
    shutdown_event = Event()
    shutdown_signal: int | None = None

    def stop_processes(signum: int | None = None, *_: object) -> None:
        nonlocal shutdown_signal
        if signum is not None:
            shutdown_signal = signum
        shutdown_event.set()
        with active_lock:
            harbor_processes = list(active_harbors.values())
        for harbor_process in harbor_processes:
            if harbor_process.poll() is None:
                harbor_process.terminate()
        if bridge.poll() is None:
            bridge.terminate()

    def run_job(spec: JobSpec) -> dict[str, object]:
        if shutdown_event.is_set():
            raise RuntimeError(f"{spec.job_name}: runner is stopping")
        if bridge.poll() is not None:
            raise RuntimeError(
                f"{spec.job_name}: local bridge exited {bridge.returncode}"
            )
        spec.job_root.mkdir()
        started_at = now()
        harbor_process: subprocess.Popen[str] | None = None
        try:
            with spec.console_path.open("w", encoding="utf-8") as console:
                harbor_process = subprocess.Popen(
                    harbor_command(
                        harbor_cli,
                        spec.job_root,
                        overlay,
                        spec.task,
                        spec.arm,
                        spec.job_name,
                        args.port,
                        args.max_output_tokens,
                        args.agent_setup_timeout_multiplier,
                    ),
                    cwd=harbor_root,
                    stdout=console,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
                with active_lock:
                    if spec.job_name in active_harbors:
                        raise RuntimeError(f"duplicate active job: {spec.job_name}")
                    active_harbors[spec.job_name] = harbor_process
                if shutdown_event.is_set() and harbor_process.poll() is None:
                    harbor_process.terminate()
                completed_returncode = harbor_process.wait()
        finally:
            with active_lock:
                active_harbors.pop(spec.job_name, None)

        if shutdown_signal is not None:
            signal_name = signal.Signals(shutdown_signal).name
            raise RuntimeError(f"runner interrupted by {signal_name}")
        if shutdown_event.is_set():
            raise RuntimeError(f"{spec.job_name}: runner stopped before inspection")
        if bridge.poll() is not None:
            raise RuntimeError(
                f"{spec.job_name}: local bridge exited {bridge.returncode}"
            )
        result = inspect_trial(spec.job_root, spec.job_name, str(spec.task["name"]))
        if completed_returncode != 0 and result["trialStatus"] != "errored-zero":
            raise RuntimeError(f"{spec.job_name}: Harbor exited {completed_returncode}")
        progress = {
            "arm": spec.arm,
            "completedAt": now(),
            "console": str(spec.console_path.resolve()),
            "jobRoot": str(spec.job_root.resolve()),
            "startedAt": started_at,
            "taskIndex": spec.task_index,
            "taskName": spec.task["name"],
            **result,
        }
        append_jsonl(output_root / "progress.jsonl", progress, lock=progress_lock)
        with progress_lock:
            print(
                json.dumps(
                    {
                        "arm": spec.arm,
                        "status": result["trialStatus"],
                        "task": spec.task["name"],
                        "taskIndex": spec.task_index,
                        "totalTasks": EXPECTED_TASKS,
                    },
                    sort_keys=True,
                ),
                flush=True,
            )
        return progress

    signal.signal(signal.SIGINT, stop_processes)
    signal.signal(signal.SIGTERM, stop_processes)
    try:
        wait_for_bridge(args.port, bridge)
        audit_rows = require_zero_bridge_audit_rows(bridge_dir)
        parser_sha256 = require_attested_parser(repo_root, run_meta)
        run_meta["launchGate"] = {
            "bridgeHealth": "ready",
            "checkedAt": now(),
            "parserSha256": parser_sha256,
            "providerRawRowsAtStart": audit_rows["provider-raw.jsonl"],
            "requestsRowsAtStart": audit_rows["requests.jsonl"],
            "status": "passed",
        }
        write_json(output_root / "run-meta.json", run_meta)
        for batch in task_batches(tasks, args.task_pairs):
            wait_for_disk(output_root, minimum_free_gb)
            images_before = docker_refs()
            specs = job_specs_for_batch(batch, jobs_root, logs_dir)
            completed = run_job_specs(
                specs,
                args.task_pairs,
                run_job,
                on_error=stop_processes,
            )
            validate_completed_task_pairs(batch, completed)
            cleanup = remove_new_batch_images(
                images_before,
                [task.get("dockerImage") for _task_index, task in batch],
                enabled=args.cleanup_task_images,
            )
            if cleanup["removed"] or cleanup["referenced"]:
                task_indexes = [task_index for task_index, _task in batch]
                task_names = [str(task["name"]) for _task_index, task in batch]
                cleanup_row: dict[str, object] = {
                    **cleanup,
                    "taskIndexes": task_indexes,
                    "taskNames": task_names,
                }
                if len(batch) == 1:
                    cleanup_row["taskIndex"] = task_indexes[0]
                    cleanup_row["taskName"] = task_names[0]
                append_jsonl(
                    output_root / "image-cleanup.jsonl",
                    cleanup_row,
                    lock=progress_lock,
                )
        run_meta["completedAt"] = now()
        run_meta["status"] = "inference-complete"
        write_json(output_root / "run-meta.json", run_meta)
    except BaseException as error:
        run_meta["completedAt"] = now()
        run_meta["errorType"] = error.__class__.__name__
        if shutdown_signal is not None:
            run_meta["interruptionSignal"] = signal.Signals(shutdown_signal).name
        run_meta["status"] = "invalid-incomplete"
        write_json(output_root / "run-meta.json", run_meta)
        raise
    finally:
        stop_processes()
        try:
            bridge.wait(timeout=15)
        except subprocess.TimeoutExpired:
            bridge.kill()
            bridge.wait()
        bridge_log.close()


if __name__ == "__main__":
    main()
