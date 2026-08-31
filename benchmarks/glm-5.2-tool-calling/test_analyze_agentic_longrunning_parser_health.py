#!/usr/bin/env python3

from datetime import datetime, timedelta, timezone
from importlib import import_module
import json
from pathlib import Path
import tempfile
from typing import Any, Callable, cast
import unittest

HEALTH = import_module("analyze_agentic_longrunning_parser_health")
appworld_lifecycle = cast(
    Callable[[Path], dict[str, Any]], getattr(HEALTH, "appworld_lifecycle")
)
bridge_health = cast(
    Callable[[str, Path], dict[str, Any]], getattr(HEALTH, "bridge_health")
)
declared_tool_names = cast(
    Callable[[dict[str, Any]], set[str] | None],
    getattr(HEALTH, "declared_tool_names"),
)
diagnostic_tool_name = cast(
    Callable[[str], str | None], getattr(HEALTH, "diagnostic_tool_name")
)
parser_event_class = cast(
    Callable[..., str], getattr(HEALTH, "parser_event_class")
)
terminal_benchmark_name = cast(
    Callable[[Path], str], getattr(HEALTH, "terminal_benchmark_name")
)


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


def capture(
    capture_id: str,
    job_key: str,
    captured_at: str,
    *,
    attempt: int = 1,
    body: str = '{"model":"fixture"}',
) -> dict[str, Any]:
    return {
        "captureId": capture_id,
        "capturedAt": captured_at,
        "context": {"attempt": attempt, "jobKey": job_key},
        "request": {"body": body},
    }


def request(request_id: str, capture_ids: list[str]) -> dict[str, Any]:
    return {
        "requestId": request_id,
        "model": "glm52-native-plus",
        "status": 200,
        "upstreamCaptureIds": capture_ids,
    }


def request_with_tool_diagnostic(
    request_id: str, declared_name: str, attempted_name: str
) -> dict[str, Any]:
    return {
        **request(request_id, [f"capture-{request_id}"]),
        "parserErrors": [
            "Could not parse GLM-5.2 tool call. "
            + json.dumps(
                {
                    "dropReason": "malformed-glm5-tool-call",
                    "toolCall": (
                        f"<tool_call>{attempted_name}"
                        "<arg_key>value</arg_key><arg_value>1</arg_value>"
                        "</tool_call>"
                    ),
                }
            )
        ],
        "requestBody": json.dumps(
            {
                "tools": [
                    {
                        "type": "function",
                        "function": {"name": declared_name},
                    }
                ]
            }
        ),
    }


