#!/usr/bin/env python3
"""Analyze scored ACEBench-derived protocol results and render SVG charts."""

from __future__ import annotations

import argparse
import csv
import html
import json
import math
from collections import Counter, defaultdict
from datetime import UTC, datetime
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
LANGUAGE_ORDER = ("en", "zh")
CATEGORY_ORDER = (
    "normal_single_turn_single_function",
    "normal_single_turn_parallel_function",
    "normal_similar_api",
    "normal_preference",
    "normal_atom_bool",
    "normal_atom_enum",
    "normal_atom_number",
    "normal_atom_list",
    "normal_atom_object_deep",
    "normal_atom_object_short",
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
CATEGORY_LABELS = {
    "normal_single_turn_single_function": "Single",
    "normal_single_turn_parallel_function": "Parallel",
    "normal_similar_api": "Similar API",
    "normal_preference": "Preference",
    "normal_atom_bool": "Bool",
    "normal_atom_enum": "Enum",
    "normal_atom_number": "Number",
    "normal_atom_list": "List",
    "normal_atom_object_deep": "Object deep",
    "normal_atom_object_short": "Object short",
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
FAILURE_KINDS = (
    "provider",
    "malformed",
    "argumentWhitespace",
    "textLeak",
    "missingCall",
    "wrongCount",
    "wrongFunction",
    "missingArgument",
    "extraArgument",
    "wrongType",
    "wrongValue",
    "scorerError",
    "otherSemantic",
    "excluded",
)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def deduplicate_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: dict[tuple[str, str, str, str, int], dict[str, Any]] = {}
    for row in rows:
        key = (
            str(row["language"]),
            str(row["category"]),
            str(row["caseId"]),
            str(row["arm"]),
            int(row.get("trial", 0)),
        )
        selected[key] = row
    return list(selected.values())


def ratio(numerator: int, denominator: int) -> float | None:
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


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    eligible = [row for row in rows if row.get("benchmarkItemValid")]
    available = [row for row in eligible if row.get("transportOk")]
    correct = sum(bool(row.get("strictCorrect")) for row in available)
    semantic_correct = sum(bool(row.get("aceCorrect")) for row in available)
    provider_failures = len(eligible) - len(available)
    excluded = len(rows) - len(eligible)
    lower95, upper95 = wilson(correct, len(available))
    semantic_lower95, semantic_upper95 = wilson(semantic_correct, len(available))
    availability_lower95, availability_upper95 = wilson(
        len(available), len(eligible)
    )
    end_to_end_lower95, end_to_end_upper95 = wilson(correct, len(eligible))
    return {
        "accuracy": ratio(correct, len(available)),
        "aceAccuracy": ratio(semantic_correct, len(available)),
        "argumentBoundaryWhitespace": sum(
            bool(row.get("argumentBoundaryWhitespace")) for row in available
        ),
        "availability": ratio(len(available), len(eligible)),
        "availabilityLower95": availability_lower95,
        "availabilityUpper95": availability_upper95,
        "available": len(available),
        "correct": correct,
        "eligible": len(eligible),
        "endToEndAccuracy": ratio(correct, len(eligible)),
        "endToEndLower95": end_to_end_lower95,
        "endToEndUpper95": end_to_end_upper95,
        "excluded": excluded,
        "inputTokensMean": mean(
            float(row["usage"]["inputTokens"])
            for row in available
            if isinstance(row.get("usage"), dict)
            and row["usage"].get("inputTokens") is not None
        ),
        "latencyP50Ms": quantile(
            (float(row.get("latencyMs", 0)) for row in available), 0.5
        ),
        "latencyP95Ms": quantile(
            (float(row.get("latencyMs", 0)) for row in available), 0.95
        ),
        "lower95": lower95,
        "malformedCalls": sum(
            not bool(row.get("callShapeValid")) for row in available
        ),
        "observed": len(rows),
        "outputTokensMean": mean(
            float(row["usage"]["outputTokens"])
            for row in available
            if isinstance(row.get("usage"), dict)
            and row["usage"].get("outputTokens") is not None
        ),
        "parserErrors": sum(bool(row.get("parserErrors")) for row in available),
        "protocolFailures": sum(
            bool(row.get("aceCorrect")) and not bool(row.get("strictCorrect"))
            for row in available
        ),
        "providerFailures": provider_failures,
        "semanticCorrect": semantic_correct,
        "semanticFailures": len(available) - semantic_correct,
        "semanticLower95": semantic_lower95,
        "semanticUpper95": semantic_upper95,
        "textLeaks": sum(bool(row.get("textLeak")) for row in available),
        "upper95": upper95,
    }


def group_rows(
    rows: list[dict[str, Any]], key_fields: tuple[str, ...]
) -> dict[tuple[str, ...], list[dict[str, Any]]]:
    grouped: dict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[tuple(str(row[field]) for field in key_fields)].append(row)
    return grouped


def classify_failure(row: dict[str, Any]) -> str | None:
    if not row.get("benchmarkItemValid"):
        return "excluded"
    if not row.get("transportOk"):
        return "provider"
    if row.get("strictCorrect"):
        return None
    if not row.get("callShapeValid") or row.get("parserErrors"):
        return "malformed"
    if row.get("argumentBoundaryWhitespace"):
        return "argumentWhitespace"
    if row.get("textLeak"):
        return "textLeak"
    error_type = str(row.get("scoreErrorType") or "")
    error_text = " ".join(str(item) for item in row.get("scoreErrors", []))
    calls = row.get("calls", [])
    if error_type == "scorer_error":
        return "scorerError"
    if "wrong functions number" in error_type or "number of functions" in error_text:
        return "missingCall" if not calls else "wrongCount"
    if "function_mismatch" in error_type or "wrong_function" in error_type:
        return "missingCall" if not calls else "wrongFunction"
    if "lack_args" in error_type:
        return "missingArgument"
    if "addition_args" in error_type:
        return "extraArgument"
    if "type_error" in error_type:
        return "wrongType"
    if "value_error" in error_type:
        return "wrongValue"
    return "otherSemantic"


def failure_summaries(
    rows: list[dict[str, Any]], arms: list[str]
) -> list[dict[str, Any]]:
    by_arm = group_rows(rows, ("arm",))
    output: list[dict[str, Any]] = []
    for arm in arms:
        counter = Counter(
            kind
            for row in by_arm.get((arm,), [])
            if (kind := classify_failure(row)) is not None
        )
        output.append({"arm": arm, **{kind: counter[kind] for kind in FAILURE_KINDS}})
    return output


def exact_two_sided_mcnemar(conversion_loss: int, recovery: int) -> float:
    discordant = conversion_loss + recovery
    if discordant == 0:
        return 1.0
    tail = min(conversion_loss, recovery)
    probability = sum(
        math.comb(discordant, count) for count in range(tail + 1)
    ) / 2**discordant
    return min(1.0, 2 * probability)


def paired_vs_native(
    rows: list[dict[str, Any]], arms: list[str]
) -> list[dict[str, Any]]:
    by_arm = group_rows(rows, ("arm",))
    native = {
        (
            str(row["language"]),
            str(row["category"]),
            str(row["caseId"]),
            int(row.get("trial", 0)),
        ): row
        for row in by_arm.get(("native",), [])
    }
    output: list[dict[str, Any]] = []
    for arm in arms:
        if arm == "native":
            continue
        conversion_loss = 0
        recovery = 0
        comparable = 0
        conditional_strict_comparable = 0
        conditional_strict_conversion_loss = 0
        conditional_strict_recovery = 0
        conditional_semantic_comparable = 0
        conditional_semantic_conversion_loss = 0
        conditional_semantic_recovery = 0
        for row in by_arm.get((arm,), []):
            case_key = (
                str(row["language"]),
                str(row["category"]),
                str(row["caseId"]),
                int(row.get("trial", 0)),
            )
            baseline = native.get(case_key)
            if not baseline:
                continue
            if not (
                baseline.get("benchmarkItemValid")
                and row.get("benchmarkItemValid")
            ):
                continue
            comparable += 1
            if baseline.get("strictCorrect") and not row.get("strictCorrect"):
                conversion_loss += 1
            elif row.get("strictCorrect") and not baseline.get("strictCorrect"):
                recovery += 1
            if baseline.get("transportOk") and row.get("transportOk"):
                conditional_strict_comparable += 1
                if baseline.get("strictCorrect") and not row.get("strictCorrect"):
                    conditional_strict_conversion_loss += 1
                elif row.get("strictCorrect") and not baseline.get("strictCorrect"):
                    conditional_strict_recovery += 1
                conditional_semantic_comparable += 1
                if baseline.get("aceCorrect") and not row.get("aceCorrect"):
                    conditional_semantic_conversion_loss += 1
                elif row.get("aceCorrect") and not baseline.get("aceCorrect"):
                    conditional_semantic_recovery += 1
        output.append(
            {
                "arm": arm,
                "comparable": comparable,
                "conditionalSemanticComparable": conditional_semantic_comparable,
                "conditionalSemanticConversionLoss": conditional_semantic_conversion_loss,
                "conditionalSemanticExactP": exact_two_sided_mcnemar(
                    conditional_semantic_conversion_loss,
                    conditional_semantic_recovery,
                ),
                "conditionalSemanticRecovery": conditional_semantic_recovery,
                "conditionalStrictComparable": conditional_strict_comparable,
                "conditionalStrictConversionLoss": conditional_strict_conversion_loss,
                "conditionalStrictExactP": exact_two_sided_mcnemar(
                    conditional_strict_conversion_loss,
                    conditional_strict_recovery,
                ),
                "conditionalStrictRecovery": conditional_strict_recovery,
                "conversionLoss": conversion_loss,
                "mcnemarExactP": exact_two_sided_mcnemar(
                    conversion_loss, recovery
                ),
                "netVsNative": recovery - conversion_loss,
                "recovery": recovery,
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


def ordered_values(known: tuple[str, ...], observed: Iterable[str]) -> list[str]:
    observed_set = set(observed)
    return [item for item in known if item in observed_set] + sorted(
        observed_set.difference(known)
    )


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


def percent_axis(
    left: int, top: int, chart_width: int, bottom: int
) -> list[str]:
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


def overall_accuracy_svg(
    summaries: list[dict[str, Any]], arms: list[str]
) -> str:
    width = 1100
    left = 215
    top = 78
    row_height = 57
    chart_width = 780
    bottom = top + len(arms) * row_height
    height = bottom + 70
    by_arm = {str(item["arm"]): item for item in summaries}
    lines = percent_axis(left, top - 8, chart_width, bottom)
    lines.append(
        '<text x="40" y="60" class="subtitle">Accuracy denominator: provider-successful, oracle-valid ACE items</text>'
    )
    for index, arm in enumerate(arms):
        summary = by_arm[arm]
        y = top + index * row_height
        accuracy = summary.get("accuracy")
        lower = summary.get("lower95")
        upper = summary.get("upper95")
        bar_value = float(accuracy or 0)
        lines.append(
            f'<text x="{left - 14}" y="{y + 23}" text-anchor="end" class="label">{esc(ARM_LABELS.get(arm, arm))}</text>'
        )
        lines.append(
            f'<rect x="{left}" y="{y + 6}" width="{bar_value * chart_width}" height="25" rx="5" fill="{ARM_COLORS.get(arm, "#64748b")}"/>'
        )
        if lower is not None and upper is not None:
            low_x = left + float(lower) * chart_width
            high_x = left + float(upper) * chart_width
            lines.extend(
                [
                    f'<line x1="{low_x}" y1="{y + 18.5}" x2="{high_x}" y2="{y + 18.5}" stroke="#111827" stroke-width="2"/>',
                    f'<line x1="{low_x}" y1="{y + 12}" x2="{low_x}" y2="{y + 25}" stroke="#111827"/>',
                    f'<line x1="{high_x}" y1="{y + 12}" x2="{high_x}" y2="{y + 25}" stroke="#111827"/>',
                ]
            )
        lines.append(
            f'<text x="{left + bar_value * chart_width + 8}" y="{y + 24}" class="value">{format_percent(accuracy)} · n={summary["available"]}</text>'
        )
    return svg_frame(
        width,
        height,
        "ACE Normal static strict accuracy (95% Wilson CI)",
        "\n".join(lines),
    )


def semantic_vs_strict_svg(
    summaries: list[dict[str, Any]], arms: list[str]
) -> str:
    width = 1100
    left = 215
    top = 88
    row_height = 68
    chart_width = 780
    bottom = top + len(arms) * row_height
    height = bottom + 70
    by_arm = {str(item["arm"]): item for item in summaries}
    lines = percent_axis(left, top - 8, chart_width, bottom)
    lines.extend(
        [
            '<rect x="720" y="48" width="14" height="10" fill="#94a3b8"/><text x="740" y="58" class="small">Official semantic</text>',
            '<rect x="870" y="48" width="14" height="10" fill="#111827"/><text x="890" y="58" class="small">Protocol-strict</text>',
        ]
    )
    for index, arm in enumerate(arms):
        summary = by_arm[arm]
        y = top + index * row_height
        semantic = float(summary.get("aceAccuracy") or 0)
        strict = float(summary.get("accuracy") or 0)
        color = ARM_COLORS.get(arm, "#64748b")
        lines.append(
            f'<text x="{left - 14}" y="{y + 31}" text-anchor="end" class="label">{esc(ARM_LABELS.get(arm, arm))}</text>'
        )
        lines.append(
            f'<rect x="{left}" y="{y + 4}" width="{semantic * chart_width}" height="20" rx="4" fill="{color}" opacity="0.35"/>'
        )
        lines.append(
            f'<rect x="{left}" y="{y + 31}" width="{strict * chart_width}" height="20" rx="4" fill="{color}"/>'
        )
        lines.append(
            f'<text x="{left + semantic * chart_width + 7}" y="{y + 19}" class="small">semantic {format_percent(semantic)}</text>'
        )
        lines.append(
            f'<text x="{left + strict * chart_width + 7}" y="{y + 47}" class="value">strict {format_percent(strict)}</text>'
        )
    return svg_frame(
        width,
        height,
        "ACE official semantic vs protocol-strict accuracy",
        "\n".join(lines),
    )


def language_split_svg(
    summaries: list[dict[str, Any]], arms: list[str], languages: list[str]
) -> str:
    width = 1100
    left = 215
    top = 94
    row_height = 69
    chart_width = 780
    bottom = top + len(arms) * row_height
    height = bottom + 70
    by_key = {
        (str(item["arm"]), str(item["language"])): item for item in summaries
    }
    lines = percent_axis(left, top - 12, chart_width, bottom)
    lines.extend(
        [
            '<rect x="750" y="48" width="14" height="10" fill="#334155"/><text x="770" y="58" class="small">English</text>',
            '<rect x="850" y="48" width="14" height="10" fill="#94a3b8"/><text x="870" y="58" class="small">Chinese</text>',
        ]
    )
    for index, arm in enumerate(arms):
        y = top + index * row_height
        lines.append(
            f'<text x="{left - 14}" y="{y + 31}" text-anchor="end" class="label">{esc(ARM_LABELS.get(arm, arm))}</text>'
        )
        for language_index, language in enumerate(languages):
            summary = by_key[(arm, language)]
            bar_y = y + 4 + language_index * 25
            accuracy = summary.get("accuracy")
            value = float(accuracy or 0)
            opacity = 1 if language == "en" else 0.48
            lines.append(
                f'<rect x="{left}" y="{bar_y}" width="{value * chart_width}" height="18" rx="4" fill="{ARM_COLORS.get(arm, "#64748b")}" opacity="{opacity}"/>'
            )
            lower = summary.get("lower95")
            upper = summary.get("upper95")
            if lower is not None and upper is not None:
                lines.append(
                    f'<line x1="{left + float(lower) * chart_width}" y1="{bar_y + 9}" x2="{left + float(upper) * chart_width}" y2="{bar_y + 9}" stroke="#111827" stroke-width="1.5"/>'
                )
            lines.append(
                f'<text x="{left + value * chart_width + 7}" y="{bar_y + 14}" class="value">{language.upper()} {format_percent(accuracy)}</text>'
            )
    return svg_frame(
        width,
        height,
        "ACE strict accuracy by language (95% Wilson CI)",
        "\n".join(lines),
    )


def heat_color(value: float | None) -> str:
    if value is None:
        return "#f3f4f6"
    if value < 0.5:
        ratio_value = max(0.0, value) / 0.5
        start = (254, 226, 226)
        end = (254, 243, 199)
    else:
        ratio_value = min(1.0, (value - 0.5) / 0.5)
        start = (254, 243, 199)
        end = (167, 243, 208)
    rgb = tuple(
        round(start[index] + (end[index] - start[index]) * ratio_value)
        for index in range(3)
    )
    return f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"


def category_heatmap_svg(
    summaries: list[dict[str, Any]],
    arms: list[str],
    languages: list[str],
    categories: list[str],
) -> str:
    left = 210
    top = 112
    cell_width = 112
    cell_height = 39
    width = left + len(arms) * cell_width + 40
    height = top + len(languages) * len(categories) * cell_height + 35
    by_key = {
        (str(item["arm"]), str(item["language"]), str(item["category"])): item
        for item in summaries
    }
    lines = [
        '<text x="40" y="62" class="subtitle">Each cell is strict accuracy; n is provider-successful eligible cases</text>'
    ]
    for arm_index, arm in enumerate(arms):
        x = left + arm_index * cell_width + cell_width / 2
        lines.append(
            f'<text x="{x}" y="94" text-anchor="middle" class="small">{esc(ARM_LABELS.get(arm, arm))}</text>'
        )
    row_index = 0
    for language in languages:
        for category in categories:
            y = top + row_index * cell_height
            label = f"{language.upper()} · {CATEGORY_LABELS.get(category, category)}"
            lines.append(
                f'<text x="{left - 12}" y="{y + 25}" text-anchor="end" class="label">{esc(label)}</text>'
            )
            for arm_index, arm in enumerate(arms):
                summary = by_key[(arm, language, category)]
                value = summary.get("accuracy")
                x = left + arm_index * cell_width
                lines.append(
                    f'<rect x="{x + 1}" y="{y + 1}" width="{cell_width - 3}" height="{cell_height - 3}" rx="3" fill="{heat_color(value)}" stroke="#ffffff"/>'
                )
                lines.append(
                    f'<text x="{x + cell_width / 2}" y="{y + 18}" text-anchor="middle" class="value">{format_percent(value, 0)}</text>'
                )
                lines.append(
                    f'<text x="{x + cell_width / 2}" y="{y + 31}" text-anchor="middle" class="small">n={summary["available"]}</text>'
                )
            row_index += 1
    return svg_frame(
        width,
        height,
        "ACE category × language accuracy heatmap",
        "\n".join(lines),
    )


def outcome_svg(rows: list[dict[str, Any]], arms: list[str]) -> str:
    width = 1260
    left = 215
    top = 108
    chart_width = 800
    row_height = 58
    bottom = top + len(arms) * row_height
    height = bottom + 75
    grouped = group_rows(rows, ("arm",))
    colors = {
        "strict": "#10b981",
        "semantic": "#f59e0b",
        "protocol": "#8b5cf6",
        "provider": "#ef4444",
        "excluded": "#9ca3af",
    }
    labels = {
        "strict": "Strict correct",
        "semantic": "Semantic failure",
        "protocol": "Protocol failure",
        "provider": "Provider failure",
        "excluded": "Excluded source item",
    }
    lines: list[str] = [
        '<text x="40" y="62" class="subtitle">Composition uses every observed job, including oracle-invalid source rows</text>'
    ]
    legend_x = 300
    for index, kind in enumerate(("strict", "semantic", "protocol", "provider", "excluded")):
        x = legend_x + index * 155
        lines.append(
            f'<rect x="{x}" y="74" width="12" height="10" fill="{colors[kind]}"/><text x="{x + 18}" y="84" class="small">{labels[kind]}</text>'
        )
    for index, arm in enumerate(arms):
        arm_rows = grouped.get((arm,), [])
        total = len(arm_rows)
        counts = {
            "strict": sum(bool(row.get("strictCorrect")) for row in arm_rows),
            "semantic": sum(
                bool(row.get("benchmarkItemValid"))
                and bool(row.get("transportOk"))
                and not bool(row.get("aceCorrect"))
                for row in arm_rows
            ),
            "protocol": sum(
                bool(row.get("benchmarkItemValid"))
                and bool(row.get("transportOk"))
                and bool(row.get("aceCorrect"))
                and not bool(row.get("strictCorrect"))
                for row in arm_rows
            ),
            "provider": sum(
                bool(row.get("benchmarkItemValid"))
                and not bool(row.get("transportOk"))
                for row in arm_rows
            ),
            "excluded": sum(
                not bool(row.get("benchmarkItemValid")) for row in arm_rows
            ),
        }
        y = top + index * row_height
        lines.append(
            f'<text x="{left - 14}" y="{y + 24}" text-anchor="end" class="label">{esc(ARM_LABELS.get(arm, arm))}</text>'
        )
        cursor = left
        for kind in ("strict", "semantic", "protocol", "provider", "excluded"):
            segment_width = 0 if total == 0 else counts[kind] / total * chart_width
            if segment_width > 0:
                lines.append(
                    f'<rect x="{cursor}" y="{y + 6}" width="{segment_width}" height="27" fill="{colors[kind]}"/>'
                )
            cursor += segment_width
        eligible = total - counts["excluded"]
        available = eligible - counts["provider"]
        availability = ratio(available, eligible)
        lines.append(
            f'<text x="{left + chart_width + 8}" y="{y + 24}" class="value">avail {format_percent(availability)} · {available}/{eligible}</text>'
        )
    for tick in range(0, 101, 20):
        x = left + tick / 100 * chart_width
        lines.append(
            f'<text x="{x}" y="{bottom + 25}" text-anchor="middle" class="small">{tick}%</text>'
        )
    return svg_frame(
        width,
        height,
        "ACE outcome composition and availability",
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
        '<text x="40" y="62" class="subtitle">End-to-end strict paired outcomes; provider and parser failures count as incorrect</text>',
        f'<line x1="{center}" y1="{top - 18}" x2="{center}" y2="{height - 48}" stroke="#111827" stroke-width="2"/>',
        f'<text x="{center - half_width / 2}" y="{top - 28}" text-anchor="middle" class="small">Native correct → protocol wrong</text>',
        f'<text x="{center + half_width / 2}" y="{top - 28}" text-anchor="middle" class="small">Native wrong → protocol correct</text>',
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
        "ACE paired end-to-end changes vs Native",
        "\n".join(lines),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scored", required=True, type=Path)
    parser.add_argument("--out-dir", type=Path)
    args = parser.parse_args()
    out_dir = args.out_dir or args.scored.parent

    rows = deduplicate_rows(load_jsonl(args.scored))
    arms = ordered_values(ARM_ORDER, (str(row["arm"]) for row in rows))
    languages = ordered_values(
        LANGUAGE_ORDER, (str(row["language"]) for row in rows)
    )
    categories = ordered_values(
        CATEGORY_ORDER, (str(row["category"]) for row in rows)
    )
    by_arm = group_rows(rows, ("arm",))
    by_language = group_rows(rows, ("arm", "language"))
    by_category = group_rows(rows, ("arm", "language", "category"))

    protocol_summaries = [
        {"arm": arm, **summarize(by_arm.get((arm,), []))} for arm in arms
    ]
    language_summaries = [
        {
            "arm": arm,
            "language": language,
            **summarize(by_language.get((arm, language), [])),
        }
        for arm in arms
        for language in languages
    ]
    category_summaries = [
        {
            "arm": arm,
            "language": language,
            "category": category,
            **summarize(by_category.get((arm, language, category), [])),
        }
        for arm in arms
        for language in languages
        for category in categories
    ]
    failures = failure_summaries(rows, arms)
    paired = paired_vs_native(rows, arms)
    excluded_case_keys = sorted(
        {
            (
                str(row["language"]),
                str(row["category"]),
                str(row["caseId"]),
            )
            for row in rows
            if not row.get("benchmarkItemValid")
        }
    )
    summary = {
        "benchmark": "ACEBench-derived Normal static bilingual subset",
        "generatedAt": datetime.now(UTC).isoformat(),
        "scoredPath": str(args.scored.resolve()),
        "observedRows": len(rows),
        "eligibleRows": sum(bool(row.get("benchmarkItemValid")) for row in rows),
        "excludedCases": [
            {"language": language, "category": category, "caseId": case_id}
            for language, category, case_id in excluded_case_keys
        ],
        "protocols": protocol_summaries,
        "languages": language_summaries,
        "pairedVsNative": paired,
        "methodology": {
            "conditionalAccuracy": "provider-successful, oracle-valid rows only; availability and endToEndAccuracy are reported separately",
            "pairedPrimary": "two-sided exact McNemar on matched oracle-valid end-to-end strict outcomes; provider and parser failures count as incorrect",
            "pairedSecondary": "conditional strict and ACE semantic McNemar on pairs where both transports succeeded",
        },
        "categories": category_summaries,
        "failures": failures,
    }

    charts_dir = out_dir / "charts"
    charts_dir.mkdir(parents=True, exist_ok=True)
    write_csv(out_dir / "ace-protocol-summary.csv", protocol_summaries)
    write_csv(out_dir / "ace-language-summary.csv", language_summaries)
    write_csv(out_dir / "ace-category-summary.csv", category_summaries)
    write_csv(out_dir / "ace-failure-summary.csv", failures)
    write_csv(out_dir / "ace-paired-vs-native.csv", paired)
    (out_dir / "ace-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (charts_dir / "ace-overall-accuracy.svg").write_text(
        overall_accuracy_svg(protocol_summaries, arms), encoding="utf-8"
    )
    (charts_dir / "ace-language-split.svg").write_text(
        language_split_svg(language_summaries, arms, languages), encoding="utf-8"
    )
    (charts_dir / "ace-semantic-vs-strict.svg").write_text(
        semantic_vs_strict_svg(protocol_summaries, arms), encoding="utf-8"
    )
    (charts_dir / "ace-category-heatmap.svg").write_text(
        category_heatmap_svg(category_summaries, arms, languages, categories),
        encoding="utf-8",
    )
    (charts_dir / "ace-availability-failure.svg").write_text(
        outcome_svg(rows, arms), encoding="utf-8"
    )
    (charts_dir / "ace-paired-vs-native.svg").write_text(
        paired_outcome_svg(paired), encoding="utf-8"
    )
    print(
        f"Analyzed {len(rows)} scored rows -> {out_dir} "
        f"({len(excluded_case_keys)} excluded source cases)"
    )


if __name__ == "__main__":
    main()
