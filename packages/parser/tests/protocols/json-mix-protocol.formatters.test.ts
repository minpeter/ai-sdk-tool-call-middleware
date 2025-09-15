import { describe, expect, it, vi } from "vitest";

import { jsonMixProtocol } from "@/protocols/json-mix-protocol";

// Mock generateId to avoid dependency issues in tests
vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "test-id"),
}));

describe("jsonMixProtocol formatters and parseGeneratedText edges", () => {
  it("formatToolCall stringifies input JSON and non-JSON inputs", () => {
    const p = jsonMixProtocol();
    const xml = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "run",
      input: '{"a":1}',
    } as any);
    expect(xml).toContain("<tool_call>");
    const xml2 = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "run",
      input: "not-json" as any,
    } as any);
    expect(xml2).toContain("run");
  });

  it("parseGeneratedText falls back to text on malformed tool call", () => {
    const p = jsonMixProtocol();
    const out = p.parseGeneratedText({
      text: "prefix <tool_call>{bad}</tool_call> suffix",
      tools: [],
    });
    const combined = out
      .map((c: any) => (c.type === "text" ? c.text : ""))
      .join("");
    expect(combined).toContain("<tool_call>{bad}</tool_call>");
  });
});
