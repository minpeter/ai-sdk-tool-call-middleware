#!/usr/bin/env python3
"""Render the GLM-5.2 parser-superiority report from audited artifacts.

The renderer intentionally separates two evidence planes:

1. same provider-response bytes replayed through Native and Native-Plus; and
2. the same raw canonical GLM text replayed through pinned deployment-reference
   decoders and the production custom parser.

No benchmark score is embedded as a source-of-truth constant.  Numeric claims
are loaded from the same-byte and reference-replay artifacts, validated, copied
to a machine-readable manifest, and then used to generate SVG/PNG figures and
the Korean report.  The ``--allow-pending-reference`` flag exists only for
layout development; publication must run without it.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from render_report_visuals import (
    AMBER,
    BLUE,
    CANVAS,
    CYAN,
    GREEN,
    GRID,
    INK,
    MUTED,
    PANEL,
    RED,
    arrow_path,
    box,
    esc,
    svg_document,
    text_lines,
)
from render_svg_charts import (
    render as render_png,
    sanitized_child_environment,
)


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[1]
RESULTS = ROOT / "results"
DEFAULT_SAME_BYTE_DIR = (
    RESULTS / "2026-07-17-glm5-native-parser-same-byte-audit-v1"
)
DEFAULT_REFERENCE_DIR = (
    RESULTS / "2026-07-17-glm5-reference-parser-replay-v1"
)
DEFAULT_OUT_DIR = (
    RESULTS / "2026-07-17-glm5-parser-superiority-report-v1"
)
DEFAULT_REPORT = ROOT / "REPORT-GLM5-PARSER-SUPERIORITY.ko.md"

PURPLE = "#7c3aed"
PINK = "#db2777"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def biome_write(paths: Iterable[Path]) -> None:
    """Apply the repository's deterministic formatter to generated artifacts."""

    resolved_paths = [path.resolve() for path in paths]
    if not resolved_paths:
        return
    pnpm = shutil.which("pnpm")
    if not pnpm:
        raise RuntimeError("pnpm is required to format generated report artifacts")
    command = [
        pnpm,
        "exec",
        "biome",
        "check",
        "--write",
        f"--config-path={REPO_ROOT / 'biome.jsonc'}",
        "--vcs-enabled=false",
        "--files-ignore-unknown=false",
        *[str(path) for path in resolved_paths],
    ]
    completed = subprocess.run(
        command,
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        env=sanitized_child_environment(),
        text=True,
        timeout=120,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"Biome could not format generated artifacts: {detail}")


def load_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object in {path}")
    return value


def nested(value: dict[str, Any], *keys: str) -> Any:
    current: Any = value
    traversed: list[str] = []
    for key in keys:
        traversed.append(key)
        if not isinstance(current, dict) or key not in current:
            raise ValueError(f"Missing summary field: {'.'.join(traversed)}")
        current = current[key]
    return current


def required_int(value: dict[str, Any], *keys: str) -> int:
    item = nested(value, *keys)
    if isinstance(item, bool) or not isinstance(item, int):
        raise ValueError(f"Expected integer at {'.'.join(keys)}, found {item!r}")
    return item


def required_float(value: dict[str, Any], *keys: str) -> float:
    item = nested(value, *keys)
    if isinstance(item, bool) or not isinstance(item, (int, float)):
        raise ValueError(f"Expected number at {'.'.join(keys)}, found {item!r}")
    return float(item)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def truthy_csv(value: str) -> bool:
    if value not in {"true", "false"}:
        raise ValueError(f"Expected CSV boolean, found {value!r}")
    return value == "true"


@dataclass(frozen=True)
class SameByteEvidence:
    summary_path: Path
    details_path: Path
    run_meta_path: Path
    summary_sha256: str
    details_sha256: str
    run_meta_sha256: str
    provider_calls: int
    raw_request_material_written: bool
    unique_captures: int
    generate_captures: int
    sse_captures: int
    shared_envelope_errors: int
    comparable_envelopes: int
    structured_calls: int
    strict_valid_calls: int
    malformed_calls: int
    repaired_calls: int
    preserved_valid_calls: int
    native_plus_malformed_calls: int
    new_text_fallback_calls: int
    changed_captures: int
    unchanged_accepted_captures: int
    wins: int
    neutral_changes: int
    losses: int
    case_mcnemar_p: float
    call_acceptance_mcnemar_p: float
    chunk_invariant: int
    chunk_invariant_failures: int
    max_sse_byte_variants: int
    max_stream_delta_variants: int
    win_cases: tuple[str, ...]
    neutral_cases: tuple[str, ...]


@dataclass(frozen=True)
class ReferenceMetric:
    parser: str
    total: int
    action_correct: int
    exact_correct: int
    false_positive: int
    false_negative: int
    exact_precision: float
    exact_recall: float


@dataclass(frozen=True)
class NaturalStrictMetric:
    parser: str
    total: int
    correct: int
    protocol_valid: int
    accuracy: float | None


@dataclass(frozen=True)
class NaturalSection:
    name: str
    cases: int
    metrics: tuple[NaturalStrictMetric, ...]
    pairwise_vs_generate: dict[str, dict[str, int]]


@dataclass(frozen=True)
class ReferenceEvidence:
    summary_path: Path
    summary_sha256: str
    caveat: str
    synthetic_cases: int
    synthetic_chunk_invariant: int
    natural_cases: int
    natural_chunk_invariant: int
    metrics: tuple[ReferenceMetric, ...]
    natural_sections: tuple[NaturalSection, ...]
    provider_calls: int
    sources: dict[str, Any]


def load_same_byte_evidence(directory: Path) -> SameByteEvidence:
    summary_path = directory / "summary.json"
    details_path = directory / "strict-discordance.csv"
    run_meta_path = directory / "run-meta.json"
    summary = load_object(summary_path)
    run_meta = load_object(run_meta_path)

    unique_captures = required_int(summary, "corpus", "uniqueNativeCaptures")
    generate_captures = required_int(summary, "corpus", "generateCaptures")
    sse_captures = required_int(summary, "corpus", "sseCaptures")
    structured_calls = required_int(summary, "parser", "nativeStructuredCalls")
    strict_valid_calls = required_int(summary, "parser", "nativeStrictValidCalls")
    malformed_calls = required_int(summary, "parser", "nativeMalformedCalls")
    repaired_calls = required_int(summary, "parser", "repairedMalformedCalls")
    preserved_valid_calls = required_int(
        summary, "parser", "validNativeCallsPreserved"
    )
    native_plus_malformed_calls = required_int(
        summary, "parser", "nativePlusMalformedCalls"
    )
    changed_captures = required_int(summary, "parser", "changedCaptures")
    wins = required_int(summary, "scoring", "wins")
    losses = required_int(summary, "scoring", "losses")
    chunk_invariant = required_int(summary, "stream", "chunkInvariant")
    chunk_invariant_failures = required_int(
        summary, "stream", "chunkInvariantFailures"
    )

    with details_path.open(encoding="utf-8", newline="") as handle:
        changed_rows = list(csv.DictReader(handle))
    require(len(changed_rows) == changed_captures, (
        "strict-discordance.csv row count does not match parser.changedCaptures"
    ))
    for row in changed_rows:
        require(
            truthy_csv(row["callsChanged"]) or truthy_csv(row["textChanged"]),
            "strict-discordance.csv contains an unchanged row",
        )
    outcome_counts = {
        outcome: sum(row["scoreOutcome"] == outcome for row in changed_rows)
        for outcome in {"win", "loss", "neutral-failure", "neutral-success"}
    }
    require(
        outcome_counts["win"] == wins and outcome_counts["loss"] == losses,
        "strict-discordance.csv win/loss counts disagree with summary.json",
    )
    neutral_changes = (
        outcome_counts["neutral-failure"] + outcome_counts["neutral-success"]
    )
    win_cases = tuple(
        row["caseKey"] for row in changed_rows if row["scoreOutcome"] == "win"
    )
    neutral_cases = tuple(
        row["caseKey"]
        for row in changed_rows
        if row["scoreOutcome"].startswith("neutral-")
    )

    require(
        generate_captures + sse_captures == unique_captures,
        "Generate + SSE capture counts must equal unique captures",
    )
    require(
        strict_valid_calls + malformed_calls == structured_calls,
        "Native valid + malformed calls must equal structured calls",
    )
    require(
        repaired_calls == malformed_calls,
        "Every Native malformed call must be accounted for as repaired",
    )
    require(
        preserved_valid_calls == strict_valid_calls,
        "Every already-valid Native call must be preserved",
    )
    require(
        native_plus_malformed_calls == 0,
        "Native-Plus output still contains malformed calls",
    )
    require(
        wins + neutral_changes + losses == changed_captures,
        "Changed-capture outcomes do not partition changed captures",
    )
    require(
        chunk_invariant + chunk_invariant_failures == sse_captures,
        "Chunk-invariance outcomes do not partition SSE captures",
    )
    provider_calls = required_int(run_meta, "providerCalls")
    raw_request_material_written = nested(run_meta, "rawRequestMaterialWritten")
    if not isinstance(raw_request_material_written, bool):
        raise ValueError("run-meta.rawRequestMaterialWritten must be boolean")
    require(provider_calls == 0, "Same-byte audit unexpectedly made provider calls")
    require(
        not raw_request_material_written,
        "Same-byte audit unexpectedly wrote raw request material",
    )

    return SameByteEvidence(
        summary_path=summary_path,
        details_path=details_path,
        run_meta_path=run_meta_path,
        summary_sha256=sha256(summary_path),
        details_sha256=sha256(details_path),
        run_meta_sha256=sha256(run_meta_path),
        provider_calls=provider_calls,
        raw_request_material_written=raw_request_material_written,
        unique_captures=unique_captures,
        generate_captures=generate_captures,
        sse_captures=sse_captures,
        shared_envelope_errors=required_int(
            summary, "envelope", "sharedEnvelopeErrors"
        ),
        comparable_envelopes=required_int(summary, "envelope", "accepted"),
        structured_calls=structured_calls,
        strict_valid_calls=strict_valid_calls,
        malformed_calls=malformed_calls,
        repaired_calls=repaired_calls,
        preserved_valid_calls=preserved_valid_calls,
        native_plus_malformed_calls=native_plus_malformed_calls,
        new_text_fallback_calls=required_int(
            summary, "parser", "newTextFallbackCalls"
        ),
        changed_captures=changed_captures,
        unchanged_accepted_captures=required_int(
            summary, "parser", "unchangedAcceptedCaptures"
        ),
        wins=wins,
        neutral_changes=neutral_changes,
        losses=losses,
        case_mcnemar_p=required_float(summary, "scoring", "exactMcNemarP"),
        call_acceptance_mcnemar_p=required_float(
            summary, "parser", "pairedMalformedCallAcceptanceExactMcNemarP"
        ),
        chunk_invariant=chunk_invariant,
        chunk_invariant_failures=chunk_invariant_failures,
        max_sse_byte_variants=required_int(
            summary, "stream", "maxSseByteChunkVariants"
        ),
        max_stream_delta_variants=required_int(
            summary, "stream", "maxStreamDeltaChunkVariants"
        ),
        win_cases=win_cases,
        neutral_cases=neutral_cases,
    )


