#!/usr/bin/env python3
"""Build a score-free parser-health audit across live agentic benchmarks.

The audit never retains request bodies, model response bodies, rewards, or
benchmark scores. It reads only declared tool names from a request when needed
to distinguish a hallucinated undeclared tool from a parser failure, then
records capture linkage, parser diagnostics, transport status, completed
trajectory counts, and lifecycle depth metrics.
"""

from __future__ import annotations

import argparse
import hashlib
from importlib import import_module
import json
import math
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, cast

analyze_terminal_recovery = cast(
    Callable[[Path], dict[str, Any]],
    getattr(import_module("analyze_terminalbench2_live_recovery"), "analyze"),
)


MODELS = ("glm52-native", "glm52-native-plus")
TRAILING_IDS_SUFFIX = "_ids"
TOOLS_ARRAY_RE = re.compile(r'"tools"\s*:\s*(?=\[)')
DEFAULT_RETRY_ENVELOPE_SECONDS = 920
DEFAULT_OUTER_TIMEOUT_SECONDS = 960
DEFAULT_LIVE_WRITE_GRACE_SECONDS = 60


def now() -> str:
    return datetime.now().astimezone().isoformat()


def parse_time(value: object) -> datetime:
    if not isinstance(value, str):
        raise RuntimeError(f"invalid timestamp: {value!r}")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def read_live_jsonl(path: Path) -> tuple[list[dict[str, Any]], int]:
    """Read an append-only JSONL snapshot, tolerating one trailing partial row."""
    if not path.is_file():
        return [], 0
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line]
    rows: list[dict[str, Any]] = []
    trailing_partial = 0
    for index, line in enumerate(lines):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            if index == len(lines) - 1:
                trailing_partial = 1
                continue
            raise RuntimeError(f"{path}:{index + 1}: malformed non-final JSONL row")
        if not isinstance(value, dict):
            raise RuntimeError(f"{path}:{index + 1}: expected a JSON object")
        rows.append(value)
    return rows, trailing_partial


def percentile(values: list[int], quantile: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * quantile) - 1)]


def extract_json_array(text: str, start: int) -> list[Any] | None:
    depth = 0
    quoted = False
    escaped = False
    for index in range(start, len(text)):
        character = text[index]
        if quoted:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                quoted = False
            continue
        if character == '"':
            quoted = True
        elif character == "[":
            depth += 1
        elif character == "]":
            depth -= 1
            if depth == 0:
                try:
                    value = json.loads(text[start : index + 1])
                except json.JSONDecodeError:
                    return None
                return value if isinstance(value, list) else None
    return None


def request_tools(request_body: str) -> list[Any] | None:
    try:
        body = json.loads(request_body)
    except json.JSONDecodeError:
        body = None
    if isinstance(body, dict) and isinstance(body.get("tools"), list):
        return body["tools"]
    matches = list(TOOLS_ARRAY_RE.finditer(request_body))
    for match in reversed(matches):
        tools = extract_json_array(request_body, match.end())
        if tools is not None:
            return tools
    return None


def declared_tool_names(row: dict[str, Any]) -> set[str] | None:
    request_body = row.get("requestBody")
    if not isinstance(request_body, str):
        return None
    tools = request_tools(request_body)
    if tools is None:
        return None
    names: set[str] = set()
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        function = tool.get("function")
        if not isinstance(function, dict):
            continue
        name = function.get("name")
        if isinstance(name, str) and name:
            names.add(name)
    return names


def diagnostic_tool_name(message: str) -> str | None:
    payload_start = message.find("{")
    if payload_start < 0:
        return None
    try:
        payload, _ = json.JSONDecoder().raw_decode(message[payload_start:])
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    tool_call = payload.get("toolCall")
    if not isinstance(tool_call, str):
        return None
    marker = "<tool_call>"
    if marker not in tool_call:
        return None
    candidate = tool_call.split(marker, 1)[1].split("<", 1)[0].strip()
    return candidate or None


def uniquely_matches_pluralized_trailing_ids(
    attempted_tool: str, declared_tools: set[str]
) -> bool:
    matches = [
        candidate
        for candidate in declared_tools
        if candidate.endswith(f"s{TRAILING_IDS_SUFFIX}")
        and f"{candidate[: -len(TRAILING_IDS_SUFFIX)]}es" == attempted_tool
    ]
    return len(matches) == 1


