#!/usr/bin/env python3
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, tzinfo
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
from typing import Any


ARMS = {
    "native": {
        "agent": "openai_bridge_native",
        "arm": "native",
        "model": "glm52-native",
    },
    "glm5": {
        "agent": "openai_bridge_glm5",
        "arm": "glm5",
        "model": "glm52-prompt-only",
    },
}
EXPECTED_DOMAIN_COUNTS = {
    "airline": 50,
    "retail": 114,
    "telecom": 114,
    "banking_knowledge": 97,
}
EXPECTED_TASKS = sum(EXPECTED_DOMAIN_COUNTS.values())
EXPECTED_TIMEOUT_SECONDS = 960
PINNED_COMMIT = "a1e85084a3960281cb06997594133e8f39ea42a7"
PARSER_PATH = "src/core/protocols/glm5-call-parsing.ts"
RUNTIME_ROLES = ("parser", "bridge", "runner")
SAVE_COMPONENT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
GIT_HEAD_RE = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
CONTROL_CHARACTER_RE = re.compile(r"[\x00-\x1f\x7f]")


def read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected an object")
    return value


def canonical_json_bytes(value: object, *, ensure_ascii: bool) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=ensure_ascii,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def sha256_json(value: object, *, ensure_ascii: bool = False) -> str:
    return hashlib.sha256(
        canonical_json_bytes(value, ensure_ascii=ensure_ascii)
    ).hexdigest()


def sha256_file(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    byte_length = 0
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            byte_length += len(chunk)
            digest.update(chunk)
    return byte_length, digest.hexdigest()


def save_component(value: str) -> str:
    if SAVE_COMPONENT_RE.fullmatch(value) is None:
        raise argparse.ArgumentTypeError(
            "must be one path-safe component containing letters, digits, '.', '_', or '-'"
        )
    return value


def parse_timestamp(
    value: object, *, label: str, default_timezone: tzinfo | None = None
) -> datetime:
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"{label}: timestamp missing")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise RuntimeError(f"{label}: invalid timestamp") from error
    if parsed.tzinfo is None:
        if default_timezone is None:
            raise RuntimeError(f"{label}: timezone missing")
        parsed = parsed.replace(tzinfo=default_timezone)
    return parsed


def validate_timestamp_not_before(
    value: object, *, label: str, started_at: datetime
) -> datetime:
    parsed = parse_timestamp(value, label=label, default_timezone=started_at.tzinfo)
    if parsed < started_at:
        raise RuntimeError(f"{label}: timestamp predates run start")
    return parsed


def validate_manifest(
    manifest: dict[str, Any],
) -> dict[str, dict[str, str]]:
    expected_fields = {
        "benchmark": "tau3-bench",
        "commit": PINNED_COMMIT,
        "domainCounts": EXPECTED_DOMAIN_COUNTS,
        "formatVersion": 1,
        "population": "text-half-duplex-base",
        "taskCount": EXPECTED_TASKS,
    }
    for field, expected in expected_fields.items():
        if manifest.get(field) != expected:
            raise RuntimeError(f"tau3 manifest drift: {field}")

    tasks = manifest.get("tasks")
    if not isinstance(tasks, list) or len(tasks) != EXPECTED_TASKS:
        raise RuntimeError("tau3 manifest task rows missing")
    expected_by_domain: dict[str, dict[str, str]] = {
        domain: {} for domain in EXPECTED_DOMAIN_COUNTS
    }
    for task in tasks:
        if not isinstance(task, dict):
            raise RuntimeError("invalid manifest task row")
        domain = task.get("domain")
        task_id = task.get("id")
        row_sha256 = task.get("rowSha256")
        if domain not in EXPECTED_DOMAIN_COUNTS:
            raise RuntimeError("tau3 manifest task domain drift")
        if not isinstance(task_id, str) or not task_id:
            raise RuntimeError("tau3 manifest task ID invalid")
        if not isinstance(row_sha256, str) or SHA256_RE.fullmatch(row_sha256) is None:
            raise RuntimeError("tau3 manifest task provenance hash invalid")
        if task_id in expected_by_domain[domain]:
            raise RuntimeError("tau3 manifest contains duplicate domain/task IDs")
        expected_by_domain[domain][task_id] = row_sha256

    actual_counts = {domain: len(rows) for domain, rows in expected_by_domain.items()}
    if actual_counts != EXPECTED_DOMAIN_COUNTS:
        raise RuntimeError("tau3 manifest domain membership drift")

    stable = {
        field: manifest[field]
        for field in (
            "benchmark",
            "commit",
            "domainCounts",
            "formatVersion",
            "population",
            "taskCount",
            "tasks",
        )
    }
    expected_task_set_sha256 = sha256_json(stable)
    if manifest.get("taskSetSha256") != expected_task_set_sha256:
        raise RuntimeError("tau3 manifest task-set hash drift")
    return expected_by_domain


