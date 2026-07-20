#!/usr/bin/env python3
"""Render a Terminal-Bench invalidation and clean replacement-run gate."""

from __future__ import annotations

import argparse
import html
import json
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any


ARMS = (
    ("glm52-native", "Native", "#a78bfa"),
    ("glm52-native-plus", "Native-Plus", "#5eead4"),
)


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected an object")
    return value


def jsonl_rows(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        value = json.loads(line)
        if isinstance(value, dict):
            rows.append(value)
    return rows


def render(
    invalid_root: Path, replacement_root: Path, timestamp: str
) -> tuple[str, dict[str, object]]:
    invalid = read_json(invalid_root / "run-meta.json")
    replacement = read_json(replacement_root / "run-meta.json")
    invalidation = invalid.get("invalidation")
    if not (
        str(invalid.get("status", "")).startswith("invalid")
        and isinstance(invalidation, dict)
        and invalidation.get("populationContribution") == 0
        and invalidation.get("reuseForbidden") is True
    ):
        raise RuntimeError("invalidated run gate is not sealed")
    freshness = replacement.get("freshness")
    if (
        not isinstance(replacement.get("bridgeSuite"), str)
        or not isinstance(freshness, dict)
        or freshness.get("emptyOutputRootAtStart") is not True
        or freshness.get("resumeFromPriorRun") is not False
    ):
        raise RuntimeError("replacement freshness gate failed")

    progress = jsonl_rows(replacement_root / "progress.jsonl")
    counts = {
        arm: sum(row.get("arm") == arm for row in progress) for arm, _, _ in ARMS
    }
    requests = len(jsonl_rows(replacement_root / "bridge/requests.jsonl"))
    captures = len(jsonl_rows(replacement_root / "bridge/provider-raw.jsonl"))
    invalid_progress = jsonl_rows(invalid_root / "progress.jsonl")
    retry_policy = replacement.get("bridgeTransientRetryPolicy")
    if not isinstance(retry_policy, dict):
        raise RuntimeError("replacement retry policy is missing")
    additional_attempts = retry_policy.get("additionalAttempts")
    if not isinstance(additional_attempts, int) or additional_attempts < 0:
        raise RuntimeError("replacement retry policy is invalid")

    total = int(replacement["taskCountPerArm"])
    width, height = 1600, 1040
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">',
        '<rect width="100%" height="100%" rx="30" fill="#05070b"/>',
        "<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:42px;font-weight:780;fill:#f8fafc}.sub{font-size:18px;fill:#94a3b8}.eyebrow{font-size:14px;font-weight:760;letter-spacing:1.4px;fill:#94a3b8}.cardtitle{font-size:22px;font-weight:760;fill:#f8fafc}.body{font-size:16px;fill:#cbd5e1}.small{font-size:14px;fill:#94a3b8}.big{font-size:50px;font-weight:820}.ok{font-size:15px;font-weight:740;fill:#6ee7b7}.bad{font-size:15px;font-weight:740;fill:#fb7185}.warn{font-size:15px;font-weight:740;fill:#fbbf24}</style>",
        '<text x="64" y="72" class="title">Terminal-Bench 2.0 · validity gate</text>',
        f'<text x="64" y="108" class="sub">{esc(timestamp)} · unrecovered provider run sealed → retry-audited empty restart</text>',
        '<rect x="64" y="148" width="458" height="326" rx="24" fill="#26151c" stroke="#fb7185" stroke-width="2"/>',
        f'<text x="94" y="188" class="eyebrow">{esc(invalid_root.name.upper())} · INVALIDATED</text>',
        '<text x="94" y="252" class="big" fill="#fb7185">EXCLUDED</text>',
        f'<text x="94" y="298" class="body">completed trajectories {len(invalid_progress)} / {total * 2}</text>',
        f'<text x="94" y="334" class="body">provider attempts exhausted · {esc(invalidation.get("providerAttempts"))}</text>',
        f'<text x="94" y="370" class="body">final provider HTTP · {esc(invalidation.get("providerFinalStatus"))}</text>',
        '<text x="94" y="410" class="bad">entire run has population contribution 0</text>',
        '<text x="94" y="444" class="small">no score · no resume · no artifact import</text>',
        '<rect x="570" y="148" width="458" height="326" rx="24" fill="#171b2d" stroke="#a78bfa" stroke-width="2"/>',
        '<text x="600" y="188" class="eyebrow">BRIDGE + VALIDATOR PATCH</text>',
        f'<text x="600" y="238" class="cardtitle">{additional_attempts} additional attempts · {additional_attempts + 1} total</text>',
        '<text x="600" y="278" class="body">retry: HTTP 408 / 425 / 429 / 5xx</text>',
        '<text x="600" y="314" class="body">retry: transport timeout / reset</text>',
        '<text x="600" y="350" class="body">no retry: input or tool-output errors</text>',
        '<text x="600" y="390" class="ok">all attempts linked under one request ID</text>',
        '<text x="600" y="426" class="ok">validator rejects exhausted transient failure</text>',
        '<text x="600" y="454" class="small">2 validator tests + dry-run + Ruff pass</text>',
        '<rect x="1076" y="148" width="460" height="326" rx="24" fill="#0f2a24" stroke="#34d399" stroke-width="2"/>',
        f'<text x="1106" y="188" class="eyebrow">{esc(replacement_root.name.upper())} · CLEAN RESTART</text>',
        '<text x="1106" y="252" class="big" fill="#5eead4">RUNNING</text>',
        f'<text x="1106" y="298" class="body">{total} tasks / arm · {total * 2} new trajectories</text>',
        '<text x="1106" y="334" class="ok">empty output root at start</text>',
        '<text x="1106" y="370" class="ok">fresh-v2 artifacts not imported</text>',
        f'<text x="1106" y="406" class="ok">health gate reports transientRetries={additional_attempts}</text>',
        f'<text x="1106" y="442" class="small">bridge {requests} requests · {captures} captures</text>',
        '<text x="64" y="538" class="eyebrow">LIVE REPLACEMENT COMPLETION · COUNTS ONLY</text>',
    ]
    for index, (arm, label, color) in enumerate(ARMS):
        y = 574 + index * 104
        count = counts[arm]
        ratio = count / total if total else 0.0
        parts.extend(
            [
                f'<text x="64" y="{y + 28}" class="cardtitle" fill="{color}">{label}</text>',
                f'<rect x="300" y="{y}" width="980" height="40" rx="12" fill="#172036"/>',
                f'<rect x="300" y="{y}" width="{980 * ratio:.2f}" height="40" rx="12" fill="{color}"/>',
                f'<text x="1510" y="{y + 28}" text-anchor="end" class="cardtitle" fill="{color}">{count} / {total} · {ratio * 100:.2f}%</text>',
            ]
        )
    parts.extend(
        [
            '<rect x="64" y="812" width="1472" height="112" rx="24" fill="#111827"/>',
            '<text x="94" y="852" class="eyebrow">VALIDITY CONTRACT</text>',
            '<text x="94" y="890" class="body">Ordinary model or task failures remain in the denominator. Provider, auth, network, adapter, evaluator, or environment failures invalidate the affected run.</text>',
            '<rect x="64" y="952" width="1472" height="48" rx="24" fill="#4a3005"/>',
            f'<text x="800" y="983" text-anchor="middle" class="warn">SCORE LOCKED UNTIL {total}/{total} BOTH ARMS + OFFICIAL REWARDS + STRICT BRIDGE VALIDATION</text>',
            "</svg>",
        ]
    )
    return "\n".join(parts) + "\n", {
        "captures": captures,
        "counts": counts,
        "invalidRunSealed": True,
        "requests": requests,
        "replacementFreshnessPassed": True,
        "totalPerArm": total,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--invalid-run", type=Path, required=True)
    parser.add_argument("--replacement-run", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--timestamp")
    args = parser.parse_args()
    timestamp = args.timestamp or datetime.now().astimezone().strftime(
        "%Y-%m-%d %H:%M %Z"
    )
    rendered, summary = render(
        args.invalid_run.resolve(), args.replacement_run.resolve(), timestamp
    )
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
    print(json.dumps({"out": str(args.out.resolve()), **summary}, sort_keys=True))


if __name__ == "__main__":
    main()
