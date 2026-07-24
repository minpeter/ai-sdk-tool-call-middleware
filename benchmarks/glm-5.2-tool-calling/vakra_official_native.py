#!/usr/bin/env python3
"""Run VAKRA's pinned public population through paired native parser arms."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from threading import Event
from time import sleep
from typing import Any, BinaryIO, Callable


ARMS = ("glm52-native", "glm52-prompt-only")
CAPABILITIES = (1, 2, 3, 4)
EXPECTED_TASKS = 5_207
EXPECTED_CODE_COMMIT = "99847464a7b0fca05413b53ad8a7714d9a9279e9"
MAX_DOMAIN_WORKERS_PER_CAPABILITY = 2
CAPABILITY_NAMES = {
    1: "capability_1_bi_apis",
    2: "capability_2_dashboard_apis",
    3: "capability_3_multihop_reasoning",
    4: "capability_4_multiturn",
}
DOMAIN_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]*")


@dataclass(frozen=True, order=True)
class DomainSpec:
    capability: int
    domain: str
    capability_name: str
    relative_path: str
    row_count: int
    expected_uuids: tuple[str, ...] = ()


@dataclass(frozen=True)
class ShardArtifact:
    arm: str
    log_path: Path
    result_path: Path
    spec: DomainSpec
    tools_path: Path


def now() -> str:
    return datetime.now().astimezone().isoformat()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected a JSON object")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def git_revision(root: Path) -> str:
    return subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def validate_manifest(manifest: dict[str, Any], code_root: Path) -> None:
    if manifest.get("benchmark") != "VAKRA":
        raise RuntimeError("manifest is not VAKRA")
    if manifest.get("taskCount") != EXPECTED_TASKS:
        raise RuntimeError("manifest is not the full 5,207-task population")
    revision = git_revision(code_root)
    if revision != EXPECTED_CODE_COMMIT or manifest.get("codeCommit") != revision:
        raise RuntimeError("VAKRA code revision mismatch")


def domain_specs_from_manifest(manifest: dict[str, Any]) -> tuple[DomainSpec, ...]:
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise RuntimeError("VAKRA manifest file inventory is empty")
    specs: list[DomainSpec] = []
    identities: set[tuple[int, str]] = set()
    for entry in files:
        if not isinstance(entry, dict):
            raise RuntimeError("VAKRA manifest file entry is invalid")
        relative = entry.get("path")
        if not isinstance(relative, str):
            raise RuntimeError("VAKRA manifest file path is invalid")
        capability_name = entry.get("capability")
        if not isinstance(capability_name, str):
            raise RuntimeError("VAKRA manifest capability is invalid")
        capability = next(
            (
                candidate
                for candidate, expected_name in CAPABILITY_NAMES.items()
                if capability_name == expected_name
            ),
            None,
        )
        if capability is None:
            raise RuntimeError(
                f"VAKRA manifest capability is unknown: {capability_name}"
            )
        relative_path = PurePosixPath(relative)
        if relative_path.is_absolute() or ".." in relative_path.parts:
            raise RuntimeError(f"VAKRA manifest path escapes data root: {relative}")
        if len(relative_path.parts) != 4:
            raise RuntimeError(f"VAKRA manifest path shape is invalid: {relative}")
        prefix, path_capability, input_dir, filename = relative_path.parts
        domain = PurePosixPath(filename).stem
        expected_parts = ("test", capability_name, "input", f"{domain}.json")
        if (
            (prefix, path_capability, input_dir, filename) != expected_parts
            or DOMAIN_NAME.fullmatch(domain) is None
        ):
            raise RuntimeError(f"VAKRA manifest path identity is invalid: {relative}")
        row_count = entry.get("rowCount")
        if (
            not isinstance(row_count, int)
            or isinstance(row_count, bool)
            or row_count <= 0
        ):
            raise RuntimeError(f"VAKRA manifest row count is invalid: {relative}")
        identity = (capability, domain)
        if identity in identities:
            raise RuntimeError(
                f"VAKRA manifest domain is duplicated: capability-{capability}/{domain}"
            )
        identities.add(identity)
        specs.append(
            DomainSpec(
                capability=capability,
                capability_name=capability_name,
                domain=domain,
                relative_path=relative,
                row_count=row_count,
            )
        )

    specs.sort()
    counts = manifest.get("counts")
    if not isinstance(counts, dict):
        raise RuntimeError("VAKRA manifest capability counts are missing")
    for capability, capability_name in CAPABILITY_NAMES.items():
        expected = sum(
            spec.row_count for spec in specs if spec.capability == capability
        )
        if expected <= 0 or counts.get(capability_name) != expected:
            raise RuntimeError(
                f"VAKRA manifest count mismatch for {capability_name}: {expected}"
            )
    if sum(spec.row_count for spec in specs) != EXPECTED_TASKS:
        raise RuntimeError("VAKRA manifest domain rows do not total 5,207")
    return tuple(specs)


def validate_dataset(
    manifest: dict[str, Any], code_root: Path
) -> tuple[DomainSpec, ...]:
    validated: list[DomainSpec] = []
    rows = 0
    for spec in domain_specs_from_manifest(manifest):
        local = code_root / "data" / spec.relative_path
        if not local.is_file():
            raise RuntimeError(f"VAKRA dataset file is missing: {local}")
        entry = next(
            item
            for item in manifest["files"]
            if isinstance(item, dict) and item.get("path") == spec.relative_path
        )
        if local.stat().st_size != entry.get("bytes"):
            raise RuntimeError(f"VAKRA dataset byte drift: {local}")
        if sha256_file(local) != entry.get("sha256"):
            raise RuntimeError(f"VAKRA dataset hash drift: {local}")
        value = json.loads(local.read_text(encoding="utf-8"))
        if not isinstance(value, list) or len(value) != spec.row_count:
            raise RuntimeError(f"VAKRA dataset row drift: {local}")
        uuids: list[str] = []
        for item in value:
            if not isinstance(item, dict):
                raise RuntimeError(f"VAKRA dataset item is invalid: {local}")
            uuid = item.get("uuid")
            if not isinstance(uuid, str) or not uuid:
                raise RuntimeError(f"VAKRA dataset UUID is invalid: {local}")
            if item.get("domain") != spec.domain:
                raise RuntimeError(f"VAKRA dataset domain drift: {local}")
            uuids.append(uuid)
        if len(set(uuids)) != len(uuids):
            raise RuntimeError(f"VAKRA dataset UUID is duplicated: {local}")
        validated.append(
            DomainSpec(
                capability=spec.capability,
                capability_name=spec.capability_name,
                domain=spec.domain,
                relative_path=spec.relative_path,
                row_count=spec.row_count,
                expected_uuids=tuple(uuids),
            )
        )
        rows += len(value)
    if rows != EXPECTED_TASKS:
        raise RuntimeError(
            f"VAKRA dataset expected {EXPECTED_TASKS} rows, found {rows}"
        )
    return tuple(validated)


def command_for(
    python: Path,
    code_root: Path,
    capability: int,
    arm: str,
    arm_root: Path,
    top_k_tools: int,
    max_iterations: int | None,
    *,
    domain: str | None = None,
    output_dir: Path | None = None,
) -> list[str]:
    output = output_dir or arm_root / f"capability-{capability}"
    command = [
        str(python),
        str(code_root / "benchmark_runner.py"),
        "--capability_id",
        str(capability),
        "--provider",
        "litellm",
        "--model",
        arm,
        "--output",
        str(output),
        "--top-k-tools",
        str(top_k_tools),
        "--temperature",
        "0",
    ]
    if domain is not None:
        command.extend(["--domain", domain])
    if max_iterations is not None:
        command.extend(["--max-iterations", str(max_iterations)])
    return command


def shard_output_path(output_root: Path, spec: DomainSpec, arm: str) -> Path:
    if arm not in ARMS:
        raise RuntimeError(f"unknown VAKRA arm: {arm}")
    return (
        output_root
        / "shards"
        / f"capability-{spec.capability}"
        / spec.domain
        / arm
    )


def shard_console_path(output_root: Path, spec: DomainSpec, arm: str) -> Path:
    if arm not in ARMS:
        raise RuntimeError(f"unknown VAKRA arm: {arm}")
    return (
        output_root
        / "logs"
        / "shards"
        / f"capability-{spec.capability}"
        / spec.domain
        / f"{arm}.log"
    )


def shard_commands(
    specs: tuple[DomainSpec, ...],
    python: Path,
    code_root: Path,
    output_root: Path,
    top_k_tools: int,
    max_iterations: int | None,
) -> dict[str, list[str]]:
    return {
        f"capability-{spec.capability}/{spec.domain}/{arm}": command_for(
            python,
            code_root,
            spec.capability,
            arm,
            output_root / "outputs" / arm,
            top_k_tools,
            max_iterations,
            domain=spec.domain,
            output_dir=shard_output_path(output_root, spec, arm),
        )
        for spec in specs
        for arm in ARMS
    }


def _json_list(path: Path, description: str) -> list[Any]:
    if not path.is_file() or path.is_symlink():
        raise RuntimeError(f"VAKRA {description} is missing or not regular: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"VAKRA {description} is invalid: {path}: {error}"
        ) from error
    if not isinstance(value, list):
        raise RuntimeError(f"VAKRA {description} is not a JSON list: {path}")
    return value


def _output_uuids(
    rows: list[Any], spec: DomainSpec, description: str
) -> tuple[str, ...]:
    uuids: list[str] = []
    for row in rows:
        if not isinstance(row, dict):
            raise RuntimeError(
                f"VAKRA {description} row is not an object: "
                f"capability-{spec.capability}/{spec.domain}"
            )
        uuid = row.get("uuid")
        if not isinstance(uuid, str) or not uuid:
            raise RuntimeError(
                f"VAKRA {description} UUID is invalid: "
                f"capability-{spec.capability}/{spec.domain}"
            )
        if row.get("domain") != spec.domain:
            raise RuntimeError(
                f"VAKRA {description} domain mismatch: "
                f"capability-{spec.capability}/{spec.domain}"
            )
        uuids.append(uuid)
    return tuple(uuids)


def validate_shard_output(
    output_root: Path, spec: DomainSpec, arm: str
) -> ShardArtifact:
    if not spec.expected_uuids or len(spec.expected_uuids) != spec.row_count:
        raise RuntimeError(
            f"VAKRA shard spec was not dataset-validated: "
            f"capability-{spec.capability}/{spec.domain}"
        )
    shard_root = shard_output_path(output_root, spec, arm)
    result_path = shard_root / f"{spec.domain}.json"
    tools_path = shard_root / f"{spec.domain}_tools.json"
    log_path = shard_root / "run.log"
    if not log_path.is_file() or log_path.is_symlink():
        raise RuntimeError(f"VAKRA shard run log is missing or not regular: {log_path}")
    results = _json_list(result_path, "shard result")
    tools = _json_list(tools_path, "shard tool log")
    if len(results) != spec.row_count or len(tools) != spec.row_count:
        raise RuntimeError(
            f"VAKRA shard row mismatch for capability-{spec.capability}/"
            f"{spec.domain}/{arm}: results={len(results)}, tools={len(tools)}, "
            f"expected={spec.row_count}"
        )
    result_uuids = _output_uuids(results, spec, "shard result")
    tool_uuids = _output_uuids(tools, spec, "shard tool log")
    if result_uuids != spec.expected_uuids or tool_uuids != spec.expected_uuids:
        raise RuntimeError(
            f"VAKRA shard UUID/order mismatch for capability-{spec.capability}/"
            f"{spec.domain}/{arm}"
        )
    return ShardArtifact(
        arm=arm,
        log_path=log_path,
        result_path=result_path,
        spec=spec,
        tools_path=tools_path,
    )


def _child_log(
    output_root: Path,
    spec: DomainSpec,
    arm: str,
    child_log_mode: str,
) -> BinaryIO:
    if child_log_mode == "full":
        path = shard_console_path(output_root, spec, arm)
        if path.exists():
            raise RuntimeError(f"refusing existing VAKRA shard console log: {path}")
        path.parent.mkdir(parents=True, exist_ok=True)
        return path.open("xb")
    return open(os.devnull, "wb")


def run_domain_pair(
    spec: DomainSpec,
    *,
    commands: dict[str, list[str]],
    output_root: Path,
    code_root: Path,
    environment: dict[str, str],
    child_log_mode: str,
    stop_event: Event | None = None,
) -> tuple[ShardArtifact, ...]:
    processes: list[tuple[str, subprocess.Popen[bytes], BinaryIO]] = []
    for arm in ARMS:
        shard_root = shard_output_path(output_root, spec, arm)
        if shard_root.exists():
            raise RuntimeError(f"refusing existing VAKRA shard output: {shard_root}")
        console = shard_console_path(output_root, spec, arm)
        if child_log_mode == "full" and console.exists():
            raise RuntimeError(f"refusing existing VAKRA shard console log: {console}")
    try:
        for arm in ARMS:
            handle = _child_log(output_root, spec, arm, child_log_mode)
            try:
                process = subprocess.Popen(
                    commands[f"capability-{spec.capability}/{spec.domain}/{arm}"],
                    cwd=code_root,
                    env=environment,
                    stdout=handle,
                    stderr=subprocess.STDOUT,
                )
            except BaseException:
                handle.close()
                raise
            processes.append((arm, process, handle))

        while True:
            failures = [
                f"capability-{spec.capability}/{spec.domain}/{arm}: "
                f"exit {process.returncode}"
                for arm, process, _handle in processes
                if process.poll() not in (None, 0)
            ]
            if failures:
                if stop_event is not None:
                    stop_event.set()
                raise RuntimeError("; ".join(failures))
            if all(process.poll() == 0 for _arm, process, _handle in processes):
                break
            if stop_event is not None and stop_event.is_set():
                raise RuntimeError("VAKRA shard execution cancelled after peer failure")
            sleep(0.2)
    except BaseException:
        if stop_event is not None:
            stop_event.set()
        for _arm, process, _handle in processes:
            if process.poll() is None:
                process.terminate()
        for _arm, process, _handle in processes:
            if process.poll() is None:
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        raise
    finally:
        for _arm, _process, handle in processes:
            if not handle.closed:
                handle.close()

    return tuple(validate_shard_output(output_root, spec, arm) for arm in ARMS)


def run_capability_shards(
    specs: tuple[DomainSpec, ...],
    workers: int,
    run_pair: Callable[[DomainSpec], tuple[ShardArtifact, ...]],
    stop_event: Event | None = None,
) -> tuple[ShardArtifact, ...]:
    if workers < 1 or workers > MAX_DOMAIN_WORKERS_PER_CAPABILITY:
        raise RuntimeError(
            "VAKRA domain workers per capability must be between 1 and "
            f"{MAX_DOMAIN_WORKERS_PER_CAPABILITY}"
        )
    stop = stop_event or Event()
    artifacts: list[ShardArtifact] = []

    def guarded_run(spec: DomainSpec) -> tuple[ShardArtifact, ...]:
        if stop.is_set():
            raise RuntimeError("VAKRA shard execution cancelled before launch")
        return run_pair(spec)

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(guarded_run, spec) for spec in specs]
        try:
            for future in as_completed(futures):
                artifacts.extend(future.result())
        except BaseException:
            stop.set()
            for future in futures:
                future.cancel()
            raise
    return tuple(
        sorted(
            artifacts,
            key=lambda item: (item.spec.capability, item.spec.domain, item.arm),
        )
    )


def run_domain_shards(
    specs: tuple[DomainSpec, ...],
    *,
    workers_per_capability: int,
    parallel_capabilities: bool,
    run_pair: Callable[[DomainSpec], tuple[ShardArtifact, ...]],
    stop_event: Event | None = None,
) -> tuple[ShardArtifact, ...]:
    stop = stop_event or Event()
    grouped = {
        capability: tuple(
            sorted(
                (spec for spec in specs if spec.capability == capability),
                key=lambda spec: (-spec.row_count, spec.domain),
            )
        )
        for capability in CAPABILITIES
    }

    def run_capability(capability: int) -> tuple[ShardArtifact, ...]:
        return run_capability_shards(
            grouped[capability], workers_per_capability, run_pair, stop
        )

    if not parallel_capabilities:
        return tuple(
            artifact
            for capability in CAPABILITIES
            for artifact in run_capability(capability)
        )

    artifacts: list[ShardArtifact] = []
    with ThreadPoolExecutor(max_workers=len(CAPABILITIES)) as executor:
        futures = [
            executor.submit(run_capability, capability)
            for capability in CAPABILITIES
        ]
        try:
            for future in as_completed(futures):
                artifacts.extend(future.result())
        except BaseException:
            stop.set()
            for future in futures:
                future.cancel()
            raise
    return tuple(
        sorted(
            artifacts,
            key=lambda item: (item.spec.capability, item.spec.domain, item.arm),
        )
    )


def aggregate_shards(
    output_root: Path, specs: tuple[DomainSpec, ...]
) -> dict[str, Any]:
    canonical = output_root / "outputs"
    temporary = output_root / ".outputs.aggregate.tmp"
    if canonical.exists():
        raise RuntimeError(f"refusing existing VAKRA canonical output: {canonical}")
    if temporary.exists():
        raise RuntimeError(
            f"refusing existing VAKRA aggregate staging root: {temporary}"
        )

    artifacts = [
        validate_shard_output(output_root, spec, arm)
        for arm in ARMS
        for spec in specs
    ]
    entries: list[dict[str, Any]] = []
    totals = {arm: 0 for arm in ARMS}
    temporary.mkdir()
    for artifact in artifacts:
        destination_dir = (
            temporary
            / artifact.arm
            / f"capability-{artifact.spec.capability}"
        )
        destination_dir.mkdir(parents=True, exist_ok=True)
        result_destination = destination_dir / artifact.result_path.name
        tools_destination = destination_dir / artifact.tools_path.name
        if result_destination.exists() or tools_destination.exists():
            raise RuntimeError(
                f"VAKRA aggregate destination collision: {result_destination}"
            )
        shutil.copyfile(artifact.result_path, result_destination)
        shutil.copyfile(artifact.tools_path, tools_destination)
        totals[artifact.arm] += artifact.spec.row_count
        entries.append(
            {
                "arm": artifact.arm,
                "capability": artifact.spec.capability,
                "domain": artifact.spec.domain,
                "result": str(
                    Path("outputs")
                    / artifact.arm
                    / f"capability-{artifact.spec.capability}"
                    / result_destination.name
                ),
                "resultSha256": sha256_file(result_destination),
                "rows": artifact.spec.row_count,
                "shard": str(artifact.result_path.relative_to(output_root)),
                "tools": str(
                    Path("outputs")
                    / artifact.arm
                    / f"capability-{artifact.spec.capability}"
                    / tools_destination.name
                ),
                "toolsSha256": sha256_file(tools_destination),
            }
        )
    expected_total = sum(spec.row_count for spec in specs)
    if any(total != expected_total for total in totals.values()):
        raise RuntimeError(f"VAKRA aggregate population mismatch: {totals}")
    manifest = {
        "arms": list(ARMS),
        "domainShardCount": len(specs) * len(ARMS),
        "files": entries,
        "formatVersion": 1,
        "itemConcurrencyWithinShard": 1,
        "taskCountPerArm": totals,
    }
    atomic_json(temporary / "aggregate-manifest.json", manifest)
    os.replace(temporary, canonical)
    return manifest


def run_legacy_capabilities(
    *,
    commands: dict[str, list[str]],
    output_root: Path,
    code_root: Path,
    environment: dict[str, str],
    child_log_mode: str,
) -> None:
    """Preserve the original capability-sequential, paired-arm execution path."""
    for capability in CAPABILITIES:
        processes: list[tuple[str, subprocess.Popen[bytes], BinaryIO]] = []
        try:
            for arm in ARMS:
                if child_log_mode == "full":
                    log_path = (
                        output_root / "logs" / f"capability-{capability}-{arm}.log"
                    )
                    if log_path.exists():
                        raise RuntimeError(
                            f"refusing existing VAKRA child log: {log_path}"
                        )
                    log_path.parent.mkdir(parents=True, exist_ok=True)
                    handle = log_path.open("xb")
                else:
                    handle = open(os.devnull, "wb")
                try:
                    process = subprocess.Popen(
                        commands[f"capability-{capability}/{arm}"],
                        cwd=code_root,
                        env=environment,
                        stdout=handle,
                        stderr=subprocess.STDOUT,
                    )
                except BaseException:
                    handle.close()
                    raise
                processes.append((arm, process, handle))

            failures: list[str] = []
            for arm, process, _handle in processes:
                return_code = process.wait()
                if return_code != 0:
                    failures.append(
                        f"capability-{capability}/{arm}: exit {return_code}"
                    )
            if failures:
                raise RuntimeError("; ".join(failures))
        except BaseException:
            for _arm, process, _handle in processes:
                if process.poll() is None:
                    process.terminate()
            for _arm, process, _handle in processes:
                if process.poll() is None:
                    try:
                        process.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
            raise
        finally:
            for _arm, _process, handle in processes:
                if not handle.closed:
                    handle.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--code-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--bridge-root", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--top-k-tools", type=int, default=128)
    parser.add_argument("--max-iterations", type=int)
    parser.add_argument("--agent-timeout-seconds", type=int, default=300)
    parser.add_argument(
        "--child-log-mode", choices=("full", "discard"), default="full"
    )
    parser.add_argument(
        "--domain-sharding",
        action="store_true",
        help=(
            "Run one upstream process per domain and arm, then atomically "
            "aggregate canonical outputs. Disabled by default for compatibility."
        ),
    )
    parser.add_argument(
        "--domain-workers-per-capability",
        type=int,
        default=1,
        help=(
            "Concurrent paired-domain workers per capability container in "
            f"sharded mode (1-{MAX_DOMAIN_WORKERS_PER_CAPABILITY}; each worker "
            "launches both arms)."
        ),
    )
    parser.add_argument(
        "--parallel-capabilities",
        action="store_true",
        help="Run the four independently-containerized capabilities concurrently.",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not 1 <= args.domain_workers_per_capability <= MAX_DOMAIN_WORKERS_PER_CAPABILITY:
        parser.error(
            "--domain-workers-per-capability must be between 1 and "
            f"{MAX_DOMAIN_WORKERS_PER_CAPABILITY}"
        )
    sharded = (
        args.domain_sharding
        or args.parallel_capabilities
        or args.domain_workers_per_capability > 1
    )

    code_root = args.code_root.resolve()
    manifest_path = args.manifest.resolve()
    output_root = args.output_root.resolve()
    bridge_root = args.bridge_root.resolve()
    # Preserve the virtualenv launcher path. Path.resolve() follows the
    # ``bin/python`` symlink to the system interpreter and loses venv package
    # discovery when that resolved path is executed directly.
    python = args.python.absolute()
    manifest = read_json(manifest_path)
    validate_manifest(manifest, code_root)
    if not python.is_file():
        raise RuntimeError(f"VAKRA Python is missing: {python}")
    manifest_specs = domain_specs_from_manifest(manifest)
    if sharded:
        commands = shard_commands(
            manifest_specs,
            python,
            code_root,
            output_root,
            args.top_k_tools,
            args.max_iterations,
        )
    else:
        commands = {
            f"capability-{capability}/{arm}": command_for(
                python,
                code_root,
                capability,
                arm,
                output_root / "outputs" / arm,
                args.top_k_tools,
                args.max_iterations,
            )
            for capability in CAPABILITIES
            for arm in ARMS
        }
    if args.dry_run:
        print(
            json.dumps(
                {
                    "arms": list(ARMS),
                    "armWorkersPerCapability": (
                        args.domain_workers_per_capability * len(ARMS)
                        if sharded
                        else len(ARMS)
                    ),
                    "capabilities": list(CAPABILITIES),
                    "commands": commands,
                    "domainPairCount": len(manifest_specs),
                    "domainScheduling": "largest-processing-time-first",
                    "domainSharding": sharded,
                    "domainWorkersPerCapability": args.domain_workers_per_capability,
                    "expectedFreshTrajectories": EXPECTED_TASKS * len(ARMS),
                    "bridgeRoot": str(bridge_root),
                    "itemConcurrencyWithinShard": 1,
                    "parallelCapabilities": args.parallel_capabilities,
                    "status": "valid-dry-run",
                    "taskCountPerArm": EXPECTED_TASKS,
                    "taskSetSha256": manifest.get("taskSetSha256"),
                },
                ensure_ascii=False,
                sort_keys=True,
            )
        )
        return

    if output_root.exists():
        raise RuntimeError(f"refusing existing VAKRA output root: {output_root}")
    if not bridge_root.is_dir():
        raise RuntimeError(f"VAKRA bridge root is missing: {bridge_root}")
    if (
        output_root == bridge_root
        or output_root in bridge_root.parents
        or bridge_root in output_root.parents
    ):
        raise RuntimeError("VAKRA bridge root must be outside the fresh output root")
    for filename in ("provider-raw.jsonl", "requests.jsonl"):
        if not (bridge_root / filename).is_file():
            raise RuntimeError(f"VAKRA bridge audit file is missing: {filename}")
    validated_specs = validate_dataset(manifest, code_root)
    output_root.mkdir(parents=True)
    (output_root / "bridge").symlink_to(bridge_root, target_is_directory=True)
    started_at = now()
    runner_path = Path(__file__).resolve()
    run_meta: dict[str, Any] = {
        "arms": list(ARMS),
        "armWorkersPerCapability": (
            args.domain_workers_per_capability * len(ARMS)
            if sharded
            else len(ARMS)
        ),
        "benchmark": "VAKRA",
        "benchmarkCommit": git_revision(code_root),
        "bridgeRoot": str(bridge_root),
        "childLogMode": args.child_log_mode,
        "completedAt": None,
        "domainPairCount": len(validated_specs),
        "domainScheduling": "largest-processing-time-first",
        "domainSharding": sharded,
        "domainWorkersPerCapability": args.domain_workers_per_capability,
        "expectedFreshTrajectories": EXPECTED_TASKS * len(ARMS),
        "freshness": {
            "canonicalOutputAbsentAtStart": True,
            "historicalRawInput": False,
            "historicalScoreInput": False,
            "outputRootAbsentBeforeCreation": True,
            "preseed": False,
            "resumeFromPriorRun": False,
            "shardOutputsAbsentAtStart": True,
        },
        "itemConcurrencyWithinShard": 1,
        "parallelCapabilities": args.parallel_capabilities,
        "runnerSha256": sha256_file(runner_path),
        "startedAt": started_at,
        "status": "running",
        "taskCountPerArm": EXPECTED_TASKS,
        "taskSetSha256": manifest.get("taskSetSha256"),
        "topKTools": args.top_k_tools,
    }
    atomic_json(output_root / "run-meta.json", run_meta)
    atomic_json(
        output_root / "launch-manifest.json",
        {
            "agentTimeoutSeconds": args.agent_timeout_seconds,
            "armWorkersPerCapability": (
                args.domain_workers_per_capability * len(ARMS)
                if sharded
                else len(ARMS)
            ),
            "baseUrl": args.base_url,
            "childLogMode": args.child_log_mode,
            "commands": commands,
            "domainPairCount": len(validated_specs),
            "domainScheduling": "largest-processing-time-first",
            "domainSharding": sharded,
            "domainWorkersPerCapability": args.domain_workers_per_capability,
            "generatedAt": started_at,
            "itemConcurrencyWithinShard": 1,
            "maxIterations": args.max_iterations,
            "modelProvider": "litellm-openai-compatible",
            "parallelCapabilities": args.parallel_capabilities,
            "runnerSha256": run_meta["runnerSha256"],
            "topKTools": args.top_k_tools,
        },
    )

    environment = os.environ.copy()
    environment.update(
        {
            "AGENT_TIMEOUT_SECONDS": str(args.agent_timeout_seconds),
            "LITELLM_API_KEY": "bridge-local",
            "LITELLM_BASE_URL": args.base_url.rstrip("/"),
            "PYTHONUNBUFFERED": "1",
        }
    )
    stage = "inference"
    try:
        if sharded:
            stop_event = Event()
            artifacts = run_domain_shards(
                validated_specs,
                workers_per_capability=args.domain_workers_per_capability,
                parallel_capabilities=args.parallel_capabilities,
                stop_event=stop_event,
                run_pair=lambda spec: run_domain_pair(
                    spec,
                    commands=commands,
                    output_root=output_root,
                    code_root=code_root,
                    environment=environment,
                    child_log_mode=args.child_log_mode,
                    stop_event=stop_event,
                ),
            )
            expected_artifacts = len(validated_specs) * len(ARMS)
            if len(artifacts) != expected_artifacts:
                raise RuntimeError(
                    f"VAKRA shard artifact mismatch: {len(artifacts)} != "
                    f"{expected_artifacts}"
                )
            stage = "aggregate"
            aggregate = aggregate_shards(output_root, validated_specs)
            run_meta.update(
                {
                    "aggregateManifest": "outputs/aggregate-manifest.json",
                    "canonicalDomainFiles": len(aggregate["files"]),
                }
            )
        else:
            run_legacy_capabilities(
                commands=commands,
                output_root=output_root,
                code_root=code_root,
                environment=environment,
                child_log_mode=args.child_log_mode,
            )
    except BaseException as error:
        run_meta.update(
            {
                "completedAt": now(),
                "failure": f"{type(error).__name__}: {error}",
                "status": f"{stage}-failed",
            }
        )
        atomic_json(output_root / "run-meta.json", run_meta)
        raise

    run_meta.update({"completedAt": now(), "status": "inference-complete"})
    atomic_json(output_root / "run-meta.json", run_meta)
    print(json.dumps(run_meta, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"VAKRA runner failed: {error}", file=sys.stderr)
        raise