def validate_run_meta(
    run_meta: dict[str, Any],
    manifest: dict[str, Any],
    expected_save_prefix: str,
) -> datetime:
    if run_meta.get("status") != "inference-complete":
        raise RuntimeError("tau3 run is not inference-complete")
    expected_fields = {
        "assistantModel": "zai-org/glm-5.2",
        "benchmarkCommit": PINNED_COMMIT,
        "domainCounts": EXPECTED_DOMAIN_COUNTS,
        "maxRetries": 0,
        "numTrials": 1,
        "populationPerArm": EXPECTED_TASKS,
        "requestTimeoutSeconds": EXPECTED_TIMEOUT_SECONDS,
        "savePrefix": expected_save_prefix,
        "seed": 52,
        "taskCountPerArm": EXPECTED_TASKS,
        "taskSetSha256": manifest.get("taskSetSha256"),
    }
    for field, expected in expected_fields.items():
        if run_meta.get(field) != expected:
            raise RuntimeError(f"tau3 run metadata drift: {field}")

    expected_admission = {"globalCeiling": 4, "tau3": 4, "total": 4}
    if run_meta.get("campaignAdmissionContract") != expected_admission:
        raise RuntimeError("tau3 campaign admission contract drift")
    expected_concurrency = {
        "armsPerDomain": 2,
        "domainScheduling": "bounded-dynamic-slots",
        "domainWorkers": 2,
        "globalAdmissionCeiling": 4,
        "maxConcurrentChildRuns": 4,
        "maxConcurrentSimulationTasks": 4,
        "taskConcurrencyPerRun": 1,
    }
    if run_meta.get("tau3Concurrency") != expected_concurrency:
        raise RuntimeError("tau3 active concurrency contract drift")

    started_at = parse_timestamp(run_meta.get("startedAt"), label="run startedAt")
    completed_at = validate_timestamp_not_before(
        run_meta.get("completedAt"), label="run completedAt", started_at=started_at
    )
    if completed_at < started_at:
        raise RuntimeError("tau3 run completion predates start")

    freshness = run_meta.get("freshness")
    if not isinstance(freshness, dict):
        raise RuntimeError("tau3 freshness metadata missing")
    if freshness.get("outputRootAbsentBeforeCreation") is not True:
        raise RuntimeError("tau3 empty-output freshness proof missing")
    for key in (
        "preseed",
        "historicalRawInput",
        "historicalScoreInput",
        "resumeFromPriorRun",
    ):
        if freshness.get(key) is not False:
            raise RuntimeError(f"tau3 freshness flag invalid: {key}")

    retry_policy = run_meta.get("bridgeTransientRetryPolicy")
    if not isinstance(retry_policy, dict):
        raise RuntimeError("tau3 bridge retry policy missing")
    expected_retry_policy = {
        "additionalAttempts": 2,
        "delayMs": 5_000,
        "timeoutMsPerAttempt": 180_000,
        "validatorRequiresRecoveredByteIdenticalRequest": True,
    }
    for field, expected in expected_retry_policy.items():
        if retry_policy.get(field) != expected:
            raise RuntimeError(f"tau3 bridge retry policy drift: {field}")
    if run_meta.get("providerTransientRetries") != retry_policy["additionalAttempts"]:
        raise RuntimeError("tau3 provider retry count drift")
    attempts = retry_policy["additionalAttempts"] + 1
    retry_window_ms = (
        attempts * retry_policy["timeoutMsPerAttempt"]
        + retry_policy["additionalAttempts"] * retry_policy["delayMs"]
    )
    if retry_window_ms > EXPECTED_TIMEOUT_SECONDS * 1_000:
        raise RuntimeError("tau3 retry window exceeds the request timeout")
    return started_at


