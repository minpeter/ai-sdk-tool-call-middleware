#!/usr/bin/env python3
"""Render the tau3 invalidation, preflight, and replacement fresh-run gate."""

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


def read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected an object")
    return value


def rows(path: Path) -> int:
    if not path.is_file():
        return 0
    value = read_object(path)
    simulations = value.get("simulations")
    return len(simulations) if isinstance(simulations, list) else 0


def lines(path: Path) -> int:
    if not path.is_file():
        return 0
    return sum(1 for line in path.read_text(encoding="utf-8").splitlines() if line)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--invalid-root", type=Path, required=True)
    parser.add_argument("--replacement-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--timestamp")
    args = parser.parse_args()

    invalid_root = args.invalid_root.resolve()
    replacement = args.replacement_root.resolve()
    invalid_meta = read_object(invalid_root / "run-meta.json")
    observed = invalid_meta["observedAtInvalidation"]
    preflight_root = invalid_root / "preflight-v3-json-judge"
    preflight = read_object(preflight_root / "preflight-validation.json")
    preflight_bridge = read_object(preflight_root / "bridge-validation.json")
    replacement_meta = read_object(replacement / "run-meta.json")
    native = sum(
        rows(path)
        for path in (replacement / "data/simulations").glob(
            "fresh-v3-*-native/results.json"
        )
    )
    plus = sum(
        rows(path)
        for path in (replacement / "data/simulations").glob(
            "fresh-v3-*-glm5/results.json"
        )
    )
    requests = lines(replacement / "bridge/requests.jsonl")
    captures = lines(replacement / "bridge/provider-raw.jsonl")
    timestamp = args.timestamp or datetime.now().astimezone().strftime(
        "%Y-%m-%d %H:%M %Z"
    )

    width, height = 1500, 900
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">',
        '<rect width="100%" height="100%" rx="30" fill="#05070b"/>',
        '<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:40px;font-weight:780;fill:#f8fafc}.sub{font-size:17px;fill:#94a3b8}.eyebrow{font-size:14px;font-weight:760;letter-spacing:1.4px;fill:#94a3b8}.head{font-size:25px;font-weight:780}.value{font-size:30px;font-weight:800}.body{font-size:15px;fill:#cbd5e1}.small{font-size:14px;fill:#94a3b8}.ok{font-size:15px;font-weight:730;fill:#6ee7b7}.bad{font-size:15px;font-weight:730;fill:#fb7185}.warn{font-size:15px;font-weight:730;fill:#fbbf24}</style>',
        '<text x="60" y="70" class="title">τ³-bench · evaluator validity gate and clean replacement</text>',
        f'<text x="60" y="106" class="sub">{esc(timestamp)} · pinned 375 tasks / arm · no invalid trajectory reuse</text>',
    ]
    cards = [
        (
            60,
            "INVALID FULL v2",
            "#3f1d2a",
            "#fb7185",
            f'{observed["glm52NativeRows"]} / {observed["glm52NativePlusRows"]} rows',
            f'evaluator infrastructure_error {observed["glm52NativeInfrastructureErrors"]} / {observed["glm52NativePlusInfrastructureErrors"]}',
            "NL judge response was not constrained to JSON",
        ),
        (
            520,
            "EXCLUDED PREFLIGHT",
            "#123425",
            "#6ee7b7",
            "1 + 1 task valid",
            f'{preflight_bridge["requestCount"]} requests = {preflight_bridge["captureCount"]} captures',
            "reward_info present · JSON-object response gate",
        ),
        (
            980,
            "CLEAN FULL v3",
            "#11243a",
            "#5eead4",
            f"{native} / {plus} of 375",
            f"{requests} requests · {captures} captures",
            "empty root · retries 3 · preflight/v2 import false",
        ),
    ]
    for x, label, fill, color, value, detail, note in cards:
        parts.extend(
            [
                f'<rect x="{x}" y="160" width="420" height="250" rx="24" fill="{fill}"/>',
                f'<text x="{x + 28}" y="202" class="eyebrow">{esc(label)}</text>',
                f'<text x="{x + 28}" y="258" class="value" fill="{color}">{esc(value)}</text>',
                f'<text x="{x + 28}" y="305" class="body">{esc(detail)}</text>',
                f'<text x="{x + 28}" y="347" class="small">{esc(note)}</text>',
                f'<text x="{x + 28}" y="384" class="{("bad" if "INVALID" in label else "ok")}">{("EXCLUDED FROM SCORE" if "INVALID" in label else ("GATE PASS, NOT IN DENOMINATOR" if "PREFLIGHT" in label else "RUNNING FROM ZERO"))}</text>',
            ]
        )
    parts.extend(
        [
            '<path d="M480 285 L510 285" stroke="#64748b" stroke-width="4" marker-end="url(#a)"/>',
            '<path d="M940 285 L970 285" stroke="#64748b" stroke-width="4" marker-end="url(#a)"/>',
            '<defs><marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#64748b"/></marker></defs>',
            '<rect x="60" y="458" width="1380" height="306" rx="24" fill="#111827"/>',
            '<text x="90" y="501" class="eyebrow">VALIDITY DECISION</text>',
            '<text x="90" y="548" class="head" fill="#f8fafc">Why v2 cannot be scored</text>',
            '<text x="90" y="585" class="body">The model-under-test trajectory completed, but the NL evaluator then parsed unconstrained prose with json.loads().</text>',
            '<text x="90" y="617" class="body">The paired concentration on identical retail task IDs proves a judge/harness failure rather than an arm-specific parser outcome.</text>',
            '<text x="90" y="667" class="head" fill="#f8fafc">What v3 changes</text>',
            '<text x="90" y="704" class="body">response_format=json_object · official default task retries restored to 3 · separate bridge/output root · same pinned tasks/models/seed.</text>',
            '<text x="90" y="736" class="body">The exact validator rejects any infrastructure_error, missing reward_info, identity drift, task omission, or imported trajectory.</text>',
            '<rect x="60" y="808" width="1380" height="48" rx="24" fill="#3f2b08"/>',
            '<text x="750" y="839" text-anchor="middle" class="warn">SCORE LOCKED UNTIL v3 REACHES 375/375 ON BOTH ARMS + BRIDGE + EXACT TRAJECTORY VALIDATION</text>',
            "</svg>",
        ]
    )
    rendered = "\n".join(parts) + "\n"
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
    print(
        json.dumps(
            {
                "invalidStatus": invalid_meta["status"],
                "out": str(args.out.resolve()),
                "preflightStatus": preflight["status"],
                "replacementCounts": [native, plus],
                "replacementStatus": replacement_meta["status"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
