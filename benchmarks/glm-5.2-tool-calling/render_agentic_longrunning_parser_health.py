#!/usr/bin/env python3
"""Render the score-free agentic long-running parser-health audit."""

from __future__ import annotations

import argparse
import html
import json
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any


MODELS = (
    ("glm52-native", "Native", "#a78bfa"),
    ("glm52-native-plus", "Native-Plus", "#5eead4"),
)


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected an object")
    return value


def fmt_int(value: object) -> str:
    if not isinstance(value, (int, float, str)):
        raise RuntimeError(f"expected a numeric value, found {type(value).__name__}")
    return f"{int(value):,}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--timestamp")
    args = parser.parse_args()

    audit = read_object(args.audit.resolve())
    bridges = {bridge["name"]: bridge for bridge in audit["bridges"]}
    lifecycle = audit["lifecycle"]
    aggregate = audit["aggregate"]
    terminal_name = audit.get("terminalBenchmark")
    if not isinstance(terminal_name, str) or terminal_name not in lifecycle:
        terminal_name = next(
            (
                name
                for name in lifecycle
                if isinstance(name, str) and name.startswith("Terminal-Bench ")
            ),
            "Terminal-Bench 2.x",
        )
    timestamp = args.timestamp or datetime.now().astimezone().strftime(
        "%Y-%m-%d %H:%M %Z"
    )

    suite_names = [str(bridge["name"]) for bridge in audit["bridges"]]
    suite_top = 374
    suite_step = 150
    detail_y = suite_top + len(suite_names) * suite_step + 42
    footer_y = detail_y + 138
    width, height = 1600, footer_y + 66
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">',
        '<rect width="100%" height="100%" rx="32" fill="#05070b"/>',
        "<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:42px;font-weight:780;fill:#f8fafc}.sub{font-size:18px;fill:#94a3b8}.eyebrow{font-size:14px;font-weight:760;letter-spacing:1.4px;fill:#94a3b8}.cardv{font-size:35px;font-weight:800;fill:#f8fafc}.cardl{font-size:15px;fill:#94a3b8}.suite{font-size:23px;font-weight:760;fill:#f8fafc}.name{font-size:16px;font-weight:720}.value{font-size:16px;font-weight:760}.small{font-size:14px;fill:#94a3b8}.ok{font-size:15px;font-weight:730;fill:#6ee7b7}.warn{font-size:15px;font-weight:720;fill:#fbbf24}</style>",
        '<text x="64" y="72" class="title">Full campaign parser health · live fresh evidence</text>',
        f'<text x="64" y="108" class="sub">{esc(timestamp)} · seven fresh suites · score-free bridge audit with agentic lifecycle depth</text>',
    ]
    cards = [
        (
            "NATIVE-PLUS REQUESTS",
            fmt_int(aggregate["nativePlusRequests"]),
            "all seven current fresh suite roots",
            "#0f2f2a",
        ),
        (
            "PARSER PATH",
            fmt_int(aggregate.get("nativePlusParserRecoveryEvents", 0)),
            (
                f"{fmt_int(aggregate.get('nativePlusParserRecoveryEvents', 0))} repaired · "
                f"{fmt_int(aggregate.get('nativePlusUnrecoveredParserEvents', aggregate['nativePlusParserErrors']))} failures · "
                f"{fmt_int(aggregate.get('nativePlusModelOutputPassThroughEvents', 0))} pass-through"
            ),
            (
                "#123425"
                if int(aggregate.get("nativePlusUnrecoveredParserEvents", 0)) == 0
                else "#3f1d22"
            ),
        ),
        (
            "CAPTURE LINKAGE",
            "PASS" if not aggregate["invalidLinkageSuites"] else "FAIL",
            f"{fmt_int(aggregate['requestCount'])} requests · {fmt_int(aggregate['captureCount'])} captures",
            "#123425" if not aggregate["invalidLinkageSuites"] else "#3f1d22",
        ),
        (
            "RESULT STATUS",
            "LOCKED",
            "exact denominator + validators pending",
            "#3f2b08",
        ),
    ]
    for index, (label, value, detail, color) in enumerate(cards):
        x = 64 + index * 372
        parts.extend(
            [
                f'<rect x="{x}" y="142" width="344" height="152" rx="22" fill="{color}"/>',
                f'<text x="{x + 26}" y="178" class="eyebrow">{esc(label)}</text>',
                f'<text x="{x + 26}" y="232" class="cardv">{esc(value)}</text>',
                f'<text x="{x + 26}" y="269" class="cardl">{esc(detail)}</text>',
            ]
        )

    parts.append('<text x="64" y="346" class="eyebrow">ALL LIVE SUITE EVIDENCE</text>')
    for suite_index, suite_name in enumerate(suite_names):
        y = suite_top + suite_index * suite_step
        bridge = bridges[suite_name]
        life = lifecycle.get(suite_name)
        total = int(life["expectedPerArm"]) if isinstance(life, dict) else 0
        linkage = bridge["linkageStatus"]
        parts.extend(
            [
                f'<rect x="64" y="{y}" width="1472" height="126" rx="22" fill="#111827"/>',
                f'<text x="90" y="{y + 34}" class="suite">{esc(suite_name)}</text>',
                f'<text x="1510" y="{y + 31}" text-anchor="end" class="{("ok" if linkage != "invalid" else "warn")}">bridge {esc(linkage)} · {fmt_int(bridge["requestCount"])} requests · {fmt_int(bridge["captureCount"])} captures</text>',
            ]
        )
        for model_index, (model, label, color) in enumerate(MODELS):
            row_y = y + 52 + model_index * 34
            completed = (
                int(life["models"][model]["completedTrajectories"])
                if isinstance(life, dict)
                else None
            )
            model_requests = int(bridge["models"][model]["requests"])
            recoveries = int(
                bridge["models"][model]["parserEventClasses"].get("recovery", 0)
            )
            parser_failures = sum(
                int(bridge["models"][model]["parserEventClasses"].get(key, 0))
                for key in ("parse_failure", "safety_drop", "duplicate", "other")
            )
            model_passthrough = int(
                bridge["models"][model]["parserEventClasses"].get(
                    "model_output_passthrough", 0
                )
            )
            non2xx = int(bridge["models"][model]["non2xx"])
            completion = (
                f" · completed {completed:,}/{total:,}"
                if completed is not None
                else ""
            )
            parts.extend(
                [
                    f'<text x="90" y="{row_y + 21}" class="name" fill="{color}">{label}</text>',
                    f'<text x="230" y="{row_y + 21}" class="value" fill="{color}">{model_requests:,} requests{completion}</text>',
                    f'<text x="1510" y="{row_y + 20}" text-anchor="end" class="small">parser {parser_failures} fail / {recoveries} repaired · pass-through {model_passthrough} · non-2xx {non2xx}</text>',
                ]
            )

    app = lifecycle["AppWorld"]["models"]["glm52-native-plus"]
    vakra = lifecycle["VAKRA"]["models"]["glm52-native-plus"]
    tau = lifecycle["tau3-bench"]["models"]["glm52-native-plus"]
    terminal = lifecycle[terminal_name]["models"]["glm52-native-plus"]
    details = [
        (
            "APPWORLD DEPTH",
            f"{app['totalApiCalls']:,} API calls",
            f"max {app['maxApiCallsPerTrajectory']} API / {app['maxLmCallsPerTrajectory']} LM calls per completed trajectory",
        ),
        (
            "VAKRA LIFECYCLE",
            f"{vakra['totalOutputTurns']:,} output turns",
            f"max {vakra['maxOutputTurns']} output turns · success rows tracked separately from score",
        ),
        (
            "τ³ CONVERSATION",
            f"{tau['totalMessages']:,} messages",
            f"max {tau['maxMessagesPerTrajectory']} messages in one completed trajectory",
        ),
        (
            "TERMINAL TOOL LOOP",
            f"{terminal['totalToolCalls']:,} tool calls",
            f"max {terminal['maxStepsPerTrajectory']} steps / {terminal['maxToolCallsPerTrajectory']} tool calls",
        ),
    ]
    for index, (label, value, detail) in enumerate(details):
        x = 64 + index * 372
        parts.extend(
            [
                f'<rect x="{x}" y="{detail_y}" width="344" height="112" rx="20" fill="#111827"/>',
                f'<text x="{x + 24}" y="{detail_y + 30}" class="eyebrow">{esc(label)}</text>',
                f'<text x="{x + 24}" y="{detail_y + 65}" class="value" fill="#f8fafc">{esc(value)}</text>',
                f'<text x="{x + 24}" y="{detail_y + 91}" class="small">{esc(detail)}</text>',
            ]
        )
    parts.extend(
        [
            f'<rect x="64" y="{footer_y}" width="1472" height="34" rx="17" fill="#3f2b08"/>',
            f'<text x="800" y="{footer_y + 23}" text-anchor="middle" class="warn">PROVISIONAL PARSER-PATH EVIDENCE · FINAL VALIDITY REQUIRES EVERY FULL DENOMINATOR + OFFICIAL VALIDATORS</text>',
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
                "nativePlusParserErrors": aggregate["nativePlusParserErrors"],
                "nativePlusParserRecoveryEvents": aggregate.get(
                    "nativePlusParserRecoveryEvents", 0
                ),
                "nativePlusUnrecoveredParserEvents": aggregate.get(
                    "nativePlusUnrecoveredParserEvents",
                    aggregate["nativePlusParserErrors"],
                ),
                "nativePlusRequests": aggregate["nativePlusRequests"],
                "out": str(args.out.resolve()),
                "status": audit["conclusionGate"]["status"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
