#!/usr/bin/env python3
"""Sync VAKRA runtime data at the exact manifest-pinned dataset revision."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime
from pathlib import Path
from typing import Any


REPOSITORY = "ibm-research/VAKRA"
EXPECTED_TASKS = 5_207


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def verify(manifest: dict[str, Any], data_root: Path) -> dict[str, int]:
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise RuntimeError("VAKRA manifest file inventory is empty")
    rows = 0
    verified_files = 0
    verified_bytes = 0
    for entry in files:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            raise RuntimeError("VAKRA manifest file entry is invalid")
        path = data_root / entry["path"]
        if not path.is_file():
            raise RuntimeError(f"pinned VAKRA test file is missing: {path}")
        size = path.stat().st_size
        if size != entry.get("bytes") or sha256_file(path) != entry.get("sha256"):
            raise RuntimeError(f"pinned VAKRA test file hash drift: {path}")
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, list) or len(value) != entry.get("rowCount"):
            raise RuntimeError(f"pinned VAKRA test file row drift: {path}")
        rows += len(value)
        verified_files += 1
        verified_bytes += size
    if rows != EXPECTED_TASKS:
        raise RuntimeError(f"expected {EXPECTED_TASKS} VAKRA rows, found {rows}")
    return {
        "manifestFilesVerified": verified_files,
        "manifestFileBytesVerified": verified_bytes,
        "testRowsVerified": rows,
    }


def tree_size(root: Path) -> tuple[int, int]:
    files = 0
    size = 0
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if not path.is_file() or ".cache" in relative.parts:
            continue
        files += 1
        size += path.stat().st_size
    return files, size


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--code-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--max-workers", type=int, default=8)
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="verify an already-downloaded pinned snapshot without a Hub request",
    )
    args = parser.parse_args()

    from huggingface_hub import snapshot_download

    code_root = args.code_root.resolve()
    manifest = json.loads(args.manifest.resolve().read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("taskCount") != EXPECTED_TASKS:
        raise RuntimeError("VAKRA manifest is not the full public test population")
    revision = manifest.get("datasetRevision")
    if not isinstance(revision, str):
        raise RuntimeError("VAKRA manifest dataset revision is invalid")
    out = args.out.resolve()
    if out.exists():
        raise RuntimeError(f"refusing existing VAKRA dataset sync output: {out}")
    data_root = code_root / "data"
    if args.verify_only:
        if not data_root.is_dir():
            raise RuntimeError(f"VAKRA data root is missing: {data_root}")
        snapshot = str(data_root)
    else:
        snapshot = snapshot_download(
            repo_id=REPOSITORY,
            repo_type="dataset",
            revision=revision,
            local_dir=data_root,
            ignore_patterns=["train/**"],
            max_workers=args.max_workers,
        )
    verified = verify(manifest, data_root)
    runtime_files, runtime_bytes = tree_size(data_root)
    result = {
        "datasetRevision": revision,
        "downloadedAt": datetime.now().astimezone().isoformat(),
        "localDataRoot": str(data_root),
        "repository": REPOSITORY,
        "resolvedSnapshot": str(snapshot),
        "runtimeBytes": runtime_bytes,
        "runtimeFiles": runtime_files,
        "syncMode": "verify-only" if args.verify_only else "download-and-verify",
        "status": "valid",
        "taskSetSha256": manifest.get("taskSetSha256"),
        **verified,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"out": str(out), **result}, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
