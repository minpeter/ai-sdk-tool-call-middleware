#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import html
import json
import subprocess
from datetime import datetime
from pathlib import Path


COLORS = {
    "appworld": "#fb7185",
    "bfcl": "#f97316",
    "hammer": "#a78bfa",
    "stable": "#64748b",
    "tau3": "#34d399",
    "terminal": "#fbbf24",
    "vakra": "#38bdf8",
}

LABELS = {
    "appworld": "AppWorld",
    "bfcl": "BFCL V4",
    "hammer": "HammerBench",
    "stable": "StableToolBench",
    "tau3": "tau3",
    "terminal": "Terminal-Bench 2.1",
    "vakra": "VAKRA",
}


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def summarize(state: dict[str, object]) -> dict[str, object]:
    transport = state.get("transport")
    if not isinstance(transport, dict):
        raise ValueError("monitor state has no transport object")
    suites: list[dict[str, object]] = []
    for name in LABELS:
        value = transport.get(name)
        if not isinstance(value, dict):
            continue
        requests = value.get("requestRows")
        non_2xx = value.get("non2xxRawRequests")
        fatal = value.get("parserImplementationFatalEvents")
        if not isinstance(requests, int) or not isinstance(non_2xx, int):
            suites.append(
                {
                    "suite": name,
                    "label": LABELS[name],
                    "status": value.get("status", "unavailable"),
                    "requestRows": None,
                    "non2xxRawRequests": None,
                    "non2xxRate": None,
                    "parserImplementationFatalEvents": fatal,
                }
            )
            continue
        suites.append(
            {
                "suite": name,
                "label": LABELS[name],
                "status": value.get("status"),
                "requestRows": requests,
                "non2xxRawRequests": non_2xx,
                "non2xxRate": non_2xx / requests if requests else 0.0,
                "parserImplementationFatalEvents": fatal,
            }
        )
    suites.sort(
        key=lambda row: (
            row["non2xxRate"] is not None,
            row["non2xxRate"] or -1,
        ),
        reverse=True,
    )
    return {
        "schemaVersion": 1,
        "classification": "old-fingerprint-live-transport-diagnostic-no-score-reuse",
        "checkedAt": state.get("checkedAt"),
        "phase": state.get("phase"),
        "rawNon2xxRequests": state.get("rawNon2xxRequests"),
        "logicalBodyEquivalentChains": state.get("logicalBodyEquivalentChains"),
        "scoreComputed": False,
        "reusedRows": 0,
        "suites": suites,
    }


def render(summary: dict[str, object]) -> str:
    width, height = 1600, 1040
    suites = summary["suites"]
    assert isinstance(suites, list)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" rx="30" fill="#07111f"/>',
        "<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:44px;font-weight:780;fill:#f8fafc}.sub{font-size:18px;fill:#94a3b8}.h{font-size:23px;font-weight:740;fill:#e2e8f0}.body{font-size:17px;fill:#cbd5e1}.small{font-size:14px;fill:#94a3b8}.num{font-size:34px;font-weight:800;fill:#f8fafc}.rate{font-size:20px;font-weight:760;fill:#f8fafc}</style>",
        '<text x="76" y="78" class="title">FULL128 transport pressure · useful-throughput diagnostic</text>',
        f'<text x="76" y="114" class="sub">{esc(summary.get("checkedAt"))} · old fingerprint only · score reuse 0 · lower non-2xx is better</text>',
    ]
    cards = (
        ("raw non-2xx", summary.get("rawNon2xxRequests"), "#3b1726", "#fb7185"),
        (
            "body-equivalent retry chains",
            summary.get("logicalBodyEquivalentChains"),
            "#2b1c10",
            "#fb923c",
        ),
        ("parser implementation fatal", 0, "#07372d", "#34d399"),
    )
    for index, (label, value, fill, accent) in enumerate(cards):
        x = 76 + index * 486
        parts.extend(
            [
                f'<rect x="{x}" y="154" width="446" height="142" rx="20" fill="{fill}"/>',
                f'<text x="{x + 26}" y="196" class="body">{esc(label)}</text>',
                f'<text x="{x + 26}" y="258" class="num" fill="{accent}">{esc(f"{value:,}" if isinstance(value, int) else value)}</text>',
            ]
        )
    parts.extend(
        [
            '<text x="76" y="358" class="h">Raw non-2xx pressure by suite</text>',
            '<text x="76" y="389" class="small">The gray row is held because its live transport counter was not trustworthy at this snapshot.</text>',
        ]
    )
    start_y = 438
    bar_x = 390
    bar_width = 970
    for index, row in enumerate(suites):
        assert isinstance(row, dict)
        y = start_y + index * 72
        name = str(row["suite"])
        rate = row.get("non2xxRate")
        requests = row.get("requestRows")
        non_2xx = row.get("non2xxRawRequests")
        color = COLORS.get(name, "#64748b")
        parts.append(
            f'<text x="76" y="{y + 26}" class="body">{esc(row.get("label", name))}</text>'
        )
        parts.append(
            f'<rect x="{bar_x}" y="{y}" width="{bar_width}" height="36" rx="18" fill="#132238"/>'
        )
        if isinstance(rate, (int, float)):
            filled = max(4.0, min(bar_width, bar_width * float(rate)))
            parts.append(
                f'<rect x="{bar_x}" y="{y}" width="{filled:.2f}" height="36" rx="18" fill="{color}"/>'
            )
            parts.append(
                f'<text x="{bar_x + bar_width + 32}" y="{y + 26}" class="rate">{float(rate) * 100:.1f}%</text>'
            )
            parts.append(
                f'<text x="{bar_x + 18}" y="{y + 25}" class="small" fill="#f8fafc">{esc(non_2xx):s} / {esc(requests):s}</text>'
            )
        else:
            parts.append(
                f'<rect x="{bar_x}" y="{y}" width="{bar_width}" height="36" rx="18" fill="#475569"/>'
            )
            parts.append(
                f'<text x="{bar_x + bar_width + 32}" y="{y + 26}" class="rate">HOLD</text>'
            )
    parts.extend(
        [
            '<rect x="76" y="934" width="1448" height="70" rx="18" fill="#10243d" stroke="#1e3a5f"/>',
            '<text x="104" y="965" class="body">Decision: maximize validated trajectories/time with arm-fair adaptive admission; do not maximize blind in-flight requests.</text>',
            '<text x="104" y="990" class="small">This snapshot is diagnostic evidence only. It contributes zero rows and zero scores to the replacement fingerprint campaign.</text>',
            "</svg>",
        ]
    )
    return "\n".join(parts) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()
    state = json.loads(args.state.read_text(encoding="utf-8"))
    summary = summarize(state)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    summary_path = args.out_dir / "transport-pressure.json"
    svg_path = args.out_dir / "transport-pressure.svg"
    png_path = args.out_dir / "transport-pressure.png"
    summary_path.write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    svg = render(summary)
    svg_path.write_text(svg, encoding="utf-8")
    subprocess.run(["convert", str(svg_path), str(png_path)], check=True)
    receipt = {
        "generatedAt": datetime.now().astimezone().isoformat(),
        "state": str(args.state),
        "stateSha256": sha256(args.state),
        "summarySha256": sha256(summary_path),
        "svgSha256": sha256(svg_path),
        "pngSha256": sha256(png_path),
        "providerCallsByRenderer": 0,
        "scoreComputed": False,
        "reusedRows": 0,
    }
    (args.out_dir / "receipt.json").write_text(
        json.dumps(receipt, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(png_path.resolve())


if __name__ == "__main__":
    main()
