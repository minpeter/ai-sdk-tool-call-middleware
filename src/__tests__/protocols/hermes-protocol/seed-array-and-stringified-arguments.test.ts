import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../core/protocols/hermes-protocol";
import {
  createInterleavedStream,
  extractToolInputTimeline,
  runProtocolStreamParser,
} from "../cross-protocol/tool-input/streaming-events.shared";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "list_dir",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "write_file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
];

// Exact structural shape observed from ByteDance Seed 2.0 Lite: both calls
// are complete in one JSON array, while only the wrapper close is truncated.
const SEED_ARRAY_WITH_PARTIAL_CLOSE = `<tool_call>
[
  {
    "name": "list_dir",
    "arguments": { "path": "/src" }
  },
  {
    "name": "read_file",
    "arguments": { "path": "/src/main.ts" }
  }
]
</tool`;

const STRINGIFIED_ARGUMENTS =
  '<tool_call>{"name":"write_file","arguments":"{\\"path\\":\\"fizzbuzz.py\\",\\"content\\":\\"classic interview question\\"}"}</tool_call>';
const OBJECT_ARGUMENTS =
  '<tool_call>{"name":"write_file","arguments":{"path":"fizzbuzz.py","content":"classic interview question"}}</tool_call>';
const TRAILING_PARTIAL_TOOL_CLOSE_RE = /<\/tool$/;

function textParts(chunks: readonly string[]): LanguageModelV4StreamPart[] {
  return chunks.map((delta) => ({
    type: "text-delta",
    id: "fixture-text",
    delta,
  }));
}

function rawInterleavedParts(
  chunks: readonly string[]
): LanguageModelV4StreamPart[] {
  return chunks.flatMap<LanguageModelV4StreamPart>((delta) => [
    {
      type: "raw",
      rawValue: { choices: [{ delta: { content: delta } }] },
    },
    { type: "text-delta", id: "fixture-text", delta },
  ]);
}

function generatedCalls(text: string) {
  return hermesProtocol()
    .parseGeneratedText({ text, tools })
    .filter((part) => part.type === "tool-call");
}

function generatedParts(text: string) {
  return hermesProtocol().parseGeneratedText({ text, tools });
}

async function streamedParts(options: {
  chunks: readonly string[];
  onError?: (message: string, metadata?: Record<string, unknown>) => void;
  withRaw?: boolean;
}) {
  return await runProtocolStreamParser({
    protocol: hermesProtocol(),
    tools,
    parserOptions: { onError: options.onError },
    stream: createInterleavedStream(
      options.withRaw
        ? rawInterleavedParts(options.chunks)
        : textParts(options.chunks)
    ),
  });
}

function expectAtomicCalls(
  parts: LanguageModelV4StreamPart[],
  expected: Array<{ toolName: string; input: Record<string, unknown> }>
) {
  const calls = parts.filter((part) => part.type === "tool-call");
  const timeline = extractToolInputTimeline(parts);

  expect(calls).toHaveLength(expected.length);
  expect(timeline.starts).toHaveLength(expected.length);
  expect(timeline.ends).toHaveLength(expected.length);
  expect(new Set(calls.map((call) => call.toolCallId)).size).toBe(
    expected.length
  );

  for (const [index, expectedCall] of expected.entries()) {
    const call = calls[index];
    if (call?.type !== "tool-call") {
      throw new Error(`Expected tool call at index ${index}`);
    }
    expect(call.toolName).toBe(expectedCall.toolName);
    expect(JSON.parse(call.input)).toEqual(expectedCall.input);
    expect(timeline.starts[index]?.id).toBe(call.toolCallId);
    expect(timeline.ends[index]?.id).toBe(call.toolCallId);
    expect(
      timeline.deltas
        .filter((delta) => delta.id === call.toolCallId)
        .map((delta) => delta.delta)
        .join("")
    ).toBe(call.input);
  }
  expect(
    parts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("")
  ).toBe("");
}

const expectedSeedCalls = [
  { toolName: "list_dir", input: { path: "/src" } },
  { toolName: "read_file", input: { path: "/src/main.ts" } },
];

