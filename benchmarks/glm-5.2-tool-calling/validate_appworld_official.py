#!/usr/bin/env python3
"""Validate exact fresh AppWorld coverage without exposing partial scores."""

from __future__ import annotations

import argparse
from importlib import import_module
import json
import os
import subprocess
from pathlib import Path
from typing import Any

appworld_runner = import_module("appworld_full_native")
EXPECTED_APPWORLD_ADMISSION = appworld_runner.EXPECTED_APPWORLD_ADMISSION
experiment_names = appworld_runner.experiment_names
experiment_tag = appworld_runner.experiment_tag
validate_experiment_configs = appworld_runner.validate_experiment_configs
validate_bridge_retry_policy = appworld_runner.validate_bridge_retry_policy
validate_runtime_fingerprint = appworld_runner.validate_runtime_fingerprint


ARMS = ("glm52-native", "glm52-prompt-only")
EXPECTED_COMMIT = "a072b7a86e7c1d5b1d7175659d750ebb9b79f10a"
EXPECTED_COUNTS = {"test_challenge": 417, "test_normal": 168}
EXPECTED_TOTAL = sum(EXPECTED_COUNTS.values())
EXPECTED_MAX_OUTPUT_TOKENS = 16_384


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected a JSON object")
    return value


def bridge_base_url(run_meta: dict[str, Any]) -> str:
    port = run_meta.get("bridgePort")
    if type(port) is not int or not 1 <= port <= 65535:
        raise RuntimeError("run metadata bridge port is invalid")
    return f"http://127.0.0.1:{port}/v1"


def require_model_config(
    config: dict[str, Any], arm: str, base_url: str, path: Path
) -> None:
    model = config.get("model_config")
    if not isinstance(model, dict):
        raise RuntimeError(f"{path}: missing model_config")
    expected = {
        "base_url": base_url,
        "max_retries": 100,
        "name": arm,
        "retry_after_n_seconds": 15,
        "use_cache": False,
    }
    for key, value in expected.items():
        if model.get(key) != value:
            raise RuntimeError(
                f"{path}: model_config.{key} expected {value!r}, "
                f"found {model.get(key)!r}"
            )