def load_reference_evidence(directory: Path) -> ReferenceEvidence:
    summary_path = directory / "summary.json"
    summary = load_object(summary_path)
    metrics_value = nested(summary, "synthetic", "metrics")
    if not isinstance(metrics_value, dict) or not metrics_value:
        raise ValueError("Reference summary has no synthetic parser metrics")
    metrics: list[ReferenceMetric] = []
    for parser, raw_metric in metrics_value.items():
        if not isinstance(raw_metric, dict):
            raise ValueError(f"Expected metric object for {parser}")
        metric = ReferenceMetric(
            parser=parser,
            total=required_int(raw_metric, "total"),
            action_correct=required_int(raw_metric, "actionCorrect"),
            exact_correct=required_int(raw_metric, "exactCorrect"),
            false_positive=required_int(raw_metric, "falsePositive"),
            false_negative=required_int(raw_metric, "falseNegative"),
            exact_precision=required_float(raw_metric, "exactPrecision"),
            exact_recall=required_float(raw_metric, "exactRecall"),
        )
        require(
            0 <= metric.exact_precision <= 1
            and 0 <= metric.exact_recall <= 1,
            f"Reference precision/recall out of range for {parser}",
        )
        require(
            0 <= metric.action_correct <= metric.total
            and 0 <= metric.exact_correct <= metric.total
            and 0 <= metric.false_positive <= metric.total
            and 0 <= metric.false_negative <= metric.total,
            f"Reference counts out of range for {parser}",
        )
        metrics.append(metric)
    synthetic_cases = required_int(summary, "synthetic", "cases")
    require(
        all(metric.total == synthetic_cases for metric in metrics),
        "Synthetic parser totals must equal synthetic.cases",
    )
    sources = nested(summary, "referenceSources")
    if not isinstance(sources, dict):
        raise ValueError("referenceSources must be an object")
    caveat = nested(summary, "caveat")
    if not isinstance(caveat, str) or not caveat:
        raise ValueError("Reference summary caveat is missing")
    provider_calls = required_int(summary, "providerCalls")
    require(provider_calls == 0, "Reference replay unexpectedly made provider calls")
    natural_value = nested(summary, "natural")
    if not isinstance(natural_value, dict) or not natural_value:
        raise ValueError("Reference summary has no natural replay sections")
    natural_sections: list[NaturalSection] = []
    for section_name, raw_section in sorted(natural_value.items()):
        if not isinstance(raw_section, dict):
            raise ValueError(f"Natural section {section_name} is not an object")
        cases = required_int(raw_section, "cases")
        strict = nested(raw_section, "strict")
        if not isinstance(strict, dict):
            raise ValueError(f"Natural section {section_name} has no strict summary")
        by_parser = nested(strict, "byParser")
        pairwise = nested(strict, "pairwiseVsProductionGenerate")
        if not isinstance(by_parser, dict) or not isinstance(pairwise, dict):
            raise ValueError(f"Natural strict summary is malformed: {section_name}")
        section_metrics: list[NaturalStrictMetric] = []
        for parser, raw_metric in by_parser.items():
            if not isinstance(raw_metric, dict):
                raise ValueError(
                    f"Natural strict metric is malformed: {section_name}/{parser}"
                )
            accuracy_value = nested(raw_metric, "accuracy")
            accuracy = (
                None
                if accuracy_value is None
                else required_float(raw_metric, "accuracy")
            )
            metric = NaturalStrictMetric(
                parser=parser,
                total=required_int(raw_metric, "total"),
                correct=required_int(raw_metric, "correct"),
                protocol_valid=required_int(raw_metric, "protocolValid"),
                accuracy=accuracy,
            )
            require(
                metric.total == cases
                and 0 <= metric.correct <= metric.total
                and 0 <= metric.protocol_valid <= metric.total,
                f"Natural strict metric count mismatch: {section_name}/{parser}",
            )
            section_metrics.append(metric)
        normalized_pairwise: dict[str, dict[str, int]] = {}
        for parser, raw_pair in pairwise.items():
            if not isinstance(raw_pair, dict):
                raise ValueError(
                    f"Natural pairwise metric is malformed: {section_name}/{parser}"
                )
            normalized = {
                key: required_int(raw_pair, key)
                for key in ("wins", "losses", "ties")
            }
            require(
                sum(normalized.values()) == cases,
                f"Natural pairwise outcomes do not sum to cases: {section_name}/{parser}",
            )
            normalized_pairwise[parser] = normalized
        natural_sections.append(
            NaturalSection(
                name=section_name,
                cases=cases,
                metrics=tuple(sorted(section_metrics, key=lambda item: parser_order_name(item.parser))),
                pairwise_vs_generate=normalized_pairwise,
            )
        )
    return ReferenceEvidence(
        summary_path=summary_path,
        summary_sha256=sha256(summary_path),
        caveat=caveat,
        synthetic_cases=synthetic_cases,
        synthetic_chunk_invariant=required_int(
            summary, "synthetic", "productionChunkInvariant"
        ),
        natural_cases=required_int(summary, "naturalTotal"),
        natural_chunk_invariant=required_int(
            summary, "naturalProductionChunkInvariant"
        ),
        metrics=tuple(metrics),
        natural_sections=tuple(natural_sections),
        provider_calls=provider_calls,
        sources=sources,
    )


def parser_label(parser: str) -> str:
    return {
        "vllmReference": "vLLM Rust reference",
        "vllmPythonReference": "vLLM Python reference",
        "sglangReference": "SGLang reference",
        "productionGenerate": "Custom · generate",
        "productionStream": "Custom · stream",
    }.get(parser, parser)


def parser_order(metric: ReferenceMetric) -> tuple[int, str]:
    return parser_order_name(metric.parser)


def parser_order_name(parser: str) -> tuple[int, str]:
    order = {
        "vllmReference": 0,
        "vllmPythonReference": 1,
        "sglangReference": 2,
        "productionGenerate": 3,
        "productionStream": 4,
    }
    return (order.get(parser, 99), parser)


def format_p(value: float) -> str:
    return f"{value:.2e}" if value < 0.001 else f"{value:.8f}".rstrip("0")


def format_percent(value: float, digits: int = 1) -> str:
    return f"{value * 100:.{digits}f}%"


