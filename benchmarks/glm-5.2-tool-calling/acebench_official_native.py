#!/usr/bin/env python3
"""Run pinned ACEBench end to end through native and prompt-only tool calls.

ACEBench's source runner prompts API calls as Python-like text.  This adapter
keeps its datasets, user simulator, executable agent environments, result file
layout, and scorer contract, while replacing only the assistant-under-test's
call representation with OpenAI-native tools routed through the loopback
parser bridge.  Results are therefore an ACEBench full-population native-tool
adaptation, not a directly comparable upstream text-prompt leaderboard entry.
"""

from __future__ import annotations

import json
import os
import runpy
import sys
import time
import types
from pathlib import Path
from typing import Any


ACE_ROOT = Path(
    os.getenv("ACEBENCH_ROOT", "/tmp/acebench-function-calling")
).resolve()
sys.path.insert(0, str(ACE_ROOT))

from openai import OpenAI  # noqa: E402

from model_inference.base_inference import BaseHandler  # noqa: E402
from model_inference.multi_step.execution_role_step import (  # noqa: E402
    EXECUTION_STEP,
)
from model_inference.multi_step.multi_step_scene import (  # noqa: E402
    Mulit_Step_Scene,
)
from model_inference.multi_turn.APIModel_user import (  # noqa: E402
    SYSTEM_PROMPT_BASE_EN,
    SYSTEM_PROMPT_BASE_ZH,
    SYSTEM_PROMPT_TRAVEL_EN,
    SYSTEM_PROMPT_TRAVEL_ZH,
    remove_prefix,
)
from model_inference.multi_turn.execution_role import EXECUTION  # noqa: E402
from model_inference.multi_turn.multi_turn_scene import Scene  # noqa: E402
from model_inference.prompt_en import BASE_PROMPT_EN, TRAVEL_PROMPT_EN  # noqa: E402
from model_inference.prompt_zh import BASE_PROMPT_ZH, TRAVEL_PROMPT_ZH  # noqa: E402


SAVED_CLASS = {
    "BaseApi": ["wifi", "logged_in"],
    "MessageApi": ["inbox"],
    "ReminderApi": ["reminder_list"],
    "FoodPlatform": ["users", "logged_in_users", "orders"],
    "Finance": [
        "user_accounts",
        "is_logged_in",
        "deposit_history",
        "withdrawal_history",
        "loan_history",
        "orders",
        "holdings",
    ],
    "Travel": ["users", "reservations"],
}

TYPE_MAPPING = {
    "bool": "boolean",
    "dict": "object",
    "float": "number",
    "int": "integer",
    "list": "array",
    "str": "string",
}

PROVIDER_MAX_TOKENS = 16_384

NORMAL_SYSTEM = {
    "en": (
        "You are the assistant under evaluation. Use the provided native tools "
        "to satisfy the final user turn in the supplied conversation history. "
        "Call every and only relevant API. Preserve user-provided values exactly. "
        "Do not describe or serialize a call as text."
    ),
    "zh": (
        "你是被评测的助手。请使用提供的原生工具完成给定对话历史中用户最后一轮的要求。"
        "只调用相关 API，并完整保留用户给出的参数值。不要用文本描述或序列化工具调用。"
    ),
}

SPECIAL_SYSTEM = {
    "en": (
        "Use the provided native tools only when the request is fully valid and "
        "solvable. Otherwise return the required diagnostic text and make no tool "
        "call. For a wrong value use: There is incorrect value (value) for the "
        "parameters (key) in the conversation history. For missing required data "
        "use: Missing necessary parameters (key1, key2, ...) for the api (ApiName). "
        "For an unsupported request use: Due to the limitations of the function, "
        "I cannot solve this problem."
    ),
    "zh": (
        "仅当请求信息完整、参数正确且候选工具能够解决时才调用提供的原生工具。否则不要调用工具，"
        "并按评测要求输出英文诊断短语：错误值使用 There is incorrect value (value) for the "
        "parameters (key) in the conversation history.；缺少参数使用 Missing necessary "
        "parameters (key1, key2, ...) for the api (ApiName).；能力外请求使用 Due to the "
        "limitations of the function, I cannot solve this problem."
    ),
}

