#!/usr/bin/env python3
"""Generate every HammerBench snapshot through native OpenAI tool calls."""

from __future__ import annotations

import argparse
import json
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Final

from openai import OpenAI


REQUIRED_MAX_TOKENS = 16_384
OFFICIAL_MODELS: Final = ("glm52-native", "glm52-prompt-only")


SYSTEM_PROMPT = (
    "You are evaluated on mobile function calling. Use exactly one of the supplied "
    "native tools for the current dialogue snapshot. Call the best matching tool "
    "with every argument explicitly provided so far. When required information has "
    "not been provided, still call that tool and omit unknown arguments rather than "
    "inventing values. Do not serialize or describe the call as text."
)

JSON_SCHEMA_TYPES = {
    "array",
    "boolean",
    "integer",
    "null",
    "number",
    "object",
    "string",
}
SCHEMA_TYPE_ALIASES = {"float": "number"}


def official_model(value: str) -> str:
    if value not in OFFICIAL_MODELS:
        raise argparse.ArgumentTypeError(
            "model must be glm52-native or glm52-prompt-only; "
            "the native-plus arm is retired"
        )
    return value


def openai_messages(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    output: list[dict[str, str]] = [{"role": "system", "content": SYSTEM_PROMPT}]
    for message in messages[:-1]:
        role = message.get("role")
        if role in {"user", "assistant"}:
            output.append({"role": role, "content": str(message.get("content") or "")})
    return output


def normalize_json_schema(value: Any) -> Any:
    """Map HammerBench mobile types to standards-compliant JSON Schema.

    HammerBench uses ``float`` for numeric mobile API parameters. OpenAI tool
    calling accepts JSON Schema, where the equivalent type is ``number``.
    Normalize recursively without mutating the pinned source task.
    """

    if isinstance(value, list):
        return [normalize_json_schema(item) for item in value]
    if not isinstance(value, dict):
        return value
    normalized = {
        key: normalize_json_schema(item) for key, item in value.items()
    }
    schema_type = normalized.get("type")
    if isinstance(schema_type, str):
        mapped = SCHEMA_TYPE_ALIASES.get(schema_type, schema_type)
        if mapped not in JSON_SCHEMA_TYPES:
            raise RuntimeError(f"unsupported HammerBench schema type: {schema_type}")
        normalized["type"] = mapped
    elif isinstance(schema_type, list):
        mapped_types = [
            SCHEMA_TYPE_ALIASES.get(item, item) if isinstance(item, str) else item
            for item in schema_type
        ]
        invalid = [item for item in mapped_types if item not in JSON_SCHEMA_TYPES]
        if invalid:
            raise RuntimeError(
                f"unsupported HammerBench schema type: {invalid[0]}"
            )
        normalized["type"] = mapped_types
    return normalized


def schema_type_values(value: Any) -> list[str]:
    values: list[str] = []
    if isinstance(value, list):
        for item in value:
            values.extend(schema_type_values(item))
        return values
    if not isinstance(value, dict):
        return values
    schema_type = value.get("type")
    if isinstance(schema_type, str):
        values.append(schema_type)
    elif isinstance(schema_type, list):
        values.extend(item for item in schema_type if isinstance(item, str))
    for item in value.values():
        values.extend(schema_type_values(item))
    return values


def openai_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": str(tool["name"]),
                "description": str(tool.get("description") or ""),
                "parameters": normalize_json_schema(
                    tool.get("parameters")
                    or {"type": "object", "properties": {}}
                ),
            },
        }
        for tool in tools
    ]


def load_tasks(
    data_root: Path,
) -> list[tuple[dict[str, Any], str, str, int, int]]:
    tasks: list[tuple[dict[str, Any], str, str, int, int]] = []
    global_index = 0
    for language, split in (
        ("en", "multi-turn"),
        ("en", "single-turn"),
        ("zh", "multi-turn"),
        ("zh", "single-turn"),
    ):
        path = data_root / "data" / language / f"{split}.json"
        for source_index, task in enumerate(
            json.loads(path.read_text(encoding="utf-8"))
        ):
            tasks.append((task, language, split, source_index, global_index))
            global_index += 1
    return tasks


def audit_schema_population(
    tasks: list[tuple[dict[str, Any], str, str, int, int]],
) -> dict[str, Any]:
    before: Counter[str] = Counter()
    after: Counter[str] = Counter()
    affected_tasks = 0
    for task, _language, _split, _source_index, _global_index in tasks:
        task_affected = False
        for tool in task["tools"]:
            schema = tool.get("parameters") or {
                "properties": {},
                "type": "object",
            }
            before_values = schema_type_values(schema)
            normalized = normalize_json_schema(schema)
            after_values = schema_type_values(normalized)
            before.update(before_values)
            after.update(after_values)
            if before_values != after_values:
                task_affected = True
        affected_tasks += int(task_affected)
    return {
        "affectedTasks": affected_tasks,
        "schemaTypeCountsAfter": dict(sorted(after.items())),
        "schemaTypeCountsBefore": dict(sorted(before.items())),
        "status": "valid",
        "taskCount": len(tasks),
        "typeAliases": SCHEMA_TYPE_ALIASES,
    }


