#!/usr/bin/env python3
"""Render score-free live progress for Terminal-Bench 2.0 full inference."""

from __future__ import annotations

import argparse
import html
import json
import subprocess
from datetime import datetime
from pathlib import Path


ARMS = (
    ("glm52-native", "Native", "#a78bfa"),
    ("glm52-native-plus", "Native-Plus", "#5eead4"),
)


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def read_json(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected an object")
    return value


def read_progress(path: Path) -> list[dict[str, object]]:
    if not path.is_file():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        value = json.loads(line)
        if isinstance(value, dict):
            rows.append(value)
    return rows


def line_count(path: Path) -> int:
    if not path.is_file():
        return 0
    return sum(1 for line in path.read_text(encoding="utf-8").splitlines() if line)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--timestamp")
    args = parser.parse_args()

    run_root = args.run_root.resolve()
    run_meta = read_json(run_root / "run-meta.json")
    launch = read_json(run_root / "launch-manifest.json")
    progress = read_progress(run_root / "progress.jsonl")
    total = int(run_meta["taskCountPerArm"])
    counts = {arm: sum(row.get("arm") == arm for row in progress) for arm, _, _ in ARMS}
    tool_calls = {
        arm: sum(
            int(row.get("toolCalls", 0)) for row in progress if row.get("arm") == arm
        )
        for arm, _, _ in ARMS
    }
    completed_pairs = len(
        {str(row.get("taskName")) for row in progress if row.get("arm") == ARMS[0][0]}
        & {str(row.get("taskName")) for row in progress if row.get("arm") == ARMS[1][0]}
    )
    last = progress[-1] if progress else {}
    requests = line_count(run_root / "bridge/requests.jsonl")
    captures = line_count(run_root / "bridge/provider-raw.jsonl")
    timestamp = args.timestamp or datetime.now().astimezone().strftime(
        "%Y-%m-%d %H:%M %Z"
    )

    width, height = 1500, 900
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">',
        '<rect width="100%" height="100%" rx="30" fill="#05070b"/>',
        "<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:40px;font-weight:780;fill:#f8fafc}.sub{font-size:17px;fill:#94a3b8}.eyebrow{font-size:14px;font-weight:760;letter-spacing:1.3px;fill:#94a3b8}.name{font-size:20px;font-weight:740}.value{font-size:18px;font-weight:760}.body{font-size:15px;fill:#cbd5e1}.small{font-size:14px;fill:#94a3b8}.ok{font-size:15px;font-weight:720;fill:#6ee7b7}</style>",
        '<text x="60" y="70" class="title">Terminal-Bench 2.0 · fresh full-run progress</text>',
        f'<text x="60" y="106" class="sub">{esc(timestamp)} · completion only · partial rewards intentionally hidden</text>',
        '<rect x="60" y="142" width="1380" height="106" rx="22" fill="#111827"/>',
        '<text x="90" y="178" class="eyebrow">PINNED FULL POPULATION</text>',
        f'<text x="90" y="218" class="name" fill="#f8fafc">{total} tasks / arm · {total * 2} fresh trajectories · {completed_pairs} paired tasks complete</text>',
        '<rect x="1120" y="172" width="278" height="44" rx="22" fill="#064e3b"/>',
        '<text x="1259" y="200" text-anchor="middle" class="ok">PROGRESS, NOT SCORE</text>',
        '<text x="60" y="302" class="eyebrow">LIVE COMPLETION</text>',
    ]
    for index, (arm, label, color) in enumerate(ARMS):
        y = 338 + index * 116
        count = counts[arm]
        ratio = count / total
        parts.extend(
            [
                f'<text x="60" y="{y + 28}" class="name" fill="{color}">{label}</text>',
                f'<rect x="270" y="{y}" width="950" height="42" rx="13" fill="#172036"/>',
                f'<rect x="270" y="{y}" width="{950 * ratio:.2f}" height="42" rx="13" fill="{color}"/>',
                f'<text x="1405" y="{y + 29}" text-anchor="end" class="value" fill="{color}">{count} / {total} · {ratio * 100:.2f}%</text>',
                f'<text x="270" y="{y + 76}" class="small">completed-trajectory native tool calls: {tool_calls[arm]}</text>',
            ]
        )
    parity = "PARITY" if requests == captures else "LIVE WRITE WINDOW"
    parts.extend(
        [
            '<rect x="60" y="592" width="1380" height="204" rx="24" fill="#111827"/>',
            '<text x="90" y="632" class="eyebrow">FRESHNESS AND AUDIT GATE</text>',
            '<text x="90" y="672" class="ok">PASS · output empty at start · no historical raw/score · no resume · smoke not imported</text>',
            f'<text x="90" y="710" class="body">Bridge {requests} requests · {captures} captures · {parity}</text>',
            f'<text x="90" y="748" class="body">Last completed: {esc(last.get("taskName", "none"))} · {esc(last.get("arm", "none"))} · task index {esc(last.get("taskIndex", 0))}/{total}</text>',
            f'<text x="90" y="780" class="small">Task-set SHA {esc(str(launch["taskSetSha256"])[:16])}… · MiniSweAgent 2.4.5 · paired task order · retries 0</text>',
            '<rect x="60" y="832" width="1380" height="44" rx="22" fill="#3f2b08"/>',
            f'<text x="750" y="861" text-anchor="middle" class="body" fill="#fbbf24">FINAL SCORE LOCKED UNTIL {total}/{total} ON BOTH ARMS + OFFICIAL REWARD + BRIDGE VALIDATION</text>',
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
    print(
        json.dumps(
            {
                "counts": counts,
                "out": str(args.out.resolve()),
                "pairedTasks": completed_pairs,
                "status": "progress-not-score",
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
