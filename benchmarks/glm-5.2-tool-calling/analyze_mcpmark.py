#!/usr/bin/env python3
"""Analyze MCPMark Filesystem results and render dependency-free charts."""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import math
import os
import re
import shutil
import subprocess
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


ARM_ORDER = (
    "native",
    "glm5",
    "hermes",
    "morphXml",
    "yamlXml",
    "qwen3Coder",
    "sijawaraDetailed",
    "sijawaraConcise",
    "uiTars",
)
ARM_LABELS = {
    "native": "Native",
    "glm5": "GLM-5.2",
    "hermes": "Hermes",
    "morphXml": "Morph XML",
    "yamlXml": "YAML XML",
    "qwen3Coder": "Qwen3Coder",
    "sijawaraDetailed": "Sijawara Detailed",
    "sijawaraConcise": "Sijawara Concise",
    "uiTars": "UI-TARS",
}
ARM_COLORS = {
    "native": "#111827",
    "glm5": "#dc2626",
    "hermes": "#7c3aed",
    "morphXml": "#059669",
    "yamlXml": "#d97706",
    "qwen3Coder": "#2563eb",
    "sijawaraDetailed": "#db2777",
    "sijawaraConcise": "#f472b6",
    "uiTars": "#0891b2",
}
PRIMARY_OUTCOME_ORDER = (
    "passed",
    "verification",
    "parser",
    "mcp",
    "turn_limit",
    "attempt_timeout",
    "provider",
    "setup",
    "unknown",
)
PRIMARY_OUTCOME_COLORS = {
    "passed": "#10b981",
    "verification": "#f59e0b",
    "parser": "#8b5cf6",
    "mcp": "#ef4444",
    "turn_limit": "#f97316",
    "attempt_timeout": "#0f766e",
    "provider": "#dc2626",
    "setup": "#7f1d1d",
    "unknown": "#9ca3af",
}
PRIMARY_OUTCOME_LABELS = {
    "passed": "Passed",
    "verification": "Verifier failed",
    "parser": "Parser",
    "mcp": "MCP execution",
    "turn_limit": "Turn limit",
    "attempt_timeout": "Attempt timeout",
    "provider": "Provider",
    "setup": "Setup",
    "unknown": "Unknown",
}
SECRET_ENVIRONMENT_NAME = re.compile(
    r"(?:api[_-]?key|authorization|credential|password|secret|token)", re.I
)


def sanitized_child_environment() -> dict[str, str]:
    return {
        name: value
        for name, value in os.environ.items()
        if not SECRET_ENVIRONMENT_NAME.search(name)
    }


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("run metadata root must be an object")
    return value


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"raw row {line_number} is not an object")
            rows.append(value)
    return rows


def ordered_values(known: Iterable[str], observed: Iterable[str]) -> list[str]:
    observed_set = set(observed)
    return [item for item in known if item in observed_set] + sorted(
        observed_set.difference(known)
    )


def row_key(row: dict[str, Any]) -> tuple[str, str, int]:
    return str(row["taskId"]), str(row["arm"]), int(row["trial"])


def group_rows(
    rows: list[dict[str, Any]], fields: tuple[str, ...]
) -> dict[tuple[str, ...], list[dict[str, Any]]]:
    grouped: dict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[tuple(str(row[field]) for field in fields)].append(row)
    return grouped


def ratio(numerator: int | float, denominator: int | float) -> float | None:
    return None if denominator == 0 else numerator / denominator


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


def exact_two_sided_mcnemar(conversion_loss: int, recovery: int) -> float:
    discordant = conversion_loss + recovery
    if discordant == 0:
        return 1.0
    tail_limit = min(conversion_loss, recovery)
    tail = sum(math.comb(discordant, index) for index in range(tail_limit + 1))
    return min(1.0, 2 * tail / (2**discordant))


