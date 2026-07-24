#!/usr/bin/env python3
"""Freeze every pinned tau3 text half-duplex base task."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PINNED_COMMIT = "a1e85084a3960281cb06997594133e8f39ea42a7"
EXPECTED_COUNTS = {
    "airline": 50,
    "retail": 114,
    "telecom": 114,
    "banking_knowledge": 97,
}


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()


def sha256(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def revision(root: Path) -> str:
    return subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()


def discover(root: Path) -> list[dict[str, Any]]:
    sys.path.insert(0, str(root / "src"))
    from tau2.runner import get_tasks

    rows: list[dict[str, Any]] = []
    for domain, expected in EXPECTED_COUNTS.items():
        tasks = get_tasks(domain, task_split_name="base")
        if len(tasks) != expected:
            raise RuntimeError(
                f"{domain}: expected {expected} base tasks, found {len(tasks)}"
            )
        for task in tasks:
            value = task.model_dump(mode="json")
            rows.append(
                {
                    "domain": domain,
                    "id": str(task.id),
                    "rowSha256": sha256(value),
                }
            )
    keys = [(row["domain"], row["id"]) for row in rows]
    if len(keys) != len(set(keys)):
        raise RuntimeError("tau3 manifest contains duplicate domain/task IDs")
    return rows


def build(root: Path) -> dict[str, Any]:
    commit = revision(root)
    if commit != PINNED_COMMIT:
        raise RuntimeError(
            f"tau3 revision mismatch: expected {PINNED_COMMIT}, found {commit}"
        )
    rows = discover(root)
    stable = {
        "benchmark": "tau3-bench",
        "commit": commit,
        "domainCounts": EXPECTED_COUNTS,
        "formatVersion": 1,
        "population": "text-half-duplex-base",
        "taskCount": len(rows),
        "tasks": rows,
    }
    return {
        **stable,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "taskSetSha256": sha256(stable),
    }


def validate(existing: dict[str, Any], current: dict[str, Any]) -> None:
    for field in (
        "benchmark",
        "commit",
        "domainCounts",
        "formatVersion",
        "population",
        "taskCount",
        "tasks",
        "taskSetSha256",
    ):
        if existing.get(field) != current.get(field):
            raise RuntimeError(f"tau3 manifest drift: {field}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()
    current = build(args.root.resolve())
    if args.validate:
        validate(json.loads(args.out.read_text(encoding="utf-8")), current)
        status = "valid"
    else:
        if args.out.exists():
            raise RuntimeError(f"refusing to overwrite manifest: {args.out}")
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(
            json.dumps(current, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        status = "created"
    print(
        json.dumps(
            {
                "domainCounts": current["domainCounts"],
                "status": status,
                "taskCount": current["taskCount"],
                "taskSetSha256": current["taskSetSha256"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
