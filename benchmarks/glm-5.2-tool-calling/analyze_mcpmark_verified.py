#!/usr/bin/env python3
"""Aggregate a complete, official MCPMark Verified two-arm result tree."""

from __future__ import annotations

import argparse
import csv
import html
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any


ARMS = ("glm52-native", "glm52-prompt-only")
ARM_LABELS = {
    "glm52-native": "GLM-5.2 Native",
    "glm52-prompt-only": "GLM-5.2 Prompt-Only",
}
ARM_COLORS = {
    "glm52-native": "#a78bfa",
    "glm52-prompt-only": "#5eead4",
}
DOMAINS = (
    "filesystem",
    "notion",
    "github",
    "postgres",
    "playwright_webarena",
    "playwright",
)
DOMAIN_LABELS = {
    "filesystem": "Filesystem",
    "notion": "Notion",
    "github": "GitHub",
    "postgres": "Postgres",
    "playwright_webarena": "WebArena",
    "playwright": "Playwright",
}


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected a JSON object")
    return value


def exact_two_sided_mcnemar(losses: int, recoveries: int) -> float:
    discordant = losses + recoveries
    if discordant == 0:
        return 1.0
    lower = min(losses, recoveries)
    tail = sum(math.comb(discordant, index) for index in range(lower + 1))
    return min(1.0, 2 * tail / (2**discordant))


