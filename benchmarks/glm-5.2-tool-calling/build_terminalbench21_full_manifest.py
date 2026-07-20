#!/usr/bin/env python3
"""Freeze and validate the complete official Terminal-Bench 2.1 population."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import tomllib
from datetime import datetime, timezone
from pathlib import Path


PINNED_DATASET_COMMIT = "36d417f56c293b8271b306a0e4c566f58e98c153"
PINNED_HARBOR_COMMIT = "d3e606d9f7d1e111bb22d3d820ebed03ec300eb3"
EXPECTED_TASKS = 89


def canonical_sha256(value: object) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def git_head(root: Path) -> str:
    return subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()


def file_record(path: Path, task_root: Path) -> dict[str, str]:
    relative = path.relative_to(task_root).as_posix()
    if path.is_symlink():
        payload = os.readlink(path).encode()
        file_type = "symlink"
    else:
        payload = path.read_bytes()
        file_type = "file"
    return {
        "path": relative,
        "sha256": hashlib.sha256(payload).hexdigest(),
        "type": file_type,
    }


def task_rows(dataset_root: Path) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for task_dir in sorted(dataset_root.iterdir()):
        task_toml = task_dir / "task.toml"
        instruction = task_dir / "instruction.md"
        if not task_dir.is_dir() or not task_toml.is_file():
            continue
        if not instruction.is_file():
            raise RuntimeError(f"missing instruction.md for {task_dir.name}")
        with task_toml.open("rb") as handle:
            tomllib.load(handle)
        files = [
            file_record(path, task_dir)
            for path in sorted(task_dir.rglob("*"))
            if path.is_file() or path.is_symlink()
        ]
        rows.append(
            {
                "files": files,
                "name": task_dir.name,
                "taskIdSha256": hashlib.sha256(task_dir.name.encode()).hexdigest(),
            }
        )
    if len(rows) != EXPECTED_TASKS:
        raise RuntimeError(
            f"expected {EXPECTED_TASKS} Terminal-Bench 2.1 tasks, found {len(rows)}"
        )
    names = [str(row["name"]) for row in rows]
    if len(names) != len(set(names)):
        raise RuntimeError("Terminal-Bench 2.1 task names are duplicated")
    return rows


def build(dataset_root: Path, harbor_root: Path) -> dict[str, object]:
    dataset_commit = git_head(dataset_root)
    if dataset_commit != PINNED_DATASET_COMMIT:
        raise RuntimeError(
            "Terminal-Bench 2.1 revision mismatch: "
            f"expected {PINNED_DATASET_COMMIT}, found {dataset_commit}"
        )
    harbor_commit = git_head(harbor_root)
    if harbor_commit != PINNED_HARBOR_COMMIT:
        raise RuntimeError(
            f"Harbor revision mismatch: expected {PINNED_HARBOR_COMMIT}, found {harbor_commit}"
        )
    tasks = task_rows(dataset_root)
    task_names = [str(row["name"]) for row in tasks]
    manifest_basis = {
        "benchmark": "Terminal-Bench 2.1",
        "datasetCommit": dataset_commit,
        "harborCommit": harbor_commit,
        "population": "terminal-bench-2-1 official full set",
        "sourceRepository": "harbor-framework/terminal-bench-2-1",
        "taskCount": len(tasks),
        "taskIdSetSha256": canonical_sha256(task_names),
        "tasks": tasks,
    }
    return {
        **manifest_basis,
        "formatVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "taskSetSha256": canonical_sha256(manifest_basis),
    }


def validate(existing: dict[str, object], current: dict[str, object]) -> None:
    for field in (
        "benchmark",
        "datasetCommit",
        "formatVersion",
        "harborCommit",
        "population",
        "sourceRepository",
        "taskCount",
        "taskIdSetSha256",
        "tasks",
        "taskSetSha256",
    ):
        if existing.get(field) != current.get(field):
            raise RuntimeError(f"Terminal-Bench 2.1 manifest drift in field: {field}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-root", type=Path, required=True)
    parser.add_argument("--harbor-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()
    current = build(args.dataset_root.resolve(), args.harbor_root.resolve())
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
