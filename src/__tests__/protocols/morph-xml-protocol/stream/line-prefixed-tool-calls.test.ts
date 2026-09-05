import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import type { ProtocolMetadata } from "../../../../core/protocols/protocol-interface";
import { stopFinishReason, zeroUsage } from "../../../test-helpers";
import { assertCanonicalAiSdkEventOrder } from "../../cross-protocol/tool-input/streaming-events.shared";
import {
  collectProtocolStream,
  collectTextDeltas,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

function pathTool(name: string): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  };
}

const tools: LanguageModelV4FunctionTool[] = [
  pathTool("list_dir"),
  pathTool("read_file"),
  {
    type: "function",
    name: "write_file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        read_file: { type: "string" },
      },
      required: ["path", "read_file"],
      additionalProperties: false,
    },
  },
];

// Exact structural shape observed from Devstral Medium: both opening root
// brackets and the first root close are missing; the second root close remains.
const DEVSTRAL_LINE_PREFIXED_CALLS =
  "list_dir\n" +
  "  <path>/src</path>\n" +
  "read_file\n" +
  "  <path>/src/main.ts</path>\n" +
  "</read_file>";

function generatedCalls(text: string) {
  return morphXmlProtocol()
    .parseGeneratedText({ text, tools })
    .filter((part) => part.type === "tool-call");
}

function interleavedParts(chunks: readonly string[]) {
  return chunks.flatMap<LanguageModelV4StreamPart>((delta) => [
    { type: "raw", rawValue: { choices: [{ delta: { content: delta } }] } },
    { type: "text-delta", id: "fixture-text", delta },
  ]);
}

function streamedParts(options: {
  readonly chunks: readonly string[];
  readonly onError?: (message: string, metadata?: ProtocolMetadata) => void;
  readonly withRaw?: boolean;
}) {
  const textParts: LanguageModelV4StreamPart[] = options.chunks.map(
    (delta) => ({ type: "text-delta", id: "fixture-text", delta })
  );
  const parts = options.withRaw ? interleavedParts(options.chunks) : textParts;
  parts.push({
    type: "finish",
    finishReason: stopFinishReason,
    usage: zeroUsage,
  });
  return collectProtocolStream({
    protocol: morphXmlProtocol(),
    tools,
    parserOptions: { onError: options.onError },
    parts,
  });
}

function expectBothCalls(parts: readonly LanguageModelV4StreamPart[]): void {
  const calls = selectToolCalls(parts);
  expect(calls.map((call) => call.toolName)).toEqual(["list_dir", "read_file"]);
  expect(calls.map((call) => JSON.parse(call.input))).toEqual([
    { path: "/src" },
    { path: "/src/main.ts" },
  ]);

  const timeline = selectToolInputTimeline(parts);
  expect(timeline.starts.map((part) => part.toolName)).toEqual([
    "list_dir",
    "read_file",
  ]);
  expect(timeline.ends).toHaveLength(2);
  expect(new Set(calls.map((call) => call.toolCallId)).size).toBe(2);
  expect(collectTextDeltas(parts)).not.toContain("</read_file>");
  assertCanonicalAiSdkEventOrder([...parts]);
}

async function expectStreamAndGeneratedCalls(text: string): Promise<void> {
  const parts = await streamedParts({ chunks: Array.from(text) });
  expectBothCalls(parts);
  expect(generatedCalls(text).map((call) => call.toolName)).toEqual([
    "list_dir",
    "read_file",
  ]);
}