def expected_tasks(manifest: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    if manifest.get("benchmark") != "MCPMark Verified":
        raise RuntimeError("manifest is not MCPMark Verified")
    if manifest.get("population") != "standard":
        raise RuntimeError("manifest population is not standard")
    rows = manifest.get("tasks")
    if not isinstance(rows, list):
        raise RuntimeError("manifest tasks are missing")
    output: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise RuntimeError("manifest task row is not an object")
        category = str(row.get("category"))
        task_id = str(row.get("taskId"))
        key = (category, task_id)
        if key in output:
            raise RuntimeError(
                f"category/task is not globally unique in manifest: {category}/{task_id}"
            )
        output[key] = row
    expected_count = int(manifest.get("taskCount", 0))
    if len(output) != expected_count:
        raise RuntimeError(
            f"manifest task count mismatch: header={expected_count}, rows={len(output)}"
        )
    return output


def classify_failure(meta: dict[str, Any]) -> str:
    result = meta.get("execution_result")
    if not isinstance(result, dict):
        return "missing_execution_result"
    if bool(result.get("success")):
        return "passed"
    error = str(result.get("error_message") or "").lower()
    if not error:
        return "verifier"
    if "timeout" in error or "timed out" in error:
        return "timeout"
    if "litellm" in error or "model generation failed" in error:
        return "model_or_provider"
    if "mcp" in error:
        return "mcp"
    if "setup" in error or "initial state" in error:
        return "setup"
    return "agent_error"


def discover_rows(
    official_root: Path,
    expected: dict[tuple[str, str], dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[str]]:
    rows: list[dict[str, Any]] = []
    duplicates: list[str] = []
    seen: set[tuple[str, str, str]] = set()
    for arm in ARMS:
        for meta_path in sorted(official_root.glob(f"{arm}__*/run-*/**/meta.json")):
            service_dir = meta_path.parents[2].name
            prefix = f"{arm}__"
            if not service_dir.startswith(prefix):
                raise RuntimeError(f"unrecognized service directory: {service_dir}")
            actual_service = service_dir[len(prefix) :]
            task_dir = meta_path.parent.name
            if "__" not in task_dir:
                raise RuntimeError(f"unrecognized task directory: {meta_path.parent}")
            category, task_id = task_dir.split("__", 1)
            task = expected.get((category, task_id))
            if task is None:
                raise RuntimeError(f"unexpected task result: {category}/{task_id}")
            expected_service_dir = (
                "playwright"
                if task["service"] == "playwright_webarena"
                else str(task["service"])
            )
            if actual_service != expected_service_dir:
                raise RuntimeError(
                    f"service mismatch for {category}/{task_id}: "
                    f"expected {expected_service_dir}, found {actual_service}"
                )
            key = (arm, category, task_id)
            if key in seen:
                duplicates.append(f"{arm}:{category}/{task_id}")
                continue
            seen.add(key)
            meta = read_json(meta_path)
            if meta.get("task_name") != task_dir:
                raise RuntimeError(f"task_name mismatch in {meta_path}")
            if meta.get("model_name") != arm:
                raise RuntimeError(f"model_name mismatch in {meta_path}")
            result = meta.get("execution_result")
            if not isinstance(result, dict):
                result = {}
            usage = meta.get("token_usage")
            if not isinstance(usage, dict):
                usage = {}
            passed = bool(result.get("success"))
            rows.append(
                {
                    "agentExecutionSeconds": float(
                        meta.get("agent_execution_time", 0) or 0
                    ),
                    "arm": arm,
                    "category": category,
                    "errorMessage": str(result.get("error_message") or ""),
                    "failureClass": classify_failure(meta),
                    "inputTokens": int(usage.get("input_tokens", 0) or 0),
                    "outputTokens": int(usage.get("output_tokens", 0) or 0),
                    "passed": passed,
                    "service": str(task["service"]),
                    "taskExecutionSeconds": float(
                        meta.get("task_execution_time", 0) or 0
                    ),
                    "taskId": task_id,
                    "taskKey": f"{task['service']}/{category}/{task_id}",
                    "totalTokens": int(usage.get("total_tokens", 0) or 0),
                    "turnCount": int(meta.get("turn_count", 0) or 0),
                }
            )
    return rows, duplicates


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    passed = sum(bool(row["passed"]) for row in rows)
    return {
        "failed": len(rows) - passed,
        "failureClasses": dict(
            sorted(Counter(str(row["failureClass"]) for row in rows).items())
        ),
        "inputTokens": sum(int(row["inputTokens"]) for row in rows),
        "jobs": len(rows),
        "outputTokens": sum(int(row["outputTokens"]) for row in rows),
        "passRate": passed / len(rows) if rows else None,
        "passed": passed,
        "taskExecutionSeconds": sum(
            float(row["taskExecutionSeconds"]) for row in rows
        ),
        "totalTokens": sum(int(row["totalTokens"]) for row in rows),
        "turns": sum(int(row["turnCount"]) for row in rows),
    }


def paired_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    by_arm = {
        arm: {str(row["taskKey"]): row for row in rows if row["arm"] == arm}
        for arm in ARMS
    }
    shared = sorted(set(by_arm[ARMS[0]]) & set(by_arm[ARMS[1]]))
    both_pass = both_fail = loss = recovery = 0
    for key in shared:
        native = bool(by_arm[ARMS[0]][key]["passed"])
        prompt_only = bool(by_arm[ARMS[1]][key]["passed"])
        if native and prompt_only:
            both_pass += 1
        elif native and not prompt_only:
            loss += 1
        elif not native and prompt_only:
            recovery += 1
        else:
            both_fail += 1
    return {
        "bothFail": both_fail,
        "bothPass": both_pass,
        "comparable": len(shared),
        "discordant": loss + recovery,
        "mcnemarExactP": exact_two_sided_mcnemar(loss, recovery),
        "nativeOnlyPass": loss,
        "promptOnlyOnlyPass": recovery,
        "netPromptOnly": recovery - loss,
    }


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def svg_page(width: int, height: int, title: str, body: str) -> str:
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">
  <rect width="100%" height="100%" rx="28" fill="#070a0f"/>
  <style>text{{font-family:Inter,Arial,sans-serif;fill:#f8fafc}}.title{{font-size:30px;font-weight:750}}.sub{{font-size:14px;fill:#94a3b8}}.label{{font-size:15px}}.value{{font-size:18px;font-weight:700}}.grid{{stroke:#273244;stroke-width:1}}</style>
  <text x="48" y="58" class="title">{esc(title)}</text>
  {body}
</svg>\n'''


def render_pass_rate(path: Path, by_arm: dict[str, dict[str, Any]]) -> None:
    width, height = 980, 440
    parts = [
        '<text x="48" y="86" class="sub">MCPMark Verified · complete standard population only</text>'
    ]
    x0, chart_width = 260, 640
    for index, arm in enumerate(ARMS):
        y = 150 + index * 130
        rate = float(by_arm[arm]["passRate"] or 0)
        parts.append(
            f'<text x="48" y="{y + 24}" class="label">{esc(ARM_LABELS[arm])}</text>'
        )
        parts.append(
            f'<rect x="{x0}" y="{y}" width="{chart_width}" height="44" rx="12" fill="#151c28"/>'
        )
        parts.append(
            f'<rect x="{x0}" y="{y}" width="{chart_width * rate:.2f}" height="44" rx="12" fill="{ARM_COLORS[arm]}"/>'
        )
        parts.append(
            f'<text x="{x0 + chart_width - 6}" y="{y + 29}" text-anchor="end" class="value">{rate * 100:.1f}% ({by_arm[arm]["passed"]}/{by_arm[arm]["jobs"]})</text>'
        )
    path.write_text(svg_page(width, height, "MCPMark Verified pass rate", "\n  ".join(parts)), encoding="utf-8")


def render_domain_heatmap(
    path: Path, by_domain: dict[str, dict[str, dict[str, Any]]]
) -> None:
    width, height = 980, 610
    cell_width, cell_height = 265, 64
    x0, y0 = 380, 130
    parts = [
        '<text x="48" y="86" class="sub">Pass rate and passed/total by official service</text>'
    ]
    for column, arm in enumerate(ARMS):
        x = x0 + column * cell_width
        parts.append(
            f'<text x="{x + cell_width / 2}" y="112" text-anchor="middle" class="label">{esc(ARM_LABELS[arm])}</text>'
        )
    for row_index, domain in enumerate(DOMAINS):
        y = y0 + row_index * cell_height
        parts.append(
            f'<text x="48" y="{y + 38}" class="label">{esc(DOMAIN_LABELS[domain])}</text>'
        )
        for column, arm in enumerate(ARMS):
            summary = by_domain[domain][arm]
            rate = float(summary["passRate"] or 0)
            x = x0 + column * cell_width
            opacity = 0.18 + 0.72 * rate
            parts.append(
                f'<rect x="{x}" y="{y}" width="{cell_width - 14}" height="{cell_height - 12}" rx="10" fill="{ARM_COLORS[arm]}" fill-opacity="{opacity:.3f}"/>'
            )
            parts.append(
                f'<text x="{x + (cell_width - 14) / 2}" y="{y + 33}" text-anchor="middle" class="value">{rate * 100:.1f}% · {summary["passed"]}/{summary["jobs"]}</text>'
            )
    path.write_text(svg_page(width, height, "MCPMark domain matrix", "\n  ".join(parts)), encoding="utf-8")


def render_paired(path: Path, paired: dict[str, Any]) -> None:
    width, height = 980, 480
    labels = (
        ("Both pass", "bothPass", "#22c55e"),
        ("Native only", "nativeOnlyPass", ARM_COLORS[ARMS[0]]),
        ("Prompt-Only only", "promptOnlyOnlyPass", ARM_COLORS[ARMS[1]]),
        ("Both fail", "bothFail", "#475569"),
    )
    max_value = max(1, *(int(paired[key]) for _, key, _ in labels))
    parts = [
        f'<text x="48" y="86" class="sub">Exact paired outcomes · n={paired["comparable"]} · McNemar p={paired["mcnemarExactP"]:.4g}</text>'
    ]
    for index, (label, key, color) in enumerate(labels):
        y = 132 + index * 75
        value = int(paired[key])
        width_value = 610 * value / max_value
        parts.append(f'<text x="48" y="{y + 27}" class="label">{esc(label)}</text>')
        parts.append(
            f'<rect x="260" y="{y}" width="610" height="38" rx="10" fill="#151c28"/>'
        )
        parts.append(
            f'<rect x="260" y="{y}" width="{width_value:.2f}" height="38" rx="10" fill="{color}"/>'
        )
        parts.append(
            f'<text x="890" y="{y + 26}" class="value">{value}</text>'
        )
    path.write_text(svg_page(width, height, "Native vs Prompt-Only paired outcomes", "\n  ".join(parts)), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--official-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument(
        "--allow-partial",
        action="store_true",
        help="Permit incomplete trees for development checks; summary is marked partial",
    )
    args = parser.parse_args()

    manifest = read_json(args.manifest.resolve())
    expected = expected_tasks(manifest)
    rows, duplicates = discover_rows(args.official_root.resolve(), expected)
    if duplicates:
        raise RuntimeError(f"duplicate result tasks: {', '.join(duplicates[:8])}")

    counts = Counter(str(row["arm"]) for row in rows)
    missing: dict[str, list[str]] = {}
    actual_keys_by_arm = {
        arm: {str(row["taskKey"]) for row in rows if row["arm"] == arm}
        for arm in ARMS
    }
    expected_keys = {
        f"{row['service']}/{row['category']}/{row['taskId']}"
        for row in expected.values()
    }
    for arm in ARMS:
        missing[arm] = sorted(expected_keys - actual_keys_by_arm[arm])
    complete = all(counts[arm] == len(expected) and not missing[arm] for arm in ARMS)
    if not complete and not args.allow_partial:
        detail = ", ".join(
            f"{arm}={counts[arm]}/{len(expected)}" for arm in ARMS
        )
        raise RuntimeError(f"refusing partial MCPMark aggregation: {detail}")

    by_arm = {
        arm: summarize([row for row in rows if row["arm"] == arm]) for arm in ARMS
    }
    by_domain = {
        domain: {
            arm: summarize(
                [
                    row
                    for row in rows
                    if row["arm"] == arm and row["service"] == domain
                ]
            )
            for arm in ARMS
        }
        for domain in DOMAINS
    }
    paired = paired_summary(rows)
    summary = {
        "arms": by_arm,
        "benchmark": "MCPMark Verified",
        "complete": complete,
        "domains": by_domain,
        "manifestCommit": manifest.get("commit"),
        "missing": missing,
        "paired": paired,
        "population": "standard",
        "status": "complete" if complete else "partial-development-only",
        "taskCountPerArm": len(expected),
        "taskSetSha256": manifest.get("taskSetSha256"),
    }

    out_dir = args.out_dir.resolve()
    charts_dir = out_dir / "charts"
    charts_dir.mkdir(parents=True, exist_ok=True)
    write_csv(out_dir / "task-results.csv", rows)
    (out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    render_pass_rate(charts_dir / "mcpmark-pass-rate.svg", by_arm)
    render_domain_heatmap(charts_dir / "mcpmark-domain-matrix.svg", by_domain)
    render_paired(charts_dir / "mcpmark-paired-outcomes.svg", paired)
    print(
        json.dumps(
            {
                "complete": complete,
                "counts": {arm: counts[arm] for arm in ARMS},
                "outDir": str(out_dir),
                "status": summary["status"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
