#!/usr/bin/env python3
"""Render the pinned MCPMark task denominator and the 10/63 correction."""

from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
import subprocess


EXPECTED = {
    "filesystem": 30,
    "postgres": 21,
    "playwright": 4,
    "playwright_webarena": 21,
    "github": 23,
    "notion": 28,
}
LABELS = {
    "filesystem": "Filesystem",
    "postgres": "Postgres",
    "playwright": "Playwright",
    "playwright_webarena": "WebArena",
    "github": "GitHub",
    "notion": "Notion",
}
COLORS = {
    "filesystem": "#5eead4",
    "postgres": "#60a5fa",
    "playwright": "#c4b5fd",
    "playwright_webarena": "#a78bfa",
    "github": "#fbbf24",
    "notion": "#fb7185",
}


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    counts = manifest.get("counts")
    if manifest.get("taskCount") != 127 or counts != EXPECTED:
        raise RuntimeError("MCPMark pinned 127-task denominator drift")

    width, height = 1600, 980
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">',
        '<rect width="100%" height="100%" rx="32" fill="#05070b"/>',
        "<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:46px;font-weight:800;fill:#f8fafc}.sub{font-size:19px;fill:#94a3b8}.eye{font-size:15px;font-weight:760;letter-spacing:1.4px;fill:#94a3b8}.big{font-size:58px;font-weight:840;fill:#f8fafc}.label{font-size:18px;font-weight:740}.body{font-size:18px;fill:#cbd5e1}.small{font-size:15px;fill:#94a3b8}.wrong{font-size:42px;font-weight:830;fill:#fbbf24}.ok{font-size:17px;font-weight:740;fill:#6ee7b7}</style>",
        '<text x="64" y="78" class="title">MCPMark Verified · denominator correction</text>',
        '<text x="64" y="116" class="sub">Pinned standard population · task count, model turns, and provider requests are different units</text>',
        '<rect x="64" y="154" width="1472" height="176" rx="24" fill="#0f2f2a"/>',
        '<text x="96" y="196" class="eye">OFFICIAL TASK DENOMINATOR</text>',
        '<text x="96" y="270" class="big">127 tasks / arm</text>',
        '<text x="1040" y="228" class="big">254</text>',
        '<text x="1040" y="272" class="body">paired fresh trajectories</text>',
        '<text x="64" y="382" class="eye">PINNED SERVICE BREAKDOWN · SUM = 127</text>',
    ]

    bar_x, bar_y, bar_width = 64.0, 414.0, 1472.0
    cursor = bar_x
    for service, count in EXPECTED.items():
        segment = bar_width * count / 127
        parts.append(
            f'<rect x="{cursor:.2f}" y="{bar_y}" width="{segment:.2f}" height="76" fill="{COLORS[service]}"/>'
        )
        if segment >= 70:
            parts.append(
                f'<text x="{cursor + segment / 2:.2f}" y="{bar_y + 47}" text-anchor="middle" class="label" fill="#05070b">{count}</text>'
            )
        cursor += segment

    for index, (service, count) in enumerate(EXPECTED.items()):
        column = index % 3
        row = index // 3
        x = 82 + column * 500
        y = 548 + row * 58
        parts.extend(
            [
                f'<circle cx="{x}" cy="{y - 5}" r="9" fill="{COLORS[service]}"/>',
                f'<text x="{x + 22}" y="{y + 2}" class="label" fill="#f8fafc">{esc(LABELS[service])}</text>',
                f'<text x="{x + 210}" y="{y + 2}" class="body">{count} tasks</text>',
            ]
        )

    parts.extend(
        [
            '<rect x="64" y="704" width="704" height="176" rx="24" fill="#3f2b08"/>',
            '<text x="96" y="746" class="eye">NOT THE DENOMINATOR</text>',
            '<text x="96" y="810" class="wrong">10 tasks → 63 turns</text>',
            '<text x="96" y="850" class="body">Old Filesystem Easy slice and the model turns it generated</text>',
            '<rect x="800" y="704" width="736" height="176" rx="24" fill="#151d31"/>',
            '<text x="832" y="746" class="eye">STRICT REPORTING RULE</text>',
            '<text x="832" y="794" class="body">Score only after 127/127 tasks in both arms</text>',
            '<text x="832" y="832" class="body">+ official verifier + bridge validator</text>',
            '<text x="832" y="864" class="ok">No partial score · no historical response reuse</text>',
            f'<text x="64" y="934" class="small">Source: pinned MCPMark manifest · commit {esc(manifest.get("commit"))} · taskSetSha256 {esc(str(manifest.get("taskSetSha256"))[:16])}…</text>',
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
                "counts": counts,
                "out": str(args.out.resolve()),
                "pairedFreshTrajectories": 254,
                "taskCountPerArm": 127,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