def validate_hash_record_shape(record: object, *, label: str) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise RuntimeError(f"{label}: runtime file record missing")
    if set(record) != {"byteLength", "path", "sha256"}:
        raise RuntimeError(f"{label}: runtime file record shape drift")
    byte_length = record.get("byteLength")
    path = record.get("path")
    sha256 = record.get("sha256")
    if (
        isinstance(byte_length, bool)
        or not isinstance(byte_length, int)
        or byte_length < 0
    ):
        raise RuntimeError(f"{label}: runtime file byte length invalid")
    if not isinstance(path, str) or not path:
        raise RuntimeError(f"{label}: runtime file path invalid")
    if not isinstance(sha256, str) or SHA256_RE.fullmatch(sha256) is None:
        raise RuntimeError(f"{label}: runtime file hash invalid")
    return record


def validate_repo_file_record(record: object, *, label: str, repo_root: Path) -> str:
    value = validate_hash_record_shape(record, label=label)
    path_value = value["path"]
    pure = PurePosixPath(path_value)
    if (
        pure.is_absolute()
        or pure.as_posix() != path_value
        or any(part in ("", ".", "..") for part in pure.parts)
        or CONTROL_CHARACTER_RE.search(path_value)
    ):
        raise RuntimeError(f"{label}: unsafe repository-relative runtime path")
    try:
        resolved = (repo_root / Path(*pure.parts)).resolve(strict=True)
        resolved.relative_to(repo_root)
    except (OSError, ValueError) as error:
        raise RuntimeError(f"{label}: runtime path escapes the repository") from error
    if not resolved.is_file():
        raise RuntimeError(f"{label}: runtime path is not a regular file")
    byte_length, sha256 = sha256_file(resolved)
    if byte_length != value["byteLength"] or sha256 != value["sha256"]:
        raise RuntimeError(f"{label}: runtime file hash drift")
    return path_value


