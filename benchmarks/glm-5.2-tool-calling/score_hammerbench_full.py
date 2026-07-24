#!/usr/bin/env python3
"""Complete-only HammerBench scoring with the pinned repository metrics."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable


ARMS = ("glm52-native", "glm52-prompt-only")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise RuntimeError(f"{path}:{line_number}: expected object")
            rows.append(value)
    return rows


def require_error_free_rows(rows: list[dict[str, Any]], *, arm: str) -> None:
    error_indices = [
        row.get("globalIndex")
        for row in rows
        if row.get("error") is not None
    ]
    if error_indices:
        raise RuntimeError(
            f"{arm}: HammerBench inference error rows={len(error_indices)} "
            f"sampleGlobalIndices={error_indices[:10]}; refusing to score"
        )


def summarize(
    rows: list[dict[str, Any]],
    *,
    parse_response: Callable[..., Any],
    get_args_accuracy: Callable[..., bool],
    get_miss_redundant_num: Callable[..., tuple[int, int]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    function_correct: list[bool] = []
    argument_correct: list[bool] = []
    hallucinations: list[int] = []
    misses: list[int] = []
    output_strings = 0
    rejection_count = 0
    scored: list[dict[str, Any]] = []
    for row in rows:
        raw_predict = row.get("predict")
        parsed: object = raw_predict
        try:
            name, arguments = parse_response(str(raw_predict), "```json", "```")[0]
            parsed = {"name": name, "arguments": arguments}
        except Exception:
            output_strings += 1
        label = row["label"]
        func_ok = isinstance(parsed, dict) and parsed.get("name") == label.get("name")
        function_correct.append(func_ok)
        if not func_ok and "sorry" in str(raw_predict).lower():
            rejection_count += 1
        if isinstance(parsed, dict):
            predicted_arguments = parsed.get("arguments")
            args_ok = get_args_accuracy(label.get("arguments", {}), predicted_arguments)
            if isinstance(predicted_arguments, dict):
                hallucinated, missing = get_miss_redundant_num(
                    label.get("arguments", {}), predicted_arguments
                )
            else:
                hallucinated, missing = 0, len(label.get("arguments", {}))
        else:
            args_ok = False
            hallucinated, missing = 0, len(label.get("arguments", {}))
        argument_correct.append(bool(args_ok))
        hallucinations.append(hallucinated)
        misses.append(missing)
        scored.append(
            {
                **row,
                "argumentsCorrect": bool(args_ok),
                "functionCorrect": func_ok,
                "success": bool(func_ok and args_ok),
            }
        )
    function_matched_hallucinations = [
        value for value, matched in zip(hallucinations, function_correct) if matched
    ]
    function_matched_misses = [
        value for value, matched in zip(misses, function_correct) if matched
    ]
    total = len(rows)
    matched_total = len(function_matched_hallucinations)
    return (
        {
            "argumentAccuracy": sum(argument_correct) / total,
            "averageParameterHallucinations": sum(hallucinations) / total,
            "averageParameterMisses": sum(misses) / total,
            "functionAccuracy": sum(function_correct) / total,
            "outputStringRatio": output_strings / total,
            "parameterFalseNegativeRateGivenFunctionMatch": (
                sum(value > 0 for value in function_matched_misses) / matched_total
                if matched_total
                else None
            ),
            "parameterFalsePositiveRateGivenFunctionMatch": (
                sum(value > 0 for value in function_matched_hallucinations)
                / matched_total
                if matched_total
                else None
            ),
            "rejectionRate": rejection_count / total,
            "successCount": sum(
                func and args
                for func, args in zip(function_correct, argument_correct)
            ),
            "successRate": sum(
                func and args
                for func, args in zip(function_correct, argument_correct)
            )
            / total,
            "total": total,
        },
        scored,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--code-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--prompt-only", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.code_root.resolve()))
    from evaluation.metrics import (
        get_e2e_rougel,
        get_e2e_rougel_en,
        get_miss_redundant_num,
    )
    from evaluation.process_output import parse_response

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    expected = manifest["rows"]
    if len(expected) != 61075:
        raise RuntimeError("HammerBench manifest is not exactly 61,075 rows")
    input_paths = {
        "glm52-native": args.native,
        "glm52-prompt-only": args.prompt_only,
    }
    summaries: dict[str, Any] = {}
    scored_rows: list[dict[str, Any]] = []
    for arm in ARMS:
        rows = read_jsonl(input_paths[arm])
        require_error_free_rows(rows, arm=arm)
        indices = [int(row.get("globalIndex", -1)) for row in rows]
        duplicates = [key for key, count in Counter(indices).items() if count > 1]
        if len(rows) != 61075 or duplicates or set(indices) != set(range(61075)):
            raise RuntimeError(
                f"{arm}: incomplete rows={len(rows)}/61075 duplicates={len(duplicates)}"
            )
        rows.sort(key=lambda row: int(row["globalIndex"]))
        for expected_row, row in zip(expected, rows):
            for field in ("id", "language", "sourceIndex", "split"):
                if row.get(field) != expected_row.get(field):
                    raise RuntimeError(
                        f"{arm}: manifest mismatch at {row['globalIndex']} field={field}"
                    )
        by_slice: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            by_slice[f"{row['language']}/{row['split']}"].append(row)
        slice_summaries: dict[str, Any] = {}
        arm_scored: list[dict[str, Any]] = []
        for name, slice_rows in sorted(by_slice.items()):
            language = name.split("/", 1)[0]
            summary, scored = summarize(
                slice_rows,
                parse_response=parse_response,
                get_args_accuracy=(
                    get_e2e_rougel_en if language == "en" else get_e2e_rougel
                ),
                get_miss_redundant_num=get_miss_redundant_num,
            )
            slice_summaries[name] = summary
            arm_scored.extend(scored)
        overall_success = sum(row["success"] for row in arm_scored)
        summaries[arm] = {
            "slices": slice_summaries,
            "successCount": overall_success,
            "successRate": overall_success / 61075,
            "total": 61075,
        }
        scored_rows.extend({**row, "arm": arm} for row in arm_scored)
    by_arm_key = {
        arm: {int(row["globalIndex"]): bool(row["success"]) for row in scored_rows if row["arm"] == arm}
        for arm in ARMS
    }
    paired = Counter()
    for index in range(61075):
        native = by_arm_key[ARMS[0]][index]
        prompt_only = by_arm_key[ARMS[1]][index]
        paired[(native, prompt_only)] += 1
    summary = {
        "arms": summaries,
        "benchmark": "HammerBench",
        "complete": True,
        "paired": {
            "bothFail": paired[(False, False)],
            "bothPass": paired[(True, True)],
            "nativeOnlyPass": paired[(True, False)],
            "promptOnlyOnlyPass": paired[(False, True)],
        },
        "scorer": "Pinned official parse and metric functions; fixed upstream zh loop variable typo without changing metric semantics.",
        "status": "complete",
        "taskCountPerArm": 61075,
        "taskSetSha256": manifest["taskSetSha256"],
    }
    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    with (args.out_dir / "scored.jsonl").open("w", encoding="utf-8") as handle:
        for row in scored_rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(json.dumps({"status": "complete", "rows": len(scored_rows)}))


if __name__ == "__main__":
    main()