def claim_boundary_chart(reference: ReferenceEvidence | None) -> str:
    reference_caption = (
        f"{len(reference.metrics)} parser arms · {reference.synthetic_cases} labeled cases"
        if reference
        else "Reference artifact pending · layout preview only"
    )
    body = [
        '<text x="64" y="70" class="title">What the evidence can — and cannot — claim</text>',
        '<text x="64" y="110" class="subtitle">Two controlled replay planes support two different conclusions. The unknown serving backend stays outside both.</text>',
        box(
            64,
            178,
            430,
            146,
            "Observed FreeRouter response bytes",
            ["Exact same JSON/SSE body", "No second model inference", "Native capture corpus"],
            fill="#eff6ff",
            stroke="#93c5fd",
            title_color="#1d4ed8",
        ),
        box(
            584,
            178,
            430,
            146,
            "Raw canonical GLM text",
            ["Exact same emitted text", "Pinned reference semantics", reference_caption],
            fill="#f5f3ff",
            stroke="#c4b5fd",
            title_color=PURPLE,
        ),
        box(
            1104,
            178,
            432,
            146,
            "FreeRouter backend implementation",
            ["Parser identity not exposed", "Routing / revision unknown", "No backend replacement observed"],
            fill="#fff7ed",
            stroke="#fdba74",
            title_color="#c2410c",
        ),
        arrow_path("M279 324 L279 414", BLUE),
        arrow_path("M799 324 L799 414", PURPLE),
        arrow_path("M1320 324 L1320 414", AMBER, dashed=True),
        box(
            64,
            414,
            430,
            224,
            "Plane A · same-byte Native audit",
            [
                "Compare plain Native client parsing",
                "with production Native-Plus normalization.",
                "Supports: repaired acceptance + preserved calls",
                "and oracle-scored case wins/losses.",
            ],
            fill="#ffffff",
            stroke="#60a5fa",
            title_color="#1d4ed8",
        ),
        box(
            584,
            414,
            430,
            224,
            "Plane B · deployment-reference replay",
            [
                "Compare pinned vLLM / SGLang reproductions",
                "with custom generate + stream parsing.",
                "Supports: labeled conformance precision/recall",
                "and raw-text chunk parity.",
            ],
            fill="#ffffff",
            stroke="#a78bfa",
            title_color=PURPLE,
        ),
        box(
            1104,
            414,
            432,
            224,
            "Explicit non-claim",
            [
                "The FreeRouter server parser was not inspected.",
                "Reference implementations are deployment options,",
                "not evidence of the endpoint's internals.",
                "Serving nondeterminism is a separate live-run issue.",
            ],
            fill="#fff7ed",
            stroke="#fb923c",
            title_color="#c2410c",
        ),
        '<rect x="64" y="708" width="1472" height="132" rx="18" fill="#ecfdf5" stroke="#6ee7b7"/>',
        '<text x="96" y="750" class="section" fill="#047857">Defensible combined conclusion</text>',
        text_lines(
            96,
            786,
            [
                "Native-Plus improves bounded post-provider normalization on identical captured responses;",
                "the custom raw-text parser is evaluated separately against pinned deployment references.",
            ],
            "body",
            26,
        ),
        '<text x="64" y="900" class="small">Source: same-byte summary + strict discordance; reference-replay summary. Dashed orange lane denotes unavailable internal evidence.</text>',
    ]
    return svg_document(
        1600,
        930,
        "GLM-5.2 parser evidence and claim boundary",
        "Two controlled replay planes support separate parser claims while the FreeRouter backend implementation remains unknown.",
        "".join(body),
    )


def call_acceptance_funnel_chart(data: SameByteEvidence) -> str:
    native_rate = data.strict_valid_calls / data.structured_calls
    plus_rate = (
        data.preserved_valid_calls + data.repaired_calls
    ) / data.structured_calls
    body = [
        '<text x="64" y="70" class="title">Same-byte structured-call acceptance funnel</text>',
        '<text x="64" y="110" class="subtitle">Every count is read from the redacted audit summary; the denominator is unchanged across stages.</text>',
        '<rect x="66" y="164" width="1468" height="108" rx="18" fill="#ffffff" stroke="#cbd5e1" class="shadow"/>',
        f'<text x="102" y="207" class="section">Native structured calls</text><text x="1494" y="224" text-anchor="end" class="metric">{data.structured_calls:,}</text>',
        f'<text x="102" y="244" class="body">Same provider response bytes · accepted envelopes only</text>',
        arrow_path("M800 272 L800 326", MUTED),
        box(
            66,
            326,
            700,
            178,
            "Already strict-valid",
            [
                f"{data.strict_valid_calls:,} / {data.structured_calls:,} · {format_percent(native_rate)}",
                "Native-Plus preserved every call exactly",
                f"preserved: {data.preserved_valid_calls:,} / {data.strict_valid_calls:,}",
            ],
            fill="#eff6ff",
            stroke="#93c5fd",
            title_color="#1d4ed8",
        ),
        box(
            834,
            326,
            700,
            178,
            "Malformed Native arguments",
            [
                f"{data.malformed_calls:,} / {data.structured_calls:,}",
                "Bounded repair accepted every malformed call",
                f"repaired: {data.repaired_calls:,} / {data.malformed_calls:,}",
            ],
            fill="#fff7ed",
            stroke="#fdba74",
            title_color="#c2410c",
        ),
        arrow_path("M416 504 L416 580", BLUE),
        arrow_path("M1184 504 L1184 580", AMBER),
        '<rect x="66" y="580" width="1468" height="142" rx="18" fill="#ecfdf5" stroke="#6ee7b7" class="shadow"/>',
        f'<text x="102" y="626" class="section" fill="#047857">Native-Plus strict-valid output</text><text x="1494" y="654" text-anchor="end" class="metric" fill="#047857">{data.preserved_valid_calls + data.repaired_calls:,} / {data.structured_calls:,}</text>',
        f'<text x="102" y="674" class="body">{data.preserved_valid_calls:,} unchanged + {data.repaired_calls:,} recovered · {format_percent(plus_rate)} acceptance</text>',
        f'<text x="102" y="704" class="small">Paired call-acceptance exact McNemar p = {esc(format_p(data.call_acceptance_mcnemar_p))}</text>',
        '<rect x="66" y="778" width="1468" height="94" rx="16" fill="#f5f3ff" stroke="#c4b5fd"/>',
        f'<text x="102" y="817" class="label" fill="{PURPLE}">Separate fallback lane</text><text x="1494" y="830" text-anchor="end" class="metric" fill="{PURPLE}">+{data.new_text_fallback_calls}</text>',
        '<text x="102" y="850" class="body">New text-derived calls are not part of the 1,729 Native structured-call denominator.</text>',
        '<text x="66" y="925" class="small">Interpretation: p-value above is parser acceptance, not case-level semantic correctness.</text>',
    ]
    return svg_document(
        1600,
        960,
        "Same-byte GLM-5.2 Native-Plus structured-call acceptance funnel",
        "Of all Native structured calls, already-valid calls were preserved and malformed calls were repaired; text fallback calls are shown separately.",
        "".join(body),
    )


def strict_outcome_chart(data: SameByteEvidence) -> str:
    outcomes = [
        ("Strict win", data.wins, GREEN, "Native wrong → Native-Plus correct"),
        (
            "Still-wrong neutral",
            data.neutral_changes,
            AMBER,
            "Output changed, oracle outcome stayed wrong",
        ),
        ("Strict loss", data.losses, RED, "Native correct → Native-Plus wrong"),
    ]
    maximum = max(1, *(count for _, count, _, _ in outcomes))
    body = [
        '<text x="64" y="70" class="title">Oracle-scored outcomes among changed captures</text>',
        f'<text x="64" y="110" class="subtitle">Only the {data.changed_captures} responses whose calls or text changed are shown. Unchanged captures are outside this panel.</text>',
        '<rect x="64" y="158" width="1472" height="536" rx="20" fill="#ffffff" stroke="#cbd5e1" class="shadow"/>',
    ]
    for index, (label, count, color, note) in enumerate(outcomes):
        y = 222 + index * 144
        width = 900 * count / maximum
        body.extend(
            [
                f'<text x="104" y="{y + 29}" class="section">{esc(label)}</text>',
                f'<rect x="424" y="{y}" width="900" height="54" rx="12" fill="#f1f5f9"/>',
                f'<rect x="424" y="{y}" width="{width}" height="54" rx="12" fill="{color}"/>',
                f'<text x="1364" y="{y + 38}" class="metric" fill="{color}">{count}</text>',
                f'<text x="424" y="{y + 82}" class="body">{esc(note)}</text>',
            ]
        )
    body.extend(
        [
            '<rect x="64" y="744" width="710" height="132" rx="18" fill="#eff6ff" stroke="#93c5fd"/>',
            f'<text x="96" y="788" class="section" fill="#1d4ed8">Case-level exact McNemar</text><text x="742" y="809" text-anchor="end" class="metric" fill="#1d4ed8">p = {esc(format_p(data.case_mcnemar_p))}</text>',
            f'<text x="96" y="842" class="body">{data.wins} semantic wins and {data.losses} losses are directional; interpret them separately from the call-acceptance test.</text>',
            '<rect x="826" y="744" width="710" height="132" rx="18" fill="#f0fdf4" stroke="#86efac"/>',
            f'<text x="858" y="788" class="section" fill="#047857">Unchanged accepted captures</text><text x="1504" y="809" text-anchor="end" class="metric" fill="#047857">{data.unchanged_accepted_captures:,}</text>',
            '<text x="858" y="842" class="body">Native-Plus left their accepted call/text output exact.</text>',
            '<text x="64" y="928" class="small">Source: strict-discordance.csv cross-checked against summary.json. Neutral means no semantic gain, not parser failure.</text>',
        ]
    )
    return svg_document(
        1600,
        960,
        "Strict outcomes among same-byte Native-Plus changed captures",
        f"Changed captures produced {data.wins} strict wins, {data.neutral_changes} still-wrong neutral outcomes, and {data.losses} losses.",
        "".join(body),
    )


