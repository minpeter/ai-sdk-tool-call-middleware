#!/usr/bin/env python3
"""Targeted cap gates for the ACEBench native adapter."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("acebench_official_native.py")


class StubBaseHandler:
    def __init__(
        self,
        model_name: str,
        model_path: str | None = None,
        temperature: float = 0.7,
        top_p: float = 1,
        max_tokens: int = 1000,
        language: str = "zh",
    ) -> None:
        del model_path
        self.model_name = model_name
        self.temperature = temperature
        self.top_p = top_p
        self.max_tokens = max_tokens
        self.language = language


def module(name: str, **values: object) -> types.ModuleType:
    value = types.ModuleType(name)
    value.__dict__.update(values)
    return value


def load_adapter() -> types.ModuleType:
    class PlaceholderOpenAI:
        pass

    class PlaceholderRole:
        pass

    stubs = {
        "openai": module("openai", OpenAI=PlaceholderOpenAI),
        "model_inference": module("model_inference"),
        "model_inference.base_inference": module(
            "model_inference.base_inference", BaseHandler=StubBaseHandler
        ),
        "model_inference.multi_step": module("model_inference.multi_step"),
        "model_inference.multi_step.execution_role_step": module(
            "model_inference.multi_step.execution_role_step",
            EXECUTION_STEP=PlaceholderRole,
        ),
        "model_inference.multi_step.multi_step_scene": module(
            "model_inference.multi_step.multi_step_scene",
            Mulit_Step_Scene=PlaceholderRole,
        ),
        "model_inference.multi_turn": module("model_inference.multi_turn"),
        "model_inference.multi_turn.APIModel_user": module(
            "model_inference.multi_turn.APIModel_user",
            SYSTEM_PROMPT_BASE_EN="{instruction}",
            SYSTEM_PROMPT_BASE_ZH="{instruction}",
            SYSTEM_PROMPT_TRAVEL_EN="{instruction}",
            SYSTEM_PROMPT_TRAVEL_ZH="{instruction}",
            remove_prefix=lambda value: value,
        ),
        "model_inference.multi_turn.execution_role": module(
            "model_inference.multi_turn.execution_role", EXECUTION=PlaceholderRole
        ),
        "model_inference.multi_turn.multi_turn_scene": module(
            "model_inference.multi_turn.multi_turn_scene", Scene=PlaceholderRole
        ),
        "model_inference.prompt_en": module(
            "model_inference.prompt_en", BASE_PROMPT_EN="base", TRAVEL_PROMPT_EN="travel"
        ),
        "model_inference.prompt_zh": module(
            "model_inference.prompt_zh", BASE_PROMPT_ZH="base", TRAVEL_PROMPT_ZH="travel"
        ),
    }
    for package in (
        "model_inference",
        "model_inference.multi_step",
        "model_inference.multi_turn",
    ):
        stubs[package].__path__ = []  # type: ignore[attr-defined]
    spec = importlib.util.spec_from_file_location("acebench_cap_test_adapter", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load ACEBench adapter")
    adapter = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, stubs):
        spec.loader.exec_module(adapter)
    return adapter


class FakeCompletions:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def create(self, **kwargs: object) -> object:
        self.calls.append(kwargs)
        message = types.SimpleNamespace(content="ok", tool_calls=None)
        return types.SimpleNamespace(
            choices=[types.SimpleNamespace(message=message)]
        )


class FakeClient:
    def __init__(self) -> None:
        self.completions = FakeCompletions()
        self.chat = types.SimpleNamespace(completions=self.completions)


class AcebenchProviderCapTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.adapter = load_adapter()

    def test_inference_map_uses_native_and_prompt_only_aliases(self) -> None:
        # Given: the ACEBench adapter has installed its inference map.
        # When: the registered model aliases are selected.
        aliases = set(self.adapter.inference_map)

        # Then: only the canonical native and prompt-only FC arms are available.
        self.assertEqual(
            aliases,
            {"glm52-native-FC", "glm52-prompt-only-FC"},
        )

    def test_call_message_forwards_only_the_canonical_provider_cap(self) -> None:
        client = FakeClient()

        self.adapter.call_message(
            client,
            messages=[{"role": "user", "content": "probe"}],
            model="glm52-native-FC",
            temperature=0.001,
            top_p=1,
            max_tokens=self.adapter.PROVIDER_MAX_TOKENS,
        )

        self.assertEqual(len(client.completions.calls), 1)
        self.assertEqual(
            client.completions.calls[0]["max_tokens"],
            self.adapter.PROVIDER_MAX_TOKENS,
        )

    def test_call_message_rejects_a_stale_cap_before_provider_io(self) -> None:
        for stale_cap in (1200, 16_384.0, True):
            with self.subTest(stale_cap=stale_cap):
                client = FakeClient()
                with self.assertRaisesRegex(RuntimeError, "max_tokens must be 16384"):
                    self.adapter.call_message(
                        client,
                        messages=[{"role": "user", "content": "probe"}],
                        model="glm52-native-FC",
                        temperature=0.001,
                        top_p=1,
                        max_tokens=stale_cap,
                    )
                self.assertEqual(client.completions.calls, [])

    def test_assistant_and_user_simulator_send_the_canonical_cap(self) -> None:
        clients: list[FakeClient] = []

        def client_factory(**_kwargs: object) -> FakeClient:
            client = FakeClient()
            clients.append(client)
            return client

        with patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "test-only",
                "OPENAI_BASE_URL": "http://127.0.0.1:1/v1",
            },
        ), patch.object(self.adapter, "OpenAI", side_effect=client_factory):
            assistant = self.adapter.NativeACEInference(
                "glm52-native-FC", language="en"
            )
            assistant.single_turn_inference("probe", [], "", "", "normal_0")
            simulator = self.adapter.NativeUser(
                involved_classes=[], language="en"
            )
            simulator.messages = [{"role": "user", "content": "probe"}]
            simulator._complete()

        self.assertEqual(len(clients), 2)
        self.assertEqual(
            [client.completions.calls[0]["max_tokens"] for client in clients],
            [self.adapter.PROVIDER_MAX_TOKENS] * 2,
        )

    def test_assistant_and_user_simulator_constructors_reject_stale_caps(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "max_tokens must be 16384"):
            self.adapter.NativeACEInference("glm52-native-FC", max_tokens=1200)
        with self.assertRaisesRegex(RuntimeError, "max_tokens must be 16384"):
            self.adapter.NativeUser(
                involved_classes=[], language="en", max_tokens=1000
            )


if __name__ == "__main__":
    unittest.main()
