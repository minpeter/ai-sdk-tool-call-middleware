#!/usr/bin/env python3
"""Regression tests for HammerBench's OpenAI tool-schema adapter."""

from __future__ import annotations

import argparse
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import hammerbench_official_native as hammer
from hammerbench_official_native import (
    Generator,
    REQUIRED_MAX_TOKENS,
    main,
    normalize_json_schema,
    openai_tools,
    require_error_free_generation,
    select_tasks,
)
from score_hammerbench_full import require_error_free_rows


class HammerBenchSchemaAdapterTest(unittest.TestCase):
    def test_runner_accepts_only_canonical_bridge_models(self) -> None:
        self.assertEqual(
            hammer.OFFICIAL_MODELS,
            ("glm52-native", "glm52-prompt-only"),
        )
        for model in hammer.OFFICIAL_MODELS:
            self.assertEqual(hammer.official_model(model), model)
        with self.assertRaisesRegex(
            argparse.ArgumentTypeError,
            "glm52-prompt-only",
        ):
            hammer.official_model("glm52-native-plus")

    def test_required_model_output_cap_is_16384(self) -> None:
        self.assertEqual(REQUIRED_MAX_TOKENS, 16_384)

    def test_runner_refuses_complete_status_for_generated_error_row(self) -> None:
        task = ({"id": "case-0", "tools": []}, "en", "single-turn", 0, 0)
        error_row = {"error": "provider failed", "globalIndex": 0}
        with TemporaryDirectory() as directory:
            output = Path(directory) / "rows.jsonl"
            with (
                patch(
                    "hammerbench_official_native.load_tasks",
                    return_value=[task],
                ),
                patch.object(Generator, "generate", return_value=error_row),
                patch(
                    "sys.argv",
                    [
                        "hammerbench_official_native.py",
                        "--data-root",
                        directory,
                        "--base-url",
                        "http://unused.invalid",
                        "--model",
                        "glm52-native",
                        "--out",
                        str(output),
                        "--max-tokens",
                        "16384",
                    ],
                ),
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "1 error rows.*refusing complete status"
                ):
                    main()

    def test_generation_refuses_complete_status_when_any_row_has_an_error(
        self,
    ) -> None:
        require_error_free_generation(0)
        with self.assertRaisesRegex(RuntimeError, "2 error rows"):
            require_error_free_generation(2)

    def test_scorer_rejects_inference_error_rows(self) -> None:
        require_error_free_rows(
            [{"error": None, "globalIndex": 0}], arm="glm52-native"
        )
        with self.assertRaisesRegex(
            RuntimeError, "inference error rows=1.*refusing to score"
        ):
            require_error_free_rows(
                [
                    {"error": None, "globalIndex": 0},
                    {"error": "provider failed", "globalIndex": 1},
                ],
                arm="glm52-native",
            )

    def test_preflight_limit_is_deterministic_and_never_resumes(self) -> None:
        tasks = [({"id": index}, "en", "single-turn", index, index) for index in range(5)]
        self.assertEqual(
            [row[-1] for row in select_tasks(tasks, global_index=None, limit=3)],
            [0, 1, 2],
        )
        self.assertEqual(
            [row[-1] for row in select_tasks(tasks, global_index=4, limit=1)],
            [4],
        )
        with self.assertRaisesRegex(RuntimeError, "limit must be positive"):
            select_tasks(tasks, global_index=None, limit=0)

    def test_float_is_mapped_recursively_without_mutating_source(self) -> None:
        source = {
            "properties": {
                "pay": {"type": "float"},
                "nested": {
                    "items": {"properties": {"ratio": {"type": "float"}}},
                    "type": "array",
                },
            },
            "type": "object",
        }
        normalized = normalize_json_schema(source)

        self.assertEqual(source["properties"]["pay"]["type"], "float")
        self.assertEqual(normalized["properties"]["pay"]["type"], "number")
        self.assertEqual(
            normalized["properties"]["nested"]["items"]["properties"][
                "ratio"
            ]["type"],
            "number",
        )

    def test_property_named_type_remains_a_schema_object(self) -> None:
        schema = {
            "properties": {
                "type": {"description": "kind", "type": "string"},
            },
            "type": "object",
        }
        self.assertEqual(normalize_json_schema(schema), schema)

    def test_unknown_schema_type_is_rejected_before_provider_call(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "unsupported.*double"):
            normalize_json_schema({"type": "double"})

    def test_openai_tools_emits_json_schema_number(self) -> None:
        tools = [
            {
                "name": "calculate",
                "description": "calculate pay",
                "parameters": {
                    "properties": {"pay": {"type": "float"}},
                    "type": "object",
                },
            }
        ]
        output = openai_tools(tools)
        self.assertEqual(
            output[0]["function"]["parameters"]["properties"]["pay"]["type"],
            "number",
        )


if __name__ == "__main__":
    unittest.main()
