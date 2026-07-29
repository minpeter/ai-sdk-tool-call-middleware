#!/usr/bin/env python3
"""Score ACEBench-derived tool calls with ACEBench's official checker.

The benchmark runner already converts every protocol into normalized AI SDK
tool calls. This adapter maps those calls to ACEBench's list-of-dictionaries
representation and delegates semantic validation to ``normal_checker`` from
the pinned ACEBench checkout.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Callable


LEAK_PATTERNS = (
    "<tool_call",
    "</tool_call",
    "<function=",
    "</function>",
    "<tools>",
    "[TOOL_CALLS]",
    "<|tool_call",
)

# These cases fail when their own ground truth is fed to the official checker.
# The scorer also runs the oracle check dynamically; this map keeps the known
# upstream defects explicit and makes excluded rows easier to audit.
KNOWN_ORACLE_FAILURES = {
    ("en", "normal_single_turn_parallel_function_42"):
        "Official checker cannot match distinct arguments for repeated calls.",
    ("en", "normal_preference_40"):
        "Ground truth contains a value incompatible with the function schema.",
    ("zh", "normal_single_turn_parallel_function_45"):
        "Ground truth fails the official argument type checker.",
    ("zh", "normal_single_turn_parallel_function_80"):
        "Official checker cannot match distinct arguments for repeated calls.",
    ("zh", "normal_similar_api_2"):
        "Official checker strips a numeric suffix that belongs to the tool name.",
    ("zh", "normal_similar_api_22"):
        "Official checker strips a numeric suffix that belongs to the tool name.",
    ("zh", "normal_atom_list_28"):
        "Official nested type checker rejects the ground-truth empty list.",
    ("zh", "normal_atom_object_short_1"):
        "Ground truth omits a parameter marked required by the function schema.",
}

NormalChecker = Callable[
    [list[dict[str, Any]], list[dict[str, Any]], dict[str, Any], str, str],
    dict[str, Any],
]


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def error_strings(value: Any) -> list[str]:
    if value is None or value == "":
        return []
    values = value if isinstance(value, list) else [value]
    return [
        item
        if isinstance(item, str)
        else json.dumps(item, ensure_ascii=False, sort_keys=True)
        for item in values
    ]


def deduplicate_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep the first success, or the most recent failure, for every ACE job."""
    selected: dict[tuple[str, str, str, str, int], dict[str, Any]] = {}
    for row in rows:
        key = (
            str(row["language"]),
            str(row["category"]),
            str(row["caseId"]),
            str(row["arm"]),
            int(row.get("trial", 0)),
        )
        current = selected.get(key)
        if current is None or (
            not current.get("transportOk") and row.get("transportOk")
        ):
            selected[key] = row
        elif not current.get("transportOk"):
            selected[key] = row
    return list(selected.values())


def has_markup_leak(row: dict[str, Any]) -> bool:
    if row.get("textLeak"):
        return True
    text = row.get("text", "")
    if not isinstance(text, str):
        return True
    if any(pattern in text for pattern in LEAK_PATTERNS):
        return True
    for mapping in row.get("nameMap", []):
        if not isinstance(mapping, dict):
            continue
        for name in (mapping.get("safe"), mapping.get("original")):
            if isinstance(name, str) and (
                f"<{name}" in text or f"</{name}" in text
            ):
                return True
    return False


def calls_have_valid_shape(row: dict[str, Any]) -> bool:
    calls = row.get("calls", [])
    return isinstance(calls, list) and all(
        isinstance(call, dict)
        and isinstance(call.get("name"), str)
        and isinstance(call.get("arguments"), dict)
        for call in calls
    )


def has_boundary_whitespace(value: Any) -> bool:
    if isinstance(value, str):
        return value != value.strip()
    if isinstance(value, dict):
        return any(has_boundary_whitespace(item) for item in value.values())
    if isinstance(value, list):
        return any(has_boundary_whitespace(item) for item in value)
    return False


