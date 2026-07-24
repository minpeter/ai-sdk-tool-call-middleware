#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("toolsandbox_official_native.py")


class StubAgent:
    pass


class StubUser:
    pass


class StubOpenAI:
    pass


class StubRoleImplType:
    Gorilla = "Gorilla"
    GPT_4_o_2024_05_13 = "GPT_4_o_2024_05_13"


def stubbed_modules() -> dict[str, ModuleType]:
    httpx = ModuleType("httpx")
    setattr(httpx, "Client", type("Client", (), {}))
    openai = ModuleType("openai")
    setattr(openai, "OpenAI", StubOpenAI)
    tool_sandbox = ModuleType("tool_sandbox")
    setattr(tool_sandbox, "__path__", [])
    cli = ModuleType("tool_sandbox.cli")
    setattr(cli, "__path__", [])
    cli_utils = ModuleType("tool_sandbox.cli.utils")
    setattr(cli_utils, "AGENT_TYPE_TO_FACTORY", {})
    setattr(cli_utils, "USER_TYPE_TO_FACTORY", {})
    setattr(cli_utils, "RoleImplType", StubRoleImplType)
    roles = ModuleType("tool_sandbox.roles")
    setattr(roles, "__path__", [])
    agent = ModuleType("tool_sandbox.roles.openai_api_agent")
    setattr(agent, "OpenAIAPIAgent", StubAgent)
    user = ModuleType("tool_sandbox.roles.openai_api_user")
    setattr(user, "OpenAIAPIUser", StubUser)
    return {
        "httpx": httpx,
        "openai": openai,
        "tool_sandbox": tool_sandbox,
        "tool_sandbox.cli": cli,
        "tool_sandbox.cli.utils": cli_utils,
        "tool_sandbox.roles": roles,
        "tool_sandbox.roles.openai_api_agent": agent,
        "tool_sandbox.roles.openai_api_user": user,
    }


def load_adapter(model: str | None) -> ModuleType:
    spec = importlib.util.spec_from_file_location("toolsandbox_adapter_test", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("ToolSandbox adapter import specification is unavailable")
    adapter = importlib.util.module_from_spec(spec)
    environment = {"TOOLSANDBOX_ROOT": "/unused/tool-sandbox"}
    if model is not None:
        environment["TOOLSANDBOX_AGENT_MODEL"] = model
    with (
        patch.dict(sys.modules, stubbed_modules()),
        patch.dict(os.environ, environment, clear=True),
    ):
        sys.modules[spec.name] = adapter
        spec.loader.exec_module(adapter)
    return adapter


class ToolSandboxBridgeConfigTest(unittest.TestCase):
    def test_accepts_exact_prompt_only_alias(self) -> None:
        adapter = load_adapter("glm52-prompt-only")
        agent = adapter.__dict__["GLM52BridgeAgent"]

        self.assertEqual(agent.model_name, "glm52-prompt-only")

    def test_defaults_to_exact_native_alias(self) -> None:
        adapter = load_adapter(None)
        agent = adapter.__dict__["GLM52BridgeAgent"]

        self.assertEqual(agent.model_name, "glm52-native")

    def test_rejects_removed_native_plus_alias(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "unsupported ToolSandbox agent"):
            load_adapter("glm52-native-plus")

    def test_rejects_ambiguous_model_name(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "unsupported ToolSandbox agent"):
            load_adapter("zai-org/glm-5.2")


if __name__ == "__main__":
    unittest.main()
