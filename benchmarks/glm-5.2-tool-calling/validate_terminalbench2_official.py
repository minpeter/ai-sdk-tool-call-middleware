#!/usr/bin/env python3
"""Validate and aggregate a complete Terminal-Bench 2.0 paired fresh run."""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
from collections import Counter
from pathlib import Path
from typing import Any


ARMS = ("glm52-native", "glm52-prompt-only")
EXPECTED_TASKS = 89
SCORABLE_AGENT_EXCEPTIONS = {
    "AgentTimeoutError",
    "NonZeroAgentExitCodeError",
}


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected a JSON object")
    return value


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), 1
    ):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise RuntimeError(f"{path}:{line_number}: expected an object")
        rows.append(value)
    return rows


def percentile(values: list[int], quantile: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    index = max(0, math.ceil(len(ordered) * quantile) - 1)
    return ordered[index]


def row_float(row: dict[str, object], key: str) -> float:
    value = row.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RuntimeError(f"invalid numeric metric: {key}")
    return float(value)


def row_int(row: dict[str, object], key: str) -> int:
    value = row.get(key)
    if type(value) is not int:
        raise RuntimeError(f"invalid integer metric: {key}")
    return value


def parser_event_class(message: str) -> str:
    lowered = message.lower()
    if "recovered malformed" in lowered:
        return "recovery"
    if "could not parse" in lowered or "failed" in lowered:
        return "parse_failure"
    if "dropped" in lowered or "exceeded limit" in lowered:
        return "safety_drop"
    if "duplicate" in lowered:
        return "duplicate"
    return "other"


def is_transient_capture(capture: dict[str, Any]) -> bool:
    response = capture.get("response")
    if isinstance(response, dict):
        status = response.get("status")
        if isinstance(status, int) and (
            status in {408, 425, 429} or status >= 500
        ):
            return True
    transport_error = capture.get("transportError")
    return isinstance(transport_error, str) and bool(transport_error)


def validate_bridge(
    bridge_root: Path,
    expected_models: set[str],
    expected_suite: str,
    maximum_attempts: int,
    secret_env: str | None,
) -> dict[str, object]:
    captures_path = bridge_root / "provider-raw.jsonl"
    requests_path = bridge_root / "requests.jsonl"
    captures = read_jsonl(captures_path)
    requests = read_jsonl(requests_path)
    if not captures or not requests:
        raise RuntimeError("bridge capture files are empty")
    captures_by_id: dict[str, dict[str, Any]] = {}
    for row in captures:
        capture_id = row.get("captureId")
        if not isinstance(capture_id, str) or capture_id in captures_by_id:
            raise RuntimeError("provider capture IDs are missing or duplicated")
        context = row.get("context")
        if not isinstance(context, dict) or context.get("suite") != expected_suite:
            raise RuntimeError(f"capture {capture_id}: suite mismatch")
        captures_by_id[capture_id] = row

    referenced: list[str] = []
    request_ids: set[str] = set()
    observed_models: set[str] = set()
    status_counts: Counter[int] = Counter()
    parser_errors: Counter[str] = Counter()
    parser_event_classes: dict[str, Counter[str]] = {
        model: Counter() for model in expected_models
    }
    requests_with_parser_events: Counter[str] = Counter()
    requests_by_arm: Counter[str] = Counter()
    provider_transient_attempts: Counter[str] = Counter()
    retried_requests: Counter[str] = Counter()
    for row in requests:
        request_id = row.get("requestId")
        if not isinstance(request_id, str) or request_id in request_ids:
            raise RuntimeError("bridge request IDs are missing or duplicated")
        request_ids.add(request_id)
        if row.get("suite") != expected_suite:
            raise RuntimeError(f"request {request_id}: suite mismatch")
        model = row.get("model")
        if not isinstance(model, str) or model not in expected_models:
            raise RuntimeError(f"request {request_id}: unexpected model {model}")
        observed_models.add(model)
        requests_by_arm[model] += 1
        status = row.get("status")
        if not isinstance(status, int):
            raise RuntimeError(f"request {request_id}: invalid status")
        status_counts[status] += 1
        errors = row.get("parserErrors")
        if isinstance(errors, list):
            parser_errors[model] += len(errors)
            if errors:
                requests_with_parser_events[model] += 1
            for error in errors:
                if isinstance(error, str):
                    parser_event_classes[model][parser_event_class(error)] += 1
        capture_ids = row.get("upstreamCaptureIds")
        if not isinstance(capture_ids, list) or not capture_ids:
            raise RuntimeError(f"request {request_id}: capture linkage missing")
        request_captures: list[dict[str, Any]] = []
        for capture_id in capture_ids:
            capture = captures_by_id.get(str(capture_id))
            if capture is None:
                raise RuntimeError(f"request {request_id}: unresolved capture")
            context = capture.get("context")
            if not isinstance(context, dict) or context.get("jobKey") != request_id:
                raise RuntimeError(f"request {request_id}: capture job key mismatch")
            request_captures.append(capture)
            referenced.append(str(capture_id))
        attempts = [
            capture.get("context", {}).get("attempt")
            for capture in request_captures
        ]
        if (
            any(not isinstance(attempt, int) for attempt in attempts)
            or sorted(attempts) != list(range(1, len(attempts) + 1))
            or len(attempts) > maximum_attempts
        ):
            raise RuntimeError(f"request {request_id}: invalid retry attempt sequence")
        transient_attempt_count = sum(
            is_transient_capture(capture) for capture in request_captures
        )
        provider_transient_attempts[model] += transient_attempt_count
        if len(request_captures) > 1:
            retried_requests[model] += 1
        final_capture = max(
            request_captures,
            key=lambda capture: int(capture.get("context", {}).get("attempt", 0)),
        )
        if is_transient_capture(final_capture):
            raise RuntimeError(
                f"request {request_id}: exhausted retries on provider infrastructure failure"
            )
    if len(referenced) != len(set(referenced)):
        raise RuntimeError("provider capture is linked more than once")
    if set(referenced) != set(captures_by_id):
        raise RuntimeError("provider captures are unreferenced")
    if observed_models != expected_models:
        raise RuntimeError("bridge model coverage mismatch")
    if secret_env:
        secret = os.getenv(secret_env)
        if not secret:
            raise RuntimeError(f"secret environment variable is unset: {secret_env}")
        encoded = secret.encode()
        if (
            encoded in captures_path.read_bytes()
            or encoded in requests_path.read_bytes()
        ):
            raise RuntimeError(
                f"exact secret retained in bridge artifacts: {secret_env}"
            )
    return {
        "captureCount": len(captures),
        "models": sorted(observed_models),
        "parserEventClassesByModel": {
            model: dict(sorted(parser_event_classes[model].items()))
            for model in sorted(parser_event_classes)
        },
        "parserErrorsByModel": dict(sorted(parser_errors.items())),
        "providerTransientAttemptsByModel": dict(
            sorted(provider_transient_attempts.items())
        ),
        "requestCount": len(requests),
        "requestsByModel": dict(sorted(requests_by_arm.items())),
        "requestsWithParserEventsByModel": dict(
            sorted(requests_with_parser_events.items())
        ),
        "retriedRequestsByModel": dict(sorted(retried_requests.items())),
        "statusCounts": {
            str(status): count for status, count in sorted(status_counts.items())
        },
    }


def trial_row(progress: dict[str, Any], expected_tasks: set[str]) -> dict[str, object]:
    arm = progress.get("arm")
    task_name = progress.get("taskName")
    if arm not in ARMS or task_name not in expected_tasks:
        raise RuntimeError("progress row has an unexpected arm or task")
    trajectory_value = progress.get("trajectory")
    if trajectory_value is None:
        job_root_value = progress.get("jobRoot")
        job_name = progress.get("jobName")
        trial_name = progress.get("trial")
        if (
            not isinstance(job_root_value, str)
            or not isinstance(job_name, str)
            or not isinstance(trial_name, str)
            or not trial_name.startswith(f"{task_name}__")
        ):
            raise RuntimeError(f"missing trajectory for {arm}/{task_name}")
        job_root = Path(job_root_value).resolve()
        if job_root.name != job_name:
            raise RuntimeError(f"missing trajectory for {arm}/{task_name}")
        trial_dir = job_root / job_name / trial_name
        trajectory_path: Path | None = None
    else:
        trajectory_path = Path(str(trajectory_value)).resolve()
        if not trajectory_path.is_file():
            raise RuntimeError(f"missing trajectory for {arm}/{task_name}")
        trial_dir = trajectory_path.parents[1]
    result = read_json(trial_dir / "result.json")
    if result.get("task_name") not in {task_name, f"terminal-bench/{task_name}"}:
        raise RuntimeError(f"task mismatch for {arm}/{task_name}")
    agent_info = result.get("agent_info")
    model_info = agent_info.get("model_info") if isinstance(agent_info, dict) else None
    if (
        not isinstance(agent_info, dict)
        or agent_info.get("name") != "mini-swe-agent"
        or agent_info.get("version") != "2.4.5"
        or not isinstance(model_info, dict)
        or model_info.get("name") != arm
    ):
        raise RuntimeError(f"agent identity mismatch for {arm}/{task_name}")
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
        expected_trial_status = "verified"
    elif exception_type in SCORABLE_AGENT_EXCEPTIONS:
        official_reward = None
        score_contribution = 0.0
        expected_trial_status = "errored-zero"
    else:
        raise RuntimeError(f"invalid or missing official reward for {arm}/{task_name}")
    if (
        progress.get("officialReward") != official_reward
        or progress.get("scoreContribution") != score_contribution
        or progress.get("trialStatus") != expected_trial_status
    ):
        raise RuntimeError(f"progress outcome mismatch for {arm}/{task_name}")
    if trajectory_path is None:
        if not (
            exception_type in SCORABLE_AGENT_EXCEPTIONS
            and score_contribution == 0
            and progress.get("exceptionType") == exception_type
            and progress.get("trajectoryStatus")
            == "absent-scorable-agent-exception"
            and progress.get("steps") == 0
            and progress.get("toolCalls") == 0
        ):
            raise RuntimeError(f"invalid absent trajectory for {arm}/{task_name}")
        steps = []
        tool_calls = 0
        trajectory_output: str | None = None
    else:
        trajectory = read_json(trajectory_path)
        trajectory_steps = trajectory.get("steps")
        if not isinstance(trajectory_steps, list):
            raise RuntimeError(f"invalid ATIF trajectory for {arm}/{task_name}")
        steps = trajectory_steps
        tool_calls = sum(
            len(step.get("tool_calls") or [])
            for step in steps
            if isinstance(step, dict)
        )
        if (
            tool_calls != progress.get("toolCalls")
            or len(steps) != progress.get("steps")
        ):
            raise RuntimeError(f"trajectory metric mismatch for {arm}/{task_name}")
        trajectory_output = str(trajectory_path)
    return {
        "arm": arm,
        "exceptionType": exception_type,
        "finishedAt": result.get("finished_at"),
        "jobName": progress.get("jobName"),
        "officialReward": official_reward,
        "scoreContribution": score_contribution,
        "startedAt": result.get("started_at"),
        "steps": len(steps),
        "taskIndex": int(progress.get("taskIndex", 0)),
        "taskName": task_name,
        "toolCalls": tool_calls,
        "trajectory": trajectory_output,
    }


def arm_summary(rows: list[dict[str, object]]) -> dict[str, object]:
    scores = [row_float(row, "scoreContribution") for row in rows]
    steps = [row_int(row, "steps") for row in rows]
    tool_calls = [row_int(row, "toolCalls") for row in rows]
    return {
        "erroredWithoutVerifier": sum(
            row["officialReward"] is None for row in rows
        ),
        "exceptions": sum(row["exceptionType"] is not None for row in rows),
        "meanReward": sum(scores) / len(scores),
        "passed": sum(score == 1 for score in scores),
        "tasks": len(rows),
        "totalSteps": sum(steps),
        "totalToolCalls": sum(tool_calls),
        "stepP50": percentile(steps, 0.5),
        "stepP95": percentile(steps, 0.95),
        "stepMax": max(steps),
        "toolCallP50": percentile(tool_calls, 0.5),
        "toolCallP95": percentile(tool_calls, 0.95),
        "toolCallMax": max(tool_calls),
    }


def paired_summary(rows: list[dict[str, object]]) -> dict[str, object]:
    by_arm = {
        arm: {
            str(row["taskName"]): row_float(row, "scoreContribution")
            for row in rows
            if row["arm"] == arm
        }
        for arm in ARMS
    }
    both_pass = native_only = plus_only = both_fail = 0
    for task in sorted(by_arm[ARMS[0]]):
        native = by_arm[ARMS[0]][task] == 1
        plus = by_arm[ARMS[1]][task] == 1
        if native and plus:
            both_pass += 1
        elif native:
            native_only += 1
        elif plus:
            plus_only += 1
        else:
            both_fail += 1
    return {
        "bothFail": both_fail,
        "bothPass": both_pass,
        "nativeOnlyPass": native_only,
        "nativePlusOnlyPass": plus_only,
        "netNativePlus": plus_only - native_only,
    }


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--secret-env")
    parser.add_argument("--expected-max-output-tokens", type=int, default=4096)
    args = parser.parse_args()

    run_root = args.run_root.resolve()
    manifest = read_json(args.manifest.resolve())
    if manifest.get("taskCount") != EXPECTED_TASKS:
        raise RuntimeError("Terminal-Bench manifest is not the full 89-task set")
    run_meta = read_json(run_root / "run-meta.json")
    if run_meta.get("status") != "inference-complete":
        raise RuntimeError("refusing incomplete Terminal-Bench inference")
    if (
        args.expected_max_output_tokens < 1
        or run_meta.get("maxOutputTokens") != args.expected_max_output_tokens
    ):
        raise RuntimeError("Terminal-Bench output-token limit mismatch")
    benchmark_name = run_meta.get("benchmark")
    if not isinstance(benchmark_name, str) or not benchmark_name.startswith(
        "Terminal-Bench 2."
    ):
        raise RuntimeError("Terminal-Bench benchmark identity is invalid")
    expected_suite = run_meta.get("bridgeSuite")
    retry_policy = run_meta.get("bridgeTransientRetryPolicy")
    additional_attempts = (
        retry_policy.get("additionalAttempts")
        if isinstance(retry_policy, dict)
        else None
    )
    if not isinstance(expected_suite, str) or not expected_suite:
        raise RuntimeError("Terminal-Bench bridge suite is missing")
    if not isinstance(additional_attempts, int) or additional_attempts < 0:
        raise RuntimeError("Terminal-Bench retry policy is invalid")
    task_order = read_json(run_root / "task-order.json").get("tasks")
    if not isinstance(task_order, list) or len(task_order) != EXPECTED_TASKS:
        raise RuntimeError("task order is missing or incomplete")
    expected_tasks = {
        str(task["name"]) for task in task_order if isinstance(task, dict)
    }
    if len(expected_tasks) != EXPECTED_TASKS:
        raise RuntimeError("task order contains duplicates")

    progress = read_jsonl(run_root / "progress.jsonl")
    if len(progress) != EXPECTED_TASKS * len(ARMS):
        raise RuntimeError(
            f"expected {EXPECTED_TASKS * len(ARMS)} progress rows, found {len(progress)}"
        )
    keys = [(row.get("arm"), row.get("taskName")) for row in progress]
    if len(keys) != len(set(keys)):
        raise RuntimeError("duplicate Terminal-Bench arm/task rows")
    expected_keys = {(arm, task) for arm in ARMS for task in expected_tasks}
    if set(keys) != expected_keys:
        raise RuntimeError("Terminal-Bench arm/task coverage mismatch")

    rows = [trial_row(row, expected_tasks) for row in progress]
    rows.sort(key=lambda row: (str(row["taskName"]), str(row["arm"])))
    arms = {
        arm: arm_summary([row for row in rows if row["arm"] == arm]) for arm in ARMS
    }
    bridge = validate_bridge(
        run_root / "bridge",
        set(ARMS),
        expected_suite,
        additional_attempts + 1,
        args.secret_env,
    )
    summary = {
        "arms": arms,
        "benchmark": benchmark_name,
        "bridge": bridge,
        "complete": True,
        "maxOutputTokens": args.expected_max_output_tokens,
        "paired": paired_summary(rows),
        "population": manifest.get("population"),
        "status": "valid",
        "taskCountPerArm": EXPECTED_TASKS,
        "taskSetSha256": manifest.get("taskSetSha256"),
    }
    out_dir = args.out_dir.resolve()
    if out_dir.exists():
        raise RuntimeError(f"refusing existing analysis directory: {out_dir}")
    out_dir.mkdir(parents=True)
    write_csv(out_dir / "task-results.csv", rows)
    (out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
