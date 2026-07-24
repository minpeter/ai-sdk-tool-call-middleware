#!/usr/bin/env python3
"""Render a live fresh-run progress board without computing benchmark scores."""

from __future__ import annotations

import argparse
import html
import json
import subprocess
from datetime import datetime
from pathlib import Path


ARMS = (
    ("Native", "#a78bfa"),
    ("Prompt-only", "#5eead4"),
)


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def jsonl_rows(path: Path) -> int:
    if not path.is_file():
        return 0
    with path.open(encoding="utf-8") as handle:
        return sum(1 for line in handle if line.strip())


def run_is_invalid(root: Path) -> bool:
    meta_path = root / "run-meta.json"
    if not meta_path.is_file():
        return False
    try:
        status = str(json.loads(meta_path.read_text(encoding="utf-8")).get("status"))
    except (json.JSONDecodeError, OSError):
        return True
    return status.startswith("invalid")


def mcpmark_experiment_root(root: Path) -> Path:
    """Resolve the one fresh experiment without hard-coding an old run name."""
    meta_path = root / "run-meta.json"
    if meta_path.is_file():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            meta = {}
        experiment_name = meta.get("experimentName")
        if isinstance(experiment_name, str) and experiment_name:
            return root / "official" / experiment_name

    candidates = sorted(
        path for path in (root / "official").glob("fresh-*") if path.is_dir()
    )
    if len(candidates) != 1:
        return root / "official" / "__unresolved_fresh_experiment__"
    return candidates[0]


def mcpmark_counts(root: Path) -> tuple[int, int]:
    if run_is_invalid(root):
        return 0, 0
    official = mcpmark_experiment_root(root)
    return (
        len(list(official.glob("glm52-native__*/run-*/**/meta.json"))),
        len(list(official.glob("glm52-prompt-only__*/run-*/**/meta.json"))),
    )


def bfcl_count(root: Path, model: str) -> int:
    total = 0
    for path in (root / "official" / model).rglob("*_result.json"):
        if "format_sensitivity" not in path.name:
            total += jsonl_rows(path)
    return total


def bfcl_counts(root: Path) -> tuple[int, int]:
    if run_is_invalid(root):
        return 0, 0
    return (
        bfcl_count(root, "glm52-native"),
        bfcl_count(root, "glm52-prompt-only"),
    )


def ace_count(root: Path, model: str) -> int:
    workdir = root / "workdir" / "result_all"
    return sum(
        jsonl_rows(path)
        for language in ("en", "zh")
        for path in (workdir / f"result_{language}" / model).glob("*_result.json")
    )


def ace_counts(root: Path) -> tuple[int, int]:
    if run_is_invalid(root):
        return 0, 0
    return (
        ace_count(root, "glm52-native-FC"),
        ace_count(root, "glm52-prompt-only-FC"),
    )


def tau3_count(root: Path, suffix: str) -> int:
    total = 0
    simulations = root / "data" / "simulations"
    save_prefix = "fresh-v3"
    meta_path = root / "run-meta.json"
    if meta_path.is_file():
        try:
            configured = json.loads(meta_path.read_text(encoding="utf-8")).get(
                "savePrefix"
            )
        except (json.JSONDecodeError, OSError):
            configured = None
        if isinstance(configured, str) and configured:
            save_prefix = configured
    for path in simulations.glob(f"{save_prefix}-*-{suffix}/results.json"):
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        rows = value.get("simulations") if isinstance(value, dict) else None
        if isinstance(rows, list):
            total += len(rows)
    return total


def tau3_counts(root: Path) -> tuple[int, int]:
    if run_is_invalid(root):
        return 0, 0
    return tau3_count(root, "native"), tau3_count(root, "glm5")


def hammer_counts(root: Path) -> tuple[int, int]:
    if run_is_invalid(root):
        return 0, 0
    return (
        jsonl_rows(root / "glm52-native.jsonl"),
        jsonl_rows(root / "glm52-prompt-only.jsonl"),
    )


def stabletoolbench_counts(root: Path) -> tuple[int, int]:
    if run_is_invalid(root):
        return 0, 0
    outputs = root / "outputs"
    if outputs.is_dir():
        return (
            len(list((outputs / "gpt-native").glob("*/*.json"))),
            len(list((outputs / "gpt-prompt-only").glob("*/*.json"))),
        )
    official = root / "official"
    def count_model(model: str) -> int:
        return sum(
            len(list(path.glob("*_CoT@1.json")))
            for path in (official / model).glob("*")
            if path.is_dir()
        )

    return (
        count_model("gpt-native"),
        count_model("gpt-prompt-only"),
    )


