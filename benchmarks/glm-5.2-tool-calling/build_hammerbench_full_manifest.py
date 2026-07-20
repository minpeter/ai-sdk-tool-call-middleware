#!/usr/bin/env python3
"""Freeze the complete downloaded HammerBench EN and ZH populations."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PINNED_CODE_COMMIT = "403d58f2d30430b04b16b8f68e69665a7fba1264"
DATASET_REVISION = "18b4f4ea47e8b367006391951cf7e69cefa48c73"
EXPECTED_COUNTS = {
    ("en", "multi-turn"): 17461,
    ("en", "single-turn"): 13054,
    ("zh", "multi-turn"): 17498,
    ("zh", "single-turn"): 13062,
}


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()


def sha256(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def revision(root: Path) -> str:
    return subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()


def build(code_root: Path, data_root: Path) -> dict[str, Any]:
    commit = revision(code_root)
    if commit != PINNED_CODE_COMMIT:
        raise RuntimeError(
            f"HammerBench revision mismatch: expected {PINNED_CODE_COMMIT}, found {commit}"
        )
    rows: list[dict[str, Any]] = []
    files: dict[str, dict[str, Any]] = {}
    for (language, split), expected in EXPECTED_COUNTS.items():
        path = data_root / "data" / language / f"{split}.json"
        values = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(values, list) or len(values) != expected:
            raise RuntimeError(
                f"{language}/{split}: expected {expected} rows, found {len(values)}"
            )
        relative = str(path.relative_to(data_root))
        files[relative] = {"rows": len(values), "sha256": file_sha256(path)}
        for index, value in enumerate(values):
            rows.append(
                {
                    "id": str(value["id"]),
                    "language": language,
                    "rowSha256": sha256(value),
                    "sourceIndex": index,
                    "split": split,
                }
            )
    # HammerBench contains repeated snapshot IDs in the published files. The
    # primary unit is the source row, so sourceIndex is the stable unique key.
    keys = [
        (row["language"], row["split"], row["sourceIndex"]) for row in rows
    ]
    if len(keys) != len(set(keys)):
        raise RuntimeError("HammerBench manifest contains duplicate source-row keys")
    stable = {
        "benchmark": "HammerBench",
        "codeCommit": commit,
        "datasetRevision": DATASET_REVISION,
        "files": files,
        "formatVersion": 1,
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
        "codeCommit",
        "datasetRevision",
        "files",
        "formatVersion",
        "rowCount",
        "rows",
        "taskSetSha256",
    ):
        if existing.get(field) != current.get(field):
            raise RuntimeError(f"HammerBench manifest drift: {field}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--code-root", type=Path, required=True)
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()
    current = build(args.code_root.resolve(), args.data_root.resolve())
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
                "rowCount": current["rowCount"],
                "status": status,
                "taskSetSha256": current["taskSetSha256"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
