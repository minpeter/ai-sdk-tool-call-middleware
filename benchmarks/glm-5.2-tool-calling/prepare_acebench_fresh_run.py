#!/usr/bin/env python3
"""Create immutable launch metadata for a fresh ACEBench full run."""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
from typing import Any


PINNED_COMMIT = "56dd66cf6439b0d9655ee1b353e4cd745c6f664e"
PINNED_TASK_SET_SHA256 = (
    "3967082cc1ed8e4a532ae290f099947241d6fe12e23e08f10c7109f5d7f01b74"
)
PARSER_PATH = Path("src/core/protocols/glm5-call-parsing.ts")
EXPECTED_RUNNER_PATHS = {
    "benchmarks/glm-5.2-tool-calling/acebench_official_native.py",
    "benchmarks/glm-5.2-tool-calling/acebench_one_row_preflight.py",
    "benchmarks/glm-5.2-tool-calling/build_acebench_full_manifest.py",
    "benchmarks/glm-5.2-tool-calling/launch_acebench_fresh_v3.sh",
    "benchmarks/glm-5.2-tool-calling/prepare_acebench_fresh_run.py",
}


def now() -> str:
    return datetime.now().astimezone().isoformat()


def read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected an object")
    return value


def write_exclusive(path: Path, value: dict[str, Any]) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=True, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def runtime_identity(
    repo: Path, fingerprint: dict[str, Any]
) -> dict[str, Any]:
    runtime = fingerprint.get("runtimeFingerprint")
    if not isinstance(runtime, dict):
        raise RuntimeError("runtime fingerprint is missing")
    aggregate = runtime.get("aggregateSha256")
    if not isinstance(aggregate, str) or len(aggregate) != 64:
        raise RuntimeError("runtime fingerprint aggregate is invalid")
    files = runtime.get("files")
    if not isinstance(files, dict):
        raise RuntimeError("runtime fingerprint file roles are missing")
    parser_records = files.get("parser")
    runner_records = files.get("runner")
    if not isinstance(parser_records, list) or not isinstance(runner_records, list):
        raise RuntimeError("runtime parser or runner records are missing")
    parser_sha256 = hashlib.sha256((repo / PARSER_PATH).read_bytes()).hexdigest()
    matching_parser = [
        record
        for record in parser_records
        if isinstance(record, dict) and record.get("path") == PARSER_PATH.as_posix()
    ]
    if len(matching_parser) != 1 or matching_parser[0].get("sha256") != parser_sha256:
        raise RuntimeError("runtime fingerprint does not attest the final parser")
    runner_paths = {
        str(record.get("path")) for record in runner_records if isinstance(record, dict)
    }
    if runner_paths != EXPECTED_RUNNER_PATHS:
        raise RuntimeError("runtime fingerprint runner set is incomplete or unexpected")
    return {
        "runtimeFingerprintAggregateSha256": aggregate,
        "runtimeFingerprintFile": "runtime-fingerprint.json",
        "runtimeStartAttestation": {
            "finalParserSourceMtime": datetime.fromtimestamp(
                (repo / PARSER_PATH).stat().st_mtime,
                tz=datetime.now().astimezone().tzinfo,
            ).isoformat(),
            "parserSha256": parser_sha256,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--implementation-fingerprint", required=True)
    parser.add_argument("--bridge-port", type=int, default=18861)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()

    repo = args.repo_root.resolve()
    output_root = args.output_root.resolve()
    if not output_root.is_dir() or output_root.is_symlink():
        raise RuntimeError("ACEBench output root must be a new real directory")
    expected_entries = {"task-manifest.json", "runtime-fingerprint.json"}
    actual_entries = {path.name for path in output_root.iterdir()}
    if actual_entries != expected_entries:
        raise RuntimeError(
            "ACEBench output root must contain only its fresh manifest and fingerprint"
        )
    if args.threads != 2:
        raise RuntimeError("stable ACEBench admission is pinned to two threads per lane")
    if len(args.implementation_fingerprint) != 64 or any(
        char not in "0123456789abcdef"
        for char in args.implementation_fingerprint
    ):
        raise RuntimeError("implementation fingerprint is invalid")

    manifest = read_object(output_root / "task-manifest.json")
    if (
        manifest.get("commit") != PINNED_COMMIT
        or manifest.get("rowCount") != 2040
        or manifest.get("languageCounts") != {"en": 1023, "zh": 1017}
        or manifest.get("taskSetSha256") != PINNED_TASK_SET_SHA256
    ):
        raise RuntimeError("ACEBench manifest is not the pinned full population")
    fingerprint = read_object(output_root / "runtime-fingerprint.json")
    identity = runtime_identity(repo, fingerprint)
    metadata = {
        **identity,
        "adapter": "acebench_official_native.py",
        "arms": ["glm52-native-FC", "glm52-prompt-only-FC"],
        "assistantModel": "zai-org/glm-5.2",
        "benchmark": "ACEBench native-tool full-population adaptation",
        "benchmarkCommit": PINNED_COMMIT,
        "bridgePort": args.bridge_port,
        "bridgeSuite": output_root.name,
        "categoriesPerLanguage": 17,
        "comparability": (
            "Pinned ACEBench data, official user simulator, executable environments, "
            "result layout, and official scorer contract are retained; only the "
            "assistant call representation is adapted to native tools."
        ),
        "createdAt": now(),
        "expectedFreshRows": 4080,
        "freshness": {
            "historicalRawInput": False,
            "historicalResultInput": False,
            "historicalScoreInput": False,
            "outputRootAbsentBeforeCreation": True,
            "preseed": False,
            "resumeFromPriorRun": False,
            "supersededRunsExcluded": [
                "2026-07-18-acebench-full-2040-fresh-v1",
                "2026-07-18-acebench-full-2040-fresh-v2",
            ],
        },
        "fullLaunchAuthorizationMode": "ACEBENCH_FULL_LAUNCH=YES",
        "globalAdmissionCeiling": 128,
        "implementationFingerprint": args.implementation_fingerprint,
        "includedInFinalScore": False,
        "languageCounts": {"en": 1023, "zh": 1017},
        "populationContribution": 0,
        "populationPerArm": 2040,
        "preflightAdmission": 1,
        "providerMaxTokens": {
            "assistant": 16_384,
            "userSimulator": 16_384,
        },
        "providerTransientRetries": 4,
        "runId": output_root.name,
        "scoreDisclosure": "locked-until-4080-fresh-rows-and-official-validation",
        "stableAdmission": {
            "arms": 2,
            "languages": 2,
            "threadsPerArmLanguage": args.threads,
            "total": 2 * 2 * args.threads,
        },
        "status": "prepared-one-row-preflight-pending",
        "taskSetSha256": PINNED_TASK_SET_SHA256,
        "temperature": 0.001,
        "topP": 1,
        "transport": "generate via captured loopback OpenAI bridge",
        "userSimulatorModelAlias": "glm52-simulator",
    }
    write_exclusive(output_root / "run-meta.json", metadata)
    print(
        json.dumps(
            {
                "admission": metadata["stableAdmission"]["total"],
                "parserSha256": metadata["runtimeStartAttestation"]["parserSha256"],
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