def validate_runtime_fingerprint(
    *,
    run_root: Path,
    repo_root: Path,
    run_meta: dict[str, Any],
    started_at: datetime,
) -> str:
    if run_meta.get("runtimeFingerprintFile") != "runtime-fingerprint.json":
        raise RuntimeError("tau3 runtime fingerprint filename drift")
    fingerprint = read_object(run_root / "runtime-fingerprint.json")
    if set(fingerprint) != {"runtimeFingerprint"}:
        raise RuntimeError("tau3 runtime fingerprint envelope drift")
    runtime = fingerprint.get("runtimeFingerprint")
    if not isinstance(runtime, dict):
        raise RuntimeError("tau3 runtime fingerprint object missing")
    expected_keys = {
        "aggregateSha256",
        "files",
        "git",
        "loader",
        "node",
        "schemaVersion",
    }
    if set(runtime) != expected_keys:
        raise RuntimeError("tau3 runtime fingerprint shape drift")
    aggregate = runtime.get("aggregateSha256")
    if not isinstance(aggregate, str) or SHA256_RE.fullmatch(aggregate) is None:
        raise RuntimeError("tau3 runtime fingerprint aggregate invalid")
    material = {key: runtime[key] for key in expected_keys - {"aggregateSha256"}}
    recomputed = sha256_json(material, ensure_ascii=True)
    if aggregate != recomputed:
        raise RuntimeError("tau3 runtime fingerprint aggregate drift")
    if run_meta.get("runtimeFingerprintAggregateSha256") != aggregate:
        raise RuntimeError("tau3 run metadata fingerprint mismatch")

    if runtime.get("schemaVersion") != 1:
        raise RuntimeError("tau3 runtime fingerprint schema drift")
    git = runtime.get("git")
    if (
        not isinstance(git, dict)
        or set(git) != {"head"}
        or not isinstance(git.get("head"), str)
        or GIT_HEAD_RE.fullmatch(git["head"]) is None
    ):
        raise RuntimeError("tau3 runtime fingerprint git identity invalid")

    files = runtime.get("files")
    if not isinstance(files, dict) or set(files) != set(RUNTIME_ROLES):
        raise RuntimeError("tau3 runtime fingerprint role set drift")
    selected_paths: list[str] = []
    parser_records: list[dict[str, Any]] = []
    for role in RUNTIME_ROLES:
        records = files.get(role)
        if not isinstance(records, list) or not records:
            raise RuntimeError(f"tau3 runtime fingerprint {role} records missing")
        previous_path: str | None = None
        for index, record in enumerate(records):
            path_value = validate_repo_file_record(
                record,
                label=f"runtime {role}[{index}]",
                repo_root=repo_root,
            )
            if previous_path is not None and path_value <= previous_path:
                raise RuntimeError(f"tau3 runtime fingerprint {role} ordering drift")
            previous_path = path_value
            selected_paths.append(path_value)
            if role == "parser" and isinstance(record, dict):
                parser_records.append(record)

    loader_path = validate_repo_file_record(
        runtime.get("loader"), label="runtime loader", repo_root=repo_root
    )
    selected_paths.append(loader_path)
    if len(selected_paths) != len(set(selected_paths)):
        raise RuntimeError("tau3 runtime fingerprint contains duplicate files")

    node = runtime.get("node")
    if not isinstance(node, dict) or set(node) != {
        "byteLength",
        "path",
        "sha256",
        "version",
    }:
        raise RuntimeError("tau3 runtime node record shape drift")
    validate_hash_record_shape(
        {key: node[key] for key in ("byteLength", "path", "sha256")},
        label="runtime node",
    )
    if not str(node["path"]).startswith("<external>/"):
        raise RuntimeError("tau3 runtime node path is not sanitized")
    if not isinstance(node.get("version"), str) or not node["version"].startswith("v"):
        raise RuntimeError("tau3 runtime node version invalid")

    matching_parser_records = [
        record for record in parser_records if record.get("path") == PARSER_PATH
    ]
    if len(matching_parser_records) != 1:
        raise RuntimeError("tau3 final parser is absent from runtime fingerprint")
    parser_sha256 = matching_parser_records[0].get("sha256")
    attestation = run_meta.get("runtimeStartAttestation")
    if not isinstance(attestation, dict):
        raise RuntimeError("tau3 parser start attestation missing")
    if attestation.get("metadataPreparedAfterFinalParserPatch") is not True:
        raise RuntimeError("tau3 parser start attestation is not final")
    if attestation.get("parserSha256") != parser_sha256:
        raise RuntimeError("tau3 parser attestation hash drift")
    parser_mtime = parse_timestamp(
        attestation.get("finalParserSourceMtime"),
        label="runtime parser source mtime",
        default_timezone=started_at.tzinfo,
    )
    if parser_mtime > started_at:
        raise RuntimeError("tau3 parser source mtime follows run start")
    return aggregate


def percentile(values: list[int], quantile: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * quantile) - 1)]


