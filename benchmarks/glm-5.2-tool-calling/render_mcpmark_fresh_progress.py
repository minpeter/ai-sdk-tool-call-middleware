#!/usr/bin/env python3
"""Render a score-free MCPMark fresh-run audit and progress board."""

from __future__ import annotations

import argparse
import html
import json
import subprocess
from datetime import datetime
from pathlib import Path


ARM_SPECS = (
    ("glm52-native", "Native", "#a78bfa"),
    ("glm52-native-plus", "Native-Plus", "#5eead4"),
)


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def jsonl_rows(path: Path) -> int:
    if not path.is_file():
        return 0
    with path.open(encoding="utf-8") as handle:
        return sum(1 for line in handle if line.strip())


def completed_keys(experiment_root: Path, model: str) -> set[str]:
    keys: set[str] = set()
    for meta_path in experiment_root.glob(f"{model}__*/run-*/**/meta.json"):
        keys.add(meta_path.parent.name)
    return keys


def render(run_root: Path, timestamp: str) -> tuple[str, dict[str, object]]:
    meta = json.loads((run_root / "run-meta.json").read_text(encoding="utf-8"))
    manifest = json.loads((run_root / "task-manifest.json").read_text(encoding="utf-8"))
    experiment = run_root / "official" / meta["experimentName"]
    tasks = manifest["tasks"]
    total = int(manifest["taskCount"])
    service_counts = manifest["counts"]
    expected_services = (
        ("filesystem", "Filesystem", "#60a5fa"),
        ("postgres", "Postgres", "#34d399"),
        ("playwright", "Playwright", "#fbbf24"),
        ("playwright_webarena", "WebArena", "#fb7185"),
        ("github", "GitHub", "#c084fc"),
        ("notion", "Notion", "#f8fafc"),
    )

    arm_rows: list[dict[str, object]] = []
    for model, label, color in ARM_SPECS:
        present = completed_keys(experiment, model)
        by_service: dict[str, int] = {}
        for service, _, _ in expected_services:
            by_service[service] = sum(
                1
                for task in tasks
                if task["service"] == service
                and f"{task['category']}__{task['taskId']}" in present
            )
        arm_rows.append(
            {
                "model": model,
                "label": label,
                "color": color,
                "completed": sum(by_service.values()),
                "byService": by_service,
            }
        )

    requests = jsonl_rows(run_root / "bridge" / "requests.jsonl")
    captures = jsonl_rows(run_root / "bridge" / "provider-raw.jsonl")
    freshness = meta["freshness"]
    official_output_empty = (
        freshness.get("officialOutputEntriesAtStart") == 0
        or freshness.get("emptyOfficialOutputAtStart") is True
    )
    freshness_checks = (
        (
            "Official output empty at start",
            official_output_empty,
        ),
        ("No historical raw input", freshness["historicalRawInput"] is False),
        ("No historical score input", freshness["historicalScoreInput"] is False),
        ("No prior-run resume", freshness["resumeFromPriorRun"] is False),
    )

    width, height = 1600, 1220
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">',
        '<rect width="100%" height="100%" rx="30" fill="#05070b"/>',
        "<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:42px;font-weight:780;fill:#f8fafc}.sub{font-size:18px;fill:#94a3b8}.eyebrow{font-size:14px;font-weight:760;letter-spacing:1.4px;fill:#94a3b8}.big{font-size:58px;font-weight:800}.cardtitle{font-size:21px;font-weight:740;fill:#f8fafc}.body{font-size:16px;fill:#cbd5e1}.small{font-size:14px;fill:#94a3b8}.barlabel{font-size:17px;font-weight:700}.value{font-size:18px;font-weight:760}.ok{font-size:15px;font-weight:700;fill:#6ee7b7}.warn{font-size:15px;font-weight:700;fill:#fbbf24}</style>",
        '<text x="64" y="72" class="title">MCPMark · fresh full-population audit</text>',
        f'<text x="64" y="108" class="sub">{esc(timestamp)} · progress only, never a partial score</text>',
        '<rect x="64" y="142" width="448" height="190" rx="22" fill="#111827"/>',
        '<text x="92" y="176" class="eyebrow">OBSOLETE SUBSET</text>',
        '<text x="92" y="242" class="big" fill="#fb7185">10</text>',
        '<text x="202" y="228" class="cardtitle">tasks</text>',
        '<text x="92" y="286" class="body">Filesystem Easy only</text>',
        '<text x="92" y="314" class="small">Not MCPMark full population</text>',
        '<rect x="576" y="142" width="448" height="190" rx="22" fill="#111827"/>',
        '<text x="604" y="176" class="eyebrow">SUBSET EXECUTION VOLUME</text>',
        '<text x="604" y="242" class="big" fill="#fbbf24">63</text>',
        '<text x="714" y="228" class="cardtitle">model turns</text>',
        '<text x="604" y="286" class="body">Generated while running those 10 tasks</text>',
        '<text x="604" y="314" class="small">Turns are not task count</text>',
        '<rect x="1088" y="142" width="448" height="190" rx="22" fill="#0f2a24" stroke="#34d399" stroke-width="2"/>',
        '<text x="1116" y="176" class="eyebrow">OFFICIAL STANDARD POPULATION</text>',
        f'<text x="1116" y="242" class="big" fill="#5eead4">{total}</text>',
        '<text x="1244" y="228" class="cardtitle">tasks / arm</text>',
        f'<text x="1116" y="286" class="body">{total * 2} brand-new trajectories total</text>',
        '<text x="1116" y="314" class="small">Pinned manifest denominator</text>',
        '<text x="64" y="388" class="eyebrow">OFFICIAL SERVICE BREAKDOWN</text>',
    ]

    service_x = 64
    for service, label, color in expected_services:
        count = int(service_counts[service])
        card_width = 232
        parts.extend(
            [
                f'<rect x="{service_x}" y="412" width="{card_width}" height="108" rx="18" fill="#111827"/>',
                f'<circle cx="{service_x + 28}" cy="443" r="7" fill="{color}"/>',
                f'<text x="{service_x + 44}" y="449" class="body">{esc(label)}</text>',
                f'<text x="{service_x + 28}" y="494" class="value" fill="{color}">{count} tasks</text>',
            ]
        )
        service_x += 248

    parts.append(
        f'<text x="64" y="578" class="eyebrow">LIVE {esc(str(meta["experimentName"]).upper())} COMPLETION</text>'
    )
    for arm_index, arm in enumerate(arm_rows):
        y = 610 + arm_index * 112
        completed = int(arm["completed"])
        ratio = completed / total if total else 0.0
        color = str(arm["color"])
        parts.extend(
            [
                f'<text x="64" y="{y + 26}" class="barlabel" fill="{color}">{esc(arm["label"])}</text>',
                f'<rect x="270" y="{y}" width="1050" height="38" rx="12" fill="#172036"/>',
                f'<rect x="270" y="{y}" width="{1050 * ratio:.2f}" height="38" rx="12" fill="{color}"/>',
                f'<text x="1508" y="{y + 27}" text-anchor="end" class="value" fill="{color}">{completed} / {total} · {ratio * 100:.2f}%</text>',
            ]
        )
        detail = "  ·  ".join(
            f"{label} {arm['byService'][service]}/{service_counts[service]}"
            for service, label, _ in expected_services
        )
        parts.append(f'<text x="270" y="{y + 70}" class="small">{esc(detail)}</text>')

    parts.extend(
        [
            '<rect x="64" y="862" width="1472" height="250" rx="24" fill="#111827"/>',
            '<text x="94" y="902" class="eyebrow">FRESHNESS GATE</text>',
            f'<text x="94" y="946" class="cardtitle">Run {esc(meta["runId"])}</text>',
            f'<text x="94" y="980" class="small">Started {esc(meta["startedAt"])} · benchmark commit {esc(meta["benchmarkCommit"][:12])} · task-set SHA {esc(meta["taskSetSha256"][:12])}</text>',
        ]
    )
    for index, (label, ok) in enumerate(freshness_checks):
        x = 94 + (index % 2) * 650
        y = 1024 + (index // 2) * 42
        marker = "PASS" if ok else "FAIL"
        css = "ok" if ok else "warn"
        parts.append(
            f'<text x="{x}" y="{y}" class="{css}">{marker} · {esc(label)}</text>'
        )
    parity_label = "PARITY" if requests == captures else "LIVE WRITE WINDOW"
    parity_css = "ok" if requests == captures else "warn"
    parts.extend(
        [
            f'<text x="94" y="1092" class="{parity_css}">{parity_label} · bridge requests {requests} · provider captures {captures}</text>',
            '<rect x="64" y="1144" width="1472" height="44" rx="22" fill="#064e3b"/>',
            '<text x="800" y="1173" text-anchor="middle" class="ok">SCORE LOCKED UNTIL 127 / 127 ON BOTH ARMS + STRICT VALIDATOR PASS</text>',
            "</svg>",
        ]
    )
    summary: dict[str, object] = {
        "runId": meta["runId"],
        "taskCountPerArm": total,
        "expectedFreshTrajectories": total * 2,
        "arms": arm_rows,
        "bridgeRequests": requests,
        "providerCaptures": captures,
        "freshnessChecksPassed": all(ok for _, ok in freshness_checks),
    }
    return "\n".join(parts) + "\n", summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--timestamp")
    args = parser.parse_args()
    timestamp = args.timestamp or datetime.now().astimezone().strftime(
        "%Y-%m-%d %H:%M %Z"
    )
    rendered, summary = render(args.run_root, timestamp)
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
    print(json.dumps({"out": str(args.out.resolve()), **summary}, sort_keys=True))


if __name__ == "__main__":
    main()
