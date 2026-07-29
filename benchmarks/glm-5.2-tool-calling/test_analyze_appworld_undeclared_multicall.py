#!/usr/bin/env python3
"""Regression coverage for AppWorld undeclared adjacent tool-call diagnostics."""

from __future__ import annotations

from importlib import import_module
import json
from pathlib import Path
import tempfile
import unittest


HEALTH = import_module("analyze_agentic_longrunning_parser_health")

DECLARED_TOOLS = (
    "supervisor__complete_task",
    "supervisor__show_profile",
    "supervisor__show_account_passwords",
    "amazon__login",
    "amazon__show_cart",
    "amazon__place_order",
)
DIAGNOSTIC = (
    "Could not parse GLM-5.2 tool call. "
    + json.dumps(
        {
            "dropReason": "malformed-glm5-tool-call",
            "toolCall": (
                "<tool_call>supervisor__show_addresses</tool_call>"
                "<tool_call>supervisor__show_payment_cards</tool_call>"
            ),
        },
        separators=(",", ":"),
    )
)


def request_body() -> str:
    return json.dumps(
        {
            "messages": [{"role": "user", "content": "fixture"}],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": name,
                        "parameters": {
                            "type": "object",
                            "properties": {},
                            "required": [],
                        },
                    },
                }
                for name in DECLARED_TOOLS
            ],
        },
        separators=(",", ":"),
    )


class AppWorldUndeclaredMultiCallTest(unittest.TestCase):
    def test_adjacent_undeclared_bare_calls_are_not_a_parser_regression(self) -> None:
        self.assertEqual(
            HEALTH.parser_event_class(DIAGNOSTIC, set(DECLARED_TOOLS)),
            "model_output_passthrough",
        )

    def test_bridge_audit_classifies_the_live_shape_without_retaining_body(self) -> None:
        request = {
            "requestId": "request",
            "model": "glm52-native-plus",
            "status": 200,
            "latencyMs": 1,
            "parserErrors": [DIAGNOSTIC],
            "requestBody": request_body(),
            "upstreamCaptureIds": ["capture"],
        }
        capture = {
            "captureId": "capture",
            "capturedAt": "2026-07-18T09:00:00+00:00",
            "context": {"jobKey": "request"},
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "requests.jsonl").write_text(
                json.dumps(request) + "\n", encoding="utf-8"
            )
            (root / "provider-raw.jsonl").write_text(
                json.dumps(capture) + "\n", encoding="utf-8"
            )
            result = HEALTH.bridge_health("fixture", root)

        model = result["models"]["glm52-native-plus"]
        self.assertEqual(
            model["parserEventClasses"], {"model_output_passthrough": 1}
        )
        self.assertNotIn("requestBody", result)


if __name__ == "__main__":
    unittest.main()