def appworld_run_root(root: Path) -> Path:
    final_roots: list[Path] = []
    for path in sorted(root.glob("final-v*")):
        meta_path = path / "run-meta.json"
        if not meta_path.is_file():
            continue
        try:
            status = str(json.loads(meta_path.read_text(encoding="utf-8")).get("status"))
        except (json.JSONDecodeError, OSError):
            continue
        if status.startswith("invalid"):
            continue
        final_roots.append(path)
    return final_roots[-1] if final_roots else root


def terminalbench_run_root(root: Path) -> Path:
    """Select the newest non-invalid fresh run, never an aborted artifact root."""
    full_roots: list[Path] = []
    for path in sorted(root.glob("full-fresh-v*")):
        meta_path = path / "run-meta.json"
        if not meta_path.is_file():
            continue
        try:
            status = str(json.loads(meta_path.read_text(encoding="utf-8")).get("status"))
        except (json.JSONDecodeError, OSError):
            continue
        if status.startswith("invalid"):
            continue
        full_roots.append(path)
    return full_roots[-1] if full_roots else root


def appworld_counts(root: Path) -> tuple[int, int]:
    final_root = appworld_run_root(root)
    meta_path = final_root / "run-meta.json"
    if not meta_path.is_file():
        return 0, 0
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return 0, 0
    experiments = meta.get("experimentNames")
    if not isinstance(experiments, list) or len(experiments) != 2:
        return 0, 0
    native_experiment, plus_experiment = experiments
    if not isinstance(native_experiment, str) or not isinstance(
        plus_experiment, str
    ):
        return 0, 0
    outputs = final_root / "root" / "experiments" / "outputs"
    base = outputs / "simplified_function_calling_agent" / "local"
    def count_experiment(experiment: str) -> int:
        return sum(
            len(list((base / experiment / split / "tasks").glob("*/misc/finished")))
            for split in ("test_normal", "test_challenge")
        )

    return (
        count_experiment(native_experiment),
        count_experiment(plus_experiment),
    )


def vakra_count(root: Path, model: str) -> int:
    total = 0
    output_root = root / "outputs" / model
    for path in output_root.glob("capability-*/*.json"):
        if path.name.endswith("_tools.json"):
            continue
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if isinstance(value, list):
            total += len(value)
    return total


def vakra_counts(root: Path) -> tuple[int, int]:
    full_roots = sorted(
        path
        for path in root.glob("full-fresh-v*")
        if (path / "run-meta.json").is_file() and not run_is_invalid(path)
    )
    output_root = full_roots[-1] if full_roots else root
    return (
        vakra_count(output_root, "glm52-native"),
        vakra_count(output_root, "glm52-prompt-only"),
    )


def vakra_bridge_root(root: Path) -> Path:
    """Resolve the bridge sibling for the selected fresh VAKRA output root."""
    full_roots = sorted(
        path
        for path in root.glob("full-fresh-v*")
        if (path / "run-meta.json").is_file() and not run_is_invalid(path)
    )
    if not full_roots:
        return root
    candidate = root / f"bridge-{full_roots[-1].name}"
    return candidate if candidate.is_dir() else root


def terminalbench_counts(root: Path) -> tuple[int, int]:
    run_root = terminalbench_run_root(root)
    if run_root == root:
        return 0, 0
    progress = run_root / "progress.jsonl"
    if not progress.is_file():
        return 0, 0
    counts = {"glm52-native": 0, "glm52-prompt-only": 0}
    with progress.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            arm = row.get("arm") if isinstance(row, dict) else None
            if arm in counts:
                counts[arm] += 1
    return counts["glm52-native"], counts["glm52-prompt-only"]