class LiveBridgeLinkageTest(unittest.TestCase):
    def run_health(
        self,
        captures: list[dict[str, Any]],
        requests: list[dict[str, Any]],
        *,
        producer_alive: bool = True,
        snapshot_time: datetime | None = None,
    ) -> dict[str, Any]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_jsonl(root / "provider-raw.jsonl", captures)
            write_jsonl(root / "requests.jsonl", requests)
            return bridge_health(
                "fixture",
                root,
                producer_alive=producer_alive,
                snapshot_time=snapshot_time,
            )

    def test_internal_retry_is_exact_without_count_parity(self) -> None:
        timestamp = datetime.now(timezone.utc).isoformat()
        result = self.run_health(
            [
                capture("a", "r", timestamp, attempt=1),
                capture("b", "r", timestamp, attempt=2),
            ],
            [request("r", ["a", "b"])],
        )
        self.assertEqual(result["linkageStatus"], "exact")

    def test_multiple_recent_inflight_captures_are_live_window(self) -> None:
        timestamp = datetime.now(timezone.utc).isoformat()
        result = self.run_health(
            [
                capture("a", "pending-a", timestamp),
                capture("b", "pending-b", timestamp),
            ],
            [],
        )
        self.assertEqual(
            result["linkageStatus"], "provisional-live-write-window"
        )

    def test_920_second_retry_capture_is_provisional_while_live(self) -> None:
        snapshot_time = datetime(2026, 7, 18, tzinfo=timezone.utc)
        result = self.run_health(
            [
                capture(
                    "a",
                    "pending",
                    (snapshot_time - timedelta(seconds=920)).isoformat(),
                )
            ],
            [],
            snapshot_time=snapshot_time,
        )
        self.assertEqual(
            result["linkageStatus"], "provisional-live-write-window"
        )
        self.assertEqual(result["liveWriteThresholdSeconds"], 1020)

    def test_375_second_byte_identical_retry_is_exact_when_linked(self) -> None:
        timestamp = datetime.now(timezone.utc).isoformat()
        result = self.run_health(
            [
                capture("a", "r", timestamp, attempt=1, body="same"),
                capture("b", "r", timestamp, attempt=2, body="same"),
                capture("c", "r", timestamp, attempt=3, body="same"),
            ],
            [request("r", ["a", "b", "c"])],
        )
        self.assertEqual(result["linkageStatus"], "exact")

    def test_26_and_6_second_captures_are_provisional_while_live(self) -> None:
        snapshot_time = datetime(2026, 7, 18, tzinfo=timezone.utc)
        result = self.run_health(
            [
                capture(
                    "a",
                    "pending-a",
                    (snapshot_time - timedelta(seconds=26)).isoformat(),
                ),
                capture(
                    "b",
                    "pending-b",
                    (snapshot_time - timedelta(seconds=6)).isoformat(),
                ),
            ],
            [],
            snapshot_time=snapshot_time,
        )
        self.assertEqual(
            result["linkageStatus"], "provisional-live-write-window"
        )

    def test_capture_older_than_1020_seconds_is_invalid(self) -> None:
        snapshot_time = datetime(2026, 7, 18, tzinfo=timezone.utc)
        result = self.run_health(
            [
                capture(
                    "a",
                    "orphan",
                    (snapshot_time - timedelta(seconds=1021)).isoformat(),
                )
            ],
            [],
            snapshot_time=snapshot_time,
        )
        self.assertEqual(result["linkageStatus"], "invalid")

    def test_recent_capture_is_invalid_after_producer_quiesces(self) -> None:
        timestamp = datetime.now(timezone.utc).isoformat()
        result = self.run_health(
            [capture("a", "orphan", timestamp)],
            [],
            producer_alive=False,
        )
        self.assertEqual(result["linkageStatus"], "invalid")

    def test_duplicate_and_unresolved_capture_ids_are_invalid(self) -> None:
        timestamp = datetime.now(timezone.utc).isoformat()
        duplicate = self.run_health(
            [capture("a", "r", timestamp)],
            [request("r", ["a", "a"])],
        )
        unresolved = self.run_health([], [request("r", ["missing"])])
        self.assertEqual(duplicate["linkageStatus"], "invalid")
        self.assertEqual(unresolved["linkageStatus"], "invalid")

    def test_job_attempt_and_retry_body_invariants_fail_closed(self) -> None:
        timestamp = datetime.now(timezone.utc).isoformat()
        job_mismatch = self.run_health(
            [capture("a", "different", timestamp)],
            [request("r", ["a"])],
        )
        attempt_gap = self.run_health(
            [capture("a", "r", timestamp, attempt=2)],
            [request("r", ["a"])],
        )
        body_mismatch = self.run_health(
            [
                capture("a", "r", timestamp, attempt=1, body="first"),
                capture("b", "r", timestamp, attempt=2, body="second"),
            ],
            [request("r", ["a", "b"])],
        )
        self.assertEqual(job_mismatch["linkageStatus"], "invalid")
        self.assertEqual(attempt_gap["linkageStatus"], "invalid")
        self.assertEqual(body_mismatch["linkageStatus"], "invalid")

    def test_stale_unreferenced_capture_is_invalid(self) -> None:
        result = self.run_health(
            [capture("a", "orphan", "2020-01-01T00:00:00Z")],
            [],
        )
        self.assertEqual(result["linkageStatus"], "invalid")


