#!/usr/bin/env python3
"""Static contract tests for the pinned StableToolBench runner adapter."""

from __future__ import annotations

import argparse
import ast
from pathlib import Path
import unittest

import stabletoolbench_official_native as official


HERE = Path(__file__).resolve().parent
ADAPTER = HERE / "stabletoolbench_official_native.py"
PINNED_UPSTREAM_ARGUMENTS = frozenset(
    {
        "api_customization",
        "backbone_model",
        "base_url",
        "chatgpt_model",
        "corpus_tsv_path",
        "disable_tqdm",
        "input_query_file",
        "lora",
        "lora_path",
        "max_observation_length",
        "max_query_count",
        "max_sequence_length",
        "max_source_sequence_length",
        "method",
        "model_path",
        "num_thread",
        "observ_compress_method",
        "openai_key",
        "output_answer_file",
        "rapidapi_key",
        "retrieval_model_path",
        "retrieved_api_nums",
        "single_chain_max_step",
        "tool_root_dir",
        "toolbench_key",
        "use_rapidapi_key",
    }
)


class StableToolBenchRunnerArgsTest(unittest.TestCase):
    def test_runner_accepts_only_canonical_bridge_models(self) -> None:
        self.assertEqual(
            official.OFFICIAL_MODELS,
            ("glm52-native", "glm52-prompt-only"),
        )
        for model in official.OFFICIAL_MODELS:
            self.assertEqual(official.official_model(model), model)
        with self.assertRaisesRegex(
            argparse.ArgumentTypeError,
            "glm52-prompt-only",
        ):
            official.official_model("glm52-native-plus")

    def test_request_output_cap_is_exactly_16384(self) -> None:
        tree = ast.parse(ADAPTER.read_text(encoding="utf-8"))
        default_cap = None
        completion_cap_name = None
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == "REQUIRED_MAX_TOKENS"
                for target in node.targets
            ) and isinstance(node.value, ast.Constant):
                default_cap = node.value.value
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if node.func.attr != "create":
                    continue
                for keyword in node.keywords:
                    if keyword.arg == "max_tokens" and isinstance(keyword.value, ast.Name):
                        completion_cap_name = keyword.value.id
        self.assertEqual(default_cap, 16_384)
        self.assertEqual(completion_cap_name, "REQUEST_MAX_TOKENS")

    def test_request_timeout_is_bounded_and_covers_bridge_retry_window(self) -> None:
        tree = ast.parse(ADAPTER.read_text(encoding="utf-8"))
        default_timeout = None
        openai_timeout_name = None
        bounded_argument = False
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name)
                and target.id == "DEFAULT_REQUEST_TIMEOUT_SECONDS"
                for target in node.targets
            ):
                if isinstance(node.value, ast.Constant):
                    default_timeout = node.value.value
            if isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name) and node.func.id == "OpenAI":
                    for keyword in node.keywords:
                        if keyword.arg == "timeout" and isinstance(
                            keyword.value, ast.Name
                        ):
                            openai_timeout_name = keyword.value.id
                if (
                    isinstance(node.func, ast.Attribute)
                    and node.func.attr == "add_argument"
                    and node.args
                    and isinstance(node.args[0], ast.Constant)
                    and node.args[0].value == "--request-timeout-seconds"
                ):
                    bounded_argument = any(
                        keyword.arg == "type"
                        and isinstance(keyword.value, ast.Name)
                        and keyword.value.id == "bounded_timeout"
                        for keyword in node.keywords
                    )
        self.assertEqual(default_timeout, 960)
        self.assertEqual(openai_timeout_name, "REQUEST_TIMEOUT_SECONDS")
        self.assertTrue(bounded_argument)

    def test_adapter_supplies_every_pinned_upstream_argument(self) -> None:
        tree = ast.parse(ADAPTER.read_text(encoding="utf-8"))
        supplied: set[str] = set()
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if not isinstance(node.func, ast.Name) or node.func.id != "SimpleNamespace":
                continue
            supplied.update(keyword.arg for keyword in node.keywords if keyword.arg)

        self.assertEqual(PINNED_UPSTREAM_ARGUMENTS - supplied, set())

    def test_thread_count_is_bounded(self) -> None:
        tree = ast.parse(ADAPTER.read_text(encoding="utf-8"))
        maximum = None
        bounded_argument = False
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                if any(
                    isinstance(target, ast.Name) and target.id == "MAX_THREADS"
                    for target in node.targets
                ) and isinstance(node.value, ast.Constant):
                    maximum = node.value.value
            if not isinstance(node, ast.Call):
                continue
            if not isinstance(node.func, ast.Attribute) or node.func.attr != "add_argument":
                continue
            if not node.args or not isinstance(node.args[0], ast.Constant):
                continue
            if node.args[0].value != "--threads":
                continue
            bounded_argument = any(
                keyword.arg == "type"
                and isinstance(keyword.value, ast.Name)
                and keyword.value.id == "bounded_threads"
                for keyword in node.keywords
            )
        self.assertEqual(maximum, 16)
        self.assertTrue(bounded_argument)


if __name__ == "__main__":
    unittest.main()
