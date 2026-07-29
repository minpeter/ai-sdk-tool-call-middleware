#!/usr/bin/env python3
"""Render the source-confirmed full benchmark population catalog."""

from __future__ import annotations

import argparse
import html
import math
from pathlib import Path


BENCHMARKS = (
    ("HammerBench", 61075, "EN + ZH full files", "#fb7185"),
    ("BFCL V4", 5217, "all_scoring · 22 categories", "#38bdf8"),
    ("VAKRA", 5207, "public test · four capabilities", "#f472b6"),
    ("ACEBench", 2040, "EN 1,023 + ZH 1,017", "#818cf8"),
    ("ToolSandbox", 1032, "official named_scenarios()", "#fbbf24"),
    ("ComplexFuncBench", 1000, "pinned dataset rows", "#f97316"),
    ("StableToolBench", 765, "six canonical sets", "#c084fc"),
    ("AppWorld", 585, "test_normal 168 + test_challenge 417", "#22d3ee"),
    ("τ³ base", 375, "50 + 114 + 114 + 97", "#a78bfa"),
    ("MCPMark Verified", 127, "standard · six services", "#5eead4"),
    ("Terminal-Bench 2.1", 89, "official Harbor population", "#34d399"),
)
EXPANSION_ONLY = frozenset({"ToolSandbox", "ComplexFuncBench"})


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def render() -> str:
    width = 1600
    row_height = 92
    height = 260 + row_height * len(BENCHMARKS) + 120
    x0 = 440
    bar_width = 920
    maximum = max(count for _, count, _, _ in BENCHMARKS)
    expanded_total = sum(count for _, count, _, _ in BENCHMARKS)
    primary_total = sum(
        count for name, count, _, _ in BENCHMARKS if name not in EXPANSION_ONLY
    )
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">',
        '<rect width="100%" height="100%" rx="32" fill="#05070b"/>',
        '<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:42px;font-weight:760;fill:#f8fafc}.sub{font-size:19px;fill:#94a3b8}.name{font-size:22px;font-weight:700;fill:#f8fafc}.note{font-size:14px;fill:#94a3b8}.count{font-size:23px;font-weight:750}.axis{font-size:13px;fill:#64748b}</style>',
        '<text x="72" y="74" class="title">Confirmed full-population benchmark catalog</text>',
        '<text x="72" y="112" class="sub">Fresh-only targets · source-pinned counts · logarithmic bar scale</text>',
        f'<rect x="72" y="148" width="1456" height="88" rx="20" fill="#111827"/>',
        f'<text x="108" y="184" class="note">EXPANDED 11-SUITE CASES / ARM</text>',
        f'<text x="108" y="221" class="title">{expanded_total:,}</text>',
        f'<text x="370" y="215" class="sub">primary 9 = {primary_total:,} / arm · expanded = {expanded_total * 2:,} fresh trajectories</text>',
        '<rect x="1220" y="168" width="260" height="48" rx="24" fill="#064e3b"/>',
        '<text x="1350" y="199" text-anchor="middle" class="name" fill="#6ee7b7">NO SCORE REUSE</text>',
    ]
    for index, (name, count, note, color) in enumerate(BENCHMARKS):
        y = 282 + index * row_height
        ratio = math.log10(count + 1) / math.log10(maximum + 1)
        parts.extend(
            [
                f'<text x="92" y="{y + 26}" class="name">{esc(name)}</text>',
                f'<text x="92" y="{y + 52}" class="note">{esc(note)}</text>',
                f'<rect x="{x0}" y="{y}" width="{bar_width}" height="50" rx="14" fill="#172036"/>',
                f'<rect x="{x0}" y="{y}" width="{bar_width * ratio:.2f}" height="50" rx="14" fill="{color}"/>',
                f'<text x="1480" y="{y + 34}" text-anchor="end" class="count" fill="{color}">{count:,}</text>',
            ]
        )
    footer_y = 300 + len(BENCHMARKS) * row_height
    parts.extend(
        [
            f'<text x="72" y="{footer_y}" class="sub">Separate diagnostic: BFCL format_sensitivity 5,200 / arm</text>',
            f'<text x="72" y="{footer_y + 30}" class="note">Official CLI skips it for FC model aliases; it is excluded from both the 75,480 primary-9 and 77,512 expanded-11 totals.</text>',
            f'<text x="72" y="{footer_y + 70}" class="axis">Primary 9 excludes externally blocked ToolSandbox and ComplexFuncBench; expanded 11 retains their full pinned denominators without subset scoring.</text>',
            '</svg>',
        ]
    )
    return "\n".join(parts) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(render(), encoding="utf-8")
    print(args.out.resolve())


if __name__ == "__main__":
    main()
