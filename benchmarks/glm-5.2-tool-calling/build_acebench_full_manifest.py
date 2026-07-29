#!/usr/bin/env python3
"""Freeze every EN and ZH ACEBench row at the pinned revision."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PINNED_COMMIT = "56dd66cf6439b0d9655ee1b353e4cd745c6f664e"
EXPECTED_LANGUAGE_COUNTS = {"en": 1023, "zh": 1017}
EXPECTED_CATEGORIES = 17


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


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise RuntimeError(f"{path}:{line_number}: row is not an object")
            output.append(value)
    return output


def discover(root: Path) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for language, expected_count in EXPECTED_LANGUAGE_COUNTS.items():
        data_root = root / "data_all" / f"data_{language}"
        files = sorted(data_root.glob("data_*.json"))
        if len(files) != EXPECTED_CATEGORIES:
            raise RuntimeError(
                f"{language}: expected {EXPECTED_CATEGORIES} category files, found {len(files)}"
            )
        language_rows = 0
        for path in files:
            category = path.stem.removeprefix("data_")
            for source_line, row in enumerate(load_jsonl(path), start=1):
                output.append(
                    {
                        "category": category,
                        "id": str(row["id"]),
                        "language": language,
                        "rowSha256": sha256(row),
                        "sourceLine": source_line,
                    }
                )
                language_rows += 1
        if language_rows != expected_count:
            raise RuntimeError(
                f"{language}: expected {expected_count} rows, found {language_rows}"
            )
    keys = [(row["language"], row["category"], row["id"]) for row in output]
    if len(keys) != len(set(keys)):
        raise RuntimeError("ACEBench manifest contains duplicate language/category/id")
    return output


def build(root: Path) -> dict[str, Any]:
    commit = revision(root)
    if commit != PINNED_COMMIT:
        raise RuntimeError(
            f"ACEBench revision mismatch: expected {PINNED_COMMIT}, found {commit}"
        )
    rows = discover(root)
    stable = {
        "benchmark": "ACEBench",
        "commit": commit,
        "formatVersion": 1,
        "languageCounts": EXPECTED_LANGUAGE_COUNTS,
        "rowCount": len(rows),
        "rows": rows,
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
        "formatVersion",
        "languageCounts",
        "rowCount",
        "rows",
        "taskSetSha256",
    ):
        if existing.get(field) != current.get(field):
            raise RuntimeError(f"ACEBench manifest drift: {field}")


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
                "languageCounts": current["languageCounts"],
                "rowCount": current["rowCount"],
                "status": status,
                "taskSetSha256": current["taskSetSha256"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
