#!/usr/bin/env python3
"""Freeze StableToolBench's six canonical solvable-query populations."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PINNED_COMMIT = "aa4ed9f4737ad98bd706663f01d63623c3427812"
EXPECTED_COUNTS = {
    "G1_category": 153,
    "G1_instruction": 163,
    "G1_tool": 158,
    "G2_category": 124,
    "G2_instruction": 106,
    "G3_instruction": 61,
}


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def build(root: Path) -> dict[str, Any]:
    commit = subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()
    if commit != PINNED_COMMIT:
        raise RuntimeError(
            f"StableToolBench revision mismatch: expected {PINNED_COMMIT}, found {commit}"
        )
    data_root = root / "solvable_queries" / "test_instruction"
    rows: list[dict[str, Any]] = []
    file_hashes: dict[str, str] = {}
    for group, expected_count in EXPECTED_COUNTS.items():
        path = data_root / f"{group}.json"
        raw = path.read_bytes()
        file_hashes[group] = hashlib.sha256(raw).hexdigest()
        values = json.loads(raw)
        if not isinstance(values, list) or len(values) != expected_count:
            raise RuntimeError(
                f"{group}: expected {expected_count} rows, found {len(values)}"
            )
        ids: list[str] = []
        for source_index, value in enumerate(values):
            if not isinstance(value, dict):
                raise RuntimeError(f"{group}/{source_index}: expected object")
            query_id = str(value["query_id"])
            ids.append(query_id)
            rows.append(
                {
                    "group": group,
                    "queryId": query_id,
                    "rowSha256": digest(value),
                    "sourceIndex": source_index,
                }
            )
        if len(ids) != len(set(ids)):
            raise RuntimeError(f"{group}: duplicate query IDs")
    if len(rows) != 765:
        raise RuntimeError(f"expected 765 StableToolBench rows, found {len(rows)}")
    stable = {
        "benchmark": "StableToolBench",
        "commit": commit,
        "fileSha256": file_hashes,
        "formatVersion": 1,
        "groupCounts": EXPECTED_COUNTS,
        "population": "solvable_queries/test_instruction six canonical groups",
        "rowCount": len(rows),
        "rows": rows,
    }
    return {
        **stable,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "taskSetSha256": digest(stable),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()
    current = build(args.root.resolve())
    if args.validate:
        existing = json.loads(args.out.read_text(encoding="utf-8"))
        for field in (
            "benchmark",
            "commit",
            "fileSha256",
            "formatVersion",
            "groupCounts",
            "population",
            "rowCount",
            "rows",
            "taskSetSha256",
        ):
            if existing.get(field) != current.get(field):
                raise RuntimeError(f"StableToolBench manifest drift: {field}")
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
                "groupCounts": current["groupCounts"],
                "rowCount": current["rowCount"],
                "status": status,
                "taskSetSha256": current["taskSetSha256"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