def hex_rgb(color: str) -> tuple[int, int, int]:
    value = color.removeprefix("#")
    if len(value) != 6:
        raise ValueError(f"Expected six-digit hex color, found {color}")
    return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4))


def blend(left: str, right: str, ratio: float) -> str:
    ratio = max(0.0, min(1.0, ratio))
    left_rgb = hex_rgb(left)
    right_rgb = hex_rgb(right)
    values = [
        round(start + (finish - start) * ratio)
        for start, finish in zip(left_rgb, right_rgb, strict=True)
    ]
    return "#" + "".join(f"{value:02x}" for value in values)


def conformance_heatmap_chart(reference: ReferenceEvidence | None) -> str:
    width, height = 1600, 980
    if reference is None:
        body = [
            '<text x="64" y="70" class="title">Conformance precision / recall / false positives</text>',
            '<text x="64" y="110" class="subtitle">Layout preview only. Publication mode refuses to emit this placeholder.</text>',
            '<rect x="64" y="178" width="1472" height="620" rx="22" fill="#fff7ed" stroke="#fdba74" class="shadow"/>',
            '<text x="800" y="376" text-anchor="middle" class="metric" fill="#c2410c">REFERENCE ARTIFACT PENDING</text>',
            '<text x="800" y="430" text-anchor="middle" class="section">No precision, recall, or false-positive value has been invented.</text>',
            '<text x="800" y="484" text-anchor="middle" class="body">Expected input: results/2026-07-17-glm5-reference-parser-replay-v1/summary.json</text>',
            '<text x="800" y="530" text-anchor="middle" class="body">Rerun without --allow-pending-reference before publishing.</text>',
            '<text x="64" y="926" class="small">PENDING is a development state and must not appear in the final report artifact.</text>',
        ]
        return svg_document(
            width,
            height,
            "Pending GLM-5.2 parser conformance heatmap",
            "A development placeholder with no fabricated reference-parser values.",
            "".join(body),
        )

    metrics = sorted(reference.metrics, key=parser_order)
    body = [
        '<text x="64" y="70" class="title">Labeled parser conformance and corruption corpus</text>',
        f'<text x="64" y="110" class="subtitle">Exact-call metrics on {reference.synthetic_cases} official-template-derived cases. Deployment references are pinned reproductions, not FreeRouter internals.</text>',
        '<rect x="64" y="164" width="1472" height="650" rx="20" fill="#ffffff" stroke="#cbd5e1" class="shadow"/>',
        '<rect x="416" y="196" width="330" height="64" fill="#f1f5f9" stroke="#cbd5e1"/>',
        '<rect x="746" y="196" width="330" height="64" fill="#f1f5f9" stroke="#cbd5e1"/>',
        '<rect x="1076" y="196" width="330" height="64" fill="#f1f5f9" stroke="#cbd5e1"/>',
        '<text x="581" y="236" text-anchor="middle" class="label">Exact precision</text>',
        '<text x="911" y="236" text-anchor="middle" class="label">Exact recall</text>',
        '<text x="1241" y="236" text-anchor="middle" class="label">False positives</text>',
    ]
    row_height = 98
    for index, metric in enumerate(metrics):
        y = 260 + index * row_height
        is_custom = metric.parser.startswith("production")
        label_fill = "#f5f3ff" if is_custom else "#f8fafc"
        label_stroke = "#c4b5fd" if is_custom else "#cbd5e1"
        precision_fill = blend("#fee2e2", "#bbf7d0", metric.exact_precision)
        recall_fill = blend("#fee2e2", "#bbf7d0", metric.exact_recall)
        fp_ratio = metric.false_positive / max(1, metric.total)
        fp_fill = blend("#dcfce7", "#fecaca", min(1, fp_ratio * 5))
        body.extend(
            [
                f'<rect x="94" y="{y}" width="322" height="{row_height}" fill="{label_fill}" stroke="{label_stroke}"/>',
                f'<text x="116" y="{y + 43}" class="label" fill="{PURPLE if is_custom else INK}">{esc(parser_label(metric.parser))}</text>',
                f'<text x="116" y="{y + 70}" class="small">exact {metric.exact_correct}/{metric.total} · action {metric.action_correct}/{metric.total}</text>',
                f'<rect x="416" y="{y}" width="330" height="{row_height}" fill="{precision_fill}" stroke="#ffffff"/>',
                f'<text x="581" y="{y + 59}" text-anchor="middle" class="metric">{format_percent(metric.exact_precision)}</text>',
                f'<rect x="746" y="{y}" width="330" height="{row_height}" fill="{recall_fill}" stroke="#ffffff"/>',
                f'<text x="911" y="{y + 59}" text-anchor="middle" class="metric">{format_percent(metric.exact_recall)}</text>',
                f'<rect x="1076" y="{y}" width="330" height="{row_height}" fill="{fp_fill}" stroke="#ffffff"/>',
                f'<text x="1241" y="{y + 50}" text-anchor="middle" class="metric">{metric.false_positive}</text>',
                f'<text x="1241" y="{y + 75}" text-anchor="middle" class="small">of {metric.total}</text>',
            ]
        )
    bottom = 260 + len(metrics) * row_height
    body.extend(
        [
            f'<rect x="94" y="{bottom + 26}" width="1312" height="88" rx="14" fill="#eff6ff" stroke="#93c5fd"/>',
            text_lines(
                118,
                bottom + 60,
                [
                    "Precision = exact TP / (exact TP + false positive); recall = exact TP / expected-positive.",
                    "Counts and definitions come directly from the labeled replay artifact.",
                ],
                "body",
                24,
            ),
            '<text x="64" y="946" class="small">Source: reference-replay summary.synthetic.metrics. Green is better for precision/recall; zero is better for false positives.</text>',
        ]
    )
    return svg_document(
        width,
        height,
        "GLM-5.2 parser conformance precision recall and false positives",
        f"Exact precision, recall, and false-positive counts for {len(metrics)} parsers on {reference.synthetic_cases} labeled cases.",
        "".join(body),
    )


def stream_invariance_chart(
    same_byte: SameByteEvidence, reference: ReferenceEvidence | None
) -> str:
    natural_value = (
        f"{reference.natural_chunk_invariant:,} / {reference.natural_cases:,}"
        if reference
        else "PENDING"
    )
    synthetic_value = (
        f"{reference.synthetic_chunk_invariant:,} / {reference.synthetic_cases:,}"
        if reference
        else "PENDING"
    )
    natural_note = (
        "whole/captured, 1-char, 7-char, seeded chunk strategies"
        if reference
        else "reference summary not loaded"
    )
    body = [
        '<text x="64" y="70" class="title">Generate, SSE, and chunk-invariance evidence</text>',
        '<text x="64" y="110" class="subtitle">Transport coverage and rechunk parity are shown separately from semantic benchmark accuracy.</text>',
        box(
            64,
            174,
            452,
            198,
            "Same-byte capture corpus",
            [
                f"Generate responses: {same_byte.generate_captures:,}",
                f"SSE responses: {same_byte.sse_captures:,}",
                f"Unique responses: {same_byte.unique_captures:,}",
                "No provider re-generation during replay",
            ],
            fill="#eff6ff",
            stroke="#93c5fd",
            title_color="#1d4ed8",
        ),
        box(
            574,
            174,
            452,
            198,
            "Native-Plus SSE invariance",
            [
                f"Invariant: {same_byte.chunk_invariant}/{same_byte.sse_captures}",
                f"Failures: {same_byte.chunk_invariant_failures}",
                f"Raw SSE byte variants: up to {same_byte.max_sse_byte_variants}",
                f"Internal delta variants: up to {same_byte.max_stream_delta_variants}",
            ],
            fill="#ecfdf5",
            stroke="#6ee7b7",
            title_color="#047857",
        ),
        box(
            1084,
            174,
            452,
            198,
            "Reference raw-text replay",
            [
                f"Natural chunk invariant: {natural_value}",
                f"Synthetic chunk invariant: {synthetic_value}",
                natural_note,
                "Custom generate is the parity baseline",
            ],
            fill="#f5f3ff" if reference else "#fff7ed",
            stroke="#c4b5fd" if reference else "#fdba74",
            title_color=PURPLE if reference else "#c2410c",
        ),
        arrow_path("M516 273 L574 273", BLUE),
        arrow_path("M1026 273 L1084 273", PURPLE),
        '<rect x="64" y="454" width="1472" height="300" rx="20" fill="#ffffff" stroke="#cbd5e1" class="shadow"/>',
        '<text x="96" y="500" class="section">What chunk invariance means</text>',
        box(
            100,
            538,
            384,
            132,
            "1 · Same text / bytes",
            ["Hold content constant", "Only boundaries move"],
            fill="#f8fafc",
        ),
        box(
            608,
            538,
            384,
            132,
            "2 · Rechunk repeatedly",
            ["One-character + fixed + seeded", "SSE byte and stream-delta layers"],
            fill="#f8fafc",
        ),
        box(
            1116,
            538,
            384,
            132,
            "3 · Compare final lifecycle",
            ["Calls and text exact", "Balanced start/delta/end"],
            fill="#f8fafc",
        ),
        arrow_path("M484 604 L608 604", MUTED),
        arrow_path("M992 604 L1116 604", MUTED),
        '<rect x="64" y="814" width="1472" height="86" rx="14" fill="#fefce8" stroke="#fde047"/>',
        '<text x="96" y="850" class="label" fill="#854d0e">Scope boundary</text>',
        '<text x="96" y="879" class="body">This proves deterministic parsing under boundary changes; it does not measure TTFT or first-tool-call latency.</text>',
        '<text x="64" y="956" class="small">Sources: same-byte summary.stream and reference summary natural/synthetic productionChunkInvariant.</text>',
    ]
    return svg_document(
        1600,
        990,
        "Generate SSE and chunk-invariance evidence",
        "Generate and SSE corpus coverage plus deterministic chunk-boundary parity for same-byte and raw-text parser replays.",
        "".join(body),
    )


