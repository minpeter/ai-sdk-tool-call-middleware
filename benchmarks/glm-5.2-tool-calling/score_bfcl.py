#!/usr/bin/env python3
"""Score normalized AI SDK tool calls with BFCL's official AST checker."""

from __future__ import annotations

import argparse
import json
import sys
import types
from pathlib import Path
from typing import Any


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


TYPE_NORMALIZATION = {
    "Array": "array",
    "ArrayList": "array",
    "Any": "any",
    "Bigint": "integer",
    "Boolean": "boolean",
    "HashMap": "dict",
    "Hashtable": "dict",
    "Queue": "array",
    "Set": "array",
    "Stack": "array",
    "String": "string",
    "bool": "boolean",
    "byte": "integer",
    "char": "string",
    "double": "float",
    "list": "array",
    "long": "integer",
    "number": "float",
    "object": "dict",
    "short": "integer",
}

LEAK_PATTERNS = (
    "<tool_call",
    "</tool_call",
    "<function=",
    "</function>",
    "<tools>",
    "[TOOL_CALLS]",
    "<|tool_call",
)


def normalize_schema_node(schema: Any) -> Any:
    """Map Java/JavaScript schema nodes to equivalent Python schema nodes.

    AI SDK has already decoded every tool argument into JSON values. BFCL's Java
    and JavaScript adapters normally receive source-code strings and decode them
    before calling the AST checker. Normalizing only the schema type labels lets
    the same official checker validate the already-decoded JSON values.
    """
    if not isinstance(schema, dict):
        return schema
    normalized = dict(schema)
    if isinstance(normalized.get("type"), str):
        normalized["type"] = TYPE_NORMALIZATION.get(
            normalized["type"], normalized["type"]
        )
    properties = normalized.get("properties")
    if isinstance(properties, dict):
        normalized["properties"] = {
            name: normalize_schema_node(child)
            for name, child in properties.items()
        }
    items = normalized.get("items")
    if isinstance(items, list):
        normalized["items"] = [normalize_schema_node(item) for item in items]
    elif isinstance(items, dict):
        normalized["items"] = normalize_schema_node(items)
    if isinstance(normalized.get("additionalProperties"), dict):
        normalized["additionalProperties"] = normalize_schema_node(
            normalized["additionalProperties"]
        )
    for keyword in ("allOf", "anyOf", "oneOf"):
        if isinstance(normalized.get(keyword), list):
            normalized[keyword] = [
                normalize_schema_node(item) for item in normalized[keyword]
            ]
    return normalized


