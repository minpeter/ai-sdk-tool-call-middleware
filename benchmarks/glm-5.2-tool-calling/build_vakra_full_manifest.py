#!/usr/bin/env python3
"""Freeze VAKRA's complete pinned public test population."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import subprocess
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


PINNED_CODE_COMMIT = "99847464a7b0fca05413b53ad8a7714d9a9279e9"
PINNED_DATASET_REVISION = "1511b3a6ce0bb8df8aca2ae1b578510e150b6b7e"
EXPECTED_COUNTS = {
    "capability_1_bi_apis": 2077,
    "capability_2_dashboard_apis": 1597,
    "capability_3_multihop_reasoning": 869,
    "capability_4_multiturn": 664,
}


def canonical_sha256(value: object) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def fetch_json(url: str) -> object:
    with urllib.request.urlopen(url, timeout=180) as response:
        return json.load(response)


def fetch_file(path: str) -> dict[str, object]:
    quoted_path = urllib.parse.quote(path)
    url = (
        "https://huggingface.co/datasets/ibm-research/VAKRA/resolve/"
        f"{PINNED_DATASET_REVISION}/{quoted_path}?download=true"
    )
    with urllib.request.urlopen(url, timeout=300) as response:
        raw = response.read()
    value = json.loads(raw)
    if not isinstance(value, list):
        raise RuntimeError(f"VAKRA test file is not a JSON list: {path}")
    return {
        "bytes": len(raw),
        "capability": path.split("/")[1],
        "path": path,
        "rowCount": len(value),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def build(root: Path, threads: int) -> dict[str, object]:
    commit = subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()
    if commit != PINNED_CODE_COMMIT:
        raise RuntimeError(
            f"VAKRA revision mismatch: expected {PINNED_CODE_COMMIT}, found {commit}"
        )

    tree_url = (
        "https://huggingface.co/api/datasets/ibm-research/VAKRA/tree/"
        f"{PINNED_DATASET_REVISION}/test?recursive=true&expand=false&limit=1000"
    )
    tree = fetch_json(tree_url)
    if not isinstance(tree, list):
        raise RuntimeError("VAKRA Hugging Face tree response was not a list")
    paths = sorted(
        item["path"]
        for item in tree
        if isinstance(item, dict)
        and item.get("type") == "file"
        and str(item.get("path", "")).endswith(".json")
    )
    with concurrent.futures.ThreadPoolExecutor(max_workers=threads) as pool:
        files = list(pool.map(fetch_file, paths))

    counts: Counter[str] = Counter()
    for row in files:
        counts[str(row["capability"])] += int(row["rowCount"])
    if dict(sorted(counts.items())) != EXPECTED_COUNTS:
        raise RuntimeError(
            f"VAKRA count drift: expected {EXPECTED_COUNTS}, found {dict(counts)}"
        )

    manifest_basis = {
        "benchmark": "VAKRA",
        "codeCommit": commit,
        "counts": EXPECTED_COUNTS,
        "datasetRevision": PINNED_DATASET_REVISION,
        "files": files,
        "population": "all four public test capabilities",
        "taskCount": sum(EXPECTED_COUNTS.values()),
    }
    return {
        **manifest_basis,
        "formatVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "taskSetSha256": canonical_sha256(manifest_basis),
    }


def validate(existing: dict[str, object], current: dict[str, object]) -> None:
    stable_fields = (
        "benchmark",
        "codeCommit",
        "counts",
        "datasetRevision",
        "files",
        "formatVersion",
        "population",
        "taskCount",
        "taskSetSha256",
    )
    for field in stable_fields:
        if existing.get(field) != current.get(field):
            raise RuntimeError(f"VAKRA manifest drift in field: {field}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()
    current = build(args.root.resolve(), args.threads)
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
