#!/usr/bin/env python3
"""Run the pinned tau3 base split as fresh paired native/parser arms."""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from time import monotonic, sleep
from typing import Any, BinaryIO


DOMAINS = ("airline", "retail", "telecom", "banking_knowledge")
ARMS = ("native", "glm5")
AGENTS = {
    "native": "openai_bridge_native",
    "glm5": "openai_bridge_glm5",
}
EXPECTED_DOMAIN_COUNTS = {
    "airline": 50,
    "retail": 114,
    "telecom": 114,
    "banking_knowledge": 97,
}
EXPECTED_TASKS = sum(EXPECTED_DOMAIN_COUNTS.values())
PINNED_COMMIT = "a1e85084a3960281cb06997594133e8f39ea42a7"
GLOBAL_ADMISSION_CEILING = 4
DEFAULT_REQUEST_TIMEOUT_SECONDS = 960
REQUIRED_MAX_TOKENS = 16_384
REQUIRED_BRIDGE_TRANSIENT_RETRIES = 2
MAX_REQUEST_TIMEOUT_SECONDS = 3600
SAVE_COMPONENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")


@dataclass(frozen=True)
class ConcurrencyPlan:
    domain_workers: int
    task_concurrency_per_run: int

    @property
    def max_concurrent_child_runs(self) -> int:
        return self.domain_workers * len(ARMS)

    @property
    def max_concurrent_simulation_tasks(self) -> int:
        return self.max_concurrent_child_runs * self.task_concurrency_per_run

    def as_json(self) -> dict[str, Any]:
        return {
            "armsPerDomain": len(ARMS),
            "domainScheduling": "bounded-dynamic-slots",
            "domainWorkers": self.domain_workers,
            "globalAdmissionCeiling": GLOBAL_ADMISSION_CEILING,
            "maxConcurrentChildRuns": self.max_concurrent_child_runs,
            "maxConcurrentSimulationTasks": self.max_concurrent_simulation_tasks,
            "taskConcurrencyPerRun": self.task_concurrency_per_run,
        }


@dataclass
class ChildRun:
    arm: str
    domain: str
    handle: BinaryIO
    process: subprocess.Popen[bytes]

    @property
    def label(self) -> str:
        return f"{self.domain}/{self.arm}"


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


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive integer") from error
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def save_component(value: str) -> str:
    if SAVE_COMPONENT.fullmatch(value) is None:
        raise argparse.ArgumentTypeError(
            "must be one path-safe component containing letters, digits, '.', '_', or '-'"
        )
    return value


def concurrency_plan(
    domain_workers: int, task_concurrency_per_run: int
) -> ConcurrencyPlan:
    if not 1 <= domain_workers <= len(DOMAINS):
        raise ValueError(f"domain workers must be between 1 and {len(DOMAINS)}")
    if task_concurrency_per_run < 1:
        raise ValueError("task concurrency per run must be positive")
    plan = ConcurrencyPlan(domain_workers, task_concurrency_per_run)
    if plan.max_concurrent_simulation_tasks > GLOBAL_ADMISSION_CEILING:
        raise ValueError(
            "tau3 concurrency exceeds the global admission ceiling: "
            f"{len(ARMS)} arms x {domain_workers} domain workers x "
            f"{task_concurrency_per_run} tasks = "
            f"{plan.max_concurrent_simulation_tasks} > {GLOBAL_ADMISSION_CEILING}"
        )
    return plan


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--tau-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--save-prefix", type=save_component, required=True)
    parser.add_argument(
        "--request-timeout-seconds",
        type=positive_int,
        default=DEFAULT_REQUEST_TIMEOUT_SECONDS,
        help=(
            "OpenAI bridge client timeout; must cover the bridge's bounded "
            "provider retry window (default: 960)"
        ),
    )
    parser.add_argument("--max-tokens", type=positive_int, default=REQUIRED_MAX_TOKENS)
    parser.add_argument(
        "--domain-workers",
        type=positive_int,
        default=1,
        help="number of domain pairs to execute concurrently (default: 1)",
    )
    parser.add_argument(
        "--task-concurrency-per-run",
        "--max-concurrency-per-run",
        dest="task_concurrency_per_run",
        type=positive_int,
        default=1,
        help="tau3 concurrent simulations inside each domain/arm run (default: 1)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="validate the pinned fresh-run plan without writing or launching",
    )
    args = parser.parse_args(argv)
    if args.max_tokens != REQUIRED_MAX_TOKENS:
        parser.error(f"--max-tokens must equal {REQUIRED_MAX_TOKENS}")
    if args.request_timeout_seconds > MAX_REQUEST_TIMEOUT_SECONDS:
        parser.error(
            "request timeout seconds must not exceed "
            f"{MAX_REQUEST_TIMEOUT_SECONDS}"
        )
    try:
        args.concurrency = concurrency_plan(
            args.domain_workers, args.task_concurrency_per_run
        )
    except ValueError as error:
        parser.error(str(error))
    return args


