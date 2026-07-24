#!/usr/bin/env python3
"""Render a score-free Terminal-Bench 2.0 native-tool smoke audit."""

from __future__ import annotations

import argparse
import html
import json
import subprocess
from pathlib import Path


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--validation", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    validation = json.loads(args.validation.read_text(encoding="utf-8"))
    arms = (
        ("glm52-native", "Native", "#a78bfa"),
        ("glm52-native-plus", "Native-Plus", "#5eead4"),
    )
    width, height = 1460, 820
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">',
        '<rect width="100%" height="100%" rx="30" fill="#05070b"/>',
        "<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:38px;font-weight:780;fill:#f8fafc}.sub{font-size:17px;fill:#94a3b8}.eyebrow{font-size:14px;font-weight:760;letter-spacing:1.3px;fill:#94a3b8}.node{font-size:18px;font-weight:720;fill:#f8fafc}.body{font-size:15px;fill:#cbd5e1}.metric{font-size:34px;font-weight:800}.ok{font-size:16px;font-weight:740;fill:#6ee7b7}.note{font-size:14px;fill:#94a3b8}</style>",
        '<text x="58" y="66" class="title">Terminal-Bench 2.0 · native-tool path smoke</text>',
        '<text x="58" y="100" class="sub">Fresh Docker environment per arm · same task and agent · smoke proof, not benchmark score</text>',
        '<text x="58" y="152" class="eyebrow">VERIFIED EXECUTION PATH</text>',
    ]
    nodes = (
        (58, 184, 242, "Harbor", "official task + verifier"),
        (340, 184, 272, "MiniSweAgent 2.4.5", "native function tools"),
        (652, 184, 252, "Local bridge", "Native or Native-Plus"),
        (944, 184, 214, "GLM-5.2", "fresh provider call"),
        (1198, 184, 204, "Docker task", "bash tool execution"),
    )
    for index, (x, y, node_width, title, subtitle) in enumerate(nodes):
        parts.extend(
            [
                f'<rect x="{x}" y="{y}" width="{node_width}" height="108" rx="18" fill="#111827" stroke="#273244"/>',
                f'<text x="{x + node_width / 2}" y="{y + 44}" text-anchor="middle" class="node">{esc(title)}</text>',
                f'<text x="{x + node_width / 2}" y="{y + 75}" text-anchor="middle" class="body">{esc(subtitle)}</text>',
            ]
        )
        if index < len(nodes) - 1:
            next_x = nodes[index + 1][0]
            parts.extend(
                [
                    f'<line x1="{x + node_width + 10}" y1="238" x2="{next_x - 14}" y2="238" stroke="#5eead4" stroke-width="3"/>',
                    f'<path d="M {next_x - 24} 230 L {next_x - 12} 238 L {next_x - 24} 246" fill="none" stroke="#5eead4" stroke-width="3"/>',
                ]
            )

    parts.append('<text x="58" y="360" class="eyebrow">FRESH SMOKE RESULTS</text>')
    for index, (arm_id, label, color) in enumerate(arms):
        arm = validation["arms"][arm_id]
        x = 58 + index * 700
        parts.extend(
            [
                f'<rect x="{x}" y="388" width="644" height="278" rx="24" fill="#111827"/>',
                f'<text x="{x + 30}" y="430" class="node" fill="{color}">{esc(label)}</text>',
                f'<text x="{x + 30}" y="493" class="metric" fill="{color}">{arm["nativeToolCalls"]}</text>',
                f'<text x="{x + 92}" y="490" class="body">native bash tool calls</text>',
                f'<text x="{x + 30}" y="548" class="ok">PASS · official verifier reward {arm["verifierReward"]:.1f}</text>',
                f'<text x="{x + 30}" y="586" class="body">Bridge {arm["bridgeRequests"]}/{arm["providerCaptures"]} · HTTP 200 only · linkage {esc(arm["bridgeValidation"])}</text>',
                f'<text x="{x + 30}" y="626" class="note">Trajectory steps {arm["trajectorySteps"]} · prior-run resume disabled</text>',
            ]
        )

    parts.extend(
        [
            '<rect x="58" y="708" width="1344" height="64" rx="20" fill="#3f2b08"/>',
            '<text x="730" y="748" text-anchor="middle" class="body" fill="#fbbf24">1 task validates the adapter only. Full score remains locked until all 89 tasks complete on both fresh arms.</text>',
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
    print(json.dumps({"out": str(args.out.resolve()), "status": "valid-smoke-only"}))


if __name__ == "__main__":
    main()