def native_plus_architecture_chart() -> str:
    body = [
        '<text x="64" y="70" class="title">GLM-5.2 Native-Plus parsing architecture</text>',
        '<text x="64" y="110" class="subtitle">Provider Native remains primary. Repair and text fallback are bounded, schema-aware, and ordered by Native-wins arbitration.</text>',
        box(
            64,
            178,
            320,
            132,
            "Provider response",
            ["Native structured calls", "Assistant text · JSON or SSE"],
            fill="#eff6ff",
            stroke="#93c5fd",
            title_color="#1d4ed8",
        ),
        arrow_path("M384 244 L470 244", BLUE),
        box(
            470,
            178,
            330,
            132,
            "Envelope decode",
            ["Generate or real SSE", "Shared envelope errors stay shared"],
            fill="#ffffff",
        ),
        arrow_path("M800 244 L886 244", BLUE),
        box(
            886,
            178,
            330,
            132,
            "Native call present?",
            ["Yes → Native-primary lane", "No → text-fallback lane"],
            fill="#f5f3ff",
            stroke="#c4b5fd",
            title_color=PURPLE,
        ),
        arrow_path("M996 310 L996 350 L290 350 L290 388", BLUE),
        arrow_path("M1106 310 L1106 350 L1310 350 L1310 388", PURPLE),
        box(
            64,
            388,
            452,
            222,
            "Native-primary lane",
            [
                "Preserve already-valid structured calls",
                "Repair bounded relaxed JSON / final delimiter",
                "Recover opaque object references only where",
                "schema explicitly permits arbitrary properties",
                "Native call suppresses any text fallback",
            ],
            fill="#eff6ff",
            stroke="#60a5fa",
            title_color="#1d4ed8",
        ),
        box(
            574,
            388,
            452,
            222,
            "Fail-closed safety gates",
            [
                "Declared tool + schema validation",
                "Duplicate / prototype-sensitive key rejection",
                "Bounded bytes, depth, and named arguments",
                "No operators, call arguments, or semicolons",
                "Ambiguous or unbounded truncation stays non-call",
            ],
            fill="#fff7ed",
            stroke="#fdba74",
            title_color="#c2410c",
        ),
        box(
            1084,
            388,
            452,
            222,
            "Text-fallback lane",
            [
                "Only when Native emitted zero calls",
                "Canonical GLM XML with schema coercion",
                "or whole-response anchored bare call",
                "Unknown tool / unsafe input rejected",
                "Fallback text removed only after acceptance",
            ],
            fill="#f5f3ff",
            stroke="#a78bfa",
            title_color=PURPLE,
        ),
        arrow_path("M516 500 L574 500", AMBER),
        arrow_path("M1084 500 L1026 500", AMBER),
        arrow_path("M800 610 L800 704", GREEN),
        '<rect x="64" y="704" width="1472" height="154" rx="20" fill="#ecfdf5" stroke="#6ee7b7" class="shadow"/>',
        '<text x="96" y="748" class="section" fill="#047857">Unified AI SDK output and stream lifecycle</text>',
        text_lines(
            96,
            786,
            [
                "Schema-valid tool-call parts + remaining assistant text · native-wins arbitration",
                "SSE finalization holds uncertain deltas until calls are accepted, then balances start / delta / end.",
            ],
            "body",
            27,
        ),
        '<text x="64" y="926" class="small">Sources: glm5-native-call-repair.ts, glm5-native-text-fallback.ts, native-primary-stream.ts, preconfigured-middleware.ts.</text>',
    ]
    return svg_document(
        1600,
        960,
        "GLM-5.2 Native-Plus parsing architecture",
        "Provider-native calls stay primary while bounded repair, guarded text fallback, and stream lifecycle handling converge into AI SDK output.",
        "".join(body),
    )


def relative_link(target: Path, report_path: Path) -> str:
    return Path(os.path.relpath(target, report_path.parent)).as_posix()


def find_reference_metric(
    reference: ReferenceEvidence, parser: str
) -> ReferenceMetric:
    for metric in reference.metrics:
        if metric.parser == parser:
            return metric
    raise ValueError(f"Reference summary has no {parser} metric")


def dominance_result(reference: ReferenceEvidence) -> tuple[bool, list[str]]:
    custom = find_reference_metric(reference, "productionGenerate")
    references = [
        metric for metric in reference.metrics if metric.parser.endswith("Reference")
    ]
    require(references, "Reference summary has no deployment-reference metrics")
    not_dominated: list[str] = []
    for metric in references:
        no_worse = (
            custom.exact_precision >= metric.exact_precision
            and custom.exact_recall >= metric.exact_recall
            and custom.false_positive <= metric.false_positive
            and custom.exact_correct >= metric.exact_correct
        )
        strictly_better = (
            custom.exact_precision > metric.exact_precision
            or custom.exact_recall > metric.exact_recall
            or custom.false_positive < metric.false_positive
            or custom.exact_correct > metric.exact_correct
        )
        if not (no_worse and strictly_better):
            not_dominated.append(metric.parser)
    return not not_dominated, not_dominated


def report_source_link(path: Path, report_path: Path, label: str) -> str:
    return f"[{label}]({relative_link(path, report_path)})"