def iter_attempts(rows: Iterable[dict[str, Any]]) -> Iterable[dict[str, Any]]:
    for row in rows:
        attempts = row.get("attempts", [])
        if isinstance(attempts, list):
            for attempt in attempts:
                if isinstance(attempt, dict):
                    yield attempt


def resource_totals(rows: list[dict[str, Any]]) -> dict[str, int]:
    attempts = list(iter_attempts(rows))
    turns = 0
    tool_calls = 0
    input_tokens = 0
    output_tokens = 0
    total_tokens = 0
    for attempt in attempts:
        trajectory = attempt.get("trajectory", [])
        if isinstance(trajectory, list):
            turns += len(trajectory)
            tool_calls += sum(
                len(turn.get("toolCalls", []))
                for turn in trajectory
                if isinstance(turn, dict)
                and isinstance(turn.get("toolCalls", []), list)
            )
        usage = attempt.get("usage", {})
        if isinstance(usage, dict):
            input_tokens += int(usage.get("inputTokens", 0) or 0)
            output_tokens += int(usage.get("outputTokens", 0) or 0)
            total_tokens += int(usage.get("totalTokens", 0) or 0)
    return {
        "attemptsTotal": len(attempts),
        "turnsTotal": turns,
        "toolCallsTotal": tool_calls,
        "inputTokensTotal": input_tokens,
        "outputTokensTotal": output_tokens,
        "totalTokensTotal": total_tokens,
    }


def final_failure_stages(row: dict[str, Any]) -> set[str]:
    attempts = row.get("attempts", [])
    if not isinstance(attempts, list) or not attempts:
        return set(str(item) for item in row.get("failureStages", []))
    final_attempt = attempts[-1]
    if not isinstance(final_attempt, dict):
        return set()
    failures = final_attempt.get("failures", [])
    if not isinstance(failures, list):
        return set()
    return {
        str(failure["stage"])
        for failure in failures
        if isinstance(failure, dict) and "stage" in failure
    }


def primary_outcome(row: dict[str, Any]) -> str:
    if bool(row.get("verificationPassed")):
        return "passed"
    stages = final_failure_stages(row)
    # Infrastructure loss takes precedence, then the earliest actionable model
    # failure.  A bare verifier failure means the task result itself was wrong.
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


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    jobs = len(rows)
    passed = sum(bool(row.get("verificationPassed")) for row in rows)
    lower95, upper95 = wilson(passed, jobs)
    latencies = [float(row["jobLatencyMs"]) for row in rows]
    totals = resource_totals(rows)
    failure_stage_counts = Counter(
        str(stage)
        for row in rows
        for stage in row.get("failureStages", [])
    )
    final_failure_stage_counts = Counter(
        stage for row in rows for stage in final_failure_stages(row)
    )
    outcome_counts = Counter(primary_outcome(row) for row in rows)
    return {
        "jobs": jobs,
        "passed": passed,
        "failed": jobs - passed,
        "passRate": ratio(passed, jobs),
        "lower95": lower95,
        "upper95": upper95,
        "jobLatencyMeanMs": mean(latencies),
        "jobLatencyP50Ms": quantile(latencies, 0.5),
        "jobLatencyP95Ms": quantile(latencies, 0.95),
        **totals,
        "turnsPerJob": ratio(totals["turnsTotal"], jobs),
        "toolCallsPerJob": ratio(totals["toolCallsTotal"], jobs),
        "totalTokensPerJob": ratio(totals["totalTokensTotal"], jobs),
        "failureStageCounts": dict(sorted(failure_stage_counts.items())),
        "finalFailureStageCounts": dict(
            sorted(final_failure_stage_counts.items())
        ),
        "primaryOutcomeCounts": {
            outcome: outcome_counts[outcome]
            for outcome in PRIMARY_OUTCOME_ORDER
            if outcome_counts[outcome]
        },
    }


