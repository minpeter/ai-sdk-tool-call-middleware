#!/usr/bin/env python3
"""Run one pinned StableToolBench group through native tool calls.

This keeps StableToolBench's query loader, API environment, CoT@1 search,
virtual-server contract, and answer serialization. Heavy local-model imports are
stubbed because the selected backbone is an OpenAI-compatible remote model.
"""

from __future__ import annotations

import argparse
import re
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Final

import numpy as np
from openai import OpenAI


MAX_THREADS = 16
REQUIRED_MAX_TOKENS = 16_384
OFFICIAL_MODELS: Final = ("glm52-native", "glm52-prompt-only")
DEFAULT_REQUEST_TIMEOUT_SECONDS = 960
MAX_REQUEST_TIMEOUT_SECONDS = 3600
REQUEST_TIMEOUT_SECONDS = DEFAULT_REQUEST_TIMEOUT_SECONDS
REQUEST_MAX_TOKENS = REQUIRED_MAX_TOKENS


def official_model(value: str) -> str:
    if value not in OFFICIAL_MODELS:
        raise argparse.ArgumentTypeError(
            "model must be glm52-native or glm52-prompt-only; "
            "the native-plus arm is retired"
        )
    return value


def bounded_threads(value: str) -> int:
    threads = int(value)
    if not 1 <= threads <= MAX_THREADS:
        raise argparse.ArgumentTypeError(
            f"StableToolBench threads must be within 1..{MAX_THREADS}"
        )
    return threads


def bounded_timeout(value: str) -> int:
    timeout = int(value)
    if not 1 <= timeout <= MAX_REQUEST_TIMEOUT_SECONDS:
        raise argparse.ArgumentTypeError(
            "StableToolBench request timeout must be within "
            f"1..{MAX_REQUEST_TIMEOUT_SECONDS} seconds"
        )
    return timeout


def standardize(value: str) -> str:
    result = re.sub("[^\\u4e00-\\u9fa5^a-z^A-Z^0-9^_]", "_", value)
    result = re.sub(r"(_)\1+", "_", result).lower().strip("_")
    if result and result[0].isdigit():
        result = "get_" + result
    return result


def standardize_category(value: str) -> str:
    value = value.replace(" ", "_").replace(",", "_").replace("/", "_")
    while "__" in value:
        value = value.replace("__", "_")
    return value


def change_name(value: str) -> str:
    return (
        "is_" + value
        if value in {"from", "class", "return", "false", "true", "id", "and"}
        else value
    )


def softmax_bias(values: list[float], temperature: float = 1) -> np.ndarray:
    transformed = [10 ** ((value / temperature) / 400) for value in values]
    total = sum(transformed)
    return np.array([value / total for value in transformed])


def install_lightweight_imports() -> None:
    inference_utils = types.ModuleType("utils")
    inference_utils.softmax_bias = softmax_bias
    sys.modules["utils"] = inference_utils

    toolbench_utils = types.ModuleType("toolbench.utils")
    toolbench_utils.standardize = standardize
    toolbench_utils.standardize_category = standardize_category
    toolbench_utils.change_name = change_name
    toolbench_utils.replace_llama_with_condense = lambda ratio: None
    toolbench_utils.process_retrieval_ducoment = lambda value: value
    sys.modules["toolbench.utils"] = toolbench_utils

    class UnusedLocalModel:
        def __init__(self, *_: Any, **__: Any) -> None:
            raise RuntimeError("local StableToolBench model path was not selected")

    for module_name, class_name in (
        ("toolbench.inference.LLM.davinci_model", "Davinci"),
        ("toolbench.inference.LLM.tool_llama_lora_model", "ToolLLaMALoRA"),
        ("toolbench.inference.LLM.tool_llama_model", "ToolLLaMA"),
        ("toolbench.inference.LLM.tool_llama_vllm_model", "ToolLLaMA_vllm"),
        ("toolbench.inference.LLM.retriever", "ToolRetriever"),
    ):
        module = types.ModuleType(module_name)
        setattr(module, class_name, UnusedLocalModel)
        sys.modules[module_name] = module


