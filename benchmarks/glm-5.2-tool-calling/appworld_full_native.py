#!/usr/bin/env python3
"""Run the complete AppWorld test_normal and test_challenge populations."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from capture_runtime_fingerprint import build_runtime_fingerprint


ARMS = ("glm52-native", "glm52-prompt-only")
SPLITS = ("test_normal", "test_challenge")
EXPECTED_APPWORLD_ADMISSION = 8
REQUIRED_BRIDGE_TRANSIENT_RETRIES = 2
EXPERIMENT_TAG_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\Z")
FINAL_PARSER_PATH = Path("src/core/protocols/glm5-call-parsing.ts")
RUNTIME_BRIDGE_PATHS = (
    Path("benchmarks/glm-5.2-tool-calling/src/benchmark-model-call.ts"),
    Path("benchmarks/glm-5.2-tool-calling/src/openai-compat-bridge.ts"),
    Path("benchmarks/glm-5.2-tool-calling/src/provider-capture.ts"),
)


def now() -> str:
    return datetime.now().astimezone().isoformat()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive integer") from error
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def experiment_tag(value: str) -> str:
    if not EXPERIMENT_TAG_RE.fullmatch(value):
        raise argparse.ArgumentTypeError(
            "experiment tag must contain only lowercase letters, digits, and hyphens"
        )
    return value


def experiment_names(tag: str) -> tuple[str, ...]:
    return tuple(f"{arm}-{tag}" for arm in ARMS)


def experiments(tag: str) -> tuple[str, ...]:
    return tuple(
        f"simplified_function_calling_agent/local/{name}/{split}"
        for name in experiment_names(tag)
        for split in SPLITS
    )


def runtime_source_paths(repo_root: Path) -> tuple[Path, ...]:
    source_root = repo_root / "src"
    paths = tuple(
        path.relative_to(repo_root)
        for path in sorted(source_root.rglob("*.ts"))
        if "__tests__" not in path.parts
    )
    if FINAL_PARSER_PATH not in paths:
        raise RuntimeError("AppWorld runtime source closure is missing the final parser")
    return paths


def runtime_loader_path(repo_root: Path) -> Path:
    candidates = sorted(
        (repo_root / "node_modules/.pnpm").glob(
            "tsx@*/node_modules/tsx/dist/loader.mjs"
        )
    )
    if len(candidates) != 1 or not candidates[0].is_file():
        raise RuntimeError("AppWorld runtime requires exactly one tsx loader")
    return candidates[0]


def validate_runtime_fingerprint(
    output_root: Path, repo_root: Path | None = None
) -> dict[str, str | int]:
    root = (repo_root or Path(__file__).resolve().parents[2]).resolve()
    fingerprint_path = output_root / "runtime-fingerprint.json"
    fingerprint = json.loads(fingerprint_path.read_text(encoding="utf-8"))
    expected = build_runtime_fingerprint(
        repo_root=root,
        parser_paths=runtime_source_paths(root),
        bridge_paths=RUNTIME_BRIDGE_PATHS,
        runner_paths=[Path(__file__).resolve()],
        loader_path=runtime_loader_path(root),
    )
    if fingerprint != expected:
        raise RuntimeError(
            "AppWorld runtime fingerprint does not match the full parser/handler closure"
        )
    runtime = expected["runtimeFingerprint"]
    if not isinstance(runtime, dict):
        raise RuntimeError("AppWorld runtime fingerprint object is invalid")
    aggregate = runtime.get("aggregateSha256")
    if not isinstance(aggregate, str):
        raise RuntimeError("AppWorld runtime fingerprint aggregate is invalid")
    parser_sha256 = hashlib.sha256((root / FINAL_PARSER_PATH).read_bytes()).hexdigest()
    return {
        "aggregateSha256": aggregate,
        "parserFileCount": len(runtime_source_paths(root)),
        "parserSha256": parser_sha256,
    }


def read_jsonnet(path: Path, experiment_prompts_path: Path) -> dict[str, Any]:
    try:
        import _jsonnet
    except ImportError as error:
        raise RuntimeError("AppWorld Jsonnet runtime is unavailable") from error
    ext_vars = {
        **dict(os.environ),
        "APPWORLD_EXPERIMENT_PROMPTS_PATH": str(experiment_prompts_path),
    }
    value = json.loads(_jsonnet.evaluate_file(str(path), ext_vars=ext_vars))
    if not isinstance(value, dict):
        raise RuntimeError(f"AppWorld config is not an object: {path}")
    return value


def validate_experiment_configs(
    source_root: Path, tag: str, bridge_port: int
) -> dict[str, Any]:
    if type(bridge_port) is not int or not 1 <= bridge_port <= 65535:
        raise RuntimeError("AppWorld bridge port is invalid")
    local = (
        source_root
        / "experiments/configs/simplified_function_calling_agent/local"
    )
    base = local / f"_glm52_{tag.replace('-', '_')}.libsonnet"
    if not base.is_file():
        raise RuntimeError(f"AppWorld experiment config base is missing: {base}")
    base_sha256 = hashlib.sha256(base.read_bytes()).hexdigest()
    expected_url = f"http://127.0.0.1:{bridge_port}/v1"
    attested_paths = [base]
    config_files: list[str] = []
    for arm in ARMS:
        for split in SPLITS:
            path = local / f"{arm}-{tag}" / f"{split}.jsonnet"
            config = read_jsonnet(path, source_root / "experiments/prompts")
            config_root = config.get("config")
            if not isinstance(config_root, dict) or config_root.get("dataset") != split:
                raise RuntimeError(f"AppWorld config dataset mismatch: {path}")
            agent = config_root.get("agent")
            if not isinstance(agent, dict):
                raise RuntimeError(f"AppWorld agent config is missing: {path}")
            for section in ("model_config", "api_predictor_config"):
                model = agent.get(section)
                if section == "api_predictor_config" and isinstance(model, dict):
                    model = model.get("model_config")
                if not isinstance(model, dict):
                    raise RuntimeError(f"AppWorld {section} is missing: {path}")
                if model.get("name") != arm or model.get("base_url") != expected_url:
                    raise RuntimeError(
                        f"AppWorld {section} runtime binding mismatch: {path}"
                    )
            config_files.append(str(path.relative_to(local)))
            attested_paths.append(path)
    config_set = hashlib.sha256()
    for path in sorted(attested_paths):
        config_set.update(path.relative_to(local).as_posix().encode())
        config_set.update(b"\0")
        config_set.update(path.read_bytes())
        config_set.update(b"\0")
    return {
        "baseSha256": base_sha256,
        "files": config_files,
        "port": bridge_port,
        "setSha256": config_set.hexdigest(),
        "tag": tag,
    }


def validate_bridge_retry_policy(run_meta: dict[str, Any]) -> None:
    expected = {
        "additionalAttempts": REQUIRED_BRIDGE_TRANSIENT_RETRIES,
        "delayMs": 5_000,
        "timeoutMsPerAttempt": 180_000,
        "validatorRequiresRecoveredByteIdenticalRequest": True,
    }
    if run_meta.get("bridgeTransientRetryPolicy") != expected:
        raise RuntimeError("AppWorld bridge retry policy is not the active policy")
    if (
        run_meta.get("providerTransientRetries")
        != REQUIRED_BRIDGE_TRANSIENT_RETRIES
    ):
        raise RuntimeError("AppWorld bridge retry policy count is inconsistent")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--appworld", type=Path, required=True)
    parser.add_argument("--experiment-tag", type=experiment_tag, required=True)
    parser.add_argument(
        "--num-processes-per-experiment",
        type=positive_int,
        default=1,
        help="AppWorld worker processes for each of the four experiments",
    )
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def experiment_command(
    appworld: Path,
    experiment: str,
    root: Path,
    num_processes_per_experiment: int,
) -> list[str]:
    return [
        str(appworld),
        "run",
        experiment,
        "--root",
        str(root),
        "--num-processes",
        str(num_processes_per_experiment),
        "--with-evaluation",
        "--without-setup",
    ]


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)

    source_root = args.source_root.resolve()
    output_root = args.output_root.resolve()
    appworld = args.appworld.absolute()
    selected_experiments = experiments(args.experiment_tag)
    selected_experiment_names = experiment_names(args.experiment_tag)
    run_meta_path = output_root / "run-meta.json"
    run_meta = json.loads(run_meta_path.read_text(encoding="utf-8"))
    if run_meta.get("status") != "running":
        raise RuntimeError("AppWorld run metadata is not launchable")
    validate_bridge_retry_policy(run_meta)
    if not (output_root / "task-manifest.json").is_file():
        raise RuntimeError("fresh AppWorld task manifest is missing")
    if run_meta.get("experimentTag") != args.experiment_tag:
        raise RuntimeError("AppWorld experiment tag conflicts with run metadata")
    if run_meta.get("experimentNames") != list(selected_experiment_names):
        raise RuntimeError("AppWorld experiment names conflict with run metadata")
    bridge_port = run_meta.get("bridgePort")
    config_audit = validate_experiment_configs(
        source_root, args.experiment_tag, bridge_port
    )
    if run_meta.get("configBaseSha256") != config_audit["baseSha256"]:
        raise RuntimeError("AppWorld config base hash conflicts with run metadata")
    if run_meta.get("configSetSha256") != config_audit["setSha256"]:
        raise RuntimeError("AppWorld config set hash conflicts with run metadata")
    runtime_audit = validate_runtime_fingerprint(output_root)
    if run_meta.get("runtimeFingerprintFile") != "runtime-fingerprint.json":
        raise RuntimeError("AppWorld runtime fingerprint file is not pinned")
    if (
        run_meta.get("runtimeFingerprintAggregateSha256")
        != runtime_audit["aggregateSha256"]
    ):
        raise RuntimeError("AppWorld runtime aggregate conflicts with run metadata")
    runtime_attestation = run_meta.get("runtimeStartAttestation")
    if not isinstance(runtime_attestation, dict) or (
        runtime_attestation.get("parserSha256") != runtime_audit["parserSha256"]
    ):
        raise RuntimeError("AppWorld parser attestation conflicts with runtime")
    recorded_concurrency = run_meta.get("numProcessesPerExperiment")
    if recorded_concurrency is not None and (
        type(recorded_concurrency) is not int
        or recorded_concurrency != args.num_processes_per_experiment
    ):
        raise RuntimeError(
            "AppWorld concurrency conflicts with existing run metadata"
        )
    admission = len(selected_experiments) * args.num_processes_per_experiment
    campaign_contract = run_meta.get("campaignAdmissionContract")
    if not isinstance(campaign_contract, dict) or (
        campaign_contract.get("appWorld") != EXPECTED_APPWORLD_ADMISSION
        or campaign_contract.get("globalCeiling") != EXPECTED_APPWORLD_ADMISSION
        or campaign_contract.get("total") != EXPECTED_APPWORLD_ADMISSION
        or admission != EXPECTED_APPWORLD_ADMISSION
    ):
        raise RuntimeError("AppWorld campaign admission contract is not exactly 8/8")

    root = output_root / "root"
    if root.exists():
        raise RuntimeError(f"refusing existing AppWorld execution root: {root}")
    if args.dry_run:
        print(
            json.dumps(
                {
                    "admission": admission,
                    "bridgeTransientRetries": REQUIRED_BRIDGE_TRANSIENT_RETRIES,
                    "config": config_audit,
                    "experiments": list(selected_experiments),
                    "runtime": runtime_audit,
                    "status": "valid-dry-run",
                },
                ensure_ascii=False,
                sort_keys=True,
            )
        )
        return
    (root / "experiments/outputs").mkdir(parents=True)
    (root / "data").symlink_to(source_root / "data", target_is_directory=True)
    logs = output_root / "logs"
    logs.mkdir()
    run_meta["numProcessesPerExperiment"] = args.num_processes_per_experiment
    atomic_json(run_meta_path, run_meta)

    environment = dict(os.environ)
    environment.update(
        {
            "APPWORLD_BRIDGE_API_KEY": "bridge-local",
            "APPWORLD_ROOT": str(root),
            # AppWorld's OpenAI backend constructs a default client while
            # selecting its callable, before applying api_key_env_name.
            "OPENAI_API_KEY": "bridge-local",
            "PYTHONUNBUFFERED": "1",
        }
    )
    active: list[subprocess.Popen[bytes]] = []
    handles: list[Any] = []
    interruption: int | None = None

    def stop(signum: int, _frame: object) -> None:
        nonlocal interruption
        interruption = signum
        for process in active:
            if process.poll() is None:
                process.terminate()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    try:
        for experiment in selected_experiments:
            output = root / "experiments/outputs" / experiment
            if output.exists():
                raise RuntimeError(f"refusing existing AppWorld experiment: {output}")
            label = experiment.replace("/", "-")
            handle = (logs / f"{label}.log").open("wb")
            handles.append(handle)
            active.append(
                subprocess.Popen(
                    experiment_command(
                        appworld,
                        experiment,
                        root,
                        args.num_processes_per_experiment,
                    ),
                    cwd=source_root,
                    env=environment,
                    stdout=handle,
                    stderr=subprocess.STDOUT,
                )
            )
        return_codes = [process.wait() for process in active]
        for handle in handles:
            handle.close()
        if interruption is not None:
            raise RuntimeError(f"interrupted by {signal.Signals(interruption).name}")
        failures = [
            f"{experiment}: exit {code}"
            for experiment, code in zip(
                selected_experiments, return_codes, strict=True
            )
            if code != 0
        ]
        if failures:
            raise RuntimeError("; ".join(failures))
        run_meta.update({"completedAt": now(), "status": "inference-complete"})
        atomic_json(run_meta_path, run_meta)
    except BaseException as error:
        for process in active:
            if process.poll() is None:
                process.terminate()
        for process in active:
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for handle in handles:
            if not handle.closed:
                handle.close()
        run_meta.update(
            {
                "completedAt": now(),
                "failure": f"{type(error).__name__}: {error}",
                "interruptionSignal": (
                    signal.Signals(interruption).name
                    if interruption is not None
                    else None
                ),
                "status": "invalid-incomplete",
            }
        )
        atomic_json(run_meta_path, run_meta)
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"AppWorld full runner failed: {error}", file=sys.stderr)
        raise
