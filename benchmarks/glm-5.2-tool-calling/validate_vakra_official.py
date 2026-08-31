#!/usr/bin/env python3
"""Validate complete paired VAKRA inference outputs against the pinned dataset."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any


ARMS = ("glm52-native", "glm52-prompt-only")
CAPABILITIES = {
    1: "capability_1_bi_apis",
    2: "capability_2_dashboard_apis",
    3: "capability_3_multihop_reasoning",
    4: "capability_4_multiturn",
}
EXPECTED_TASKS = 5_207


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def expected_domains(
    manifest: dict[str, Any], data_root: Path
) -> dict[int, dict[str, set[str]]]:
    by_capability: dict[int, dict[str, set[str]]] = {
        capability: {} for capability in CAPABILITIES
    }
    capability_ids = {name: number for number, name in CAPABILITIES.items()}
    files = manifest.get("files")
    if not isinstance(files, list):
        raise RuntimeError("VAKRA manifest files are invalid")
    for entry in files:
        if not isinstance(entry, dict):
            raise RuntimeError("VAKRA manifest file entry is invalid")
        capability_name = entry.get("capability")
        capability = capability_ids.get(str(capability_name))
        relative = entry.get("path")
        if capability is None or not isinstance(relative, str):
            raise RuntimeError("VAKRA manifest capability/path is invalid")
        path = data_root / relative
        value = read_json(path)
        if not isinstance(value, list) or len(value) != entry.get("rowCount"):
            raise RuntimeError(f"VAKRA dataset row drift: {path}")
        domain = path.stem
        uuids: set[str] = set()
        for row in value:
            uuid = row.get("uuid") if isinstance(row, dict) else None
            if not isinstance(uuid, str) or uuid in uuids:
                raise RuntimeError(f"VAKRA dataset UUID drift: {path}")
            uuids.add(uuid)
        by_capability[capability][domain] = uuids
    total = sum(
        len(uuids) for domains in by_capability.values() for uuids in domains.values()
    )
    if total != EXPECTED_TASKS:
        raise RuntimeError(f"expected {EXPECTED_TASKS} VAKRA UUIDs, found {total}")
    return by_capability


def validate_domain(
    result_path: Path,
    tools_path: Path,
    domain: str,
    expected_uuids: set[str],
) -> tuple[Counter[str], int]:
    rows = read_json(result_path)
    tool_rows = read_json(tools_path)
    if not isinstance(rows, list) or not isinstance(tool_rows, list):
        raise RuntimeError(f"VAKRA output is not a list: {result_path}")
    if len(rows) != len(expected_uuids) or len(tool_rows) != len(expected_uuids):
        raise RuntimeError(f"VAKRA output count mismatch: {result_path}")
    observed: set[str] = set()
    statuses: Counter[str] = Counter()
    tool_calls = 0
    for row in rows:
        if not isinstance(row, dict):
            raise RuntimeError(f"VAKRA output row is invalid: {result_path}")
        uuid = row.get("uuid")
        if not isinstance(uuid, str) or uuid in observed:
            raise RuntimeError(
                f"VAKRA output UUID is missing/duplicated: {result_path}"
            )
        observed.add(uuid)
        if row.get("domain") != domain:
            raise RuntimeError(f"VAKRA output domain mismatch: {result_path}")
        status = row.get("status")
        if status not in {"success", "error"}:
            raise RuntimeError(f"VAKRA output status is invalid: {result_path}")
        statuses[str(status)] += 1
        output = row.get("output")
        if not isinstance(output, list) or len(output) != 1:
            raise RuntimeError(f"VAKRA output turn shape is invalid: {result_path}")
        turn = output[0]
        sequence = turn.get("sequence") if isinstance(turn, dict) else None
        calls = sequence.get("tool_call") if isinstance(sequence, dict) else None
        if not isinstance(calls, list):
            raise RuntimeError(f"VAKRA tool-call shape is invalid: {result_path}")
        tool_calls += len(calls)
    if observed != expected_uuids:
        raise RuntimeError(f"VAKRA output UUID coverage mismatch: {result_path}")
    tool_uuids = {row.get("uuid") for row in tool_rows if isinstance(row, dict)}
    if tool_uuids != expected_uuids:
        raise RuntimeError(f"VAKRA tools-log UUID coverage mismatch: {tools_path}")
    return statuses, tool_calls


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    manifest = read_json(args.manifest.resolve())
    if not isinstance(manifest, dict) or manifest.get("taskCount") != EXPECTED_TASKS:
        raise RuntimeError("VAKRA manifest is not the full public population")
    run_root = args.run_root.resolve()
    run_meta = read_json(run_root / "run-meta.json")
    if not isinstance(run_meta, dict) or run_meta.get("status") != "inference-complete":
        raise RuntimeError("refusing incomplete VAKRA inference")
    expected = expected_domains(manifest, args.data_root.resolve())
    arms: dict[str, dict[str, Any]] = {}
    for arm in ARMS:
        total_statuses: Counter[str] = Counter()
        total_calls = 0
        capability_rows: dict[str, dict[str, int]] = {}
        for capability, domains in expected.items():
            output_root = run_root / "outputs" / arm / f"capability-{capability}"
            expected_files = {f"{domain}.json" for domain in domains}
            observed_files = {
                path.name
                for path in output_root.glob("*.json")
                if not path.name.endswith("_tools.json")
            }
            if observed_files != expected_files:
                raise RuntimeError(
                    f"VAKRA domain-file coverage mismatch for {arm}/capability-{capability}"
                )
            statuses: Counter[str] = Counter()
            calls = 0
            for domain, expected_uuids in domains.items():
                domain_statuses, domain_calls = validate_domain(
                    output_root / f"{domain}.json",
                    output_root / f"{domain}_tools.json",
                    domain,
                    expected_uuids,
                )
                statuses.update(domain_statuses)
                calls += domain_calls
            rows = sum(statuses.values())
            expected_rows = sum(len(uuids) for uuids in domains.values())
            if rows != expected_rows:
                raise RuntimeError("VAKRA capability row count mismatch")
            capability_rows[str(capability)] = {
                "errors": statuses["error"],
                "rows": rows,
                "successes": statuses["success"],
                "toolCalls": calls,
            }
            total_statuses.update(statuses)
            total_calls += calls
        if sum(total_statuses.values()) != EXPECTED_TASKS:
            raise RuntimeError(f"VAKRA arm coverage mismatch: {arm}")
        arms[arm] = {
            "capabilities": capability_rows,
            "errors": total_statuses["error"],
            "rows": sum(total_statuses.values()),
            "successes": total_statuses["success"],
            "toolCalls": total_calls,
        }
    result = {
        "arms": arms,
        "benchmark": "VAKRA",
        "complete": True,
        "status": "valid",
        "taskCountPerArm": EXPECTED_TASKS,
        "taskSetSha256": manifest.get("taskSetSha256"),
    }
    out = args.out.resolve()
    if out.exists():
        raise RuntimeError(f"refusing existing VAKRA validation output: {out}")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"out": str(out), **result}, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
