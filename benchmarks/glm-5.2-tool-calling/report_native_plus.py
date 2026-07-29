#!/usr/bin/env python3
"""Build an offline Native versus Native-Plus cross-suite report.

The report is intentionally separate from the earlier Canonical GLM report.
It reads already-scored BFCL/ACE outputs and already-verified MCPMark outputs;
it never makes provider or network calls.  Native-Plus is described as the
hybrid, repair-only arm throughout the generated artifacts.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

from render_svg_charts import render


NATIVE_COLOR = "#111827"
PLUS_COLOR = "#dc2626"
WIN_COLOR = "#059669"
LOSS_COLOR = "#dc2626"
GRID_COLOR = "#cbd5e1"
MUTED_COLOR = "#475569"
CANVAS_COLOR = "#f8fafc"
PANEL_COLOR = "#ffffff"

DEFAULT_PLUS_LABEL = "Native-Plus (hybrid, repair-only)"
SUITE_ORDER = ("BFCL", "ACE", "MCPMark")
SUMMARY_FILENAMES = {
    "BFCL": "summary.json",
    "ACE": "ace-summary.json",
    "MCPMark": "mcpmark-summary.json",
}
ROW_FILENAMES = {
    "BFCL": "scored.jsonl",
    "ACE": "scored.jsonl",
    "MCPMark": "raw.jsonl",
}
SUITE_DISPLAY_NAMES = {
    "BFCL": "BFCL v4",
    "ACE": "ACE Normal",
    "MCPMark": "MCPMark Easy",
}


def escape(value: Any) -> str:
    return html.escape(str(value), quote=True)


def load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"Required input does not exist: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object in {path}")
    return value


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise FileNotFoundError(f"Required input does not exist: {path}")
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"Row {line_number} in {path} is not an object")
            rows.append(value)
    if not rows:
        raise ValueError(f"No rows found in {path}")
    return rows


def numeric(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def integer(value: Any, field: str) -> int:
    parsed = numeric(value)
    if parsed is None or parsed < 0 or not parsed.is_integer():
        raise ValueError(f"Expected a non-negative integer for {field}, got {value!r}")
    return int(parsed)


def mean(values: Iterable[float]) -> float | None:
    materialized = list(values)
    return None if not materialized else sum(materialized) / len(materialized)


def quantile(values: Iterable[float], probability: float) -> float | None:
    ordered = sorted(values)
    if not ordered:
        return None
    index = (len(ordered) - 1) * probability
    lower = math.floor(index)
    upper = math.ceil(index)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] * (upper - index) + ordered[upper] * (index - lower)


def wilson(successes: int, total: int) -> tuple[float | None, float | None]:
    if total == 0:
        return None, None
    z = 1.959963984540054
    proportion = successes / total
    denominator = 1 + z**2 / total
    center = (proportion + z**2 / (2 * total)) / denominator
    margin = (z / denominator) * math.sqrt(
        proportion * (1 - proportion) / total + z**2 / (4 * total**2)
    )
    return center - margin, center + margin


def exact_two_sided_mcnemar(losses: int, wins: int) -> float:
    discordant = losses + wins
    if discordant == 0:
        return 1.0
    tail_limit = min(losses, wins)
    tail = sum(math.comb(discordant, index) for index in range(tail_limit + 1))
    return min(1.0, 2 * tail / (2**discordant))


def summary_rows(suite: str, summary: dict[str, Any]) -> list[dict[str, Any]]:
    field = "arms" if suite == "BFCL" else "protocols"
    value = summary.get(field)
    if not isinstance(value, list) or not all(isinstance(row, dict) for row in value):
        raise ValueError(f"{suite} summary must contain an object array at {field!r}")
    return value


def find_arm_summary(
    suite: str, summary: dict[str, Any], arm: str
) -> dict[str, Any]:
    matches = [row for row in summary_rows(suite, summary) if row.get("arm") == arm]
    if len(matches) != 1:
        observed = sorted(
            str(row.get("arm")) for row in summary_rows(suite, summary)
        )
        raise ValueError(
            f"Expected exactly one {suite} summary row for {arm!r}; "
            f"observed arms: {observed}"
        )
    return matches[0]


def selected_rows(
    rows: list[dict[str, Any]], native_arm: str, plus_arm: str
) -> list[dict[str, Any]]:
    selected = [row for row in rows if row.get("arm") in {native_arm, plus_arm}]
    observed = {str(row.get("arm")) for row in selected}
    expected = {native_arm, plus_arm}
    if observed != expected:
        raise ValueError(
            f"Expected raw/scored rows for {sorted(expected)}, found {sorted(observed)}"
        )
    return selected


def pair_key(suite: str, row: dict[str, Any]) -> tuple[str, ...]:
    trial = str(row.get("trial", 1))
    if suite == "BFCL":
        return (str(row.get("category", "")), str(row["caseId"]), trial)
    if suite == "ACE":
        return (
            str(row.get("language", "")),
            str(row.get("category", "")),
            str(row["caseId"]),
            trial,
        )
    return (str(row["taskId"]), trial)


def eligible_for_pair(suite: str, row: dict[str, Any]) -> bool:
    return suite != "ACE" or row.get("benchmarkItemValid") is not False


def row_outcome(suite: str, row: dict[str, Any]) -> bool:
    if suite in {"BFCL", "ACE"}:
        return bool(row.get("strictCorrect"))
    return bool(row.get("verificationPassed"))


def paired_summary(
    suite: str,
    rows: list[dict[str, Any]],
    native_arm: str,
    plus_arm: str,
) -> dict[str, Any]:
    by_arm: dict[str, dict[tuple[str, ...], dict[str, Any]]] = {
        native_arm: {},
        plus_arm: {},
    }
    for row in selected_rows(rows, native_arm, plus_arm):
        if not eligible_for_pair(suite, row):
            continue
        arm = str(row["arm"])
        key = pair_key(suite, row)
        if key in by_arm[arm]:
            raise ValueError(f"Duplicate {suite} row for arm={arm!r}, key={key!r}")
        by_arm[arm][key] = row
    native_keys = set(by_arm[native_arm])
    plus_keys = set(by_arm[plus_arm])
    if native_keys != plus_keys:
        native_only = sorted(native_keys - plus_keys)[:3]
        plus_only = sorted(plus_keys - native_keys)[:3]
        raise ValueError(
            f"Unpaired {suite} inputs: native-only={native_only}, plus-only={plus_only}"
        )
    if not native_keys:
        raise ValueError(f"No eligible paired {suite} rows")

    both_pass = 0
    both_fail = 0
    losses = 0
    wins = 0
    for key in sorted(native_keys):
        native_pass = row_outcome(suite, by_arm[native_arm][key])
        plus_pass = row_outcome(suite, by_arm[plus_arm][key])
        if native_pass and plus_pass:
            both_pass += 1
        elif native_pass:
            losses += 1
        elif plus_pass:
            wins += 1
        else:
            both_fail += 1
    return {
        "comparable": len(native_keys),
        "bothPass": both_pass,
        "bothFail": both_fail,
        "wins": wins,
        "losses": losses,
        "ties": both_pass + both_fail,
        "netWins": wins - losses,
        "discordant": wins + losses,
        "mcnemarExactP": exact_two_sided_mcnemar(losses, wins),
    }


def direct_usage(row: dict[str, Any]) -> tuple[float | None, float | None, float | None]:
    usage = row.get("usage")
    if not isinstance(usage, dict):
        return None, None, None
    input_tokens = numeric(usage.get("inputTokens"))
    output_tokens = numeric(usage.get("outputTokens"))
    total_tokens = numeric(usage.get("totalTokens"))
    if total_tokens is None and input_tokens is not None and output_tokens is not None:
        total_tokens = input_tokens + output_tokens
    return input_tokens, output_tokens, total_tokens


def mcp_usage(row: dict[str, Any]) -> tuple[float | None, float | None, float | None]:
    inputs = 0.0
    outputs = 0.0
    totals = 0.0
    input_seen = False
    output_seen = False
    total_seen = False
    attempts = row.get("attempts")
    if not isinstance(attempts, list):
        return None, None, None
    for attempt in attempts:
        if not isinstance(attempt, dict):
            continue
        item_input, item_output, item_total = direct_usage(attempt)
        if item_input is not None:
            inputs += item_input
            input_seen = True
        if item_output is not None:
            outputs += item_output
            output_seen = True
        if item_total is not None:
            totals += item_total
            total_seen = True
    return (
        inputs if input_seen else None,
        outputs if output_seen else None,
        totals if total_seen else None,
    )


def observed_efficiency(
    suite: str, rows: list[dict[str, Any]], arm: str
) -> dict[str, Any]:
    arm_rows = [
        row
        for row in rows
        if row.get("arm") == arm and eligible_for_pair(suite, row)
    ]
    usages = [mcp_usage(row) if suite == "MCPMark" else direct_usage(row) for row in arm_rows]
    input_values = [value[0] for value in usages if value[0] is not None]
    output_values = [value[1] for value in usages if value[1] is not None]
    total_values = [value[2] for value in usages if value[2] is not None]
    latency_field = "jobLatencyMs" if suite == "MCPMark" else "latencyMs"
    latencies = [
        value
        for row in arm_rows
        if (value := numeric(row.get(latency_field))) is not None
    ]
    return {
        "latencyP50Ms": quantile(latencies, 0.5),
        "latencyP95Ms": quantile(latencies, 0.95),
        "inputTokensMean": mean(input_values),
        "outputTokensMean": mean(output_values),
        "totalTokensMean": mean(total_values),
        "tokenRows": len(total_values),
        "latencyRows": len(latencies),
    }


def outcome_summary(suite: str, row: dict[str, Any]) -> dict[str, Any]:
    if suite == "BFCL":
        correct = integer(row.get("correct"), "BFCL correct")
        total = integer(row.get("total"), "BFCL total")
    elif suite == "ACE":
        correct = integer(row.get("correct"), "ACE correct")
        total = integer(row.get("eligible"), "ACE eligible")
    else:
        correct = integer(row.get("passed"), "MCPMark passed")
        total = integer(row.get("jobs"), "MCPMark jobs")
    if correct > total:
        raise ValueError(f"{suite} correct/pass count exceeds total: {correct}/{total}")
    lower, upper = wilson(correct, total)
    return {
        "correct": correct,
        "total": total,
        "rate": None if total == 0 else correct / total,
        "lower95": lower,
        "upper95": upper,
    }


def explicit_cost_usd(suite: str, row: dict[str, Any]) -> float | None:
    """Return only an explicitly supplied USD cost; never derive it from tokens."""

    candidates = (
        "costUsd",
        "costUSD",
        "totalCostUsd",
        "totalCostUSD",
    )
    for field in candidates:
        value = numeric(row.get(field))
        if value is not None:
            return value
    # MCPMark summaries sometimes nest externally supplied accounting.  The
    # field still has to state USD explicitly; pricing is never guessed.
    accounting = row.get("accounting")
    if isinstance(accounting, dict):
        for field in candidates:
            value = numeric(accounting.get(field))
            if value is not None:
                return value
    return None


def generic_failure(suite: str, row: dict[str, Any]) -> str:
    if row_outcome(suite, row):
        return "passed"
    if suite == "MCPMark":
        attempts = row.get("attempts")
        final_attempt = attempts[-1] if isinstance(attempts, list) and attempts else None
        failures = final_attempt.get("failures") if isinstance(final_attempt, dict) else None
        stages = {
            str(item.get("stage"))
            for item in failures or []
            if isinstance(item, dict) and item.get("stage")
        }
        for stage in (
            "setup",
            "provider",
            "attempt_timeout",
            "parser",
            "mcp",
            "turn_limit",
            "verification",
        ):
            if stage in stages:
                return stage
        return "unknown"
    if not bool(row.get("transportOk", True)):
        return "provider"
    if not bool(row.get("callShapeValid", True)) or row.get("parserErrors"):
        return "malformed"
    if bool(row.get("textLeak")):
        return "textLeak"
    if suite == "ACE" and bool(row.get("argumentBoundaryWhitespace")):
        return "argumentWhitespace"
    error_type = str(row.get("scoreErrorType") or "otherSemantic")
    return error_type.split(":", 1)[0] or "otherSemantic"


def failure_counts(
    suite: str,
    summary: dict[str, Any],
    rows: list[dict[str, Any]],
    arm: str,
) -> dict[str, int]:
    field = "failureTaxonomy" if suite == "BFCL" else "failures"
    taxonomy = summary.get(field)
    if isinstance(taxonomy, list):
        match = [item for item in taxonomy if isinstance(item, dict) and item.get("arm") == arm]
        if len(match) == 1:
            return {
                str(name): int(value)
                for name, value in match[0].items()
                if name != "arm" and numeric(value) is not None and int(value) > 0
            }
    if suite == "MCPMark":
        protocol = find_arm_summary(suite, summary, arm)
        outcomes = protocol.get("primaryOutcomeCounts")
        if isinstance(outcomes, dict):
            return {
                str(name): int(value)
                for name, value in outcomes.items()
                if name != "passed" and numeric(value) is not None and int(value) > 0
            }
    counts = Counter(
        generic_failure(suite, row)
        for row in rows
        if row.get("arm") == arm and eligible_for_pair(suite, row)
    )
    counts.pop("passed", None)
    return dict(sorted(counts.items()))


def svg_document(width: int, height: int, title: str, body: str) -> str:
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="chart-title">
  <title id="chart-title">{escape(title)}</title>
  <rect width="100%" height="100%" fill="{CANVAS_COLOR}"/>
  <style>
    text{{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Arial,sans-serif;fill:#0f172a}}
    .title{{font-size:29px;font-weight:800}}.subtitle{{font-size:14px;fill:{MUTED_COLOR}}}
    .section{{font-size:18px;font-weight:800}}.label{{font-size:14px;font-weight:650}}
    .small{{font-size:12px;fill:{MUTED_COLOR}}}.value{{font-size:14px;font-weight:800}}
    .grid{{stroke:{GRID_COLOR};stroke-width:1}}.panel{{fill:{PANEL_COLOR};stroke:#e2e8f0;stroke-width:1}}
  </style>
  {body}
</svg>
'''


def accuracy_chart(suites: list[dict[str, Any]], plus_label: str) -> str:
    width, height = 1600, 820
    left, chart_width = 340, 780
    top, group_gap = 190, 180
    lines = [
        '<text x="48" y="54" class="title">Native vs Native-Plus: three-suite outcomes</text>',
        f'<text x="48" y="84" class="subtitle">{escape(plus_label)} · paired end-to-end outcomes · no pooled score</text>',
        f'<circle cx="1035" cy="54" r="7" fill="{NATIVE_COLOR}"/><text x="1050" y="59" class="label">Native</text>',
        f'<circle cx="1165" cy="54" r="7" fill="{PLUS_COLOR}"/><text x="1180" y="59" class="label">Native-Plus</text>',
        '<rect x="48" y="108" width="1504" height="48" rx="10" fill="#eff6ff" stroke="#bfdbfe"/>',
        '<text x="70" y="138" class="label">MCPMark is reported as its own 10-task panel when n=10; percentages are never pooled across suites.</text>',
    ]
    bottom = top + len(suites) * group_gap - 35
    for tick in range(0, 101, 20):
        x = left + chart_width * tick / 100
        lines.append(f'<line x1="{x}" y1="{top - 20}" x2="{x}" y2="{bottom}" class="grid"/>')
        lines.append(f'<text x="{x}" y="{bottom + 28}" text-anchor="middle" class="small">{tick}%</text>')
    for index, suite in enumerate(suites):
        y = top + index * group_gap
        n = suite["pair"]["comparable"]
        scope = "10-task panel" if suite["suite"] == "MCPMark" and n == 10 else "paired cases"
        lines.extend(
            [
                f'<text x="54" y="{y + 18}" class="section">{escape(suite["displayName"])}</text>',
                f'<text x="54" y="{y + 43}" class="small">n={n} {scope}</text>',
            ]
        )
        for row_index, arm in enumerate(suite["arms"]):
            bar_y = y + row_index * 60
            rate = float(arm["rate"] or 0)
            low = float(arm["lower95"] or 0)
            high = float(arm["upper95"] or 0)
            color = NATIVE_COLOR if arm["armRole"] == "native" else PLUS_COLOR
            label = "Native" if arm["armRole"] == "native" else "Native-Plus"
            lines.extend(
                [
                    f'<text x="{left - 18}" y="{bar_y + 24}" text-anchor="end" class="label">{label}</text>',
                    f'<rect x="{left}" y="{bar_y + 4}" width="{chart_width}" height="28" rx="7" fill="#e2e8f0"/>',
                    f'<rect x="{left}" y="{bar_y + 4}" width="{rate * chart_width}" height="28" rx="7" fill="{color}"/>',
                    f'<line x1="{left + low * chart_width}" y1="{bar_y + 39}" x2="{left + high * chart_width}" y2="{bar_y + 39}" stroke="{color}" stroke-width="3"/>',
                    f'<line x1="{left + low * chart_width}" y1="{bar_y + 34}" x2="{left + low * chart_width}" y2="{bar_y + 44}" stroke="{color}" stroke-width="3"/>',
                    f'<line x1="{left + high * chart_width}" y1="{bar_y + 34}" x2="{left + high * chart_width}" y2="{bar_y + 44}" stroke="{color}" stroke-width="3"/>',
                    f'<text x="{left + chart_width + 18}" y="{bar_y + 24}" class="value" fill="{color}">{arm["correct"]}/{arm["total"]} · {rate * 100:.1f}%</text>',
                ]
            )
        delta = (
            float(suite["arms"][1]["rate"] or 0)
            - float(suite["arms"][0]["rate"] or 0)
        ) * 100
        lines.append(
            f'<text x="1390" y="{y + 82}" class="value" fill="{PLUS_COLOR}">Δ {delta:+.1f} pp</text>'
        )
    return svg_document(width, height, "Native vs Native-Plus three-suite outcomes", "".join(lines))


def paired_chart(suites: list[dict[str, Any]], plus_label: str) -> str:
    width, height = 1420, 630
    center, half_width = 700, 360
    top, row_gap = 170, 105
    max_change = max(
        [
            int(suite["pair"][field])
            for suite in suites
            for field in ("wins", "losses")
        ]
        or [1]
    )
    scale = half_width / max(1, max_change)
    lines = [
        '<text x="48" y="54" class="title">Paired wins and losses versus Native</text>',
        f'<text x="48" y="84" class="subtitle">{escape(plus_label)} · exact McNemar test on discordant end-to-end outcomes</text>',
        f'<line x1="{center}" y1="130" x2="{center}" y2="520" stroke="#0f172a" stroke-width="2"/>',
        f'<text x="{center - half_width / 2}" y="120" text-anchor="middle" class="label">Loss: Native pass → Plus fail</text>',
        f'<text x="{center + half_width / 2}" y="120" text-anchor="middle" class="label">Win: Native fail → Plus pass</text>',
    ]
    for index, suite in enumerate(suites):
        pair = suite["pair"]
        y = top + index * row_gap
        loss_width = pair["losses"] * scale
        win_width = pair["wins"] * scale
        lines.extend(
            [
                f'<text x="230" y="{y + 28}" text-anchor="end" class="section">{escape(suite["displayName"])}</text>',
                f'<text x="230" y="{y + 50}" text-anchor="end" class="small">n={pair["comparable"]}</text>',
                f'<rect x="{center - loss_width}" y="{y + 4}" width="{loss_width}" height="34" rx="5" fill="{LOSS_COLOR}"/>',
                f'<rect x="{center}" y="{y + 4}" width="{win_width}" height="34" rx="5" fill="{WIN_COLOR}"/>',
                f'<text x="{center - loss_width - 10}" y="{y + 28}" text-anchor="end" class="value">−{pair["losses"]}</text>',
                f'<text x="{center + win_width + 10}" y="{y + 28}" class="value">+{pair["wins"]}</text>',
                f'<text x="{center + half_width + 24}" y="{y + 21}" class="label">net {pair["netWins"]:+d}</text>',
                f'<text x="{center + half_width + 24}" y="{y + 44}" class="small">ties {pair["ties"]} · p={pair["mcnemarExactP"]:.4g}</text>',
            ]
        )
    lines.extend(
        [
            '<rect x="48" y="548" width="1324" height="48" rx="10" fill="#fff7ed" stroke="#fed7aa"/>',
            '<text x="70" y="578" class="label">A win repairs a Native miss; a loss regresses a Native success. Zero-width bars are labeled explicitly.</text>',
        ]
    )
    return svg_document(width, height, "Paired Native-Plus changes", "".join(lines))


def format_compact(value: float | None, unit: str) -> str:
    if value is None:
        return "n/a"
    if unit == "tokens" and value >= 1000:
        return f"{value / 1000:.1f}k"
    if unit == "ms":
        return f"{value / 1000:.2f}s"
    return f"{value:.0f}"


def efficiency_chart(suites: list[dict[str, Any]], plus_label: str) -> str:
    width, height = 1750, 900
    left, panel_width, panel_gap = 230, 500, 240
    top, row_gap = 185, 210
    lines = [
        '<text x="48" y="54" class="title">Latency and observed token footprint</text>',
        f'<text x="48" y="84" class="subtitle">{escape(plus_label)} · p50 bars with p95 markers · tokens are observed usage, never converted to cost</text>',
        f'<text x="{left}" y="130" class="section">End-to-end latency</text>',
        f'<text x="{left + panel_width + panel_gap}" y="130" class="section">Mean tokens per case/job</text>',
    ]
    for suite_index, suite in enumerate(suites):
        y = top + suite_index * row_gap
        latency_max = max(
            float(arm["latencyP95Ms"] or 0) for arm in suite["arms"]
        )
        token_max = max(
            float(arm["totalTokensMean"] or 0) for arm in suite["arms"]
        )
        latency_scale = panel_width / (latency_max * 1.08 if latency_max > 0 else 1)
        token_scale = panel_width / (token_max * 1.08 if token_max > 0 else 1)
        lines.extend(
            [
                f'<rect x="48" y="{y - 36}" width="1654" height="174" rx="14" class="panel"/>',
                f'<text x="70" y="{y - 6}" class="section">{escape(suite["displayName"])}</text>',
                f'<text x="70" y="{y + 18}" class="small">n={suite["pair"]["comparable"]}</text>',
            ]
        )
        for arm_index, arm in enumerate(suite["arms"]):
            bar_y = y + arm_index * 62
            role = arm["armRole"]
            color = NATIVE_COLOR if role == "native" else PLUS_COLOR
            label = "Native" if role == "native" else "Native-Plus"
            p50 = float(arm["latencyP50Ms"] or 0)
            p95 = float(arm["latencyP95Ms"] or 0)
            inputs = float(arm["inputTokensMean"] or 0)
            outputs = float(arm["outputTokensMean"] or 0)
            total = float(arm["totalTokensMean"] or 0)
            token_x = left + panel_width + panel_gap
            lines.extend(
                [
                    f'<text x="{left - 16}" y="{bar_y + 24}" text-anchor="end" class="label">{label}</text>',
                    f'<rect x="{left}" y="{bar_y + 5}" width="{p95 * latency_scale}" height="28" rx="6" fill="{color}" opacity="0.20"/>',
                    f'<rect x="{left}" y="{bar_y + 5}" width="{p50 * latency_scale}" height="28" rx="6" fill="{color}"/>',
                    f'<line x1="{left + p95 * latency_scale}" y1="{bar_y + 1}" x2="{left + p95 * latency_scale}" y2="{bar_y + 38}" stroke="{color}" stroke-width="3"/>',
                    f'<text x="{left + panel_width + 8}" y="{bar_y + 24}" class="small">p50 {format_compact(arm["latencyP50Ms"], "ms")} · p95 {format_compact(arm["latencyP95Ms"], "ms")}</text>',
                    f'<rect x="{token_x}" y="{bar_y + 5}" width="{inputs * token_scale}" height="28" rx="6" fill="{color}"/>',
                    f'<rect x="{token_x + inputs * token_scale}" y="{bar_y + 5}" width="{outputs * token_scale}" height="28" fill="#f59e0b"/>',
                    f'<text x="{token_x + panel_width + 8}" y="{bar_y + 24}" class="small">{format_compact(total, "tokens")} total</text>',
                ]
            )
    lines.extend(
        [
            f'<rect x="1400" y="107" width="6" height="12" fill="{NATIVE_COLOR}"/><rect x="1406" y="107" width="6" height="12" fill="{PLUS_COLOR}"/><text x="1420" y="118" class="small">input (arm color)</text>',
            '<rect x="1555" y="107" width="12" height="12" fill="#f59e0b"/><text x="1575" y="118" class="small">output tokens</text>',
            '<text x="48" y="872" class="small">Each suite uses its own horizontal scale so MCPMark multi-turn jobs do not visually flatten BFCL/ACE. Missing usage remains missing.</text>',
        ]
    )
    return svg_document(width, height, "Latency and token comparison", "".join(lines))


def flatten_rows(suites: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for suite in suites:
        pair = suite["pair"]
        for arm in suite["arms"]:
            is_plus = arm["armRole"] == "native_plus"
            output.append(
                {
                    "suite": suite["suite"],
                    "suiteLabel": suite["displayName"],
                    "arm": arm["arm"],
                    "armRole": arm["armRole"],
                    "armLabel": arm["armLabel"],
                    "correctOrPassed": arm["correct"],
                    "total": arm["total"],
                    "endToEndRate": arm["rate"],
                    "lower95": arm["lower95"],
                    "upper95": arm["upper95"],
                    "latencyP50Ms": arm["latencyP50Ms"],
                    "latencyP95Ms": arm["latencyP95Ms"],
                    "inputTokensMean": arm["inputTokensMean"],
                    "outputTokensMean": arm["outputTokensMean"],
                    "totalTokensMean": arm["totalTokensMean"],
                    "tokenRows": arm["tokenRows"],
                    "explicitCostUsd": arm["explicitCostUsd"],
                    "pairedComparable": pair["comparable"] if is_plus else None,
                    "pairedWins": pair["wins"] if is_plus else None,
                    "pairedLosses": pair["losses"] if is_plus else None,
                    "pairedTies": pair["ties"] if is_plus else None,
                    "pairedNetWins": pair["netWins"] if is_plus else None,
                    "mcnemarExactP": pair["mcnemarExactP"] if is_plus else None,
                }
            )
    return output


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def format_percent(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:.1f}%"


def format_number(value: float | None, digits: int = 0) -> str:
    if value is None:
        return "—"
    return f"{value:,.{digits}f}"


def top_failures(failures: dict[str, int]) -> str:
    observed = sorted(failures.items(), key=lambda item: (-item[1], item[0]))
    return ", ".join(f"{name} {count}" for name, count in observed[:4]) or "없음"


def notion_markdown(study: dict[str, Any]) -> str:
    suites = study["suites"]
    lines = [
        "# Native vs Native-Plus 교차 벤치마크 요약",
        "",
        f"프로토콜: **{study['nativePlusLabel']}**. Provider-native 구조화 호출을 우선 보존하고, "
        "bounded repair를 적용하는 하이브리드 repair-only 비교군이다.",
        "",
        "## 결과",
        "",
        "| Suite | Native | Native-Plus | Δ | Plus 승/패 | Exact p |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for suite in suites:
        native, plus = suite["arms"]
        delta = (float(plus["rate"] or 0) - float(native["rate"] or 0)) * 100
        lines.append(
            f"| {suite['displayName']} (n={suite['pair']['comparable']}) "
            f"| {native['correct']}/{native['total']} ({format_percent(native['rate'])}) "
            f"| {plus['correct']}/{plus['total']} ({format_percent(plus['rate'])}) "
            f"| {delta:+.1f} pp | {suite['pair']['wins']}/{suite['pair']['losses']} "
            f"| {suite['pair']['mcnemarExactP']:.4g} |"
        )
    lines.extend(
        [
            "",
            "> Suite마다 과제·채점기·표본 수가 다르므로 pooled accuracy는 계산하지 않았다. "
            "MCPMark n=10이면 공식 전체 벤치마크가 아닌 10-task 패널로 해석한다.",
            "",
            "## 실패·지연·토큰",
            "",
            "| Suite / arm | 주요 실패(최대 4종) | p50 / p95 | 평균 input / output / total tokens |",
            "|---|---|---:|---:|",
        ]
    )
    for suite in suites:
        for arm in suite["arms"]:
            label = "Native" if arm["armRole"] == "native" else "Native-Plus"
            lines.append(
                f"| {suite['displayName']} / {label} | {top_failures(arm['failures'])} "
                f"| {format_number(arm['latencyP50Ms'], 0)} / {format_number(arm['latencyP95Ms'], 0)} ms "
                f"| {format_number(arm['inputTokensMean'], 1)} / "
                f"{format_number(arm['outputTokensMean'], 1)} / "
                f"{format_number(arm['totalTokensMean'], 1)} |"
            )
    any_cost = any(
        arm["explicitCostUsd"] is not None
        for suite in suites
        for arm in suite["arms"]
    )
    lines.extend(["", "## 비용", ""])
    if any_cost:
        lines.append(
            "입력 결과에 명시된 USD 비용 필드만 보존했다. 토큰 수로 비용을 역산하지 않았다; "
            "세부 값은 cross-suite JSON/CSV를 참조한다."
        )
    else:
        lines.append(
            "입력에 가격 또는 실비 데이터가 없어 달러 비용을 보고하지 않았다. "
            "토큰 수로 비용을 추정하지 않았다."
        )
    lines.extend(
        [
            "",
            "## 산출물",
            "",
            "- `native-plus-three-suite-accuracy.{png,svg}`",
            "- `native-plus-paired-wins-losses.{png,svg}`",
            "- `native-plus-latency-tokens.{png,svg}`",
            "- `native-plus-cross-suite.{csv,json}`",
            "",
        ]
    )
    return "\n".join(lines)


def build_study(
    directories: dict[str, Path], native_arm: str, plus_arm: str, plus_label: str
) -> dict[str, Any]:
    suites: list[dict[str, Any]] = []
    sources: dict[str, dict[str, str]] = {}
    for suite in SUITE_ORDER:
        directory = directories[suite]
        summary_path = directory / SUMMARY_FILENAMES[suite]
        rows_path = directory / ROW_FILENAMES[suite]
        summary = load_json(summary_path)
        rows = load_jsonl(rows_path)
        pair = paired_summary(suite, rows, native_arm, plus_arm)
        arms: list[dict[str, Any]] = []
        for arm_role, arm_id, arm_label in (
            ("native", native_arm, "Native"),
            ("native_plus", plus_arm, plus_label),
        ):
            aggregate = find_arm_summary(suite, summary, arm_id)
            outcome = outcome_summary(suite, aggregate)
            efficiency = observed_efficiency(suite, rows, arm_id)
            if outcome["total"] != pair["comparable"]:
                raise ValueError(
                    f"{suite} summary/raw count mismatch for {arm_id!r}: "
                    f"summary total={outcome['total']}, paired rows={pair['comparable']}"
                )
            arms.append(
                {
                    "arm": arm_id,
                    "armRole": arm_role,
                    "armLabel": arm_label,
                    **outcome,
                    **efficiency,
                    "explicitCostUsd": explicit_cost_usd(suite, aggregate),
                    "failures": failure_counts(suite, summary, rows, arm_id),
                }
            )
        suites.append(
            {
                "suite": suite,
                "displayName": SUITE_DISPLAY_NAMES[suite],
                "pair": pair,
                "arms": arms,
            }
        )
        sources[suite] = {
            "directory": str(directory.resolve()),
            "summary": str(summary_path.resolve()),
            "rows": str(rows_path.resolve()),
        }
    return {
        "study": "Native vs Native-Plus cross-suite paired evaluation",
        "nativeArm": native_arm,
        "nativePlusArm": plus_arm,
        "nativePlusLabel": plus_label,
        "nativePlusProtocol": "hybrid/repair-only",
        "pooledScore": None,
        "pooledScoreReason": "Suites use different tasks, scorers, and sample sizes.",
        "pricing": {
            "inferencePolicy": "Only explicit USD cost fields are preserved; token counts are never converted to dollars.",
            "hasExplicitCost": any(
                arm["explicitCostUsd"] is not None
                for suite in suites
                for arm in suite["arms"]
            ),
        },
        "sources": sources,
        "suites": suites,
    }


def write_report(study: dict[str, Any], out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    chart_specs = (
        (
            "native-plus-three-suite-accuracy.svg",
            accuracy_chart(study["suites"], study["nativePlusLabel"]),
        ),
        (
            "native-plus-paired-wins-losses.svg",
            paired_chart(study["suites"], study["nativePlusLabel"]),
        ),
        (
            "native-plus-latency-tokens.svg",
            efficiency_chart(study["suites"], study["nativePlusLabel"]),
        ),
    )
    artifacts: list[Path] = []
    rendering: list[dict[str, Any]] = []
    for filename, content in chart_specs:
        svg_path = out_dir / filename
        svg_path.write_text(content, encoding="utf-8")
        rendering.append(render(svg_path))
        artifacts.extend([svg_path, svg_path.with_suffix(".png")])

    json_path = out_dir / "native-plus-cross-suite.json"
    csv_path = out_dir / "native-plus-cross-suite.csv"
    notion_path = out_dir / "native-plus-notion-summary.md"
    render_path = out_dir / "native-plus-rendering.json"
    json_path.write_text(
        json.dumps(study, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    write_csv(csv_path, flatten_rows(study["suites"]))
    notion_path.write_text(notion_markdown(study), encoding="utf-8")
    render_path.write_text(
        json.dumps({"charts": rendering, "count": len(rendering)}, indent=2) + "\n",
        encoding="utf-8",
    )
    artifacts.extend([json_path, csv_path, notion_path, render_path])
    return artifacts


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create an offline Native vs Native-Plus (hybrid, repair-only) "
            "BFCL/ACE/MCPMark report with PNG+SVG charts."
        ),
        epilog=(
            "Each input is a result directory: BFCL must contain summary.json "
            "and scored.jsonl; ACE must contain ace-summary.json and scored.jsonl; "
            "MCPMark must contain mcpmark-summary.json and raw.jsonl. No provider "
            "calls are made and missing pricing is never inferred from tokens."
        ),
    )
    parser.add_argument("--bfcl-dir", required=True, type=Path)
    parser.add_argument("--ace-dir", required=True, type=Path)
    parser.add_argument("--mcpmark-dir", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument(
        "--native-arm",
        default="native",
        help="arm ID used by the provider-native baseline (default: native)",
    )
    parser.add_argument(
        "--plus-arm",
        default="glm5Repair",
        help="arm ID used by Native-Plus repair-only (default: glm5Repair)",
    )
    parser.add_argument(
        "--plus-label",
        default=DEFAULT_PLUS_LABEL,
        help=f"display label (default: {DEFAULT_PLUS_LABEL!r})",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    directories = {
        "BFCL": args.bfcl_dir,
        "ACE": args.ace_dir,
        "MCPMark": args.mcpmark_dir,
    }
    study = build_study(
        directories, args.native_arm, args.plus_arm, args.plus_label
    )
    artifacts = write_report(study, args.out_dir)
    print(
        json.dumps(
            {
                "artifactCount": len(artifacts),
                "nativePlusArm": args.plus_arm,
                "nativePlusLabel": args.plus_label,
                "outDir": str(args.out_dir.resolve()),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
