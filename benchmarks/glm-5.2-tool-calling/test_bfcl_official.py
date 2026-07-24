#!/usr/bin/env python3

import importlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from typing import Any, cast
from unittest.mock import patch

from validate_bfcl_official import result_ids

bfcl_official = importlib.import_module("bfcl_official")
BRIDGE_RETRY_WINDOW_SECONDS = cast(
    float, bfcl_official.BRIDGE_RETRY_WINDOW_SECONDS
)
DEFAULT_BFCL_CLIENT_MAX_RETRIES = cast(
    int, bfcl_official.DEFAULT_BFCL_CLIENT_MAX_RETRIES
)
DEFAULT_BFCL_REQUEST_TIMEOUT_SECONDS = cast(
    float, bfcl_official.DEFAULT_BFCL_REQUEST_TIMEOUT_SECONDS
)
BridgeOpenAICompletionsHandler = cast(
    type[Any], bfcl_official.BridgeOpenAICompletionsHandler
)


class BFCLModelAliasTest(unittest.TestCase):
    def test_model_registry_uses_native_and_prompt_only_aliases(self) -> None:
        # Given: the BFCL wrapper has registered its bridge-backed models.
        # When: the benchmark-specific aliases are selected.
        aliases = {
            name
            for name in bfcl_official.MODEL_CONFIG_MAPPING
            if name.startswith("glm52-")
        }

        # Then: only the canonical native and prompt-only arms are available.
        self.assertEqual(aliases, {"glm52-native", "glm52-prompt-only"})


class BridgeOpenAICompletionsHandlerTest(unittest.TestCase):
    def client_kwargs(self) -> dict[str, float | int]:
        handler = object.__new__(BridgeOpenAICompletionsHandler)
        return cast(dict[str, float | int], handler._build_client_kwargs())

    def test_defaults_cover_bridge_retry_window_and_enable_external_retries(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            kwargs = self.client_kwargs()

        self.assertEqual(kwargs["timeout"], DEFAULT_BFCL_REQUEST_TIMEOUT_SECONDS)
        self.assertGreater(kwargs["timeout"], BRIDGE_RETRY_WINDOW_SECONDS)
        self.assertEqual(kwargs["max_retries"], DEFAULT_BFCL_CLIENT_MAX_RETRIES)

    def test_timeout_at_retry_window_is_rejected(self) -> None:
        with patch.dict(
            os.environ,
            {"BFCL_REQUEST_TIMEOUT_SECONDS": str(BRIDGE_RETRY_WINDOW_SECONDS)},
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "must exceed"):
                self.client_kwargs()

    def test_explicit_timeout_and_retry_count_are_forwarded(self) -> None:
        with patch.dict(
            os.environ,
            {
                "BFCL_CLIENT_MAX_RETRIES": "3",
                "BFCL_REQUEST_TIMEOUT_SECONDS": "1000",
            },
            clear=True,
        ):
            kwargs = self.client_kwargs()

        self.assertEqual(kwargs["timeout"], 1000.0)
        self.assertEqual(kwargs["max_retries"], 3)


class BFCLResultCoverageTest(unittest.TestCase):
    def write_result(self, root: Path, result: Any) -> None:
        path = root / "BFCL_v4_simple_result.json"
        path.write_text(
            json.dumps({"id": "simple_0", "result": result}) + "\n",
            encoding="utf-8",
        )

    def test_result_ids_accepts_list_payloads(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_result(root, [])
            self.assertEqual(result_ids(root), (["simple_0"], 1))

    def test_result_ids_rejects_inference_error_sentinel(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_result(root, "Error during inference: timeout")
            with self.assertRaisesRegex(RuntimeError, "inference error sentinel"):
                result_ids(root)

    def test_result_ids_rejects_other_non_list_payloads(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_result(root, {"unexpected": True})
            with self.assertRaisesRegex(RuntimeError, "expected result list"):
                result_ids(root)


if __name__ == "__main__":
    unittest.main()