AGENT_SYSTEM = {
    "en": (
        "You are the tool-using agent. Continue from the complete conversation "
        "history. When an API action is required, invoke the provided native tool; "
        "do not write Python-style or bracketed calls. If information is missing, "
        "ask the user briefly. When every requested task is complete, reply exactly "
        "finish conversation."
    ),
    "zh": (
        "你是使用工具的 agent。根据完整对话历史继续任务。需要 API 操作时调用提供的原生工具，"
        "不要输出 Python 风格或方括号调用文本。信息不足时简短询问用户；全部任务完成后仅回复 "
        "finish conversation。"
    ),
}


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def require_provider_max_tokens(value: int, *, actor: str) -> int:
    """Fail closed before any ACEBench provider request can use a stale cap."""
    if type(value) is not int or value != PROVIDER_MAX_TOKENS:
        raise RuntimeError(
            f"{actor} max_tokens must be {PROVIDER_MAX_TOKENS}, found {value}"
        )
    return value


def normalize_schema(value: Any) -> Any:
    if isinstance(value, list):
        return [normalize_schema(item) for item in value]
    if not isinstance(value, dict):
        return TYPE_MAPPING.get(value, value) if isinstance(value, str) else value
    output = {
        key: normalize_schema(child)
        for key, child in value.items()
        if key != "unit"
    }
    schema_type = output.get("type")
    if isinstance(schema_type, str):
        output["type"] = TYPE_MAPPING.get(schema_type, schema_type)
    if output.get("type") == "array" and "items" not in output:
        output["items"] = {}
    if output.get("type") == "object" and not any(
        key in output for key in ("properties", "additionalProperties")
    ):
        output["additionalProperties"] = True
    return output