def normalize_function_schemas(functions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized_functions: list[dict[str, Any]] = []
    for function in functions:
        normalized = dict(function)
        normalized["parameters"] = normalize_schema_node(
            function.get("parameters", {})
        )
        normalized_functions.append(normalized)
    return normalized_functions


def has_markup_leak(row: dict[str, Any]) -> bool:
    """Detect protocol markup left in assistant text after middleware parsing."""
    if row.get("textLeak"):
        return True
    text = row.get("text", "")
    if any(pattern in text for pattern in LEAK_PATTERNS):
        return True
    for mapping in row.get("nameMap", []):
        for name in (mapping.get("safe"), mapping.get("original")):
            if name and (f"<{name}" in text or f"</{name}" in text):
                return True
    return False


def normalized_model_output(row: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {call["name"]: call["arguments"]}
        for call in row.get("calls", [])
    ]


def calls_have_valid_shape(row: dict[str, Any]) -> bool:
    calls = row.get("calls", [])
    return isinstance(calls, list) and all(
        isinstance(call, dict)
        and isinstance(call.get("name"), str)
        and isinstance(call.get("arguments"), dict)
        for call in calls
    )


def deduplicate_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep the first successful attempt, or the last failure, for each job."""
    selected: dict[tuple[str, str, str, int], dict[str, Any]] = {}
    for row in rows:
        key = (
            row["category"],
            row["caseId"],
            row["arm"],
            int(row["trial"]),
        )
        current = selected.get(key)
        if current is None or (
            not current.get("transportOk") and row.get("transportOk")
        ):
            selected[key] = row
        elif not current.get("transportOk"):
            selected[key] = row
    return list(selected.values())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--bfcl-root", required=True, type=Path)
    args = parser.parse_args()

    sys.path.insert(0, str(args.bfcl_root))
    fake_config = types.ModuleType("bfcl_eval.constants.model_config")
    fake_config.MODEL_CONFIG_MAPPING = {
        "glm52-protocol-benchmark": types.SimpleNamespace(
            underscore_to_dot=False
        )
    }
    sys.modules["bfcl_eval.constants.model_config"] = fake_config

    from bfcl_eval.constants.enums import Language  # noqa: PLC0415
    from bfcl_eval.eval_checker.ast_eval.ast_checker import (  # noqa: PLC0415
        ast_checker,
    )

    raw_rows = deduplicate_rows(load_jsonl(args.raw))
    categories = sorted({row["category"] for row in raw_rows})
    prompts: dict[str, dict[str, dict[str, Any]]] = {}
    answers: dict[str, dict[str, dict[str, Any]]] = {}

    for category in categories:
        data_dir = args.bfcl_root / "bfcl_eval" / "data"
        prompt_path = data_dir / f"BFCL_v4_{category}.json"
        prompts[category] = {
            row["id"]: row for row in load_jsonl(prompt_path)
        }
        answer_path = data_dir / "possible_answer" / f"BFCL_v4_{category}.json"
        answers[category] = (
            {row["id"]: row for row in load_jsonl(answer_path)}
            if answer_path.exists()
            else {}
        )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as output:
        for row in raw_rows:
            category = row["category"]
            case_id = row["caseId"]
            transport_ok = bool(row.get("transportOk"))
            text_leak = has_markup_leak(row)
            call_shape_valid = calls_have_valid_shape(row)
            protocol_valid = (
                transport_ok
                and call_shape_valid
                and not row.get("parserErrors")
                and not text_leak
            )
            score_errors: list[str] = []
            score_error_type: str | None = None
            bfcl_correct: bool | None = None

            if transport_ok:
                calls = (
                    normalized_model_output(row) if call_shape_valid else []
                )
                prompt = prompts[category][case_id]
                if not call_shape_valid:
                    bfcl_correct = False
                    score_error_type = "ast_decoder:decoder_wrong_output_format"
                    score_errors = [
                        "One or more tool calls had non-object arguments."
                    ]
                elif "irrelevance" in category:
                    bfcl_correct = len(calls) == 0
                    if not bfcl_correct:
                        score_error_type = "irrelevance:unexpected_call"
                        score_errors = [
                            f"Expected no function call, received {len(calls)}."
                        ]
                elif category.endswith("relevance"):
                    bfcl_correct = len(calls) > 0
                    if not bfcl_correct:
                        score_error_type = "relevance:missing_call"
                        score_errors = ["Expected at least one relevant call."]
                else:
                    possible = answers[category][case_id]["ground_truth"]
                    try:
                        checker_result = ast_checker(
                            normalize_function_schemas(prompt["function"]),
                            calls,
                            possible,
                            Language.PYTHON,
                            category,
                            "glm52-protocol-benchmark",
                        )
                        bfcl_correct = bool(checker_result["valid"])
                        score_errors = checker_result.get("error", [])
                        score_error_type = checker_result.get("error_type")
                    except Exception as error:  # keep one bad row auditable
                        bfcl_correct = False
                        score_error_type = "scorer_error"
                        score_errors = [
                            f"{type(error).__name__}: {error}"
                        ]
            else:
                score_error_type = "provider_error"
                score_errors = [row.get("error", "Provider call failed.")]

            scored = {
                **row,
                "bfclCorrect": bfcl_correct,
                "callShapeValid": call_shape_valid,
                "evaluable": transport_ok,
                "protocolValid": protocol_valid,
                "scoreErrors": score_errors,
                "scoreErrorType": score_error_type,
                "strictCorrect": bool(bfcl_correct and protocol_valid),
                "textLeak": text_leak,
            }
            output.write(json.dumps(scored, ensure_ascii=False) + "\n")

    print(f"Scored {len(raw_rows)} rows -> {args.out}")


if __name__ == "__main__":
    main()