describe("MorphXML streaming line-prefixed tool calls", () => {
  it("recovers both calls from the exact Devstral output", async () => {
    const parts = await streamedParts({
      chunks: [DEVSTRAL_LINE_PREFIXED_CALLS],
    });
    expectBothCalls(parts);
  });

  it("matches generated-text recovery for both Devstral calls", () => {
    const calls = generatedCalls(DEVSTRAL_LINE_PREFIXED_CALLS);
    const names = calls.map(({ toolName }) => toolName);
    const inputs = calls.map(({ input }) => JSON.parse(input));
    expect(names).toEqual(["list_dir", "read_file"]);
    expect(inputs).toEqual([{ path: "/src" }, { path: "/src/main.ts" }]);
  });

  it("is invariant across every two-chunk boundary", async () => {
    for (
      let split = 1;
      split < DEVSTRAL_LINE_PREFIXED_CALLS.length;
      split += 1
    ) {
      const parts = await streamedParts({
        chunks: [
          DEVSTRAL_LINE_PREFIXED_CALLS.slice(0, split),
          DEVSTRAL_LINE_PREFIXED_CALLS.slice(split),
        ],
      });
      expectBothCalls(parts);
    }
  });

  it("keeps partial line-prefixed calls buffered across raw chunks", async () => {
    const chunks = Array.from(DEVSTRAL_LINE_PREFIXED_CALLS);
    const parts = await streamedParts({ chunks, withRaw: true });
    expectBothCalls(parts);
    expect(parts.filter((part) => part.type === "raw")).toHaveLength(
      chunks.length
    );
  });

  it.each([
    {
      label: "explicit close before a normal second call",
      text:
        "list_dir\n" +
        "<path>/src</path>\n" +
        "</list_dir>\n" +
        "<read_file><path>/src/main.ts</path></read_file>",
    },
    {
      label: "a normal second call as the implicit first-call boundary",
      text:
        "list_dir\n" +
        "<path>/src</path>\n" +
        "<read_file><path>/src/main.ts</path></read_file>",
    },
  ])("recovers a line-prefixed call before $label", async ({ text }) => {
    await expectStreamAndGeneratedCalls(text);
  });

  it("recovers a line-prefixed call after a normal first call", async () => {
    const text =
      "<list_dir><path>/src</path></list_dir>\n" +
      "read_file\n" +
      "<path>/src/main.ts</path>\n" +
      "</read_file>";
    await expectStreamAndGeneratedCalls(text);
  });

  it("finalizes a single line-prefixed call only when the stream finishes", async () => {
    const text = "list_dir\n<path>/src</path>";
    const parts = await streamedParts({
      chunks: ["list_dir\n", "<path>/src</path>"],
    });
    const calls = parts.filter((part) => part.type === "tool-call");
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("list_dir");
    expect(JSON.parse(calls[0].input)).toEqual({ path: "/src" });
    expect(collectTextDeltas(parts)).not.toContain(text);
  });

  it("preserves trailing prose after a completed line-prefixed call", async () => {
    const parts = await streamedParts({
      chunks: ["list_dir\n<path>/src</path>\nDone."],
    });
    expect(
      parts
        .filter((part) => part.type === "tool-call")
        .map((part) => part.toolName)
    ).toEqual(["list_dir"]);
    expect(collectTextDeltas(parts)).toContain("Done.");
  });

  it("preserves a parameter whose name matches another tool", async () => {
    const text =
      "write_file\n" +
      "<path>/tmp/result.txt</path>\n" +
      "<read_file>/src/input.txt</read_file>\n" +
      "</write_file>";
    const expectedInput = {
      path: "/tmp/result.txt",
      read_file: "/src/input.txt",
    };

    const generated = generatedCalls(text);
    expect(generated).toHaveLength(1);
    expect(generated[0]?.toolName).toBe("write_file");
    expect(JSON.parse(generated[0]?.input ?? "null")).toEqual(expectedInput);

    const parts = await streamedParts({ chunks: Array.from(text) });
    const streamed = parts.filter((part) => part.type === "tool-call");
    expect(streamed).toHaveLength(1);
    expect(streamed[0]?.toolName).toBe("write_file");
    expect(JSON.parse(streamed[0]?.input ?? "null")).toEqual(expectedInput);
    assertCanonicalAiSdkEventOrder(parts);
  });

  it.each([
    "list_dir\nI can help with that.",
    "Mention list_dir inline, but do not call it.",
    "list_dir\n<path>/src",
  ])("preserves non-call text without inventing a call: %s", async (text) => {
    const parts = await streamedParts({ chunks: Array.from(text) });
    expect(parts.some((part) => part.type === "tool-call")).toBe(false);
    expect(collectTextDeltas(parts)).toBe(text);
  });

  it("rejects a prototype-sensitive first call and continues to the next call", async () => {
    const onError = vi.fn();
    const text =
      "list_dir\n" +
      "<path>/src</path><__proto__><polluted>true</polluted></__proto__>\n" +
      "read_file\n" +
      "<path>/src/main.ts</path>\n" +
      "</read_file>";
    const parts = await streamedParts({ chunks: [text], onError });

    expect(
      parts
        .filter((part) => part.type === "tool-call")
        .map((part) => part.toolName)
    ).toEqual(["read_file"]);
    expect(onError).toHaveBeenCalled();
  });
});