def openai_tools(
    functions: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Build a legal native-tool list and retain ACEBench scorer names.

    ACEBench contains one pinned case with two different schemas that share the
    same function name. OpenAI-compatible native tool arrays require unique
    names, while ACEBench's scorer intentionally keys calls by the original
    name. Give only the colliding entries deterministic transport aliases and
    translate them back before writing official result rows.
    """
    original_names = [str(function["name"]) for function in functions]
    name_counts = {name: original_names.count(name) for name in set(original_names)}
    occurrences: dict[str, int] = {}
    reserved_names = set(original_names)
    used_aliases: set[str] = set()
    original_by_alias: dict[str, str] = {}
    tools = []
    for function, original_name in zip(functions, original_names, strict=True):
        occurrence = occurrences.get(original_name, 0) + 1
        occurrences[original_name] = occurrence
        alias = original_name
        if name_counts[original_name] > 1:
            alias = f"{original_name}__ace_variant_{occurrence}"
            disambiguator = 2
            while alias in reserved_names or alias in used_aliases:
                alias = (
                    f"{original_name}__ace_variant_{occurrence}_{disambiguator}"
                )
                disambiguator += 1
        used_aliases.add(alias)
        original_by_alias[alias] = original_name
        parameters = (
            function.get("parameters")
            or function.get("arguments")
            or function.get("_arguments")
            or {"properties": {}, "type": "object"}
        )
        tools.append(
            {
                "type": "function",
                "function": {
                    "name": alias,
                    "description": str(function.get("description") or ""),
                    "parameters": normalize_schema(parameters),
                },
            }
        )
    return tools, original_by_alias


def call_message(
    client: OpenAI,
    *,
    messages: list[dict[str, Any]],
    model: str,
    temperature: float,
    top_p: float,
    max_tokens: int,
    tools: list[dict[str, Any]] | None = None,
) -> Any:
    require_provider_max_tokens(max_tokens, actor="provider request")
    last_error: Exception | None = None
    for attempt in range(1, 7):
        try:
            kwargs: dict[str, Any] = {
                "messages": messages,
                "model": model,
                "temperature": temperature,
                "top_p": top_p,
                "max_tokens": max_tokens,
            }
            if tools:
                kwargs["tools"] = tools
                kwargs["tool_choice"] = "auto"
            return client.chat.completions.create(**kwargs).choices[0].message
        except Exception as error:  # noqa: BLE001 - official runner also retries API errors.
            last_error = error
            if attempt == 6:
                break
            time.sleep(min(8.0, 0.75 * (2 ** (attempt - 1))))
    assert last_error is not None
    raise last_error


def fc_result(
    message: Any, original_by_alias: dict[str, str] | None = None
) -> list[dict[str, str]]:
    original_by_alias = original_by_alias or {}
    return [
        {
            original_by_alias.get(
                str(call.function.name), str(call.function.name)
            ): str(call.function.arguments or "{}")
        }
        for call in (message.tool_calls or [])
    ]


def parse_arguments(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def calls_as_ace_syntax(
    message: Any, original_by_alias: dict[str, str] | None = None
) -> str:
    original_by_alias = original_by_alias or {}
    calls = []
    for call in message.tool_calls or []:
        arguments = parse_arguments(str(call.function.arguments or "{}"))
        serialized = ", ".join(f"{key}={value!r}" for key, value in arguments.items())
        function_name = original_by_alias.get(
            str(call.function.name), str(call.function.name)
        )
        calls.append(f"{function_name}({serialized})")
    return f"[{', '.join(calls)}]"


def extract_state(result_instances: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for result_instance in result_instances:
        for name, instance in result_instance.items():
            fields = SAVED_CLASS.get(name, [])
            output.append(
                {name: {field: instance.__dict__[field] for field in fields}}
            )
    return output


class NativeAgent:
    def __init__(
        self,
        *,
        model_name: str,
        functions: list[dict[str, Any]],
        involved_classes: list[str],
        language: str,
        temperature: float,
        top_p: float,
        max_tokens: int,
    ) -> None:
        self.model_name = model_name
        self.functions = functions
        self.involved_classes = involved_classes
        self.language = language
        self.temperature = temperature
        self.top_p = top_p
        self.max_tokens = require_provider_max_tokens(
            max_tokens, actor="assistant agent"
        )
        self.client = OpenAI(
            api_key=require_env("OPENAI_API_KEY"),
            base_url=require_env("OPENAI_BASE_URL"),
        )

    def system_prompt(self) -> str:
        policy = AGENT_SYSTEM[self.language]
        if "Travel" in self.involved_classes:
            policy += "\n\n" + (
                TRAVEL_PROMPT_EN if self.language == "en" else TRAVEL_PROMPT_ZH
            )
        if "BaseApi" in self.involved_classes:
            policy += "\n\n" + (
                BASE_PROMPT_EN if self.language == "en" else BASE_PROMPT_ZH
            )
        return (
            policy
            + "\n\nOverride any textual function-call format mentioned above: use the "
            "provided native tools and never write bracketed call syntax."
        )

    def respond(self, history: str) -> dict[str, Any]:
        tools, original_by_alias = openai_tools(self.functions)
        message = call_message(
            self.client,
            messages=[
                {"role": "system", "content": self.system_prompt()},
                {"role": "user", "content": history},
            ],
            model=self.model_name,
            temperature=self.temperature,
            top_p=self.top_p,
            max_tokens=self.max_tokens,
            tools=tools,
        )
        if message.tool_calls:
            return {
                "sender": "agent",
                "recipient": "execution",
                "message": calls_as_ace_syntax(message, original_by_alias),
            }
        return {
            "sender": "agent",
            "recipient": "user",
            "message": str(message.content or ""),
        }


class NativeUser:
    def __init__(
        self,
        *,
        involved_classes: list[str],
        language: str,
        model_name: str = "glm52-simulator",
        temperature: float = 0.001,
        top_p: float = 1,
        max_tokens: int = PROVIDER_MAX_TOKENS,
    ) -> None:
        self.involved_classes = involved_classes
        self.language = language
        self.model_name = model_name
        self.temperature = temperature
        self.top_p = top_p
        self.max_tokens = require_provider_max_tokens(
            max_tokens, actor="user simulator"
        )
        self.messages: list[dict[str, str]] = []
        self.client = OpenAI(
            api_key=require_env("OPENAI_API_KEY"),
            base_url=require_env("OPENAI_BASE_URL"),
        )

    def _template(self) -> str:
        if "BaseApi" in self.involved_classes:
            return SYSTEM_PROMPT_BASE_EN if self.language == "en" else SYSTEM_PROMPT_BASE_ZH
        return SYSTEM_PROMPT_TRAVEL_EN if self.language == "en" else SYSTEM_PROMPT_TRAVEL_ZH

    def _complete(self) -> str:
        message = call_message(
            self.client,
            messages=self.messages,
            model=self.model_name,
            temperature=self.temperature,
            top_p=self.top_p,
            max_tokens=self.max_tokens,
        )
        return str(message.content or "")

    def get_init_prompt(self, question: str) -> str:
        greeting = (
            "Is there anything you need help with today?"
            if self.language == "en"
            else "今天有什么需要帮助的吗？"
        )
        self.messages = [
            {"role": "system", "content": self._template().format(instruction=question)},
            {"role": "user", "content": greeting},
        ]
        response = self._complete()
        self.messages.append({"role": "assistant", "content": response})
        return response

    def step(self, message: str) -> None:
        self.messages.append({"role": "user", "content": remove_prefix(message)})

    def respond(self) -> dict[str, str]:
        response = self._complete()
        self.messages.append({"role": "assistant", "content": response})
        return {"sender": "user", "recipient": "agent", "message": response}


class NativeACEInference(BaseHandler):
    def __init__(
        self,
        model_name: str,
        model_path: str | None = None,
        temperature: float = 0.001,
        top_p: float = 1,
        max_tokens: int = PROVIDER_MAX_TOKENS,
        max_dialog_turns: int = 40,
        user_model: str = "glm52-simulator",
        language: str = "zh",
    ) -> None:
        validated_max_tokens = require_provider_max_tokens(
            max_tokens, actor="assistant under test"
        )
        super().__init__(
            model_name,
            model_path,
            temperature,
            top_p,
            validated_max_tokens,
            language,
        )
        self.max_dialog_turns = max_dialog_turns
        self.user_model = user_model
        self.client = OpenAI(
            api_key=require_env("OPENAI_API_KEY"),
            base_url=require_env("OPENAI_BASE_URL"),
        )

    def inference(
        self,
        question: str,
        functions: list[dict[str, Any]],
        time_context: str,
        profile: str,
        test_case: dict[str, Any],
        case_id: str,
    ) -> Any:
        if "agent" in case_id:
            if "multi_turn" in case_id:
                return self.multi_turn_inference(test_case)
            return self.multi_step_inference(test_case)
        return self.single_turn_inference(
            question, functions, time_context, profile, case_id
        )

    def single_turn_inference(
        self,
        question: str,
        functions: list[dict[str, Any]],
        time_context: str,
        profile: str,
        case_id: str,
    ) -> Any:
        special = "special" in case_id
        instruction = SPECIAL_SYSTEM[self.language] if special else NORMAL_SYSTEM[self.language]
        context = "\n\n".join(
            value
            for value in (
                f"Time context:\n{time_context}" if time_context else "",
                f"Character profile:\n{profile}" if profile else "",
            )
            if value
        )
        tools, original_by_alias = openai_tools(functions)
        message = call_message(
            self.client,
            messages=[
                {"role": "system", "content": instruction + (f"\n\n{context}" if context else "")},
                {"role": "user", "content": question},
            ],
            model=self.model_name,
            temperature=self.temperature,
            top_p=self.top_p,
            max_tokens=self.max_tokens,
            tools=tools,
        )
        calls = fc_result(message, original_by_alias)
        if calls:
            return calls
        return str(message.content or "") if special else []

    def multi_turn_inference(self, test_case: dict[str, Any]) -> tuple[list[dict[str, Any]], list[Any]]:
        involved = test_case["involved_classes"]
        functions = test_case["function"]
        test_id = str(test_case["id"]).split("_")[-1]
        agent = NativeAgent(
            model_name=self.model_name,
            functions=functions,
            involved_classes=involved,
            language=self.language,
            temperature=self.temperature,
            top_p=self.top_p,
            max_tokens=self.max_tokens,
        )
        user = NativeUser(
            involved_classes=involved,
            language=self.language,
            model_name=self.user_model,
            max_tokens=self.max_tokens,
        )
        execution = EXECUTION(
            agent_model_name=self.model_name,
            initial_config=test_case["initial_config"],
            involved_classes=involved,
            test_id=test_id,
            language=self.language,
        )
        scene = Scene(
            initial_state=test_case["initial_config"],
            functions=functions,
            agent_role=agent,
            user_role=user,
            init_message=user.get_init_prompt(test_case["question"]),
            language=self.language,
        )
        result_instances: list[dict[str, Any]] = []
        milestones: list[Any] = []
        for index in range(self.max_dialog_turns):
            last_recipient = scene.dialogue_history[-1]["recipient"]
            if last_recipient == "user":
                scene.get_inference_message()
                user.step(scene.dialogue_history[-1]["message"])
                current = user.respond()
            elif last_recipient == "agent":
                current = agent.respond(scene.get_inference_message())
            else:
                scene.get_inference_message()
                milestones.append(scene.dialogue_history[-1]["message"])
                current, instance = execution.respond(scene.dialogue_history)
                if isinstance(instance, dict) and instance not in result_instances:
                    result_instances.append(instance)
            scene.add_dialogue(current)
            if index > 1 and "finish conversation" in str(current["message"]).lower():
                break
        return extract_state(result_instances), milestones

    def multi_step_inference(self, test_case: dict[str, Any]) -> tuple[list[dict[str, Any]], list[Any]]:
        involved = test_case["involved_classes"]
        functions = test_case["function"]
        test_id = str(test_case["id"]).split("_")[-1]
        agent = NativeAgent(
            model_name=self.model_name,
            functions=functions,
            involved_classes=involved,
            language=self.language,
            temperature=self.temperature,
            top_p=self.top_p,
            max_tokens=self.max_tokens,
        )
        execution = EXECUTION_STEP(
            agent_model_name=self.model_name,
            initial_config=test_case["initial_config"],
            involved_classes=involved,
            test_id=test_id,
            language=self.language,
        )
        scene = Mulit_Step_Scene(
            question=test_case["question"],
            initial_state=test_case["initial_config"],
            functions=functions,
            agent_role=agent,
            language=self.language,
        )
        result_instances: list[dict[str, Any]] = []
        milestones: list[Any] = []
        for index in range(self.max_dialog_turns):
            last_sender = scene.dialogue_history[-1]["sender"]
            if index == 0 or last_sender == "execution":
                current = agent.respond(scene.get_inference_message())
            else:
                milestones.append(scene.dialogue_history[-1]["message"])
                current, instance = execution.respond(scene.dialogue_history)
                if isinstance(instance, dict) and instance not in result_instances:
                    result_instances.append(instance)
            scene.add_dialogue(current)
            if index > 1 and "finish conversation" in str(current["message"]).lower():
                break
        return extract_state(result_instances), milestones


inference_map = {
    "glm52-native-FC": NativeACEInference,
    "glm52-prompt-only-FC": NativeACEInference,
}
inference_map_module = types.ModuleType("model_inference.inference_map")
inference_map_module.inference_map = inference_map
sys.modules["model_inference.inference_map"] = inference_map_module


if __name__ == "__main__":
    runpy.run_path(str(ACE_ROOT / "generate.py"), run_name="__main__")