class CapturedChatGPTFunction:
    def __init__(self, model: str, openai_key: str, base_url: str) -> None:
        self.model = model
        self.messages: list[dict[str, Any]] = []
        self.client = OpenAI(
            api_key=openai_key,
            base_url=base_url,
            max_retries=0,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )

    def change_messages(self, messages: list[dict[str, Any]]) -> None:
        self.messages = messages

    def parse(
        self,
        tools: list[dict[str, Any]],
        process_id: int,
        **_: Any,
    ) -> tuple[dict[str, Any], int, int]:
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=self.messages,
                tools=tools or None,
                temperature=0.001,
                max_tokens=REQUEST_MAX_TOKENS,
            )
            message = response.choices[0].message.model_dump(exclude_none=True)
            usage = response.usage.total_tokens if response.usage else 0
            return message, 0, usage
        except Exception as error:  # Provider errors remain in-population failures.
            return (
                {
                    "role": "assistant",
                    "content": f"Fresh model request failed: {type(error).__name__}",
                },
                -1,
                0,
            )


def install_chat_model() -> None:
    module_name = "toolbench.inference.LLM.chatgpt_function_model"
    module = types.ModuleType(module_name)
    module.ChatGPTFunction = CapturedChatGPTFunction
    sys.modules[module_name] = module


def main() -> None:
    global REQUEST_MAX_TOKENS, REQUEST_TIMEOUT_SECONDS

    parser = argparse.ArgumentParser()
    parser.add_argument("--code-root", type=Path, required=True)
    parser.add_argument("--tool-root", type=Path, required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", type=official_model, required=True)
    parser.add_argument("--max-tokens", type=int, default=REQUIRED_MAX_TOKENS)
    parser.add_argument("--threads", type=bounded_threads, default=4)
    parser.add_argument(
        "--request-timeout-seconds",
        type=bounded_timeout,
        default=DEFAULT_REQUEST_TIMEOUT_SECONDS,
    )
    args = parser.parse_args()
    if args.max_tokens != REQUIRED_MAX_TOKENS:
        parser.error(f"--max-tokens must equal {REQUIRED_MAX_TOKENS}")
    REQUEST_MAX_TOKENS = args.max_tokens
    REQUEST_TIMEOUT_SECONDS = args.request_timeout_seconds
    if args.out.exists():
        raise RuntimeError(f"refusing to resume StableToolBench output: {args.out}")
    args.out.parent.mkdir(parents=True, exist_ok=True)

    code_root = args.code_root.resolve()
    sys.path.insert(0, str(code_root))
    sys.path.insert(0, str(code_root / "toolbench" / "inference"))
    install_lightweight_imports()
    install_chat_model()
    from toolbench.inference.Downstream_tasks.rapidapi_multithread import (
        pipeline_runner,
    )

    runner_args = SimpleNamespace(
        api_customization=False,
        backbone_model="chatgpt_function",
        base_url=args.base_url,
        chatgpt_model=args.model,
        corpus_tsv_path="",
        disable_tqdm=False,
        input_query_file=str(args.input.resolve()),
        lora=False,
        lora_path="",
        max_observation_length=1024,
        max_query_count=200,
        max_sequence_length=8192,
        max_source_sequence_length=4096,
        method="CoT@1",
        model_path="",
        num_thread=args.threads,
        observ_compress_method="truncate",
        openai_key="benchmark-loopback-only",
        output_answer_file=str(args.out.resolve()),
        rapidapi_key="",
        retrieved_api_nums=5,
        retrieval_model_path="",
        single_chain_max_step=50,
        tool_root_dir=str(args.tool_root.resolve()),
        toolbench_key="",
        use_rapidapi_key=False,
    )
    pipeline_runner(runner_args).run()


if __name__ == "__main__":
    main()
