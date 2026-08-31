#!/usr/bin/env python3
"""Strictly validate every pinned VAKRA MCP domain and tool checksum."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


EXPECTED_CODE_COMMIT = "99847464a7b0fca05413b53ad8a7714d9a9279e9"
EXPECTED_TASKS = 5_207


def now() -> str:
    return datetime.now().astimezone().isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected a JSON object")
    return value


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def git_revision(root: Path) -> str:
    return subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()


def image_id() -> str:
    return subprocess.check_output(
        ["docker", "image", "inspect", "benchmark_environ", "--format", "{{.Id}}"],
        text=True,
    ).strip()


async def validate_domain(
    capability_id: int,
    domain: str,
    config: Any,
    create_client_and_connect: Any,
    stop_mcp_server: Any,
    verify_checksum: Any,
) -> dict[str, Any]:
    started = datetime.now().astimezone()
    row: dict[str, Any] = {
        "capabilityId": capability_id,
        "checksumVerified": False,
        "domain": domain,
        "error": None,
        "status": "failed",
        "toolCount": 0,
    }
    connected = False
    try:
        try:
            async with create_client_and_connect(config, domain) as session:
                tools = (await session.list_tools()).tools
                row["toolCount"] = len(tools)
                verify_checksum(capability_id, domain, tools)
                row["checksumVerified"] = True
                row["status"] = "valid"
                connected = True
        except Exception as error:  # noqa: BLE001 - context exit may group cleanup errors
            if connected:
                row["cleanupWarning"] = str(error)[:500]
            else:
                raise
    except Exception as error:  # noqa: BLE001 - validator must retain all failures
        row["error"] = f"{type(error).__name__}: {error}"[:1000]
        try:
            stop_mcp_server(config)
        except Exception:  # noqa: BLE001 - best-effort cleanup after a recorded failure
            pass
    completed = datetime.now().astimezone()
    row["durationMs"] = (completed - started).total_seconds() * 1000
    return row


async def run(args: argparse.Namespace) -> dict[str, Any]:
    code_root = args.code_root.resolve()
    manifest_path = args.manifest.resolve()
    dataset_sync_path = args.dataset_sync.resolve()
    out = args.out.resolve()
    if out.exists():
        raise RuntimeError(f"refusing existing VAKRA runtime validation: {out}")

    manifest = read_object(manifest_path)
    dataset_sync = read_object(dataset_sync_path)
    revision = git_revision(code_root)
    if revision != EXPECTED_CODE_COMMIT or manifest.get("codeCommit") != revision:
        raise RuntimeError("VAKRA code revision mismatch")
    if manifest.get("taskCount") != EXPECTED_TASKS:
        raise RuntimeError("VAKRA manifest denominator mismatch")
    if (
        dataset_sync.get("status") != "valid"
        or dataset_sync.get("testRowsVerified") != EXPECTED_TASKS
        or dataset_sync.get("datasetRevision") != manifest.get("datasetRevision")
        or dataset_sync.get("taskSetSha256") != manifest.get("taskSetSha256")
    ):
        raise RuntimeError("VAKRA dataset validation provenance mismatch")

    sys.path.insert(0, str(code_root))
    from benchmark.mcp_client import (  # noqa: PLC0415
        create_client_and_connect,
        load_mcp_config,
        stop_mcp_server,
    )
    from benchmark.runner_helpers import load_benchmark_data  # noqa: PLC0415
    from environment.tool_checksums import verify_checksum  # noqa: PLC0415

    configs = load_mcp_config(str(code_root / "benchmark/mcp_connection_config.yaml"))
    started_at = now()
    rows: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    for capability_id in (1, 2, 3, 4):
        _, domains = load_benchmark_data(
            capability_id=capability_id,
            domain_names_only=True,
        )
        counts[str(capability_id)] = len(domains)
        for index, domain in enumerate(domains, start=1):
            row = await validate_domain(
                capability_id,
                domain,
                configs[capability_id],
                create_client_and_connect,
                stop_mcp_server,
                verify_checksum,
            )
            rows.append(row)
            print(
                f"capability {capability_id} · {index}/{len(domains)} · "
                f"{domain} · {row['status']} · {row['toolCount']} tools",
                flush=True,
            )

    failures = [row for row in rows if row["status"] != "valid"]
    result = {
        "benchmark": "VAKRA",
        "benchmarkCommit": revision,
        "completedAt": now(),
        "datasetRevision": manifest.get("datasetRevision"),
        "domainCountsByCapability": counts,
        "failedDomains": len(failures),
        "imageId": image_id(),
        "manifestSha256": sha256_file(manifest_path),
        "results": rows,
        "startedAt": started_at,
        "status": "valid" if not failures else "invalid",
        "successfulDomains": len(rows) - len(failures),
        "taskCountPerArm": EXPECTED_TASKS,
        "taskSetSha256": manifest.get("taskSetSha256"),
        "totalDomains": len(rows),
        "validatorSha256": sha256_file(Path(__file__).resolve()),
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(out, result)
    if failures:
        raise RuntimeError(f"VAKRA runtime validation failed in {len(failures)} domain(s)")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--code-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--dataset-sync", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = asyncio.run(run(args))
    print(
        json.dumps(
            {
                "failedDomains": result["failedDomains"],
                "out": str(args.out.resolve()),
                "status": result["status"],
                "successfulDomains": result["successfulDomains"],
                "totalDomains": result["totalDomains"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
