#!/usr/bin/env python3
"""Complete-only StableToolBench SoPR aggregation for two adapted arms."""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


ARMS = ("gpt-native", "gpt-prompt-only")
EVALUATIONS = (0, 1, 2)
SCORES = {
    "AnswerStatus.Solved": 1.0,
    "AnswerStatus.Unsure": 0.5,
    "AnswerStatus.Unsolved": 0.0,
}


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected object")
    return value


def mean(values: list[float]) -> float:
    return sum(values) / len(values)


def population_std(values: list[float]) -> float:
    average = mean(values)
    return math.sqrt(sum((value - average) ** 2 for value in values) / len(values))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--judge-root", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()
    manifest = read_json(args.manifest.resolve())
    rows = manifest.get("rows")
    if not isinstance(rows, list) or len(rows) != 765:
        raise RuntimeError("StableToolBench manifest is not exactly 765 rows")
    expected: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        expected[str(row["group"])].add(str(row["queryId"]))

    scored: list[dict[str, Any]] = []
    summaries: dict[str, Any] = {}
    by_arm_key: dict[str, dict[tuple[str, str], float]] = {}
    for arm in ARMS:
        arm_scores: dict[tuple[str, str], float] = {}
        group_summaries: dict[str, Any] = {}
        arm_eval_scores: dict[int, list[float]] = defaultdict(list)
        for group, expected_ids in sorted(expected.items()):
            path = args.judge_root.resolve() / arm / f"{group}_{arm}.json"
            values = read_json(path)
            if set(values) != expected_ids:
                raise RuntimeError(
                    f"{arm}/{group}: judge coverage mismatch "
                    f"rows={len(values)}/{len(expected_ids)}"
                )
            group_query_scores: list[float] = []
            group_eval_scores: dict[int, list[float]] = defaultdict(list)
            for query_id, value in values.items():
                if not isinstance(value, dict) or not isinstance(
                    value.get("is_solved"), dict
                ):
                    raise RuntimeError(f"{path}: {query_id} is missing is_solved")
                labels = value["is_solved"]
                query_scores: list[float] = []
                for evaluation in EVALUATIONS:
                    label = labels.get(str(evaluation))
                    if label not in SCORES:
                        raise RuntimeError(
                            f"{path}: {query_id} evaluation {evaluation} has {label!r}"
                        )
                    score = SCORES[label]
                    query_scores.append(score)
                    group_eval_scores[evaluation].append(score)
                    arm_eval_scores[evaluation].append(score)
                query_score = mean(query_scores)
                group_query_scores.append(query_score)
                arm_scores[(group, query_id)] = query_score
                scored.append(
                    {
                        "arm": arm,
                        "evaluationScores": query_scores,
                        "group": group,
                        "queryId": query_id,
                        "score": query_score,
                    }
                )
            eval_rates = [mean(group_eval_scores[index]) for index in EVALUATIONS]
            group_summaries[group] = {
                "evaluationRates": eval_rates,
                "meanScore": mean(group_query_scores),
                "stdAcrossEvaluations": population_std(eval_rates),
                "total": len(group_query_scores),
            }
        if len(arm_scores) != 765:
            raise RuntimeError(f"{arm}: expected 765 scored rows")
        arm_rates = [mean(arm_eval_scores[index]) for index in EVALUATIONS]
        summaries[arm] = {
            "evaluationRates": arm_rates,
            "groups": group_summaries,
            "meanScore": mean(list(arm_scores.values())),
            "stdAcrossEvaluations": population_std(arm_rates),
            "total": len(arm_scores),
        }
        by_arm_key[arm] = arm_scores

    paired = Counter()
    for key in by_arm_key[ARMS[0]]:
        native = by_arm_key[ARMS[0]][key]
        prompt_only = by_arm_key[ARMS[1]][key]
        if native == prompt_only:
            paired["tie"] += 1
        elif native > prompt_only:
            paired["nativeHigher"] += 1
        else:
            paired["promptOnlyHigher"] += 1
    summary = {
        "arms": summaries,
        "benchmark": "StableToolBench",
        "complete": True,
        "judge": "Pinned normalized ToolEval prompt, three evaluations per query, GLM-5.2 judge adaptation",
        "paired": dict(paired),
        "status": "complete-adapted",
        "taskCountPerArm": 765,
        "taskSetSha256": manifest.get("taskSetSha256"),
    }
    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    with (args.out_dir / "scored.jsonl").open("w", encoding="utf-8") as handle:
        for row in scored:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(json.dumps({"rows": len(scored), "status": "complete-adapted"}))


if __name__ == "__main__":
    main()
