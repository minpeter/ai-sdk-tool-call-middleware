#!/usr/bin/env python3
"""Recompute and validate the pinned tau2 complexity-stratified pilot."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


def sequence_length(value: Any) -> int:
    return len(value or [])


def complexity_score(task: Any) -> int:
    criteria = task.evaluation_criteria
    return sum(
        (
            sequence_length(
                getattr(task.initial_state, "initialization_actions", None)
            ),
            sequence_length(criteria.actions),
            sequence_length(criteria.env_assertions),
            sequence_length(criteria.communicate_info),
            sequence_length(criteria.nl_assertions),
            sequence_length(task.user_tools),
            sequence_length(task.required_documents),
        )
    )


def quantile_positions(size: int) -> list[int]:
    if size < 5:
        raise ValueError("each domain needs at least five eligible tasks")
    return [0, (size - 1) // 4, (size - 1) // 2, 3 * (size - 1) // 4, size - 1]


def git_revision(root: Path) -> str:
    return subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def require_equal(actual: Any, expected: Any, label: str) -> None:
    if actual != expected:
        raise ValueError(
            f"{label} mismatch\nexpected={json.dumps(expected, ensure_ascii=False)}"
            f"\nactual={json.dumps(actual, ensure_ascii=False)}"
        )


def main() -> None:
    root = Path(os.environ.get("TAU2_ROOT", "/tmp/tau2-research")).resolve()
    source = root / "src"
    if not source.is_dir():
        raise ValueError(f"tau2 source directory not found: {source}")
    sys.path.insert(0, str(source))

    from tau2.runner import get_tasks

    manifest_path = Path(__file__).with_name("pilot-manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    require_equal(git_revision(root), manifest["tau2Commit"], "tau2 commit")
    require_equal(manifest["taskSplit"], "base", "task split")
    require_equal(
        manifest["selection"]["eligibility"],
        "complexityScore > 0 (exclude tasks with no enumerated evaluable criterion)",
        "selection eligibility",
    )
    require_equal(
        manifest["selection"]["complexityScore"],
        "len(initial_state.initialization_actions) + "
        "len(evaluation_criteria.actions) + "
        "len(evaluation_criteria.env_assertions) + "
        "len(evaluation_criteria.communicate_info) + "
        "len(evaluation_criteria.nl_assertions) + len(user_tools) + "
        "len(required_documents)",
        "complexity score formula",
    )
    require_equal(
        manifest["selection"]["positions"],
        [
            "0",
            "floor((n - 1) / 4)",
            "floor((n - 1) / 2)",
            "floor(3 * (n - 1) / 4)",
            "n - 1",
        ],
        "selection positions",
    )
    require_equal(
        manifest["domainOptions"]["banking_knowledge"]["retrievalConfig"],
        "golden_retrieval",
        "banking retrieval config",
    )

    domains = ["airline", "retail", "telecom", "banking_knowledge"]
    actual_counts: dict[str, int] = {}
    selected: dict[str, list[dict[str, Any]]] = {}
    for domain in domains:
        tasks = get_tasks(domain, task_split_name="base")
        actual_counts[domain] = len(tasks)
        scored = [(complexity_score(task), str(task.id)) for task in tasks]
        eligible = sorted((score, task_id) for score, task_id in scored if score > 0)
        positions = quantile_positions(len(eligible))
        domain_selection = [
            {"id": eligible[position][1], "complexityScore": eligible[position][0]}
            for position in positions
        ]
        selected[domain] = domain_selection
        require_equal(
            manifest["domains"][domain],
            domain_selection,
            f"{domain} selected quantiles",
        )

    actual_counts["total"] = sum(actual_counts.values())
    require_equal(manifest["datasetCounts"], actual_counts, "base dataset counts")
    require_equal(sorted(manifest["domains"]), sorted(domains), "manifest domain set")
    print(
        json.dumps(
            {
                "counts": actual_counts,
                "manifest": str(manifest_path),
                "selected": selected,
                "status": "valid",
                "tau2Commit": manifest["tau2Commit"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
