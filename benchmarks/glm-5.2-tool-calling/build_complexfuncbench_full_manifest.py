#!/usr/bin/env python3
"""Freeze all 1,000 pinned ComplexFuncBench dataset rows."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PINNED_COMMIT = "c37b284e2f2e03ee456115b7c4b7e537f534be37"
DATA_SHA256 = "be1e0f5951b666f6543b946e915a431a39bbda1807481878eb331245276ac088"
EXPECTED_DOMAINS = {
    "Attraction": 150,
    "Car-Rental": 150,
    "Cross": 400,
    "Flights": 150,
    "Hotels": 150,
}


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def domain(task_id: str) -> str:
    for name in EXPECTED_DOMAINS:
        if task_id.startswith(name + "-"):
            return name
    raise RuntimeError(f"unrecognized ComplexFuncBench ID: {task_id}")


def build(code_root: Path, data_path: Path) -> dict[str, Any]:
    commit = subprocess.check_output(
        ["git", "-C", str(code_root), "rev-parse", "HEAD"], text=True
    ).strip()
    if commit != PINNED_COMMIT:
        raise RuntimeError(
            f"ComplexFuncBench revision mismatch: expected {PINNED_COMMIT}, found {commit}"
        )
    raw = data_path.read_bytes()
    actual_data_hash = hashlib.sha256(raw).hexdigest()
    if actual_data_hash != DATA_SHA256:
        raise RuntimeError(
            f"dataset hash mismatch: expected {DATA_SHA256}, found {actual_data_hash}"
        )
    rows: list[dict[str, Any]] = []
    ids: list[str] = []
    for source_index, line in enumerate(raw.decode().splitlines()):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise RuntimeError(f"row {source_index}: expected object")
        task_id = str(value["id"])
        ids.append(task_id)
        rows.append(
            {
                "domain": domain(task_id),
                "id": task_id,
                "rowSha256": digest(value),
                "sourceIndex": source_index,
            }
        )
    if len(rows) != 1000 or len(ids) != len(set(ids)):
        raise RuntimeError("ComplexFuncBench is not exactly 1,000 unique rows")
    counts = Counter(row["domain"] for row in rows)
    if dict(sorted(counts.items())) != EXPECTED_DOMAINS:
        raise RuntimeError(f"domain count mismatch: {dict(counts)}")
    stable = {
        "benchmark": "ComplexFuncBench",
        "commit": commit,
        "dataSha256": actual_data_hash,
        "domainCounts": EXPECTED_DOMAINS,
        "formatVersion": 1,
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
    parser.add_argument("--code-root", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()
    current = build(args.code_root.resolve(), args.data.resolve())
    if args.validate:
        existing = json.loads(args.out.read_text(encoding="utf-8"))
        for field in (
            "benchmark",
            "commit",
            "dataSha256",
            "domainCounts",
            "formatVersion",
            "rowCount",
            "rows",
            "taskSetSha256",
        ):
            if existing.get(field) != current.get(field):
                raise RuntimeError(f"ComplexFuncBench manifest drift: {field}")
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
                "rowCount": current["rowCount"],
                "status": status,
                "taskSetSha256": current["taskSetSha256"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
