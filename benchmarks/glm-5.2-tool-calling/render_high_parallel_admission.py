#!/usr/bin/env python3
"""Render the bounded high-parallel campaign admission and replacement gate."""

from __future__ import annotations

import argparse
import html
import subprocess
from pathlib import Path


ALLOCATIONS = (
    ("Hammer", 64, "#8b5cf6"),
    ("BFCL", 24, "#3b82f6"),
    ("VAKRA", 16, "#ec4899"),
    ("AppWorld", 8, "#10b981"),
    ("tau3", 8, "#f59e0b"),
    ("Terminal", 4, "#f97316"),
    ("Stable", 4, "#22d3ee"),
)


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def render(timestamp: str, parser_sha: str) -> str:
    width, height = 1440, 1040
    left, bar_width = 70, 1300
    x = left
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" rx="30" fill="#05070b"/>',
        '<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:38px;font-weight:760;fill:#f8fafc}.sub{font-size:17px;fill:#94a3b8}.h{font-size:22px;font-weight:730;fill:#f8fafc}.body{font-size:16px;fill:#cbd5e1}.small{font-size:14px;fill:#94a3b8}.num{font-size:24px;font-weight:780;fill:#f8fafc}.pill{font-size:14px;font-weight:760;fill:#d1fae5}</style>',
        '<text x="70" y="72" class="title">High-parallel admission · bounded at 128</text>',
        f'<text x="70" y="106" class="sub">{esc(timestamp)} · optimized fresh replacement contract · provider retries remain sequential inside each admission</text>',
        '<rect x="70" y="142" width="1300" height="112" rx="20" fill="#111827"/>',
    ]
    for name, count, color in ALLOCATIONS:
        block = bar_width * count / 128
        parts.append(
            f'<rect x="{x:.2f}" y="170" width="{block:.2f}" height="56" fill="{color}"/>'
        )
        if block >= 58:
            parts.extend(
                [
                    f'<text x="{x + block / 2:.2f}" y="194" text-anchor="middle" class="small" fill="#fff">{esc(name)}</text>',
                    f'<text x="{x + block / 2:.2f}" y="216" text-anchor="middle" class="body" fill="#fff">{count}</text>',
                ]
            )
        else:
            parts.append(
                f'<text x="{x + block / 2:.2f}" y="205" text-anchor="middle" class="body" fill="#fff">{count}</text>'
            )
        x += block
    parts.extend(
        [
            '<text x="70" y="286" class="small">64 + 24 + 16 + 8 + 8 + 4 + 4 = 128 bounded admissions · no historical result reuse</text>',
            '<text x="70" y="350" class="h">Concurrency contracts</text>',
        ]
    )
    cards = (
        ("HammerBench v9", "32 threads × 2 arms", "64"),
        ("BFCL V4 v12", "12 threads × 2 arms", "24"),
        ("VAKRA v10", "2 domains × 4 caps × 2 arms", "16"),
        ("AppWorld v14", "2 procs × 2 splits × 2 arms", "8"),
        ("tau3 v12", "4 domains × 2 arms × 1", "8"),
        ("TB 2.1 v8", "2 task pairs × 2 arms", "4"),
        ("Stable v13", "2 groups × 2 arms × 1", "4"),
    )
    for index, (name, formula, count) in enumerate(cards):
        column = index % 4
        row = index // 4
        cx = 70 + column * 326
        cy = 378 + row * 128
        parts.extend(
            [
                f'<rect x="{cx}" y="{cy}" width="302" height="104" rx="16" fill="#111827" stroke="#1e293b"/>',
                f'<text x="{cx + 18}" y="{cy + 31}" class="body">{esc(name)}</text>',
                f'<text x="{cx + 18}" y="{cy + 60}" class="small">{esc(formula)}</text>',
                f'<text x="{cx + 277}" y="{cy + 69}" text-anchor="end" class="num">{count}</text>',
            ]
        )
    parts.extend(
        [
            '<text x="70" y="670" class="h">Final-parser replacement gate</text>',
        ]
    )
    steps = (
        ("1 / 5", "parser locked", f"SHA {parser_sha[:8]}…", "#065f46"),
        ("2 / 5", "full fingerprints", "122 source files", "#065f46"),
        ("3 / 5", "core five suites", "116 admissions", "#065f46"),
        ("4 / 5", "AppWorld + TB", "12 admissions", "#065f46"),
        ("5 / 5", "128 / 128 live", "fresh roots only", "#065f46"),
    )
    for index, (time, label, detail, color) in enumerate(steps):
        sx = 70 + index * 260
        parts.extend(
            [
                f'<rect x="{sx}" y="704" width="220" height="126" rx="18" fill="{color}"/>',
                f'<text x="{sx + 18}" y="735" class="small" fill="#e2e8f0">{esc(time)}</text>',
                f'<text x="{sx + 18}" y="772" class="h" font-size="18">{esc(label)}</text>',
                f'<text x="{sx + 18}" y="804" class="body">{esc(detail)}</text>',
            ]
        )
        if index < len(steps) - 1:
            parts.extend(
                [
                    f'<line x1="{sx + 224}" y1="767" x2="{sx + 250}" y2="767" stroke="#64748b" stroke-width="3"/>',
                    f'<path d="M {sx + 250} 767 l -10 -7 v 14 z" fill="#64748b"/>',
                ]
            )
    parts.extend(
        [
            '<rect x="70" y="872" width="1300" height="100" rx="20" fill="#111827"/>',
            '<rect x="94" y="896" width="220" height="38" rx="19" fill="#064e3b"/>',
            '<text x="204" y="921" text-anchor="middle" class="pill">FRESH RUNTIME ONLY</text>',
            '<text x="350" y="910" class="body">Invalid or interrupted roots: populationContribution = 0 · reuseForbidden = true</text>',
            '<text x="350" y="940" class="body">Scores stay locked until exact denominators and official validators complete.</text>',
            '</svg>',
        ]
    )
    return "\n".join(parts) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--timestamp", required=True)
    parser.add_argument("--parser-sha", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    svg = render(args.timestamp, args.parser_sha)
    if args.out.suffix.lower() == ".png":
        subprocess.run(
            ["convert", "svg:-", str(args.out)], input=svg, text=True, check=True
        )
    else:
        args.out.write_text(svg, encoding="utf-8")
    print(args.out.resolve())


if __name__ == "__main__":
    main()