def select_tasks(
    tasks: list[tuple[dict[str, Any], str, str, int, int]],
    *,
    global_index: int | None,
    limit: int | None,
) -> list[tuple[dict[str, Any], str, str, int, int]]:
    if global_index is not None:
        selected = [row for row in tasks if row[-1] == global_index]
        if len(selected) != 1:
            raise RuntimeError(f"HammerBench global index not found: {global_index}")
        return selected
    if limit is None:
        return tasks
    if limit < 1:
        raise RuntimeError("HammerBench limit must be positive")
    return tasks[:limit]


def require_error_free_generation(error_count: int) -> None:
    if error_count:
        raise RuntimeError(
            "HammerBench generation produced "
            f"{error_count} error rows; refusing complete status"
        )


class Generator:
    def __init__(
        self, base_url: str, model: str, timeout: float, max_tokens: int
    ) -> None:
        self.base_url = base_url
        self.model = model
        self.timeout = timeout
        self.max_tokens = max_tokens
        self.local = threading.local()

    def client(self) -> OpenAI:
        client = getattr(self.local, "client", None)
        if client is None:
            client = OpenAI(
                api_key="bridge-local",
                base_url=self.base_url,
                max_retries=0,
                timeout=self.timeout,
            )
            self.local.client = client
        return client

    def generate(
        self,
        task: dict[str, Any],
        *,
        language: str,
        split: str,
        source_index: int,
        global_index: int,
    ) -> dict[str, Any]:
        started = time.monotonic()
        label = task["messages"][-1]["content"]
        try:
            response = self.client().chat.completions.create(
                model=self.model,
                messages=openai_messages(task["messages"]),
                tools=openai_tools(task["tools"]),
                tool_choice="auto",
                temperature=0.001,
                max_tokens=self.max_tokens,
            )
            message = response.choices[0].message
            calls = message.tool_calls or []
            parsed_calls: list[dict[str, Any]] = []
            for call in calls:
                arguments = json.loads(call.function.arguments or "{}")
                if not isinstance(arguments, dict):
                    raise RuntimeError("tool arguments are not an object")
                parsed_calls.append(
                    {"name": call.function.name, "arguments": arguments}
                )
            if parsed_calls:
                first = parsed_calls[0]
                predict = json.dumps(
                    {"name": first["name"], "parameters": first["arguments"]},
                    ensure_ascii=False,
                )
            else:
                predict = str(message.content or "")
            usage = response.usage.model_dump(mode="json") if response.usage else None
            error = None
        except Exception as exception:  # A fresh provider failure is an in-population failure.
            parsed_calls = []
            predict = ""
            usage = None
            error = f"{type(exception).__name__}: {exception}"[:2000]
        dialogue = "\n".join(
            f"{message['role']}:{message['content']}"
            for message in task["messages"][:-1]
            if message.get("role") in {"user", "assistant"}
        )
        return {
            "error": error,
            "globalIndex": global_index,
            "id": str(task["id"]),
            "input": dialogue,
            "label": label,
            "language": language,
            "latencyMs": round((time.monotonic() - started) * 1000),
            "model": self.model,
            "predict": predict,
            "sourceIndex": source_index,
            "split": split,
            "toolCalls": parsed_calls,
            "usage": usage,
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--base-url")
    parser.add_argument("--model", type=official_model)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--max-tokens", type=int, default=REQUIRED_MAX_TOKENS)
    parser.add_argument("--global-index", type=int)
    parser.add_argument(
        "--limit",
        type=int,
        help="deterministic prefix size for an explicitly non-scoring preflight",
    )
    parser.add_argument("--schema-audit-only", action="store_true")
    args = parser.parse_args()
    if args.max_tokens != REQUIRED_MAX_TOKENS:
        parser.error(f"--max-tokens must equal {REQUIRED_MAX_TOKENS}")
    tasks = load_tasks(args.data_root)
    schema_audit = audit_schema_population(tasks)
    if args.schema_audit_only:
        print(json.dumps(schema_audit, sort_keys=True))
        return
    if not args.base_url or not args.model or args.out is None:
        parser.error("--base-url, --model, and --out are required for inference")
    tasks = select_tasks(
        tasks,
        global_index=args.global_index,
        limit=args.limit,
    )
    if args.out.exists():
        raise RuntimeError(f"refusing to reuse HammerBench output: {args.out}")
    generator = Generator(args.base_url, args.model, args.timeout, args.max_tokens)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf-8") as handle:
        with ThreadPoolExecutor(max_workers=args.threads) as executor:
            futures = [
                executor.submit(
                    generator.generate,
                    task,
                    language=language,
                    split=split,
                    source_index=source_index,
                    global_index=index,
                )
                for task, language, split, source_index, index in tasks
            ]
            completed = 0
            error_count = 0
            for future in as_completed(futures):
                row = future.result()
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
                completed += 1
                error_count += int(row.get("error") is not None)
                if completed % 100 == 0:
                    handle.flush()
                    print(f"completed={completed}/{len(tasks)}", flush=True)
    require_error_free_generation(error_count)
    print(
        json.dumps(
            {
                "model": args.model,
                "rows": len(tasks),
                "schemaAudit": schema_audit,
                "status": "complete",
            }
        )
    )


if __name__ == "__main__":
    main()
