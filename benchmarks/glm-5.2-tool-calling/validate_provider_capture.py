#!/usr/bin/env python3
"""Validate credential-free provider captures and result-row linkage."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit


CAPTURED_REQUEST_HEADERS = {"accept", "content-type", "user-agent"}
SECRET_NAME = re.compile(
    r"(?:api[_-]?key|authorization|credential|password|secret|token)", re.I
)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"row {line_number} is not an object")
            rows.append(value)
    return rows


def environment_secret_values() -> list[str]:
    return sorted(
        {
            value
            for name, value in os.environ.items()
            if len(value) >= 4 and SECRET_NAME.search(name)
        },
        key=len,
        reverse=True,
    )


def expected_capture_identity(row: dict[str, Any]) -> tuple[str, str] | None:
    arm = row.get("arm")
    if not isinstance(arm, str):
        return None
    if isinstance(row.get("taskId"), str):
        return (
            "mcpmark",
            f'{row["taskId"]}\0{arm}\0{int(row.get("trial", 1))}',
        )
    if all(
        isinstance(row.get(field), str)
        for field in ("language", "category", "caseId")
    ):
        return (
            "ace",
            f'{row["language"]}\0{row["category"]}\0{row["caseId"]}\0{arm}',
        )
    if all(isinstance(row.get(field), str) for field in ("category", "caseId")):
        return (
            "bfcl",
            f'{row["category"]}\0{row["caseId"]}\0{arm}\0{int(row.get("trial", 1))}',
        )
    return None


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Validate provider-raw.jsonl structure, linkage, and credential removal"
    )
    parser.add_argument("--capture", required=True, type=Path)
    parser.add_argument("--result-raw", type=Path)
    parser.add_argument("--expected-arms", default="native,glm5")
    args = parser.parse_args()

    captures = load_jsonl(args.capture)
    errors: list[str] = []
    capture_ids: list[str] = []
    capture_by_id: dict[str, dict[str, Any]] = {}
    arms: Counter[str] = Counter()
    media: Counter[str] = Counter()
    for index, row in enumerate(captures, 1):
        capture_id = row.get("captureId")
        context = row.get("context")
        request = row.get("request")
        response = row.get("response")
        if row.get("formatVersion") != 1:
            errors.append(f"row {index}: unsupported formatVersion")
        if not isinstance(capture_id, str) or not capture_id:
            errors.append(f"row {index}: captureId must be a non-empty string")
        else:
            capture_ids.append(capture_id)
            capture_by_id[capture_id] = row
        if not isinstance(context, dict) or not isinstance(context.get("arm"), str):
            errors.append(f"row {index}: context.arm must be a string")
        else:
            arms[str(context["arm"])] += 1
        if not isinstance(request, dict):
            errors.append(f"row {index}: request must be an object")
            continue
        headers = request.get("headers")
        if not isinstance(headers, dict):
            errors.append(f"row {index}: request.headers must be an object")
        else:
            unexpected_headers = sorted(
                str(name)
                for name in headers
                if str(name).lower() not in CAPTURED_REQUEST_HEADERS
            )
            if unexpected_headers:
                errors.append(
                    f"row {index}: unexpected captured request headers {unexpected_headers}"
                )
            if any(SECRET_NAME.search(str(name)) for name in headers):
                errors.append(f"row {index}: credential-like request header name")
        url = request.get("url")
        if not isinstance(url, str):
            errors.append(f"row {index}: request.url must be a string")
        elif any(SECRET_NAME.search(name) for name, _ in parse_qsl(urlsplit(url).query)):
            errors.append(f"row {index}: credential-like URL query name")
        if isinstance(response, dict):
            response_headers = response.get("headers")
            content_type = (
                response_headers.get("content-type", "")
                if isinstance(response_headers, dict)
                else ""
            )
            if "text/event-stream" in str(content_type):
                media["sse"] += 1
            elif "json" in str(content_type):
                media["json"] += 1
            else:
                media["other"] += 1
        else:
            media["transportError"] += 1

    duplicate_ids = len(capture_ids) - len(set(capture_ids))
    if duplicate_ids:
        errors.append(f"duplicate capture IDs: {duplicate_ids}")

    capture_text = args.capture.read_text(encoding="utf-8")
    leaked_environment_values = sum(
        secret in capture_text for secret in environment_secret_values()
    )
    if leaked_environment_values:
        errors.append(
            "capture contains one or more credential values from the current environment"
        )

    linkage = {
        "checked": args.result_raw is not None,
        "missingCaptureReferences": 0,
        "mismatchedCaptureReferences": 0,
        "duplicateCaptureReferences": 0,
        "unreferencedCaptures": 0,
        "successfulRowsWithoutCapture": 0,
    }
    leaked_result_environment_values = 0
    if args.result_raw is not None:
        result_text = args.result_raw.read_text(encoding="utf-8")
        leaked_result_environment_values = sum(
            secret in result_text for secret in environment_secret_values()
        )
        if leaked_result_environment_values:
            errors.append(
                "result raw data contains one or more credential values from the current environment"
            )
        results = load_jsonl(args.result_raw)
        expected_arms = {
            arm.strip() for arm in args.expected_arms.split(",") if arm.strip()
        }
        referenced: set[str] = set()
        reference_counts: Counter[str] = Counter()
        for index, row in enumerate(results, 1):
            if row.get("arm") not in expected_arms:
                continue
            ids = row.get("rawCaptureIds")
            if ids is None and isinstance(row.get("attempts"), list):
                ids = [
                    capture_id
                    for attempt in row["attempts"]
                    if isinstance(attempt, dict)
                    and isinstance(attempt.get("rawCaptureIds"), list)
                    for capture_id in attempt["rawCaptureIds"]
                ]
            if not isinstance(ids, list) or not all(
                isinstance(item, str) for item in ids
            ):
                errors.append(f"result row {index}: rawCaptureIds must be a string array")
                continue
            referenced.update(ids)
            reference_counts.update(ids)
            expected_identity = expected_capture_identity(row)
            if expected_identity is None:
                errors.append(
                    f"result row {index}: could not derive benchmark capture identity"
                )
            else:
                expected_suite, expected_job_key = expected_identity
                expected_transport = str(row.get("transport") or "generate")
                for capture_id in ids:
                    capture_row = capture_by_id.get(capture_id)
                    if capture_row is None:
                        continue
                    context = capture_row.get("context")
                    if not isinstance(context, dict) or any(
                        (
                            context.get("arm") != row.get("arm"),
                            context.get("jobKey") != expected_job_key,
                            context.get("suite") != expected_suite,
                            context.get("transport") != expected_transport,
                        )
                    ):
                        linkage["mismatchedCaptureReferences"] += 1
            if (
                row.get("transportOk") is True
                or row.get("verificationPassed") is True
            ) and not ids:
                linkage["successfulRowsWithoutCapture"] += 1
        known = set(capture_ids)
        linkage["missingCaptureReferences"] = len(referenced - known)
        linkage["unreferencedCaptures"] = len(known - referenced)
        linkage["duplicateCaptureReferences"] = sum(
            count - 1 for count in reference_counts.values() if count > 1
        )
        if (
            linkage["missingCaptureReferences"]
            or linkage["mismatchedCaptureReferences"]
            or linkage["duplicateCaptureReferences"]
            or linkage["successfulRowsWithoutCapture"]
        ):
            errors.append("capture/result linkage is incomplete")

    report = {
        "valid": not errors,
        "captureRows": len(captures),
        "arms": dict(sorted(arms.items())),
        "media": dict(sorted(media.items())),
        "duplicateCaptureIds": duplicate_ids,
        "environmentSecretValuesChecked": len(environment_secret_values()),
        "environmentSecretValuesLeaked": leaked_environment_values,
        "resultEnvironmentSecretValuesLeaked": leaked_result_environment_values,
        "linkage": linkage,
        "errors": errors,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