def git_revision(root: Path) -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            text=True,
        ).strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise RuntimeError(f"cannot read tau3 revision from {root}") from error


def validate_manifest(manifest: dict[str, Any], tau_root: Path) -> None:
    if (
        manifest.get("benchmark") != "tau3-bench"
        or manifest.get("commit") != PINNED_COMMIT
        or manifest.get("taskCount") != EXPECTED_TASKS
        or manifest.get("domainCounts") != EXPECTED_DOMAIN_COUNTS
    ):
        raise RuntimeError("tau3 manifest is not the pinned 375-task base population")
    tasks = manifest.get("tasks")
    if not isinstance(tasks, list) or len(tasks) != EXPECTED_TASKS:
        raise RuntimeError("tau3 manifest task inventory is missing")
    identities: list[tuple[str, str]] = []
    for task in tasks:
        if not isinstance(task, dict):
            raise RuntimeError("tau3 manifest task row is invalid")
        domain = task.get("domain")
        task_id = task.get("id")
        if domain not in EXPECTED_DOMAIN_COUNTS or not isinstance(task_id, str):
            raise RuntimeError("tau3 manifest task identity is invalid")
        identities.append((domain, task_id))
    if len(set(identities)) != EXPECTED_TASKS:
        raise RuntimeError("tau3 manifest contains duplicate task identities")
    if Counter(domain for domain, _task_id in identities) != Counter(
        EXPECTED_DOMAIN_COUNTS
    ):
        raise RuntimeError("tau3 manifest domain membership drift")
    if git_revision(tau_root) != PINNED_COMMIT:
        raise RuntimeError("tau3 source revision does not match the pinned manifest")


def validate_fresh_run_meta(
    run_meta: dict[str, Any], manifest: dict[str, Any], save_prefix: str
) -> None:
    if run_meta.get("status") != "running":
        raise RuntimeError("tau3 run metadata is not launchable")
    if (
        run_meta.get("benchmarkCommit") != PINNED_COMMIT
        or run_meta.get("taskCountPerArm") != EXPECTED_TASKS
        or run_meta.get("taskSetSha256") != manifest.get("taskSetSha256")
        or run_meta.get("savePrefix") != save_prefix
    ):
        raise RuntimeError("tau3 run metadata does not match the fresh manifest")
    freshness = run_meta.get("freshness")
    if not isinstance(freshness, dict):
        raise RuntimeError("tau3 freshness metadata is missing")
    if freshness.get("outputRootAbsentBeforeCreation") is not True:
        raise RuntimeError("tau3 empty-output freshness proof is missing")
    for key in ("preseed", "historicalRawInput", "historicalScoreInput"):
        if freshness.get(key) is not False:
            raise RuntimeError(f"tau3 freshness flag is invalid: {key}")
    if freshness.get("resumeFromPriorRun") is not False:
        raise RuntimeError("tau3 resume must be disabled")
    expected_retry_policy = {
        "additionalAttempts": REQUIRED_BRIDGE_TRANSIENT_RETRIES,
        "delayMs": 5_000,
        "timeoutMsPerAttempt": 180_000,
        "validatorRequiresRecoveredByteIdenticalRequest": True,
    }
    if run_meta.get("bridgeTransientRetryPolicy") != expected_retry_policy:
        raise RuntimeError("tau3 bridge retry policy is not the active campaign policy")
    if (
        run_meta.get("providerTransientRetries")
        != REQUIRED_BRIDGE_TRANSIENT_RETRIES
    ):
        raise RuntimeError("tau3 bridge retry policy count is inconsistent")
    expected_admission = {"globalCeiling": 4, "tau3": 4, "total": 4}
    if run_meta.get("campaignAdmissionContract") != expected_admission:
        raise RuntimeError("tau3 campaign admission contract is not exactly four")