def validate_row(
    row: dict[str, Any],
    *,
    domain: str,
    suffix: str,
    expected_id: str,
    started_at: datetime,
) -> dict[str, Any]:
    task_id = row.get("task_id")
    if not isinstance(task_id, str) or task_id != expected_id:
        raise RuntimeError(f"{domain}/{suffix}: task identity mismatch")
    termination_reason = row.get("termination_reason")
    if not isinstance(termination_reason, str) or not termination_reason:
        raise RuntimeError(f"{domain}/{suffix}/{task_id}: termination reason missing")
    if termination_reason == "infrastructure_error":
        raise RuntimeError(f"{domain}/{suffix}/{task_id}: infrastructure_error")
    info = row.get("info")
    if (
        isinstance(info, dict)
        and "error" in info
        and info.get("error") not in (None, "")
    ):
        raise RuntimeError(f"{domain}/{suffix}/{task_id}: retained error info")
    reward_info = row.get("reward_info")
    if not isinstance(reward_info, dict):
        raise RuntimeError(f"{domain}/{suffix}/{task_id}: reward_info missing")
    reward = reward_info.get("reward")
    if (
        isinstance(reward, bool)
        or not isinstance(reward, (int, float))
        or not math.isfinite(float(reward))
        or not 0 <= reward <= 1
    ):
        raise RuntimeError(f"{domain}/{suffix}/{task_id}: invalid reward")

    row_timestamp = validate_timestamp_not_before(
        row.get("timestamp"),
        label=f"{domain}/{suffix}/{task_id} timestamp",
        started_at=started_at,
    )
    row_start = validate_timestamp_not_before(
        row.get("start_time"),
        label=f"{domain}/{suffix}/{task_id} start_time",
        started_at=started_at,
    )
    row_end = validate_timestamp_not_before(
        row.get("end_time"),
        label=f"{domain}/{suffix}/{task_id} end_time",
        started_at=started_at,
    )
    if row_end < row_start or row_timestamp < row_start:
        raise RuntimeError(f"{domain}/{suffix}/{task_id}: timestamp ordering drift")

    seed = row.get("seed")
    trial = row.get("trial")
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise RuntimeError(f"{domain}/{suffix}/{task_id}: row seed missing")
    if trial != 0:
        raise RuntimeError(f"{domain}/{suffix}/{task_id}: row trial drift")

    messages = row.get("messages")
    if not isinstance(messages, list) or not messages:
        raise RuntimeError(f"{domain}/{suffix}/{task_id}: messages missing")
    assistant_messages = [
        message
        for message in messages
        if isinstance(message, dict) and message.get("role") == "assistant"
    ]
    identity_messages = [
        message
        for message in assistant_messages
        if isinstance(message.get("raw_data"), dict)
        and ("arm" in message["raw_data"] or "model" in message["raw_data"])
    ]
    if not identity_messages:
        raise RuntimeError(f"{domain}/{suffix}/{task_id}: assistant identity missing")
    expected = ARMS[suffix]
    tool_calls = 0
    for message in identity_messages:
        raw_data = message["raw_data"]
        if (
            raw_data.get("arm") != expected["arm"]
            or raw_data.get("model") != expected["model"]
        ):
            raise RuntimeError(
                f"{domain}/{suffix}/{task_id}: model-under-test identity drift"
            )
    for message in assistant_messages:
        calls = message.get("tool_calls")
        if calls is None:
            continue
        if not isinstance(calls, list):
            raise RuntimeError(f"{domain}/{suffix}/{task_id}: tool_calls invalid")
        tool_calls += len(calls)
    return {
        "domain": domain,
        "messages": len(messages),
        "reward": float(reward),
        "seed": seed,
        "taskId": task_id,
        "terminationReason": termination_reason,
        "toolCalls": tool_calls,
        "trial": trial,
    }


def validate_results_info(
    value: dict[str, Any], *, domain: str, suffix: str, started_at: datetime
) -> None:
    validate_timestamp_not_before(
        value.get("timestamp"),
        label=f"{domain}/{suffix} results timestamp",
        started_at=started_at,
    )
    info = value.get("info")
    if not isinstance(info, dict):
        raise RuntimeError(f"{domain}/{suffix}: Results.info missing")
    if info.get("git_commit") != PINNED_COMMIT:
        raise RuntimeError(f"{domain}/{suffix}: Results.info commit drift")
    if info.get("num_trials") != 1 or info.get("seed") != 52:
        raise RuntimeError(f"{domain}/{suffix}: Results.info seed/trial drift")
    environment_info = info.get("environment_info")
    if (
        not isinstance(environment_info, dict)
        or environment_info.get("domain_name") != domain
    ):
        raise RuntimeError(f"{domain}/{suffix}: Results.info domain drift")

    agent_info = info.get("agent_info")
    if not isinstance(agent_info, dict):
        raise RuntimeError(f"{domain}/{suffix}: Results.info agent missing")
    if (
        agent_info.get("implementation") != ARMS[suffix]["agent"]
        or agent_info.get("llm") != "zai-org/glm-5.2"
    ):
        raise RuntimeError(f"{domain}/{suffix}: Results.info agent/model drift")
    agent_args = agent_info.get("llm_args")
    if (
        not isinstance(agent_args, dict)
        or agent_args.get("timeout_seconds") != EXPECTED_TIMEOUT_SECONDS
    ):
        raise RuntimeError(f"{domain}/{suffix}: Results.info timeout drift")

    user_info = info.get("user_info")
    if not isinstance(user_info, dict):
        raise RuntimeError(f"{domain}/{suffix}: Results.info user missing")
    user_args = user_info.get("llm_args")
    if (
        user_info.get("implementation") != "user_simulator"
        or user_info.get("llm") != "openai/zai-org/glm-5.2"
        or not isinstance(user_args, dict)
        or user_args.get("seed") != 52
        or user_args.get("temperature") != 0
    ):
        raise RuntimeError(f"{domain}/{suffix}: Results.info user contract drift")

    expected_retrieval = "golden_retrieval" if domain == "banking_knowledge" else None
    if info.get("retrieval_config") != expected_retrieval:
        raise RuntimeError(f"{domain}/{suffix}: Results.info retrieval drift")