def parser_event_class(
    message: str, declared_tools: set[str] | None = None
) -> str:
    lowered = message.lower()
    if "recovered malformed" in lowered:
        return "recovery"
    if (
        "bridge tool-name pass-through" in lowered
        or "bridge tool-input pass-through" in lowered
    ):
        return "model_output_passthrough"
    if "bridge history" in lowered:
        return "history_preservation"
    if "bridge tool-name recovery" in lowered:
        return "name_recovery"
    if "could not parse" in lowered:
        attempted_tool = diagnostic_tool_name(message)
        if (
            attempted_tool is not None
            and declared_tools is not None
            and attempted_tool not in declared_tools
            and not uniquely_matches_pluralized_trailing_ids(
                attempted_tool, declared_tools
            )
        ):
            return "model_output_passthrough"
        return "parse_failure"
    if "failed" in lowered:
        return "parse_failure"
    if "dropped" in lowered or "exceeded limit" in lowered:
        return "safety_drop"
    if "duplicate" in lowered:
        return "duplicate"
    return "other"


def bridge_retry_envelope_seconds(root: Path) -> int:
    """Read the bridge retry envelope without trusting live process state."""
    for path in (root / "run-meta.json", root.parent / "run-meta.json"):
        if not path.is_file():
            continue
        try:
            value = read_json(path)
        except (json.JSONDecodeError, OSError):
            continue
        policy = value.get("bridgeTransientRetryPolicy")
        if not isinstance(policy, dict):
            continue
        attempts = policy.get("additionalAttempts")
        timeout_ms = policy.get("timeoutMsPerAttempt")
        delay_ms = policy.get("delayMs")
        if (
            isinstance(attempts, int)
            and attempts >= 0
            and isinstance(timeout_ms, int)
            and timeout_ms > 0
            and isinstance(delay_ms, int)
            and delay_ms >= 0
        ):
            return math.ceil(
                ((attempts + 1) * timeout_ms + attempts * delay_ms) / 1000
            )
    return DEFAULT_RETRY_ENVELOPE_SECONDS


def provider_request_body_sha256(row: dict[str, Any]) -> str | None:
    request = row.get("request")
    if not isinstance(request, dict):
        return None
    body = request.get("body")
    if not isinstance(body, str):
        return None
    return hashlib.sha256(body.encode()).hexdigest()


