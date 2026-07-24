#!/usr/bin/env python3
"""Validate complete StableToolBench output coverage before scoring."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


ARMS = ("gpt-native", "gpt-prompt-only")


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected object")
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    args = parser.parse_args()
    manifest = read_json(args.manifest.resolve())
    rows = manifest.get("rows")
    if not isinstance(rows, list) or len(rows) != 765:
        raise RuntimeError("StableToolBench manifest is not exactly 765 rows")
    expected: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        if not isinstance(row, dict):
            raise RuntimeError("manifest row is not an object")
        expected[str(row["group"])].add(str(row["queryId"]))
    summaries: dict[str, Any] = {}
    for arm in ARMS:
        group_summary: dict[str, Any] = {}
        arm_total = 0
        for group, expected_ids in sorted(expected.items()):
            root = args.output_root.resolve() / arm / group
            files = sorted(root.glob("*_CoT@1.json"))
            ids = [path.name.removesuffix("_CoT@1.json") for path in files]
            counts = Counter(ids)
            duplicates = [value for value, count in counts.items() if count > 1]
            missing = expected_ids - set(ids)
            unexpected = set(ids) - expected_ids
            if duplicates or missing or unexpected or len(ids) != len(expected_ids):
                raise RuntimeError(
                    f"{arm}/{group}: incomplete coverage rows={len(ids)}/{len(expected_ids)} "
                    f"missing={len(missing)} unexpected={len(unexpected)} "
                    f"duplicates={len(duplicates)}"
                )
            for path in files:
                value = read_json(path)
                answer = value.get("answer_generation")
                if not isinstance(answer, dict):
                    raise RuntimeError(f"{path}: answer_generation is missing")
                if not isinstance(answer.get("valid_data"), bool):
                    raise RuntimeError(f"{path}: valid_data is missing")
            arm_total += len(files)
            group_summary[group] = {"rows": len(files), "status": "complete"}
        if arm_total != 765:
            raise RuntimeError(f"{arm}: invalid total {arm_total}")
        summaries[arm] = {
            "groups": group_summary,
            "rows": arm_total,
            "status": "complete",
        }
    print(
        json.dumps(
            {
                "arms": summaries,
                "benchmark": "StableToolBench",
                "status": "valid",
                "taskSetSha256": manifest.get("taskSetSha256"),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