def validate_task_provenance(
    value: dict[str, Any],
    *,
    domain: str,
    suffix: str,
    expected_tasks: dict[str, str],
) -> None:
    tasks = value.get("tasks")
    if not isinstance(tasks, list) or len(tasks) != len(expected_tasks):
        raise RuntimeError(f"{domain}/{suffix}: embedded task inventory mismatch")
    observed: dict[str, dict[str, Any]] = {}
    for task in tasks:
        if not isinstance(task, dict):
            raise RuntimeError(f"{domain}/{suffix}: embedded task row invalid")
        task_id = task.get("id")
        if not isinstance(task_id, str) or not task_id or task_id in observed:
            raise RuntimeError(f"{domain}/{suffix}: embedded task identity invalid")
        observed[task_id] = task
    if set(observed) != set(expected_tasks):
        raise RuntimeError(f"{domain}/{suffix}: embedded task coverage mismatch")
    for task_id, expected_sha256 in expected_tasks.items():
        if sha256_json(observed[task_id]) != expected_sha256:
            raise RuntimeError(
                f"{domain}/{suffix}/{task_id}: embedded task provenance drift"
            )


def arm_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    rewards = [float(row["reward"]) for row in rows]
    messages = [int(row["messages"]) for row in rows]
    tool_calls = [int(row["toolCalls"]) for row in rows]
    return {
        "meanReward": sum(rewards) / len(rewards),
        "messageMax": max(messages),
        "messageP50": percentile(messages, 0.5),
        "messageP95": percentile(messages, 0.95),
        "passed": sum(reward == 1 for reward in rewards),
        "rewardDistribution": {
            str(reward): count for reward, count in sorted(Counter(rewards).items())
        },
        "tasks": len(rows),
        "terminationReasons": dict(
            sorted(Counter(str(row["terminationReason"]) for row in rows).items())
        ),
        "toolCallMax": max(tool_calls),
        "toolCallP50": percentile(tool_calls, 0.5),
        "toolCallP95": percentile(tool_calls, 0.95),
        "totalMessages": sum(messages),
        "totalToolCalls": sum(tool_calls),
    }


def paired_summary(rows_by_arm: dict[str, list[dict[str, Any]]]) -> dict[str, int]:
    indexed = {
        suffix: {(str(row["domain"]), str(row["taskId"])): row for row in rows}
        for suffix, rows in rows_by_arm.items()
    }
    if set(indexed["native"]) != set(indexed["glm5"]):
        raise RuntimeError("paired task keys differ")
    both_pass = native_only = plus_only = both_fail = 0
    for key in indexed["native"]:
        native = float(indexed["native"][key]["reward"]) == 1
        plus = float(indexed["glm5"][key]["reward"]) == 1
        if native and plus:
            both_pass += 1
        elif native:
            native_only += 1
        elif plus:
            plus_only += 1
        else:
            both_fail += 1
        if (
            indexed["native"][key]["seed"] != indexed["glm5"][key]["seed"]
            or indexed["native"][key]["trial"] != indexed["glm5"][key]["trial"]
        ):
            raise RuntimeError(f"paired seed/trial drift: {key}")
    return {
        "bothFail": both_fail,
        "bothPass": both_pass,
        "nativeOnlyPass": native_only,
        "nativePlusOnlyPass": plus_only,
        "netNativePlus": plus_only - native_only,
    }