def bridge_health(
    name: str,
    root: Path,
    *,
    producer_alive: bool = True,
    outer_timeout_seconds: int = DEFAULT_OUTER_TIMEOUT_SECONDS,
    live_write_grace_seconds: int = DEFAULT_LIVE_WRITE_GRACE_SECONDS,
    snapshot_time: datetime | None = None,
) -> dict[str, Any]:
    requests, request_partial = read_live_jsonl(root / "requests.jsonl")
    captures, capture_partial = read_live_jsonl(root / "provider-raw.jsonl")
    request_ids: set[str] = set()
    duplicate_requests = 0
    referenced_captures: list[str] = []
    models: dict[str, dict[str, Any]] = {}
    for model in MODELS:
        model_rows = [row for row in requests if row.get("model") == model]
        latencies = [
            int(row["latencyMs"])
            for row in model_rows
            if isinstance(row.get("latencyMs"), (int, float))
        ]
        status_counts = Counter(
            int(row["status"])
            for row in model_rows
            if isinstance(row.get("status"), int)
        )
        parser_classes: Counter[str] = Counter()
        parser_error_count = 0
        requests_with_parser_errors = 0
        for row in model_rows:
            errors = row.get("parserErrors")
            if not isinstance(errors, list):
                continue
            request_tool_names = declared_tool_names(row)
            parser_error_count += len(errors)
            if errors:
                requests_with_parser_errors += 1
            for error in errors:
                if isinstance(error, str):
                    parser_classes[
                        parser_event_class(error, request_tool_names)
                    ] += 1
        models[model] = {
            "latencyMaxMs": max(latencies, default=0),
            "latencyP50Ms": percentile(latencies, 0.5),
            "latencyP95Ms": percentile(latencies, 0.95),
            "non2xx": sum(
                count for status, count in status_counts.items() if status // 100 != 2
            ),
            "parserEventClasses": dict(sorted(parser_classes.items())),
            "parserErrors": parser_error_count,
            "requests": len(model_rows),
            "requestsWithParserErrors": requests_with_parser_errors,
            "statusCounts": {
                str(status): count for status, count in sorted(status_counts.items())
            },
        }
    for row in requests:
        request_id = row.get("requestId")
        if not isinstance(request_id, str) or request_id in request_ids:
            duplicate_requests += 1
        else:
            request_ids.add(request_id)
        row_capture_ids = row.get("upstreamCaptureIds")
        if isinstance(row_capture_ids, list):
            referenced_captures.extend(str(value) for value in row_capture_ids)

    observed_capture_ids: set[str] = set()
    duplicate_captures = 0
    for row in captures:
        capture_id = row.get("captureId")
        if not isinstance(capture_id, str) or capture_id in observed_capture_ids:
            duplicate_captures += 1
        else:
            observed_capture_ids.add(capture_id)
    referenced_set = set(referenced_captures)
    unresolved = sorted(referenced_set - observed_capture_ids)
    unreferenced = sorted(observed_capture_ids - referenced_set)
    captures_by_id = {
        str(row["captureId"]): row
        for row in captures
        if isinstance(row.get("captureId"), str)
    }
    job_key_mismatches = 0
    noncontiguous_retry_attempts = 0
    retry_body_hash_mismatches = 0
    for row in requests:
        request_id = row.get("requestId")
        capture_ids = row.get("upstreamCaptureIds")
        if not isinstance(request_id, str) or not isinstance(capture_ids, list):
            continue
        linked = [captures_by_id.get(str(value)) for value in capture_ids]
        if any(capture is None for capture in linked):
            continue
        linked_rows = [capture for capture in linked if capture is not None]
        attempts: list[int] = []
        for capture in linked_rows:
            context = capture.get("context")
            if not isinstance(context, dict) or context.get("jobKey") != request_id:
                job_key_mismatches += 1
            attempt = context.get("attempt") if isinstance(context, dict) else None
            if isinstance(attempt, int):
                attempts.append(attempt)
        if attempts != list(range(1, len(linked_rows) + 1)):
            noncontiguous_retry_attempts += 1
        if len(linked_rows) > 1:
            body_hashes = [provider_request_body_sha256(capture) for capture in linked_rows]
            if None in body_hashes or len(set(body_hashes)) != 1:
                retry_body_hash_mismatches += 1
    unreferenced_rows = [
        row for row in captures if row.get("captureId") in set(unreferenced)
    ]
    observed_at = snapshot_time or datetime.now(timezone.utc)
    retry_envelope_seconds = bridge_retry_envelope_seconds(root)
    live_write_threshold_seconds = (
        max(retry_envelope_seconds, outer_timeout_seconds)
        + live_write_grace_seconds
    )
    provisional_unreferenced: list[dict[str, Any]] = []
    permanent_unreferenced: list[dict[str, Any]] = []
    unreferenced_ages: list[int] = []
    for row in unreferenced_rows:
        try:
            age = int((observed_at - parse_time(row.get("capturedAt"))).total_seconds())
        except (RuntimeError, ValueError):
            permanent_unreferenced.append(row)
            continue
        unreferenced_ages.append(max(0, age))
        context = row.get("context")
        if (
            producer_alive
            and isinstance(context, dict)
            and context.get("jobKey") not in request_ids
            and 0 <= age <= live_write_threshold_seconds
        ):
            provisional_unreferenced.append(row)
        else:
            permanent_unreferenced.append(row)
    count_delta = len(captures) - len(requests)
    structural_invalid = (
        duplicate_requests
        or duplicate_captures
        or unresolved
        or len(referenced_captures) != len(referenced_set)
        or job_key_mismatches
        or noncontiguous_retry_attempts
        or retry_body_hash_mismatches
    )
    if structural_invalid or permanent_unreferenced:
        linkage_status = "invalid"
    elif not unreferenced and not request_partial and not capture_partial:
        # A request may legitimately reference multiple captures when the
        # bridge performed byte-identical internal retries. Capture/request
        # count parity is therefore not required for exact linkage.
        linkage_status = "exact"
    elif producer_alive and request_partial + capture_partial <= 2:
        # Multiple official workers can have simultaneous upstream calls, so
        # more than one recent capture may precede its eventual request row.
        linkage_status = "provisional-live-write-window"
    else:
        linkage_status = "invalid"
    return {
        "captureCount": len(captures),
        "captureTrailingPartialRows": capture_partial,
        "countDelta": count_delta,
        "duplicateCaptureIds": duplicate_captures,
        "duplicateRequestIds": duplicate_requests,
        "jobKeyMismatchCount": job_key_mismatches,
        "linkageStatus": linkage_status,
        "liveWriteGraceSeconds": live_write_grace_seconds,
        "liveWriteThresholdSeconds": live_write_threshold_seconds,
        "models": models,
        "name": name,
        "noncontiguousRetryAttemptCount": noncontiguous_retry_attempts,
        "outerTimeoutSeconds": outer_timeout_seconds,
        "permanentUnreferencedCaptureCount": len(permanent_unreferenced),
        "producerAlive": producer_alive,
        "provisionalUnreferencedCaptureCount": len(provisional_unreferenced),
        "requestCount": len(requests),
        "requestTrailingPartialRows": request_partial,
        "retryBodyHashMismatchCount": retry_body_hash_mismatches,
        "retryEnvelopeSeconds": retry_envelope_seconds,
        "unreferencedCaptureCount": len(unreferenced),
        "unreferencedCaptureMaxAgeSeconds": max(unreferenced_ages, default=0),
        "unresolvedCaptureCount": len(unresolved),
    }