def run_command(
    python: Path,
    cli: Path,
    domain: str,
    arm: str,
    *,
    save_prefix: str,
    agent_args: str,
    user_args: str,
    task_concurrency_per_run: int,
) -> list[str]:
    command = [
        str(python),
        str(cli),
        "run",
        "--domain",
        domain,
        "--task-set-name",
        domain,
        "--task-split-name",
        "base",
        "--num-trials",
        "1",
        "--agent",
        AGENTS[arm],
        "--agent-llm",
        "zai-org/glm-5.2",
        "--agent-llm-args",
        agent_args,
        "--user",
        "user_simulator",
        "--user-llm",
        "openai/zai-org/glm-5.2",
        "--user-llm-args",
        user_args,
        "--seed",
        "52",
        "--max-concurrency",
        str(task_concurrency_per_run),
        "--max-retries",
        "0",
        "--retry-delay",
        "15",
        "--enforce-communication-protocol",
        "--verbose-logs",
        "--llm-log-mode",
        "all",
        "--save-to",
        f"{save_prefix}-{domain}-{arm}",
    ]
    if domain == "banking_knowledge":
        command.extend(["--retrieval-config", "golden_retrieval"])
    return command


def command_plan(
    python: Path,
    cli: Path,
    *,
    save_prefix: str,
    agent_args: str,
    user_args: str,
    task_concurrency_per_run: int,
) -> dict[tuple[str, str], list[str]]:
    return {
        (domain, arm): run_command(
            python,
            cli,
            domain,
            arm,
            save_prefix=save_prefix,
            agent_args=agent_args,
            user_args=user_args,
            task_concurrency_per_run=task_concurrency_per_run,
        )
        for domain in DOMAINS
        for arm in ARMS
    }


def terminate_children(children: list[ChildRun]) -> None:
    for child in children:
        if child.process.poll() is None:
            try:
                child.process.terminate()
            except OSError:
                pass


def reap_children(children: list[ChildRun]) -> None:
    deadline = monotonic() + 15
    for child in children:
        if child.process.poll() is not None:
            continue
        try:
            child.process.wait(timeout=max(0, deadline - monotonic()))
        except subprocess.TimeoutExpired:
            try:
                child.process.kill()
            except OSError:
                pass
            child.process.wait()


def close_handles(children: list[ChildRun]) -> None:
    for child in children:
        if not child.handle.closed:
            child.handle.close()


