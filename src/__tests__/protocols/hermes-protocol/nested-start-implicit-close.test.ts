import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../core/protocols/hermes-protocol";
import {
  createObjectTool,
  parseToolCallObject,
  runProtocolTextStream,
  selectToolCalls,
  selectToolInputTimeline,
} from "../shared/duplicate-harness";

function requiredPathTool(name: string): LanguageModelV4FunctionTool {
  return createObjectTool(name, { path: { type: "string" } }, false, ["path"]);
}

const tools: LanguageModelV4FunctionTool[] = [
  requiredPathTool("list_dir"),
  requiredPathTool("read_file"),
  createObjectTool("reject_all", { requiredValue: { type: "string" } }, false, [
    "requiredValue",
  ]),
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
  const parts = await runProtocolTextStream({
    chunks,
    id: "fixture-text",
    parserOptions: { onError },
    protocol: hermesProtocol(),
    tools,
  });
  return { onError, parts };
}

function expectBothCalls(
  parts: Awaited<ReturnType<typeof runProtocolTextStream>>
): void {
  const calls = selectToolCalls(parts);
  expect(calls.map((call) => call.toolName)).toEqual(["list_dir", "read_file"]);
  expect(calls.map(parseToolCallObject)).toEqual([
    { path: "/src" },
    { path: "/src/main.ts" },
  ]);

  const timeline = selectToolInputTimeline(parts);
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
    expect(selectToolCalls(parts).map((call) => call.toolName)).toEqual([
      "read_file",
    ]);
  });
});
