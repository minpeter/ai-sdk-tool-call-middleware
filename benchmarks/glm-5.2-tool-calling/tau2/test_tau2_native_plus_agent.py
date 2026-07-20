from __future__ import annotations

import errno
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from unittest.mock import patch

from tau2.data_model.message import MultiToolMessage, ToolMessage, UserMessage
from tau2.environment.tool import as_tool

from tau2_native_plus_agent import (
    Tau2NativePlusAgent,
    create_tau2_glm5_agent,
    create_tau2_native_agent,
)
from tau3_openai_compat_agent import Tau3OpenAICompatAgent
from tau2_cli import configure_nl_judge_from_env


def get_weather(city: str) -> dict[str, str]:
    """Get the current weather for a city.

    Args:
        city: City to inspect.

    Returns:
        The current weather record.
    """

    return {"city": city, "condition": "sunny"}


class FixtureBridge:
    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self.requests: list[dict[str, Any]] = []
        self.responses = list(responses)
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers["content-length"])
                owner.requests.append(json.loads(self.rfile.read(length)))
                body = json.dumps(owner.responses.pop(0)).encode("utf-8")
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_: Any) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def origin(self) -> str:
        host, port = self.server.server_address
        return f"http://{host}:{port}"

    def __enter__(self) -> "FixtureBridge":
        self.thread.start()
        return self

    def __exit__(self, *_: Any) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class InProcessAgent(Tau2NativePlusAgent):
    def __init__(self, *args: Any, responses: list[dict[str, Any]], **kwargs: Any):
        super().__init__(*args, **kwargs)
        self.requests: list[dict[str, Any]] = []
        self.responses = list(responses)

    def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.requests.append(json.loads(json.dumps(payload)))
        return self.responses.pop(0)


def bridge_response(
    *,
    arm: str = "glm5",
    text: str = "",
    tool_calls: list[dict[str, Any]] | None = None,
    parser_errors: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "arm": arm,
        "finishReason": "tool-calls" if tool_calls else "stop",
        "model": "fixture-model",
        "parserErrors": parser_errors or [],
        "text": text,
        "toolCalls": tool_calls or [],
        "usage": {"inputTokens": 10, "outputTokens": 4, "totalTokens": 14},
    }


