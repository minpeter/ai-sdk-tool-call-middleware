#!/usr/bin/env python3
"""Freeze ToolSandbox's complete official named_scenarios() population."""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PINNED_COMMIT = "165848b9a78cead7ca7fe7c89c688b58e6501219"
EXPECTED_COUNT = 1032


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()


def sha256(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def build(root: Path) -> dict[str, Any]:
    commit = subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()
    if commit != PINNED_COMMIT:
        raise RuntimeError(
            f"ToolSandbox revision mismatch: expected {PINNED_COMMIT}, found {commit}"
        )
    sys.path.insert(0, str(root))
    random.seed(42)
    from tool_sandbox.common.tool_discovery import ToolBackend, find_tools_by_module
    from tool_sandbox.scenarios import named_scenarios
    import tool_sandbox.tools

    scenarios = named_scenarios(preferred_tool_backend=ToolBackend.DEFAULT)
    if len(scenarios) != EXPECTED_COUNT:
        raise RuntimeError(
            f"expected {EXPECTED_COUNT} scenarios, found {len(scenarios)}"
        )
    rapid_names = {
        name
        for name, function in find_tools_by_module(
            tool_sandbox.tools, preferred_tool_backend=ToolBackend.DEFAULT
        ).items()
        if function.__module__.endswith("rapid_api_search_tools")
    }
    rows: list[dict[str, Any]] = []
    for name, scenario in sorted(scenarios.items()):
        allowed = list(scenario.starting_context.tool_allow_list or [])
        rows.append(
            {
                "categories": sorted(str(value) for value in scenario.categories),
                "maxMessages": scenario.max_messages,
                "name": name,
                "rapidApiToolsExposed": sorted(set(allowed) & rapid_names),
                "toolAllowList": allowed,
                "toolAugmentations": [
                    str(value)
                    for value in scenario.starting_context.tool_augmentation_list
                ],
            }
        )
    stable = {
        "benchmark": "ToolSandbox",
        "commit": commit,
        "formatVersion": 1,
        "population": "named_scenarios ToolBackend.DEFAULT random.seed(42)",
        "rowCount": len(rows),
        "rows": rows,
    }
    return {
        **stable,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "rapidApiExposedCount": sum(bool(row["rapidApiToolsExposed"]) for row in rows),
        "taskSetSha256": sha256(stable),
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
            "formatVersion",
            "population",
            "rapidApiExposedCount",
            "rowCount",
            "rows",
            "taskSetSha256",
        ):
            if existing.get(field) != current.get(field):
                raise RuntimeError(f"ToolSandbox manifest drift: {field}")
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
                "rapidApiExposedCount": current["rapidApiExposedCount"],
                "rowCount": current["rowCount"],
                "status": status,
                "taskSetSha256": current["taskSetSha256"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
