#!/usr/bin/env python3
"""Validate exact BFCL V4 all_scoring coverage from official result files."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any


INFERENCE_ERROR_SENTINEL = "Error during inference:"


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected object")
    return value


def result_ids(root: Path) -> tuple[list[str], int]:
    ids: list[str] = []
    files = sorted(root.rglob("*_result.json"))
    for path in files:
        if "format_sensitivity" in path.name:
            raise RuntimeError(
                "FC run unexpectedly contains format_sensitivity result files"
            )
        with path.open(encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                value = json.loads(line)
                if not isinstance(value, dict) or not isinstance(value.get("id"), str):
                    raise RuntimeError(f"{path}:{line_number}: missing result id")
                result = value.get("result")
                if isinstance(result, str) and result.startswith(
                    INFERENCE_ERROR_SENTINEL
                ):
                    raise RuntimeError(
                        f"{path}:{line_number}: BFCL inference error sentinel"
                    )
                if not isinstance(result, list):
                    raise RuntimeError(
                        f"{path}:{line_number}: expected result list"
                    )
                ids.append(value["id"])
    return ids, len(files)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--result-root", type=Path, required=True)
    parser.add_argument(
        "--arms", default="glm52-native,glm52-prompt-only"
    )
    args = parser.parse_args()
    manifest = read_json(args.manifest.resolve())
    population = manifest.get("populations", {}).get("all_scoring")
    if not isinstance(population, list):
        raise RuntimeError("manifest all_scoring population is missing")
    expected = [str(row["id"]) for row in population]
    if len(expected) != 5217 or len(expected) != len(set(expected)):
        raise RuntimeError("manifest all_scoring IDs are not exactly 5,217 unique rows")
    expected_set = set(expected)
    arms = [value.strip() for value in args.arms.split(",") if value.strip()]
    summaries: dict[str, dict[str, Any]] = {}
    for arm in arms:
        ids, file_count = result_ids(args.result_root.resolve() / arm)
        counts = Counter(ids)
        duplicates = sorted(value for value, count in counts.items() if count > 1)
        missing = sorted(expected_set - set(ids))
        unexpected = sorted(set(ids) - expected_set)
        if duplicates or missing or unexpected or len(ids) != len(expected):
            raise RuntimeError(
                f"{arm}: incomplete BFCL coverage rows={len(ids)}/5217 "
                f"missing={len(missing)} unexpected={len(unexpected)} "
                f"duplicates={len(duplicates)}"
            )
        summaries[arm] = {
            "fileCount": file_count,
            "resultRows": len(ids),
            "status": "complete",
        }
    print(
        json.dumps(
            {
                "arms": summaries,
                "benchmark": "BFCL V4",
                "population": "all_scoring",
                "status": "valid",
                "taskSetSha256": manifest.get("taskSetSha256"),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
