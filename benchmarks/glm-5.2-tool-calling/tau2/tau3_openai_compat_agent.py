"""tau3 half-duplex agent routed through the captured OpenAI bridge."""

from __future__ import annotations

import json
import os
import time
from typing import Any, Optional

from openai import OpenAI
from tau2.agent.base_agent import ValidAgentInputMessage
from tau2.data_model.message import AssistantMessage, ToolCall
from tau2.environment.tool import Tool

from tau2_native_plus_agent import (
    NativePlusArm,
    NativePlusState,
    Tau2NativePlusAgent,
)


class Tau3OpenAICompatAgent(Tau2NativePlusAgent):
    """Reuse the strict tau3 state adapter with an OpenAI-compatible transport."""

    def __init__(
        self,
        tools: list[Tool],
        domain_policy: str,
        *,
        arm: NativePlusArm,
        base_url: str,
        timeout_seconds: float,
        max_tokens: int,
    ) -> None:
        if arm not in {"native", "glm5"}:
            raise ValueError("arm must be native or glm5")
        super().__init__(
            tools=tools,
            domain_policy=domain_policy,
            arm=arm,
            model="glm52-prompt-only" if arm == "glm5" else "glm52-native",
            bridge_url="http://127.0.0.1:8787",
            timeout_seconds=timeout_seconds,
        )
        if not base_url.startswith(("http://127.0.0.1:", "http://localhost:")):
            raise ValueError("base_url must be a loopback OpenAI-compatible endpoint")
        self.max_tokens = max_tokens
        self.client = OpenAI(
            api_key=os.getenv("TAU3_BRIDGE_CLIENT_KEY", "bridge-local"),
            base_url=base_url,
            max_retries=0,
            timeout=timeout_seconds,
        )

    @staticmethod
    def _openai_messages(state: NativePlusState) -> list[dict[str, Any]]:
        output: list[dict[str, Any]] = []
        for message in state.messages:
            role = message["role"]
            if role in {"user", "assistant"} and "content" in message:
                output.append({"role": role, "content": message["content"]})
            elif role == "assistant":
                output.append(
                    {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": call["id"],
                                "type": "function",
                                "function": {
                                    "name": call["name"],
                                    "arguments": json.dumps(
                                        call["arguments"], ensure_ascii=False
                                    ),
                                },
                            }
                            for call in message["toolCalls"]
                        ],
                    }
                )
            elif role == "tool":
                for result in message["toolResults"]:
                    output.append(
                        {
                            "role": "tool",
                            "tool_call_id": result["id"],
                            "name": result["name"],
                            "content": result["content"],
                        }
                    )
            else:
                raise ValueError(f"unsupported bridge state message: {message!r}")
        return output

    def _openai_tools(self) -> list[dict[str, Any]]:
        return [
            {
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": tool.get("description", ""),
                    "parameters": tool["inputSchema"],
                },
            }
            for tool in self._tools
        ]

    def generate_next_message(
        self, message: ValidAgentInputMessage, state: NativePlusState
    ) -> tuple[AssistantMessage, NativePlusState]:
        self._append_input(message, state)
        started = time.monotonic()
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": self._system_prompt},
                *self._openai_messages(state),
            ],
            "temperature": 0,
            "max_tokens": self.max_tokens,
        }
        tools = self._openai_tools()
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"
        response = self.client.chat.completions.create(**kwargs)
        choice = response.choices[0]
        response_message = choice.message
        calls: list[ToolCall] = []
        for call in response_message.tool_calls or []:
            try:
                arguments = json.loads(call.function.arguments or "{}")
            except json.JSONDecodeError as error:
                raise RuntimeError("bridge returned non-JSON tool arguments") from error
            if not isinstance(arguments, dict):
                raise RuntimeError("bridge returned non-object tool arguments")
            calls.append(
                ToolCall(
                    id=call.id,
                    name=call.function.name,
                    arguments=arguments,
                    requestor="assistant",
                )
            )
        # Match the repository's dedicated tau bridge contract: once native tool
        # calls exist, they are the assistant turn and incidental text is ignored.
        content = "" if calls else (response_message.content or "")
        if not calls and not content.strip():
            raise RuntimeError("bridge returned an empty assistant message")
        usage = response.usage.model_dump(mode="json") if response.usage else None
        raw_data = {
            "arm": self.arm,
            "bridgeResponse": response.model_dump(mode="json"),
            "model": self.model,
        }
        elapsed = time.monotonic() - started
        assistant = AssistantMessage.text(
            content,
            tool_calls=calls or None,
            generation_time_seconds=elapsed,
            raw_data=raw_data,
            usage=usage,
        )
        self._append_assistant_history(assistant, state)
        return assistant, state


def _factory_options(llm_args: Optional[dict[str, Any]]) -> dict[str, Any]:
    args = llm_args or {}
    base_url = args.get("base_url") or os.getenv(
        "TAU3_OPENAI_BRIDGE_URL", "http://127.0.0.1:8798/v1"
    )
    return {
        "base_url": str(base_url),
        "max_tokens": int(args.get("max_tokens", 1024)),
        "timeout_seconds": float(args.get("timeout_seconds", 960)),
    }


def create_tau3_openai_native(
    tools: list[Tool],
    domain_policy: str,
    *,
    llm_args: Optional[dict[str, Any]] = None,
    **_: Any,
) -> Tau3OpenAICompatAgent:
    return Tau3OpenAICompatAgent(
        tools, domain_policy, arm="native", **_factory_options(llm_args)
    )


def create_tau3_openai_glm5(
    tools: list[Tool],
    domain_policy: str,
    *,
    llm_args: Optional[dict[str, Any]] = None,
    **_: Any,
) -> Tau3OpenAICompatAgent:
    return Tau3OpenAICompatAgent(
        tools, domain_policy, arm="glm5", **_factory_options(llm_args)
    )


def register_tau3_openai_compat_agents() -> None:
    from tau2.registry import registry

    for name, factory in {
        "openai_bridge_native": create_tau3_openai_native,
        "openai_bridge_glm5": create_tau3_openai_glm5,
    }.items():
        if registry.get_agent_factory(name) is None:
            registry.register_agent_factory(factory, name)
