#!/usr/bin/env python3
"""Regression tests for MCPMark's explicit LiteLLM timeout wrapper."""

from __future__ import annotations

import importlib
import os
from types import SimpleNamespace
from typing import TYPE_CHECKING
import unittest
from unittest.mock import AsyncMock, patch

if TYPE_CHECKING:
    from . import mcpmark_official as official
else:
    module_name = (
        f"{__package__}.mcpmark_official" if __package__ else "mcpmark_official"
    )
    official = importlib.import_module(module_name)


class MCPMarkModelAliasTest(unittest.TestCase):
    def test_model_registry_uses_native_and_prompt_only_aliases(self) -> None:
        # Given: the MCPMark wrapper has registered its bridge-backed models.
        # When: the benchmark-specific aliases are selected.
        aliases = {
            name
            for name in official.ModelConfig.MODEL_CONFIGS
            if name.startswith("glm52-")
        }

        # Then: only the canonical native and prompt-only arms are available.
        self.assertEqual(aliases, {"glm52-native", "glm52-prompt-only"})

    def test_prompt_only_alias_routes_through_its_exact_bridge_model(self) -> None:
        # Given: the canonical prompt-only bridge alias.
        # When: MCPMark resolves its registered model configuration.
        config = official.ModelConfig.MODEL_CONFIGS["glm52-prompt-only"]

        # Then: LiteLLM preserves the exact loopback model identifier.
        self.assertEqual(config["provider"], "openai")
        self.assertEqual(config["api_key_var"], "OPENAI_API_KEY")
        self.assertEqual(config["base_url_var"], "OPENAI_BASE_URL")
        self.assertEqual(
            config["litellm_input_model_name"],
            "openai/glm52-prompt-only",
        )


class MCPMarkLiteLLMTimeoutTest(unittest.IsolatedAsyncioTestCase):
    async def test_timeout_is_injected_and_explicit_value_is_preserved(self) -> None:
        completion = AsyncMock(return_value="ok")
        wrapped = official.install_explicit_litellm_timeout(completion, 1700.0)

        self.assertEqual(await wrapped(model="test"), "ok")
        completion.assert_awaited_once_with(model="test", timeout=1700.0)

        completion.reset_mock()
        self.assertEqual(
            await wrapped(model="test", timeout=42.0),
            "ok",
        )
        completion.assert_awaited_once_with(model="test", timeout=42.0)

    def test_invalid_timeout_environment_is_rejected(self) -> None:
        for value in ("0", "-1", "nan", "invalid"):
            with self.subTest(value=value):
                with patch.dict(
                    os.environ,
                    {"MCPMARK_LITELLM_TIMEOUT_SECONDS": value},
                ):
                    with self.assertRaisesRegex(RuntimeError, "positive number"):
                        official.configured_litellm_timeout_seconds()

    def test_invalid_compaction_fragment_environment_is_rejected(self) -> None:
        for value in ("0", "-1", "1.5", "invalid"):
            with self.subTest(value=value):
                with patch.dict(
                    os.environ,
                    {"MCPMARK_COMPACTION_FRAGMENT_CHARS": value},
                ):
                    with self.assertRaisesRegex(RuntimeError, "positive integer"):
                        official.configured_compaction_fragment_chars()

    def test_ordered_text_chunks_are_lossless_and_bounded(self) -> None:
        text = "abcdefghijklmnopqrstuvwxyz"
        chunks = official.ordered_text_chunks(text, 5)
        self.assertEqual("".join(chunks), text)
        self.assertTrue(all(0 < len(chunk) <= 5 for chunk in chunks))

    async def test_oversized_compaction_uses_bounded_hierarchy(self) -> None:
        class FakeAgent(official.MCPMarkAgent):
            SYSTEM_PROMPT = "system"
            api_key = "test-key"
            base_url = "http://bridge.test/v1"
            compaction_token = 10
            litellm_input_model_name = "openai/glm52-native"

            def _compaction_enabled(self) -> bool:
                return True

        response = SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content="short summary"),
                )
            ],
            usage=SimpleNamespace(
                prompt_tokens=3,
                completion_tokens=2,
                total_tokens=5,
            ),
        )
        completion = AsyncMock(return_value=response)
        messages = [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "goal"},
            {"role": "tool", "content": "x" * 300},
        ]
        totals = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        with (
            patch.dict(
                os.environ,
                {"MCPMARK_COMPACTION_FRAGMENT_CHARS": "100"},
            ),
            patch("mcpmark_official.litellm.acompletion", completion),
        ):
            agent = FakeAgent.__new__(FakeAgent)
            compacted = await official.compact_litellm_messages_with_bounded_hierarchy(
                agent,
                messages,
                totals,
                None,
                current_prompt_tokens=300,
            )

        self.assertEqual(compacted[:2], messages[:2])
        self.assertIn("short summary", compacted[2]["content"])
        self.assertGreater(completion.await_count, 1)
        self.assertEqual(totals["total_tokens"], completion.await_count * 5)


if __name__ == "__main__":
    unittest.main()
