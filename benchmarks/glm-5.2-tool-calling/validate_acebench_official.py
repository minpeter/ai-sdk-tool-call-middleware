#!/usr/bin/env python3
"""Validate exact ACEBench EN+ZH coverage from official result JSONL files."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


EXPECTED_LANGUAGE_COUNTS = {"en": 1023, "zh": 1017}


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected object")
    return value


def read_result_ids(path: Path) -> list[str]:
    ids: list[str] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict) or not isinstance(value.get("id"), str):
                raise RuntimeError(f"{path}:{line_number}: missing result id")
            ids.append(value["id"])
    return ids


def expected_population(
    manifest: dict[str, Any],
) -> dict[str, dict[str, set[str]]]:
    rows = manifest.get("rows")
    if not isinstance(rows, list):
        raise RuntimeError("manifest rows are missing")
    expected: dict[str, dict[str, set[str]]] = defaultdict(
        lambda: defaultdict(set)
    )
    for row in rows:
        if not isinstance(row, dict):
            raise RuntimeError("manifest row is not an object")
        language = str(row["language"])
        category = str(row["category"])
        task_id = str(row["id"])
        if task_id in expected[language][category]:
            raise RuntimeError(
                f"duplicate manifest key: {language}/{category}/{task_id}"
            )
        expected[language][category].add(task_id)
    for language, expected_count in EXPECTED_LANGUAGE_COUNTS.items():
        count = sum(len(ids) for ids in expected[language].values())
        if count != expected_count:
            raise RuntimeError(
                f"manifest {language}: expected {expected_count}, found {count}"
            )
    return expected


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--result-root", type=Path, required=True)
    parser.add_argument(
        "--arms", default="glm52-native-FC,glm52-prompt-only-FC"
    )
    args = parser.parse_args()

    manifest = read_json(args.manifest.resolve())
    expected = expected_population(manifest)
    arms = [value.strip() for value in args.arms.split(",") if value.strip()]
    summaries: dict[str, Any] = {}
    for arm in arms:
        arm_summary: dict[str, Any] = {}
        arm_total = 0
        for language, expected_count in EXPECTED_LANGUAGE_COUNTS.items():
            root = args.result_root.resolve() / f"result_{language}" / arm
            files = sorted(root.glob("data_*_result.json"))
            actual_categories = {
                path.name.removeprefix("data_").removesuffix("_result.json")
                for path in files
            }
            expected_categories = set(expected[language])
            if actual_categories != expected_categories:
                raise RuntimeError(
                    f"{arm}/{language}: category mismatch "
                    f"missing={sorted(expected_categories - actual_categories)} "
                    f"unexpected={sorted(actual_categories - expected_categories)}"
                )
            actual_keys: list[tuple[str, str]] = []
            for path in files:
                category = path.name.removeprefix("data_").removesuffix(
                    "_result.json"
                )
                actual_keys.extend(
                    (category, task_id) for task_id in read_result_ids(path)
                )
            counts = Counter(actual_keys)
            duplicates = [key for key, count in counts.items() if count > 1]
            expected_keys = {
                (category, task_id)
                for category, ids in expected[language].items()
                for task_id in ids
            }
            actual_set = set(actual_keys)
            missing = expected_keys - actual_set
            unexpected = actual_set - expected_keys
            if (
                len(actual_keys) != expected_count
                or duplicates
                or missing
                or unexpected
            ):
                raise RuntimeError(
                    f"{arm}/{language}: incomplete ACEBench coverage "
                    f"rows={len(actual_keys)}/{expected_count} "
                    f"missing={len(missing)} unexpected={len(unexpected)} "
                    f"duplicates={len(duplicates)}"
                )
            arm_total += len(actual_keys)
            arm_summary[language] = {
                "categoryFiles": len(files),
                "resultRows": len(actual_keys),
                "status": "complete",
            }
        if arm_total != sum(EXPECTED_LANGUAGE_COUNTS.values()):
            raise RuntimeError(f"{arm}: invalid total {arm_total}")
        summaries[arm] = {
            "languages": arm_summary,
            "resultRows": arm_total,
            "status": "complete",
        }

    print(
        json.dumps(
            {
                "arms": summaries,
                "benchmark": "ACEBench native-tool full-population adaptation",
                "status": "valid",
                "taskSetSha256": manifest.get("taskSetSha256"),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