class ParserEventClassTest(unittest.TestCase):
    def test_model_output_passthrough_is_not_a_parser_failure(self) -> None:
        self.assertEqual(
            parser_event_class(
                'bridge tool-name pass-through: unmapped model output "unknown"'
            ),
            "model_output_passthrough",
        )
        self.assertEqual(
            parser_event_class(
                'bridge tool-input pass-through: non-object input for "Finish"'
            ),
            "model_output_passthrough",
        )

    def test_true_parser_failure_and_recovery_remain_distinct(self) -> None:
        self.assertEqual(
            parser_event_class("Could not parse GLM-5.2 tool call."),
            "parse_failure",
        )
        self.assertEqual(
            parser_event_class("Recovered malformed GLM-5.2 tool call."),
            "recovery",
        )

    def test_undeclared_canonical_tool_is_model_output_passthrough(self) -> None:
        message = str(
            request_with_tool_diagnostic(
                "request", "declared_tool", "hallucinated_tool"
            )["parserErrors"][0]
        )
        self.assertEqual(diagnostic_tool_name(message), "hallucinated_tool")
        self.assertEqual(
            parser_event_class(message, {"declared_tool"}),
            "model_output_passthrough",
        )
        self.assertEqual(
            parser_event_class(message, {"hallucinated_tool"}),
            "parse_failure",
        )

    def test_bridge_health_classifies_without_retaining_request_body(self) -> None:
        timestamp = datetime.now(timezone.utc).isoformat()
        row = request_with_tool_diagnostic(
            "request", "declared_tool", "hallucinated_tool"
        )
        result = LiveBridgeLinkageTest().run_health(
            [capture("capture-request", "request", timestamp)],
            [row],
        )
        model = result["models"]["glm52-native-plus"]
        self.assertEqual(
            model["parserEventClasses"], {"model_output_passthrough": 1}
        )
        self.assertNotIn("requestBody", result)

    def test_declared_tool_names_fail_closed_on_invalid_request_body(self) -> None:
        self.assertEqual(
            declared_tool_names(
                request_with_tool_diagnostic(
                    "request", "declared_tool", "hallucinated_tool"
                )
            ),
            {"declared_tool"},
        )
        self.assertIsNone(declared_tool_names({"requestBody": "not-json"}))

    def test_declared_tool_names_recovers_tools_after_invalid_messages(self) -> None:
        request_body = (
            '{"messages":[invalid],"tools":['
            '{"type":"function","function":{"name":"declared_tool"}}]}'
        )
        self.assertEqual(
            declared_tool_names({"requestBody": request_body}),
            {"declared_tool"},
        )


class AppWorldLifecycleTest(unittest.TestCase):
    def test_uses_experiment_names_from_current_run_meta(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "run-meta.json").write_text(
                json.dumps(
                    {
                        "experimentNames": [
                            "glm52-native-fresh-v6",
                            "glm52-native-plus-fresh-v6",
                        ]
                    }
                ),
                encoding="utf-8",
            )
            task = (
                root
                / "root/experiments/outputs/simplified_function_calling_agent/local"
                / "glm52-native-plus-fresh-v6/test_normal/tasks/task-1"
            )
            (task / "misc").mkdir(parents=True)
            (task / "misc/finished").touch()
            (task / "logs").mkdir()
            write_jsonl(task / "logs/api_calls.jsonl", [{"id": 1}])
            write_jsonl(task / "logs/lm_calls.jsonl", [{"id": 1}, {"id": 2}])

            result = appworld_lifecycle(root)

        self.assertEqual(
            result["models"]["glm52-native-plus"]["completedTrajectories"], 1
        )
        self.assertEqual(result["models"]["glm52-native-plus"]["totalApiCalls"], 1)
        self.assertEqual(result["models"]["glm52-native-plus"]["totalLmCalls"], 2)


class TerminalBenchmarkIdentityTest(unittest.TestCase):
    def test_uses_exact_active_run_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "run-meta.json").write_text(
                json.dumps({"benchmark": "Terminal-Bench 2.1"}),
                encoding="utf-8",
            )
            self.assertEqual(terminal_benchmark_name(root), "Terminal-Bench 2.1")

    def test_missing_metadata_falls_back_without_claiming_an_old_release(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(
                terminal_benchmark_name(Path(directory)),
                "Terminal-Bench 2.x",
            )


if __name__ == "__main__":
    unittest.main()