def normalized_model_output(row: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {str(call["name"]): call["arguments"]}
        for call in row.get("calls", [])
    ]


def ground_truth_candidates(answer: dict[str, Any]) -> list[dict[str, Any]]:
    ground_truth = answer["ground_truth"]
    candidates = ground_truth if isinstance(ground_truth, list) else [ground_truth]
    if not candidates or not all(isinstance(item, dict) for item in candidates):
        raise ValueError("ACE normal ground_truth must be a dictionary or a list of dictionaries")
    return candidates


def oracle_model_output(
    functions: list[dict[str, Any]], candidate: dict[str, Any]
) -> list[dict[str, Any]]:
    """Convert a ground-truth call set into the model-output representation.

    ACEBench suffixes repeated calls with ``_1``, ``_2``, and so on. A few
    real tool names also end in such suffixes, so exact function-name matches
    take precedence over stripping.
    """
    function_names = {
        item.get("name") for item in functions if isinstance(item.get("name"), str)
    }
    output: list[dict[str, Any]] = []
    for answer_name, arguments in candidate.items():
        if answer_name in function_names:
            function_name = answer_name
        else:
            stripped = re.sub(r"_\d+$", "", answer_name)
            function_name = stripped if stripped in function_names else answer_name
        output.append({function_name: arguments})
    return output


def run_checker_candidates(
    checker: NormalChecker,
    prompt: dict[str, Any],
    candidates: list[dict[str, Any]],
    calls: list[dict[str, Any]],
    category: str,
) -> tuple[bool, list[str], str | None]:
    first_errors: list[str] = []
    first_error_type: str | None = None
    exception_errors: list[str] = []
    for candidate in candidates:
        try:
            result = checker(
                prompt["function"],
                calls,
                candidate,
                prompt["question"],
                category,
            )
        except Exception as error:  # keep upstream scorer failures auditable
            exception_errors.append(f"{type(error).__name__}: {error}")
            continue
        if result.get("valid"):
            return True, [], None
        if first_error_type is None:
            first_error_type = str(result.get("error_type") or "ace_checker_error")
            first_errors = error_strings(result.get("error"))
    if first_error_type is not None:
        return False, first_errors, first_error_type
    return False, exception_errors, "scorer_error"


def oracle_validate(
    checker: NormalChecker,
    prompt: dict[str, Any],
    candidates: list[dict[str, Any]],
    category: str,
) -> tuple[bool, list[str]]:
    errors: list[str] = []
    for candidate in candidates:
        oracle_calls = oracle_model_output(prompt["function"], candidate)
        valid, candidate_errors, error_type = run_checker_candidates(
            checker, prompt, [candidate], oracle_calls, category
        )
        if valid:
            return True, []
        detail = "; ".join(candidate_errors) or "Unknown oracle-check failure."
        errors.append(f"{error_type}: {detail}")
    return False, errors


