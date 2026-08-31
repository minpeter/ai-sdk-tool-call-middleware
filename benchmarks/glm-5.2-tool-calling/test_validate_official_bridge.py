#!/usr/bin/env python3
"""Regression tests for strict official bridge validation."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


SCRIPT = Path(__file__).with_name("validate_official_bridge.py")
SUITE = "validator-test"
MODEL = "glm52-native"


def capture(
    capture_id: str,
    request_id: str,
    *,
    attempt: int,
    body: str,
    captured_at: str,
    status: int | None = 200,
    transport_error: str | None = None,
) -> dict[str, Any]:
    value: dict[str, Any] = {
        "captureId": capture_id,
        "capturedAt": captured_at,
        "context": {
            "arm": "native",
            "attempt": attempt,
            "jobKey": request_id,
            "suite": SUITE,
        },
        "request": {
            "body": body,
            "headers": {"content-type": "application/json"},
            "method": "POST",
            "url": "https://example.invalid/v1/chat/completions",
        },
    }
    if status is not None:
        value["response"] = {
            "body": "{}",
            "headers": {"content-type": "application/json"},
            "status": status,
        }
    if transport_error is not None:
        value["transportError"] = transport_error
    return value


def request(
    request_id: str,
    capture_ids: list[str],
    *,
    body: str,
    completed_at: str,
    status: int,
) -> dict[str, Any]:
    return {
        "completedAt": completed_at,
        "model": MODEL,
        "requestBody": body,
        "requestId": request_id,
        "status": status,
        "suite": SUITE,
        "upstreamCaptureIds": capture_ids,
    }


class OfficialBridgeValidatorTest(unittest.TestCase):
    def run_validator(
        self,
        captures: list[dict[str, Any]],
        requests: list[dict[str, Any]],
        *,
        allow_external_retries: bool = False,
        live_write_window_seconds: float = 0,
    ) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            capture_path = root / "provider-raw.jsonl"
            request_path = root / "requests.jsonl"
            capture_path.write_text(
                "".join(json.dumps(row) + "\n" for row in captures),
                encoding="utf-8",
            )
            request_path.write_text(
                "".join(json.dumps(row) + "\n" for row in requests),
                encoding="utf-8",
            )
            command = [
                sys.executable,
                str(SCRIPT),
                "--capture",
                str(capture_path),
                "--requests",
                str(request_path),
                "--expected-suite",
                SUITE,
                "--expected-models",
                MODEL,
            ]
            if allow_external_retries:
                command.append("--allow-external-retries")
            if live_write_window_seconds:
                command.extend(
                    [
                        "--allow-live-write-window-seconds",
                        str(live_write_window_seconds),
                    ]
                )
            return subprocess.run(command, text=True, capture_output=True)

    def test_internal_retry_requires_identical_upstream_request(self) -> None:
        body = '{"messages":[{"role":"user","content":"test"}]}'
        captures = [
            capture(
                "capture-1",
                "request-1",
                attempt=1,
                body=body,
                captured_at="2026-01-01T00:00:00Z",
                status=None,
                transport_error="TimeoutError: timed out",
            ),
            capture(
                "capture-2",
                "request-1",
                attempt=2,
                body=body,
                captured_at="2026-01-01T00:00:05Z",
            ),
        ]
        requests = [
            request(
                "request-1",
                ["capture-1", "capture-2"],
                body=body,
                completed_at="2026-01-01T00:00:06Z",
                status=200,
            )
        ]
        result = self.run_validator(captures, requests)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output["retriedRequestsByModel"], {MODEL: 1})
        self.assertEqual(output["providerNonSuccessAttemptsByModel"], {MODEL: 1})

        captures[1]["request"]["body"] = '{"messages":[]}'
        result = self.run_validator(captures, requests)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("changed upstream request bytes", result.stderr)

    def test_external_402_must_be_recovered_by_same_model_and_body(self) -> None:
        body = '{"messages":[{"role":"user","content":"retry"}]}'
        captures = [
            capture(
                "capture-failed",
                "request-failed",
                attempt=1,
                body=body,
                captured_at="2026-01-01T00:00:00Z",
                status=402,
            ),
            capture(
                "capture-recovered",
                "request-recovered",
                attempt=1,
                body=body,
                captured_at="2026-01-01T00:00:05Z",
                status=200,
            ),
        ]
        requests = [
            request(
                "request-failed",
                ["capture-failed"],
                body=body,
                completed_at="2026-01-01T00:00:01Z",
                status=502,
            ),
            request(
                "request-recovered",
                ["capture-recovered"],
                body=body,
                completed_at="2026-01-01T00:00:06Z",
                status=200,
            ),
        ]
        result = self.run_validator(
            captures, requests, allow_external_retries=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output["recoveredExternalRetriesByModel"], {MODEL: 1})

        result = self.run_validator(captures[:1], requests[:1])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("non-success status: 402", result.stderr)

        result = self.run_validator(
            captures[:1], requests[:1], allow_external_retries=True
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("was not recovered", result.stderr)

    def test_live_window_only_allows_recent_unfinished_job_captures(self) -> None:
        now = datetime.now(timezone.utc)
        body = '{"messages":[{"role":"user","content":"in flight"}]}'
        completed_capture = capture(
            "capture-complete",
            "request-complete",
            attempt=1,
            body=body,
            captured_at=(now - timedelta(seconds=5)).isoformat(),
        )
        completed_request = request(
            "request-complete",
            ["capture-complete"],
            body=body,
            completed_at=(now - timedelta(seconds=4)).isoformat(),
            status=200,
        )
        recent = capture(
            "capture-inflight",
            "request-inflight",
            attempt=1,
            body=body,
            captured_at=now.isoformat(),
        )
        strict = self.run_validator(
            [completed_capture, recent], [completed_request]
        )
        self.assertNotEqual(strict.returncode, 0)

        live = self.run_validator(
            [completed_capture, recent],
            [completed_request],
            live_write_window_seconds=600,
        )
        self.assertEqual(live.returncode, 0, live.stderr)
        output = json.loads(live.stdout)
        self.assertEqual(output["status"], "valid-live-write-window")
        self.assertEqual(output["liveUnreferencedCaptureCount"], 1)

        recent["capturedAt"] = (now - timedelta(hours=1)).isoformat()
        stale = self.run_validator(
            [completed_capture, recent],
            [completed_request],
            live_write_window_seconds=600,
        )
        self.assertNotEqual(stale.returncode, 0)
        self.assertIn("unreferenced provider captures", stale.stderr)


if __name__ == "__main__":
    unittest.main()
