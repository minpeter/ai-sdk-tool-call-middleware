#!/usr/bin/env python3
"""Render score-free full-population readiness for externally blocked suites."""

from __future__ import annotations

import argparse
import html
import subprocess
from pathlib import Path


ROWS = (
    (
        "MCPMark Verified standard",
        127,
        55,
        "Filesystem 30 + Postgres 21 + Playwright 4",
        "Notion 28 + GitHub 23 + WebArena 21",
    ),
    (
        "ToolSandbox named_scenarios",
        1032,
        509,
        "RapidAPI not exposed: 509",
        "RapidAPI required or exposed: 523",
    ),
    (
        "ComplexFuncBench official rows",
        1000,
        0,
        "No valid launchable subset",
        "adapter + runtime + Booking API + judge",
    ),
    (
        "ToolBench original six test sets",
        1100,
        0,
        "No credential-free rows",
        "ToolBench/RapidAPI + server + adapter + ToolEval",
    ),
)


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def render(timestamp: str) -> str:
    width, height = 1440, 930
    x0, bar_width = 500, 820
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" rx="30" fill="#05070b"/>',
        '<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:38px;font-weight:760;fill:#f8fafc}.sub{font-size:17px;fill:#94a3b8}.name{font-size:21px;font-weight:720;fill:#f8fafc}.body{font-size:15px;fill:#cbd5e1}.small{font-size:14px;fill:#94a3b8}.value{font-size:16px;font-weight:750;fill:#f8fafc}.pill{font-size:14px;font-weight:760;fill:#fecaca}</style>',
        '<text x="70" y="72" class="title">Full-population readiness · external blockers</text>',
        f'<text x="70" y="106" class="sub">{esc(timestamp)} · launchable subsets are setup evidence only · no subset score is allowed</text>',
        '<rect x="70" y="136" width="1300" height="76" rx="18" fill="#111827"/>',
        '<text x="96" y="166" class="small">MCPMARK SCOPE CORRECTION</text>',
        '<text x="96" y="194" class="name">Pinned Verified standard = 127 tasks / arm, not 10 and not 63</text>',
        '<rect x="1128" y="155" width="210" height="38" rx="19" fill="#7f1d1d"/>',
        '<text x="1233" y="180" text-anchor="middle" class="pill">FULL SCORE BLOCKED</text>',
    ]
    for index, (name, total, ready, ready_text, blocked_text) in enumerate(ROWS):
        y = 250 + index * 150
        ready_width = bar_width * ready / total
        blocked = total - ready
        parts.extend(
            [
                f'<text x="70" y="{y + 20}" class="name">{esc(name)}</text>',
                f'<text x="70" y="{y + 48}" class="body">{esc(ready_text)}</text>',
                f'<text x="70" y="{y + 74}" class="small">blocked: {esc(blocked_text)}</text>',
                f'<rect x="{x0}" y="{y}" width="{bar_width}" height="54" rx="13" fill="#7f1d1d"/>',
                f'<rect x="{x0}" y="{y}" width="{ready_width:.2f}" height="54" rx="13" fill="#047857"/>',
                f'<text x="{x0 + 18}" y="{y + 34}" class="value">launchable {ready:,}</text>',
                f'<text x="{x0 + bar_width - 18}" y="{y + 34}" text-anchor="end" class="value">blocked {blocked:,} / total {total:,}</text>',
                f'<text x="{x0}" y="{y + 82}" class="small">0 results admitted to a full score until {total:,} / {total:,} completes for each arm</text>',
            ]
        )
    parts.extend(
        [
            '<rect x="70" y="846" width="1300" height="46" rx="16" fill="#111827"/>',
            '<text x="720" y="876" text-anchor="middle" class="body">Prepared subset ≠ benchmark completion · missing external environments are reported as blockers, never converted into zero-score tasks.</text>',
            '</svg>',
        ]
    )
    return "\n".join(parts) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--timestamp", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    svg = render(args.timestamp)
    if args.out.suffix.lower() == ".png":
        subprocess.run(
            ["convert", "svg:-", str(args.out)], input=svg, text=True, check=True
        )
    else:
        args.out.write_text(svg, encoding="utf-8")
    print(args.out.resolve())


if __name__ == "__main__":
    main()
