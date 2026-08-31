#!/usr/bin/env python3
"""Validate fresh official-benchmark traffic captured by the loopback bridge."""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SENSITIVE_HEADERS = {
    "api-key",
    "authorization",
    "cookie",
    "proxy-authorization",
    "set-cookie",
    "x-api-key",
}


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise RuntimeError(
                    f"{path}:{line_number}: invalid JSON: {error}"
                ) from error
            if not isinstance(value, dict):
                raise RuntimeError(f"{path}:{line_number}: row is not an object")
            rows.append(value)
    if not rows:
        raise RuntimeError(f"{path}: no JSONL rows")
    return rows


def parse_timestamp(value: object, field: str) -> datetime:
    if not isinstance(value, str):
        raise RuntimeError(f"{field}: expected ISO timestamp")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise RuntimeError(f"{field}: invalid ISO timestamp: {value}") from error


def header_names(value: object) -> set[str]:
    if isinstance(value, dict):
        return {str(key).lower() for key in value}
    if isinstance(value, list):
        names: set[str] = set()
        for item in value:
            if isinstance(item, (list, tuple)) and item:
                names.add(str(item[0]).lower())
        return names
    return set()


def require_unique(values: list[str], label: str) -> None:
    duplicates = sorted(value for value, count in Counter(values).items() if count > 1)
    if duplicates:
        preview = ", ".join(duplicates[:5])
        raise RuntimeError(f"duplicate {label}: {preview}")


def is_transient_capture(row: dict[str, Any]) -> bool:
    response = row.get("response")
    if isinstance(response, dict):
        status = response.get("status")
        if isinstance(status, int) and (
            status in {408, 425, 429} or status >= 500
        ):
            return True
    transport_error = row.get("transportError")
    return isinstance(transport_error, str) and bool(transport_error)


