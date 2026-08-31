#!/usr/bin/env python3
"""Render two Terminal-Bench invalidations and the isolated v4 restart."""

from __future__ import annotations

import argparse
import html
import json
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any


ARMS = (
    ("glm52-native", "Native", "#a78bfa"),
    ("glm52-native-plus", "Native-Plus", "#5eead4"),
)


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected an object")
    return value


def jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            value = json.loads(line)
            if isinstance(value, dict):
                rows.append(value)
    return rows


def render(
    provider_invalid_root: Path,
    orphan_invalid_root: Path,
    replacement_root: Path,
    timestamp: str,
) -> tuple[str, dict[str, object]]:
    provider_invalid = read_json(provider_invalid_root / "run-meta.json")
    orphan_invalid = read_json(orphan_invalid_root / "run-meta.json")
    replacement = read_json(replacement_root / "run-meta.json")
    for label, value in (
        ("v2", provider_invalid),
        ("v3", orphan_invalid),
    ):
        if (
            value.get("status") != "invalid-incomplete"
            or value.get("includedInFinalScore") is not False
            or value.get("resumeAllowed") is not False
        ):
            raise RuntimeError(f"{label} invalidation is not sealed")
    isolation = replacement.get("bridgeIsolation")
    freshness = replacement.get("freshness")
    if (
        replacement.get("bridgeSuite") != "terminalbench2-full-89-fresh-v4"
        or replacement.get("bridgePort") != 8814
        or not isinstance(isolation, dict)
        or isolation.get("preexistingTerminalTaskContainersAtStart") != 0
        or isolation.get("neverReusePredecessorPort") is not True
        or not isinstance(freshness, dict)
        or freshness.get("emptyOutputRootAtStart") is not True
        or freshness.get("resumeFromPriorRun") is not False
    ):
        raise RuntimeError("v4 isolation or freshness gate failed")

    progress = jsonl(replacement_root / "progress.jsonl")
    requests = jsonl(replacement_root / "bridge/requests.jsonl")
    captures = jsonl(replacement_root / "bridge/provider-raw.jsonl")
    counts = {
        arm: sum(row.get("arm") == arm for row in progress) for arm, _, _ in ARMS
    }
    total = int(replacement["taskCountPerArm"])
    v2_observed = provider_invalid["observedAtInvalidation"]
    v2_transients = v2_observed["providerTransientAttempts"][
        "glm52-native-plus"
    ]
    v3_observed = orphan_invalid["observedAtInvalidation"]

    width, height = 1600, 1070
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img">',
        '<rect width="100%" height="100%" rx="30" fill="#05070b"/>',
        "<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:42px;font-weight:780;fill:#f8fafc}.sub{font-size:18px;fill:#94a3b8}.eyebrow{font-size:14px;font-weight:760;letter-spacing:1.4px;fill:#94a3b8}.cardtitle{font-size:22px;font-weight:760;fill:#f8fafc}.body{font-size:16px;fill:#cbd5e1}.small{font-size:14px;fill:#94a3b8}.big{font-size:44px;font-weight:820}.ok{font-size:15px;font-weight:740;fill:#6ee7b7}.bad{font-size:15px;font-weight:740;fill:#fb7185}.warn{font-size:15px;font-weight:740;fill:#fbbf24}</style>",
        '<text x="64" y="72" class="title">Terminal-Bench 2.0 · isolation validity gate</text>',
        f'<text x="64" y="108" class="sub">{esc(timestamp)} · v2 provider outage + v3 orphan traffic excluded → isolated v4</text>',
        '<rect x="64" y="148" width="458" height="316" rx="24" fill="#26151c" stroke="#fb7185" stroke-width="2"/>',
        '<text x="94" y="188" class="eyebrow">FRESH-V2 · PROVIDER CONTAMINATION</text>',
        '<text x="94" y="246" class="big" fill="#fb7185">INVALID</text>',
        f'<text x="94" y="292" class="body">HTTP 503 · {esc(v2_transients["http503"])}</text>',
        f'<text x="94" y="328" class="body">transport timeouts · {esc(v2_transients["transportTimeouts"])}</text>',
        '<text x="94" y="368" class="bad">AgentTimeout timing inseparable</text>',
        f'<text x="94" y="404" class="small">{esc(v2_observed["completedTrajectories"])} / {total * 2} trajectories · no reuse</text>',
        '<rect x="570" y="148" width="458" height="316" rx="24" fill="#281c16" stroke="#f59e0b" stroke-width="2"/>',
        '<text x="600" y="188" class="eyebrow">FRESH-V3 · ORPHAN CONTAINER TRAFFIC</text>',
        '<text x="600" y="246" class="big" fill="#fbbf24">INVALID</text>',
        f'<text x="600" y="292" class="body">foreign Native-Plus BN requests · {esc(v3_observed["foreignNativePlusBnFitRequests"])}</text>',
        f'<text x="600" y="328" class="body">legitimate Native ARS requests · {esc(v3_observed["replacementNativeAdaptiveSamplerRequests"])}</text>',
        '<text x="600" y="368" class="warn">old container reconnected to port 8812</text>',
        '<text x="600" y="404" class="small">0 completed trajectories · 21 captures excluded</text>',
        '<rect x="1076" y="148" width="460" height="316" rx="24" fill="#0f2a24" stroke="#34d399" stroke-width="2"/>',
        '<text x="1106" y="188" class="eyebrow">FRESH-V4 · ISOLATED RESTART</text>',
        '<text x="1106" y="246" class="big" fill="#5eead4">RUNNING</text>',
        '<text x="1106" y="292" class="ok">pre-existing task containers · 0</text>',
        '<text x="1106" y="328" class="ok">never-reused bridge port · 8814</text>',
        '<text x="1106" y="364" class="ok">transient additional attempts · 2</text>',
        f'<text x="1106" y="404" class="small">bridge {len(requests)} requests · {len(captures)} captures</text>',
        '<text x="64" y="528" class="eyebrow">LIVE V4 COMPLETION · COUNTS ONLY</text>',
    ]
    for index, (arm, label, color) in enumerate(ARMS):
        y = 566 + index * 102
        count = counts[arm]
        ratio = count / total if total else 0.0
        parts.extend(
            [
                f'<text x="64" y="{y + 28}" class="cardtitle" fill="{color}">{label}</text>',
                f'<rect x="300" y="{y}" width="980" height="40" rx="12" fill="#172036"/>',
                f'<rect x="300" y="{y}" width="{980 * ratio:.2f}" height="40" rx="12" fill="{color}"/>',
                f'<text x="1510" y="{y + 28}" text-anchor="end" class="cardtitle" fill="{color}">{count} / {total} · {ratio * 100:.2f}%</text>',
            ]
        )
    parts.extend(
        [
            '<rect x="64" y="802" width="1472" height="146" rx="24" fill="#111827"/>',
            '<text x="94" y="842" class="eyebrow">REPLACEMENT SAFEGUARDS</text>',
            '<text x="94" y="880" class="ok">PASS · empty root · no v2/v3 import · no pre-existing Terminal container · unique port</text>',
            '<text x="94" y="918" class="body">Every transient attempt is captured under one request. Exhausted transient failures invalidate the run; ordinary model/task failures stay in the denominator.</text>',
            '<rect x="64" y="976" width="1472" height="50" rx="25" fill="#4a3005"/>',
            f'<text x="800" y="1008" text-anchor="middle" class="warn">SCORE LOCKED UNTIL {total}/{total} BOTH ARMS + OFFICIAL REWARDS + STRICT VALIDATOR PASS</text>',
            "</svg>",
        ]
    )
    return "\n".join(parts) + "\n", {
        "captures": len(captures),
        "counts": counts,
        "providerInvalidSealed": True,
        "orphanInvalidSealed": True,
        "replacementIsolationPassed": True,
        "requests": len(requests),
        "totalPerArm": total,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider-invalid-run", type=Path, required=True)
    parser.add_argument("--orphan-invalid-run", type=Path, required=True)
    parser.add_argument("--replacement-run", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--timestamp")
    args = parser.parse_args()
    timestamp = args.timestamp or datetime.now().astimezone().strftime(
        "%Y-%m-%d %H:%M %Z"
    )
    rendered, summary = render(
        args.provider_invalid_run.resolve(),
        args.orphan_invalid_run.resolve(),
        args.replacement_run.resolve(),
        timestamp,
    )
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
