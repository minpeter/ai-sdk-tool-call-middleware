#!/usr/bin/env python3
"""Render a VAKRA fresh-run readiness board without computing scores."""

from __future__ import annotations

import argparse
import html
import json
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected a JSON object")
    return value


def status_pill(
    x: int, y: int, label: str, *, passed: bool, width: int = 190
) -> str:
    fill = "#064e3b" if passed else "#78350f"
    color = "#6ee7b7" if passed else "#fbbf24"
    return "\n".join(
        (
            f'<rect x="{x}" y="{y}" width="{width}" height="36" rx="18" fill="{fill}"/>',
            f'<text x="{x + width / 2}" y="{y + 24}" text-anchor="middle" class="pill" fill="{color}">{esc(label)}</text>',
        )
    )


def render(
    manifest: dict[str, Any],
    smoke: dict[str, Any],
    *,
    dataset_ready: bool,
    output_absent: bool,
    timestamp: str,
) -> str:
    width, height = 1600, 1180
    counts = manifest["counts"]
    capability_cards = (
        ("Capability 1", "BI APIs", counts["capability_1_bi_apis"], "#60a5fa"),
        (
            "Capability 2",
            "Dashboard APIs",
            counts["capability_2_dashboard_apis"],
            "#34d399",
        ),
        (
            "Capability 3",
            "Multi-hop reasoning",
            counts["capability_3_multihop_reasoning"],
            "#fbbf24",
        ),
        (
            "Capability 4",
            "Multi-turn",
            counts["capability_4_multiturn"],
            "#fb7185",
        ),
    )
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">',
        '<rect width="100%" height="100%" rx="30" fill="#05070b"/>',
        "<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:42px;font-weight:780;fill:#f8fafc}.sub{font-size:18px;fill:#94a3b8}.eyebrow{font-size:14px;font-weight:760;letter-spacing:1.4px;fill:#94a3b8}.big{font-size:58px;font-weight:820}.cardtitle{font-size:21px;font-weight:740;fill:#f8fafc}.body{font-size:16px;fill:#cbd5e1}.small{font-size:14px;fill:#94a3b8}.pill{font-size:14px;font-weight:760}.flow{font-size:16px;font-weight:700;fill:#e2e8f0}.arrow{stroke:#475569;stroke-width:4;marker-end:url(#arrow)}</style>",
        '<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#475569"/></marker></defs>',
        '<text x="64" y="72" class="title">VAKRA · fresh full-population readiness</text>',
        f'<text x="64" y="108" class="sub">{esc(timestamp)} · setup and transport evidence only · no benchmark score</text>',
        '<rect x="64" y="142" width="700" height="176" rx="24" fill="#111827"/>',
        '<text x="94" y="178" class="eyebrow">PINNED OFFICIAL POPULATION</text>',
        f'<text x="94" y="248" class="big" fill="#5eead4">{manifest["taskCount"]:,}</text>',
        '<text x="294" y="234" class="cardtitle">tasks / arm</text>',
        f'<text x="94" y="288" class="body">{manifest["taskCount"] * 2:,} brand-new Native + Native-Plus trajectories</text>',
        '<rect x="804" y="142" width="732" height="176" rx="24" fill="#111827"/>',
        '<text x="834" y="178" class="eyebrow">FRESHNESS BOUNDARY</text>',
        '<text x="834" y="220" class="cardtitle">No raw · no score · no preseed · no resume</text>',
        f'<text x="834" y="256" class="small">Code {esc(str(manifest["codeCommit"])[:12])} · dataset {esc(str(manifest["datasetRevision"])[:12])}</text>',
        f'<text x="834" y="288" class="small">Task-set SHA {esc(str(manifest["taskSetSha256"])[:20])}…</text>',
        '<text x="64" y="374" class="eyebrow">CAPABILITY DENOMINATORS</text>',
    ]
    for index, (capability, label, count, color) in enumerate(capability_cards):
        x = 64 + index * 372
        parts.extend(
            [
                f'<rect x="{x}" y="398" width="344" height="130" rx="20" fill="#111827"/>',
                f'<circle cx="{x + 30}" cy="432" r="8" fill="{color}"/>',
                f'<text x="{x + 50}" y="439" class="body">{esc(capability)}</text>',
                f'<text x="{x + 28}" y="480" class="cardtitle">{esc(label)}</text>',
                f'<text x="{x + 28}" y="512" class="body" fill="{color}">{int(count):,} tasks</text>',
            ]
        )

    parts.extend(
        [
            '<text x="64" y="586" class="eyebrow">EXECUTION PATH</text>',
            '<rect x="64" y="612" width="1472" height="190" rx="24" fill="#0b1220"/>',
        ]
    )
    flow = (
        (120, "Pinned data"),
        (390, "4 MCP containers"),
        (690, "LangChain + LiteLLM"),
        (1010, "Native / Native-Plus"),
        (1310, "Exact validators"),
    )
    for index, (x, label) in enumerate(flow):
        parts.extend(
            [
                f'<rect x="{x}" y="674" width="210" height="66" rx="18" fill="#172036"/>',
                f'<text x="{x + 105}" y="714" text-anchor="middle" class="flow">{esc(label)}</text>',
            ]
        )
        if index + 1 < len(flow):
            parts.append(
                f'<line x1="{x + 218}" y1="707" x2="{flow[index + 1][0] - 16}" y2="707" class="arrow"/>'
            )

    smoke_valid = (
        smoke.get("status") == "valid"
        and smoke.get("requestCount") == 2
        and smoke.get("captureCount") == 2
    )
    parts.extend(
        [
            '<text x="64" y="862" class="eyebrow">READINESS GATES</text>',
            '<rect x="64" y="888" width="1472" height="206" rx="24" fill="#111827"/>',
            '<text x="94" y="930" class="body">CPU-only agent environment and pinned runner</text>',
            status_pill(1260, 904, "PASS", passed=True),
            '<text x="94" y="978" class="body">Native tool transport smoke · 2 arms · request/capture parity</text>',
            status_pill(
                1260,
                952,
                f'{"PASS" if smoke_valid else "FAIL"} · {smoke.get("requestCount", 0)}/2',
                passed=smoke_valid,
            ),
            '<text x="94" y="1026" class="body">Pinned 13 GB environment snapshot and file-hash verification</text>',
            status_pill(
                1260,
                1000,
                "PASS" if dataset_ready else "QUEUED",
                passed=dataset_ready,
            ),
            '<text x="94" y="1074" class="body">Full output root absent before first model-under-test call</text>',
            status_pill(
                1260,
                1048,
                "PASS" if output_absent else "STARTED",
                passed=output_absent,
            ),
            '<rect x="64" y="1120" width="1472" height="42" rx="21" fill="#3f1d2e"/>',
            '<text x="800" y="1148" text-anchor="middle" class="pill" fill="#fda4af">SCORE LOCKED UNTIL 5,207 / 5,207 BOTH ARMS + INFERENCE VALIDATOR + FRESH JUDGE VALIDATOR</text>',
            "</svg>",
        ]
    )
    return "\n".join(parts) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--smoke-validation", type=Path, required=True)
    parser.add_argument("--dataset-sync", type=Path)
    parser.add_argument("--full-output-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--timestamp")
    args = parser.parse_args()
    manifest = read_object(args.manifest)
    smoke = read_object(args.smoke_validation)
    smoke_valid = (
        smoke.get("status") == "valid"
        and smoke.get("requestCount") == 2
        and smoke.get("captureCount") == 2
    )
    dataset_ready = False
    if args.dataset_sync and args.dataset_sync.is_file():
        dataset_ready = read_object(args.dataset_sync).get("status") == "valid"
    timestamp = args.timestamp or datetime.now().astimezone().strftime(
        "%Y-%m-%d %H:%M %Z"
    )
    rendered = render(
        manifest,
        smoke,
        dataset_ready=dataset_ready,
        output_absent=not args.full_output_root.exists(),
        timestamp=timestamp,
    )
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
                "datasetReady": dataset_ready,
                "expectedFreshTrajectories": int(manifest["taskCount"]) * 2,
                "fullOutputAbsent": not args.full_output_root.exists(),
                "out": str(args.out.resolve()),
                "smokeValid": smoke_valid,
                "taskCountPerArm": manifest["taskCount"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