class Tau2NativePlusAgentTest(unittest.TestCase):
    def test_openai_compat_agent_round_trip(self) -> None:
        tool = as_tool(get_weather)
        fixture_response = {
            "id": "chatcmpl-fixture",
            "object": "chat.completion",
            "created": 0,
            "model": "glm52-native-plus",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "openai-1",
                                "type": "function",
                                "function": {
                                    "name": "get_weather",
                                    "arguments": '{"city":"Seoul"}',
                                },
                            }
                        ],
                    },
                }
            ],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 4,
                "total_tokens": 14,
            },
        }
        try:
            fixture = FixtureBridge([fixture_response])
        except OSError as error:
            if error.errno in {errno.EPERM, errno.EACCES}:
                self.skipTest(f"loopback bind unavailable: {error}")
            raise
        with fixture:
            agent = Tau3OpenAICompatAgent(
                [tool],
                "Weather only.",
                arm="glm5",
                base_url=f"{fixture.origin}/v1",
                timeout_seconds=10,
                max_tokens=128,
            )
            response, state = agent.generate_next_message(
                UserMessage.text("Weather in Seoul?"), agent.get_init_state()
            )
        self.assertEqual(response.tool_calls[0].id, "openai-1")
        self.assertEqual(response.tool_calls[0].arguments, {"city": "Seoul"})
        self.assertEqual(response.raw_data["arm"], "glm5")
        self.assertEqual(state.messages[-1]["role"], "assistant")
        self.assertEqual(len(fixture.requests), 1)

    def test_nl_judge_args_must_be_a_json_object(self) -> None:
        with patch.dict("os.environ", {"TAU2_NL_JUDGE_ARGS": "[]"}):
            with self.assertRaisesRegex(ValueError, "must be a JSON object"):
                configure_nl_judge_from_env()

    def test_nl_judge_env_overrides_both_import_time_constants(self) -> None:
        import tau2.config as config
        import tau2.evaluator.evaluator_nl_assertions as nl_evaluator

        old_config = (
            config.DEFAULT_LLM_NL_ASSERTIONS,
            config.DEFAULT_LLM_NL_ASSERTIONS_ARGS,
        )
        old_evaluator = (
            nl_evaluator.DEFAULT_LLM_NL_ASSERTIONS,
            nl_evaluator.DEFAULT_LLM_NL_ASSERTIONS_ARGS,
        )
        try:
            with patch.dict(
                "os.environ",
                {
                    "TAU2_NL_JUDGE_ARGS": '{"temperature":0,"seed":52}',
                    "TAU2_NL_JUDGE_MODEL": "openai/fixed-judge",
                },
            ):
                configure_nl_judge_from_env()
            self.assertEqual(config.DEFAULT_LLM_NL_ASSERTIONS, "openai/fixed-judge")
            self.assertEqual(
                config.DEFAULT_LLM_NL_ASSERTIONS_ARGS,
                {"temperature": 0, "seed": 52},
            )
            self.assertEqual(
                nl_evaluator.DEFAULT_LLM_NL_ASSERTIONS,
                config.DEFAULT_LLM_NL_ASSERTIONS,
            )
            self.assertEqual(
                nl_evaluator.DEFAULT_LLM_NL_ASSERTIONS_ARGS,
                config.DEFAULT_LLM_NL_ASSERTIONS_ARGS,
            )
        finally:
            (
                config.DEFAULT_LLM_NL_ASSERTIONS,
                config.DEFAULT_LLM_NL_ASSERTIONS_ARGS,
            ) = old_config
            (
                nl_evaluator.DEFAULT_LLM_NL_ASSERTIONS,
                nl_evaluator.DEFAULT_LLM_NL_ASSERTIONS_ARGS,
            ) = old_evaluator

    def test_zero_tool_text_only_response(self) -> None:
        agent = InProcessAgent(
            tools=[],
            domain_policy="Answer from the offline knowledge base context.",
            arm="glm5",
            model="fixture-model",
            responses=[bridge_response(text="Policy answer.")],
        )

        response, state = agent.generate_next_message(
            UserMessage.text("Explain the account policy."), agent.get_init_state()
        )

        self.assertEqual(response.content, "Policy answer.")
        self.assertIsNone(response.tool_calls)
        self.assertEqual(agent.requests[0]["tools"], [])
        self.assertEqual(state.messages[-1]["role"], "assistant")
        with self.assertRaisesRegex(ValueError, "called unknown tool"):
            agent._append_assistant_history(
                bridge_assistant_message([("unexpected", "Seoul")]), state
            )

    def test_in_process_round_trip_and_tool_history(self) -> None:
        tool = as_tool(get_weather)
        responses = [
            bridge_response(
                parser_errors=["fixture repair intervention"],
                tool_calls=[
                    {
                        "arguments": {"city": "Seoul"},
                        "id": "call-1",
                        "name": "get_weather",
                    }
                ],
            ),
            bridge_response(text="It is sunny in Seoul."),
        ]
        agent = InProcessAgent(
            tools=[tool],
            domain_policy="Only answer weather questions.",
            arm="glm5",
            model="fixture-model",
            responses=responses,
        )
        state = agent.get_init_state()
        first, state = agent.generate_next_message(
            UserMessage.text("How is the weather in Seoul?"), state
        )
        second, state = agent.generate_next_message(
            ToolMessage(
                content='{"city":"Seoul","condition":"sunny"}',
                id="call-1",
                role="tool",
            ),
            state,
        )

        self.assertEqual(first.content, "")
        self.assertEqual(len(first.tool_calls or []), 1)
        self.assertEqual(first.tool_calls[0].name, "get_weather")
        self.assertEqual(first.tool_calls[0].arguments, {"city": "Seoul"})
        self.assertEqual(
            first.raw_data["parserErrors"], ["fixture repair intervention"]
        )
        self.assertEqual(first.raw_data["usage"]["totalTokens"], 14)
        self.assertEqual(first.usage["totalTokens"], 14)
        self.assertEqual(second.content, "It is sunny in Seoul.")
        self.assertIsNone(second.tool_calls)
        self.assertEqual(len(agent.requests), 2)
        self.assertEqual(agent.requests[0]["arm"], "glm5")
        self.assertIn("Only answer weather questions.", agent.requests[0]["system"])
        self.assertEqual(agent.requests[0]["tools"][0]["name"], "get_weather")
        self.assertEqual(
            agent.requests[1]["messages"],
            [
                {"content": "How is the weather in Seoul?", "role": "user"},
                {
                    "role": "assistant",
                    "toolCalls": [
                        {
                            "arguments": {"city": "Seoul"},
                            "id": "call-1",
                            "name": "get_weather",
                        }
                    ],
                },
                {
                    "role": "tool",
                    "toolResults": [
                        {
                            "content": '{"city":"Seoul","condition":"sunny"}',
                            "error": False,
                            "id": "call-1",
                            "name": "get_weather",
                        }
                    ],
                },
            ],
        )

    def test_multi_tool_message_is_kept_as_one_parallel_result_turn(self) -> None:
        tool = as_tool(get_weather)
        agent = InProcessAgent(
            tools=[tool],
            domain_policy="Weather only.",
            arm="glm5",
            model="fixture-model",
            responses=[bridge_response(text="Both cities are sunny.")],
        )
        state = agent.get_init_state()
        agent._append_assistant_history(
            bridge_assistant_message(
                [
                    ("call-a", "Seoul"),
                    ("call-b", "Busan"),
                ]
            ),
            state,
        )
        message = MultiToolMessage(
            role="tool",
            tool_messages=[
                ToolMessage(content="sunny", id="call-a", role="tool"),
                ToolMessage(content="sunny", id="call-b", role="tool"),
            ],
        )
        response, _ = agent.generate_next_message(message, state)

        self.assertEqual(response.content, "Both cities are sunny.")
        results = agent.requests[0]["messages"][-1]["toolResults"]
        self.assertEqual([result["id"] for result in results], ["call-a", "call-b"])

    def test_real_loopback_http_when_sandbox_permits_it(self) -> None:
        tool = as_tool(get_weather)
        try:
            fixture = FixtureBridge(
                [
                    bridge_response(
                        tool_calls=[
                            {
                                "arguments": {"city": "Seoul"},
                                "id": "tcp-1",
                                "name": "get_weather",
                            }
                        ]
                    )
                ]
            )
        except OSError as error:
            if error.errno in {errno.EPERM, errno.EACCES}:
                self.skipTest(f"loopback bind unavailable: {error}")
            raise

        with fixture:
            agent = Tau2NativePlusAgent(
                tools=[tool],
                domain_policy="Weather only.",
                arm="glm5",
                model="fixture-model",
                bridge_url=fixture.origin,
            )
            response, _ = agent.generate_next_message(
                UserMessage.text("Weather in Seoul?"), agent.get_init_state()
            )

        self.assertEqual(response.tool_calls[0].id, "tcp-1")
        self.assertEqual(len(fixture.requests), 1)

    def test_factories_bind_the_control_and_native_plus_arms(self) -> None:
        tool = as_tool(get_weather)
        native = create_tau2_native_agent(
            [tool],
            "policy",
            llm="fixture-model",
            llm_args={"bridge_url": "http://127.0.0.1:8787"},
        )
        glm5 = create_tau2_glm5_agent(
            [tool],
            "policy",
            llm="fixture-model",
            llm_args={"bridge_url": "http://127.0.0.1:8787"},
        )
        self.assertEqual(native.arm, "native")
        self.assertEqual(glm5.arm, "glm5")


def bridge_assistant_message(calls: list[tuple[str, str]]):
    from tau2.data_model.message import AssistantMessage, ToolCall

    return AssistantMessage.text(
        "",
        tool_calls=[
            ToolCall(
                id=call_id,
                name="get_weather",
                arguments={"city": city},
                requestor="assistant",
            )
            for call_id, city in calls
        ],
    )


if __name__ == "__main__":
    unittest.main()