def terminalbench_label(root: Path) -> str:
    """Use the benchmark identity recorded by the selected fresh run."""
    run_root = terminalbench_run_root(root)
    meta_path = run_root / "run-meta.json"
    if not meta_path.is_file():
        # An invalidated attempt still proves the requested release identity,
        # even though it contributes no progress. This prevents a reset board
        # from degrading an exact 2.1 scope back to an ambiguous 2.x label.
        candidates = sorted(
            path
            for path in root.glob("full-fresh-v*")
            if (path / "run-meta.json").is_file()
        )
        if candidates:
            meta_path = candidates[-1] / "run-meta.json"
    if meta_path.is_file():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            meta = {}
        benchmark = meta.get("benchmark")
        if isinstance(benchmark, str) and benchmark:
            return f"{benchmark} · official Harbor population"
    return "Terminal-Bench 2.x · official Harbor population"


def externally_blocked_counts(_: Path) -> tuple[int, int]:
    """Represent suites that cannot start without benchmark-specific access.

    These rows are not campaign work waiting behind the provider admission
    queue.  They require credentials or isolated services that the FreeRouter
    model key cannot replace, so the board must not mislabel them as merely
    pending.
    """
    return 0, 0


def capture_parity(root: Path) -> tuple[int, int]:
    if run_is_invalid(root):
        # Invalid provider traffic is diagnostic evidence, not campaign
        # progress. Keeping it off this board prevents a stale root from
        # looking like an active fresh run.
        return 0, 0
    # Most benchmark roots contain a ``bridge/`` child. VAKRA names the
    # bridge directory as a sibling of its output root and passes that
    # directory directly, so accept either layout without hiding live rows.
    direct_bridge = (
        (root / "requests.jsonl").is_file()
        and (root / "provider-raw.jsonl").is_file()
    )
    bridge = root if direct_bridge else root / "bridge"
    # Provider capture is appended before the bridge request record. Read it first
    # so an active writer has a chance to finish the matching request row.
    captures = jsonl_rows(bridge / "provider-raw.jsonl")
    requests = jsonl_rows(bridge / "requests.jsonl")
    return requests, captures


