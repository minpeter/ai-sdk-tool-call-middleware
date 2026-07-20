#!/usr/bin/env python3
"""Validate integrity invariants for an MCPMark Filesystem run.

Official-verifier failures are benchmark outcomes, not integrity errors.  In
contrast, an incomplete job grid, malformed records, infrastructure failures,
schema drift, a stale output digest, or a possible credential in the artifacts
make the run unsuitable for reporting and result in a non-zero exit status.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


ALLOWED_FAILURE_STAGES = {
    "attempt_timeout",
    "mcp",
    "parser",
    "provider",
    "setup",
    "turn_limit",
    "verification",
}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SECRET_PATTERNS = {
    "freerouter_style_key": re.compile(
        r"(?<![A-Za-z0-9])fr-[A-Za-z0-9][A-Za-z0-9._-]{7,}"
    ),
    "openai_style_key": re.compile(
        r"(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{12,}"
    ),
    "bearer_credential": re.compile(
        r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}"
    ),
    "credential_json_field": re.compile(
        r'''(?i)"(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret)"\s*:\s*"[^"\r\n]{4,}"'''
    ),
    "private_key_pem": re.compile(
        r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"
    ),
    "github_token": re.compile(r"\bgh[opusr]_[A-Za-z0-9]{20,}\b"),
}


@dataclass
class IntegrityReport:
    errors: list[dict[str, Any]] = field(default_factory=list)
    counts: Counter[str] = field(default_factory=Counter)

    def add(self, kind: str, message: str, **context: Any) -> None:
        self.counts[kind] += 1
        # Values from untrusted result fields are deliberately never included.
        # Row/attempt/turn positions are safe and make diagnostics actionable.
        item: dict[str, Any] = {"kind": kind, "message": message}
        item.update(context)
        if len(self.errors) < 100:
            self.errors.append(item)


def is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def is_nonnegative_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and value >= 0
    )


def is_sha256(value: Any) -> bool:
    return isinstance(value, str) and bool(SHA256_RE.fullmatch(value))


def read_json(path: Path, integrity: IntegrityReport) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        integrity.add("meta_parse", "run metadata is not readable JSON")
        return {}
    if not isinstance(value, dict):
        integrity.add("meta_schema", "run metadata root must be an object")
        return {}
    return value


def read_jsonl(path: Path, integrity: IntegrityReport) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        integrity.add("raw_parse", "raw JSONL is not readable UTF-8")
        return rows
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            integrity.add(
                "raw_parse",
                "raw JSONL line is not valid JSON",
                row=line_number,
            )
            continue
        if not isinstance(value, dict):
            integrity.add(
                "row_schema",
                "raw JSONL row must be an object",
                row=line_number,
            )
            continue
        rows.append(value)
    return rows


def scan_secrets(paths: list[Path]) -> dict[str, Any]:
    by_pattern: Counter[str] = Counter()
    by_source: Counter[str] = Counter()
    locations: list[dict[str, Any]] = []
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        source = path.name
        for pattern_name, pattern in SECRET_PATTERNS.items():
            for match in pattern.finditer(text):
                by_pattern[pattern_name] += 1
                by_source[source] += 1
                if len(locations) < 50:
                    locations.append(
                        {
                            "source": source,
                            "line": text.count("\n", 0, match.start()) + 1,
                            "pattern": pattern_name,
                        }
                    )
    return {
        "matches": sum(by_pattern.values()),
        "byPattern": dict(sorted(by_pattern.items())),
        "bySource": dict(sorted(by_source.items())),
        # Locations contain only file names, line numbers, and pattern labels.
        "locations": locations,
    }


def parse_meta_grid(
    meta: dict[str, Any], integrity: IntegrityReport
) -> tuple[list[str], list[tuple[str, str]], int, set[tuple[str, str, int]]]:
    arms_value = meta.get("arms")
    arms: list[str] = []
    if not isinstance(arms_value, list) or not arms_value:
        integrity.add("meta_schema", "arms must be a non-empty array")
    else:
        for index, item in enumerate(arms_value):
            if (
                not isinstance(item, dict)
                or not isinstance(item.get("id"), str)
                or not item["id"]
            ):
                integrity.add(
                    "meta_schema",
                    "each arm must have a non-empty string id",
                    armIndex=index,
                )
                continue
            arms.append(item["id"])
    if len(arms) != len(set(arms)):
        integrity.add("meta_schema", "arm ids must be unique")

    tasks_value = meta.get("tasks")
    tasks: list[tuple[str, str]] = []
    if not isinstance(tasks_value, list) or not tasks_value:
        integrity.add("meta_schema", "tasks must be a non-empty array")
    else:
        for index, item in enumerate(tasks_value):
            if (
                not isinstance(item, dict)
                or not isinstance(item.get("id"), str)
                or not item["id"]
                or not isinstance(item.get("category"), str)
                or not item["category"]
            ):
                integrity.add(
                    "meta_schema",
                    "each task must have non-empty id and category strings",
                    taskIndex=index,
                )
                continue
            task_id = item["id"]
            category = item["category"]
            if not task_id.startswith(f"{category}/"):
                integrity.add(
                    "meta_task_consistency",
                    "task id does not agree with its category",
                    taskIndex=index,
                )
            for hash_field in ("descriptionHash", "metaHash", "verifierHash"):
                if not is_sha256(item.get(hash_field)):
                    integrity.add(
                        "meta_schema",
                        "task source hashes must be lowercase SHA-256 values",
                        taskIndex=index,
                    )
            tasks.append((task_id, category))
    task_ids = [task_id for task_id, _ in tasks]
    if len(task_ids) != len(set(task_ids)):
        integrity.add("meta_schema", "task ids must be unique")

    trials_value = meta.get("trials")
    trials = trials_value if is_int(trials_value) and trials_value > 0 else 0
    if trials == 0:
        integrity.add("meta_schema", "trials must be a positive integer")

    expected = {
        (task_id, arm, trial)
        for task_id, _ in tasks
        for arm in arms
        for trial in range(1, trials + 1)
    }
    expected_jobs = meta.get("expectedJobs")
    if not is_int(expected_jobs) or expected_jobs != len(expected):
        integrity.add(
            "meta_expected_jobs",
            "expectedJobs does not equal tasks x arms x trials",
        )

    official_set = meta.get("officialEasyTaskSet")
    if not isinstance(official_set, list) or not all(
        isinstance(item, str) for item in official_set
    ):
        integrity.add("meta_schema", "officialEasyTaskSet must be a string array")
    elif not set(task_ids).issubset(set(official_set)):
        integrity.add(
            "meta_task_consistency",
            "selected tasks are not all in officialEasyTaskSet",
        )

    if not isinstance(meta.get("model"), str) or not meta.get("model"):
        integrity.add("meta_schema", "model must be a non-empty string")
    if not is_sha256(meta.get("schemaHash")):
        integrity.add("meta_schema", "schemaHash must be a lowercase SHA-256 value")
    retries = meta.get("retries")
    if not is_int(retries) or retries < 0:
        integrity.add("meta_schema", "retries must be a non-negative integer")
    return arms, tasks, trials, expected


def validate_usage(
    usage: Any,
    integrity: IntegrityReport,
    *,
    row: int,
    attempt: int,
    turn: int | None = None,
) -> tuple[int, int, int] | None:
    context: dict[str, Any] = {"row": row, "attempt": attempt}
    if turn is not None:
        context["turn"] = turn
    if not isinstance(usage, dict):
        integrity.add("usage_schema", "usage must be an object", **context)
        return None
    values: list[int] = []
    for field_name in ("inputTokens", "outputTokens", "totalTokens"):
        value = usage.get(field_name, 0)
        if not is_int(value) or value < 0:
            integrity.add(
                "usage_schema",
                "token usage values must be non-negative integers",
                **context,
            )
            return None
        values.append(value)
    return values[0], values[1], values[2]


def validate_verifier(
    value: Any,
    integrity: IntegrityReport,
    *,
    row: int,
    attempt: int,
    allow_infrastructure_incomplete: bool = False,
) -> bool | None:
    context = {"row": row, "attempt": attempt}
    if not isinstance(value, dict):
        integrity.add(
            "verifier_record", "verification must be an object", **context
        )
        return None
    passed = value.get("passed")
    timed_out = value.get("timedOut")
    exit_code = value.get("exitCode")
    if not isinstance(passed, bool):
        integrity.add(
            "verifier_record", "verification.passed must be boolean", **context
        )
        return None
    if not isinstance(timed_out, bool):
        integrity.add(
            "verifier_record", "verification.timedOut must be boolean", **context
        )
    if exit_code is not None and not is_int(exit_code):
        integrity.add(
            "verifier_record",
            "verification.exitCode must be integer or null",
            **context,
        )
    for field_name in ("stdout", "stderr"):
        if not isinstance(value.get(field_name), str):
            integrity.add(
                "verifier_record",
                "verification stdout and stderr must be strings",
                **context,
            )
    if "error" in value and not isinstance(value.get("error"), str):
        integrity.add(
            "verifier_record", "verification.error must be a string", **context
        )

    # A normal model failure has a completed verifier with non-zero exit code.
    # An attempt already marked provider/setup may legitimately lack a score;
    # the job-level validator decides whether a later clean attempt recovered it.
    if (timed_out or exit_code is None) and not allow_infrastructure_incomplete:
        integrity.add(
            "verifier_execution",
            "official verifier did not complete with an exit code",
            **context,
        )
    if passed and (timed_out or exit_code != 0):
        integrity.add(
            "verifier_consistency",
            "passed verifier record has timeout or non-zero exit code",
            **context,
        )
    if not passed and exit_code == 0 and not timed_out:
        integrity.add(
            "verifier_consistency",
            "failed verifier record has a zero exit code",
            **context,
        )
    return passed


def validate_attempt(
    attempt_value: Any,
    integrity: IntegrityReport,
    *,
    row: int,
    attempt_index: int,
    expected_schema_hash: str | None,
) -> tuple[bool | None, list[str], Counter[str]]:
    if not isinstance(attempt_value, dict):
        integrity.add(
            "attempt_schema",
            "attempt must be an object",
            row=row,
            attempt=attempt_index,
        )
        return None, [], Counter()
    attempt_number = attempt_value.get("attempt")
    if not is_int(attempt_number) or attempt_number != attempt_index:
        integrity.add(
            "attempt_sequence",
            "attempt numbers must be contiguous and one-based",
            row=row,
            attempt=attempt_index,
        )
    if not is_nonnegative_number(attempt_value.get("latencyMs")):
        integrity.add(
            "attempt_schema",
            "attempt latencyMs must be non-negative",
            row=row,
            attempt=attempt_index,
        )
    for field_name in (
        "agentEndedNormally",
        "snapshotRetained",
    ):
        if not isinstance(attempt_value.get(field_name), bool):
            integrity.add(
                "attempt_schema",
                "attempt boolean field is missing or invalid",
                row=row,
                attempt=attempt_index,
            )
    for field_name in (
        "finalText",
        "mcpServerStderr",
    ):
        if not isinstance(attempt_value.get(field_name), str):
            integrity.add(
                "attempt_schema",
                "attempt text field is missing or invalid",
                row=row,
                attempt=attempt_index,
            )
    failures_value = attempt_value.get("failures")
    declared_infrastructure = {
        failure.get("stage")
        for failure in (failures_value if isinstance(failures_value, list) else [])
        if isinstance(failure, dict)
    } & {"provider", "setup"}
    schema_hash = attempt_value.get("schemaHash")
    if not is_sha256(schema_hash):
        if "setup" not in declared_infrastructure:
            integrity.add(
                "schema_consistency",
                "attempt schemaHash is missing or invalid",
                row=row,
                attempt=attempt_index,
            )
    elif expected_schema_hash is not None and schema_hash != expected_schema_hash:
        integrity.add(
            "schema_consistency",
            "attempt schemaHash differs from run metadata",
            row=row,
            attempt=attempt_index,
        )
    result_tree_hash = attempt_value.get("resultTreeHash")
    if result_tree_hash is not None and not is_sha256(result_tree_hash):
        integrity.add(
            "attempt_schema",
            "resultTreeHash must be SHA-256 when present",
            row=row,
            attempt=attempt_index,
        )

    stages: list[str] = []
    infrastructure = Counter()
    if not isinstance(failures_value, list):
        integrity.add(
            "failure_schema",
            "attempt failures must be an array",
            row=row,
            attempt=attempt_index,
        )
    else:
        for failure in failures_value:
            if not isinstance(failure, dict):
                integrity.add(
                    "failure_schema",
                    "failure record must be an object",
                    row=row,
                    attempt=attempt_index,
                )
                continue
            stage = failure.get("stage")
            if stage not in ALLOWED_FAILURE_STAGES:
                integrity.add(
                    "failure_schema",
                    "failure stage is unsupported",
                    row=row,
                    attempt=attempt_index,
                )
            else:
                stages.append(stage)
                if stage in {"provider", "setup"}:
                    infrastructure[stage] += 1
            if not isinstance(failure.get("detail"), str) or not isinstance(
                failure.get("retryable"), bool
            ):
                integrity.add(
                    "failure_schema",
                    "failure detail/retryable fields are invalid",
                    row=row,
                    attempt=attempt_index,
                )
            turn = failure.get("turn")
            if turn is not None and (not is_int(turn) or turn <= 0):
                integrity.add(
                    "failure_schema",
                    "failure turn must be a positive integer when present",
                    row=row,
                    attempt=attempt_index,
                )

    parser_errors = attempt_value.get("parserErrors")
    if not isinstance(parser_errors, list) or not all(
        isinstance(item, str) for item in parser_errors
    ):
        integrity.add(
            "attempt_schema",
            "attempt parserErrors must be a string array",
            row=row,
            attempt=attempt_index,
        )

    trajectory = attempt_value.get("trajectory")
    turn_usage_totals = [0, 0, 0]
    if not isinstance(trajectory, list):
        integrity.add(
            "trajectory_schema",
            "attempt trajectory must be an array",
            row=row,
            attempt=attempt_index,
        )
    else:
        for turn_index, turn_value in enumerate(trajectory, 1):
            if not isinstance(turn_value, dict):
                integrity.add(
                    "trajectory_schema",
                    "trajectory turn must be an object",
                    row=row,
                    attempt=attempt_index,
                    turn=turn_index,
                )
                continue
            turn_number = turn_value.get("turn")
            if not is_int(turn_number) or turn_number != turn_index:
                integrity.add(
                    "turn_sequence",
                    "turn numbers must be contiguous and one-based",
                    row=row,
                    attempt=attempt_index,
                    turn=turn_index,
                )
            if not is_nonnegative_number(turn_value.get("latencyMs")):
                integrity.add(
                    "trajectory_schema",
                    "turn latencyMs must be non-negative",
                    row=row,
                    attempt=attempt_index,
                    turn=turn_index,
                )
            if not isinstance(turn_value.get("finishReason"), str):
                integrity.add(
                    "trajectory_schema",
                    "turn finishReason must be a string",
                    row=row,
                    attempt=attempt_index,
                    turn=turn_index,
                )
            for field_name in ("text",):
                if not isinstance(turn_value.get(field_name), str):
                    integrity.add(
                        "trajectory_schema",
                        "turn text must be a string",
                        row=row,
                        attempt=attempt_index,
                        turn=turn_index,
                    )
            for field_name in ("assistantMessages", "parserErrors", "toolCalls"):
                if not isinstance(turn_value.get(field_name), list):
                    integrity.add(
                        "trajectory_schema",
                        "turn array field is missing or invalid",
                        row=row,
                        attempt=attempt_index,
                        turn=turn_index,
                    )
            calls = turn_value.get("toolCalls")
            if isinstance(calls, list):
                for call in calls:
                    if not isinstance(call, dict):
                        integrity.add(
                            "tool_call_schema",
                            "tool call must be an object",
                            row=row,
                            attempt=attempt_index,
                            turn=turn_index,
                        )
                        continue
                    if not isinstance(call.get("toolCallId"), str) or not isinstance(
                        call.get("toolName"), str
                    ):
                        integrity.add(
                            "tool_call_schema",
                            "tool call id/name must be strings",
                            row=row,
                            attempt=attempt_index,
                            turn=turn_index,
                        )
                    if not is_nonnegative_number(call.get("latencyMs")):
                        integrity.add(
                            "tool_call_schema",
                            "tool call latencyMs must be non-negative",
                            row=row,
                            attempt=attempt_index,
                            turn=turn_index,
                        )
                    result_hash = call.get("resultHash")
                    if result_hash is not None and not is_sha256(result_hash):
                        integrity.add(
                            "tool_call_schema",
                            "tool resultHash must be SHA-256 when present",
                            row=row,
                            attempt=attempt_index,
                            turn=turn_index,
                        )
            turn_usage = validate_usage(
                turn_value.get("usage"),
                integrity,
                row=row,
                attempt=attempt_index,
                turn=turn_index,
            )
            if turn_usage is not None:
                for index, value in enumerate(turn_usage):
                    turn_usage_totals[index] += value

    attempt_usage = validate_usage(
        attempt_value.get("usage"),
        integrity,
        row=row,
        attempt=attempt_index,
    )
    if attempt_usage is not None and tuple(turn_usage_totals) != attempt_usage:
        integrity.add(
            "usage_consistency",
            "attempt usage does not equal the sum of trajectory usage",
            row=row,
            attempt=attempt_index,
        )

    passed = validate_verifier(
        attempt_value.get("verification"),
        integrity,
        row=row,
        attempt=attempt_index,
        allow_infrastructure_incomplete=bool(declared_infrastructure),
    )
    return passed, stages, infrastructure


def validate_rows(
    rows: list[dict[str, Any]],
    meta: dict[str, Any],
    expected: set[tuple[str, str, int]],
    tasks: list[tuple[str, str]],
    integrity: IntegrityReport,
) -> dict[str, Any]:
    expected_model = (
        meta.get("model") if isinstance(meta.get("model"), str) else None
    )
    expected_schema_hash = (
        meta.get("schemaHash") if is_sha256(meta.get("schemaHash")) else None
    )
    retries = meta.get("retries") if is_int(meta.get("retries")) else 0
    task_categories = dict(tasks)
    keys: list[tuple[str, str, int]] = []
    arm_counts: Counter[str] = Counter()
    task_counts: Counter[str] = Counter()
    stage_counts: Counter[str] = Counter()
    provider_failures = 0
    setup_failures = 0
    infrastructure_failure_jobs = 0
    recovered_infrastructure_jobs = 0
    recovered_transient_jobs = 0
    recovered_provider_jobs = 0
    recovered_setup_jobs = 0
    unrecovered_infrastructure_jobs = 0
    unrecovered_provider_jobs = 0
    unrecovered_setup_jobs = 0
    final_verifier_pass_with_infrastructure_jobs = 0
    verification_failures = 0

    for row_index, row_value in enumerate(rows, 1):
        task_id = row_value.get("taskId")
        arm = row_value.get("arm")
        trial = row_value.get("trial")
        key_valid = (
            isinstance(task_id, str)
            and isinstance(arm, str)
            and is_int(trial)
        )
        if key_valid:
            job_key = (task_id, arm, trial)
            keys.append(job_key)
            arm_counts[arm] += 1
            task_counts[task_id] += 1
        else:
            integrity.add(
                "row_key_schema",
                "taskId, arm, and trial must form a valid job key",
                row=row_index,
            )

        if expected_model is None or row_value.get("model") != expected_model:
            integrity.add(
                "model_consistency",
                "row model does not match run metadata",
                row=row_index,
            )
        expected_category = (
            task_categories.get(task_id) if isinstance(task_id, str) else None
        )
        if expected_category is None or row_value.get("category") != expected_category:
            integrity.add(
                "task_consistency",
                "row category does not match its configured task",
                row=row_index,
            )
        if not is_nonnegative_number(row_value.get("jobLatencyMs")):
            integrity.add(
                "row_schema", "jobLatencyMs must be non-negative", row=row_index
            )
        if not isinstance(row_value.get("verificationPassed"), bool):
            integrity.add(
                "row_schema", "verificationPassed must be boolean", row=row_index
            )

        attempts = row_value.get("attempts")
        if not isinstance(attempts, list) or not attempts:
            integrity.add(
                "attempts_empty",
                "every job must contain at least one attempt",
                row=row_index,
            )
            continue
        if len(attempts) > retries + 1:
            integrity.add(
                "attempt_count",
                "attempt count exceeds configured retries",
                row=row_index,
            )
        final_passed: bool | None = None
        all_attempt_stages: list[str] = []
        job_infrastructure: Counter[str] = Counter()
        earlier_infrastructure: Counter[str] = Counter()
        final_infrastructure: Counter[str] = Counter()
        for attempt_index, attempt in enumerate(attempts, 1):
            passed, stages, infrastructure = validate_attempt(
                attempt,
                integrity,
                row=row_index,
                attempt_index=attempt_index,
                expected_schema_hash=expected_schema_hash,
            )
            provider_failures += infrastructure["provider"]
            setup_failures += infrastructure["setup"]
            job_infrastructure.update(infrastructure)
            all_attempt_stages.extend(stages)
            if attempt_index == len(attempts):
                final_passed = passed
                final_infrastructure.update(infrastructure)
            else:
                earlier_infrastructure.update(infrastructure)
        has_provider_failure = job_infrastructure["provider"] > 0
        has_setup_failure = job_infrastructure["setup"] > 0
        has_infrastructure_failure = has_provider_failure or has_setup_failure
        final_has_provider_failure = final_infrastructure["provider"] > 0
        final_has_setup_failure = final_infrastructure["setup"] > 0
        final_has_infrastructure_failure = (
            final_has_provider_failure or final_has_setup_failure
        )
        unrecovered_provider = (
            final_has_provider_failure and final_passed is not True
        )
        unrecovered_setup = final_has_setup_failure and final_passed is not True
        unrecovered_infrastructure = unrecovered_provider or unrecovered_setup

        if has_infrastructure_failure:
            infrastructure_failure_jobs += 1
        if earlier_infrastructure.total() > 0 and not final_has_infrastructure_failure:
            recovered_transient_jobs += 1
        if final_has_infrastructure_failure and final_passed is True:
            final_verifier_pass_with_infrastructure_jobs += 1
        if has_infrastructure_failure and not unrecovered_infrastructure:
            recovered_infrastructure_jobs += 1
        if has_provider_failure and not unrecovered_provider:
            recovered_provider_jobs += 1
        if has_setup_failure and not unrecovered_setup:
            recovered_setup_jobs += 1
        if unrecovered_infrastructure:
            unrecovered_infrastructure_jobs += 1
        if unrecovered_provider:
            unrecovered_provider_jobs += 1
            integrity.add(
                "unrecovered_provider_failure",
                "final attempt provider failure has no passing official verifier",
                row=row_index,
            )
        if unrecovered_setup:
            unrecovered_setup_jobs += 1
            integrity.add(
                "unrecovered_setup_failure",
                "final attempt setup failure has no passing official verifier",
                row=row_index,
            )
        if final_passed is False:
            verification_failures += 1
        if (
            final_passed is not None
            and row_value.get("verificationPassed") != final_passed
        ):
            integrity.add(
                "verifier_consistency",
                "row verificationPassed differs from final attempt verifier",
                row=row_index,
            )
        expected_failure_stages = list(dict.fromkeys(all_attempt_stages))
        row_failure_stages = row_value.get("failureStages")
        if not isinstance(row_failure_stages, list) or not all(
            isinstance(item, str) for item in row_failure_stages
        ):
            integrity.add(
                "failure_schema",
                "row failureStages must be a string array",
                row=row_index,
            )
        elif row_failure_stages != expected_failure_stages:
            integrity.add(
                "failure_consistency",
                "row failureStages differs from the union across all attempts",
                row=row_index,
            )
        stage_counts.update(expected_failure_stages)

    key_counts = Counter(keys)
    duplicate_rows = sum(count - 1 for count in key_counts.values() if count > 1)
    if duplicate_rows:
        integrity.add(
            "duplicate_jobs",
            "raw results contain duplicate task-arm-trial jobs",
            count=duplicate_rows,
        )
    observed = set(keys)
    missing = expected - observed
    unexpected = observed - expected
    if missing:
        integrity.add(
            "missing_jobs",
            "raw results are missing expected jobs",
            count=len(missing),
        )
    if unexpected:
        integrity.add(
            "unexpected_jobs",
            "raw results contain jobs outside the configured grid",
            count=len(unexpected),
        )
    if len(rows) != len(expected):
        integrity.add(
            "row_count",
            "raw row count does not equal expectedJobs",
        )
    return {
        "armCounts": dict(sorted(arm_counts.items())),
        "taskCounts": dict(sorted(task_counts.items())),
        "failureStageJobs": dict(sorted(stage_counts.items())),
        "duplicateJobs": duplicate_rows,
        "missingJobs": len(missing),
        "unexpectedJobs": len(unexpected),
        "uniqueObservedJobs": len(observed),
        "providerFailureRecords": provider_failures,
        "setupFailureRecords": setup_failures,
        "infrastructureFailureJobs": infrastructure_failure_jobs,
        "recoveredInfrastructureJobs": recovered_infrastructure_jobs,
        "recoveredTransientJobs": recovered_transient_jobs,
        "recoveredProviderFailureJobs": recovered_provider_jobs,
        "recoveredSetupFailureJobs": recovered_setup_jobs,
        "unrecoveredInfrastructureJobs": unrecovered_infrastructure_jobs,
        "unrecoveredProviderFailureJobs": unrecovered_provider_jobs,
        "unrecoveredSetupFailureJobs": unrecovered_setup_jobs,
        "finalVerifierPassWithInfrastructureFailureJobs": (
            final_verifier_pass_with_infrastructure_jobs
        ),
        "verificationFailedJobs": verification_failures,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Validate MCPMark raw results against run-meta.json"
    )
    parser.add_argument("--raw", required=True, type=Path)
    parser.add_argument("--meta", required=True, type=Path)
    args = parser.parse_args()

    integrity = IntegrityReport()
    secret_scan = scan_secrets([args.raw, args.meta])
    if secret_scan["matches"]:
        integrity.add(
            "secret_pattern",
            "possible credential material detected; values are intentionally redacted",
            count=secret_scan["matches"],
        )

    meta = read_json(args.meta, integrity)
    rows = read_jsonl(args.raw, integrity)
    arms, tasks, trials, expected = parse_meta_grid(meta, integrity)
    row_report = validate_rows(rows, meta, expected, tasks, integrity)

    actual_sha256: str | None = None
    digest_present = "outputSha256" in meta
    digest_matches: bool | None = None
    if digest_present:
        configured_digest = meta.get("outputSha256")
        if not is_sha256(configured_digest):
            integrity.add(
                "output_sha256", "outputSha256 must be a lowercase SHA-256 value"
            )
            digest_matches = False
        else:
            try:
                actual_sha256 = hashlib.sha256(args.raw.read_bytes()).hexdigest()
                digest_matches = actual_sha256 == configured_digest
            except OSError:
                digest_matches = False
            if not digest_matches:
                integrity.add(
                    "output_sha256",
                    "raw output digest does not match run metadata",
                )

    report = {
        "valid": not integrity.errors,
        "integrityErrorCount": sum(integrity.counts.values()),
        "integrityErrorsByKind": dict(sorted(integrity.counts.items())),
        "integrityErrors": integrity.errors,
        "rawRows": len(rows),
        "expectedJobs": len(expected),
        "configuredArms": len(arms),
        "configuredTasks": len(tasks),
        "trials": trials,
        **row_report,
        "outputSha256": {
            "present": digest_present,
            "checked": digest_present,
            "matches": digest_matches,
        },
        "secretScan": secret_scan,
        "note": (
            "Official verifier failures with completed non-zero exit codes are valid model "
            "outcomes. Earlier provider/setup failures are valid when a clean retry follows; "
            "a passing final verifier also validates completed side effects."
        ),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    if integrity.errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
