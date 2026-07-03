import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  createChunkedStream,
  pipeWithTransformer,
} from "../../../test-helpers";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
    },
  },
];

type ToolCallPart = Extract<LanguageModelV4StreamPart, { type: "tool-call" }>;

async function runStream(
  text: string,
  onError?: (message: string, metadata?: Record<string, unknown>) => void
): Promise<LanguageModelV4StreamPart[]> {
  const protocol = hermesProtocol();
  return await convertReadableStreamToArray(
    pipeWithTransformer(
      createChunkedStream(text),
      protocol.createStreamParser({ tools, options: { onError } })
    )
  );
}

function joinedText(parts: LanguageModelV4StreamPart[]): string {
  return parts
    .filter((p) => p.type === "text-delta")
    .map((p) => (p as { delta: string }).delta)
    .join("");
}

describe("hermes streaming mismatched-close salvage", () => {
  it("salvages a call closed with a wrong tag (e.g. </think>) at finish", async () => {
    const out = await runStream(
      '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</think>'
    );

    const toolCall = out.find((p) => p.type === "tool-call") as ToolCallPart;
    expect(toolCall).toBeDefined();
    expect(toolCall.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall.input)).toEqual({ city: "Seoul" });

    // No protocol markup leaks into visible text.
    expect(joinedText(out)).toBe("");
  });

  it("salvages a call missing its close tag entirely", async () => {
    const out = await runStream(
      '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}'
    );

    const toolCall = out.find((p) => p.type === "tool-call") as ToolCallPart;
    expect(toolCall).toBeDefined();
    expect(JSON.parse(toolCall.input)).toEqual({ city: "Seoul" });
  });

  it("salvages consecutive calls separated by orphan <tool_call> tags", async () => {
    // Real-world GLM-4.7 parallel-call shape: no closing tags at all, the
    // next <tool_call> acts as a separator.
    const out = await runStream(
      '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}'
    );

    const calls = out.filter((p) => p.type === "tool-call") as ToolCallPart[];
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => JSON.parse(c.input).city)).toEqual([
      "Seoul",
      "Tokyo",
    ]);
    expect(joinedText(out)).toBe("");
  });

  it("does not salvage genuinely truncated JSON", async () => {
    const onError = vi.fn();
    const out = await runStream(
      '<tool_call>{"name":"get_weather","argu',
      onError
    );

    expect(out.some((p) => p.type === "tool-call")).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("Could not complete streaming JSON tool call"),
      expect.objectContaining({ dropReason: "unfinished-tool-call" })
    );
  });

  it("does not salvage bodies with trailing non-markup prose", async () => {
    const onError = vi.fn();
    const out = await runStream(
      '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}} and then some prose',
      onError
    );

    expect(out.some((p) => p.type === "tool-call")).toBe(false);
    expect(onError).toHaveBeenCalled();
  });
});

describe("hermes parseGeneratedText mismatched-close salvage", () => {
  it("salvages a wrong close tag inside a well-formed tool_call span", () => {
    const protocol = hermesProtocol();
    const out = protocol.parseGeneratedText({
      text: '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</think></tool_call>',
      tools,
    });

    const toolCall = out.find((p) => p.type === "tool-call");
    expect(toolCall).toMatchObject({ toolName: "get_weather" });
    // The stray </think> inside the span is markup, not visible text.
    expect(out.some((p) => p.type === "text")).toBe(false);
  });

  it("keeps the text fallback for spans with trailing prose", () => {
    const onError = vi.fn();
    const protocol = hermesProtocol();
    const out = protocol.parseGeneratedText({
      text: '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}} definitely prose</tool_call>',
      tools,
      options: { onError },
    });

    expect(out.some((p) => p.type === "tool-call")).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("Could not process JSON tool call"),
      expect.objectContaining({ dropReason: "malformed-tool-call-body" })
    );
  });
});

describe("hermes double-encoded and array-wrapped salvage", () => {
  // Real-world shape observed from IBM Granite 4.0: arguments serialized as
  // a JSON string (the OpenAI native wire habit).
  const doubleEncoded =
    '<tool_call>\n{"name": "get_weather", "arguments": "{\\n  \\"city\\": \\"Seoul\\",\\n  \\"unit\\": \\"celsius\\"\\n}"}\n</tool_call>';

  // Real-world shape observed from ByteDance Seed 2.0: an array of calls
  // inside a single tool_call block.
  const arrayWrapped =
    '<tool_call>\n[{"name": "get_weather", "arguments": {"city": "Seoul"}},\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}]\n</tool_call>';

  it("parses string-typed arguments in parseGeneratedText", () => {
    const protocol = hermesProtocol();
    const out = protocol.parseGeneratedText({ text: doubleEncoded, tools });

    const toolCall = out.find((p) => p.type === "tool-call");
    if (toolCall?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(toolCall.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall.input)).toEqual({
      city: "Seoul",
      unit: "celsius",
    });
  });

  it("parses string-typed arguments in streaming", async () => {
    const out = await runStream(doubleEncoded);

    const toolCall = out.find((p) => p.type === "tool-call") as ToolCallPart;
    expect(toolCall).toBeDefined();
    expect(JSON.parse(toolCall.input)).toEqual({
      city: "Seoul",
      unit: "celsius",
    });
    expect(joinedText(out)).toBe("");
  });

  it("salvages an array of calls in parseGeneratedText", () => {
    const protocol = hermesProtocol();
    const out = protocol.parseGeneratedText({ text: arrayWrapped, tools });

    const calls = out.filter((p) => p.type === "tool-call");
    expect(calls).toHaveLength(2);
    expect(
      calls.map((c) => JSON.parse((c as ToolCallPart).input).city)
    ).toEqual(["Seoul", "Tokyo"]);
    expect(out.some((p) => p.type === "text")).toBe(false);
  });

  it("salvages an array of calls in streaming", async () => {
    const out = await runStream(arrayWrapped);

    const calls = out.filter((p) => p.type === "tool-call") as ToolCallPart[];
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => JSON.parse(c.input).city)).toEqual([
      "Seoul",
      "Tokyo",
    ]);
    expect(joinedText(out)).toBe("");
  });
});