def resolve_bridge_root(root: Path) -> Path:
    if (root / "requests.jsonl").is_file() and (
        root / "provider-raw.jsonl"
    ).is_file():
        return root
    return root / "bridge"


def nonempty_lines(path: Path) -> int:
    if not path.is_file():
        return 0
    return sum(1 for line in path.read_text(encoding="utf-8").splitlines() if line)


def appworld_lifecycle(root: Path) -> dict[str, Any]:
    meta = read_json(root / "run-meta.json")
    experiments = meta.get("experimentNames") if isinstance(meta, dict) else None
    if (
        not isinstance(experiments, list)
        or len(experiments) != len(MODELS)
        or not all(isinstance(value, str) and value for value in experiments)
    ):
        raise RuntimeError(
            f"{root}: AppWorld run-meta must name exactly two fresh experiments"
        )
    base = root / "root/experiments/outputs/simplified_function_calling_agent/local"
    result: dict[str, Any] = {}
    for model, experiment in zip(MODELS, experiments, strict=True):
        task_dirs: list[Path] = []
        for split in ("test_normal", "test_challenge"):
            for marker in (base / experiment / split / "tasks").glob("*/misc/finished"):
                task_dirs.append(marker.parents[1])
        api_calls = [
            nonempty_lines(path / "logs/api_calls.jsonl") for path in task_dirs
        ]
        lm_calls = [nonempty_lines(path / "logs/lm_calls.jsonl") for path in task_dirs]
        result[model] = {
            "completedTrajectories": len(task_dirs),
            "maxApiCallsPerTrajectory": max(api_calls, default=0),
            "maxLmCallsPerTrajectory": max(lm_calls, default=0),
            "totalApiCalls": sum(api_calls),
            "totalLmCalls": sum(lm_calls),
        }
    return {"expectedPerArm": 585, "models": result}


def vakra_lifecycle(root: Path) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for model in MODELS:
        rows: list[dict[str, Any]] = []
        for path in sorted((root / "outputs" / model).glob("capability-*/*.json")):
            if path.name.endswith("_tools.json"):
                continue
            value = read_json(path)
            if not isinstance(value, list) or not all(
                isinstance(row, dict) for row in value
            ):
                raise RuntimeError(f"{path}: expected a list of result objects")
            rows.extend(value)
        output_turns = [
            len(row["output"]) if isinstance(row.get("output"), list) else 0
            for row in rows
        ]
        result[model] = {
            "completedTrajectories": len(rows),
            "emptyErrorRows": sum(row.get("error") == "" for row in rows),
            "maxOutputTurns": max(output_turns, default=0),
            "statusCounts": dict(
                sorted(Counter(str(row.get("status")) for row in rows).items())
            ),
            "totalOutputTurns": sum(output_turns),
        }
    return {"expectedPerArm": 5207, "models": result}


