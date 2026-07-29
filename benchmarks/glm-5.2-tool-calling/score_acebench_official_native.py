#!/usr/bin/env python3
"""Run ACEBench's pinned scorer on native FC result values.

The upstream scorer always applies a text-extraction step before ``decode_ast``.
That is correct for ACEBench's original text-call runner, but native FC results
are already the exact list-of-dictionaries representation consumed by the
pinned ``normal_checker``.  This adapter bypasses only that text extraction for
normal categories.  The official checker, special evaluator, agent evaluator,
category aggregation, weights, and workbook writer remain pinned upstream code.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_jsonl(path: Path) -> list[dict[str, Any]]:
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ace-root", required=True, type=Path)
    parser.add_argument("--result-root", required=True, type=Path)
    parser.add_argument("--data-root", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument(
        "--models", default="glm52-native-FC,glm52-native-plus-FC"
    )
    args = parser.parse_args()

    ace_root = args.ace_root.resolve()
    result_root = args.result_root.resolve()
    data_root = args.data_root.resolve()
    out = args.out.resolve()
    adapter_path = Path(__file__).resolve()
    models = [value.strip() for value in args.models.split(",") if value.strip()]
    if models != ["glm52-native-FC", "glm52-native-plus-FC"]:
        raise RuntimeError(f"unexpected ACEBench native arms: {models}")
    if out.exists():
        raise RuntimeError(f"refusing to reuse score output: {out}")
    out.mkdir(parents=True)
    # The pinned agent-process evaluator writes one auxiliary file through a
    # hard-coded ``./score_all/...`` path.  Run from the isolated scorer root so
    # that this upstream relative path remains contained in the fresh output.
    os.chdir(out)

    sys.path.insert(0, str(ace_root))
    import eval_main as official  # noqa: PLC0415
    from category import ACE_DATA_CATEGORY  # noqa: PLC0415

    def decode_native_fc(value: Any, model_name: str) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            raise TypeError("native FC result must be a list")
        decoded = official.decode_ast(model_name, value)
        if not official.is_function_call_format_valid(decoded):
            raise TypeError("decoded native FC result has an invalid shape")
        return decoded

    def normal_single_turn_native(
        model_result: list[dict[str, Any]],
        prompt: list[dict[str, Any]],
        possible_answer: list[dict[str, Any]],
        test_category: str,
        model_name: str,
        paths: dict[str, str],
    ) -> float:
        if not all(
            len(value) == len(model_result)
            for value in (prompt, possible_answer)
        ):
            raise ValueError("ACEBench result/prompt/answer length mismatch")
        result: list[dict[str, Any]] = []
        correct_count = 0
        for index, result_row in enumerate(model_result):
            task_id = prompt[index]["id"]
            question = prompt[index]["question"]
            raw_result = result_row["result"]
            functions = prompt[index]["function"]
            answer = possible_answer[index]["ground_truth"]
            try:
                decoded = decode_native_fc(raw_result, model_name)
            except Exception as error:  # keep malformed model output in population
                result.append(
                    {
                        "id": task_id,
                        "valid": False,
                        "error": [
                            "Invalid native FC value. "
                            f"Failed to decode: {type(error).__name__}: {error}"
                        ],
                        "error_type": "wrong_output_format",
                        "model_result_raw": raw_result,
                        "possible_answer": answer,
                    }
                )
                continue
            candidates = answer if isinstance(answer, list) else [answer]
            all_errors: list[dict[str, Any]] = []
            valid = False
            for candidate in candidates:
                checker_result = official.normal_checker(
                    functions,
                    decoded,
                    candidate,
                    question,
                    test_category,
                )
                if checker_result["valid"]:
                    correct_count += 1
                    valid = True
                    break
                all_errors.append(
                    {
                        "error": checker_result["error"],
                        "error_type": checker_result["error_type"],
                    }
                )
            if not valid:
                result.append(
                    {
                        "id": task_id,
                        "valid": False,
                        "error": all_errors[0]["error"],
                        "error_type": all_errors[0]["error_type"],
                        "model_result": raw_result,
                        "possible_answer": candidates[-1],
                    }
                )
        accuracy = round(correct_count / len(model_result), 3)
        result.insert(
            0,
            {
                "accuracy": accuracy,
                "correct_count": correct_count,
                "total_count": len(model_result),
            },
        )
        official.save_score_as_json(
            f"data_{test_category}_score.json",
            result,
            os.path.join(official.OUTPUT_PATH, model_name),
        )
        official.convert_result_to_excel(model_name, test_category, paths)
        return accuracy

    def normal_multi_turn_native(
        model_result: list[dict[str, Any]],
        prompt: list[dict[str, Any]],
        possible_answer: list[dict[str, Any]],
        test_category: str,
        model_name: str,
        paths: dict[str, str],
    ) -> float:
        if not all(
            len(value) == len(model_result)
            for value in (prompt, possible_answer)
        ):
            raise ValueError("ACEBench result/prompt/answer length mismatch")
        result: list[dict[str, Any]] = []
        correct_count = 0
        score_list: list[dict[str, Any]] = []
        for index, result_row in enumerate(model_result):
            task_id = result_row["id"]
            turn = prompt[index]["id"].split("_")[-2]
            item = task_id.split("_")[-1]
            question = prompt[index]["question"]
            raw_result = result_row["result"]
            functions = prompt[index]["function"]
            answer = possible_answer[index]["ground_truth"]
            valid = False
            try:
                decoded = decode_native_fc(raw_result, model_name)
            except Exception as error:  # keep malformed model output in population
                result.append(
                    {
                        "id": task_id,
                        "turn": turn,
                        "valid": False,
                        "error": [
                            "Invalid native FC value. "
                            f"Failed to decode: {type(error).__name__}: {error}"
                        ],
                        "error_type": "wrong_output_format",
                        "model_result": raw_result,
                        "possible_answer": answer,
                        "process": False,
                        "process_score": 0,
                    }
                )
            else:
                candidates = answer if isinstance(answer, list) else [answer]
                all_errors: list[dict[str, Any]] = []
                for candidate in candidates:
                    checker_result = official.normal_checker(
                        functions,
                        decoded,
                        candidate,
                        question,
                        test_category,
                    )
                    if checker_result["valid"]:
                        correct_count += 1
                        valid = True
                        break
                    all_errors.append(
                        {
                            "error": checker_result["error"],
                            "error_type": checker_result["error_type"],
                        }
                    )
                if not valid:
                    result.append(
                        {
                            "id": task_id,
                            "turn": turn,
                            "valid": False,
                            "error": all_errors[0]["error"],
                            "error_type": all_errors[0]["error_type"],
                            "model_result": raw_result,
                            "possible_answer": candidates,
                        }
                    )
            if score_list and turn == score_list[-1]["turn"]:
                score_list[-1]["valid"].append(valid)
                score_list[-1]["number"] = item
            else:
                score_list.append(
                    {"turn": turn, "number": item, "valid": [valid]}
                )
        if score_list:
            end_accuracy, process_accuracy = official.multiplt_turn_accuracy(
                score_list
            )
        else:
            end_accuracy, process_accuracy = 0, 0
        result.insert(
            0,
            {
                "accuracy": end_accuracy,
                "correct_count": correct_count,
                "total_count": len(model_result),
                "process_accuracy": process_accuracy,
            },
        )
        official.save_score_as_json(
            f"data_{test_category}_score.json",
            result,
            os.path.join(official.OUTPUT_PATH, model_name),
        )
        official.convert_result_to_excel(model_name, test_category, paths)
        return end_accuracy

    official.normal_single_turn_eval = normal_single_turn_native
    official.normal_multi_turn_eval = normal_multi_turn_native
    categories = [
        category
        for requested in ("test_all",)
        for category in ACE_DATA_CATEGORY.get(requested, [requested])
    ]

    source_files: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    for language in ("en", "zh"):
        language_count = 1023 if language == "en" else 1017
        output_path = out / "score_all" / f"score_{language}"
        paths = {
            "INPUT_PATH": str(result_root / f"result_{language}") + os.sep,
            "PROMPT_PATH": str(data_root / f"data_{language}") + os.sep,
            "POSSIBLE_ANSWER_PATH": str(
                data_root / f"data_{language}" / "possible_answer"
            )
            + os.sep,
            "OUTPUT_PATH": str(output_path) + os.sep,
        }
        official.INPUT_PATH = paths["INPUT_PATH"]
        official.PROMPT_PATH = paths["PROMPT_PATH"]
        official.POSSIBLE_ANSWER_PATH = paths["POSSIBLE_ANSWER_PATH"]
        official.OUTPUT_PATH = paths["OUTPUT_PATH"]
        official.language = language
        official.RESULT_TABLE = {}
        for model in models:
            total = 0
            for path in sorted(
                (result_root / f"result_{language}" / model).glob(
                    "data_*_result.json"
                )
            ):
                rows = load_jsonl(path)
                total += len(rows)
                source_files.append(
                    {
                        "language": language,
                        "model": model,
                        "path": str(path.resolve()),
                        "rowCount": len(rows),
                        "sha256": sha256_file(path),
                    }
                )
            if total != language_count:
                raise RuntimeError(
                    f"{language}/{model}: expected {language_count}, found {total}"
                )
            counts[f"{language}/{model}"] = total
        official.runner(models, categories, paths)

    revision = subprocess.check_output(
        ["git", "-C", str(ace_root), "rev-parse", "HEAD"], text=True
    ).strip()
    manifest = {
        "adapter": str(adapter_path),
        "adapterSha256": sha256_file(adapter_path),
        "benchmark": "ACEBench native-tool full-population adaptation",
        "counts": counts,
        "formatVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "historicalResultInput": False,
        "models": models,
        "officialCommit": revision,
        "officialScorer": str((ace_root / "eval_main.py").resolve()),
        "officialScorerSha256": sha256_file(ace_root / "eval_main.py"),
        "resultRoot": str(result_root),
        "resume": False,
        "sourceFiles": source_files,
        "transformation": "none; normal FC values passed directly to pinned normal_checker",
    }
    (out / "scoring-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "counts": counts,
                "manifest": str((out / "scoring-manifest.json").resolve()),
                "status": "scored",
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
