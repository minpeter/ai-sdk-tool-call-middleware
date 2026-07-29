#!/usr/bin/env python3
"""Capture one pinned ACEBench row without creating benchmark score rows."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
from typing import Any
from urllib.parse import urlparse

from acebench_official_native import (
    ACE_ROOT,
    NativeAgent,
    NativeUser,
    PROVIDER_MAX_TOKENS,
)


PINNED_COMMIT = "56dd66cf6439b0d9655ee1b353e4cd745c6f664e"
PINNED_TASK_SET_SHA256 = (
    "3967082cc1ed8e4a532ae290f099947241d6fe12e23e08f10c7109f5d7f01b74"
)
LOOPBACK_API_KEY = "acebench-loopback-only"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def canonical_sha256(value: Any) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected an object")
    return value


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.is_file():
        return rows
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise RuntimeError(f"{path}:{line_number}: expected an object")
            rows.append(value)
    return rows


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


def require_loopback_base_url(value: str) -> None:
    parsed = urlparse(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
        or not parsed.path.rstrip("/").endswith("/v1")
    ):
        raise RuntimeError("preflight base URL must be a loopback HTTP /v1 endpoint")


def require_pinned_row(
    manifest_path: Path, *, category: str, language: str, task_id: str
) -> dict[str, Any]:
    manifest = read_object(manifest_path)
    if (
        manifest.get("commit") != PINNED_COMMIT
        or manifest.get("rowCount") != 2040
        or manifest.get("taskSetSha256") != PINNED_TASK_SET_SHA256
    ):
        raise RuntimeError("ACEBench manifest is not the pinned full population")
    revision = subprocess.check_output(
        ["git", "-C", str(ACE_ROOT), "rev-parse", "HEAD"], text=True
    ).strip()
    if revision != PINNED_COMMIT:
        raise RuntimeError("ACEBench checkout revision drifted")
    matches = [
        row
        for row in manifest.get("rows", [])
        if isinstance(row, dict)
        and row.get("category") == category
        and row.get("language") == language
        and row.get("id") == task_id
    ]
    if len(matches) != 1:
        raise RuntimeError("preflight row is not unique in the pinned manifest")
    manifest_row = matches[0]
    source = ACE_ROOT / "data_all" / f"data_{language}" / f"data_{category}.json"
    rows = read_jsonl(source)
    source_line = manifest_row.get("sourceLine")
    if not isinstance(source_line, int) or not 1 <= source_line <= len(rows):
        raise RuntimeError("preflight manifest source line is invalid")
    row = rows[source_line - 1]
    if row.get("id") != task_id or canonical_sha256(row) != manifest_row.get(
        "rowSha256"
    ):
        raise RuntimeError("preflight row bytes do not match the pinned manifest")
    if "multi_turn" not in task_id or "agent" not in task_id:
        raise RuntimeError("preflight row must exercise assistant and user simulator")
    return row


def provider_body(capture: dict[str, Any]) -> dict[str, Any]:
    request = capture.get("request")
    if not isinstance(request, dict) or not isinstance(request.get("body"), str):
        raise RuntimeError("provider capture request body is missing")
    body = json.loads(request["body"])
    if not isinstance(body, dict):
        raise RuntimeError("provider request body is not an object")
    return body


def validate_capture(
    bridge_root: Path, *, expected_models: set[str]
) -> dict[str, Any]:
    requests = read_jsonl(bridge_root / "requests.jsonl")
    captures = read_jsonl(bridge_root / "provider-raw.jsonl")
    if not requests or not captures:
        raise RuntimeError("preflight did not produce fresh bridge and provider rows")
    captures_by_id: dict[str, dict[str, Any]] = {}
    for capture in captures:
        capture_id = capture.get("captureId")
        if not isinstance(capture_id, str) or capture_id in captures_by_id:
            raise RuntimeError("provider capture IDs are missing or duplicated")
        if provider_body(capture).get("max_tokens") != PROVIDER_MAX_TOKENS:
            raise RuntimeError("actual provider request did not use max_tokens=16384")
        captures_by_id[capture_id] = capture

    linked_ids: set[str] = set()
    observed_models: set[str] = set()
    success_by_model: set[str] = set()
    for request in requests:
        request_id = request.get("requestId")
        request_body = request.get("requestBody")
        capture_ids = request.get("upstreamCaptureIds")
        if not isinstance(request_id, str) or not isinstance(request_body, str):
            raise RuntimeError("bridge request identity is missing")
        body = json.loads(request_body)
        if not isinstance(body, dict) or body.get("max_tokens") != PROVIDER_MAX_TOKENS:
            raise RuntimeError("loopback request did not use max_tokens=16384")
        model = body.get("model")
        if not isinstance(model, str):
            raise RuntimeError("loopback request model is missing")
        observed_models.add(model)
        if request.get("status") == 200:
            success_by_model.add(model)
        if not isinstance(capture_ids, list) or not capture_ids:
            raise RuntimeError("bridge request has no linked provider capture")
        for capture_id in capture_ids:
            if not isinstance(capture_id, str) or capture_id not in captures_by_id:
                raise RuntimeError("bridge request references an unknown capture")
            context = captures_by_id[capture_id].get("context")
            if not isinstance(context, dict) or context.get("jobKey") != request_id:
                raise RuntimeError("provider capture job linkage is invalid")
            linked_ids.add(capture_id)
    if linked_ids != set(captures_by_id):
        raise RuntimeError("provider capture contains an unlinked historical row")
    if observed_models != expected_models or success_by_model != expected_models:
        raise RuntimeError("assistant and simulator were not both freshly successful")
    return {
        "bridgeRequestRows": len(requests),
        "capVerified": PROVIDER_MAX_TOKENS,
        "linkedCaptureRows": len(linked_ids),
        "modelsObserved": sorted(observed_models),
        "providerCaptureRows": len(captures),
        "zeroReuseVerified": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--bridge-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--arm", default="glm52-prompt-only-FC")
    parser.add_argument("--language", choices=("en", "zh"), default="en")
    parser.add_argument("--category", default="agent_multi_turn")
    parser.add_argument("--task-id", default="agent_multi_turn_0")
    args = parser.parse_args()

    require_loopback_base_url(args.base_url)
    if args.output.exists() or args.output.is_symlink():
        raise RuntimeError("refusing to overwrite a preflight result")
    if read_jsonl(args.bridge_root / "requests.jsonl") or read_jsonl(
        args.bridge_root / "provider-raw.jsonl"
    ):
        raise RuntimeError("preflight bridge root is not fresh")
    row = require_pinned_row(
        args.manifest.resolve(),
        category=args.category,
        language=args.language,
        task_id=args.task_id,
    )
    started_at = now()
    os.environ["OPENAI_API_KEY"] = LOOPBACK_API_KEY
    os.environ["OPENAI_BASE_URL"] = args.base_url
    user = NativeUser(
        involved_classes=list(row["involved_classes"]),
        language=args.language,
        model_name="glm52-simulator",
        max_tokens=PROVIDER_MAX_TOKENS,
    )
    initial_message = user.get_init_prompt(str(row["question"]))
    agent = NativeAgent(
        model_name=args.arm,
        functions=list(row["function"]),
        involved_classes=list(row["involved_classes"]),
        language=args.language,
        temperature=0.001,
        top_p=1,
        max_tokens=PROVIDER_MAX_TOKENS,
    )
    agent.respond(initial_message)
    evidence = validate_capture(
        args.bridge_root,
        expected_models={args.arm, "glm52-simulator"},
    )
    output = {
        **evidence,
        "arm": args.arm,
        "benchmarkOutput": False,
        "completedAt": now(),
        "language": args.language,
        "populationContribution": 0,
        "scoreDisclosure": "not-applicable-preflight-only",
        "startedAt": started_at,
        "status": "valid-one-row-cap-linkage-preflight",
        "taskId": args.task_id,
        "taskSetSha256": PINNED_TASK_SET_SHA256,
    }
    write_exclusive(args.output, output)
    print(
        json.dumps(
            {
                "bridgeRequestRows": output["bridgeRequestRows"],
                "capVerified": output["capVerified"],
                "modelsObserved": output["modelsObserved"],
                "providerCaptureRows": output["providerCaptureRows"],
                "status": output["status"],
                "zeroReuseVerified": output["zeroReuseVerified"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
