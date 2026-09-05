import type {
  JSONSchema7Definition,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import type { ParserOptions } from "../../../../core/protocols/protocol-interface";
import {
  collectTextDeltas,
  requireToolCall,
  runProtocolTextStream,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

function makeTool(
  name: string,
  properties: Record<string, JSONSchema7Definition>,
  additionalProperties?: boolean
): LanguageModelV4FunctionTool {
  const policy =
    additionalProperties === undefined ? {} : { additionalProperties };
  return {
    inputSchema: { type: "object", properties, ...policy },
    name,
    type: "function",
  };
}

function parseChunks(
  chunks: readonly string[],
  tools: LanguageModelV4FunctionTool[] = [],
  parserOptions?: ParserOptions
): Promise<LanguageModelV4StreamPart[]> {
  return runProtocolTextStream({
    chunks,
    id: "hermes-stream-json-repair",
    parserOptions,
    protocol: hermesProtocol(),
    tools,
  });
}

function makeDeepArrayJson(depth: number): string {
  let value = "0";
  for (let index = 0; index < depth; index += 1) {
    value = `[${value}]`;
  }
  return value;
}

function expectClosedWithoutTool(
  parts: readonly LanguageModelV4StreamPart[]
): void {
  const timeline = selectToolInputTimeline(parts);
  const lifecycleCount =
    timeline.starts.length + timeline.deltas.length + timeline.ends.length;
  expect(lifecycleCount).toBe(0);
  expect(selectToolCalls(parts)).toEqual([]);
}

function parseRawFailure(
  text: string,
  tools: LanguageModelV4FunctionTool[],
  onError: (message: string) => void
): Promise<LanguageModelV4StreamPart[]> {
  return parseChunks([text], tools, {
    onError,
    emitRawToolCallTextOnError: true,
  });
}

interface StrictRepairCase {
  readonly expected: { readonly content: string; readonly path: string };
  readonly name: string;
  readonly text: string;
}

const relaxedTopLevelText =
  '<tool_call>{name:"write",arguments:{"content":"He said "hi" there","path":"/tmp/a"}}</tool_call>';
const writeTextTool = makeTool("write", {
  path: { type: "string" },
  content: { type: "string" },
});

const strictRepairCases: readonly StrictRepairCase[] = [
  {
    name: "drops schema-unknown keys when additionalProperties is false",
    text: '<tool_call>{"name":"write","arguments":{"content":"He said "hi" there","debug":"drop me","path":"/tmp/a"}}</tool_call>',
    expected: { content: 'He said "hi" there', path: "/tmp/a" },
  },
  {
    name: "drops schema-unknown keys in strict repair even when arguments parse cleanly",
    text: '<tool_call>{"name":"write","arguments":{"content":"ok","debug":"drop me","path":"/tmp/a"}}</tool_call>',
    expected: { content: "ok", path: "/tmp/a" },
  },
];

describe("json-repair.test split 1", () => {
  it("repairs streaming tool call with unescaped quotes and emits tool-call", async () => {
    const out = await parseChunks([
      '<tool_call>{"name":"edit","arguments":{"content":"He said "hello" to me"}}</tool_call>',
    ]);
    const tool = requireToolCall(out);
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("edit");
    expect(JSON.parse(tool.input).content).toBe('He said "hello" to me');
    expect(collectTextDeltas(out)).not.toContain("<tool_call>");
  });

  it("does not repair relaxed top-level keys even when argument keys are strict JSON", async () => {
    const onError = vi.fn();
    const out = await parseRawFailure(
      relaxedTopLevelText,
      [writeTextTool],
      onError
    );
    expectClosedWithoutTool(out);
    expect(collectTextDeltas(out)).toContain(relaxedTopLevelText);
    expect(onError).toHaveBeenCalled();
  });

  it("fails closed instead of throwing for deeply nested arguments", async () => {
    const onError = vi.fn();
    const text = `<tool_call>{"name":"deep","arguments":{"data":${makeDeepArrayJson(
      20_000
    )}}}</tool_call>`;
    const out = await parseRawFailure(text, [], onError);
    expectClosedWithoutTool(out);
    expect(collectTextDeltas(out)).toContain(text);
    expect(onError).toHaveBeenCalled();
  });

  it("repairs streaming unescaped quotes before a right brace character", async () => {
    const out = await parseChunks(
      [
        '<tool_call>{"name":"edit","arguments":{"content":"He said "}" there"}}</tool_call>',
      ],
      [makeTool("edit", { content: { type: "string" } }, false)]
    );
    expect(JSON.parse(requireToolCall(out).input)).toEqual({
      content: 'He said "}" there',
    });
  });

  it("repairs with known tool schema (tools parameter provided)", async () => {
    const tools = [
      makeTool("write", {
        path: { type: "string" },
        content: { type: "string" },
      }),
    ];
    const out = await parseChunks(
      [
        "<tool_call>",
        '{"name":"write","arguments":{"path":"/tmp/test.js","content":"var x = "hello";',
        '"}}',
        "</tool_call>",
      ],
      tools
    );
    const tool = requireToolCall(out);
    expect(tool).toBeTruthy();
    expect(tool.toolName).toBe("write");
    const args = JSON.parse(tool.input);
    expect(args.path).toBe("/tmp/test.js");
    expect(args.content).toContain('"hello"');
  });

  for (const scenario of strictRepairCases) {
    it(scenario.name, async () => {
      const onError = vi.fn();
      const tools = [
        makeTool(
          "write",
          { path: { type: "string" }, content: { type: "string" } },
          false
        ),
      ];
      const out = await parseChunks([scenario.text], tools, { onError });
      const tool = requireToolCall(out);
      expect(tool.toolName).toBe("write");
      expect(JSON.parse(tool.input)).toEqual(scenario.expected);
      expect(onError).not.toHaveBeenCalled();
    });
  }
});