def write_json_exclusive(path: Path, value: object) -> None:
    if not path.parent.is_dir():
        raise RuntimeError("validation output parent directory does not exist")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags, 0o600)
    except FileExistsError as error:
        raise RuntimeError(f"refusing existing validation output: {path}") from error
    except OSError as error:
        raise RuntimeError("validation output could not be created") from error
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--expected-save-prefix", type=save_component, required=True)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help="repository root used to verify runtime fingerprint file hashes",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    requested_out = args.out.absolute()
    if requested_out.exists() or requested_out.is_symlink():
        raise RuntimeError(f"refusing existing validation output: {requested_out}")
    out = requested_out.resolve()

    manifest = read_object(args.manifest.resolve(strict=True))
    expected_by_domain = validate_manifest(manifest)
    run_root = args.run_root.resolve(strict=True)
    if not run_root.is_dir():
        raise RuntimeError("tau3 run root is not a directory")
    repo_root = args.repo_root.resolve(strict=True)
    if not repo_root.is_dir():
        raise RuntimeError("repository root is not a directory")

    run_meta = read_object(run_root / "run-meta.json")
    started_at = validate_run_meta(run_meta, manifest, args.expected_save_prefix)
    runtime_aggregate = validate_runtime_fingerprint(
        run_root=run_root,
        repo_root=repo_root,
        run_meta=run_meta,
        started_at=started_at,
    )

    simulations_root = run_root / "data/simulations"
    if not simulations_root.is_dir() or simulations_root.is_symlink():
        raise RuntimeError("tau3 simulations root missing or unsafe")
    expected_directories = {
        f"{args.expected_save_prefix}-{domain}-{suffix}"
        for domain in expected_by_domain
        for suffix in ARMS
    }
    entries = list(simulations_root.iterdir())
    observed_directories = {
        path.name for path in entries if path.is_dir() and not path.is_symlink()
    }
    if (
        len(entries) != len(expected_directories)
        or observed_directories != expected_directories
    ):
        raise RuntimeError("tau3 output directory set mismatch")

    rows_by_arm: dict[str, list[dict[str, Any]]] = {suffix: [] for suffix in ARMS}
    for domain, expected_tasks in expected_by_domain.items():
        expected_ids = set(expected_tasks)
        for suffix in ARMS:
            path = (
                simulations_root
                / f"{args.expected_save_prefix}-{domain}-{suffix}"
                / "results.json"
            )
            value = read_object(path)
            validate_results_info(
                value, domain=domain, suffix=suffix, started_at=started_at
            )
            validate_task_provenance(
                value,
                domain=domain,
                suffix=suffix,
                expected_tasks=expected_tasks,
            )
            simulations = value.get("simulations")
            if not isinstance(simulations, list) or len(simulations) != len(
                expected_ids
            ):
                raise RuntimeError(f"{domain}/{suffix}: exact row count mismatch")
            by_id: dict[str, dict[str, Any]] = {}
            for row in simulations:
                if not isinstance(row, dict):
                    raise RuntimeError(f"{domain}/{suffix}: invalid simulation row")
                task_id = row.get("task_id")
                if not isinstance(task_id, str) or task_id in by_id:
                    raise RuntimeError(
                        f"{domain}/{suffix}: duplicate or invalid task ID"
                    )
                by_id[task_id] = row
            if set(by_id) != expected_ids:
                raise RuntimeError(f"{domain}/{suffix}: exact task coverage mismatch")
            for task_id in sorted(expected_ids):
                rows_by_arm[suffix].append(
                    validate_row(
                        by_id[task_id],
                        domain=domain,
                        suffix=suffix,
                        expected_id=task_id,
                        started_at=started_at,
                    )
                )
    if any(len(rows) != EXPECTED_TASKS for rows in rows_by_arm.values()):
        raise RuntimeError("tau3 arm denominator mismatch")

    output = {
        "arms": {
            ARMS[suffix]["model"]: arm_summary(rows)
            for suffix, rows in rows_by_arm.items()
        },
        "benchmark": "tau3-bench text half-duplex",
        "complete": True,
        "paired": paired_summary(rows_by_arm),
        "population": "full pinned base split",
        "runtimeFingerprintAggregateSha256": runtime_aggregate,
        "savePrefix": args.expected_save_prefix,
        "status": "valid",
        "taskCountPerArm": EXPECTED_TASKS,
        "taskSetSha256": manifest.get("taskSetSha256"),
    }
    write_json_exclusive(out, output)
    print(json.dumps(output, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