def render(
    rows: list[tuple[str, int, tuple[int, int], tuple[int, int]]],
    timestamp: str,
) -> str:
    width = 1440
    height = 294 + len(rows) * 176
    x0, bar_width = 420, 840
    cases_per_arm = sum(total for _, total, _, _ in rows)
    trajectories = cases_per_arm * len(ARMS)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">',
        '<rect width="100%" height="100%" rx="30" fill="#05070b"/>',
        "<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:38px;font-weight:760;fill:#f8fafc}.sub{font-size:17px;fill:#94a3b8}.name{font-size:21px;font-weight:700;fill:#f8fafc}.label{font-size:15px;fill:#cbd5e1}.value{font-size:16px;font-weight:720}.audit{font-size:14px;fill:#94a3b8}.pill{font-size:14px;font-weight:740;fill:#6ee7b7}</style>",
        '<text x="64" y="70" class="title">Fresh full-population campaign · live progress</text>',
        f'<text x="64" y="104" class="sub">{esc(timestamp)} · completion counts only · no partial score or historical result reuse</text>',
        '<rect x="64" y="130" width="1312" height="68" rx="18" fill="#111827"/>',
        '<text x="92" y="160" class="audit">CONFIRMED PRIMARY SCOPE</text>',
        f'<text x="92" y="187" class="name">{cases_per_arm:,} cases / arm · {trajectories:,} fresh trajectories</text>',
        '<rect x="1120" y="146" width="220" height="38" rx="19" fill="#064e3b"/>',
        '<text x="1230" y="171" text-anchor="middle" class="pill">PROGRESS, NOT SCORE</text>',
    ]
    for row_index, (name, total, counts, parity) in enumerate(rows):
        top = 238 + row_index * 176
        requests, captures = parity
        parts.extend(
            [
                f'<text x="64" y="{top + 24}" class="name">{esc(name)}</text>',
                f'<text x="64" y="{top + 50}" class="audit">live capture files: {requests:,} request rows · {captures:,} raw rows (non-atomic snapshot; validator is separate)</text>',
            ]
        )
        for arm_index, ((arm_label, color), count) in enumerate(zip(ARMS, counts)):
            y = top + 72 + arm_index * 48
            ratio = min(1.0, count / total if total else 0.0)
            parts.extend(
                [
                    f'<text x="64" y="{y + 23}" class="label">{arm_label}</text>',
                    f'<rect x="{x0}" y="{y}" width="{bar_width}" height="30" rx="10" fill="#172036"/>',
                    f'<rect x="{x0}" y="{y}" width="{bar_width * ratio:.2f}" height="30" rx="10" fill="{color}"/>',
                    f'<text x="1340" y="{y + 22}" text-anchor="end" class="value" fill="{color}">{count:,} / {total:,} · {ratio * 100:.2f}%</text>',
                ]
            )
    parts.extend(
        [
            f'<text x="64" y="{height - 38}" class="audit">Final summaries remain locked until every arm reaches its exact pinned denominator. Failures remain in-population.</text>',
            "</svg>",
        ]
    )
    return "\n".join(parts) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mcpmark-run", type=Path, required=True)
    parser.add_argument("--bfcl-run", type=Path, required=True)
    parser.add_argument("--ace-run", type=Path, required=True)
    parser.add_argument("--tau-run", type=Path)
    parser.add_argument("--hammer-run", type=Path)
    parser.add_argument("--stabletoolbench-run", type=Path)
    parser.add_argument("--toolsandbox-run", type=Path)
    parser.add_argument("--complexfuncbench-run", type=Path)
    parser.add_argument("--appworld-run", type=Path)
    parser.add_argument("--vakra-run", type=Path)
    parser.add_argument("--toolbench-run", type=Path)
    parser.add_argument("--terminalbench-run", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--timestamp")
    args = parser.parse_args()
    rows = [
        (
            "MCPMark Verified standard · full 127 isolated-service gate",
            127,
            mcpmark_counts(args.mcpmark_run),
            capture_parity(args.mcpmark_run),
        ),
        (
            "BFCL V4 all_scoring",
            5217,
            bfcl_counts(args.bfcl_run),
            capture_parity(args.bfcl_run),
        ),
        (
            "ACEBench native-tool adaptation",
            2040,
            ace_counts(args.ace_run),
            capture_parity(args.ace_run),
        ),
    ]
    if args.tau_run is not None:
        rows.append(
            (
                "tau3-bench base",
                375,
                tau3_counts(args.tau_run),
                capture_parity(args.tau_run),
            )
        )
    if args.hammer_run is not None:
        rows.append(
            (
                "HammerBench EN+ZH",
                61075,
                hammer_counts(args.hammer_run),
                capture_parity(args.hammer_run),
            )
        )
    if args.stabletoolbench_run is not None:
        rows.append(
            (
                "StableToolBench official six-group population",
                765,
                stabletoolbench_counts(args.stabletoolbench_run),
                capture_parity(args.stabletoolbench_run),
            )
        )
    if args.toolsandbox_run is not None:
        rows.append(
            (
                "ToolSandbox named_scenarios · BLOCKED: RapidAPI credential",
                1032,
                externally_blocked_counts(args.toolsandbox_run),
                capture_parity(args.toolsandbox_run),
            )
        )
    if args.complexfuncbench_run is not None:
        rows.append(
            (
                "ComplexFuncBench official rows · BLOCKED: RapidAPI + judge",
                1000,
                externally_blocked_counts(args.complexfuncbench_run),
                capture_parity(args.complexfuncbench_run),
            )
        )
    if args.appworld_run is not None:
        rows.append(
            (
                "AppWorld official test_normal + test_challenge",
                585,
                appworld_counts(args.appworld_run),
                capture_parity(appworld_run_root(args.appworld_run)),
            )
        )
    if args.vakra_run is not None:
        rows.append(
            (
                "VAKRA public test · all four capabilities",
                5207,
                vakra_counts(args.vakra_run),
                capture_parity(vakra_bridge_root(args.vakra_run)),
            )
        )
    if args.toolbench_run is not None:
        rows.append(
            (
                "ToolBench original · BLOCKED: ToolBench/RapidAPI execution key",
                1100,
                externally_blocked_counts(args.toolbench_run),
                capture_parity(args.toolbench_run),
            )
        )
    if args.terminalbench_run is not None:
        rows.append(
            (
                terminalbench_label(args.terminalbench_run),
                89,
                terminalbench_counts(args.terminalbench_run),
                capture_parity(terminalbench_run_root(args.terminalbench_run)),
            )
        )
    timestamp = args.timestamp or datetime.now().astimezone().strftime(
        "%Y-%m-%d %H:%M %Z"
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    rendered = render(rows, timestamp)
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
                "out": str(args.out.resolve()),
                "rows": [
                    {"benchmark": name, "counts": counts, "total": total}
                    for name, total, counts, _ in rows
                ],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
