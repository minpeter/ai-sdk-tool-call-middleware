#!/usr/bin/env python3
"""Render AppWorld invalidation and fresh-restart gates without scores."""

from __future__ import annotations

import argparse
import html
import json
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected JSON object")
    return value


def completion(root: Path, experiment: str) -> int:
    base = (
        root
        / "root"
        / "experiments"
        / "outputs"
        / "simplified_function_calling_agent"
        / "local"
        / experiment
    )
    return sum(
        len(list((base / split / "tasks").glob("*/misc/finished")))
        for split in ("test_normal", "test_challenge")
    )


def render(root: Path, timestamp: str) -> str:
    v2 = read_json(root / "final-v2" / "run-meta.json")
    v3 = read_json(root / "final-v3" / "run-meta.json")
    preflight = read_json(root / "preflight-v4-challenge" / "run-meta.json")
    v4_root = root / "final-v4"
    v4 = read_json(v4_root / "run-meta.json")
    for label, meta in (("final-v2", v2), ("final-v3", v3)):
        if not str(meta.get("status")).startswith("invalidated"):
            raise RuntimeError(f"{label} is not marked invalidated")
    if preflight.get("status") != "valid":
        raise RuntimeError("challenge preflight is not valid")
    if v4.get("status") != "running":
        raise RuntimeError("final-v4 is not running")
    experiments = v4["experimentNames"]
    counts = [completion(v4_root, str(experiment)) for experiment in experiments]

    width, height = 1440, 820
    cards = (
        (
            "FINAL-V2",
            "INVALID",
            "Three split runners aborted after transient 502",
            "No resume · no preseed · all partial artifacts excluded",
            "#fb7185",
        ),
        (
            "FINAL-V3",
            "INVALID",
            "1,024-token cap produced length + null content",
            "Six finished markers excluded from replacement",
            "#fb7185",
        ),
        (
            "CHALLENGE PREFLIGHT V4",
            "VALID",
            "2/2 arms finished + official evaluation artifacts",
            f"Bridge {preflight['validation']['bridgeRequests']} = {preflight['validation']['bridgeCaptures']} · excluded from full denominator",
            "#34d399",
        ),
        (
            "FINAL-V4",
            "RUNNING",
            "New empty root · 585 tasks per arm",
            f"Native {counts[0]}/585 · Native-Plus {counts[1]}/585 · score locked",
            "#5eead4",
        ),
    )
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">',
        '<rect width="100%" height="100%" rx="30" fill="#05070b"/>',
        '<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:38px;font-weight:780;fill:#f8fafc}.sub{font-size:16px;fill:#94a3b8}.eyebrow{font-size:14px;font-weight:760;letter-spacing:1.2px;fill:#94a3b8}.status{font-size:30px;font-weight:820}.body{font-size:17px;fill:#e2e8f0}.small{font-size:14px;fill:#94a3b8}.gate{font-size:15px;font-weight:740;fill:#6ee7b7}</style>',
        '<text x="64" y="68" class="title">AppWorld · fresh full-run validity gate</text>',
        f'<text x="64" y="100" class="sub">{esc(timestamp)} · invalid roots are never aggregated or resumed</text>',
    ]
    for index, (label, status, detail, note, color) in enumerate(cards):
        row, column = divmod(index, 2)
        x = 64 + column * 672
        y = 142 + row * 258
        parts.extend(
            [
                f'<rect x="{x}" y="{y}" width="632" height="218" rx="22" fill="#111827" stroke="{color}" stroke-width="2"/>',
                f'<text x="{x + 28}" y="{y + 38}" class="eyebrow">{esc(label)}</text>',
                f'<text x="{x + 28}" y="{y + 86}" class="status" fill="{color}">{esc(status)}</text>',
                f'<text x="{x + 28}" y="{y + 130}" class="body">{esc(detail)}</text>',
                f'<text x="{x + 28}" y="{y + 166}" class="small">{esc(note)}</text>',
            ]
        )
    parts.extend(
        [
            '<rect x="64" y="690" width="1312" height="70" rx="22" fill="#064e3b"/>',
            '<text x="720" y="720" text-anchor="middle" class="gate">FRESHNESS GATE: v2/v3/preflight trajectories imported = false</text>',
            f'<text x="720" y="746" text-anchor="middle" class="small">Bridge cap 4,096 · transient retry 100 × 15s · official exact coverage required: {v4["taskCountPerArm"]}/arm</text>',
            "</svg>",
        ]
    )
    return "\n".join(parts) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--timestamp")
    args = parser.parse_args()
    timestamp = args.timestamp or datetime.now().astimezone().strftime(
        "%Y-%m-%d %H:%M %Z"
    )
    rendered = render(args.run_root.resolve(), timestamp)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.out.suffix.lower() == ".png":
        subprocess.run(
            ["convert", "svg:-", str(args.out)],
            input=rendered,
            text=True,
            check=True,
        )
    else:
        args.out.write_text(rendered, encoding="utf-8")
    print(json.dumps({"out": str(args.out.resolve())}, sort_keys=True))


if __name__ == "__main__":
    main()
