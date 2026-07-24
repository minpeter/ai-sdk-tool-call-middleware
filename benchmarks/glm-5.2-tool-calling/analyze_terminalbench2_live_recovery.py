#!/usr/bin/env python3
"""Link live Terminal-Bench parser recovery events to executed tool steps."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any


RECOVERY_PREFIX = "Recovered malformed GLM-5.2 tool call. "


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


def parse_time(value: object) -> datetime:
    if not isinstance(value, str):
        raise RuntimeError(f"invalid timestamp: {value!r}")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def parse_recovery(message: str) -> dict[str, Any] | None:
    if not message.startswith(RECOVERY_PREFIX):
        return None
    # The bridge intentionally bounds diagnostic strings, so a large raw tool call
    # can leave the embedded JSON object truncated. The recovery codes and the
    # beginning of the tool call are emitted first and remain independently
    # extractable without pretending the diagnostic fragment is valid JSON.
    payload_fragment = message[len(RECOVERY_PREFIX) :]
    codes_match = re.search(r'"recoveryCodes":(\[[^]]*\])', payload_fragment)
    if codes_match is None:
        raise RuntimeError("recovery event codes are missing")
    codes = json.loads(codes_match.group(1))
    if not isinstance(codes, list) or not all(isinstance(code, str) for code in codes):
        raise RuntimeError("recovery event codes are invalid")
    raw_match = re.search(r'"toolCall":"(.*)', payload_fragment, re.DOTALL)
    if raw_match is None:
        raise RuntimeError("recovery event raw tool call fragment is missing")
    raw_call_fragment = raw_match.group(1)
    tool_match = re.search(r"<tool_call>([^<]+)", raw_call_fragment)
    arg_match = re.search(r"<arg_value>(.*)", raw_call_fragment, re.DOTALL)
    argument_prefix = arg_match.group(1) if arg_match else ""
    # A first command line is sufficient for linkage and avoids retaining the
    # diagnostic's potentially large task payload in the audit artifact.
    argument_prefix = argument_prefix.split(r"\n", 1)[0]
    return {
        "argumentPrefix": argument_prefix,
        "rawToolCallSha256": sha256_text(raw_call_fragment),
        "recoveryCodes": codes,
        "toolName": tool_match.group(1) if tool_match else None,
    }


def decode_arguments(value: object) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        decoded = json.loads(value)
        if isinstance(decoded, dict):
            return decoded
    raise RuntimeError("trajectory tool arguments are not an object")


def observation_result(step: dict[str, Any]) -> dict[str, Any] | None:
    observation = step.get("observation")
    results = observation.get("results") if isinstance(observation, dict) else None
    if not isinstance(results, list) or not results:
        return None
    first = results[0]
    content = first.get("content") if isinstance(first, dict) else None
    if not isinstance(content, str):
        return None
    try:
        decoded = json.loads(content)
    except json.JSONDecodeError:
        return None
    return decoded if isinstance(decoded, dict) else None


def completed_trajectories(run_root: Path) -> list[dict[str, Any]]:
    completed_progress_path = run_root / "progress.jsonl"
    if not completed_progress_path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    for progress in read_jsonl(completed_progress_path):
        if progress.get("arm") != "glm52-native-plus":
            continue
        trajectory_path = Path(str(progress.get("trajectory"))).resolve()
        trajectory = read_json(trajectory_path)
        result = read_json(trajectory_path.parents[1] / "result.json")
        exception_info = result.get("exception_info")
        exception_type = (
            exception_info.get("exception_type")
            if isinstance(exception_info, dict)
            else None
        )
        steps = trajectory.get("steps")
        if not isinstance(steps, list):
            raise RuntimeError(f"{trajectory_path}: steps are invalid")
        rows.append(
            {
                "exception": exception_type,
                "finishedAt": result.get("finished_at"),
                "startedAt": result.get("started_at"),
                "steps": steps,
                "taskIndex": progress.get("taskIndex"),
                "taskName": progress.get("taskName"),
                "trajectory": str(trajectory_path),
            }
        )
    return rows


def task_active_at(
    request_started: datetime, trajectories: list[dict[str, Any]]
) -> dict[str, Any] | None:
    matches = []
    for trajectory in trajectories:
        started = parse_time(trajectory["startedAt"])
        finished = parse_time(trajectory["finishedAt"])
        if started <= request_started <= finished:
            matches.append(trajectory)
    if len(matches) > 1:
        names = ", ".join(str(row.get("taskName")) for row in matches)
        raise RuntimeError(f"request overlaps multiple completed tasks: {names}")
    return matches[0] if matches else None


def unlinked_response_class(
    request_completed: datetime, active_task: dict[str, Any] | None
) -> str:
    if active_task is None:
        return "unassigned-response"
    if request_completed > parse_time(active_task["finishedAt"]):
        return "late-response-after-task-end"
    return "unlinked-in-task-response"


def match_step(
    event_time: datetime,
    recovery: dict[str, Any],
    trajectories: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], float] | None:
    matches: list[tuple[float, dict[str, Any], dict[str, Any], dict[str, Any]]] = []
    for trajectory in trajectories:
        for step in trajectory["steps"]:
            if not isinstance(step, dict):
                continue
            if not isinstance(step.get("timestamp"), str):
                continue
            step_time = parse_time(step["timestamp"])
            delta_ms = abs((step_time - event_time).total_seconds() * 1000)
            if delta_ms > 10_000:
                continue
            calls = step.get("tool_calls")
            if not isinstance(calls, list):
                continue
            for call in calls:
                if not isinstance(call, dict):
                    continue
                if call.get("function_name") != recovery["toolName"]:
                    continue
                arguments = decode_arguments(call.get("arguments"))
                command = arguments.get("command")
                prefix = recovery["argumentPrefix"]
                if (
                    isinstance(command, str)
                    and prefix
                    and not command.startswith(prefix)
                ):
                    continue
                matches.append((delta_ms, trajectory, step, arguments))
    if not matches:
        return None
    matches.sort(key=lambda item: item[0])
    delta_ms, trajectory, step, arguments = matches[0]
    return trajectory, step, arguments, delta_ms


def analyze(run_root: Path) -> dict[str, Any]:
    requests = read_jsonl(run_root / "bridge" / "requests.jsonl")
    captures = read_jsonl(run_root / "bridge" / "provider-raw.jsonl")
    capture_by_id: dict[str, dict[str, Any]] = {}
    for capture in captures:
        capture_id = capture.get("captureId")
        if not isinstance(capture_id, str) or capture_id in capture_by_id:
            raise RuntimeError("provider capture IDs are missing or duplicated")
        capture_by_id[capture_id] = capture
    trajectories = completed_trajectories(run_root)
    evidence: list[dict[str, Any]] = []
    total_parser_events = 0
    for request in requests:
        errors = request.get("parserErrors")
        if not isinstance(errors, list):
            continue
        total_parser_events += len(errors)
        for message in errors:
            if not isinstance(message, str):
                continue
            recovery = parse_recovery(message)
            if recovery is None:
                continue
            capture_ids = request.get("upstreamCaptureIds")
            if not isinstance(capture_ids, list) or not capture_ids:
                raise RuntimeError("recovery request has no provider capture linkage")
            request_captures = []
            for capture_id in capture_ids:
                capture = capture_by_id.get(str(capture_id))
                if capture is None:
                    raise RuntimeError(
                        f"recovery request references unknown capture: {capture_id}"
                    )
                request_captures.append(capture)
            request_started = min(
                parse_time(capture.get("capturedAt")) for capture in request_captures
            )
            request_completed = parse_time(request.get("completedAt"))
            match = match_step(
                request_completed, recovery, trajectories
            )
            linked = match is not None
            active_task = task_active_at(request_started, trajectories)
            linkage_class = (
                "executed-tool-step"
                if linked
                else unlinked_response_class(request_completed, active_task)
            )
            row: dict[str, Any] = {
                "arm": request.get("arm"),
                "consumedByAgent": linked,
                "executed": linked,
                "linkageClass": linkage_class,
                "model": request.get("model"),
                "rawToolCallSha256": recovery["rawToolCallSha256"],
                "recoveryCodes": recovery["recoveryCodes"],
                "requestId": request.get("requestId"),
                "status": request.get("status"),
                "toolName": recovery["toolName"],
                "upstreamCaptureIds": request.get("upstreamCaptureIds"),
                "requestCompletedAt": request.get("completedAt"),
                "requestStartedAt": min(
                    str(capture.get("capturedAt")) for capture in request_captures
                ),
            }
            if linked and match is not None:
                trajectory, step, arguments, delta_ms = match
                observation = observation_result(step)
                command = arguments.get("command")
                row.update(
                    {
                        "argumentSha256": sha256_text(
                            json.dumps(arguments, sort_keys=True, separators=(",", ":"))
                        ),
                        "commandFirstLine": (
                            command.splitlines()[0][:160]
                            if isinstance(command, str)
                            else None
                        ),
                        "continuedAfterRecovery": int(step.get("step_id", 0))
                        < len(trajectory["steps"]),
                        "exception": trajectory["exception"],
                        "observationPresent": observation is not None,
                        "returnCode": (
                            observation.get("returncode") if observation else None
                        ),
                        "stepId": step.get("step_id"),
                        "taskIndex": trajectory["taskIndex"],
                        "taskName": trajectory["taskName"],
                        "timeDeltaMs": round(delta_ms, 3),
                        "trajectory": trajectory["trajectory"],
                    }
                )
            elif active_task is not None:
                task_finished = parse_time(active_task["finishedAt"])
                row.update(
                    {
                        "completedAfterTaskEndMs": round(
                            max(
                                0.0,
                                (request_completed - task_finished).total_seconds()
                                * 1000,
                            ),
                            3,
                        ),
                        "exception": active_task["exception"],
                        "startedDuringTask": True,
                        "taskFinishedAt": active_task["finishedAt"],
                        "taskIndex": active_task["taskIndex"],
                        "taskName": active_task["taskName"],
                        "taskStartedAt": active_task["startedAt"],
                        "trajectory": active_task["trajectory"],
                    }
                )
            evidence.append(row)
    classes = Counter(str(row["linkageClass"]) for row in evidence)
    benchmark = "Terminal-Bench 2.x"
    meta_path = run_root / "run-meta.json"
    if meta_path.is_file():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        configured = meta.get("benchmark") if isinstance(meta, dict) else None
        if isinstance(configured, str) and configured.startswith("Terminal-Bench "):
            benchmark = configured
    return {
        "benchmark": benchmark,
        "completeTrajectoriesInspected": len(trajectories),
        "evidence": evidence,
        "liveCheckpointOnly": True,
        "recoveryEvents": len(evidence),
        "recoveryEventClasses": dict(sorted(classes.items())),
        "recoveryEventsContinued": sum(
            bool(row.get("continuedAfterRecovery")) for row in evidence
        ),
        "recoveryEventsExecuted": sum(bool(row["executed"]) for row in evidence),
        "recoveryEventsLateAfterTaskEnd": classes.get(
            "late-response-after-task-end", 0
        ),
        "recoveryEventsReturnCodeZero": sum(
            row.get("returnCode") == 0 for row in evidence
        ),
        "requestCount": len(requests),
        "totalParserEvents": total_parser_events,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    out = args.out.resolve()
    if out.exists():
        raise RuntimeError(f"refusing existing output: {out}")
    result = analyze(args.run_root.resolve())
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"out": str(out), **result}, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