def load_reference_data(
    ace_root: Path, rows: list[dict[str, Any]]
) -> tuple[
    dict[tuple[str, str], dict[str, dict[str, Any]]],
    dict[tuple[str, str], dict[str, dict[str, Any]]],
]:
    strata = sorted(
        {(str(row["language"]), str(row["category"])) for row in rows}
    )
    prompts: dict[tuple[str, str], dict[str, dict[str, Any]]] = {}
    answers: dict[tuple[str, str], dict[str, dict[str, Any]]] = {}
    for language, category in strata:
        data_dir = ace_root / "data_all" / f"data_{language}"
        prompt_path = data_dir / f"data_{category}.json"
        answer_path = data_dir / "possible_answer" / f"data_{category}.json"
        prompts[(language, category)] = {
            str(item["id"]): item for item in load_jsonl(prompt_path)
        }
        answers[(language, category)] = {
            str(item["id"]): item for item in load_jsonl(answer_path)
        }
    return prompts, answers


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--ace-root", required=True, type=Path)
    args = parser.parse_args()

    sys.path.insert(0, str(args.ace_root))
    from model_eval.checker import normal_checker  # noqa: PLC0415

    raw_rows = deduplicate_rows(load_jsonl(args.raw))
    prompts, answers = load_reference_data(args.ace_root, raw_rows)
    oracle_cache: dict[tuple[str, str, str], tuple[bool, list[str]]] = {}
    scored_rows: list[dict[str, Any]] = []

    for row in raw_rows:
        language = str(row["language"])
        category = str(row["category"])
        case_id = str(row["caseId"])
        prompt = prompts[(language, category)].get(case_id)
        answer = answers[(language, category)].get(case_id)
        if prompt is None or answer is None:
            raise KeyError(
                f"Missing ACE reference row for {language}/{category}/{case_id}"
            )
        candidates = ground_truth_candidates(answer)
        ground_truth_has_boundary_whitespace = any(
            has_boundary_whitespace(candidate) for candidate in candidates
        )
        oracle_key = (language, category, case_id)
        if oracle_key not in oracle_cache:
            oracle_cache[oracle_key] = oracle_validate(
                normal_checker, prompt, candidates, category
            )
        benchmark_item_valid, benchmark_item_errors = oracle_cache[oracle_key]
        known_reason = KNOWN_ORACLE_FAILURES.get((language, case_id))
        if known_reason and known_reason not in benchmark_item_errors:
            benchmark_item_errors = [known_reason, *benchmark_item_errors]

        transport_ok = bool(row.get("transportOk"))
        text_leak = has_markup_leak(row)
        call_shape_valid = calls_have_valid_shape(row)
        argument_boundary_whitespace = bool(
            has_boundary_whitespace(row.get("calls", []))
            and not ground_truth_has_boundary_whitespace
        )
        parser_errors = row.get("parserErrors", [])
        protocol_valid = bool(
            transport_ok
            and call_shape_valid
            and isinstance(parser_errors, list)
            and not parser_errors
            and not argument_boundary_whitespace
            and not text_leak
        )
        ace_correct: bool | None = None
        score_errors: list[str] = []
        score_error_type: str | None = None

        if not benchmark_item_valid:
            score_error_type = "benchmark_item_excluded"
            score_errors = benchmark_item_errors
        elif not transport_ok:
            score_error_type = "provider_error"
            score_errors = [str(row.get("error") or "Provider call failed.")]
        elif not call_shape_valid:
            ace_correct = False
            score_error_type = "wrong_output_format"
            score_errors = ["One or more tool calls had non-object arguments."]
        else:
            ace_correct, score_errors, score_error_type = run_checker_candidates(
                normal_checker,
                prompt,
                candidates,
                normalized_model_output(row),
                category,
            )

        scored_rows.append(
            {
                **row,
                "aceCorrect": ace_correct,
                "benchmarkItemErrors": benchmark_item_errors,
                "benchmarkItemValid": benchmark_item_valid,
                "callShapeValid": call_shape_valid,
                "argumentBoundaryWhitespace": argument_boundary_whitespace,
                "evaluable": bool(benchmark_item_valid and transport_ok),
                "protocolValid": protocol_valid,
                "scoreErrors": score_errors,
                "scoreErrorType": score_error_type,
                "strictCorrect": bool(
                    benchmark_item_valid and ace_correct and protocol_valid
                ),
                "textLeak": text_leak,
            }
        )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as output:
        for row in scored_rows:
            output.write(json.dumps(row, ensure_ascii=False) + "\n")

    excluded_cases = sum(not valid for valid, _ in oracle_cache.values())
    eligible_rows = sum(bool(row["benchmarkItemValid"]) for row in scored_rows)
    print(
        f"Scored {len(scored_rows)} rows -> {args.out} "
        f"(eligible rows={eligible_rows}, excluded cases={excluded_cases})"
    )


if __name__ == "__main__":
    main()
