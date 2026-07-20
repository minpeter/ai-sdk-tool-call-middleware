#!/usr/bin/env python3
"""Run pinned ToolSandbox through the captured native/prompt-only bridge.

The wrapper changes only the OpenAI-compatible agent and user-simulator
transports. Scenario construction, executable tools, state transitions,
milestone/minefield evaluation, and result serialization stay upstream.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Final


TOOLSANDBOX_AGENT_MODEL_ENV: Final = "TOOLSANDBOX_AGENT_MODEL"
NATIVE_AGENT_MODEL: Final = "glm52-native"
PROMPT_ONLY_AGENT_MODEL: Final = "glm52-prompt-only"
SUPPORTED_AGENT_MODELS: Final = frozenset(
    (NATIVE_AGENT_MODEL, PROMPT_ONLY_AGENT_MODEL)
)


def resolve_toolsandbox_agent_model(environment: Mapping[str, str]) -> str:
    model = environment.get(TOOLSANDBOX_AGENT_MODEL_ENV, NATIVE_AGENT_MODEL)
    if model not in SUPPORTED_AGENT_MODELS:
        supported = ", ".join(sorted(SUPPORTED_AGENT_MODELS))
        raise RuntimeError(
            f"unsupported ToolSandbox agent model {model!r}; expected one of {supported}"
        )
    return model


ROOT = Path(
    os.getenv(
        "TOOLSANDBOX_ROOT", "/home/minpeter/.cache/glm52-benchmarks/toolsandbox"
    )
).resolve()
sys.path.insert(0, str(ROOT))

import httpx  # noqa: E402
from openai import OpenAI  # noqa: E402

from tool_sandbox.cli.utils import (  # noqa: E402
    AGENT_TYPE_TO_FACTORY,
    USER_TYPE_TO_FACTORY,
    RoleImplType,
)
from tool_sandbox.roles.openai_api_agent import OpenAIAPIAgent  # noqa: E402
from tool_sandbox.roles.openai_api_user import OpenAIAPIUser  # noqa: E402


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def bridge_client() -> OpenAI:
    # ToolSandbox pins openai 1.17.0 while its unconstrained httpx dependency
    # resolves to 0.28+, where the legacy `proxies` constructor argument was
    # removed. Supplying a current explicit client bypasses that incompatible
    # OpenAI wrapper path without changing benchmark request semantics.
    return OpenAI(
        api_key=require_env("OPENAI_API_KEY"),
        base_url=require_env("OPENAI_BASE_URL"),
        http_client=httpx.Client(timeout=180),
        max_retries=0,
        timeout=180,
    )


class GLM52BridgeAgent(OpenAIAPIAgent):
    model_name = resolve_toolsandbox_agent_model(os.environ)

    def __init__(self) -> None:
        self.openai_client = bridge_client()


class GLM52BridgeUser(OpenAIAPIUser):
    model_name = "glm52-simulator"

    def __init__(self) -> None:
        self.openai_client = bridge_client()


# Reuse stable upstream enum values so multiprocessing-spawn workers rebuild
# the same factories when this module is imported as __mp_main__.
AGENT_TYPE_TO_FACTORY[RoleImplType.Gorilla] = GLM52BridgeAgent
USER_TYPE_TO_FACTORY[RoleImplType.GPT_4_o_2024_05_13] = GLM52BridgeUser


if __name__ == "__main__":
    from tool_sandbox.cli import main

    main()
