#!/usr/bin/env python3
"""Render report-ready GLM-5.2 benchmark visuals from existing local outputs.

This script performs no provider or network calls. The cross-suite chart reads
the committed BFCL, ACE, and MCPMark summaries; the two design diagrams render
the parser and paired-evaluation architecture implemented in this repository.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import math
import re
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"
DEFAULT_OUT = (
    RESULTS
    / "2026-07-17-glm5-native-cross-generate"
    / "charts"
)
BFCL_DIR = RESULTS / "2026-07-17-glm5-native-bfcl-v4-456-generate"
ACE_DIR = RESULTS / "2026-07-17-glm5-native-ace-normal-100-generate"
MCPMARK_DIR = (
    RESULTS
    / "2026-07-17-glm5-native-mcpmark-filesystem-easy-10-generate"
)

NATIVE = "#111827"
GLM5 = "#dc2626"
BLUE = "#2563eb"
CYAN = "#0891b2"
GREEN = "#059669"
AMBER = "#d97706"
RED = "#b91c1c"
INK = "#0f172a"
MUTED = "#475569"
GRID = "#cbd5e1"
PANEL = "#ffffff"
CANVAS = "#f8fafc"


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected an object in {path}")
    return value


def load_first_csv_row(path: Path) -> dict[str, str]:
    with path.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    if len(rows) != 1:
        raise ValueError(f"Expected exactly one paired row in {path}")
    return rows[0]


def by_arm(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result = {str(row["arm"]): row for row in rows}
    if set(result) != {"native", "glm5"}:
        raise ValueError(f"Expected native and glm5 rows, found {sorted(result)}")
    return result


def text_lines(
    x: float,
    y: float,
    lines: list[str],
    css_class: str = "body",
    line_height: int = 24,
    anchor: str = "start",
) -> str:
    tspans = "".join(
        f'<tspan x="{x}" dy="{0 if index == 0 else line_height}">{esc(line)}</tspan>'
        for index, line in enumerate(lines)
    )
    return (
        f'<text x="{x}" y="{y}" text-anchor="{anchor}" '
        f'class="{css_class}">{tspans}</text>'
    )


def box(
    x: int,
    y: int,
    width: int,
    height: int,
    title: str,
    lines: list[str],
    *,
    fill: str = PANEL,
    stroke: str = GRID,
    title_color: str = INK,
    css_class: str = "body",
) -> str:
    body = [
        f'<rect x="{x}" y="{y}" width="{width}" height="{height}" rx="16" '
        f'fill="{fill}" stroke="{stroke}" stroke-width="2" class="shadow"/>',
        f'<text x="{x + 22}" y="{y + 34}" class="box-title" '
        f'fill="{title_color}">{esc(title)}</text>',
    ]
    if lines:
        body.append(text_lines(x + 22, y + 66, lines, css_class, 23))
    return "".join(body)


def arrow_path(path: str, color: str = MUTED, dashed: bool = False) -> str:
    dash = ' stroke-dasharray="8 7"' if dashed else ""
    coordinates = [float(value) for value in re.findall(r"-?\d+(?:\.\d+)?", path)]
    points = list(zip(coordinates[0::2], coordinates[1::2], strict=True))
    if len(points) < 2:
        raise ValueError(f"Arrow path needs at least two points: {path}")
    previous_x, previous_y = points[-2]
    end_x, end_y = points[-1]
    delta_x, delta_y = end_x - previous_x, end_y - previous_y
    length = math.hypot(delta_x, delta_y)
    if length == 0:
        raise ValueError(f"Arrow path has a zero-length final segment: {path}")
    unit_x, unit_y = delta_x / length, delta_y / length
    base_x, base_y = end_x - unit_x * 13, end_y - unit_y * 13
    wing_x, wing_y = -unit_y * 6, unit_x * 6
    arrowhead = (
        f"{end_x},{end_y} "
        f"{base_x + wing_x},{base_y + wing_y} "
        f"{base_x - wing_x},{base_y - wing_y}"
    )
    segments = "".join(
        f'<line x1="{start_x}" y1="{start_y}" x2="{finish_x}" y2="{finish_y}" '
        f'stroke="{color}" stroke-width="3" stroke-linecap="round"{dash}/>'
        for (start_x, start_y), (finish_x, finish_y) in zip(
            points, points[1:]
        )
    )
    return (
        f'{segments}<polygon points="{arrowhead}" fill="{color}"/>'
    )


def svg_document(
    width: int,
    height: int,
    title: str,
    description: str,
    body: str,
) -> str:
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">
  <title id="title">{esc(title)}</title>
  <desc id="desc">{esc(description)}</desc>
  <defs>
    <filter id="shadow" x="-10%" y="-15%" width="120%" height="140%"><feDropShadow dx="0" dy="4" stdDeviation="7" flood-color="#0f172a" flood-opacity="0.09"/></filter>
    <marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#475569"/></marker>
  </defs>
  <rect width="100%" height="100%" fill="{CANVAS}"/>
  <style>
    text{{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Arial,sans-serif;fill:{INK}}}
    .title{{font-family:Arial,sans-serif;font-size:34px;font-weight:700}}
    .subtitle{{font-size:17px;fill:{MUTED}}}
    .section{{font-size:20px;font-weight:800}}
    .box-title{{font-size:17px;font-weight:800}}
    .body{{font-size:14px;fill:{MUTED}}}
    .small{{font-size:12px;fill:#64748b}}
    .label{{font-size:15px;font-weight:700}}
    .value{{font-size:17px;font-weight:800}}
    .metric{{font-size:25px;font-weight:850}}
    .mono{{font-family:"SFMono-Regular",Consolas,monospace;font-size:13px;fill:#334155}}
    .shadow{{filter:url(#shadow)}}
  </style>
  {body}
</svg>
'''


def format_p(value: float) -> str:
    if value < 0.001:
        return f"{value:.2e}"
    return f"{value:.4f}".lstrip("0")


def cross_suite_chart() -> str:
    bfcl = load_json(BFCL_DIR / "summary.json")
    ace = load_json(ACE_DIR / "ace-summary.json")
    mcpmark = load_json(MCPMARK_DIR / "mcpmark-summary.json")
    bfcl_arms = by_arm(bfcl["arms"])
    ace_arms = by_arm(ace["protocols"])
    mcpmark_arms = by_arm(mcpmark["protocols"])
    bfcl_pair = load_first_csv_row(BFCL_DIR / "paired-vs-native.csv")
    ace_pair = load_first_csv_row(ACE_DIR / "ace-paired-vs-native.csv")
    mcpmark_pair = load_first_csv_row(
        MCPMARK_DIR / "mcpmark-paired-vs-native.csv"
    )

    suites = [
        {
            "name": "BFCL v4",
            "scope": "SHA-256 stratified subset · 13 categories",
            "outcome": "strict end-to-end exact match",
            "native": bfcl_arms["native"],
            "glm5": bfcl_arms["glm5"],
            "correct_key": "correct",
            "total_key": "total",
            "rate_key": "endToEndAccuracy",
            "pair": bfcl_pair,
        },
        {
            "name": "ACE Normal",
            "scope": "derived static bilingual subset · 50 EN + 50 ZH",
            "outcome": "strict end-to-end panel accuracy",
            "native": ace_arms["native"],
            "glm5": ace_arms["glm5"],
            "correct_key": "correct",
            "total_key": "eligible",
            "rate_key": "endToEndAccuracy",
            "pair": ace_pair,
        },
        {
            "name": "MCPMark FS Easy",
            "scope": "official 10-task smoke/CI slice · 1 trial",
            "outcome": "official verifier pass",
            "native": mcpmark_arms["native"],
            "glm5": mcpmark_arms["glm5"],
            "correct_key": "passed",
            "total_key": "jobs",
            "rate_key": "passRate",
            "pair": mcpmark_pair,
        },
    ]

    width, height = 1600, 1080
    x0, plot_width = 450, 820
    group_top, group_gap = 245, 235
    content: list[str] = [
        '<text x="64" y="68" class="title">Native vs canonical GLM-5.2: cross-suite outcomes</text>',
        '<text x="64" y="108" class="subtitle">Paired runs, strict end-to-end outcomes. Bars are not pooled across suites.</text>',
        f'<circle cx="1185" cy="70" r="8" fill="{NATIVE}"/><text x="1203" y="76" class="label">Native</text>',
        f'<circle cx="1320" cy="70" r="8" fill="{GLM5}"/><text x="1338" y="76" class="label">Canonical GLM</text>',
        '<rect x="64" y="139" width="1472" height="54" rx="12" fill="#eff6ff" stroke="#bfdbfe"/>',
        '<text x="86" y="173" class="label" fill="#1d4ed8">Read literally: each numerator / denominator is shown; MCPMark is a 10-task smoke slice, not the full benchmark.</text>',
    ]
    for tick in range(0, 101, 20):
        x = x0 + plot_width * tick / 100
        content.append(
            f'<line x1="{x}" y1="208" x2="{x}" y2="905" stroke="#e2e8f0" stroke-width="1"/>'
        )
        content.append(
            f'<text x="{x}" y="226" text-anchor="middle" class="small">{tick}%</text>'
        )

    for index, suite in enumerate(suites):
        top = group_top + index * group_gap
        native = suite["native"]
        glm5 = suite["glm5"]
        native_rate = float(native[suite["rate_key"]])
        glm5_rate = float(glm5[suite["rate_key"]])
        delta = (glm5_rate - native_rate) * 100
        pair = suite["pair"]
        native_correct = int(native[suite["correct_key"]])
        glm5_correct = int(glm5[suite["correct_key"]])
        native_total = int(native[suite["total_key"]])
        glm5_total = int(glm5[suite["total_key"]])
        p_value = float(pair["mcnemarExactP"])
        content.extend(
            [
                f'<rect x="48" y="{top - 30}" width="1488" height="202" rx="18" fill="#ffffff" stroke="#e2e8f0" class="shadow"/>',
                f'<text x="76" y="{top + 3}" class="section">{esc(suite["name"])}</text>',
                f'<text x="76" y="{top + 31}" class="body">{esc(suite["scope"])}</text>',
                f'<text x="76" y="{top + 56}" class="small">Metric: {esc(suite["outcome"])}</text>',
                f'<text x="424" y="{top + 83}" text-anchor="end" class="label">Native</text>',
                f'<text x="424" y="{top + 138}" text-anchor="end" class="label" fill="{GLM5}">Canonical GLM</text>',
            ]
        )
        for row_index, (arm, rate, correct, total, color) in enumerate(
            [
                (native, native_rate, native_correct, native_total, NATIVE),
                (glm5, glm5_rate, glm5_correct, glm5_total, GLM5),
            ]
        ):
            y = top + 59 + row_index * 55
            bar_width = plot_width * rate
            lower = float(arm["lower95"])
            upper = float(arm["upper95"])
            ci_y = y + 39
            content.extend(
                [
                    f'<rect x="{x0}" y="{y}" width="{plot_width}" height="30" rx="8" fill="#e2e8f0"/>',
                    f'<rect x="{x0}" y="{y}" width="{bar_width}" height="30" rx="8" fill="{color}"/>',
                    f'<line x1="{x0 + lower * plot_width}" y1="{ci_y}" x2="{x0 + upper * plot_width}" y2="{ci_y}" stroke="{color}" stroke-width="3"/>',
                    f'<line x1="{x0 + lower * plot_width}" y1="{ci_y - 5}" x2="{x0 + lower * plot_width}" y2="{ci_y + 5}" stroke="{color}" stroke-width="3"/>',
                    f'<line x1="{x0 + upper * plot_width}" y1="{ci_y - 5}" x2="{x0 + upper * plot_width}" y2="{ci_y + 5}" stroke="{color}" stroke-width="3"/>',
                    f'<text x="{x0 + max(bar_width, 6) + 12}" y="{y + 23}" class="value" fill="{color}">{correct}/{total} · {rate * 100:.1f}%</text>',
                ]
            )
        loss = int(pair["conversionLoss"])
        recovery = int(pair["recovery"])
        content.extend(
            [
                f'<text x="1324" y="{top + 27}" class="small">GLM − Native</text>',
                f'<text x="1324" y="{top + 59}" class="metric" fill="{RED}">{delta:+.1f} pp</text>',
                f'<text x="1324" y="{top + 94}" class="body">paired loss {loss}</text>',
                f'<text x="1324" y="{top + 118}" class="body">paired recovery {recovery}</text>',
                f'<text x="1324" y="{top + 148}" class="small">exact McNemar p={format_p(p_value)}</text>',
            ]
        )

    content.extend(
        [
            '<rect x="48" y="956" width="1488" height="82" rx="15" fill="#fff7ed" stroke="#fed7aa"/>',
            '<text x="76" y="989" class="label" fill="#9a3412">No pooled score</text>',
            '<text x="76" y="1016" class="body">BFCL n=456 paired cases/arm; ACE n=100 paired cases/arm; MCPMark n=10 paired jobs/arm. Different tasks, scorers, and sample sizes make a single aggregate percentage misleading.</text>',
        ]
    )
    return svg_document(
        width,
        height,
        "Native versus canonical GLM-5.2 cross-suite outcomes",
        "Strict paired outcomes for BFCL, ACE, and a ten-task MCPMark smoke slice with exact numerators and denominators.",
        "".join(content),
    )


def parser_pipeline_chart() -> str:
    width, height = 1600, 1080
    content: list[str] = [
        '<text x="64" y="68" class="title">Canonical GLM-5.2 parser architecture</text>',
        '<text x="64" y="108" class="subtitle">One grammar, shared parse/coercion core, streaming lifecycle guarantees, and explicit fail-closed limits.</text>',
        box(
            540,
            145,
            520,
            108,
            "Pinned GLM-5.2 tool grammar",
            [
                "Tool schemas rendered in <tools> JSON lines",
                "Calls emitted as <tool_call> + arg_key / arg_value",
            ],
            fill="#eff6ff",
            stroke="#93c5fd",
            title_color="#1d4ed8",
        ),
        box(
            72,
            328,
            310,
            128,
            "Streaming text deltas",
            ["Arbitrary chunk boundaries", "Partial opening tags preserved"],
            fill="#ecfeff",
            stroke="#67e8f9",
            title_color="#0e7490",
        ),
        box(
            425,
            328,
            330,
            128,
            "Boundary-aware buffer",
            ["Flush only proven-safe text", "Active body retained ≤ 1 MiB"],
            fill="#ecfeff",
            stroke="#67e8f9",
            title_color="#0e7490",
        ),
        box(
            798,
            328,
            330,
            128,
            "Incremental close scanner",
            ["Linear scan across chunks", "At most 256 close candidates"],
            fill="#ecfeff",
            stroke="#67e8f9",
            title_color="#0e7490",
        ),
        box(
            1218,
            328,
            310,
            128,
            "Generated text",
            ["Whole-response selection", "Same structural candidate policy"],
            fill="#f5f3ff",
            stroke="#c4b5fd",
            title_color="#6d28d9",
        ),
        box(
            470,
            560,
            660,
            142,
            "Shared parseGlm5CallBody core",
            [
                "Canonical tags + bounded structural recovery",
                "Tool-name resolution and schema-aware value coercion",
                "JSON call-body compatibility without alternate prompt dialect",
            ],
            fill="#ffffff",
            stroke="#94a3b8",
        ),
        box(
            86,
            760,
            385,
            148,
            "Streaming progress",
            [
                "Parse snapshots at geometric length gates",
                "Emit only monotonic JSON-prefix deltas",
                "Always balance start → delta* → end",
            ],
            fill="#f0fdf4",
            stroke="#86efac",
            title_color="#047857",
        ),
        box(
            607,
            760,
            385,
            148,
            "Safety envelope",
            [
                "Reject duplicate / prototype-sensitive keys",
                "Bound nesting, arguments, body, and candidates",
                "Malformed ambiguity fails closed",
            ],
            fill="#fff7ed",
            stroke="#fdba74",
            title_color="#c2410c",
        ),
        box(
            1128,
            760,
            385,
            148,
            "AI SDK output",
            [
                "tool-input-start / delta / end",
                "Final tool-call only after safe stringify",
                "Text outside calls preserved",
            ],
            fill="#f0fdf4",
            stroke="#86efac",
            title_color="#047857",
        ),
        box(
            530,
            955,
            540,
            82,
            "Oversize policy",
            ["Cross 1 MiB → onError once, close lifecycle, clear buffers, poison remainder"],
            fill="#fef2f2",
            stroke="#fca5a5",
            title_color="#b91c1c",
        ),
        arrow_path("M800 253 L800 292 L227 292 L227 328", BLUE),
        arrow_path("M800 253 L800 292 L1373 292 L1373 328", BLUE),
        arrow_path("M382 392 L425 392", CYAN),
        arrow_path("M755 392 L798 392", CYAN),
        arrow_path("M963 456 L963 505 L800 505 L800 560", CYAN),
        arrow_path("M1373 456 L1373 505 L800 505 L800 560", "#7c3aed"),
        arrow_path("M800 702 L800 728 L278 728 L278 760", GREEN),
        arrow_path("M800 702 L800 760", AMBER),
        arrow_path("M800 702 L800 728 L1320 728 L1320 760", GREEN),
        arrow_path("M800 908 L800 955", RED, dashed=True),
        '<text x="64" y="1058" class="small">Source: glm5-prompt.ts, glm5-protocol.ts, glm5-call-parsing.ts, glm5-stream-parser.ts</text>',
    ]
    return svg_document(
        width,
        height,
        "Canonical GLM-5.2 parser architecture",
        "Streaming and non-streaming GLM tool-call paths converge on a bounded, schema-aware parsing core and safe AI SDK lifecycle output.",
        "".join(content),
    )


def paired_design_chart() -> str:
    width, height = 1600, 1120
    content: list[str] = [
        '<text x="64" y="68" class="title">Paired scheduling and validation design</text>',
        '<text x="64" y="108" class="subtitle">Deterministic within-case pairing controls order effects; credential-free captures and matched scorers protect auditability.</text>',
        box(
            62,
            158,
            330,
            128,
            "1 · Stable job identity",
            ["suite / case / trial", "Shared seed + exact identity"],
            fill="#eff6ff",
            stroke="#93c5fd",
            title_color="#1d4ed8",
        ),
        box(
            452,
            158,
            330,
            128,
            "2 · SHA-256 arm order",
            ["hash(seed ␀ identity)", "first byte parity selects order"],
            fill="#eff6ff",
            stroke="#93c5fd",
            title_color="#1d4ed8",
            css_class="mono",
        ),
        box(
            842,
            158,
            330,
            128,
            "3 · One worker batch",
            ["Pair stays together", "Arms run sequentially, not concurrently"],
            fill="#eff6ff",
            stroke="#93c5fd",
            title_color="#1d4ed8",
        ),
        box(
            1232,
            158,
            306,
            128,
            "4 · Symmetric resume",
            ["Both pair rows complete or neither", "Asymmetry aborts the resume"],
            fill="#fff7ed",
            stroke="#fdba74",
            title_color="#c2410c",
        ),
        arrow_path("M392 222 L452 222", BLUE),
        arrow_path("M782 222 L842 222", BLUE),
        arrow_path("M1172 222 L1232 222", BLUE),
        '<rect x="240" y="330" width="1120" height="118" rx="18" fill="#ffffff" stroke="#cbd5e1" class="shadow"/>',
        f'<rect x="282" y="361" width="168" height="52" rx="12" fill="{NATIVE}"/><text x="366" y="394" text-anchor="middle" class="label" fill="#ffffff">Native</text>',
        '<text x="475" y="394" class="metric" fill="#64748b">→</text>',
        f'<rect x="525" y="361" width="202" height="52" rx="12" fill="{GLM5}"/><text x="626" y="394" text-anchor="middle" class="label" fill="#ffffff">Canonical GLM</text>',
        '<text x="800" y="394" text-anchor="middle" class="body">or, for the other hash parity</text>',
        f'<rect x="898" y="361" width="202" height="52" rx="12" fill="{GLM5}"/><text x="999" y="394" text-anchor="middle" class="label" fill="#ffffff">Canonical GLM</text>',
        '<text x="1125" y="394" class="metric" fill="#64748b">→</text>',
        f'<rect x="1175" y="361" width="145" height="52" rx="12" fill="{NATIVE}"/><text x="1248" y="394" text-anchor="middle" class="label" fill="#ffffff">Native</text>',
        box(
            62,
            518,
            360,
            166,
            "Credential-free provider capture",
            [
                "Request body + safe headers only",
                "Raw JSON/SSE response and context",
                "No authorization, token, secret, or query key",
            ],
            fill="#ecfeff",
            stroke="#67e8f9",
            title_color="#0e7490",
        ),
        box(
            472,
            518,
            360,
            166,
            "Capture and row validation",
            [
                "Unique capture IDs + format version",
                "Arm / suite / job / transport linkage",
                "Secret scan + no missing successful captures",
            ],
            fill="#ecfeff",
            stroke="#67e8f9",
            title_color="#0e7490",
        ),
        box(
            882,
            518,
            300,
            166,
            "Suite-specific scorer",
            [
                "BFCL strict exact match",
                "ACE strict + semantic",
                "MCPMark official verifier",
            ],
            fill="#f0fdf4",
            stroke="#86efac",
            title_color="#047857",
        ),
        box(
            1232,
            518,
            306,
            166,
            "Matched pair outcome",
            [
                "Failures count incorrect / failed",
                "No cross-case substitution",
                "One row per arm and identity",
            ],
            fill="#f0fdf4",
            stroke="#86efac",
            title_color="#047857",
        ),
        arrow_path("M422 601 L472 601", CYAN),
        arrow_path("M832 601 L882 601", GREEN),
        arrow_path("M1182 601 L1232 601", GREEN),
        '<rect x="62" y="758" width="940" height="286" rx="18" fill="#ffffff" stroke="#cbd5e1" class="shadow"/>',
        '<text x="90" y="800" class="section">Exact paired comparison (McNemar)</text>',
        '<text x="90" y="832" class="body">Only discordant matched outcomes determine the exact two-sided p-value.</text>',
        '<rect x="378" y="864" width="270" height="58" fill="#f1f5f9" stroke="#cbd5e1"/>',
        '<rect x="648" y="864" width="270" height="58" fill="#f1f5f9" stroke="#cbd5e1"/>',
        '<text x="513" y="899" text-anchor="middle" class="label">GLM correct</text>',
        '<text x="783" y="899" text-anchor="middle" class="label">GLM incorrect</text>',
        '<rect x="108" y="922" width="270" height="58" fill="#f1f5f9" stroke="#cbd5e1"/>',
        '<rect x="108" y="980" width="270" height="58" fill="#f1f5f9" stroke="#cbd5e1"/>',
        '<text x="243" y="957" text-anchor="middle" class="label">Native correct</text>',
        '<text x="243" y="1015" text-anchor="middle" class="label">Native incorrect</text>',
        '<rect x="378" y="922" width="270" height="58" fill="#f0fdf4" stroke="#86efac"/>',
        '<rect x="648" y="922" width="270" height="58" fill="#fef2f2" stroke="#fca5a5"/>',
        '<rect x="378" y="980" width="270" height="58" fill="#eff6ff" stroke="#93c5fd"/>',
        '<rect x="648" y="980" width="270" height="58" fill="#f0fdf4" stroke="#86efac"/>',
        '<text x="513" y="957" text-anchor="middle" class="body">both correct</text>',
        '<text x="783" y="957" text-anchor="middle" class="label" fill="#b91c1c">conversion loss</text>',
        '<text x="513" y="1015" text-anchor="middle" class="label" fill="#1d4ed8">recovery</text>',
        '<text x="783" y="1015" text-anchor="middle" class="body">both incorrect</text>',
        '<rect x="1044" y="758" width="494" height="286" rx="18" fill="#fff7ed" stroke="#fdba74" class="shadow"/>',
        '<text x="1074" y="800" class="section" fill="#9a3412">Observed paired denominators</text>',
        '<text x="1074" y="845" class="value">BFCL</text><text x="1494" y="845" text-anchor="end" class="value">456 pairs</text>',
        '<text x="1074" y="889" class="value">ACE Normal</text><text x="1494" y="889" text-anchor="end" class="value">100 pairs</text>',
        '<text x="1074" y="933" class="value">MCPMark FS Easy</text><text x="1494" y="933" text-anchor="end" class="value">10 pairs</text>',
        '<line x1="1074" y1="958" x2="1494" y2="958" stroke="#fdba74"/>',
        '<text x="1074" y="989" class="body">Report each suite separately.</text>',
        '<text x="1074" y="1015" class="body">Never turn unequal scorers into one pooled rate.</text>',
        '<text x="64" y="1092" class="small">Source: paired-scheduling.ts, run.ts, run-ace.ts, run-mcpmark.ts, validate_provider_capture.py, suite analyzers</text>',
    ]
    return svg_document(
        width,
        height,
        "Paired scheduling and validation design",
        "Native and canonical GLM arms are deterministically ordered within the same case batch, validated through credential-free captures, and compared with exact matched-pair statistics.",
        "".join(content),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    visuals = {
        "native-vs-glm5-cross-suite.svg": cross_suite_chart(),
        "glm5-parser-pipeline.svg": parser_pipeline_chart(),
        "paired-scheduling-validation.svg": paired_design_chart(),
    }
    for name, content in visuals.items():
        path = args.out_dir / name
        path.write_text(content, encoding="utf-8")
        print(f"Wrote {path}")


if __name__ == "__main__":
    main()
