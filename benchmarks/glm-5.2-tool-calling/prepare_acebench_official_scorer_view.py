#!/usr/bin/env python3
"""Prepare a deterministic ACEBench scorer view for native tool results.

The pinned ACEBench generator stores text-protocol model output, while the
native adapter stores normal-category calls as its FC representation:
``[{"tool_name": "{\"arg\": ...}"}]``.  The pinned ``eval_main.py`` text
path cannot consume that list directly.  This script creates a separate,
auditable scorer input tree where only normal-category results are serialized
to ACEBench's original Python-call syntax.  Special and agent rows are copied
byte-for-byte at the JSON value level because their official evaluators expect
plain text and structured state respectively.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ARM_ALIASES = {
    "glm52-native-FC": "glm52-native",
    "glm52-native-plus-FC": "glm52-native-plus",
}
LANGUAGES = ("en", "zh")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_revision(root: Path) -> str:
    return subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise RuntimeError(f"{path}:{line_number}: expected object")
            rows.append(value)
    return rows


def python_call_syntax(value: Any, *, source: str) -> str:
    if not isinstance(value, list):
        raise RuntimeError(f"{source}: normal result must be a list")
    calls: list[str] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict) or len(item) != 1:
            raise RuntimeError(
                f"{source}: call {index} must be a single-entry object"
            )
        name, raw_arguments = next(iter(item.items()))
        if not isinstance(name, str) or not name:
            raise RuntimeError(f"{source}: call {index} has an invalid name")
        if isinstance(raw_arguments, str):
            try:
                arguments = json.loads(raw_arguments)
            except json.JSONDecodeError as error:
                raise RuntimeError(
                    f"{source}: call {index} arguments are invalid JSON"
                ) from error
        else:
            arguments = raw_arguments
        if not isinstance(arguments, dict):
            raise RuntimeError(
                f"{source}: call {index} arguments must decode to an object"
            )
        serialized = ", ".join(
            f"{key}={argument!r}" for key, argument in arguments.items()
        )
        calls.append(f"{name}({serialized})")
    return f"[{', '.join(calls)}]"


def category_from_path(path: Path) -> str:
    prefix = "data_"
    suffix = "_result.json"
    if not path.name.startswith(prefix) or not path.name.endswith(suffix):
        raise RuntimeError(f"unexpected ACEBench result filename: {path.name}")
    return path.name[len(prefix) : -len(suffix)]


def convert_file(source: Path, target: Path) -> dict[str, Any]:
    category = category_from_path(source)
    rows = load_jsonl(source)
    ids: list[str] = []
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8") as output:
        for index, row in enumerate(rows):
            task_id = row.get("id")
            if not isinstance(task_id, str):
                raise RuntimeError(f"{source}:{index + 1}: missing id")
            ids.append(task_id)
            converted = dict(row)
            if category.startswith("normal_"):
                converted["result"] = python_call_syntax(
                    row.get("result"), source=f"{source}:{index + 1}"
                )
            output.write(json.dumps(converted, ensure_ascii=False) + "\n")
    if len(ids) != len(set(ids)):
        raise RuntimeError(f"{source}: duplicate task ids")
    return {
        "category": category,
        "rowCount": len(rows),
        "source": str(source.resolve()),
        "sourceSha256": sha256_file(source),
        "target": str(target.resolve()),
        "targetSha256": sha256_file(target),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ace-root", required=True, type=Path)
    parser.add_argument("--result-root", required=True, type=Path)
    parser.add_argument("--data-root", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    ace_root = args.ace_root.resolve()
    result_root = args.result_root.resolve()
    data_root = args.data_root.resolve()
    out = args.out.resolve()
    if out.exists():
        raise RuntimeError(f"refusing to reuse scorer view: {out}")
    if not data_root.is_dir():
        raise RuntimeError(f"ACEBench data root does not exist: {data_root}")

    out.mkdir(parents=True)
    (out / "data_all").symlink_to(data_root, target_is_directory=True)
    files: list[dict[str, Any]] = []
    arm_counts: dict[str, int] = {}
    for language in LANGUAGES:
        for source_arm, target_arm in ARM_ALIASES.items():
            source_dir = result_root / f"result_{language}" / source_arm
            source_files = sorted(source_dir.glob("data_*_result.json"))
            if not source_files:
                raise RuntimeError(f"no ACEBench results found in {source_dir}")
            arm_count = 0
            for source in source_files:
                target = (
                    out
                    / "result_all"
                    / f"result_{language}"
                    / target_arm
                    / source.name
                )
                record = convert_file(source, target)
                record.update(
                    {
                        "language": language,
                        "sourceArm": source_arm,
                        "targetArm": target_arm,
                    }
                )
                files.append(record)
                arm_count += int(record["rowCount"])
            arm_counts[f"{language}/{target_arm}"] = arm_count

    expected_counts = {
        f"{language}/{arm}": 1023 if language == "en" else 1017
        for language in LANGUAGES
        for arm in ARM_ALIASES.values()
    }
    if arm_counts != expected_counts:
        raise RuntimeError(
            f"ACEBench scorer-view coverage mismatch: {arm_counts}"
        )

    manifest = {
        "benchmark": "ACEBench native-tool full-population adaptation",
        "formatVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "officialCommit": git_revision(ace_root),
        "officialScorer": str((ace_root / "eval_main.py").resolve()),
        "officialScorerSha256": sha256_file(ace_root / "eval_main.py"),
        "transformation": (
            "normal native FC lists to ACEBench Python-call syntax; "
            "special and agent result values unchanged"
        ),
        "historicalResultInput": False,
        "resume": False,
        "armAliases": ARM_ALIASES,
        "counts": arm_counts,
        "files": files,
    }
    (out / "scorer-view-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "counts": arm_counts,
                "fileCount": len(files),
                "manifest": str(
                    (out / "scorer-view-manifest.json").resolve()
                ),
                "status": "created",
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
