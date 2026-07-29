#!/usr/bin/env python3
"""Render a validated ACEBench fresh full-population score card."""

from __future__ import annotations

import argparse
import html
import json
import subprocess
from pathlib import Path


COLORS = {"Native": "#a78bfa", "Native-Plus": "#5eead4"}
MODELS = {
    "Native": "glm52-native-FC",
    "Native-Plus": "glm52-native-plus-FC",
}


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--validation", required=True, type=Path)
    parser.add_argument("--coverage", required=True, type=Path)
    parser.add_argument("--bridge", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    validation = json.loads(args.validation.read_text(encoding="utf-8"))
    coverage = json.loads(args.coverage.read_text(encoding="utf-8"))
    bridge = json.loads(args.bridge.read_text(encoding="utf-8"))
    if any(value.get("status") != "valid" for value in (validation, coverage, bridge)):
        raise RuntimeError("ACEBench validation inputs are not all valid")

    by_language = validation["officialSummaryByLanguage"]
    macro = validation["officialSummaryMacroAverage"]
    panels = [
        ("English", by_language["en"]),
        ("Chinese", by_language["zh"]),
        ("Macro average", macro),
    ]
    width, height = 1320, 820
    x0, bar_width = 390, 760
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" rx="30" fill="#05070b"/>',
        '<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:38px;font-weight:760;fill:#f8fafc}.sub{font-size:17px;fill:#94a3b8}.panel{font-size:23px;font-weight:720;fill:#f8fafc}.label{font-size:17px;fill:#cbd5e1}.value{font-size:17px;font-weight:760}.pill{font-size:14px;font-weight:760;fill:#6ee7b7}.audit{font-size:15px;fill:#94a3b8}</style>',
        '<text x="64" y="70" class="title">ACEBench · fresh full-population validated score</text>',
        '<text x="64" y="104" class="sub">Native-tool adaptation · pinned official checker and weights · 2,040 cases / arm</text>',
        '<rect x="64" y="132" width="1192" height="72" rx="18" fill="#111827"/>',
        f'<text x="92" y="162" class="audit">COVERAGE + CAPTURE AUDIT</text>',
        f'<text x="92" y="188" class="label">4,080 fresh result rows · {bridge["requestCount"]:,} requests = {bridge["captureCount"]:,} captures · score tree SHA {esc(validation["scoreTreeSha256"][:12])}…</text>',
        '<rect x="1040" y="149" width="180" height="38" rx="19" fill="#064e3b"/>',
        '<text x="1130" y="174" text-anchor="middle" class="pill">VALIDATED</text>',
    ]
    for panel_index, (panel_name, scores) in enumerate(panels):
        top = 252 + panel_index * 166
        parts.append(f'<text x="64" y="{top}" class="panel">{esc(panel_name)}</text>')
        for arm_index, (label, model) in enumerate(MODELS.items()):
            value = float(scores[model])
            y = top + 30 + arm_index * 50
            color = COLORS[label]
            parts.extend(
                [
                    f'<text x="64" y="{y + 23}" class="label">{esc(label)}</text>',
                    f'<rect x="{x0}" y="{y}" width="{bar_width}" height="32" rx="10" fill="#172036"/>',
                    f'<rect x="{x0}" y="{y}" width="{bar_width * value:.2f}" height="32" rx="10" fill="{color}"/>',
                    f'<text x="1225" y="{y + 23}" text-anchor="end" class="value" fill="{color}">{value * 100:.2f}</text>',
                ]
            )
    native = float(macro[MODELS["Native"]])
    plus = float(macro[MODELS["Native-Plus"]])
    delta = (plus - native) * 100
    parts.extend(
        [
            '<rect x="64" y="730" width="1192" height="54" rx="16" fill="#111827"/>',
            '<text x="92" y="764" class="label">Macro delta · Native-Plus − Native</text>',
            f'<text x="1218" y="764" text-anchor="end" class="value" fill="#5eead4">{delta:+.2f} percentage points</text>',
            '</svg>',
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
    print(json.dumps({"deltaPercentagePoints": delta, "out": str(args.out.resolve())}, sort_keys=True))


if __name__ == "__main__":
    main()
