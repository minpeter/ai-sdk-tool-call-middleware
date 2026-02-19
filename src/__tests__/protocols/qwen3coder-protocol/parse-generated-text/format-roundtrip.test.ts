import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";

describe("qwen3CoderProtocol", () => {
  it("formatToolCall emits Qwen3CoderProtocol markup that round-trips through parseGeneratedText", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const formatted = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "test_tool",
      input: JSON.stringify({ x: "1", y: ["2", "3"] }),
    });

    expect(formatted).toContain("<tool_call>");
    expect(formatted).toContain('<function="test_tool">');
    expect(formatted).toContain('<parameter="x">1</parameter>');
    expect(formatted).toContain('<parameter="y">2</parameter>');
    expect(formatted).toContain('<parameter="y">3</parameter>');

    const parsed = p.parseGeneratedText({
      text: `prefix ${formatted} suffix`,
      tools,
    });
    const calls = parsed.filter((x) => x.type === "tool-call");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("test_tool");
    expect(JSON.parse(call.input)).toEqual({ x: "1", y: ["2", "3"] });
  });

  it("formatToolCall serializes boolean/null values using Qwen3-Coder template string semantics", () => {
    const p = qwen3CoderProtocol();
    const formatted = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "test_tool",
      input: JSON.stringify({ strict: false, enabled: true, optional: null }),
    });

    expect(formatted).toContain('<parameter="strict">False</parameter>');
    expect(formatted).toContain('<parameter="enabled">True</parameter>');
    expect(formatted).toContain('<parameter="optional">None</parameter>');
  });

  it("formatToolCall quotes function and parameter shorthand names for round-trip safety", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const formatted = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "group/search tool",
      input: JSON.stringify({
        "icon/default": "star",
        "display name": "Weather",
      }),
    });

    expect(formatted).toContain('<function="group/search tool">');
    expect(formatted).toContain('<parameter="icon/default">star</parameter>');
    expect(formatted).toContain(
      '<parameter="display name">Weather</parameter>'
    );

    const parsed = p.parseGeneratedText({
      text: `prefix ${formatted} suffix`,
      tools,
    });
    const calls = parsed.filter((x) => x.type === "tool-call");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("group/search tool");
    expect(JSON.parse(call.input)).toEqual({
      "icon/default": "star",
      "display name": "Weather",
    });
  });
});
