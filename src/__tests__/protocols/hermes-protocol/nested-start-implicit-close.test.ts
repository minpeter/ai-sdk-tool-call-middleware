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
    name: "reject_all",
    inputSchema: false as never,
  },
];

const NEMOTRON_MISSING_FIRST_CLOSE =
  '<tool_call>{"name":"list_dir","arguments":{"path":"/src"}}\n' +
  '<tool_call>{"name":"read_file","arguments":{"path":"/src/main.ts"}}</tool_call>';

function generatedCalls(text: string) {
  return hermesProtocol()
    .parseGeneratedText({ text, tools })
    .filter((part) => part.type === "tool-call");
}

async function streamedParts(chunks: readonly string[], onError = vi.fn()) {
  const textParts: LanguageModelV4StreamPart[] = chunks.map((delta) => ({
    type: "text-delta",
    id: "fixture-text",
    delta,
  }));
  const parts = await runProtocolStreamParser({
    protocol: hermesProtocol(),
    tools,
    parserOptions: { onError },
    stream: createInterleavedStream(textParts),
  });
  return { onError, parts };
}

function expectBothCalls(parts: LanguageModelV4StreamPart[]) {
  const calls = parts.filter((part) => part.type === "tool-call");
  expect(calls.map((call) => call.toolName)).toEqual(["list_dir", "read_file"]);
  expect(calls.map((call) => JSON.parse(call.input))).toEqual([
    { path: "/src" },
    { path: "/src/main.ts" },
  ]);

  const timeline = extractToolInputTimeline(parts);
  expect(timeline.starts).toHaveLength(2);
  expect(timeline.ends).toHaveLength(2);
  expect(new Set(calls.map((call) => call.toolCallId)).size).toBe(2);
}

describe("Hermes implicit close before a nested tool-call start", () => {
  it("recovers the exact Nemotron shape in generated text", () => {
    const calls = generatedCalls(NEMOTRON_MISSING_FIRST_CLOSE);
    expect(calls.map((call) => call.toolName)).toEqual([
      "list_dir",
      "read_file",
    ]);
    expect(calls.map((call) => JSON.parse(call.input))).toEqual([
      { path: "/src" },
      { path: "/src/main.ts" },
    ]);
  });

  it("recovers the exact Nemotron shape in a single stream chunk", async () => {
    const { onError, parts } = await streamedParts([
      NEMOTRON_MISSING_FIRST_CLOSE,
    ]);
    expectBothCalls(parts);
    expect(onError).not.toHaveBeenCalled();
  });

  it("is invariant across every two-chunk boundary", async () => {
    for (
      let split = 1;
      split < NEMOTRON_MISSING_FIRST_CLOSE.length;
      split += 1
    ) {
      const { onError, parts } = await streamedParts([
        NEMOTRON_MISSING_FIRST_CLOSE.slice(0, split),
        NEMOTRON_MISSING_FIRST_CLOSE.slice(split),
      ]);
      expectBothCalls(parts);
      expect(onError).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      label: "unknown tool",
      first: '{"name":"unknown","arguments":{"path":"/src"}}',
    },
    {
      label: "schema-rejected argument object",
      first: '{"name":"reject_all","arguments":{}}',
    },
    {
      label: "prototype-sensitive argument key",
      first:
        '{"name":"list_dir","arguments":{"path":"/src","__proto__":{"polluted":true}}}',
    },
    {
      label: "relaxed rather than strict JSON",
      first: '{name:"list_dir",arguments:{path:"/src"}}',
    },
    {
      label: "missing arguments property",
      first: '{"name":"list_dir"}',
    },
  ])("does not implicitly close a $label call", async ({ first }) => {
    const text =
      `<tool_call>${first}\n` +
      '<tool_call>{"name":"read_file","arguments":{"path":"/src/main.ts"}}</tool_call>';

    expect(generatedCalls(text).map((call) => call.toolName)).toEqual([
      "read_file",
    ]);
    const { parts } = await streamedParts([text]);
    expect(
      parts
        .filter((part) => part.type === "tool-call")
        .map((call) => call.toolName)
    ).toEqual(["read_file"]);
  });
});
