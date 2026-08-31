#!/usr/bin/env python3
"""Validate completeness and scoring invariants for an ACE protocol run."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def key(row: dict[str, Any]) -> tuple[str, str, str, str]:
    return (
        str(row["language"]),
        str(row["category"]),
        str(row["caseId"]),
        str(row["arm"]),
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
    arms = [str(arm) for arm in meta["arms"]]
    cases = [
        (str(item["language"]), str(item["category"]), str(item["id"]))
        for item in meta["cases"]
    ]
    expected = {
        (language, category, case_id, arm)
        for language, category, case_id in cases
        for arm in arms
    }
    configured_invalid = {
        (str(item["language"]), str(item["category"]), str(item["id"]))
        for item in meta["oracleInvalidCases"]
    }
    selected_cases = set(cases)
    raw_keys = [key(row) for row in raw_rows]
    scored_keys = [key(row) for row in scored_rows]
    scored_key_set = set(scored_keys)
    arm_counts = Counter(str(row["arm"]) for row in scored_rows)
    language_counts = Counter(str(row["language"]) for row in scored_rows)
    category_counts = Counter(str(row["category"]) for row in scored_rows)
    report = {
        "armCounts": arm_counts,
        "categoryCounts": category_counts,
        "configuredOracleInvalidCases": len(configured_invalid),
        "duplicateRawRows": len(raw_rows) - len(set(raw_keys)),
        "expectedCases": len(selected_cases),
        "expectedJobs": len(expected),
        "languageCounts": language_counts,
        "missingJobs": len(expected - scored_key_set),
        "providerErrors": sum(
            bool(row.get("benchmarkItemValid")) and not bool(row.get("transportOk"))
            for row in scored_rows
        ),
        "rawRows": len(raw_rows),
        "scoredRows": len(scored_rows),
        "scorerErrors": sum(
            row.get("scoreErrorType") == "scorer_error" for row in scored_rows
        ),
        "selectedOracleInvalidCases": len(selected_cases & configured_invalid),
        "sourceExclusions": sum(
            not bool(row.get("benchmarkItemValid")) for row in scored_rows
        ),
        "unexpectedJobs": len(scored_key_set - expected),
        "uniqueScoredJobs": len(scored_key_set),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))

    assert len(selected_cases) == int(meta["expectedCases"]), "case count mismatch"
    assert len(expected) == int(meta["expectedJobs"]), "expected job count mismatch"
    assert len(scored_rows) == len(expected), "scored row count mismatch"
    assert len(scored_keys) == len(scored_key_set), "duplicate scored jobs"
    assert scored_key_set == expected, "missing or unexpected scored jobs"
    assert report["selectedOracleInvalidCases"] == 0, "invalid oracle case selected"
    assert report["sourceExclusions"] == 0, "selected source case failed oracle check"
    assert report["scorerErrors"] == 0, "official scorer raised row errors"
    assert all(
        arm_counts[arm] == len(selected_cases) for arm in arms
    ), "arm imbalance"
    assert all(
        language_counts[language]
        == sum(case[0] == language for case in selected_cases) * len(arms)
        for language in meta["languages"]
    ), "language imbalance"
    assert all(
        category_counts[category]
        == sum(case[1] == category for case in selected_cases) * len(arms)
        for category in meta["categories"]
    ), "category imbalance"


if __name__ == "__main__":
    main()
