#!/usr/bin/env python3
"""Freeze ToolBench's complete six-group official test population."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path


PINNED_CODE_COMMIT = "d56fdd89faf8c91fa135090b212bb9057ee5cfc2"
PINNED_ARCHIVE_SHA256 = "df035ef91551d5cdc9e66d782dc12c821c81e830da2e7d05f633c7b26ae06016"
SOURCE_FILE_ID = "1ceLQ9S1IkFTiWeJ3G1FArsD4zY6WYiLa"
EXPECTED_COUNTS = {
    "G1_category": 200,
    "G1_instruction": 200,
    "G1_tool": 200,
    "G2_category": 200,
    "G2_instruction": 200,
    "G3_instruction": 100,
}


def canonical_sha256(value: object) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def build(code_root: Path, data_root: Path, archive: Path) -> dict[str, object]:
    commit = subprocess.check_output(
        ["git", "-C", str(code_root), "rev-parse", "HEAD"], text=True
    ).strip()
    if commit != PINNED_CODE_COMMIT:
        raise RuntimeError(
            f"ToolBench revision mismatch: expected {PINNED_CODE_COMMIT}, found {commit}"
        )
    archive_sha256 = file_sha256(archive)
    if archive_sha256 != PINNED_ARCHIVE_SHA256:
        raise RuntimeError(
            "ToolBench data archive mismatch: "
            f"expected {PINNED_ARCHIVE_SHA256}, found {archive_sha256}"
        )

    instruction_root = data_root / "test_instruction"
    id_root = data_root / "test_query_ids"
    groups: dict[str, object] = {}
    all_case_keys: list[str] = []
    for group, expected in EXPECTED_COUNTS.items():
        instruction_path = instruction_root / f"{group}.json"
        id_path = id_root / f"{group}.json"
        rows = json.loads(instruction_path.read_text(encoding="utf-8"))
        id_map = json.loads(id_path.read_text(encoding="utf-8"))
        if not isinstance(rows, list) or not isinstance(id_map, dict):
            raise RuntimeError(f"unexpected ToolBench data shape for {group}")
        row_ids = [str(row["query_id"]) for row in rows]
        if len(row_ids) != expected or len(id_map) != expected:
            raise RuntimeError(
                f"ToolBench {group} mismatch: expected {expected}, "
                f"found rows={len(row_ids)} ids={len(id_map)}"
            )
        if len(set(row_ids)) != expected:
            raise RuntimeError(f"ToolBench {group} contains duplicate query IDs")
        if set(row_ids) != set(id_map):
            raise RuntimeError(f"ToolBench {group} row IDs do not match test_query_ids")
        sorted_ids = sorted(row_ids)
        all_case_keys.extend(f"{group}/{query_id}" for query_id in sorted_ids)
        groups[group] = {
            "count": expected,
            "instructionBytes": instruction_path.stat().st_size,
            "instructionSha256": file_sha256(instruction_path),
            "queryIdSetSha256": canonical_sha256(sorted_ids),
            "testQueryIdsBytes": id_path.stat().st_size,
            "testQueryIdsSha256": file_sha256(id_path),
        }

    tool_root = data_root / "toolenv" / "tools"
    api_json_files = sorted(tool_root.glob("*/*.json"))
    api_python_files = sorted(tool_root.glob("*/*/api.py"))
    if not api_json_files or not api_python_files:
        raise RuntimeError("ToolBench tool environment is incomplete")

    manifest_basis = {
        "archiveBytes": archive.stat().st_size,
        "archiveSha256": archive_sha256,
        "benchmark": "ToolBench",
        "codeCommit": commit,
        "counts": EXPECTED_COUNTS,
        "groups": groups,
        "population": "six official test sets",
        "sourceFileId": SOURCE_FILE_ID,
        "taskCount": sum(EXPECTED_COUNTS.values()),
        "taskSetSha256": canonical_sha256(sorted(all_case_keys)),
        "toolEnvironment": {
            "apiJsonFileCount": len(api_json_files),
            "apiPythonFileCount": len(api_python_files),
            "relativePathSetSha256": canonical_sha256(
                sorted(
                    str(path.relative_to(data_root))
                    for path in api_json_files + api_python_files
                )
            ),
        },
    }
    return {
        **manifest_basis,
        "formatVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "manifestSha256": canonical_sha256(manifest_basis),
    }


def validate(existing: dict[str, object], current: dict[str, object]) -> None:
    for field in (
        "archiveBytes",
        "archiveSha256",
        "benchmark",
        "codeCommit",
        "counts",
        "formatVersion",
        "groups",
        "manifestSha256",
        "population",
        "sourceFileId",
        "taskCount",
        "taskSetSha256",
        "toolEnvironment",
    ):
        if existing.get(field) != current.get(field):
            raise RuntimeError(f"ToolBench manifest drift in field: {field}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--code-root", type=Path, required=True)
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()
    current = build(
        args.code_root.resolve(), args.data_root.resolve(), args.archive.resolve()
    )
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
