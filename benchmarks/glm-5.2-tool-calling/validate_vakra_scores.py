#!/usr/bin/env python3
"""Validate complete fresh VAKRA score coverage before publishing metrics."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any


ARMS = ("glm52-native", "glm52-prompt-only")
CAPABILITIES = {
    1: ("capability_1_bi_apis", 2_077),
    2: ("capability_2_dashboard_apis", 1_597),
    3: ("capability_3_multihop_reasoning", 869),
    4: ("capability_4_multiturn", 664),
}
EXPECTED_TASKS = 5_207
EXPECTED_JUDGE_MODEL = "openai/gpt-oss-120b"
EXPECTED_JUDGE_BASE_URL = "https://freerouter.minpeter.workers.dev/v1"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def file_contains(path: Path, needle: bytes) -> bool:
    overlap = max(0, len(needle) - 1)
    previous = b""
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            combined = previous + chunk
            if needle in combined:
                return True
            previous = combined[-overlap:] if overlap else b""
    return False


def manifest_domains(manifest: dict[str, Any]) -> dict[int, dict[str, int]]:
    capability_ids = {name: number for number, (name, _) in CAPABILITIES.items()}
    result: dict[int, dict[str, int]] = {
        capability: {} for capability in CAPABILITIES
    }
    for entry in manifest.get("files", []):
        if not isinstance(entry, dict):
            raise RuntimeError("invalid VAKRA manifest file entry")
        capability = capability_ids.get(str(entry.get("capability")))
        relative = entry.get("path")
        rows = entry.get("rowCount")
        if capability is None or not isinstance(relative, str) or not isinstance(rows, int):
            raise RuntimeError("invalid VAKRA manifest capability file")
        result[capability][Path(relative).stem] = rows
    for capability, (_, expected) in CAPABILITIES.items():
        observed = sum(result[capability].values())
        if observed != expected:
            raise RuntimeError(
                f"VAKRA manifest capability {capability}: expected {expected}, found {observed}"
            )
    return result


def validate_score_file(
    path: Path, expected_domains: dict[str, int], expected_rows: int
) -> dict[str, float | int]:
    value = read_json(path)
    if not isinstance(value, dict):
        raise RuntimeError(f"VAKRA score output is not an object: {path}")
    domains = value.get("domains")
    summary = value.get("summary")
    if not isinstance(domains, dict) or not isinstance(summary, dict):
        raise RuntimeError(f"VAKRA score output shape is invalid: {path}")
    if set(domains) != set(expected_domains):
        raise RuntimeError(f"VAKRA scored domain coverage mismatch: {path}")
    dialogues = 0
    for domain, expected in expected_domains.items():
        row = domains[domain]
        if not isinstance(row, dict):
            raise RuntimeError(f"VAKRA scored domain is invalid: {path}/{domain}")
        if any(
            row.get(field) != expected
            for field in ("n_groundtruth", "n_prediction", "n_paired")
        ):
            raise RuntimeError(f"VAKRA scored row coverage mismatch: {path}/{domain}")
        if row.get("missing_prediction_uuids") or row.get("extra_prediction_uuids"):
            raise RuntimeError(f"VAKRA score pairing mismatch: {path}/{domain}")
        scored = row.get("dialogues")
        if not isinstance(scored, list) or len(scored) != expected:
            raise RuntimeError(f"VAKRA dialogue coverage mismatch: {path}/{domain}")
        for dialogue in scored:
            score = dialogue.get("score") if isinstance(dialogue, dict) else None
            if not isinstance(score, (int, float)) or not 0 <= float(score) <= 1:
                raise RuntimeError(f"VAKRA dialogue score is invalid: {path}/{domain}")
        dialogues += len(scored)
    if dialogues != expected_rows:
        raise RuntimeError(f"VAKRA score denominator mismatch: {path}")
    if any(
        summary.get(field) != expected_rows
        for field in ("n_paired_dialogues", "n_samples")
    ):
        raise RuntimeError(f"VAKRA score summary denominator mismatch: {path}")
    if summary.get("n_missing_predictions") != 0 or summary.get("n_extra_predictions") != 0:
        raise RuntimeError(f"VAKRA score summary pairing mismatch: {path}")
    mean = summary.get("mean_dialogue_score")
    correct = summary.get("n_correct")
    if not isinstance(mean, (int, float)) or not 0 <= float(mean) <= 1:
        raise RuntimeError(f"VAKRA mean score is invalid: {path}")
    if not isinstance(correct, (int, float)) or not 0 <= float(correct) <= expected_rows:
        raise RuntimeError(f"VAKRA correct count is invalid: {path}")
    return {
        "correct": float(correct),
        "mean": float(mean),
        "rows": expected_rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--score-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--secret-env")
    args = parser.parse_args()

    manifest = read_json(args.manifest.resolve())
    if not isinstance(manifest, dict) or manifest.get("taskCount") != EXPECTED_TASKS:
        raise RuntimeError("VAKRA manifest denominator mismatch")
    score_root = args.score_root.resolve()
    run_meta = read_json(score_root / "run-meta.json")
    if not isinstance(run_meta, dict) or run_meta.get("status") != "scoring-complete":
        raise RuntimeError("refusing incomplete VAKRA scoring")
    judge = run_meta.get("judge")
    if not isinstance(judge, dict):
        raise RuntimeError("VAKRA judge route metadata is missing")
    if judge.get("model") != EXPECTED_JUDGE_MODEL:
        raise RuntimeError("VAKRA judge model is not the documented official model")
    if judge.get("baseUrl") != EXPECTED_JUDGE_BASE_URL:
        raise RuntimeError("VAKRA judge transport is not the declared FreeRouter route")
    if judge.get("temperature") != 0 or judge.get("transportAdaptationOnly") is not True:
        raise RuntimeError("VAKRA judge adaptation metadata is invalid")
    expected = manifest_domains(manifest)
    arms: dict[str, Any] = {}
    for arm in ARMS:
        capabilities: dict[str, Any] = {}
        total_correct = 0.0
        total_rows = 0
        for capability, (_, expected_rows) in CAPABILITIES.items():
            result = validate_score_file(
                score_root / arm / f"capability-{capability}.json",
                expected[capability],
                expected_rows,
            )
            capabilities[str(capability)] = result
            total_correct += float(result["correct"])
            total_rows += int(result["rows"])
        if total_rows != EXPECTED_TASKS:
            raise RuntimeError(f"VAKRA score arm denominator mismatch: {arm}")
        arms[arm] = {
            "capabilities": capabilities,
            "correct": total_correct,
            "mean": total_correct / total_rows,
            "rows": total_rows,
        }

    receipts = score_root / "judge-call-receipts.jsonl"
    receipt_rows = 0
    for line_number, line in enumerate(
        receipts.read_text(encoding="utf-8").splitlines(), 1
    ):
        if not line.strip():
            continue
        receipt_rows += 1
        try:
            receipt = json.loads(line)
        except json.JSONDecodeError as error:
            raise RuntimeError(
                f"VAKRA judge receipt {line_number} is invalid JSON"
            ) from error
        if not isinstance(receipt, dict) or receipt.get("status") != "ok":
            raise RuntimeError(f"VAKRA judge call {line_number} did not succeed")
        if receipt.get("model") != EXPECTED_JUDGE_MODEL:
            raise RuntimeError(f"VAKRA judge call {line_number} model mismatch")
        if receipt.get("baseUrl") != EXPECTED_JUDGE_BASE_URL:
            raise RuntimeError(f"VAKRA judge call {line_number} route mismatch")
        for field in ("requestSha256", "responseSha256"):
            if not isinstance(receipt.get(field), str) or not SHA256_RE.fullmatch(
                receipt[field]
            ):
                raise RuntimeError(
                    f"VAKRA judge call {line_number} has an invalid {field}"
                )
        if not isinstance(receipt.get("responseBytes"), int) or receipt["responseBytes"] < 1:
            raise RuntimeError(
                f"VAKRA judge call {line_number} has an empty response"
            )
    if receipt_rows < EXPECTED_TASKS * len(ARMS):
        raise RuntimeError(
            "VAKRA judge receipt count is below one call per scored dialogue"
        )
    secret_scan = "not-requested"
    if args.secret_env:
        secret = os.environ.get(args.secret_env)
        if not secret:
            raise RuntimeError(f"missing secret scan env: {args.secret_env}")
        needle = secret.encode()
        for path in score_root.rglob("*"):
            if path.is_file() and file_contains(path, needle):
                raise RuntimeError(
                    f"VAKRA score artifact retained provider secret: {path.name}"
                )
        secret_scan = "pass"

    result = {
        "arms": arms,
        "benchmark": "VAKRA",
        "complete": True,
        "judgeReceiptRows": receipt_rows,
        "secretRetentionScan": secret_scan,
        "status": "valid",
        "taskCountPerArm": EXPECTED_TASKS,
        "taskSetSha256": manifest.get("taskSetSha256"),
    }
    out = args.out.resolve()
    if out.exists():
        raise RuntimeError(f"refusing existing VAKRA score validation: {out}")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"out": str(out), **result}, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
