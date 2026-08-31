#!/usr/bin/env python3
"""Validate completeness and scoring invariants for a BFCL protocol run."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def key(row: dict[str, Any]) -> tuple[str, str, str, int]:
    return (
        row["category"],
        row["caseId"],
        row["arm"],
        int(row["trial"]),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", required=True, type=Path)
    parser.add_argument("--scored", required=True, type=Path)
    parser.add_argument("--meta", required=True, type=Path)
    args = parser.parse_args()

    raw_rows = load_jsonl(args.raw)
    scored_rows = load_jsonl(args.scored)
    meta = json.loads(args.meta.read_text(encoding="utf-8"))
    arms = [arm["id"] for arm in meta["arms"]]
    expected = {
        (category, case_id, arm, trial)
        for category, details in meta["categories"].items()
        for case_id in details["ids"]
        for arm in arms
        for trial in range(1, int(meta["trials"]) + 1)
    }
    raw_keys = [key(row) for row in raw_rows]
    scored_keys = [key(row) for row in scored_rows]
    scored_key_set = set(scored_keys)
    report = {
        "duplicateRawRows": len(raw_rows) - len(set(raw_keys)),
        "expectedJobs": len(expected),
        "missingJobs": len(expected - scored_key_set),
        "providerErrors": sum(not row["evaluable"] for row in scored_rows),
        "rawRows": len(raw_rows),
        "scoredRows": len(scored_rows),
        "scorerErrors": sum(
            row.get("scoreErrorType") == "scorer_error" for row in scored_rows
        ),
        "unexpectedJobs": len(scored_key_set - expected),
        "uniqueScoredJobs": len(scored_key_set),
        "armCounts": Counter(row["arm"] for row in scored_rows),
        "categoryCounts": Counter(row["category"] for row in scored_rows),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))

    assert len(scored_rows) == len(expected), "scored row count mismatch"
    assert len(scored_keys) == len(scored_key_set), "duplicate scored jobs"
    assert scored_key_set == expected, "missing or unexpected scored jobs"
    assert report["scorerErrors"] == 0, "official scorer raised row errors"
    expected_per_arm = len(expected) // len(arms)
    assert all(
        report["armCounts"][arm] == expected_per_arm for arm in arms
    ), "arm imbalance"
    assert all(
        report["categoryCounts"][category] == details["count"] * len(arms)
        for category, details in meta["categories"].items()
    ), "category imbalance"


if __name__ == "__main__":
    main()