def flatten_protocol_summary(arm: str, value: dict[str, Any]) -> dict[str, Any]:
    fields = (
        "jobs",
        "passed",
        "failed",
        "passRate",
        "lower95",
        "upper95",
        "jobLatencyMeanMs",
        "jobLatencyP50Ms",
        "jobLatencyP95Ms",
        "attemptsTotal",
        "turnsTotal",
        "toolCallsTotal",
        "inputTokensTotal",
        "outputTokensTotal",
        "totalTokensTotal",
        "turnsPerJob",
        "toolCallsPerJob",
        "totalTokensPerJob",
    )
    return {"arm": arm, **{field: value[field] for field in fields}}


def paired_vs_native(
    rows: list[dict[str, Any]], arms: list[str]
) -> list[dict[str, Any]]:
    by_arm: dict[str, dict[tuple[str, int], dict[str, Any]]] = defaultdict(dict)
    for row in rows:
        by_arm[str(row["arm"])][
            (str(row["taskId"]), int(row["trial"]))
        ] = row
    baseline = by_arm.get("native", {})
    output: list[dict[str, Any]] = []
    for arm in arms:
        if arm == "native":
            continue
        both_pass = 0
        both_fail = 0
        conversion_loss = 0
        recovery = 0
        comparable = 0
        for case_key, native_row in baseline.items():
            arm_row = by_arm.get(arm, {}).get(case_key)
            if arm_row is None:
                continue
            comparable += 1
            native_passed = bool(native_row.get("verificationPassed"))
            arm_passed = bool(arm_row.get("verificationPassed"))
            if native_passed and arm_passed:
                both_pass += 1
            elif native_passed and not arm_passed:
                conversion_loss += 1
            elif not native_passed and arm_passed:
                recovery += 1
            else:
                both_fail += 1
        output.append(
            {
                "arm": arm,
                "comparable": comparable,
                "bothPass": both_pass,
                "bothFail": both_fail,
                "conversionLoss": conversion_loss,
                "recovery": recovery,
                "netVsNative": recovery - conversion_loss,
                "discordant": conversion_loss + recovery,
                "mcnemarExactP": exact_two_sided_mcnemar(
                    conversion_loss, recovery
                ),
            }
        )
    return output


def failure_composition(
    rows: list[dict[str, Any]], arms: list[str]
) -> list[dict[str, Any]]:
    by_arm = group_rows(rows, ("arm",))
    output: list[dict[str, Any]] = []
    for arm in arms:
        arm_rows = by_arm.get((arm,), [])
        counts = Counter(primary_outcome(row) for row in arm_rows)
        for outcome in PRIMARY_OUTCOME_ORDER:
            output.append(
                {
                    "arm": arm,
                    "outcome": outcome,
                    "count": counts[outcome],
                    "share": ratio(counts[outcome], len(arm_rows)),
                }
            )
    return output


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def format_percent(value: float | None, digits: int = 1) -> str:
    return "—" if value is None else f"{value * 100:.{digits}f}%"


