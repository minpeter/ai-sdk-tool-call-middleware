"""tau2 text agent backed by the local AI SDK Native-Plus bridge.

This module deliberately does not call tau2's LiteLLM ``generate`` helper. The
agent-under-test always reaches the provider through the Node bridge, where the
``glm5`` arm is wrapped with ``glm5NativePlusToolMiddleware`` and ``native`` is
left untouched.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Literal, Optional
from urllib.parse import urlsplit, urlunsplit

from tau2.agent.base_agent import HalfDuplexAgent, ValidAgentInputMessage
from tau2.data_model.message import (
    AssistantMessage,
    Message,
    MultiToolMessage,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from tau2.environment.tool import Tool

NativePlusArm = Literal["native", "glm5"]


class NativePlusBridgeError(RuntimeError):
    """Raised when the local bridge rejects or cannot satisfy a request."""


@dataclass
class NativePlusState:
    """Serializable conversation state retained by the tau2 orchestrator."""

    messages: list[dict[str, Any]] = field(default_factory=list)
    tool_names_by_id: dict[str, str] = field(default_factory=dict)


def _bridge_endpoint(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "http":
        raise ValueError("bridge_url must use plain HTTP on loopback")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("bridge_url must not contain credentials")
    if parsed.hostname not in {"127.0.0.1", "::1", "localhost"}:
        raise ValueError("bridge_url must point to a loopback host")
    if parsed.query or parsed.fragment:
        raise ValueError("bridge_url must not contain a query or fragment")
    if parsed.path not in {"", "/", "/v1/generate"}:
        raise ValueError("bridge_url path must be empty or /v1/generate")
    return urlunsplit((parsed.scheme, parsed.netloc, "/v1/generate", "", ""))


def _required_dict(value: Any, field_name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise NativePlusBridgeError(f"{field_name} must be an object")
    return value


def _required_string(value: Any, field_name: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value):
        qualifier = "a string" if allow_empty else "a non-empty string"
        raise NativePlusBridgeError(f"{field_name} must be {qualifier}")
    return value


class Tau2NativePlusAgent(HalfDuplexAgent[NativePlusState]):
    """A tau2 half-duplex agent whose model call is owned by the Node bridge."""

    def __init__(
        self,
        tools: list[Tool],
        domain_policy: str,
        *,
        arm: NativePlusArm,
        model: str,
        bridge_url: str = "http://127.0.0.1:8787",
        timeout_seconds: float = 125.0,
    ) -> None:
        super().__init__(tools=tools, domain_policy=domain_policy)
        if arm not in {"native", "glm5"}:
            raise ValueError("arm must be native or glm5")
        if not model:
            raise ValueError("model must be non-empty")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        self.arm: NativePlusArm = arm
        self.model = model
        self.endpoint = _bridge_endpoint(bridge_url)
        self.timeout_seconds = timeout_seconds
        self._tools = self._serialize_tools(tools)
        self._tool_names = {tool["name"] for tool in self._tools}
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @staticmethod
    def _serialize_tools(tools: list[Tool]) -> list[dict[str, Any]]:
        serialized: list[dict[str, Any]] = []
        seen: set[str] = set()
        for tool in tools:
            schema = _required_dict(tool.openai_schema, f"{tool.name}.openai_schema")
            function = _required_dict(
                schema.get("function"), f"{tool.name}.openai_schema.function"
            )
            name = _required_string(function.get("name"), f"{tool.name}.name")
            if name in seen:
                raise ValueError(f"duplicate tool name: {name}")
            seen.add(name)
            item: dict[str, Any] = {
                "inputSchema": _required_dict(
                    function.get("parameters"), f"{name}.parameters"
                ),
                "name": name,
            }
            description = function.get("description")
            if isinstance(description, str) and description:
                item["description"] = description
            serialized.append(item)
        return serialized

    @property
    def _system_prompt(self) -> str:
        return (
            "You are the service agent in a tool-use evaluation. Follow the domain "
            "policy exactly, use only the supplied tools, and never invent tool results."
            f"\n\n## Domain policy\n{self.domain_policy}"
        )

    def get_init_state(
        self, message_history: Optional[list[Message]] = None
    ) -> NativePlusState:
        state = NativePlusState()
        for message in message_history or []:
            self._append_history_message(message, state)
        return state

    def _append_history_message(self, message: Message, state: NativePlusState) -> None:
        if isinstance(message, UserMessage):
            self._append_user(message, state)
            return
        if isinstance(message, AssistantMessage):
            self._append_assistant_history(message, state)
            return
        if isinstance(message, ToolMessage):
            self._append_tool_messages([message], state)
            return
        if isinstance(message, MultiToolMessage):
            self._append_tool_messages(message.tool_messages, state)
            return
        raise ValueError(f"unsupported history message: {type(message).__name__}")

    @staticmethod
    def _append_user(message: UserMessage, state: NativePlusState) -> None:
        if message.tool_calls is not None:
            raise ValueError("user-originated tool calls are not supported")
        content = message.content
        if not isinstance(content, str) or not content.strip():
            raise ValueError("tau2 user message must contain text")
        state.messages.append({"content": content, "role": "user"})

    def _append_assistant_history(
        self, message: AssistantMessage, state: NativePlusState
    ) -> None:
        if message.tool_calls:
            if message.has_text_content():
                raise ValueError("assistant history cannot mix text and tool calls")
            calls = [
                self._serialize_tau2_call(call, state) for call in message.tool_calls
            ]
            state.messages.append({"role": "assistant", "toolCalls": calls})
            return
        content = message.content
        if not isinstance(content, str) or not content.strip():
            raise ValueError("assistant history must contain text or tool calls")
        state.messages.append({"content": content, "role": "assistant"})

    def _serialize_tau2_call(
        self, call: ToolCall, state: NativePlusState
    ) -> dict[str, Any]:
        if call.name not in self._tool_names:
            raise ValueError(f"assistant called unknown tool: {call.name}")
        if not call.id:
            raise ValueError("assistant tool call id must be non-empty")
        if call.id in state.tool_names_by_id:
            raise ValueError(f"duplicate assistant tool call id: {call.id}")
        if not isinstance(call.arguments, dict):
            raise ValueError("assistant tool call arguments must be an object")
        state.tool_names_by_id[call.id] = call.name
        return {"arguments": call.arguments, "id": call.id, "name": call.name}

    @staticmethod
    def _append_tool_messages(
        messages: list[ToolMessage], state: NativePlusState
    ) -> None:
        results: list[dict[str, Any]] = []
        for message in messages:
            name = state.tool_names_by_id.get(message.id)
            if name is None:
                raise ValueError(f"tool result has no preceding call: {message.id}")
            results.append(
                {
                    "content": message.content or "",
                    "error": message.error,
                    "id": message.id,
                    "name": name,
                }
            )
        if not results:
            raise ValueError("multi-tool message must not be empty")
        state.messages.append({"role": "tool", "toolResults": results})

    def _append_input(
        self, message: ValidAgentInputMessage, state: NativePlusState
    ) -> None:
        if isinstance(message, UserMessage):
            self._append_user(message, state)
        elif isinstance(message, ToolMessage):
            self._append_tool_messages([message], state)
        elif isinstance(message, MultiToolMessage):
            self._append_tool_messages(message.tool_messages, state)
        else:
            raise ValueError(f"unsupported agent input: {type(message).__name__}")

    def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.endpoint,
            data=encoded,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with self._opener.open(request, timeout=self.timeout_seconds) as response:
                body = response.read(2 * 1024 * 1024 + 1)
                if len(body) > 2 * 1024 * 1024:
                    raise NativePlusBridgeError("bridge response is too large")
        except urllib.error.HTTPError as error:
            body = error.read(64 * 1024)
            try:
                detail = json.loads(body.decode("utf-8")).get("error")
            except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
                detail = None
            suffix = f": {detail}" if isinstance(detail, str) else ""
            raise NativePlusBridgeError(
                f"bridge returned HTTP {error.code}{suffix}"
            ) from error
        except urllib.error.URLError as error:
            raise NativePlusBridgeError(
                f"cannot reach local bridge: {error.reason}"
            ) from error
        try:
            parsed = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise NativePlusBridgeError("bridge returned invalid JSON") from error
        return _required_dict(parsed, "bridge response")

    def _response_message(
        self, payload: dict[str, Any], state: NativePlusState, elapsed: float
    ) -> AssistantMessage:
        arm = _required_string(payload.get("arm"), "response.arm")
        if arm != self.arm:
            raise NativePlusBridgeError("bridge response arm does not match request")
        text = _required_string(payload.get("text"), "response.text", allow_empty=True)
        raw_calls = payload.get("toolCalls")
        if not isinstance(raw_calls, list):
            raise NativePlusBridgeError("response.toolCalls must be an array")
        calls: list[ToolCall] = []
        response_ids: set[str] = set()
        for index, raw_call in enumerate(raw_calls):
            item = _required_dict(raw_call, f"response.toolCalls[{index}]")
            call_id = _required_string(
                item.get("id"), f"response.toolCalls[{index}].id"
            )
            name = _required_string(
                item.get("name"), f"response.toolCalls[{index}].name"
            )
            arguments = _required_dict(
                item.get("arguments"), f"response.toolCalls[{index}].arguments"
            )
            if name not in self._tool_names:
                raise NativePlusBridgeError(f"bridge returned unknown tool: {name}")
            if call_id in state.tool_names_by_id or call_id in response_ids:
                raise NativePlusBridgeError(f"bridge reused tool call id: {call_id}")
            response_ids.add(call_id)
            calls.append(
                ToolCall(
                    id=call_id,
                    name=name,
                    arguments=arguments,
                    requestor="assistant",
                )
            )
        if calls and text:
            raise NativePlusBridgeError("bridge mixed text and tool calls")
        if not calls and not text.strip():
            raise NativePlusBridgeError("bridge returned an empty assistant message")
        usage = payload.get("usage")
        if usage is not None and not isinstance(usage, dict):
            raise NativePlusBridgeError("response.usage must be an object")
        if calls:
            return AssistantMessage.text(
                "",
                tool_calls=calls,
                generation_time_seconds=elapsed,
                raw_data=payload,
                usage=usage,
            )
        return AssistantMessage.text(
            text,
            generation_time_seconds=elapsed,
            raw_data=payload,
            usage=usage,
        )

    def generate_next_message(
        self, message: ValidAgentInputMessage, state: NativePlusState
    ) -> tuple[AssistantMessage, NativePlusState]:
        self._append_input(message, state)
        started = time.monotonic()
        payload = self._post(
            {
                "arm": self.arm,
                "messages": state.messages,
                "model": self.model,
                "system": self._system_prompt,
                "tools": self._tools,
            }
        )
        response = self._response_message(payload, state, time.monotonic() - started)
        self._append_assistant_history(response, state)
        return response, state


def _factory_options(llm: Optional[str], llm_args: Optional[dict]) -> dict[str, Any]:
    args = llm_args or {}
    model = args.get("model") or llm or os.getenv("TAU2_BRIDGE_MODEL")
    if not isinstance(model, str) or not model:
        raise ValueError("set --agent-llm or TAU2_BRIDGE_MODEL")
    bridge_url = args.get(
        "bridge_url", os.getenv("TAU2_BRIDGE_URL", "http://127.0.0.1:8787")
    )
    timeout = args.get("timeout_seconds", 125.0)
    return {
        "bridge_url": bridge_url,
        "model": model,
        "timeout_seconds": float(timeout),
    }


def create_tau2_native_agent(
    tools: list[Tool],
    domain_policy: str,
    *,
    llm: Optional[str] = None,
    llm_args: Optional[dict] = None,
    **_: Any,
) -> Tau2NativePlusAgent:
    """Factory for the unmodified provider-native control arm."""

    return Tau2NativePlusAgent(
        tools=tools,
        domain_policy=domain_policy,
        arm="native",
        **_factory_options(llm, llm_args),
    )


def create_tau2_glm5_agent(
    tools: list[Tool],
    domain_policy: str,
    *,
    llm: Optional[str] = None,
    llm_args: Optional[dict] = None,
    **_: Any,
) -> Tau2NativePlusAgent:
    """Factory for the GLM-5.2 Native-Plus middleware arm."""

    return Tau2NativePlusAgent(
        tools=tools,
        domain_policy=domain_policy,
        arm="glm5",
        **_factory_options(llm, llm_args),
    )


def register_tau2_native_plus_agents() -> None:
    """Register stable arm names for tau2's CLI and programmatic runners."""

    from tau2.registry import registry

    factories = {
        "ai_sdk_glm5": create_tau2_glm5_agent,
        "ai_sdk_native": create_tau2_native_agent,
    }
    for name, factory in factories.items():
        if registry.get_agent_factory(name) is None:
            registry.register_agent_factory(factory, name)