def is_successful_capture(row: dict[str, Any]) -> bool:
    response = row.get("response")
    if not isinstance(response, dict):
        return False
    status = response.get("status")
    return isinstance(status, int) and 200 <= status < 300


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--capture", type=Path, required=True)
    parser.add_argument("--requests", type=Path, required=True)
    parser.add_argument("--expected-suite", required=True)
    parser.add_argument("--expected-models", required=True)
    parser.add_argument("--not-before")
    parser.add_argument(
        "--allow-external-retries",
        action="store_true",
        help=(
            "Allow a provider failure only when a later byte-identical request "
            "for the same model succeeds"
        ),
    )
    parser.add_argument(
        "--external-retry-max-delay-seconds",
        type=float,
        default=60.0,
    )
    parser.add_argument(
        "--allow-live-write-window-seconds",
        type=float,
        default=0.0,
        help=(
            "During a live append-only run only, tolerate recent captures whose "
            "jobKey has not produced a request row yet. The default remains strict."
        ),
    )
    parser.add_argument(
        "--secret-env",
        action="append",
        default=[],
        help="Environment variable whose exact value must not occur in either file",
    )
    args = parser.parse_args()

    request_rows = read_jsonl(args.requests.resolve())
    # A bridge appends provider captures before the corresponding request row.
    # Reading requests first prevents a live snapshot from observing a request
    # whose already-written capture was missed by an earlier EOF boundary.
    capture_rows = read_jsonl(args.capture.resolve())
    expected_models = {
        value.strip() for value in args.expected_models.split(",") if value.strip()
    }
    if not expected_models:
        raise RuntimeError("--expected-models is empty")
    not_before = (
        parse_timestamp(args.not_before, "--not-before") if args.not_before else None
    )

    capture_ids: list[str] = []
    captures_by_id: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(capture_rows, start=1):
        capture_id = row.get("captureId")
        if not isinstance(capture_id, str) or not capture_id:
            raise RuntimeError(f"capture row {index}: missing captureId")
        capture_ids.append(capture_id)
        captures_by_id[capture_id] = row
        context = row.get("context")
        if not isinstance(context, dict):
            raise RuntimeError(f"capture {capture_id}: missing context")
        if context.get("suite") != args.expected_suite:
            raise RuntimeError(f"capture {capture_id}: suite mismatch")
        if context.get("arm") not in {"native", "glm5"}:
            raise RuntimeError(f"capture {capture_id}: unexpected arm")
        captured_at = parse_timestamp(row.get("capturedAt"), "capturedAt")
        if not_before and captured_at < not_before:
            raise RuntimeError(f"capture {capture_id}: predates fresh-run boundary")
        request = row.get("request")
        response = row.get("response")
        transport_error = row.get("transportError")
        if not isinstance(request, dict):
            raise RuntimeError(f"capture {capture_id}: missing request")
        if not isinstance(response, dict) and not (
            isinstance(transport_error, str) and transport_error
        ):
            raise RuntimeError(
                f"capture {capture_id}: missing response and transportError"
            )
        leaked_headers = header_names(request.get("headers")) & SENSITIVE_HEADERS
        if isinstance(response, dict):
            leaked_headers |= header_names(response.get("headers")) & SENSITIVE_HEADERS
        if leaked_headers:
            names = ", ".join(sorted(leaked_headers))
            raise RuntimeError(f"capture {capture_id}: sensitive headers retained: {names}")
    require_unique(capture_ids, "captureId")

    request_ids: list[str] = []
    referenced_capture_ids: list[str] = []
    observed_models: set[str] = set()
    status_counts: Counter[int] = Counter()
    provider_non_success_attempts: Counter[str] = Counter()
    provider_transient_attempts: Counter[str] = Counter()
    pending_external_retries: list[tuple[int, dict[str, Any]]] = []
    recovered_external_retries: Counter[str] = Counter()
    retried_requests: Counter[str] = Counter()
    for index, row in enumerate(request_rows, start=1):
        request_id = row.get("requestId")
        if not isinstance(request_id, str) or not request_id:
            raise RuntimeError(f"request row {index}: missing requestId")
        request_ids.append(request_id)
        if row.get("suite") != args.expected_suite:
            raise RuntimeError(f"request {request_id}: suite mismatch")
        model = row.get("model")
        if not isinstance(model, str) or model not in expected_models:
            raise RuntimeError(f"request {request_id}: unexpected model: {model}")
        observed_models.add(model)
        status = row.get("status")
        if not isinstance(status, int):
            raise RuntimeError(f"request {request_id}: invalid status")
        status_counts[status] += 1
        completed_at = parse_timestamp(row.get("completedAt"), "completedAt")
        if not_before and completed_at < not_before:
            raise RuntimeError(f"request {request_id}: predates fresh-run boundary")
        upstream_ids = row.get("upstreamCaptureIds")
        if not isinstance(upstream_ids, list) or not upstream_ids:
            raise RuntimeError(f"request {request_id}: no upstream capture linkage")
        request_captures: list[dict[str, Any]] = []
        for capture_id in upstream_ids:
            if not isinstance(capture_id, str) or capture_id not in captures_by_id:
                raise RuntimeError(
                    f"request {request_id}: unresolved capture ID: {capture_id}"
                )
            capture_context = captures_by_id[capture_id].get("context", {})
            if capture_context.get("jobKey") != request_id:
                raise RuntimeError(
                    f"request {request_id}: capture {capture_id} jobKey mismatch"
                )
            request_captures.append(captures_by_id[capture_id])
            referenced_capture_ids.append(capture_id)
        attempts = [
            capture.get("context", {}).get("attempt")
            for capture in request_captures
        ]
        if (
            any(not isinstance(attempt, int) for attempt in attempts)
            or sorted(attempts) != list(range(1, len(attempts) + 1))
        ):
            raise RuntimeError(f"request {request_id}: invalid retry attempt sequence")
        arm = str(row.get("model"))
        provider_non_success_attempts[arm] += sum(
            not is_successful_capture(capture) for capture in request_captures
        )
        provider_transient_attempts[arm] += sum(
            is_transient_capture(capture) for capture in request_captures
        )
        if len(request_captures) > 1:
            retried_requests[arm] += 1
            retry_requests = [capture.get("request") for capture in request_captures]
            if any(not isinstance(value, dict) for value in retry_requests):
                raise RuntimeError(
                    f"request {request_id}: retry attempt is missing upstream request"
                )
            first_upstream = retry_requests[0]
            for attempt_number, upstream in enumerate(retry_requests[1:], start=2):
                if any(
                    upstream.get(field) != first_upstream.get(field)
                    for field in ("body", "method", "url")
                ):
                    raise RuntimeError(
                        f"request {request_id}: retry attempt {attempt_number} "
                        "changed upstream request bytes or destination"
                    )
        final_capture = max(
            request_captures,
            key=lambda capture: int(capture.get("context", {}).get("attempt", 0)),
        )
        if not is_successful_capture(final_capture):
            if args.allow_external_retries:
                pending_external_retries.append((index - 1, row))
            elif is_transient_capture(final_capture):
                raise RuntimeError(
                    f"request {request_id}: exhausted retries on provider infrastructure failure"
                )
            else:
                response = final_capture.get("response")
                status = (
                    response.get("status") if isinstance(response, dict) else None
                )
                raise RuntimeError(
                    f"request {request_id}: provider request ended with non-success "
                    f"status: {status}"
                )
    for failed_index, failed in pending_external_retries:
        failed_at = parse_timestamp(failed.get("completedAt"), "completedAt")
        recovered = False
        for later in request_rows[failed_index + 1 :]:
            if (
                later.get("model") != failed.get("model")
                or later.get("requestBody") != failed.get("requestBody")
                or later.get("status") != 200
            ):
                continue
            delay = (
                parse_timestamp(later.get("completedAt"), "completedAt") - failed_at
            ).total_seconds()
            if 0 <= delay <= args.external_retry_max_delay_seconds:
                recovered_external_retries[str(failed.get("model"))] += 1
                recovered = True
                break
        if not recovered:
            raise RuntimeError(
                f"request {failed.get('requestId')}: provider failure was not "
                "recovered by a timely byte-identical external retry"
            )
    require_unique(request_ids, "requestId")
    require_unique(referenced_capture_ids, "capture reference")

    unreferenced = sorted(set(capture_ids) - set(referenced_capture_ids))
    live_unreferenced: list[str] = []
    if unreferenced and args.allow_live_write_window_seconds > 0:
        snapshot_time = datetime.now(timezone.utc)
        known_request_ids = set(request_ids)
        for capture_id in unreferenced:
            capture = captures_by_id[capture_id]
            context = capture.get("context")
            try:
                age_seconds = (
                    snapshot_time
                    - parse_timestamp(capture.get("capturedAt"), "capturedAt")
                ).total_seconds()
            except RuntimeError:
                continue
            if (
                isinstance(context, dict)
                and isinstance(context.get("jobKey"), str)
                and context["jobKey"] not in known_request_ids
                and 0 <= age_seconds <= args.allow_live_write_window_seconds
            ):
                live_unreferenced.append(capture_id)
    stale_unreferenced = sorted(set(unreferenced) - set(live_unreferenced))
    if stale_unreferenced:
        preview = ", ".join(stale_unreferenced[:5])
        raise RuntimeError(f"unreferenced provider captures: {preview}")
    if observed_models != expected_models:
        raise RuntimeError(
            "model coverage mismatch: "
            f"expected {sorted(expected_models)}, observed {sorted(observed_models)}"
        )

    raw_files = [args.capture.read_bytes(), args.requests.read_bytes()]
    checked_secret_names: list[str] = []
    for name in args.secret_env:
        secret = os.getenv(name)
        if not secret:
            raise RuntimeError(f"secret environment variable is unset: {name}")
        encoded = secret.encode()
        if any(encoded in raw for raw in raw_files):
            raise RuntimeError(f"exact secret value retained from environment: {name}")
        checked_secret_names.append(name)

    print(
        json.dumps(
            {
                "captureCount": len(capture_rows),
                "checkedSecretEnvironmentVariables": checked_secret_names,
                "models": sorted(observed_models),
                "liveUnreferencedCaptureCount": len(live_unreferenced),
                "liveWriteWindowSeconds": args.allow_live_write_window_seconds,
                "requestCount": len(request_rows),
                "providerTransientAttemptsByModel": dict(
                    sorted(provider_transient_attempts.items())
                ),
                "providerNonSuccessAttemptsByModel": dict(
                    sorted(provider_non_success_attempts.items())
                ),
                "providerFinalSuccessRequired": True,
                "recoveredExternalRetriesByModel": dict(
                    sorted(recovered_external_retries.items())
                ),
                "retryRequestIdentityFields": ["body", "method", "url"],
                "retriedRequestsByModel": dict(sorted(retried_requests.items())),
                "status": (
                    "valid-live-write-window"
                    if live_unreferenced
                    else "valid"
                ),
                "statusCounts": {
                    str(status): count for status, count in sorted(status_counts.items())
                },
                "suite": args.expected_suite,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
