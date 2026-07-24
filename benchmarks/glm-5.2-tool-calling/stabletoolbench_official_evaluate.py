#!/usr/bin/env python3
"""Run StableToolBench's normalized ToolEval pass-rate judge completely."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from pathlib import Path
from typing import Any

import yaml
from openai import OpenAI


ARMS = ("gpt-native", "gpt-prompt-only")
EVALUATIONS = (0, 1, 2)
ANSWER_STATUSES = {"Solved", "Unsolved", "Unsure"}


def read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path}: expected a JSON object")
    return value


def convert_answers(
    *,
    code_root: Path,
    inference_root: Path,
    converted_root: Path,
    groups: list[str],
) -> None:
    script = code_root / "toolbench" / "tooleval" / "convert_to_answer_format.py"
    workdir = script.parent
    for arm in ARMS:
        arm_root = converted_root / arm
        arm_root.mkdir(parents=True, exist_ok=False)
        for group in groups:
            subprocess.run(
                [
                    sys.executable,
                    str(script),
                    "--answer_dir",
                    str((inference_root / arm / group).resolve()),
                    "--method",
                    "CoT@1",
                    "--output",
                    str((arm_root / f"{group}.json").resolve()),
                ],
                cwd=workdir,
                check=True,
            )


def tool_steps(example: dict[str, Any]) -> tuple[str, str]:
    answer = example.get("answer")
    if not isinstance(answer, dict):
        raise RuntimeError("converted answer is missing answer")
    details = answer.get("answer_details")
    if not isinstance(details, list) or not details or not isinstance(details[0], dict):
        raise RuntimeError("converted answer is missing answer_details")
    current = details[0]
    steps: list[str] = []
    final_step = ""
    step_number = 1
    while "next" in current:
        message = current.get("message")
        if message and current.get("role") == "tool":
            step = f"Step {step_number}: {message}"
            steps.append(step)
            final_step = f"Final step: {message}"
            step_number += 1
        following = current.get("next")
        if not following:
            break
        if not isinstance(following, list) or not isinstance(following[0], dict):
            raise RuntimeError("converted answer contains invalid graph linkage")
        current = following[0]
    return "\n".join(steps), final_step


def has_finish_call(example: dict[str, Any]) -> bool:
    _steps, final_step = tool_steps(example)
    return "'name': 'Finish'" in final_step


class ToolEvalJudge:
    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        template_path: Path,
        config_path: Path,
        timeout: float,
    ) -> None:
        self.base_url = base_url
        self.model = model
        self.timeout = timeout
        self.local = threading.local()
        template = template_path.read_text(encoding="utf-8")
        self.prompts: dict[str, str] = {}
        for function in re.findall(r"<function>(.*?)</function>", template, re.DOTALL):
            name_match = re.findall(r"<name>(.*?)</name>", function, re.DOTALL)
            description_match = re.findall(
                r"<description>(.*?)</description>", function, re.DOTALL
            )
            if len(name_match) != 1 or len(description_match) != 1:
                raise RuntimeError("invalid pinned ToolEval function template")
            self.prompts[name_match[0]] = description_match[0]
        config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
        functions = config.get("completions_kwargs", {}).get("functions")
        if not isinstance(functions, list):
            raise RuntimeError("pinned ToolEval config is missing functions")
        self.functions = {
            str(function["name"]): function
            for function in functions
            if isinstance(function, dict) and "name" in function
        }

    def client(self) -> OpenAI:
        client = getattr(self.local, "client", None)
        if client is None:
            client = OpenAI(
                api_key="benchmark-loopback-only",
                base_url=self.base_url,
                max_retries=0,
                timeout=self.timeout,
            )
            self.local.client = client
        return client

    def function_call(self, name: str, arguments: dict[str, str]) -> dict[str, Any]:
        if name not in self.prompts or name not in self.functions:
            raise RuntimeError(f"pinned ToolEval function is unavailable: {name}")
        function = deepcopy(self.functions[name])
        parameters = function.get("parameters")
        if not isinstance(parameters, dict):
            raise RuntimeError(f"pinned ToolEval function has no parameters: {name}")
        properties = parameters.get("properties")
        required = parameters.get("required")
        if not isinstance(properties, dict) or not isinstance(required, list):
            raise RuntimeError(f"pinned ToolEval function schema is invalid: {name}")
        properties["reason"] = {
            "description": "explain your answer.",
            "type": "string",
        }
        if "reason" not in required:
            required.append("reason")
        prompt = self.prompts[name].format(**arguments)
        last_error: Exception | None = None
        for attempt in range(1, 4):
            try:
                response = self.client().chat.completions.create(
                    model=self.model,
                    messages=[{"role": "user", "content": prompt}],
                    tools=[{"type": "function", "function": function}],
                    tool_choice={"type": "function", "function": {"name": name}},
                    temperature=0.2,
                    max_tokens=1000,
                )
                calls = response.choices[0].message.tool_calls or []
                if len(calls) != 1 or calls[0].function.name != name:
                    raise RuntimeError(f"judge did not return forced tool {name}")
                parsed = json.loads(calls[0].function.arguments)
                if not isinstance(parsed, dict):
                    raise RuntimeError("judge tool arguments are not an object")
                missing = [field for field in required if field not in parsed]
                if missing:
                    raise RuntimeError(
                        f"judge tool arguments are missing required field: {missing[0]}"
                    )
                return parsed
            except Exception as error:
                last_error = error
                if attempt < 3:
                    time.sleep(2 ** (attempt - 1))
        raise RuntimeError(f"ToolEval judge exhausted retries for {name}") from last_error

    def answer_status(self, example: dict[str, Any]) -> tuple[str, int]:
        answer = example.get("answer")
        if not isinstance(answer, dict):
            raise RuntimeError("converted answer is missing answer")
        final_answer = answer.get("final_answer")
        if not isinstance(final_answer, str):
            raise RuntimeError("converted answer is missing final_answer")
        if not final_answer or "give_up_and_restart" in final_answer:
            return "Unsolved", 0
        result = self.function_call(
            "check_answer_status",
            {
                "answer": final_answer,
                "query": str(example.get("query") or ""),
            },
        )
        status = result.get("answer_status")
        calls = 1
        if status not in ANSWER_STATUSES:
            raise RuntimeError(f"judge returned invalid answer_status: {status!r}")
        if status == "Unsure":
            result = self.function_call(
                "parse_answer_status",
                {
                    "answer": json.dumps(answer, ensure_ascii=False),
                    "query": str(example.get("query") or ""),
                },
            )
            status = result.get("answer_status")
            calls += 1
            if status not in ANSWER_STATUSES:
                raise RuntimeError(f"judge returned invalid answer_status: {status!r}")
        return str(status), calls


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--code-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--inference-root", type=Path, required=True)
    parser.add_argument("--converted-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", default="glm52-simulator")
    parser.add_argument("--threads", type=int, default=12)
    parser.add_argument("--timeout", type=float, default=180)
    args = parser.parse_args()
    if args.converted_root.exists() or args.output_root.exists():
        raise RuntimeError("refusing to reuse StableToolBench evaluation output")
    manifest = read_object(args.manifest.resolve())
    rows = manifest.get("rows")
    if not isinstance(rows, list) or len(rows) != 765:
        raise RuntimeError("StableToolBench manifest is not exactly 765 rows")
    expected: dict[str, set[str]] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise RuntimeError("StableToolBench manifest row is invalid")
        expected.setdefault(str(row["group"]), set()).add(str(row["queryId"]))
    groups = sorted(expected)
    convert_answers(
        code_root=args.code_root.resolve(),
        inference_root=args.inference_root.resolve(),
        converted_root=args.converted_root.resolve(),
        groups=groups,
    )
    judge = ToolEvalJudge(
        base_url=args.base_url,
        model=args.model,
        template_path=(
            args.code_root
            / "toolbench/tooleval/evaluators/tooleval_gpt-3.5-turbo_default/template.txt"
        ).resolve(),
        config_path=(
            args.code_root
            / "toolbench/tooleval/evaluators/tooleval_gpt-3.5-turbo_default/config.yaml"
        ).resolve(),
        timeout=args.timeout,
    )
    args.output_root.mkdir(parents=True, exist_ok=False)
    total_jobs = 765 * len(ARMS) * len(EVALUATIONS)
    completed_jobs = 0
    provider_calls = 0
    for arm in ARMS:
        arm_output = args.output_root / arm
        arm_output.mkdir()
        for group in groups:
            examples = read_object(args.converted_root / arm / f"{group}.json")
            if set(examples) != expected[group]:
                raise RuntimeError(
                    f"{arm}/{group}: converted answer coverage mismatch "
                    f"rows={len(examples)}/{len(expected[group])}"
                )
            output: dict[str, dict[str, Any]] = {}
            for query_id, example in examples.items():
                if not isinstance(example, dict):
                    raise RuntimeError(f"{arm}/{group}/{query_id}: invalid answer")
                steps, final_step = tool_steps(example)
                tool_names = []
                available = example.get("available_tools")
                if isinstance(available, list):
                    for tool in available:
                        if not isinstance(tool, dict):
                            continue
                        function = tool.get("function")
                        name = (
                            function.get("name")
                            if isinstance(function, dict)
                            else tool.get("name")
                        )
                        if isinstance(name, str):
                            tool_names.append(name)
                output[query_id] = {
                    "answer_steps": steps,
                    "final_step": final_step,
                    "is_solved": {},
                    "query": str(example.get("query") or ""),
                    "tool_names": tool_names,
                }
            with ThreadPoolExecutor(max_workers=args.threads) as executor:
                future_map = {}
                for query_id, example in examples.items():
                    for evaluation in EVALUATIONS:
                        if has_finish_call(example):
                            future = executor.submit(judge.answer_status, example)
                            future_map[future] = (query_id, evaluation)
                        else:
                            output[query_id]["is_solved"][str(evaluation)] = (
                                "AnswerStatus.Unsolved"
                            )
                            completed_jobs += 1
                for future in as_completed(future_map):
                    query_id, evaluation = future_map[future]
                    status, calls = future.result()
                    output[query_id]["is_solved"][str(evaluation)] = (
                        f"AnswerStatus.{status}"
                    )
                    provider_calls += calls
                    completed_jobs += 1
                    if completed_jobs % 100 == 0:
                        print(
                            f"completed={completed_jobs}/{total_jobs} "
                            f"judgeCalls={provider_calls}",
                            flush=True,
                        )
            destination = arm_output / f"{group}_{arm}.json"
            with destination.open("x", encoding="utf-8") as handle:
                json.dump(output, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.write("\n")
    if completed_jobs != total_jobs:
        raise RuntimeError(
            f"StableToolBench judge job mismatch: {completed_jobs}/{total_jobs}"
        )
    print(
        json.dumps(
            {
                "evaluationRows": total_jobs,
                "judgeProviderCalls": provider_calls,
                "status": "complete",
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
