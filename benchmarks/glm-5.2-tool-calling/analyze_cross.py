#!/usr/bin/env python3
"""Create a compact BFCL/ACE cross-benchmark comparison chart."""

from __future__ import annotations

import argparse
import csv
import html
import json
from pathlib import Path
from typing import Any


ARM_ORDER = (
    "native",
    "glm5",
    "hermes",
    "morphXml",
    "yamlXml",
    "qwen3Coder",
    "sijawaraDetailed",
    "sijawaraConcise",
    "uiTars",
)
ARM_LABELS = {
    "native": "Native",
    "glm5": "GLM-5.2",
    "hermes": "Hermes",
    "morphXml": "Morph XML",
    "yamlXml": "YAML XML",
    "qwen3Coder": "Qwen3Coder",
    "sijawaraDetailed": "Sijawara Detailed",
    "sijawaraConcise": "Sijawara Concise",
    "uiTars": "UI-TARS",
}
ARM_COLORS = {
    "native": "#111827",
    "glm5": "#dc2626",
    "hermes": "#7c3aed",
    "morphXml": "#059669",
    "yamlXml": "#d97706",
    "qwen3Coder": "#2563eb",
    "sijawaraDetailed": "#db2777",
    "sijawaraConcise": "#f472b6",
    "uiTars": "#0891b2",
}


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def escape(value: Any) -> str:
    return html.escape(str(value), quote=True)


def chart(rows: list[dict[str, Any]]) -> str:
    width = 1120
    left = 230
    top = 115
    chart_width = 820
    row_height = 58
    bottom = top + len(rows) * row_height
    height = max(650, bottom + 55)
    lines: list[str] = [
        '<text x="40" y="63" class="subtitle">Strict values are end-to-end custom-panel accuracy; provider failures count as incorrect.</text>',
        '<circle cx="650" cy="84" r="7" fill="#111827"/><text x="665" y="89" class="small">BFCL E2E strict</text>',
        '<rect x="795" y="77" width="14" height="14" fill="#111827"/><text x="817" y="89" class="small">ACE E2E strict</text>',
        '<path d="M940 91 L948 76 L956 91 Z" fill="#94a3b8" stroke="#111827" stroke-width="2"/><text x="964" y="89" class="small">ACE conditional semantic</text>',
    ]
    for tick in range(0, 101, 20):
        x = left + tick / 100 * chart_width
        lines.append(
            f'<line x1="{x}" y1="{top - 15}" x2="{x}" y2="{bottom}" class="grid"/>'
        )
        lines.append(
            f'<text x="{x}" y="{bottom + 26}" text-anchor="middle" class="small">{tick}%</text>'
        )
    for index, row in enumerate(rows):
        y = top + index * row_height + 24
        color = ARM_COLORS[row["arm"]]
        bfcl_x = left + row["bfclStrict"] * chart_width
        ace_x = left + row["aceStrict"] * chart_width
        semantic_x = left + row["aceSemantic"] * chart_width
        lines.append(
            f'<text x="{left - 16}" y="{y + 5}" text-anchor="end" class="label">{escape(ARM_LABELS[row["arm"]])}</text>'
        )
        lines.append(
            f'<line x1="{min(bfcl_x, ace_x)}" y1="{y}" x2="{max(bfcl_x, ace_x)}" y2="{y}" stroke="{color}" stroke-width="4" opacity="0.28"/>'
        )
        lines.append(f'<circle cx="{bfcl_x}" cy="{y}" r="8" fill="{color}"/>')
        lines.append(
            f'<rect x="{ace_x - 7}" y="{y - 7}" width="14" height="14" fill="{color}"/>'
        )
        lines.append(
            f'<path d="M{semantic_x - 8} {y + 8} L{semantic_x} {y - 8} L{semantic_x + 8} {y + 8} Z" fill="{color}" fill-opacity="0.35" stroke="{color}" stroke-width="2"/>'
        )
        lines.append(
            f'<text x="{left + chart_width + 10}" y="{y + 5}" class="value">{row["bfclStrict"] * 100:.1f} / {row["aceStrict"] * 100:.0f}%</text>'
        )
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="chart-title">
  <title id="chart-title">Cross-benchmark protocol accuracy</title>
  <rect width="100%" height="100%" fill="#ffffff"/>
  <style>text{{font-family:Inter,Arial,sans-serif;fill:#111827}}.title{{font-size:24px;font-weight:700}}.subtitle{{font-size:13px;fill:#4b5563}}.label{{font-size:14px}}.small{{font-size:12px;fill:#4b5563}}.value{{font-size:12px;font-weight:700}}.grid{{stroke:#e5e7eb;stroke-width:1}}</style>
  <text x="40" y="38" class="title">Cross-benchmark protocol accuracy</text>
  {"".join(lines)}
</svg>
'''


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bfcl-summary", required=True, type=Path)
    parser.add_argument("--ace-summary", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    args = parser.parse_args()

    bfcl = {row["arm"]: row for row in load_json(args.bfcl_summary)["arms"]}
    ace = {row["arm"]: row for row in load_json(args.ace_summary)["protocols"]}
    rows = [
        {
            "arm": arm,
            "bfclStrict": bfcl[arm]["endToEndAccuracy"],
            "bfclConditionalStrict": bfcl[arm]["accuracy"],
            "bfclAvailability": bfcl[arm]["availability"],
            "bfclMacro": bfcl[arm]["macroAccuracy"],
            "aceStrict": ace[arm]["endToEndAccuracy"],
            "aceConditionalStrict": ace[arm]["accuracy"],
            "aceAvailability": ace[arm]["availability"],
            "aceSemantic": ace[arm]["aceAccuracy"],
        }
        for arm in ARM_ORDER
        if arm in bfcl and arm in ace
    ]

    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "cross-benchmark-summary.json").write_text(
        json.dumps(rows, indent=2) + "\n", encoding="utf-8"
    )
    with (args.out_dir / "cross-benchmark-summary.csv").open(
        "w", encoding="utf-8", newline=""
    ) as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    (args.out_dir / "cross-benchmark-accuracy.svg").write_text(
        chart(rows), encoding="utf-8"
    )
    print(f"Wrote cross-benchmark comparison -> {args.out_dir}")


if __name__ == "__main__":
    main()
