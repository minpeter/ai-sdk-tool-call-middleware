#!/usr/bin/env python3
"""Run VAKRA's pinned evaluator with an explicit OpenAI-compatible judge route.

The upstream evaluator hard-codes Groq as the transport for its documented
``openai/gpt-oss-120b`` judge.  This wrapper leaves every upstream prompt,
parser, MCP replay, and scorer unchanged while replacing only the judge model
transport.  It also refuses score resume and records hash-only judge-call
receipts so provider secrets and judge text are not retained in the audit log.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any


ARMS = ("glm52-native", "glm52-prompt-only")
CAPABILITIES = {
    1: ("capability_bi_apis", "capability_1_bi_apis", 2_077),
    2: ("capability_dashboard_apis", "capability_2_dashboard_apis", 1_597),
    3: ("capability_multihop_reasoning", "capability_3_multihop_reasoning", 869),
    4: ("capability_multiturn", "capability_4_multiturn", 664),
}
EXPECTED_TASKS = 5_207
EXPECTED_CODE_COMMIT = "99847464a7b0fca05413b53ad8a7714d9a9279e9"


def now() -> str:
    return datetime.now().astimezone().isoformat()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def git_revision(root: Path) -> str:
    return subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()


def read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected a JSON object")
    return value


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def audit_text(value: object) -> tuple[str, int]:
    if isinstance(value, str):
        text = value
    else:
        text = repr(value)
    encoded = text.encode()
    return sha256_bytes(encoded), len(encoded)


def append_jsonl(path: Path, value: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n")


def import_upstream_evaluator(
    code_root: Path,
    *,
    api_key: str,
    base_url: str,
    model: str,
    audit_path: Path,
) -> Any:
    evaluator_root = code_root / "evaluator"
    sys.path.insert(0, str(code_root))
    sys.path.insert(0, str(evaluator_root))

    # judge.py requires API_KEY when its judge objects are constructed.  Keep
    # the value process-local and replace the transport class before importing
    # evaluator.py, which constructs the capability registry defaults.
    os.environ["API_KEY"] = api_key
    judge = importlib.import_module("judge")
    chat_openai = importlib.import_module("langchain_openai")
    chat_openai_type = getattr(chat_openai, "ChatOpenAI")

    class RoutedAuditChatModel(chat_openai_type):
        def __init__(self, config: dict[str, Any]):
            params = dict(config.get("params", {}))
            params.setdefault("model", model)
            params.setdefault("api_key", api_key)
            params.setdefault("base_url", base_url.rstrip("/"))
            params.setdefault("temperature", 0)
            super().__init__(**params)

        def invoke(self, input: Any, *args: Any, **kwargs: Any) -> Any:
            request_sha, request_bytes = audit_text(input)
            started = time.perf_counter()
            receipt: dict[str, Any] = {
                "baseUrl": base_url.rstrip("/"),
                "completedAt": None,
                "latencyMs": None,
                "model": model,
                "requestBytes": request_bytes,
                "requestSha256": request_sha,
                "status": "running",
            }
            try:
                response = super().invoke(input, *args, **kwargs)
                response_sha, response_bytes = audit_text(response.content)
                receipt.update(
                    {
                        "completedAt": now(),
                        "latencyMs": round(
                            (time.perf_counter() - started) * 1000
                        ),
                        "responseBytes": response_bytes,
                        "responseSha256": response_sha,
                        "status": "ok",
                    }
                )
                append_jsonl(audit_path, receipt)
                return response
            except Exception as error:
                receipt.update(
                    {
                        "completedAt": now(),
                        "errorType": type(error).__name__,
                        "latencyMs": round(
                            (time.perf_counter() - started) * 1000
                        ),
                        "status": "error",
                    }
                )
                append_jsonl(audit_path, receipt)
                raise

    setattr(judge, "ChatModel", RoutedAuditChatModel)
    return importlib.import_module("evaluator")


def validate_inputs(
    code_root: Path,
    manifest: dict[str, Any],
    inference_root: Path,
    inference_validation: dict[str, Any],
) -> None:
    if git_revision(code_root) != EXPECTED_CODE_COMMIT:
        raise RuntimeError("VAKRA code revision mismatch")
    if manifest.get("codeCommit") != EXPECTED_CODE_COMMIT:
        raise RuntimeError("VAKRA manifest code revision mismatch")
    if manifest.get("taskCount") != EXPECTED_TASKS:
        raise RuntimeError("VAKRA manifest is not the complete public population")
    run_meta = read_object(inference_root / "run-meta.json")
    if run_meta.get("status") != "inference-complete":
        raise RuntimeError("refusing to score incomplete VAKRA inference")
    if inference_validation.get("status") != "valid":
        raise RuntimeError("refusing unvalidated VAKRA inference")
    if inference_validation.get("taskCountPerArm") != EXPECTED_TASKS:
        raise RuntimeError("VAKRA inference validation denominator mismatch")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--code-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--inference-root", type=Path, required=True)
    parser.add_argument("--inference-validation", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--judge-base-url", required=True)
    parser.add_argument("--judge-model", default="openai/gpt-oss-120b")
    parser.add_argument("--judge-api-key-env", default="FREEROUTER_API_KEY")
    args = parser.parse_args()

    code_root = args.code_root.resolve()
    manifest_path = args.manifest.resolve()
    inference_root = args.inference_root.resolve()
    validation_path = args.inference_validation.resolve()
    output_root = args.output_root.resolve()
    manifest = read_object(manifest_path)
    inference_validation = read_object(validation_path)
    validate_inputs(code_root, manifest, inference_root, inference_validation)
    if output_root.exists():
        raise RuntimeError(f"refusing existing VAKRA score root: {output_root}")
    api_key = os.environ.get(args.judge_api_key_env)
    if not api_key:
        raise RuntimeError(f"missing judge secret env: {args.judge_api_key_env}")

    output_root.mkdir(parents=True)
    audit_path = output_root / "judge-call-receipts.jsonl"
    audit_path.write_text("", encoding="utf-8")
    source_files = (
        code_root / "evaluator" / "evaluator.py",
        code_root / "evaluator" / "judge.py",
        code_root / "evaluator" / "prompt.py",
        code_root / "evaluator" / "scorer.py",
    )
    run_meta: dict[str, Any] = {
        "arms": list(ARMS),
        "benchmark": "VAKRA",
        "completedAt": None,
        "freshness": {
            "historicalJudgeInput": False,
            "historicalScoreInput": False,
            "outputRootAbsentBeforeCreation": True,
            "resumeFromPriorScore": False,
        },
        "inferenceRoot": str(inference_root),
        "inferenceTaskSetSha256": manifest.get("taskSetSha256"),
        "judge": {
            "apiKeyEnv": args.judge_api_key_env,
            "baseUrl": args.judge_base_url.rstrip("/"),
            "model": args.judge_model,
            "temperature": 0,
            "transportAdaptationOnly": True,
        },
        "scorerSourceSha256": {
            str(path.relative_to(code_root)): sha256_file(path)
            for path in source_files
        },
        "startedAt": now(),
        "status": "scoring",
        "taskCountPerArm": EXPECTED_TASKS,
        "upstreamCodeCommit": git_revision(code_root),
        "wrapperSha256": sha256_file(Path(__file__).resolve()),
    }
    atomic_json(output_root / "run-meta.json", run_meta)

    try:
        upstream = import_upstream_evaluator(
            code_root,
            api_key=api_key,
            base_url=args.judge_base_url,
            model=args.judge_model,
            audit_path=audit_path,
        )
        mcp_configs = upstream.load_mcp_config(
            str(code_root / "benchmark" / "mcp_connection_config.yaml")
        )
        registry = upstream.build_default_capability_registry()
        for capability, (
            evaluator_name,
            dataset_name,
            _expected_rows,
        ) in CAPABILITIES.items():
            ground_truth = code_root / "data" / "test" / dataset_name / "input"
            mcp_config = mcp_configs.get(capability)
            if mcp_config is None:
                raise RuntimeError(f"missing MCP config for capability {capability}")
            for arm in ARMS:
                prediction = (
                    inference_root / "outputs" / arm / f"capability-{capability}"
                )
                output = output_root / arm / f"capability-{capability}.json"
                output.parent.mkdir(parents=True, exist_ok=True)
                upstream.evaluate_capability(
                    capability_name=evaluator_name,
                    gt_dir=ground_truth,
                    pred_dir=prediction,
                    out_path=output,
                    registry=registry,
                    mcp_config=mcp_config,
                )
        run_meta.update({"completedAt": now(), "status": "scoring-complete"})
        atomic_json(output_root / "run-meta.json", run_meta)
        print(json.dumps(run_meta, ensure_ascii=False, sort_keys=True))
    except Exception as error:
        run_meta.update(
            {
                "completedAt": now(),
                "errorType": type(error).__name__,
                "status": "scoring-failed",
            }
        )
        atomic_json(output_root / "run-meta.json", run_meta)
        raise


if __name__ == "__main__":
    main()