def render_korean_report(
    same_byte: SameByteEvidence,
    reference: ReferenceEvidence | None,
    out_dir: Path,
    report_path: Path,
) -> str:
    charts = out_dir / "charts"
    source_summary = report_source_link(
        same_byte.summary_path, report_path, "same-byte summary.json"
    )
    source_discordance = report_source_link(
        same_byte.details_path, report_path, "strict-discordance.csv"
    )
    source_run_meta = report_source_link(
        same_byte.run_meta_path, report_path, "same-byte run-meta.json"
    )
    reference_summary = (
        report_source_link(
            reference.summary_path, report_path, "reference-replay summary.json"
        )
        if reference
        else "`PENDING: reference-replay summary.json`"
    )
    image = lambda name, alt: (
        f"![{alt}]({relative_link(charts / f'{name}.png', report_path)})"
    )
    call_acceptance_rate = (
        same_byte.strict_valid_calls / same_byte.structured_calls
    )
    plus_acceptance_rate = (
        same_byte.preserved_valid_calls + same_byte.repaired_calls
    ) / same_byte.structured_calls

    if reference:
        dominates, not_dominated = dominance_result(reference)
        if dominates:
            reference_gate = (
                "라벨 corpus의 exact precision·recall·false positive·exact correct를 "
                "함께 본 사전 정의 dominance gate에서 custom generate가 모든 pinned "
                "deployment reference보다 나쁘지 않고 각 reference 대비 적어도 한 지표가 "
                "엄격히 우수했다. 따라서 **이 라벨 corpus 범위에서는 custom parser "
                "superiority gate를 통과했다.**"
            )
        else:
            labels = ", ".join(parser_label(parser) for parser in not_dominated)
            reference_gate = (
                "사전 정의 dominance gate를 완전히 통과하지 못했다. custom generate가 "
                f"동시에 지배하지 못한 arm은 {labels}이다. 따라서 reference superiority를 "
                "일반 결론으로 선언하지 않는다."
            )
    else:
        reference_gate = (
            "**PENDING — layout preview only.** Reference replay artifact가 아직 없으므로 "
            "precision, recall, false positive 또는 superiority 결론을 기입하지 않았다."
        )

    if reference:
        bfcl_natural = next(
            section
            for section in reference.natural_sections
            if section.name == "bfcl-generate"
        )
        ace_natural = next(
            section
            for section in reference.natural_sections
            if section.name == "ace-generate"
        )
        bfcl_custom = next(
            metric
            for metric in bfcl_natural.metrics
            if metric.parser == "productionGenerate"
        )
        bfcl_vllm = next(
            metric
            for metric in bfcl_natural.metrics
            if metric.parser == "vllmReference"
        )
        bfcl_sglang = next(
            metric
            for metric in bfcl_natural.metrics
            if metric.parser == "sglangReference"
        )
        ace_custom = next(
            metric
            for metric in ace_natural.metrics
            if metric.parser == "productionGenerate"
        )
        ace_vllm = next(
            metric
            for metric in ace_natural.metrics
            if metric.parser == "vllmReference"
        )
        natural_boundary = (
            f"Natural canonical capture에서는 custom이 BFCL {bfcl_custom.correct}/{bfcl_custom.total}, "
            f"vLLM Rust {bfcl_vllm.correct}/{bfcl_vllm.total}, SGLang "
            f"{bfcl_sglang.correct}/{bfcl_sglang.total}이었고, ACE는 custom "
            f"{ace_custom.correct}/{ace_custom.total}, vLLM Rust "
            f"{ace_vllm.correct}/{ace_vllm.total}이었다. 따라서 labeled corruption corpus의 "
            "superiority를 모든 natural score의 우월성으로 확장하지 않는다."
        )
    else:
        natural_boundary = "PENDING — natural reference replay 결과가 아직 없다."

    lines = [
        "# GLM‑5.2 도구 호출 파서 우월성 검증",
        "",
        "작성일: 2026-07-17 (Asia/Seoul)",
        "",
        "<!-- Generated by render_parser_superiority_report.py. Numeric claims come from the linked artifacts. -->",
        "",
        "## Executive Summary",
        "",
        "이번 재검증은 서로 다른 질문을 두 개의 통제된 replay plane으로 분리했다. "
        "첫째, 이미 관측된 provider 응답 바이트를 plain Native와 production Native‑Plus에 "
        "동일하게 넣어 post-provider normalization의 효과만 측정했다. 둘째, canonical GLM "
        "raw text를 pinned vLLM/SGLang deployment-reference decoder와 custom generate/stream "
        "parser에 동일하게 넣어 parser semantics를 비교했다.",
        "",
        f"1. **동일 바이트 call acceptance는 {same_byte.strict_valid_calls:,}/{same_byte.structured_calls:,}에서 "
        f"{same_byte.preserved_valid_calls + same_byte.repaired_calls:,}/{same_byte.structured_calls:,}로 개선됐다.** "
        f"기존 strict-valid {same_byte.preserved_valid_calls:,}개를 모두 보존하고 malformed "
        f"{same_byte.repaired_calls}개를 모두 복구했다. paired call-acceptance exact McNemar "
        f"p={format_p(same_byte.call_acceptance_mcnemar_p)}다.",
        f"2. **oracle-scored changed capture는 {same_byte.wins}승·{same_byte.neutral_changes}중립·{same_byte.losses}패였다.** "
        f"strict semantic case-level exact McNemar p={format_p(same_byte.case_mcnemar_p)}이므로, "
        "방향성은 좋지만 call-acceptance 유의성과 semantic correctness 유의성을 혼동하지 않는다.",
        f"3. **SSE {same_byte.chunk_invariant}/{same_byte.sse_captures}가 chunk-invariant였다.** "
        f"응답당 raw SSE byte 분할과 internal stream-delta 분할을 각각 최대 "
        f"{same_byte.max_sse_byte_variants}개까지 바꾸어도 최종 call/text lifecycle이 같았다.",
        f"4. **Reference gate:** {reference_gate}",
        f"5. **Natural raw-capture score는 별도 경계다.** {natural_boundary}",
        "6. **FreeRouter backend parser를 식별하거나 교체했다고 주장하지 않는다.** vLLM과 "
        "SGLang은 pinned deployment-reference reproduction이며 endpoint 내부 구현은 공개되지 않았다.",
        "",
        image("01-claim-boundary", "evidence and claim boundary"),
        "",
        "## 1. 증거 경계와 질문 분리",
        "",
        "| Evidence plane | 고정한 것 | 바꾼 것 | 허용되는 주장 |",
        "|---|---|---|---|",
        "| A. Same-byte Native audit | provider JSON/SSE response body | client-side Native vs Native‑Plus parsing | 동일 응답에서 bounded normalization이 acceptance와 oracle outcome을 어떻게 바꾸는가 |",
        "| B. Raw-text reference replay | canonical GLM text와 tool schema | pinned reference vs custom parser | 동일 text에서 parser conformance·corruption recovery가 어떻게 다른가 |",
        "| Unknown backend | 관측 불가 | 관측 불가 | FreeRouter 내부 parser, routing, serving revision을 추론하지 않음 |",
        "",
        "이 경계가 중요한 이유는 live arm을 두 번 호출해 얻은 점수 차이가 serving "
        "비결정성을 포함하기 때문이다. 이전 live Native/Native‑Plus snapshot의 score 차이는 "
        "middleware intervention이 0이었던 구간을 포함하므로 parser 효과의 primary evidence로 "
        "사용하지 않는다. 이번 보고서의 parser 귀속 결론은 동일 response bytes 또는 동일 raw "
        "text replay에 한정한다.",
        "",
        "## 2. Native‑Plus 설계",
        "",
        image("06-native-plus-architecture", "Native-Plus parser architecture"),
        "",
        "Native‑Plus는 별도 text protocol이 아니라 Native-primary normalization layer다. "
        "provider-native structured call과 history를 우선 보존하고, bounded relaxed-JSON·마지막 "
        "delimiter·명시적으로 open object인 schema의 opaque reference만 제한적으로 복구한다. "
        "Native call이 하나라도 있으면 text fallback은 억제한다. Native call이 전혀 없을 때만 "
        "canonical XML 또는 응답 전체에 anchored된 bare call을 검사한다.",
        "",
        "Fail-closed gate는 duplicate argument, undeclared tool, prototype-sensitive key, operator, "
        "argument가 있는 call expression, semicolon을 거부한다. 증명 가능한 close-only "
        "truncation만 bounded 복구하고 ambiguous 또는 unbounded truncation은 non-call로 남긴다. stream은 "
        "확정 전 delta를 조정해 최종 tool lifecycle과 generate 결과를 맞춘다.",
        "",
        "## 3. Same-byte Native audit",
        "",
        f"Source: {source_summary}, {source_discordance}, {source_run_meta}",
        "",
        "### 3.1 Corpus와 envelope 경계",
        "",
        "| Metric | Result | Artifact field |",
        "|---|---:|---|",
        f"| Unique Native responses | {same_byte.unique_captures:,} | `corpus.uniqueNativeCaptures` |",
        f"| Generate / SSE | {same_byte.generate_captures:,} / {same_byte.sse_captures:,} | `corpus.generateCaptures`, `corpus.sseCaptures` |",
        f"| Shared envelope errors | {same_byte.shared_envelope_errors:,} | `envelope.sharedEnvelopeErrors` |",
        f"| Comparable accepted envelopes | {same_byte.comparable_envelopes:,} | `envelope.accepted` |",
        f"| Provider calls during replay | {same_byte.provider_calls} | `run-meta.providerCalls` |",
        f"| Raw request material written | {str(same_byte.raw_request_material_written).lower()} | `run-meta.rawRequestMaterialWritten` |",
        "",
        "shared envelope error는 두 parser가 함께 받지 못한 transport/envelope 문제이므로 parser "
        "귀속 분모에서 분리했다. same-byte audit는 새 model inference를 수행하지 않았다.",
        "",
        "### 3.2 Call acceptance",
        "",
        image("02-call-acceptance-funnel", "same-byte call acceptance funnel"),
        "",
        "| Stage | Calls | Rate |",
        "|---|---:|---:|",
        f"| Native structured calls | {same_byte.structured_calls:,} | 100% |",
        f"| Native strict-valid | {same_byte.strict_valid_calls:,} | {format_percent(call_acceptance_rate, 2)} |",
        f"| Valid Native calls preserved | {same_byte.preserved_valid_calls:,}/{same_byte.strict_valid_calls:,} | 100% |",
        f"| Malformed Native calls repaired | {same_byte.repaired_calls}/{same_byte.malformed_calls} | 100% |",
        f"| Native‑Plus strict-valid output | {same_byte.preserved_valid_calls + same_byte.repaired_calls:,} | {format_percent(plus_acceptance_rate, 2)} |",
        f"| New text-fallback calls | +{same_byte.new_text_fallback_calls} | structured-call denominator 밖 |",
        "",
        f"Call-level paired acceptance의 discordance는 repair {same_byte.repaired_calls}, loss "
        f"{same_byte.native_plus_malformed_calls}이므로 exact McNemar p="
        f"{format_p(same_byte.call_acceptance_mcnemar_p)}다. 이것은 parser가 schema-valid call로 "
        "수용했는지에 대한 통계이며, 호출 내용이 task oracle에 맞았는지에 대한 통계가 아니다.",
        "",
        "### 3.3 Oracle-scored changed captures",
        "",
        image("03-strict-changed-outcomes", "strict outcomes among changed captures"),
        "",
        f"전체 changed capture {same_byte.changed_captures}건은 strict win "
        f"{same_byte.wins}, still-wrong neutral {same_byte.neutral_changes}, loss "
        f"{same_byte.losses}로 정확히 분할된다. win case는 다음과 같다.",
        "",
        *[f"- `{case}`" for case in same_byte.win_cases],
        "",
        f"Case-level exact McNemar p={format_p(same_byte.case_mcnemar_p)}다. 따라서 “관측된 "
        f"{same_byte.wins}건을 손실 없이 복구했다”는 사실은 말할 수 있지만, 이 case 표본만으로 "
        "semantic accuracy의 통계적 우월성을 5% 수준에서 확정하지 않는다.",
        "",
        "## 4. Pinned reference parser replay",
        "",
        f"Source: {reference_summary}",
        "",
    ]

    if reference:
        lines.extend(
            [
                f"Labeled corpus는 official chat-template grammar에서 도출한 conformance, "
                f"bounded corruption, false-positive, parallel-call case {reference.synthetic_cases}건이다. "
                "각 parser는 동일 text와 동일 tool schema를 받았다.",
                "",
                image("04-conformance-heatmap", "reference parser conformance heatmap"),
                "",
                "| Parser | Exact | Action correct | False positive | False negative | Exact precision | Exact recall |",
                "|---|---:|---:|---:|---:|---:|---:|",
            ]
        )
        for metric in sorted(reference.metrics, key=parser_order):
            lines.append(
                f"| {parser_label(metric.parser)} | {metric.exact_correct}/{metric.total} | "
                f"{metric.action_correct}/{metric.total} | {metric.false_positive} | "
                f"{metric.false_negative} | {format_percent(metric.exact_precision, 2)} | "
                f"{format_percent(metric.exact_recall, 2)} |"
            )
        lines.extend(
            [
                "",
                "`Exact`는 expected no-call을 포함한 whole-case exact이고, precision/recall의 "
                "positive denominator는 expected call case다. Harness의 false positive는 call을 "
                "수용했지만 expected calls와 exact가 아닌 row를 뜻한다.",
                "",
                f"Gate 판정: {reference_gate}",
                "",
                "### 4.1 Natural canonical captures와 pinned scorer",
                "",
                "Natural replay는 기존 canonical GLM BFCL/ACE capture의 raw text를 각 parser로 "
                "다시 decode하고, 원래 suite의 pinned scorer와 호환되는 row를 생성한다. 아래 "
                "accuracy는 새로운 model generation이 아니라 동일 text의 parser replay 결과다.",
                "",
            ]
        )
        for section in reference.natural_sections:
            lines.extend(
                [
                    f"#### `{section.name}` — {section.cases} cases",
                    "",
                    "| Parser | Strict correct | Protocol valid | Accuracy | Pairwise vs custom generate (win/loss/tie) |",
                    "|---|---:|---:|---:|---:|",
                ]
            )
            for metric in section.metrics:
                pair = section.pairwise_vs_generate.get(metric.parser)
                pair_text = (
                    "baseline"
                    if metric.parser == "productionGenerate"
                    else (
                        f"{pair['wins']}/{pair['losses']}/{pair['ties']}"
                        if pair
                        else "n/a"
                    )
                )
                accuracy_text = (
                    "n/a"
                    if metric.accuracy is None
                    else format_percent(metric.accuracy, 2)
                )
                lines.append(
                    f"| {parser_label(metric.parser)} | {metric.correct}/{metric.total} | "
                    f"{metric.protocol_valid}/{metric.total} | {accuracy_text} | {pair_text} |"
                )
            lines.append("")
        lines.extend(
            [
                "Pairwise 열은 해당 parser 관점의 win/loss/tie이며 baseline은 custom "
                "`productionGenerate`다. 이 결과도 FreeRouter backend parser를 식별하지 않는다.",
                "",
                "### 4.2 Reference source pins",
                "",
                "| Reference | Implementation | Revision | Source SHA-256 |",
                "|---|---|---|---|",
            ]
        )
        for name, source in sorted(reference.sources.items()):
            if not isinstance(source, dict):
                continue
            sha_value = source.get("sha256")
            sha_text = (
                "<br>".join(f"`{item}`" for item in sha_value)
                if isinstance(sha_value, list)
                else f"`{sha_value}`"
            )
            lines.append(
                f"| {name} | `{source.get('implementation')}` | "
                f"`{source.get('revision')}` | {sha_text} |"
            )
        lines.extend(["", f"> Artifact caveat: {reference.caveat}", ""])
    else:
        lines.extend(
            [
                "> **PENDING — publication forbidden.** Reference artifact가 없으므로 이 절에는 "
                "수치를 넣지 않았다. 최종 생성기는 `--allow-pending-reference` 없이 실행해야 한다.",
                "",
                image("04-conformance-heatmap", "pending reference heatmap"),
                "",
            ]
        )

    natural_chunk = (
        f"{reference.natural_chunk_invariant}/{reference.natural_cases}"
        if reference
        else "PENDING"
    )
    synthetic_chunk = (
        f"{reference.synthetic_chunk_invariant}/{reference.synthetic_cases}"
        if reference
        else "PENDING"
    )
    lines.extend(
        [
            "## 5. Generate/SSE parity와 chunk invariance",
            "",
            image("05-stream-invariance", "generate SSE chunk invariance"),
            "",
            "| Scope | Result |",
            "|---|---:|",
            f"| Same-byte generate captures | {same_byte.generate_captures:,} |",
            f"| Same-byte real SSE captures | {same_byte.sse_captures:,} |",
            f"| Native‑Plus SSE chunk invariant | {same_byte.chunk_invariant}/{same_byte.sse_captures} |",
            f"| Raw SSE byte / stream-delta max variants | {same_byte.max_sse_byte_variants} / {same_byte.max_stream_delta_variants} |",
            f"| Natural raw-text custom chunk invariant | {natural_chunk} |",
            f"| Synthetic custom chunk invariant | {synthetic_chunk} |",
            "",
            "Chunk invariance는 content를 고정하고 boundary만 바꿨을 때 최종 calls, text, "
            "tool-call lifecycle이 exact인지 본다. TTFT, first tool-call latency, partial-call "
            "responsiveness를 측정한 것이 아니다.",
            "",
            "## 6. 통계 해석",
            "",
            "두 p-value는 질문과 분모가 다르다.",
            "",
            "| Test | Unit | Discordance가 뜻하는 것 | p | 해석 |",
            "|---|---|---|---:|---|",
            f"| Call acceptance McNemar | Native structured call {same_byte.structured_calls:,}개 | malformed→valid vs valid→malformed | {format_p(same_byte.call_acceptance_mcnemar_p)} | parser acceptance 개선 근거 |",
            f"| Strict semantic McNemar | scorer-comparable case | wrong→correct vs correct→wrong | {format_p(same_byte.case_mcnemar_p)} | 방향성은 positive, 0.05 미만 아님 |",
            "",
            "Labeled reference corpus의 precision/recall은 설계된 corruption/conformance panel의 "
            "descriptive metric이다. corpus가 real-world corruption prevalence를 추정하지 않으므로 "
            "이를 production incidence rate로 변환하지 않는다.",
            "",
            "## 7. 보안·재현성",
            "",
            f"- Same-byte replay provider call: `{same_byte.provider_calls}`.",
            f"- Reference replay provider call: `{reference.provider_calls if reference else 'PENDING'}`.",
            f"- Raw request material written: `{str(same_byte.raw_request_material_written).lower()}`.",
            "- 시각화와 보고서 생성기는 provider/network call을 하지 않는다.",
            "- PNG converter child process에는 secret-like 이름의 환경 변수를 전달하지 않는다.",
            "- 결과 manifest는 source SHA-256, JSON pointer, SVG/PNG SHA-256을 보존한다.",
            "",
            "재생성 명령:",
            "",
            "```bash",
            "python3 benchmarks/glm-5.2-tool-calling/render_parser_superiority_report.py",
            "```",
            "",
            "Reference artifact가 없으면 기본 명령은 실패한다. layout 개발에서만 output과 "
            "report를 `/tmp`로 지정하고 `--allow-pending-reference`를 사용할 수 있다.",
            "",
            "## 8. 제한사항",
            "",
            "- Same-byte corpus는 한 endpoint와 한 날짜에 이미 관측된 response 분포다. 미래 "
            "malformed-call 발생률을 추정하지 않는다.",
            "- BFCL·ACE natural replay는 기존 custom/adapted panel의 pinned scorer를 사용하며 공식 "
            "leaderboard submission이 아니다.",
            "- Synthetic reference corpus는 parser semantics를 분리하기 위한 labeled panel이다. "
            "모델의 tool selection, planning, multi-turn execution 능력을 측정하지 않는다.",
            "- FreeRouter backend parser, routing, quantization, serving revision은 관측하지 못했다.",
            "- Case-level semantic p-value와 call-level acceptance p-value를 서로 대체하지 않는다.",
            "- 이전 live paired score 차이는 response bytes가 동일하지 않은 serving 반복이므로 "
            "이번 parser causal claim에 합치지 않는다.",
            "",
            "## 9. 운영 권고",
            "",
            "1. Provider Native를 기본 경로로 유지한다.",
            "2. Native‑Plus는 request를 바꾸지 않는 repair-only safety layer로 사용한다.",
            "3. Call acceptance 개선은 production gate로 활용하되, semantic benchmark 개선으로 "
            "과장하지 않는다.",
            "4. 동일 response-byte regression corpus와 SSE rechunk suite를 CI에 유지한다.",
            "5. Deployment-reference 결과는 text-only deployment 선택에 사용하되 FreeRouter 내부 "
            "구현의 대리 지표로 사용하지 않는다.",
            "",
            "## 10. 산출물과 source map",
            "",
            f"- Same-byte summary: {source_summary}",
            f"- Changed-capture detail: {source_discordance}",
            f"- Same-byte run metadata: {source_run_meta}",
            f"- Reference replay summary: {reference_summary}",
            f"- Visual/report manifest: "
            f"{report_source_link(out_dir / 'visual-manifest.json', report_path, 'visual-manifest.json')}",
            "",
            "모든 보고 수치의 machine-readable source field와 artifact SHA-256은 manifest에 "
            "기록한다. PNG와 SVG는 같은 source snapshot에서 한 번에 생성한다.",
            "",
        ]
    )
    return "\n".join(lines)


