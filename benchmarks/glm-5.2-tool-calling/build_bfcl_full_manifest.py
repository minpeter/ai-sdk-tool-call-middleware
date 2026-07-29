#!/usr/bin/env python3
"""Freeze the pinned BFCL V4 scoring and format-sensitivity populations."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from bfcl_eval.utils import load_dataset_entry, parse_test_category_argument


PINNED_COMMIT = "6ea57973c7a6097fd7c5915698c54c17c5b1b6c8"
EXPECTED_COUNTS = {"all_scoring": 5217, "format_sensitivity": 5200}


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()


def sha256(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def revision(repo_root: Path) -> str:
    return subprocess.check_output(
        ["git", "-C", str(repo_root), "rev-parse", "HEAD"], text=True
    ).strip()


def load_population(group: str) -> list[dict[str, str]]:
    output: list[dict[str, str]] = []
    for category in parse_test_category_argument([group]):
        for row in load_dataset_entry(category):
            output.append(
                {
                    "category": category,
                    "id": str(row["id"]),
                    "rowSha256": sha256(row),
                }
            )
    if len(output) != EXPECTED_COUNTS[group]:
        raise RuntimeError(
            f"{group}: expected {EXPECTED_COUNTS[group]}, found {len(output)}"
        )
    keys = [(row["category"], row["id"]) for row in output]
    if len(keys) != len(set(keys)):
        raise RuntimeError(f"{group}: duplicate category/id")
    return output


def build(repo_root: Path) -> dict[str, Any]:
    commit = revision(repo_root)
    if commit != PINNED_COMMIT:
        raise RuntimeError(
            f"BFCL revision mismatch: expected {PINNED_COMMIT}, found {commit}"
        )
    populations = {
        group: load_population(group) for group in EXPECTED_COUNTS
    }
    stable = {
        "benchmark": "BFCL V4",
        "commit": commit,
        "counts": EXPECTED_COUNTS,
        "formatVersion": 1,
        "populations": populations,
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
        "counts",
        "formatVersion",
        "populations",
        "taskSetSha256",
    ):
        if existing.get(field) != current.get(field):
            raise RuntimeError(f"BFCL manifest drift: {field}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()
    current = build(args.repo_root.resolve())
    if args.validate:
        existing = json.loads(args.out.read_text(encoding="utf-8"))
        validate(existing, current)
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
                "counts": current["counts"],
                "status": status,
                "taskSetSha256": current["taskSetSha256"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
