#!/usr/bin/env python3
"""Render a score-free invalidation board for an MCPMark fresh run."""

from __future__ import annotations

import argparse
from collections import Counter
import html
import json
from pathlib import Path
import subprocess


ARMS = ("glm52-native", "glm52-native-plus")


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def read_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected a JSON object")
    return value


def capture_outcomes(path: Path) -> Counter[str]:
    outcomes: Counter[str] = Counter()
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            response = row.get("response")
            if isinstance(response, dict) and isinstance(response.get("status"), int):
                outcomes[f"HTTP {response['status']}"] += 1
                continue
            error = str(row.get("transportError") or "unknown")
            if "timeout" in error.lower():
                outcomes["transport timeout"] += 1
            elif "fetch failed" in error.lower():
                outcomes["transport fetch failed"] += 1
            else:
                outcomes[f"transport {error[:40]}"] += 1
    return outcomes


def task_artifacts(root: Path) -> dict[str, int]:
    official = root / "official" / "fresh-v2"
    return {
        arm: sum(1 for _ in official.glob(f"{arm}__*/run-*/**/meta.json"))
        for arm in ARMS
    }


def render(root: Path) -> tuple[str, dict]:
    meta = read_json(root / "run-meta.json")
    if meta.get("status") != "invalid-provider-failures":
        raise RuntimeError("run is not marked invalid-provider-failures")
    invalidation = meta.get("invalidation")
    if not isinstance(invalidation, dict) or not invalidation.get("reuseForbidden"):
        raise RuntimeError("run invalidation does not forbid reuse")
    outcomes = capture_outcomes(root / "bridge" / "provider-raw.jsonl")
    artifacts = task_artifacts(root)
    expected = {
        "HTTP 200": 2099,
        "HTTP 413": 42,
        "HTTP 503": 2,
        "transport timeout": 20,
        "transport fetch failed": 219,
    }
    if dict(outcomes) != expected:
        raise RuntimeError(f"provider outcome drift: {dict(outcomes)}")
    if set(artifacts.values()) != {69}:
        raise RuntimeError(f"unexpected diagnostic artifact counts: {artifacts}")

    width, height = 1600, 1040
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">',
        '<rect width="100%" height="100%" rx="32" fill="#05070b"/>',
        '<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:42px;font-weight:790;fill:#f8fafc}.sub{font-size:18px;fill:#94a3b8}.eye{font-size:14px;font-weight:760;letter-spacing:1.5px;fill:#94a3b8}.big{font-size:44px;font-weight:820}.label{font-size:18px;font-weight:730;fill:#f8fafc}.body{font-size:16px;fill:#cbd5e1}.small{font-size:14px;fill:#94a3b8}.danger{font-size:17px;font-weight:760;fill:#fecaca}.ok{font-size:15px;font-weight:730;fill:#6ee7b7}</style>',
        '<text x="64" y="72" class="title">MCPMark fresh-v2 · strict invalidation</text>',
        '<text x="64" y="108" class="sub">Fresh calls were made, but unrecovered provider failure invalidates every task artifact and score</text>',
    ]
    cards = (
        ("OFFICIAL DENOMINATOR", "127", "tasks / arm", "#0e2f29", "#5eead4"),
        ("DIAGNOSTIC ARTIFACTS", "69 + 69", "excluded from score", "#2d233d", "#c4b5fd"),
        ("VALID COMPLETIONS", "0", "resume and reuse forbidden", "#3f1d22", "#fb7185"),
        ("SCORE STATUS", "LOCKED", "fresh-v3 required", "#3f2b08", "#fbbf24"),
    )
    for index, (label, value, detail, background, color) in enumerate(cards):
        x = 64 + index * 372
        parts.extend(
            [
                f'<rect x="{x}" y="144" width="344" height="168" rx="22" fill="{background}"/>',
                f'<text x="{x + 26}" y="184" class="eye">{esc(label)}</text>',
                f'<text x="{x + 26}" y="246" class="big" fill="{color}">{esc(value)}</text>',
                f'<text x="{x + 26}" y="286" class="small">{esc(detail)}</text>',
            ]
        )

    parts.extend(
        [
            '<text x="64" y="372" class="eye">PROVIDER CAPTURE OUTCOMES · ALL 2,382 FRESH ATTEMPTS</text>',
            '<rect x="64" y="402" width="1472" height="236" rx="24" fill="#111827"/>',
        ]
    )
    labels = (
        ("HTTP 200", 2099, "#34d399"),
        ("HTTP 413", 42, "#fb7185"),
        ("HTTP 503", 2, "#f97316"),
        ("timeout", 20, "#fbbf24"),
        ("fetch failed", 219, "#f59e0b"),
    )
    total = sum(value for _, value, _ in labels)
    x = 94.0
    bar_width = 1412.0
    for label, value, color in labels:
        segment = bar_width * value / total
        parts.append(
            f'<rect x="{x:.2f}" y="446" width="{segment:.2f}" height="52" fill="{color}"/>'
        )
        x += segment
    for index, (label, value, color) in enumerate(labels):
        x = 94 + index * 282
        parts.extend(
            [
                f'<circle cx="{x + 8}" cy="554" r="8" fill="{color}"/>',
                f'<text x="{x + 26}" y="560" class="label">{esc(label)}</text>',
                f'<text x="{x + 26}" y="594" class="body">{value:,}</text>',
            ]
        )

    request_id = str(invalidation.get("firstUnrecoveredRequestId"))
    parts.extend(
        [
            '<text x="64" y="704" class="eye">VALIDATION DECISION</text>',
            '<rect x="64" y="734" width="1472" height="172" rx="24" fill="#321a20" stroke="#fb7185" stroke-width="2"/>',
            '<text x="94" y="780" class="danger">STRICT GATE FAILED · provider failure lacked timely same-model, byte-identical recovery</text>',
            f'<text x="94" y="822" class="body">first unrecovered request: {esc(request_id)}</text>',
            '<text x="94" y="858" class="body">69/127 progress is withdrawn; model responses, verifier outcomes, raw captures, and resume state are not inputs to fresh-v3.</text>',
            '<rect x="64" y="938" width="1472" height="54" rx="27" fill="#0f3d31"/>',
            '<text x="800" y="972" text-anchor="middle" class="ok">REPLACEMENT: ABSENT OUTPUT ROOT · NEW PROVIDER CALLS · 64K OFFICIAL AUTO-COMPACTION · SAME-BYTE TRANSIENT RETRIES</text>',
            '</svg>',
        ]
    )
    summary = {
        "artifactsPerArm": artifacts,
        "outcomes": dict(outcomes),
        "runId": meta.get("runId"),
        "status": meta.get("status"),
        "validCompletionsPerArm": 0,
    }
    return "\n".join(parts) + "\n", summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    rendered, summary = render(args.run_root.resolve())
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
