#!/usr/bin/env python3

from __future__ import annotations

import argparse
from collections.abc import Mapping, Sequence
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Final, TYPE_CHECKING, assert_never

if TYPE_CHECKING:
    from .agentic_replacement_metadata import (
        BFCL_COMMIT, HAMMER_COMMIT, HAMMER_DATASET_REVISION, STABLE_COMMIT,
        TAU3_COMMIT, CampaignBinding, PreparationConfig, PreparationError,
        Suite, bfcl_meta, bind_run_to_campaign, campaign_binding, common,
        hammer_meta, stable_meta, tau3_meta,
    )
    from .capture_runtime_fingerprint import canonical_json_bytes
else:
    from agentic_replacement_metadata import (
        BFCL_COMMIT, HAMMER_COMMIT, HAMMER_DATASET_REVISION, STABLE_COMMIT,
        TAU3_COMMIT, CampaignBinding, PreparationConfig, PreparationError,
        Suite, bfcl_meta, bind_run_to_campaign, campaign_binding, common,
        hammer_meta, stable_meta, tau3_meta,
    )
    from capture_runtime_fingerprint import canonical_json_bytes

__all__ = (
    "BFCL_COMMIT", "HAMMER_COMMIT", "HAMMER_DATASET_REVISION", "STABLE_COMMIT",
    "TAU3_COMMIT", "CampaignBinding", "PreparationConfig", "Suite", "bfcl_meta",
    "bind_run_to_campaign", "campaign_binding", "common", "hammer_meta", "stable_meta",
    "tau3_meta", "PARSER_PATH", "EXPECTED_BRIDGE_PATHS", "EXPECTED_RUNNER_PATHS",
    "runtime_identity", "write_prepared_artifacts",
)


PARSER_PATH: Final = Path("src/core/protocols/glm5-call-parsing.ts")
EXPECTED_BRIDGE_PATHS: Final = frozenset(
    {
        "benchmarks/glm-5.2-tool-calling/src/benchmark-model-call.ts",
        "benchmarks/glm-5.2-tool-calling/src/openai-compat-bridge.ts",
        "benchmarks/glm-5.2-tool-calling/src/provider-capture.ts",
    }
)
EXPECTED_RUNNER_PATHS: Final = {
    Suite.HAMMER: frozenset(
        {"benchmarks/glm-5.2-tool-calling/hammerbench_official_native.py"}
    ),
    Suite.BFCL: frozenset(
        {"benchmarks/glm-5.2-tool-calling/bfcl_official.py"}
    ),
    Suite.STABLE: frozenset(
        {
            "benchmarks/glm-5.2-tool-calling/stabletoolbench_full_native.py",
            "benchmarks/glm-5.2-tool-calling/stabletoolbench_official_native.py",
            "benchmarks/glm-5.2-tool-calling/stabletoolbench_service_isolation.py",
        }
    ),
    Suite.TAU3: frozenset(
        {
            "benchmarks/glm-5.2-tool-calling/tau2/tau3_openai_compat_agent.py",
            "benchmarks/glm-5.2-tool-calling/tau3_full_native.py",
        }
    ),
}


def read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise PreparationError(f"{path}: expected a JSON object")
    return value


def prepared_root(requested: Path) -> Path:
    absolute = Path(os.path.abspath(requested))
    if not os.path.lexists(absolute) or absolute.is_symlink() or not absolute.is_dir():
        raise PreparationError("replacement output root must be a new real directory")
    expected_entries = {"task-manifest.json", "runtime-fingerprint.json"}
    entries = {path.name for path in absolute.iterdir()}
    if entries != expected_entries:
        raise PreparationError(
            "replacement output root must contain only the new manifest and fingerprint"
        )
    for name in expected_entries:
        artifact = absolute / name
        if artifact.is_symlink() or not artifact.is_file():
            raise PreparationError("prepared inputs must be regular non-symlink files")
    return absolute.resolve(strict=True)


