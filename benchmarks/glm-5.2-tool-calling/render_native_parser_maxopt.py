#!/usr/bin/env python3

from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
import subprocess


def load_object(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object: {path}")
    return value


def nested(value: dict[str, object], *keys: str) -> object:
    current: object = value
    for key in keys:
        if not isinstance(current, dict) or key not in current:
            raise ValueError(f"missing field: {'.'.join(keys)}")
        current = current[key]
    return current


def number(value: dict[str, object], *keys: str) -> float:
    item = nested(value, *keys)
    if isinstance(item, bool) or not isinstance(item, (int, float)):
        raise ValueError(f"expected number: {'.'.join(keys)}")
    return float(item)


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def render(
    performance: dict[str, object],
    same_byte: dict[str, object],
    parser_sha: str,
) -> str:
    baseline = number(performance, "baselineMedianMicroseconds")
    production = number(performance, "productionMedianMicroseconds")
    improvement = number(performance, "improvementPercent")
    catalog_size = int(number(performance, "catalogSize"))
    captures = int(number(same_byte, "corpus", "uniqueNativeCaptures"))
    preserved = int(number(same_byte, "parser", "validNativeCallsPreserved"))
    valid = int(number(same_byte, "parser", "nativeStrictValidCalls"))
    repaired = int(number(same_byte, "parser", "repairedMalformedCalls"))
    malformed = int(number(same_byte, "parser", "nativeMalformedCalls"))
    wins = int(number(same_byte, "scoring", "wins"))
    losses = int(number(same_byte, "scoring", "losses"))
    sse = int(number(same_byte, "stream", "sseCaptures"))
    invariant = int(number(same_byte, "stream", "chunkInvariant"))
    width, height = 1440, 860
    max_latency = max(baseline, production)
    baseline_width = 470 * baseline / max_latency
    production_width = 470 * production / max_latency
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" rx="30" fill="#05070b"/>',
        "<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:38px;font-weight:760;fill:#f8fafc}.sub{font-size:17px;fill:#94a3b8}.h{font-size:22px;font-weight:730;fill:#f8fafc}.body{font-size:16px;fill:#cbd5e1}.small{font-size:14px;fill:#94a3b8}.metric{font-size:42px;font-weight:800;fill:#f8fafc}.good{fill:#34d399}.zero{fill:#22d3ee}</style>",
        '<text x="70" y="72" class="title">GLM-5.2 Native-Plus · production max optimization</text>',
        f'<text x="70" y="108" class="sub">parser {esc(parser_sha[:12])}… · fresh production replay and 12-round latency A/B</text>',
        '<rect x="70" y="150" width="650" height="330" rx="22" fill="#111827" stroke="#1e293b"/>',
        f'<text x="100" y="195" class="h">{catalog_size}-tool transform + wrap latency</text>',
        '<text x="100" y="235" class="small">Cached candidate before direct native-tool snapshot</text>',
        f'<rect x="100" y="252" width="{baseline_width:.2f}" height="54" rx="10" fill="#64748b"/>',
        f'<text x="590" y="288" text-anchor="end" class="body">{baseline:.2f} µs</text>',
        '<text x="100" y="345" class="small">Current production</text>',
        f'<rect x="100" y="362" width="{production_width:.2f}" height="54" rx="10" fill="#8b5cf6"/>',
        f'<text x="590" y="398" text-anchor="end" class="body">{production:.2f} µs</text>',
        f'<text x="100" y="454" class="metric" fill="#34d399">−{improvement:.2f}%</text>',
        '<rect x="750" y="150" width="620" height="330" rx="22" fill="#111827" stroke="#1e293b"/>',
        '<text x="780" y="195" class="h">Same-byte safety gate</text>',
        f'<text x="780" y="250" class="metric">{captures:,}</text>',
        '<text x="780" y="278" class="small">unique provider captures replayed</text>',
        f'<text x="1045" y="250" class="metric" fill="#34d399">{preserved}/{valid}</text>',
        '<text x="1045" y="278" class="small">valid Native calls preserved</text>',
        f'<text x="780" y="365" class="metric" fill="#34d399">{repaired}/{malformed}</text>',
        '<text x="780" y="393" class="small">malformed calls repaired</text>',
        f'<text x="1045" y="365" class="metric" fill="#22d3ee">{wins}–{losses}</text>',
        '<text x="1045" y="393" class="small">official comparable wins–losses</text>',
        '<rect x="70" y="510" width="1300" height="270" rx="22" fill="#111827" stroke="#1e293b"/>',
        '<text x="100" y="555" class="h">Invariant stack</text>',
        '<line x1="155" y1="635" x2="1285" y2="635" stroke="#334155" stroke-width="6"/>',
    ]
    stages = (
        ("Valid calls", f"{preserved:,}/{valid:,}", "#8b5cf6"),
        ("Malformed repair", f"{repaired}/{malformed}", "#ec4899"),
        ("Official score", f"{wins} win · {losses} loss", "#10b981"),
        ("SSE rechunk", f"{invariant}/{sse}", "#22d3ee"),
    )
    for index, (label, detail, color) in enumerate(stages):
        x = 155 + index * 376
        parts.extend(
            [
                f'<circle cx="{x}" cy="635" r="22" fill="{color}"/>',
                f'<text x="{x}" y="690" text-anchor="middle" class="body">{esc(label)}</text>',
                f'<text x="{x}" y="720" text-anchor="middle" class="small">{esc(detail)}</text>',
            ]
        )
    parts.extend(
        [
            '<text x="100" y="760" class="small">No historical score reuse · provider calls in this replay: 0 · chunk invariance required before launch</text>',
            "</svg>",
        ]
    )
    return "\n".join(parts) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--performance", required=True, type=Path)
    parser.add_argument("--same-byte", required=True, type=Path)
    parser.add_argument("--parser-sha", required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    svg = render(
        load_object(args.performance),
        load_object(args.same_byte),
        args.parser_sha,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.out.suffix.lower() == ".png":
        subprocess.run(
            ["convert", "svg:-", str(args.out)],
            input=svg,
            text=True,
            check=True,
        )
    else:
        args.out.write_text(svg, encoding="utf-8")
    print(args.out.resolve())


if __name__ == "__main__":
    main()
