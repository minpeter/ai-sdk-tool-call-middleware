#!/usr/bin/env python3
"""Freeze AppWorld's two official test populations without exposing task IDs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path


PINNED_COMMIT = "a072b7a86e7c1d5b1d7175659d750ebb9b79f10a"
EXPECTED_COUNTS = {"test_normal": 168, "test_challenge": 417}


def canonical_sha256(value: object) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def build(root: Path) -> dict[str, object]:
    commit = subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()
    if commit != PINNED_COMMIT:
        raise RuntimeError(
            f"AppWorld revision mismatch: expected {PINNED_COMMIT}, found {commit}"
        )

    os.environ["APPWORLD_ROOT"] = str(root)
    from appworld import load_task_ids

    split_hashes: dict[str, str] = {}
    counts: dict[str, int] = {}
    for split, expected in EXPECTED_COUNTS.items():
        task_ids = sorted(load_task_ids(split))
        if len(task_ids) != expected:
            raise RuntimeError(
                f"AppWorld {split} mismatch: expected {expected}, found {len(task_ids)}"
            )
        counts[split] = len(task_ids)
        split_hashes[split] = canonical_sha256(task_ids)

    data_version_path = root / "data" / "version.txt"
    data_version = data_version_path.read_text(encoding="utf-8").strip()
    manifest_basis = {
        "benchmark": "AppWorld",
        "codeCommit": commit,
        "counts": counts,
        "dataVersion": data_version,
        "population": "test_normal + test_challenge",
        "splitIdSetSha256": split_hashes,
        "taskCount": sum(counts.values()),
    }
    return {
        **manifest_basis,
        "formatVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "taskSetSha256": canonical_sha256(manifest_basis),
    }


def validate(existing: dict[str, object], current: dict[str, object]) -> None:
    stable_fields = (
        "benchmark",
        "codeCommit",
        "counts",
        "dataVersion",
        "formatVersion",
        "population",
        "splitIdSetSha256",
        "taskCount",
        "taskSetSha256",
    )
    for field in stable_fields:
        if existing.get(field) != current.get(field):
            raise RuntimeError(f"AppWorld manifest drift in field: {field}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()
    current = build(args.root.resolve())
    if args.validate:
        validate(json.loads(args.out.read_text(encoding="utf-8")), current)
        print(
            json.dumps(
                {
                    "status": "valid",
                    "taskCount": current["taskCount"],
                    "taskSetSha256": current["taskSetSha256"],
                },
                sort_keys=True,
            )
        )
        return
    if args.out.exists():
        raise RuntimeError(f"refusing to overwrite existing manifest: {args.out}")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(current, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "status": "created",
                "taskCount": current["taskCount"],
                "taskSetSha256": current["taskSetSha256"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