def svg_frame(width: int, height: int, title: str, content: str) -> str:
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="chart-title">
  <title id="chart-title">{esc(title)}</title>
  <rect width="100%" height="100%" fill="#ffffff"/>
  <style>text{{font-family:Inter,Arial,sans-serif;fill:#111827}}.title{{font-size:24px;font-weight:700}}.subtitle{{font-size:13px;fill:#4b5563}}.label{{font-size:14px}}.small{{font-size:12px;fill:#4b5563}}.value{{font-size:12px;font-weight:700}}.grid{{stroke:#e5e7eb;stroke-width:1}}</style>
  <text x="40" y="38" class="title">{esc(title)}</text>
  {content}
</svg>
'''


def percent_axis(left: int, top: int, chart_width: int, bottom: int) -> list[str]:
    lines: list[str] = []
    for tick in range(0, 101, 20):
        x = left + tick / 100 * chart_width
        lines.append(
            f'<line x1="{x}" y1="{top}" x2="{x}" y2="{bottom}" class="grid"/>'
        )
        lines.append(
            f'<text x="{x}" y="{bottom + 24}" text-anchor="middle" class="small">{tick}%</text>'
        )
    return lines


def overall_success_svg(
    summaries: list[dict[str, Any]], arms: list[str]
) -> str:
    width = 1120
    left = 220
    top = 86
    row_height = 57
    chart_width = 760
    bottom = top + len(arms) * row_height
    height = bottom + 70
    by_arm = {str(item["arm"]): item for item in summaries}
    lines = percent_axis(left, top - 10, chart_width, bottom)
    lines.append(
        '<text x="40" y="62" class="subtitle">End-to-end official verifier pass rate · whiskers show 95% Wilson CI</text>'
    )
    for index, arm in enumerate(arms):
        summary = by_arm[arm]
        y = top + index * row_height
        value = float(summary.get("passRate") or 0)
        lines.append(
            f'<text x="{left - 14}" y="{y + 24}" text-anchor="end" class="label">{esc(ARM_LABELS.get(arm, arm))}</text>'
        )
        lines.append(
            f'<rect x="{left}" y="{y + 6}" width="{value * chart_width}" height="26" rx="5" fill="{ARM_COLORS.get(arm, "#64748b")}"/>'
        )
        lower = summary.get("lower95")
        upper = summary.get("upper95")
        if lower is not None and upper is not None:
            low_x = left + float(lower) * chart_width
            high_x = left + float(upper) * chart_width
            lines.extend(
                [
                    f'<line x1="{low_x}" y1="{y + 19}" x2="{high_x}" y2="{y + 19}" stroke="#111827" stroke-width="2"/>',
                    f'<line x1="{low_x}" y1="{y + 12}" x2="{low_x}" y2="{y + 26}" stroke="#111827"/>',
                    f'<line x1="{high_x}" y1="{y + 12}" x2="{high_x}" y2="{y + 26}" stroke="#111827"/>',
                ]
            )
        lines.append(
            f'<text x="{left + chart_width + 10}" y="{y + 25}" class="value">{format_percent(summary.get("passRate"))} · {summary["passed"]}/{summary["jobs"]}</text>'
        )
    return svg_frame(
        width,
        height,
        "MCPMark Filesystem Easy success (95% Wilson CI)",
        "\n".join(lines),
    )


def heat_color(value: float | None) -> str:
    if value is None:
        return "#f3f4f6"
    if value < 0.5:
        fraction = max(0.0, value) / 0.5
        start = (254, 226, 226)
        end = (254, 243, 199)
    else:
        fraction = min(1.0, (value - 0.5) / 0.5)
        start = (254, 243, 199)
        end = (167, 243, 208)
    rgb = tuple(
        round(start[index] + (end[index] - start[index]) * fraction)
        for index in range(3)
    )
    return f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"


def task_heatmap_svg(
    task_summaries: list[dict[str, Any]], arms: list[str], tasks: list[str]
) -> str:
    left = 275
    top = 112
    cell_width = 110
    cell_height = 47
    width = left + len(arms) * cell_width + 40
    height = top + len(tasks) * cell_height + 45
    by_key = {
        (str(item["taskId"]), str(item["arm"])): item
        for item in task_summaries
    }
    lines = [
        '<text x="40" y="62" class="subtitle">Cell = verifier pass rate; fraction = passed jobs / configured trials</text>'
    ]
    for arm_index, arm in enumerate(arms):
        x = left + arm_index * cell_width + cell_width / 2
        lines.append(
            f'<text x="{x}" y="94" text-anchor="middle" class="small">{esc(ARM_LABELS.get(arm, arm))}</text>'
        )
    for task_index, task_id in enumerate(tasks):
        y = top + task_index * cell_height
        lines.append(
            f'<text x="{left - 13}" y="{y + 29}" text-anchor="end" class="label">{esc(task_id)}</text>'
        )
        for arm_index, arm in enumerate(arms):
            summary = by_key.get((task_id, arm))
            x = left + arm_index * cell_width
            value = None if summary is None else summary.get("passRate")
            lines.append(
                f'<rect x="{x + 1}" y="{y + 1}" width="{cell_width - 3}" height="{cell_height - 3}" rx="4" fill="{heat_color(value)}" stroke="#ffffff"/>'
            )
            if summary is None:
                label = "—"
                fraction = "n=0"
            else:
                label = format_percent(value, 0)
                fraction = f'{summary["passed"]}/{summary["jobs"]}'
            lines.append(
                f'<text x="{x + cell_width / 2}" y="{y + 20}" text-anchor="middle" class="value">{label}</text>'
            )
            lines.append(
                f'<text x="{x + cell_width / 2}" y="{y + 36}" text-anchor="middle" class="small">{fraction}</text>'
            )
    return svg_frame(
        width,
        height,
        "MCPMark task × protocol success heatmap",
        "\n".join(lines),
    )


def execution_efficiency_svg(
    summaries: list[dict[str, Any]], arms: list[str]
) -> str:
    width = 1460
    left = 210
    top = 116
    row_height = 58
    panel_width = 360
    bar_width = 255
    panel_gap = 38
    bottom = top + len(arms) * row_height
    height = bottom + 70
    metrics = (
        ("turnsPerJob", "Turns / job"),
        ("toolCallsPerJob", "Tool calls / job"),
        ("totalTokensPerJob", "Tokens / job"),
    )
    by_arm = {str(item["arm"]): item for item in summaries}
    lines = [
        '<text x="40" y="62" class="subtitle">All attempts are included, including retried attempts · token labels use thousands</text>'
    ]
    for metric_index, (field, title) in enumerate(metrics):
        panel_x = left + metric_index * (panel_width + panel_gap)
        observed = [float(by_arm[arm].get(field) or 0) for arm in arms]
        maximum = max(observed, default=0)
        axis_max = maximum * 1.08 if maximum > 0 else 1
        lines.append(
            f'<text x="{panel_x}" y="91" class="label" font-weight="700">{esc(title)}</text>'
        )
        lines.append(
            f'<line x1="{panel_x}" y1="{top - 7}" x2="{panel_x}" y2="{bottom}" class="grid"/>'
        )
        lines.append(
            f'<line x1="{panel_x + bar_width}" y1="{top - 7}" x2="{panel_x + bar_width}" y2="{bottom}" class="grid"/>'
        )
        lines.append(
            f'<text x="{panel_x}" y="{bottom + 23}" class="small">0</text>'
        )
        maximum_label = (
            f"{axis_max / 1000:.1f}k"
            if field == "totalTokensPerJob"
            else f"{axis_max:.1f}"
        )
        lines.append(
            f'<text x="{panel_x + bar_width}" y="{bottom + 23}" text-anchor="end" class="small">{maximum_label}</text>'
        )
        for arm_index, arm in enumerate(arms):
            y = top + arm_index * row_height
            value = float(by_arm[arm].get(field) or 0)
            normalized_width = value / axis_max * bar_width
            lines.append(
                f'<rect x="{panel_x}" y="{y + 7}" width="{normalized_width}" height="25" rx="4" fill="{ARM_COLORS.get(arm, "#64748b")}"/>'
            )
            display_value = (
                f"{value / 1000:.1f}k"
                if field == "totalTokensPerJob"
                else f"{value:.1f}"
            )
            lines.append(
                f'<text x="{panel_x + normalized_width + 7}" y="{y + 25}" class="value">{display_value}</text>'
            )
    for arm_index, arm in enumerate(arms):
        y = top + arm_index * row_height
        lines.append(
            f'<text x="{left - 15}" y="{y + 25}" text-anchor="end" class="label">{esc(ARM_LABELS.get(arm, arm))}</text>'
        )
    return svg_frame(
        width,
        height,
        "MCPMark execution footprint by protocol",
        "\n".join(lines),
    )


def failure_composition_svg(
    failure_rows: list[dict[str, Any]], arms: list[str]
) -> str:
    width = 1320
    left = 220
    top = 130
    chart_width = 840
    row_height = 58
    bottom = top + len(arms) * row_height
    height = bottom + 70
    by_key = {
        (str(item["arm"]), str(item["outcome"])): item
        for item in failure_rows
    }
    lines = [
        '<text x="40" y="62" class="subtitle">Final-attempt primary outcome; recovered transient errors remain in audit totals, not final failure attribution</text>'
    ]
    legend_x = 55
    legend_y = 82
    for index, outcome in enumerate(PRIMARY_OUTCOME_ORDER):
        x = legend_x + (index % 5) * 245
        y = legend_y + (index // 5) * 24
        lines.append(
            f'<rect x="{x}" y="{y}" width="12" height="10" fill="{PRIMARY_OUTCOME_COLORS[outcome]}"/><text x="{x + 18}" y="{y + 10}" class="small">{esc(PRIMARY_OUTCOME_LABELS[outcome])}</text>'
        )
    for arm_index, arm in enumerate(arms):
        y = top + arm_index * row_height
        counts = {
            outcome: int(by_key[(arm, outcome)]["count"])
            for outcome in PRIMARY_OUTCOME_ORDER
        }
        total = sum(counts.values())
        lines.append(
            f'<text x="{left - 14}" y="{y + 25}" text-anchor="end" class="label">{esc(ARM_LABELS.get(arm, arm))}</text>'
        )
        cursor = float(left)
        for outcome in PRIMARY_OUTCOME_ORDER:
            segment = 0 if total == 0 else counts[outcome] / total * chart_width
            if segment > 0:
                lines.append(
                    f'<rect x="{cursor}" y="{y + 6}" width="{segment}" height="27" fill="{PRIMARY_OUTCOME_COLORS[outcome]}"/>'
                )
                if segment >= 34:
                    lines.append(
                        f'<text x="{cursor + segment / 2}" y="{y + 25}" text-anchor="middle" font-size="11" font-weight="700" fill="#111827">{counts[outcome]}</text>'
                    )
            cursor += segment
        passed = counts["passed"]
        lines.append(
            f'<text x="{left + chart_width + 10}" y="{y + 25}" class="value">pass {passed}/{total}</text>'
        )
    for tick in range(0, 101, 20):
        x = left + tick / 100 * chart_width
        lines.append(
            f'<text x="{x}" y="{bottom + 24}" text-anchor="middle" class="small">{tick}%</text>'
        )
    return svg_frame(
        width,
        height,
        "MCPMark outcome and failure-stage composition",
        "\n".join(lines),
    )


def paired_outcome_svg(paired: list[dict[str, Any]]) -> str:
    width = 1120
    center = 560
    top = 92
    half_width = 360
    row_height = 62
    height = max(240, top + len(paired) * row_height + 70)
    max_count = max(
        [
            int(item.get(field, 0))
            for item in paired
            for field in ("conversionLoss", "recovery")
        ]
        or [1]
    )
    scale = half_width / max(1, max_count)
    lines = [
        '<text x="40" y="62" class="subtitle">End-to-end official-verifier outcomes; all execution failures count as failed jobs</text>',
        f'<line x1="{center}" y1="{top - 18}" x2="{center}" y2="{height - 48}" stroke="#111827" stroke-width="2"/>',
        f'<text x="{center - half_width / 2}" y="{top - 28}" text-anchor="middle" class="small">Native pass → protocol fail</text>',
        f'<text x="{center + half_width / 2}" y="{top - 28}" text-anchor="middle" class="small">Native fail → protocol pass</text>',
    ]
    for index, item in enumerate(paired):
        y = top + index * row_height
        loss = int(item.get("conversionLoss", 0))
        recovery = int(item.get("recovery", 0))
        loss_width = loss * scale
        recovery_width = recovery * scale
        arm = str(item["arm"])
        lines.extend(
            [
                f'<text x="{center - half_width - 16}" y="{y + 24}" text-anchor="end" class="label">{esc(ARM_LABELS.get(arm, arm))}</text>',
                f'<rect x="{center - loss_width}" y="{y + 5}" width="{loss_width}" height="25" fill="#ef4444"/>',
                f'<rect x="{center}" y="{y + 5}" width="{recovery_width}" height="25" fill="#22c55e"/>',
                f'<text x="{center - loss_width - 7}" y="{y + 23}" text-anchor="end" class="value">−{loss}</text>',
                f'<text x="{center + recovery_width + 7}" y="{y + 23}" class="value">+{recovery}</text>',
                f'<text x="{center + half_width + 12}" y="{y + 23}" class="small">p={float(item.get("mcnemarExactP", 1)):.3g}</text>',
            ]
        )
    return svg_frame(
        width,
        height,
        "MCPMark paired end-to-end changes vs Native",
        "\n".join(lines),
    )


def convert_svg_to_png(svg_path: Path, png_path: Path) -> str:
    rsvg = shutil.which("rsvg-convert")
    if rsvg:
        command = [
            rsvg,
            "--background-color",
            "white",
            "--output",
            str(png_path),
            str(svg_path),
        ]
        converter = "rsvg-convert"
    else:
        magick = shutil.which("magick") or shutil.which("convert")
        if not magick:
            raise RuntimeError(
                "PNG output requires rsvg-convert or ImageMagick (magick/convert)"
            )
        command = [
            magick,
            "-background",
            "white",
            "-density",
            "144",
            str(svg_path),
            "-strip",
            "-define",
            "png:exclude-chunk=date,time",
            str(png_path),
        ]
        converter = Path(magick).name
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        env=sanitized_child_environment(),
        text=True,
        timeout=120,
    )
    if (
        completed.returncode != 0
        or not png_path.exists()
        or png_path.stat().st_size == 0
    ):
        raise RuntimeError(f"{converter} could not render {svg_path.name}")
    return converter


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Analyze MCPMark raw results and render SVG/PNG charts"
    )
    parser.add_argument("--raw", required=True, type=Path)
    parser.add_argument("--meta", required=True, type=Path)
    parser.add_argument("--out-dir", type=Path)
    args = parser.parse_args()
    out_dir = args.out_dir or args.raw.parent

    meta = load_json(args.meta)
    rows = load_jsonl(args.raw)
    keys = [row_key(row) for row in rows]
    if len(keys) != len(set(keys)):
        raise ValueError(
            "duplicate task-arm-trial rows; run validate_mcpmark.py before analysis"
        )
    configured_arms = [
        str(item["id"])
        for item in meta.get("arms", [])
        if isinstance(item, dict) and "id" in item
    ]
    arms = ordered_values(
        ARM_ORDER,
        configured_arms or (str(row["arm"]) for row in rows),
    )
    configured_tasks = [
        (str(item["id"]), str(item["category"]))
        for item in meta.get("tasks", [])
        if isinstance(item, dict) and "id" in item and "category" in item
    ]
    tasks = [task_id for task_id, _ in configured_tasks]
    if not tasks:
        tasks = sorted({str(row["taskId"]) for row in rows})
    task_categories = dict(configured_tasks)

    by_arm = group_rows(rows, ("arm",))
    by_task_arm = group_rows(rows, ("taskId", "arm"))
    protocol_details = [
        {"arm": arm, **summarize(by_arm.get((arm,), []))} for arm in arms
    ]
    protocol_csv = [
        flatten_protocol_summary(str(item["arm"]), item)
        for item in protocol_details
    ]
    task_details: list[dict[str, Any]] = []
    task_csv: list[dict[str, Any]] = []
    for task_id in tasks:
        for arm in arms:
            detail = summarize(by_task_arm.get((task_id, arm), []))
            item = {
                "taskId": task_id,
                "category": task_categories.get(task_id, task_id.split("/", 1)[0]),
                "arm": arm,
                **detail,
            }
            task_details.append(item)
            flat = flatten_protocol_summary(arm, detail)
            task_csv.append(
                {
                    "taskId": item["taskId"],
                    "category": item["category"],
                    **flat,
                }
            )
    paired = paired_vs_native(rows, arms)
    failures = failure_composition(rows, arms)
    overall = summarize(rows)

    charts_dir = out_dir / "charts"
    charts_dir.mkdir(parents=True, exist_ok=True)
    chart_specs = {
        "mcpmark-overall-success": overall_success_svg(protocol_csv, arms),
        "mcpmark-task-heatmap": task_heatmap_svg(task_details, arms, tasks),
        "mcpmark-execution-efficiency": execution_efficiency_svg(
            protocol_csv, arms
        ),
        "mcpmark-failure-composition": failure_composition_svg(failures, arms),
        "mcpmark-paired-vs-native": paired_outcome_svg(paired),
    }
    chart_files: list[dict[str, str]] = []
    converter_names: set[str] = set()
    for stem, svg in chart_specs.items():
        svg_path = charts_dir / f"{stem}.svg"
        png_path = charts_dir / f"{stem}.png"
        svg_path.write_text(svg, encoding="utf-8")
        converter_names.add(convert_svg_to_png(svg_path, png_path))
        chart_files.append(
            {"name": stem, "svg": str(svg_path), "png": str(png_path)}
        )

    write_csv(out_dir / "mcpmark-protocol-summary.csv", protocol_csv)
    write_csv(out_dir / "mcpmark-task-summary.csv", task_csv)
    write_csv(out_dir / "mcpmark-paired-vs-native.csv", paired)
    write_csv(out_dir / "mcpmark-failure-summary.csv", failures)
    summary = {
        "benchmark": "MCPMark Filesystem Easy official 10-task smoke/CI slice",
        "mcpmarkCommit": meta.get("mcpmarkCommit"),
        "model": meta.get("model"),
        "startedAt": meta.get("startedAt"),
        "completedAt": meta.get("completedAt"),
        "rawSha256": hashlib.sha256(args.raw.read_bytes()).hexdigest(),
        "observedJobs": len(rows),
        "expectedJobs": meta.get("expectedJobs"),
        "trials": meta.get("trials"),
        "arms": arms,
        "tasks": [
            {
                "taskId": task_id,
                "category": task_categories.get(task_id, task_id.split("/", 1)[0]),
            }
            for task_id in tasks
        ],
        "totals": overall,
        "protocols": protocol_details,
        "taskResults": task_details,
        "pairedVsNative": paired,
        "failureComposition": failures,
        "methodology": {
            "success": "final attempt official verifier passed",
            "confidenceInterval": "two-sided 95% Wilson interval",
            "latency": "jobLatencyMs, including retries",
            "resources": "sum across all attempts, including retried attempts",
            "failureComposition": "mutually exclusive final-attempt primary outcome; recovered earlier-attempt errors remain only in all-attempt failureStageCounts",
            "pairedTest": "two-sided exact McNemar test against Native on matched end-to-end official-verifier outcomes; provider, parser, and other execution failures count as failed jobs",
        },
        "charts": chart_files,
        "pngConverters": sorted(converter_names),
    }
    (out_dir / "mcpmark-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"Analyzed {len(rows)} MCPMark jobs -> {out_dir} "
        f"({sum(bool(row.get('verificationPassed')) for row in rows)} passed; "
        f"{len(chart_specs)} SVG+PNG charts)"
    )


if __name__ == "__main__":
    main()