describe("Hermes Seed array with partial wrapper close", () => {
  it("recovers the complete call array atomically in generated text", () => {
    const calls = generatedCalls(SEED_ARRAY_WITH_PARTIAL_CLOSE);
    expect(calls).toHaveLength(2);
    expect(
      calls.map((call) => ({
        toolName: call.toolName,
        input: JSON.parse(call.input),
      }))
    ).toEqual(expectedSeedCalls);
  });

  it("recovers both calls with consistent lifecycles at every stream split", async () => {
    for (
      let split = 1;
      split < SEED_ARRAY_WITH_PARTIAL_CLOSE.length;
      split += 1
    ) {
      const onError = vi.fn();
      const parts = await streamedParts({
        chunks: [
          SEED_ARRAY_WITH_PARTIAL_CLOSE.slice(0, split),
          SEED_ARRAY_WITH_PARTIAL_CLOSE.slice(split),
        ],
        onError,
      });
      expect(onError, `split at ${split}`).not.toHaveBeenCalled();
      expectAtomicCalls(parts, expectedSeedCalls);
    }
  });

  it("recovers character streaming with raw events between every character", async () => {
    const onError = vi.fn();
    const chunks = [...SEED_ARRAY_WITH_PARTIAL_CLOSE];
    const parts = await streamedParts({ chunks, onError, withRaw: true });

    expect(onError).not.toHaveBeenCalled();
    expectAtomicCalls(parts, expectedSeedCalls);
    expect(parts.filter((part) => part.type === "raw")).toHaveLength(
      chunks.length
    );
  });

  it.each([
    "</",
    "</t",
    "</tool_",
    "</tool_call",
  ])("accepts a complete array followed by the partial close %s", (partialClose) => {
    const text = SEED_ARRAY_WITH_PARTIAL_CLOSE.replace(
      TRAILING_PARTIAL_TOOL_CLOSE_RE,
      partialClose
    );
    expect(
      generatedCalls(text).map((call) => ({
        toolName: call.toolName,
        input: JSON.parse(call.input),
      }))
    ).toEqual(expectedSeedCalls);
  });

  it("preserves text before the recovered array without leaking wrapper markup", () => {
    const parts = generatedParts(`Before ${SEED_ARRAY_WITH_PARTIAL_CLOSE}`);
    expect(
      parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe("Before ");
    expect(parts.filter((part) => part.type === "tool-call")).toHaveLength(2);
  });

  it("honors configured wrapper delimiters when only their close is partial", async () => {
    const body = SEED_ARRAY_WITH_PARTIAL_CLOSE.slice(
      "<tool_call>".length
    ).replace(TRAILING_PARTIAL_TOOL_CLOSE_RE, "</cal");
    const text = `<calls>${body}`;
    const protocol = hermesProtocol({
      toolCallStart: "<calls>",
      toolCallEnd: "</calls>",
    });
    const generated = protocol
      .parseGeneratedText({ text, tools })
      .filter((part) => part.type === "tool-call");
    expect(generated).toHaveLength(2);

    const parts = await runProtocolStreamParser({
      protocol,
      tools,
      stream: createInterleavedStream(textParts([...text])),
    });
    expectAtomicCalls(parts, expectedSeedCalls);
  });

  it.each([
    {
      name: "one invalid item",
      body: '[{"name":"list_dir","arguments":{"path":"/src"}},{"name":"read_file"}]',
    },
    {
      name: "unknown tool",
      body: '[{"name":"list_dir","arguments":{"path":"/src"}},{"name":"delete_everything","arguments":{}}]',
    },
    {
      name: "prototype-sensitive arguments",
      body: '[{"name":"list_dir","arguments":{"path":"/src"}},{"name":"read_file","arguments":{"__proto__":{}}}]',
    },
    {
      name: "single-call array",
      body: '[{"name":"list_dir","arguments":{"path":"/src"}}]',
    },
    {
      name: "string arguments inside the array",
      body: '[{"name":"list_dir","arguments":"{\\"path\\":\\"/src\\"}"},{"name":"read_file","arguments":{"path":"/src/main.ts"}}]',
    },
    {
      name: "truncated JSON array",
      body: '[{"name":"list_dir","arguments":{"path":"/src"}},{"name":"read_file","arguments":{"path":"/src/main.ts"}',
    },
    {
      name: "trailing prose after the partial close",
      body: '[{"name":"list_dir","arguments":{"path":"/src"}},{"name":"read_file","arguments":{"path":"/src/main.ts"}}]\n</tool and prose',
      includesClose: true,
    },
  ])("rejects $name atomically", async ({ body, includesClose }) => {
    const text = `<tool_call>${body}${includesClose ? "" : "\n</tool"}`;
    expect(generatedCalls(text)).toHaveLength(0);

    const onError = vi.fn();
    const parts = await streamedParts({ chunks: [...text], onError });
    expect(parts.some((part) => part.type === "tool-call")).toBe(false);
    expect(parts.some((part) => part.type === "tool-input-start")).toBe(false);
    expect(parts.some((part) => part.type === "tool-input-delta")).toBe(false);
    expect(onError).toHaveBeenCalled();
  });
});

describe("Hermes stringified arguments compatibility", () => {
  it("matches ordinary object arguments in generated text without changing them", () => {
    const stringified = generatedCalls(STRINGIFIED_ARGUMENTS);
    const ordinary = generatedCalls(OBJECT_ARGUMENTS);
    expect(stringified).toHaveLength(1);
    expect(ordinary).toHaveLength(1);
    expect({
      toolName: stringified[0]?.toolName,
      input: stringified[0]?.input,
    }).toEqual({
      toolName: ordinary[0]?.toolName,
      input: ordinary[0]?.input,
    });
  });

  it("keeps stringified arguments final-input consistent at every stream split", async () => {
    for (let split = 1; split < STRINGIFIED_ARGUMENTS.length; split += 1) {
      const onError = vi.fn();
      const parts = await streamedParts({
        chunks: [
          STRINGIFIED_ARGUMENTS.slice(0, split),
          STRINGIFIED_ARGUMENTS.slice(split),
        ],
        onError,
      });
      expect(onError, `split at ${split}`).not.toHaveBeenCalled();
      expectAtomicCalls(parts, [
        {
          toolName: "write_file",
          input: {
            path: "fizzbuzz.py",
            content: "classic interview question",
          },
        },
      ]);
    }
  });

  it("keeps character streaming with raw events final-input consistent", async () => {
    const chunks = [...STRINGIFIED_ARGUMENTS];
    const onError = vi.fn();
    const parts = await streamedParts({ chunks, onError, withRaw: true });

    expect(onError).not.toHaveBeenCalled();
    expectAtomicCalls(parts, [
      {
        toolName: "write_file",
        input: {
          path: "fizzbuzz.py",
          content: "classic interview question",
        },
      },
    ]);
    expect(parts.filter((part) => part.type === "raw")).toHaveLength(
      chunks.length
    );
  });

  it.each([
    {
      name: "array-valued inner JSON",
      argumentsText: "[1,2,3]",
    },
    {
      name: "primitive-valued inner JSON",
      argumentsText: "42",
    },
    {
      name: "recursively stringified JSON",
      argumentsText: '"{\\"path\\":\\"fizzbuzz.py\\"}"',
    },
    {
      name: "invalid triple-quoted inner JSON",
      argumentsText: '{"path":"fizzbuzz.py","content":"""code"""}',
    },
    {
      name: "prototype-sensitive inner JSON",
      argumentsText: '{"path":"fizzbuzz.py","content":"ok","__proto__":{}}',
    },
  ])("rejects $name without recursive or syntax repair", async ({
    argumentsText,
  }) => {
    const encoded = JSON.stringify(argumentsText);
    const text = `<tool_call>{"name":"write_file","arguments":${encoded}}</tool_call>`;
    expect(generatedCalls(text)).toHaveLength(0);

    const onError = vi.fn();
    const parts = await streamedParts({ chunks: [...text], onError });
    expect(parts.some((part) => part.type === "tool-call")).toBe(false);
    expect(parts.some((part) => part.type === "tool-input-start")).toBe(false);
    expect(parts.some((part) => part.type === "tool-input-delta")).toBe(false);
    expect(onError).toHaveBeenCalled();
  });
});