def write_exclusive(path: Path, value: Mapping[str, Any]) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    complete = False
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            os.fchmod(handle.fileno(), 0o600)
            json.dump(value, handle, ensure_ascii=True, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        complete = True
    finally:
        if not complete:
            path.unlink(missing_ok=True)


def write_prepared_artifacts(
    root: Path, metadata: Mapping[str, Any], binding: CampaignBinding
) -> None:
    created: list[Path] = []
    complete = False
    try:
        binding_path = root / "campaign-binding.json"
        write_exclusive(binding_path, binding)
        created.append(binding_path)
        metadata_path = root / "run-meta.json"
        write_exclusive(metadata_path, metadata)
        created.append(metadata_path)
        complete = True
    finally:
        if not complete:
            for path in reversed(created):
                path.unlink(missing_ok=True)


def _runtime_role_paths(root: Path, runtime: Mapping[str, Any], role: str) -> list[str]:
    files = runtime.get("files")
    if not isinstance(files, dict):
        raise PreparationError("runtime fingerprint file roles are missing")
    records = files.get(role)
    if not isinstance(records, list):
        raise PreparationError(f"runtime fingerprint {role} records are missing")
    paths: list[str] = []
    for record in records:
        if not isinstance(record, dict):
            raise PreparationError(f"runtime fingerprint {role} record is invalid")
        relative = record.get("path")
        expected_sha256 = record.get("sha256")
        if not isinstance(relative, str) or not isinstance(expected_sha256, str):
            raise PreparationError(f"runtime fingerprint {role} record is invalid")
        try:
            source = (root / relative).resolve(strict=True)
            source.relative_to(root)
        except (OSError, ValueError) as error:
            raise PreparationError(f"runtime fingerprint {role} path escaped") from error
        if not source.is_file():
            raise PreparationError(f"runtime fingerprint {role} path is not a file")
        actual_sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
        if expected_sha256 != actual_sha256:
            raise PreparationError(f"runtime fingerprint {role} source drift")
        paths.append(relative)
    if len(paths) != len(set(paths)):
        raise PreparationError(f"runtime fingerprint {role} contains duplicates")
    return paths


def runtime_identity(root: Path, fingerprint: Mapping[str, Any], suite: Suite) -> dict[str, Any]:
    runtime = fingerprint.get("runtimeFingerprint")
    if not isinstance(runtime, dict) or runtime.get("schemaVersion") != 1:
        raise PreparationError("runtime fingerprint object is invalid")
    parser_paths = _runtime_role_paths(root, runtime, "parser")
    if parser_paths.count(PARSER_PATH.as_posix()) != 1:
        raise PreparationError("runtime fingerprint does not contain the final parser")
    runner_paths = _runtime_role_paths(root, runtime, "runner")
    if frozenset(runner_paths) != EXPECTED_RUNNER_PATHS[suite]:
        raise PreparationError("runtime fingerprint runner set is incomplete or unexpected")
    bridge_paths = _runtime_role_paths(root, runtime, "bridge")
    if frozenset(bridge_paths) != EXPECTED_BRIDGE_PATHS:
        raise PreparationError("runtime fingerprint bridge set is incomplete or unexpected")
    aggregate = runtime.get("aggregateSha256")
    material = {key: value for key, value in runtime.items() if key != "aggregateSha256"}
    expected_aggregate = hashlib.sha256(canonical_json_bytes(material)).hexdigest()
    if aggregate != expected_aggregate:
        raise PreparationError("runtime fingerprint aggregate is invalid")
    parser_source = root / PARSER_PATH
    parser_sha256 = hashlib.sha256(parser_source.read_bytes()).hexdigest()
    source_mtime = datetime.fromtimestamp(
        parser_source.stat().st_mtime, tz=datetime.now().astimezone().tzinfo
    ).isoformat()
    return {
        "runtimeFingerprintAggregateSha256": aggregate,
        "runtimeFingerprintFile": "runtime-fingerprint.json",
        "runtimeStartAttestation": {
            "finalParserSourceMtime": source_mtime,
            "metadataPreparedAfterFinalParserPatch": True,
            "parserSha256": parser_sha256,
        },
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--suite", type=Suite, choices=tuple(Suite), required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument(
        "--campaign-ledger",
        type=Path,
        default=Path(__file__).with_name("fresh_campaign_ledger.json"),
    )
    parser.add_argument("--bridge-port", type=int, required=True)
    parser.add_argument("--supersedes", default="")
    parser.add_argument("--hammer-threads", type=int, default=4)
    parser.add_argument("--bfcl-threads", type=int, default=4)
    parser.add_argument("--stable-group-concurrency", type=int, default=1)
    parser.add_argument("--stable-threads", type=int, default=2)
    parser.add_argument("--tau-domain-workers", type=int, default=2)
    parser.add_argument("--tau-task-concurrency", type=int, default=1)
    parser.add_argument("--tau-request-timeout", type=int, default=960)
    parser.add_argument("--save-prefix", default="prompt-only-20260720")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    suite = Suite(args.suite)
    root = args.repo_root.resolve(strict=True)
    output_root = prepared_root(args.output_root)
    config = PreparationConfig(
        bridge_port=args.bridge_port,
        output_root=output_root,
        started_at=datetime.now().astimezone().isoformat(),
        supersedes=args.supersedes,
        hammer_threads=args.hammer_threads,
        bfcl_threads=args.bfcl_threads,
        stable_group_concurrency=args.stable_group_concurrency,
        stable_threads=args.stable_threads,
        tau_domain_workers=args.tau_domain_workers,
        tau_request_timeout=args.tau_request_timeout,
        tau_task_concurrency=args.tau_task_concurrency,
        save_prefix=args.save_prefix,
    )
    manifest = read_object(output_root / "task-manifest.json")
    fingerprint = read_object(output_root / "runtime-fingerprint.json")
    match suite:
        case Suite.HAMMER:
            metadata = hammer_meta(config, manifest)
        case Suite.BFCL:
            metadata = bfcl_meta(config, manifest)
        case Suite.STABLE:
            metadata = stable_meta(config, manifest)
        case Suite.TAU3:
            metadata = tau3_meta(config, manifest)
        case unreachable:
            assert_never(unreachable)
    metadata = {**metadata, **runtime_identity(root, fingerprint, suite)}
    ledger = read_object(args.campaign_ledger.resolve(strict=True))
    metadata = bind_run_to_campaign(metadata, ledger, output_root)
    binding = campaign_binding(metadata)
    write_prepared_artifacts(output_root, metadata, binding)
    print(
        json.dumps(
            {
                "admission": metadata["totalAdmission"],
                "runId": metadata["runId"],
                "runtimeFingerprintAggregateSha256": metadata[
                    "runtimeFingerprintAggregateSha256"
                ],
                "status": metadata["status"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