def tau3_lifecycle(root: Path) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for model, suffix in (
        ("glm52-native", "native"),
        ("glm52-native-plus", "glm5"),
    ):
        simulations: list[dict[str, Any]] = []
        for path in sorted(
            (root / "data/simulations").glob(f"fresh-v*-*-{suffix}/results.json")
        ):
            value = read_json(path)
            rows = value.get("simulations") if isinstance(value, dict) else None
            if not isinstance(rows, list) or not all(
                isinstance(row, dict) for row in rows
            ):
                raise RuntimeError(f"{path}: expected simulations")
            simulations.extend(rows)
        message_counts = [
            len(row["messages"]) if isinstance(row.get("messages"), list) else 0
            for row in simulations
        ]
        result[model] = {
            "completedTrajectories": len(simulations),
            "maxMessagesPerTrajectory": max(message_counts, default=0),
            "terminationReasons": dict(
                sorted(
                    Counter(
                        str(row.get("termination_reason")) for row in simulations
                    ).items()
                )
            ),
            "totalMessages": sum(message_counts),
        }
    return {"expectedPerArm": 375, "models": result}


def terminal_lifecycle(root: Path) -> dict[str, Any]:
    rows, trailing_partial = read_live_jsonl(root / "progress.jsonl")
    result: dict[str, Any] = {}
    for model in MODELS:
        model_rows = [row for row in rows if row.get("arm") == model]
        result[model] = {
            "completedTrajectories": len(model_rows),
            "erroredZeroTrajectories": sum(
                row.get("trialStatus") == "errored-zero" for row in model_rows
            ),
            "maxStepsPerTrajectory": max(
                (int(row.get("steps", 0)) for row in model_rows), default=0
            ),
            "maxToolCallsPerTrajectory": max(
                (int(row.get("toolCalls", 0)) for row in model_rows), default=0
            ),
            "totalSteps": sum(int(row.get("steps", 0)) for row in model_rows),
            "totalToolCalls": sum(int(row.get("toolCalls", 0)) for row in model_rows),
        }
    return {
        "expectedPerArm": 89,
        "models": result,
        "progressTrailingPartialRows": trailing_partial,
    }


def terminal_benchmark_name(root: Path) -> str:
    """Use the exact benchmark identity recorded by the active fresh run."""

    meta_path = root / "run-meta.json"
    if meta_path.is_file():
        try:
            meta = read_json(meta_path)
        except (json.JSONDecodeError, OSError):
            meta = None
        if isinstance(meta, dict):
            benchmark = meta.get("benchmark")
            if isinstance(benchmark, str) and benchmark.startswith("Terminal-Bench "):
                return benchmark
    return "Terminal-Bench 2.x"


def model_total(bridges: Iterable[dict[str, Any]], model: str, field: str) -> int:
    return sum(int(bridge["models"][model][field]) for bridge in bridges)


