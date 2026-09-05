import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  hasProseOutsideXmlCalls,
  serializeQwenToolParserCalls,
} from "../../../../core/protocols/qwen3coder-stream-salvage";

const TOOL_CALL_ID_RE = /^call_[A-Za-z0-9]{24}$/;

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "search",
    description: "Search by query",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
    },
  },
];

describe("Qwen stream salvage coverage", () => {
  it.each([
    ["ordinary text", false],
    ["<tool_call>plain prose", true],
    ["<tool_call>closed prose</tool_call>", true],
    ["<tool_call><parameter=query>value</tool_call>outside", false],
    ["<tool_call>   ", false],
    ["<tool_call>prose <function=search></function>", true],
    ["<tool_call>  <function=search></function>", false],
    [
      "<tool_call><function=search></function>between<call=search></call>",
      true,
    ],
    ["<tool_call><function=search></function>after", true],
    ["<tool_call><function=search></function><tail>", false],
    ["<tool_call><tail", false],
    ["<tool_call><>after", true],
    ["<tool_call><tail></tail>after", true],
    ["<tool_call><tail>after", true],
    ["<tool_call><parameter=query>after", false],
    ['<tool_call name="search"><query>after', false],
    ['<tool_call name="missing"><query>after', true],
  ])("classifies prose boundaries in %s", (markup, expected) => {
    // Given potentially salvageable Qwen markup
    // When prose outside XML calls is detected
    const result = hasProseOutsideXmlCalls(markup, tools);

    // Then only visible text outside a value tag is classified as prose
    expect(result).toBe(expected);
  });

  it("serializes valid parser calls", () => {
    // Given valid parsed calls
    const calls = [
      { toolName: "search", args: { query: "weather" } },
      { toolName: "missing", args: { raw: true } },
    ];

    // When calls are serialized
    const serialized = serializeQwenToolParserCalls(calls, tools);

    // Then schema coercion, fallback serialization, IDs, and cardinality are preserved
    expect(serialized).toHaveLength(2);
    expect(
      serialized?.map(({ toolName, input }) => ({ toolName, input }))
    ).toEqual([
      { toolName: "search", input: '{"query":"weather"}' },
      { toolName: "missing", input: '{"raw":true}' },
    ]);
    expect(
      serialized?.every(({ toolCallId }) => TOOL_CALL_ID_RE.test(toolCallId))
    ).toBe(true);
  });

  it("preserves an empty parser call list", () => {
    // Given no parsed calls
    // When the empty list is serialized
    const serialized = serializeQwenToolParserCalls([], tools);

    // Then no synthetic call is introduced
    expect(serialized).toEqual([]);
  });

  it("fails closed when a parsed call contains a prototype-sensitive key", () => {
    // Given a parsed call whose arguments cannot be safely serialized
    const calls = [{ toolName: "search", args: { constructor: "blocked" } }];

    // When calls are serialized
    const serialized = serializeQwenToolParserCalls(calls, tools);

    // Then the complete salvage batch is rejected
    expect(serialized).toBeNull();
  });
});