def require_runtime_binding(run_root: Path, run_meta: dict[str, Any]) -> None:
    validate_bridge_retry_policy(run_meta)
    tag = run_meta.get("experimentTag")
    if not isinstance(tag, str):
        raise RuntimeError("run metadata experiment tag is missing")
    try:
        validated_tag = experiment_tag(tag)
    except argparse.ArgumentTypeError as error:
        raise RuntimeError("run metadata experiment tag is invalid") from error
    if run_meta.get("experimentNames") != list(experiment_names(validated_tag)):
        raise RuntimeError("run metadata experiment names do not match the tag")
    contract = run_meta.get("campaignAdmissionContract")
    if not isinstance(contract, dict) or (
        contract.get("appWorld") != EXPECTED_APPWORLD_ADMISSION
        or contract.get("globalCeiling") != EXPECTED_APPWORLD_ADMISSION
        or contract.get("total") != EXPECTED_APPWORLD_ADMISSION
        or run_meta.get("numProcessesPerExperiment") != 2
    ):
        raise RuntimeError("run metadata AppWorld admission is not exactly 8/8")
    if run_meta.get("runtimeFingerprintFile") != "runtime-fingerprint.json":
        raise RuntimeError("run metadata runtime fingerprint file is not pinned")
    runtime = validate_runtime_fingerprint(run_root)
    if run_meta.get("runtimeFingerprintAggregateSha256") != runtime[
        "aggregateSha256"
    ]:
        raise RuntimeError("run metadata runtime fingerprint aggregate mismatch")
    attestation = run_meta.get("runtimeStartAttestation")
    if not isinstance(attestation, dict) or attestation.get(
        "parserSha256"
    ) != runtime.get("parserSha256"):
        raise RuntimeError("run metadata parser attestation mismatch")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--code-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    code_root = args.code_root.resolve()
    manifest = read_json(args.manifest.resolve())
    run_root = args.run_root.resolve()
    run_meta = read_json(run_root / "run-meta.json")
    if run_meta.get("status") != "inference-complete":
        raise RuntimeError("AppWorld inference is not complete")
    require_runtime_binding(run_root, run_meta)
    expected_base_url = bridge_base_url(run_meta)
    tag = str(run_meta["experimentTag"])
    config_audit = validate_experiment_configs(code_root, tag, run_meta["bridgePort"])
    if run_meta.get("configBaseSha256") != config_audit["baseSha256"]:
        raise RuntimeError("run metadata config base hash mismatch")
    if run_meta.get("configSetSha256") != config_audit["setSha256"]:
        raise RuntimeError("run metadata config set hash mismatch")

    commit = subprocess.check_output(
        ["git", "-C", str(code_root), "rev-parse", "HEAD"], text=True
    ).strip()
    if commit != EXPECTED_COMMIT:
        raise RuntimeError(
            f"AppWorld revision mismatch: expected {EXPECTED_COMMIT}, found {commit}"
        )
    if manifest.get("benchmark") != "AppWorld":
        raise RuntimeError("manifest benchmark mismatch")
    if manifest.get("codeCommit") != EXPECTED_COMMIT:
        raise RuntimeError("manifest code commit mismatch")
    if manifest.get("counts") != EXPECTED_COUNTS:
        raise RuntimeError("manifest split counts mismatch")
    if manifest.get("taskCount") != EXPECTED_TOTAL:
        raise RuntimeError("manifest task count mismatch")
    if run_meta.get("taskCountPerArm") != EXPECTED_TOTAL:
        raise RuntimeError("run metadata task count mismatch")
    if run_meta.get("bridgeMaxOutputTokens") != EXPECTED_MAX_OUTPUT_TOKENS:
        raise RuntimeError("run metadata bridge output-token limit mismatch")
    if run_meta.get("arms") != list(ARMS):
        raise RuntimeError("run metadata arm order mismatch")
    if run_meta.get("taskSetSha256") != manifest.get("taskSetSha256"):
        raise RuntimeError("run metadata task-set hash mismatch")

    freshness = run_meta.get("freshness")
    if not isinstance(freshness, dict):
        raise RuntimeError("run metadata freshness record is missing")
    required_freshness = {
        "emptyOutputRootAtStart": True,
        "historicalRawInput": False,
        "historicalScoreInput": False,
        "resumeFromPriorRun": False,
        "preseed": False,
        "useCache": False,
    }
    for key, value in required_freshness.items():
        if freshness.get(key) != value:
            raise RuntimeError(
                f"freshness.{key} expected {value!r}, found {freshness.get(key)!r}"
            )

    experiments = run_meta.get("experimentNames")
    if not isinstance(experiments, list) or len(experiments) != len(ARMS):
        raise RuntimeError("run metadata experiment names are invalid")

    os.environ["APPWORLD_ROOT"] = str(code_root)
    load_task_ids = getattr(import_module("appworld"), "load_task_ids")

    expected_by_split = {
        split: set(load_task_ids(split)) for split in EXPECTED_COUNTS
    }
    for split, expected_count in EXPECTED_COUNTS.items():
        if len(expected_by_split[split]) != expected_count:
            raise RuntimeError(
                f"{split}: expected {expected_count} upstream tasks, "
                f"found {len(expected_by_split[split])}"
            )

    base = (
        run_root
        / "root"
        / "experiments"
        / "outputs"
        / "simplified_function_calling_agent"
        / "local"
    )
    coverage: dict[str, dict[str, int]] = {}
    for arm, experiment in zip(ARMS, experiments, strict=True):
        if not isinstance(experiment, str) or not experiment:
            raise RuntimeError("empty AppWorld experiment name")
        coverage[arm] = {}
        for split, expected_ids in expected_by_split.items():
            split_root = base / experiment / split
            tasks_root = split_root / "tasks"
            actual_ids = {path.name for path in tasks_root.iterdir() if path.is_dir()}
            missing = sorted(expected_ids - actual_ids)
            unexpected = sorted(actual_ids - expected_ids)
            if missing or unexpected:
                raise RuntimeError(
                    f"{arm}/{split}: task coverage mismatch; "
                    f"missing={missing[:8]}, unexpected={unexpected[:8]}"
                )
            unfinished = sorted(
                task_id
                for task_id in expected_ids
                if not (tasks_root / task_id / "misc" / "finished").is_file()
            )
            if unfinished:
                raise RuntimeError(
                    f"{arm}/{split}: unfinished tasks: {unfinished[:8]}"
                )

            evaluation_path = split_root / "evaluations" / f"{split}.json"
            evaluation = read_json(evaluation_path)
            individual = evaluation.get("individual")
            if not isinstance(individual, dict):
                raise RuntimeError(f"{evaluation_path}: missing individual results")
            evaluated_ids = set(individual)
            if evaluated_ids != expected_ids:
                raise RuntimeError(
                    f"{arm}/{split}: official evaluation coverage mismatch"
                )
            if not isinstance(evaluation.get("aggregate"), dict):
                raise RuntimeError(f"{evaluation_path}: missing aggregate result")

            config_path = split_root / "configs" / f"{split}.json"
            config = read_json(config_path)
            if config.get("config", {}).get("dataset") != split:
                raise RuntimeError(f"{config_path}: dataset mismatch")
            agent = config.get("config", {}).get("agent")
            if not isinstance(agent, dict):
                raise RuntimeError(f"{config_path}: agent config is missing")
            if agent.get("type") != "simplified_function_calling":
                raise RuntimeError(f"{config_path}: agent type mismatch")
            if agent.get("skip_if_finished") is not False:
                raise RuntimeError(f"{config_path}: skip_if_finished must be false")
            require_model_config(agent, arm, expected_base_url, config_path)
            predictor = agent.get("api_predictor_config")
            if not isinstance(predictor, dict):
                raise RuntimeError(f"{config_path}: predictor config is missing")
            require_model_config(predictor, arm, expected_base_url, config_path)
            coverage[arm][split] = len(actual_ids)

    output = {
        "benchmark": "AppWorld",
        "complete": True,
        "coverage": coverage,
        "officialEvaluationCoveragePerArm": EXPECTED_TOTAL,
        "status": "valid",
        "taskCountPerArm": EXPECTED_TOTAL,
        "taskSetSha256": manifest.get("taskSetSha256"),
    }
    out = args.out.resolve()
    if out.exists():
        raise RuntimeError(f"refusing to overwrite existing validation: {out}")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(output, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(output, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