def model_event_total(
    bridges: Iterable[dict[str, Any]], model: str, event_class: str
) -> int:
    return sum(
        int(bridge["models"][model]["parserEventClasses"].get(event_class, 0))
        for bridge in bridges
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--appworld-root", type=Path, required=True)
    parser.add_argument("--vakra-output-root", type=Path, required=True)
    parser.add_argument("--vakra-bridge-root", type=Path, required=True)
    parser.add_argument("--tau3-root", type=Path, required=True)
    parser.add_argument("--terminal-root", type=Path, required=True)
    parser.add_argument("--hammer-root", type=Path)
    parser.add_argument("--bfcl-root", type=Path)
    parser.add_argument("--stabletoolbench-root", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    terminal_name = terminal_benchmark_name(args.terminal_root)
    bridges = [
        bridge_health("AppWorld", args.appworld_root / "bridge"),
        bridge_health("VAKRA", args.vakra_bridge_root),
        bridge_health("tau3-bench", args.tau3_root / "bridge"),
        bridge_health(terminal_name, args.terminal_root / "bridge"),
    ]
    optional_bridges = (
        ("HammerBench", args.hammer_root),
        ("BFCL V4", args.bfcl_root),
        ("StableToolBench", args.stabletoolbench_root),
    )
    bridges.extend(
        bridge_health(name, resolve_bridge_root(root))
        for name, root in optional_bridges
        if root is not None
    )
    lifecycle = {
        "AppWorld": appworld_lifecycle(args.appworld_root),
        terminal_name: terminal_lifecycle(args.terminal_root),
        "VAKRA": vakra_lifecycle(args.vakra_output_root),
        "tau3-bench": tau3_lifecycle(args.tau3_root),
    }
    terminal_recovery = analyze_terminal_recovery(args.terminal_root)
    invalid_linkage = [
        bridge["name"] for bridge in bridges if bridge["linkageStatus"] == "invalid"
    ]
    native_plus_parser_diagnostics = model_total(
        bridges, "glm52-native-plus", "parserErrors"
    )
    native_plus_recovery_events = model_event_total(
        bridges, "glm52-native-plus", "recovery"
    )
    native_plus_model_output_passthrough = model_event_total(
        bridges, "glm52-native-plus", "model_output_passthrough"
    )
    native_plus_history_preservation = model_event_total(
        bridges, "glm52-native-plus", "history_preservation"
    )
    native_plus_name_recovery = model_event_total(
        bridges, "glm52-native-plus", "name_recovery"
    )
    # Only diagnostics that represent an actual unhandled parser event belong
    # in the parser-health failure gate. Schema-invalid model output that the
    # bridge deliberately passes through to the benchmark scorer and history
    # preservation diagnostics are evidence categories, not parser failures.
    native_plus_unrecovered_parser_events = sum(
        model_event_total(bridges, "glm52-native-plus", event_class)
        for event_class in ("parse_failure", "safety_drop", "duplicate", "other")
    )
    aggregate: dict[str, Any] = {
        "captureCount": sum(int(bridge["captureCount"]) for bridge in bridges),
        "invalidLinkageSuites": invalid_linkage,
        "nativePlusNon2xx": model_total(bridges, "glm52-native-plus", "non2xx"),
        "nativePlusParserDiagnostics": native_plus_parser_diagnostics,
        "nativePlusParserErrors": native_plus_unrecovered_parser_events,
        "nativePlusHistoryPreservationEvents": native_plus_history_preservation,
        "nativePlusModelOutputPassThroughEvents": (
            native_plus_model_output_passthrough
        ),
        "nativePlusNameRecoveryEvents": native_plus_name_recovery,
        "nativePlusParserRecoveryEvents": native_plus_recovery_events,
        "nativePlusParserRecoveryEventsExecuted": int(
            terminal_recovery["recoveryEventsExecuted"]
        ),
        "nativePlusParserRecoveryEventsLateUnconsumed": int(
            terminal_recovery["recoveryEventsLateAfterTaskEnd"]
        ),
        "nativePlusRequests": model_total(bridges, "glm52-native-plus", "requests"),
        "nativePlusUnrecoveredParserEvents": native_plus_unrecovered_parser_events,
        "nativeParserErrors": model_total(bridges, "glm52-native", "parserErrors"),
        "requestCount": sum(int(bridge["requestCount"]) for bridge in bridges),
    }
    conclusion_gate: dict[str, Any] = {
        "claim": "live parser-path health only; task scores remain locked",
        "parserPathHealthySoFar": (
            not invalid_linkage
            and native_plus_unrecovered_parser_events == 0
            and model_total(bridges, "glm52-native-plus", "requests") > 0
        ),
        "status": "provisional-live-evidence",
    }
    output: dict[str, Any] = {
        "aggregate": aggregate,
        "bridges": bridges,
        "conclusionGate": conclusion_gate,
        "generatedAt": now(),
        "lifecycle": lifecycle,
        "scoreDisclosure": "locked-until-exact-denominator-and-official-validators",
        "terminalBenchmark": terminal_name,
        "terminalRecoveryLinkage": terminal_recovery,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(output, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "nativePlusParserErrors": aggregate["nativePlusParserErrors"],
                "nativePlusParserRecoveryEvents": aggregate[
                    "nativePlusParserRecoveryEvents"
                ],
                "nativePlusUnrecoveredParserEvents": aggregate[
                    "nativePlusUnrecoveredParserEvents"
                ],
                "nativePlusRequests": aggregate["nativePlusRequests"],
                "out": str(args.out.resolve()),
                "parserPathHealthySoFar": conclusion_gate["parserPathHealthySoFar"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
