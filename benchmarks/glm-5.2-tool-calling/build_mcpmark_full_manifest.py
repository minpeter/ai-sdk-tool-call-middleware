#!/usr/bin/env python3
"""Freeze and validate the pinned MCPMark Verified standard task population."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path


PINNED_COMMIT = "cd45b7f57923b9b3985467f5139927575f83141c"
EXPECTED_COUNTS = {
    "filesystem": 30,
    "notion": 28,
    "github": 23,
    "postgres": 21,
    "playwright_webarena": 21,
    "playwright": 4,
}


def sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git_revision(root: Path) -> str:
    return subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()


def discover(root: Path) -> list[dict[str, object]]:
    tasks: list[dict[str, object]] = []
    for service, expected in EXPECTED_COUNTS.items():
        service_root = root / "tasks" / service / "standard"
        rows = []
        for meta_path in sorted(service_root.glob("*/*/meta.json")):
            category = meta_path.parent.parent.name
            task_id = meta_path.parent.name
            rows.append(
                {
                    "category": category,
                    "descriptionSha256": sha256_file(
                        meta_path.parent / "description.md"
                    ),
                    "metaSha256": sha256_file(meta_path),
                    "service": service,
                    "taskId": task_id,
                    "verifySha256": sha256_file(meta_path.parent / "verify.py"),
                }
            )
        if len(rows) != expected:
            raise RuntimeError(
                f"{service} count mismatch: expected {expected}, found {len(rows)}"
            )
        tasks.extend(rows)
    keys = [f"{row['service']}/{row['category']}/{row['taskId']}" for row in tasks]
    if len(keys) != len(set(keys)):
        raise RuntimeError("MCPMark manifest contains duplicate task keys")
    return tasks


def canonical_sha256(value: object) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def build(root: Path) -> dict[str, object]:
    revision = git_revision(root)
    if revision != PINNED_COMMIT:
        raise RuntimeError(
            f"MCPMark revision mismatch: expected {PINNED_COMMIT}, found {revision}"
        )
    tasks = discover(root)
    return {
        "benchmark": "MCPMark Verified",
        "commit": revision,
        "counts": EXPECTED_COUNTS,
        "formatVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "population": "standard",
        "taskCount": len(tasks),
        "taskSetSha256": canonical_sha256(tasks),
        "tasks": tasks,
    }


def validate(existing: dict[str, object], current: dict[str, object]) -> None:
    stable_fields = (
        "benchmark",
        "commit",
        "counts",
        "formatVersion",
        "population",
        "taskCount",
        "taskSetSha256",
        "tasks",
    )
    for field in stable_fields:
        if existing.get(field) != current.get(field):
            raise RuntimeError(f"manifest drift in field: {field}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()
    current = build(args.root.resolve())
    if args.validate:
        existing = json.loads(args.out.read_text(encoding="utf-8"))
        validate(existing, current)
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
