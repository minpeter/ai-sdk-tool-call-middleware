#!/usr/bin/env python3
"""Freeze the complete official Terminal-Bench 2.0 population."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import tomllib
from datetime import datetime, timezone
from pathlib import Path


PINNED_DATASET_COMMIT = "69671fbaac6d67a7ef0dfec016cc38a64ef7a77c"
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


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(dataset_root: Path, harbor_root: Path) -> dict[str, object]:
    dataset_commit = git_head(dataset_root)
    if dataset_commit != PINNED_DATASET_COMMIT:
        raise RuntimeError(
            "Terminal-Bench 2.0 revision mismatch: "
            f"expected {PINNED_DATASET_COMMIT}, found {dataset_commit}"
        )
    harbor_commit = git_head(harbor_root)
    if harbor_commit != PINNED_HARBOR_COMMIT:
        raise RuntimeError(
            f"Harbor revision mismatch: expected {PINNED_HARBOR_COMMIT}, found {harbor_commit}"
        )

    registry_path = harbor_root / "registry.json"
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    matches = [
        row
        for row in registry
        if row.get("name") == "terminal-bench" and row.get("version") == "2.0"
    ]
    if len(matches) != 1:
        raise RuntimeError("Harbor registry must contain exactly one terminal-bench@2.0 entry")
    registry_entry = matches[0]
    registry_tasks = registry_entry.get("tasks")
    if not isinstance(registry_tasks, list):
        raise RuntimeError("terminal-bench@2.0 registry tasks are missing")
    registry_names = sorted(str(row["name"]) for row in registry_tasks)
    registry_commits = {str(row["git_commit_id"]) for row in registry_tasks}
    if registry_commits != {PINNED_DATASET_COMMIT}:
        raise RuntimeError(f"Terminal-Bench registry commit drift: {registry_commits}")

    task_dirs = sorted(
        path
        for path in dataset_root.iterdir()
        if path.is_dir() and path.name != ".git" and (path / "task.toml").is_file()
    )
    task_names = [path.name for path in task_dirs]
    if task_names != registry_names:
        raise RuntimeError("Terminal-Bench checkout does not match the Harbor registry task set")
    if len(task_names) != EXPECTED_TASKS:
        raise RuntimeError(
            f"expected {EXPECTED_TASKS} Terminal-Bench tasks, found {len(task_names)}"
        )

    task_file_hashes: list[dict[str, str]] = []
    for task_dir in task_dirs:
        task_toml = task_dir / "task.toml"
        instruction = task_dir / "instruction.md"
        if not instruction.is_file():
            raise RuntimeError(f"missing instruction.md for {task_dir.name}")
        with task_toml.open("rb") as handle:
            tomllib.load(handle)
        task_file_hashes.append(
            {
                "instructionSha256": file_sha256(instruction),
                "taskIdSha256": hashlib.sha256(task_dir.name.encode()).hexdigest(),
                "taskTomlSha256": file_sha256(task_toml),
            }
        )

    manifest_basis = {
        "benchmark": "Terminal-Bench",
        "datasetCommit": dataset_commit,
        "harborCommit": harbor_commit,
        "population": "terminal-bench@2.0 official full set",
        "registryEntrySha256": canonical_sha256(registry_entry),
        "taskCount": len(task_names),
        "taskFileHashes": task_file_hashes,
        "taskIdSetSha256": canonical_sha256(task_names),
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
        "registryEntrySha256",
        "taskCount",
        "taskFileHashes",
        "taskIdSetSha256",
        "taskSetSha256",
    ):
        if existing.get(field) != current.get(field):
            raise RuntimeError(f"Terminal-Bench manifest drift in field: {field}")


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
