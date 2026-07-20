#!/usr/bin/env python3
"""Render a compact proof board for a live Terminal-Bench parser recovery."""

from __future__ import annotations

import argparse
import html
import json
import subprocess
from datetime import datetime
from pathlib import Path


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def render(evidence_path: Path, timestamp: str) -> tuple[str, dict[str, object]]:
    report = json.loads(evidence_path.read_text(encoding="utf-8"))
    rows = report.get("evidence")
    if not isinstance(rows, list) or len(rows) != 1:
        raise RuntimeError("expected exactly one linked live recovery event")
    row = rows[0]
    if not isinstance(row, dict):
        raise RuntimeError("recovery evidence row is invalid")
    gates = {
        "freshRequest": row.get("status") == 200,
        "linked": row.get("executed") is True,
        "observed": row.get("observationPresent") is True,
        "returnCodeZero": row.get("returnCode") == 0,
        "continued": row.get("continuedAfterRecovery") is True,
    }
    if not all(gates.values()):
        raise RuntimeError(f"live recovery evidence gate failed: {gates}")
    codes = row.get("recoveryCodes")
    if not isinstance(codes, list) or len(codes) != 2:
        raise RuntimeError("expected two recovery codes")

    width, height = 1600, 940
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">',
        '<rect width="100%" height="100%" rx="30" fill="#05070b"/>',
        "<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:42px;font-weight:780;fill:#f8fafc}.sub{font-size:18px;fill:#94a3b8}.eyebrow{font-size:14px;font-weight:760;letter-spacing:1.4px;fill:#94a3b8}.cardtitle{font-size:21px;font-weight:740;fill:#f8fafc}.body{font-size:16px;fill:#cbd5e1}.small{font-size:14px;fill:#94a3b8}.big{font-size:46px;font-weight:800}.ok{font-size:15px;font-weight:700;fill:#6ee7b7}.warn{font-size:15px;font-weight:700;fill:#fbbf24}</style>",
        '<text x="64" y="72" class="title">Terminal-Bench 2.0 · live parser recovery proof</text>',
        f'<text x="64" y="108" class="sub">{esc(timestamp)} · fresh provider response → production parser → executed agent tool</text>',
        '<rect x="64" y="150" width="440" height="230" rx="22" fill="#201526" stroke="#fb7185" stroke-width="2"/>',
        '<text x="92" y="188" class="eyebrow">MALFORMED PROVIDER OUTPUT</text>',
        '<text x="92" y="252" class="big" fill="#fb7185">2</text>',
        '<text x="154" y="242" class="cardtitle">missing close tags</text>',
        '<text x="92" y="294" class="body">arg_value close · tool_call close</text>',
        '<text x="92" y="336" class="small">HTTP 200 · Native-Plus · live request</text>',
        '<rect x="580" y="150" width="440" height="230" rx="22" fill="#172036" stroke="#a78bfa" stroke-width="2"/>',
        '<text x="608" y="188" class="eyebrow">PRODUCTION PARSER</text>',
        '<text x="608" y="252" class="big" fill="#a78bfa">RECOVERED</text>',
        f'<text x="608" y="298" class="body">{esc(codes[0])}</text>',
        f'<text x="608" y="332" class="body">{esc(codes[1])}</text>',
        '<rect x="1096" y="150" width="440" height="230" rx="22" fill="#0f2a24" stroke="#34d399" stroke-width="2"/>',
        '<text x="1124" y="188" class="eyebrow">REAL TOOL EXECUTION</text>',
        '<text x="1124" y="252" class="big" fill="#5eead4">RETURN 0</text>',
        f'<text x="1124" y="298" class="body">{esc(row.get("toolName"))} · trajectory step {esc(row.get("stepId"))}</text>',
        f'<text x="1124" y="332" class="small">request ↔ step delta {esc(row.get("timeDeltaMs"))} ms</text>',
        '<text x="64" y="442" class="eyebrow">END-TO-END LINKAGE</text>',
        '<line x1="270" y1="518" x2="1330" y2="518" stroke="#334155" stroke-width="8" stroke-linecap="round"/>',
    ]
    stages = (
        (270, "Provider", "malformed GLM call", "#fb7185"),
        (620, "Native-Plus", "two close tags repaired", "#a78bfa"),
        (970, "MiniSweAgent", "bash call accepted", "#60a5fa"),
        (1330, "Container", "returncode 0", "#5eead4"),
    )
    for x, title, detail, color in stages:
        parts.extend(
            [
                f'<circle cx="{x}" cy="518" r="25" fill="{color}"/>',
                f'<text x="{x}" y="572" text-anchor="middle" class="cardtitle">{esc(title)}</text>',
                f'<text x="{x}" y="604" text-anchor="middle" class="small">{esc(detail)}</text>',
            ]
        )
    parts.extend(
        [
            '<rect x="64" y="658" width="1472" height="174" rx="24" fill="#111827"/>',
            '<text x="94" y="700" class="eyebrow">TRAJECTORY CONTINUITY</text>',
            f'<text x="94" y="748" class="cardtitle">Task {esc(row.get("taskName"))} · step {esc(row.get("stepId"))} recovered and executed</text>',
            f'<text x="94" y="786" class="body">Command: {esc(row.get("commandFirstLine"))} · agent continued after the recovered call · exception: none</text>',
            f'<text x="94" y="816" class="small">request {esc(str(row.get("requestId"))[:12])}… · capture {esc(str((row.get("upstreamCaptureIds") or [""])[0])[:12])}… · argument SHA {esc(str(row.get("argumentSha256"))[:12])}…</text>',
            '<rect x="64" y="858" width="1472" height="44" rx="22" fill="#4a3005"/>',
            '<text x="800" y="887" text-anchor="middle" class="warn">LIVE CAUSAL EVIDENCE · FULL 89-TASK SCORE AND GENERAL VALIDITY REMAIN LOCKED</text>',
            "</svg>",
        ]
    )
    return "\n".join(parts) + "\n", {
        "allGatesPassed": all(gates.values()),
        "gates": gates,
        "requestId": row.get("requestId"),
        "taskName": row.get("taskName"),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--timestamp")
    args = parser.parse_args()
    timestamp = args.timestamp or datetime.now().astimezone().strftime(
        "%Y-%m-%d %H:%M %Z"
    )
    rendered, summary = render(args.evidence.resolve(), timestamp)
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
