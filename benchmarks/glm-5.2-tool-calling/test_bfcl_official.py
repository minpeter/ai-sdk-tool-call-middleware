#!/usr/bin/env python3

import importlib
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("bfcl_official.py")
result_ids = cast(
    Callable[[Path], tuple[list[str], int]],
    importlib.import_module("validate_bfcl_official").result_ids,
)


class StubOpenAICompletionsHandler:
    def _build_client_kwargs(self) -> dict[str, float | int]:
        return {}


class StubModelConfig:
    def __init__(self, **values) -> None:
        del values


class StubWebSearchAPI:
    show_snippet = False


def module(name: str, **values) -> types.ModuleType:
    value = types.ModuleType(name)
    value.__dict__.update(values)
    return value


class AdapterLoadError(RuntimeError):
    pass


def load_adapter() -> types.ModuleType:
    stubs = {
        "bs4": module("bs4", BeautifulSoup=type("BeautifulSoup", (), {})),
        "bfcl_eval": module("bfcl_eval"),
        "bfcl_eval.__main__": module("bfcl_eval.__main__", cli=lambda: None),
        "bfcl_eval.constants": module("bfcl_eval.constants"),
        "bfcl_eval.constants.model_config": module(
            "bfcl_eval.constants.model_config",
            MODEL_CONFIG_MAPPING={},
            ModelConfig=StubModelConfig,
        ),
        "bfcl_eval.eval_checker": module("bfcl_eval.eval_checker"),
        "bfcl_eval.eval_checker.multi_turn_eval": module(
            "bfcl_eval.eval_checker.multi_turn_eval"
        ),
        "bfcl_eval.eval_checker.multi_turn_eval.func_source_code": module(
            "bfcl_eval.eval_checker.multi_turn_eval.func_source_code"
        ),
        "bfcl_eval.eval_checker.multi_turn_eval.func_source_code.web_search": module(
            "bfcl_eval.eval_checker.multi_turn_eval.func_source_code.web_search",
            WebSearchAPI=StubWebSearchAPI,
        ),
        "bfcl_eval.model_handler": module("bfcl_eval.model_handler"),
        "bfcl_eval.model_handler.api_inference": module(
            "bfcl_eval.model_handler.api_inference"
        ),
        "bfcl_eval.model_handler.api_inference.openai_completion": module(
            "bfcl_eval.model_handler.api_inference.openai_completion",
            OpenAICompletionsHandler=StubOpenAICompletionsHandler,
        ),
    }
    spec = importlib.util.spec_from_file_location("bfcl_official", SCRIPT)
    if spec is None or spec.loader is None:
        raise AdapterLoadError("could not load BFCL adapter")
    adapter = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, stubs):
        spec.loader.exec_module(adapter)
    return adapter


bfcl_official = load_adapter()
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
