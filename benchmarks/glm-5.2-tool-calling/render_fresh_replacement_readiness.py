#!/usr/bin/env python3
"""Render the read-only fresh replacement readiness audit."""

from __future__ import annotations

import argparse
import html
import json
import subprocess
from datetime import datetime
from pathlib import Path


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def status_color(ok: bool) -> str:
    return "#5eead4" if ok else "#fb7185"


def status_label(ok: bool) -> str:
    return "PASS" if ok else "BLOCKED"


def render(report: dict[str, object], timestamp: str) -> str:
    width, height = 1600, 1280
    global_checks = report["global"]
    mcpmark = report["mcpmark127"]
    suites = report["suites"]
    assert isinstance(global_checks, dict)
    assert isinstance(mcpmark, dict)
    assert isinstance(suites, list)
    checks = (
        ("Pinned manifests", bool(global_checks["manifestsReady"])),
        ("Replacement roots absent", bool(global_checks["replacementRootsAbsent"])),
        ("Reserved ports free", bool(global_checks["portsFree"])),
        ("Docker ready", bool(global_checks["dockerReady"])),
        ("TB2.1 disk ≥ 25 GiB", bool(global_checks["minimumTerminalBenchDiskReady"])),
        ("Provider key in process env", bool(global_checks["providerCredentialPresent"])),
    )
    services = mcpmark["services"]
    assert isinstance(services, dict)
    service_rows = (
        ("Filesystem 30", bool(services["filesystem"])),
        ("Postgres 21", bool(services["postgres"])),
        ("Playwright 4", bool(services["playwright"])),
        ("GitHub 23", bool(services["github"])),
        ("Notion 28", bool(services["notion"])),
        ("WebArena 21", bool(services["playwright_webarena"])),
    )
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">',
        '<rect width="100%" height="100%" rx="30" fill="#05070b"/>',
        "<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:42px;font-weight:780;fill:#f8fafc}.sub{font-size:18px;fill:#94a3b8}.eyebrow{font-size:14px;font-weight:760;letter-spacing:1.4px;fill:#94a3b8}.cardtitle{font-size:21px;font-weight:740;fill:#f8fafc}.body{font-size:16px;fill:#cbd5e1}.small{font-size:14px;fill:#94a3b8}.state{font-size:15px;font-weight:760}.suite{font-size:16px;font-weight:700;fill:#e2e8f0}.count{font-size:15px;fill:#94a3b8}</style>",
        '<text x="64" y="72" class="title">Fresh replacement · readiness gate</text>',
        f'<text x="64" y="108" class="sub">{esc(timestamp)} · read-only preflight · no provider call · no output root creation</text>',
        '<rect x="64" y="142" width="1472" height="92" rx="22" fill="#111827"/>',
        '<text x="94" y="176" class="eyebrow">CURRENT DECISION</text>',
        f'<text x="94" y="212" class="cardtitle">{esc(str(report["status"]).upper())}</text>',
        '<text x="1500" y="196" text-anchor="end" class="small">Partial invalid roots remain excluded · ACEBench validated result retained</text>',
        '<text x="64" y="286" class="eyebrow">GLOBAL FRESHNESS AND RUNTIME GATES</text>',
    ]
    for index, (label, ok) in enumerate(checks):
        col, row = index % 3, index // 3
        x, y = 64 + col * 500, 314 + row * 94
        color = status_color(ok)
        parts.extend(
            [
                f'<rect x="{x}" y="{y}" width="472" height="72" rx="16" fill="#111827" stroke="{color}" stroke-width="1.5"/>',
                f'<circle cx="{x + 28}" cy="{y + 36}" r="8" fill="{color}"/>',
                f'<text x="{x + 50}" y="{y + 31}" class="body">{esc(label)}</text>',
                f'<text x="{x + 50}" y="{y + 54}" class="state" fill="{color}">{status_label(ok)}</text>',
            ]
        )
    free_disk = global_checks["freeDiskGiB"]
    parts.extend(
        [
            f'<text x="64" y="524" class="small">Free disk {esc(free_disk)} GiB · stale Terminal-Bench containers {len(global_checks["terminalBenchTaskContainers"])}</text>',
            '<text x="64" y="580" class="eyebrow">MCPMARK VERIFIED STANDARD · EXACT 127 TASKS / ARM</text>',
        ]
    )
    for index, (label, ok) in enumerate(service_rows):
        x = 64 + index * 248
        color = status_color(ok)
        parts.extend(
            [
                f'<rect x="{x}" y="608" width="232" height="108" rx="18" fill="#111827"/>',
                f'<circle cx="{x + 28}" cy="640" r="7" fill="{color}"/>',
                f'<text x="{x + 46}" y="646" class="body">{esc(label)}</text>',
                f'<text x="{x + 28}" y="688" class="state" fill="{color}">{status_label(ok)}</text>',
            ]
        )
    parts.extend(
        [
            '<text x="64" y="772" class="eyebrow">REPLACEMENT SUITES · EMPTY ROOT + PINNED DENOMINATOR</text>',
        ]
    )
    for index, item in enumerate(suites):
        assert isinstance(item, dict)
        col, row = index % 2, index // 2
        x, y = 64 + col * 744, 800 + row * 92
        preflight_ok = bool(
            item["manifestReady"] and item["outputRootsAbsent"] and item["portFree"]
        )
        color = status_color(preflight_ok)
        parts.extend(
            [
                f'<rect x="{x}" y="{y}" width="716" height="72" rx="16" fill="#111827"/>',
                f'<circle cx="{x + 26}" cy="{y + 25}" r="7" fill="{color}"/>',
                f'<text x="{x + 44}" y="{y + 31}" class="suite">{esc(item["name"])}</text>',
                f'<text x="{x + 44}" y="{y + 56}" class="count">{int(item["expectedPerArm"]):,} / arm · port {item["port"]} · preflight {status_label(preflight_ok)}</text>',
            ]
        )
    parts.extend(
        [
            '<rect x="64" y="1192" width="1472" height="52" rx="24" fill="#4c0519"/>',
            '<text x="800" y="1225" text-anchor="middle" class="state" fill="#fda4af">NO REPLACEMENT LAUNCH UNTIL PROVIDER KEY IS RESTORED · MCPMARK ALSO REQUIRES GITHUB, NOTION, AND WEBARENA</text>',
            "</svg>",
        ]
    )
    return "\n".join(parts) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--timestamp")
    args = parser.parse_args()
    report = json.loads(args.audit.read_text(encoding="utf-8"))
    timestamp = args.timestamp or datetime.now().astimezone().strftime(
        "%Y-%m-%d %H:%M %Z"
    )
    rendered = render(report, timestamp)
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
    print(json.dumps({"out": str(args.out.resolve()), "status": report["status"]}))


if __name__ == "__main__":
    main()