def source_relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        return str(path.resolve())


def evidence_manifest(
    same_byte: SameByteEvidence,
    reference: ReferenceEvidence | None,
    out_dir: Path,
    report_path: Path,
    rendered: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    source_artifacts = [
        {
            "role": "same-byte-summary",
            "path": source_relative(same_byte.summary_path),
            "sha256": same_byte.summary_sha256,
        },
        {
            "role": "same-byte-strict-discordance",
            "path": source_relative(same_byte.details_path),
            "sha256": same_byte.details_sha256,
        },
        {
            "role": "same-byte-run-meta",
            "path": source_relative(same_byte.run_meta_path),
            "sha256": same_byte.run_meta_sha256,
        },
    ]
    if reference:
        source_artifacts.append(
            {
                "role": "reference-replay-summary",
                "path": source_relative(reference.summary_path),
                "sha256": reference.summary_sha256,
            }
        )
    charts: list[dict[str, Any]] = []
    for entry in rendered:
        svg_path = Path(entry["svg"])
        png_path = Path(entry["png"]) if entry.get("png") else None
        chart = {
            "svg": source_relative(svg_path),
            "svgBytes": svg_path.stat().st_size,
            "svgSha256": sha256(svg_path),
        }
        if png_path:
            chart.update(
                {
                    "png": source_relative(png_path),
                    "pngBytes": png_path.stat().st_size,
                    "pngSha256": sha256(png_path),
                }
            )
        charts.append(chart)
    manifest: dict[str, Any] = {
        "artifactVersion": 1,
        "publicationReady": reference is not None,
        "sourceArtifacts": source_artifacts,
        "metricSources": {
            "callAcceptanceFunnel": {
                "artifactRole": "same-byte-summary",
                "jsonPointers": [
                    "/parser/nativeStructuredCalls",
                    "/parser/nativeStrictValidCalls",
                    "/parser/nativeMalformedCalls",
                    "/parser/repairedMalformedCalls",
                    "/parser/validNativeCallsPreserved",
                    "/parser/pairedMalformedCallAcceptanceExactMcNemarP",
                ],
            },
            "strictChangedOutcomes": {
                "artifactRole": "same-byte-strict-discordance",
                "columns": [
                    "callsChanged",
                    "textChanged",
                    "baselineStrict",
                    "nativePlusStrict",
                    "scoreOutcome",
                ],
            },
            "sameByteStreaming": {
                "artifactRole": "same-byte-summary",
                "jsonPointers": ["/corpus", "/stream"],
            },
            "referenceConformance": {
                "artifactRole": "reference-replay-summary",
                "jsonPointer": "/synthetic/metrics",
                "status": "loaded" if reference else "pending",
            },
            "referenceStreaming": {
                "artifactRole": "reference-replay-summary",
                "jsonPointers": [
                    "/naturalProductionChunkInvariant",
                    "/naturalTotal",
                    "/synthetic/productionChunkInvariant",
                    "/synthetic/cases",
                ],
                "status": "loaded" if reference else "pending",
            },
        },
        "sameByteEvidence": {
            "structuredCalls": same_byte.structured_calls,
            "strictValidCalls": same_byte.strict_valid_calls,
            "malformedCalls": same_byte.malformed_calls,
            "repairedCalls": same_byte.repaired_calls,
            "preservedValidCalls": same_byte.preserved_valid_calls,
            "wins": same_byte.wins,
            "neutralChanges": same_byte.neutral_changes,
            "losses": same_byte.losses,
            "chunkInvariant": same_byte.chunk_invariant,
            "sseCaptures": same_byte.sse_captures,
        },
        "referenceEvidence": (
            {
                "naturalCases": reference.natural_cases,
                "naturalChunkInvariant": reference.natural_chunk_invariant,
                "syntheticCases": reference.synthetic_cases,
                "syntheticChunkInvariant": reference.synthetic_chunk_invariant,
                "providerCalls": reference.provider_calls,
                "syntheticMetrics": {
                    metric.parser: {
                        "total": metric.total,
                        "actionCorrect": metric.action_correct,
                        "exactCorrect": metric.exact_correct,
                        "falsePositive": metric.false_positive,
                        "falseNegative": metric.false_negative,
                        "exactPrecision": metric.exact_precision,
                        "exactRecall": metric.exact_recall,
                    }
                    for metric in reference.metrics
                },
                "naturalStrict": {
                    section.name: {
                        metric.parser: {
                            "total": metric.total,
                            "correct": metric.correct,
                            "protocolValid": metric.protocol_valid,
                            "accuracy": metric.accuracy,
                        }
                        for metric in section.metrics
                    }
                    for section in reference.natural_sections
                },
            }
            if reference
            else None
        ),
        "charts": charts,
        "report": {
            "path": source_relative(report_path),
            "sha256": sha256(report_path),
        },
        "outputDirectory": source_relative(out_dir),
    }
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Render source-driven GLM-5.2 parser superiority visuals and report"
    )
    parser.add_argument("--same-byte-dir", type=Path, default=DEFAULT_SAME_BYTE_DIR)
    parser.add_argument("--reference-dir", type=Path, default=DEFAULT_REFERENCE_DIR)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument(
        "--allow-pending-reference",
        action="store_true",
        help="Development preview only; publication output refuses this state",
    )
    parser.add_argument(
        "--svg-only",
        action="store_true",
        help="Skip deterministic PNG conversion",
    )
    args = parser.parse_args()

    same_byte_dir = args.same_byte_dir.resolve()
    reference_dir = args.reference_dir.resolve()
    out_dir = args.out_dir.resolve()
    report_path = args.report.resolve()
    same_byte = load_same_byte_evidence(same_byte_dir)
    reference_summary_path = reference_dir / "summary.json"
    if reference_summary_path.is_file():
        reference = load_reference_evidence(reference_dir)
    elif args.allow_pending_reference:
        reference = None
        require(
            out_dir != DEFAULT_OUT_DIR.resolve(),
            "Pending preview cannot write the default publication output directory",
        )
        require(
            report_path != DEFAULT_REPORT.resolve(),
            "Pending preview cannot overwrite the default publication report",
        )
    else:
        raise FileNotFoundError(
            "Reference replay summary is required for publication: "
            f"{reference_summary_path}"
        )

    charts_dir = out_dir / "charts"
    charts_dir.mkdir(parents=True, exist_ok=True)
    visuals = {
        "01-claim-boundary.svg": claim_boundary_chart(reference),
        "02-call-acceptance-funnel.svg": call_acceptance_funnel_chart(same_byte),
        "03-strict-changed-outcomes.svg": strict_outcome_chart(same_byte),
        "04-conformance-heatmap.svg": conformance_heatmap_chart(reference),
        "05-stream-invariance.svg": stream_invariance_chart(same_byte, reference),
        "06-native-plus-architecture.svg": native_plus_architecture_chart(),
    }
    svg_paths: list[Path] = []
    for name, content in visuals.items():
        svg_path = charts_dir / name
        svg_path.write_text(content, encoding="utf-8")
        svg_paths.append(svg_path)
    biome_write(svg_paths)

    rendered: list[dict[str, Any]] = []
    for svg_path in svg_paths:
        entry: dict[str, Any] = {"svg": str(svg_path)}
        if not args.svg_only:
            entry.update(render_png(svg_path))
        rendered.append(entry)

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_text = render_korean_report(
        same_byte=same_byte,
        reference=reference,
        out_dir=out_dir,
        report_path=report_path,
    )
    if reference is not None:
        require("PENDING" not in report_text, "Publication report contains PENDING")
    report_path.write_text(report_text, encoding="utf-8")
    manifest = evidence_manifest(
        same_byte=same_byte,
        reference=reference,
        out_dir=out_dir,
        report_path=report_path,
        rendered=rendered,
    )
    manifest_path = out_dir / "visual-manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    biome_write([manifest_path])
    print(
        json.dumps(
            {
                "charts": len(rendered),
                "manifest": str(manifest_path),
                "publicationReady": reference is not None,
                "referenceDataLoaded": reference is not None,
                "report": str(report_path),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