def execute_plan(
    commands: dict[tuple[str, str], list[str]],
    *,
    domain_workers: int,
    tau_root: Path,
    environment: dict[str, str],
    logs: Path,
    all_children: list[ChildRun],
    signal_state: dict[str, int | None],
) -> None:
    """Execute bounded domain pairs while exposing children for error fan-out."""

    active_domains: dict[str, list[ChildRun]] = {}
    pending = iter(DOMAINS)

    def ensure_not_interrupted() -> None:
        interruption = signal_state["interruption"]
        if interruption is not None:
            raise RuntimeError(f"interrupted by {signal.Signals(interruption).name}")

    def launch_domain(domain: str) -> None:
        domain_children: list[ChildRun] = []
        for arm in ARMS:
            ensure_not_interrupted()
            log_path = logs / f"{domain}-{arm}.log"
            handle = log_path.open("xb")
            try:
                process = subprocess.Popen(
                    commands[(domain, arm)],
                    cwd=tau_root,
                    env=environment,
                    stdout=handle,
                    stderr=subprocess.STDOUT,
                )
            except BaseException:
                handle.close()
                raise
            child = ChildRun(arm, domain, handle, process)
            domain_children.append(child)
            all_children.append(child)
        active_domains[domain] = domain_children

    def fill_slots() -> None:
        while len(active_domains) < domain_workers:
            ensure_not_interrupted()
            try:
                domain = next(pending)
            except StopIteration:
                return
            launch_domain(domain)

    fill_slots()
    while active_domains:
        ensure_not_interrupted()
        statuses = {
            child.label: child.process.poll()
            for children in active_domains.values()
            for child in children
        }
        failures = [
            f"{label}: exit {code}"
            for label, code in statuses.items()
            if code not in (None, 0)
        ]
        if failures:
            raise RuntimeError("; ".join(failures))
        completed = [
            domain
            for domain, children in active_domains.items()
            if all(statuses[child.label] == 0 for child in children)
        ]
        if not completed:
            sleep(0.2)
            continue
        for domain in completed:
            close_handles(active_domains.pop(domain))
        fill_slots()


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)

    repo_root = args.repo_root.resolve()
    tau_root = args.tau_root.resolve()
    output_root = args.output_root.resolve()
    python = args.python.absolute()
    run_meta_path = output_root / "run-meta.json"
    manifest_path = output_root / "task-manifest.json"
    run_meta = read_object(run_meta_path)
    if not manifest_path.is_file():
        raise RuntimeError("fresh tau3 task manifest is missing")
    manifest = read_object(manifest_path)
    validate_manifest(manifest, tau_root)
    validate_fresh_run_meta(run_meta, manifest, args.save_prefix)

    data = output_root / "data"
    logs = output_root / "logs"
    for path in (data, logs):
        if path.exists() or path.is_symlink():
            raise RuntimeError(f"refusing existing tau3 execution path: {path}")
    source_data = tau_root / "data/tau2"
    cli = repo_root / "benchmarks/glm-5.2-tool-calling/tau2/tau2_cli.py"
    if not source_data.is_dir():
        raise RuntimeError(f"pinned tau3 data root is missing: {source_data}")
    if not cli.is_file():
        raise RuntimeError(f"tau3 CLI wrapper is missing: {cli}")
    if not python.is_file():
        raise RuntimeError(f"tau3 Python executable is missing: {python}")

    concurrency = args.concurrency.as_json()
    recorded_concurrency = run_meta.get("tau3Concurrency")
    if recorded_concurrency is not None and recorded_concurrency != concurrency:
        raise RuntimeError("tau3 concurrency conflicts with existing run metadata")

    agent_args = json.dumps(
        {
            "base_url": args.base_url,
            "max_tokens": args.max_tokens,
            "timeout_seconds": args.request_timeout_seconds,
        },
        separators=(",", ":"),
    )
    user_args = json.dumps({"temperature": 0, "seed": 52}, separators=(",", ":"))
    commands = command_plan(
        python,
        cli,
        save_prefix=args.save_prefix,
        agent_args=agent_args,
        user_args=user_args,
        task_concurrency_per_run=args.task_concurrency_per_run,
    )
    if args.dry_run:
        print(
            json.dumps(
                {
                    "commands": [
                        {
                            "arm": arm,
                            "command": commands[(domain, arm)],
                            "domain": domain,
                            "log": str(logs / f"{domain}-{arm}.log"),
                            "saveTo": f"{args.save_prefix}-{domain}-{arm}",
                        }
                        for domain in DOMAINS
                        for arm in ARMS
                    ],
                    "concurrency": concurrency,
                    "bridgeTransientRetries": REQUIRED_BRIDGE_TRANSIENT_RETRIES,
                    "freshExecutionPathsAbsent": True,
                    "requestTimeoutSeconds": args.request_timeout_seconds,
                    "maxOutputTokens": args.max_tokens,
                    "status": "dry-run-valid",
                    "taskCountPerArm": EXPECTED_TASKS,
                },
                ensure_ascii=False,
                sort_keys=True,
            )
        )
        return

    provider_key = os.getenv("FREEROUTER_API_KEY")
    if not provider_key:
        raise RuntimeError("FREEROUTER_API_KEY is required in the process environment")
    environment = dict(os.environ)
    environment.update(
        {
            "OPENAI_API_BASE": "https://freerouter.minpeter.workers.dev/v1",
            "OPENAI_API_KEY": provider_key,
            "PYTHONPATH": str(repo_root / "benchmarks/glm-5.2-tool-calling/tau2"),
            "PYTHONUNBUFFERED": "1",
            "TAU2_DATA_DIR": str(data),
            "TAU2_NL_JUDGE_ARGS": json.dumps(
                {
                    "response_format": {"type": "json_object"},
                    "seed": 52,
                    "temperature": 0,
                },
                separators=(",", ":"),
            ),
            "TAU2_NL_JUDGE_MODEL": "openai/zai-org/glm-5.2",
        }
    )

    children: list[ChildRun] = []
    signal_state: dict[str, int | None] = {"interruption": None}

    def stop(signum: int, _frame: object) -> None:
        signal_state["interruption"] = signum
        terminate_children(children)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    try:
        run_meta["tau3Concurrency"] = concurrency
        run_meta["requestTimeoutSeconds"] = args.request_timeout_seconds
        run_meta["clientMaxOutputTokens"] = args.max_tokens
        atomic_json(run_meta_path, run_meta)
        data.mkdir()
        (data / "tau2").symlink_to(source_data, target_is_directory=True)
        logs.mkdir()
        execute_plan(
            commands,
            domain_workers=args.domain_workers,
            tau_root=tau_root,
            environment=environment,
            logs=logs,
            all_children=children,
            signal_state=signal_state,
        )
        interruption = signal_state["interruption"]
        if interruption is not None:
            raise RuntimeError(f"interrupted by {signal.Signals(interruption).name}")
        close_handles(children)
        run_meta.update({"completedAt": now(), "status": "inference-complete"})
        atomic_json(run_meta_path, run_meta)
    except BaseException as error:
        terminate_children(children)
        reap_children(children)
        close_handles(children)
        interruption = signal_state["interruption"]
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


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"tau3 full runner failed: {error}", file=sys.stderr)
        raise
