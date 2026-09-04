import type { JSONValue } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { emptyFunctionTools } from "../../../fixtures/function-tools";

function expectRoundTrip(
  formatted: string,
  toolName: string,
  input: Record<string, JSONValue>
): void {
  const parsed = qwen3CoderProtocol().parseGeneratedText({
    text: `prefix ${formatted} suffix`,
    tools: emptyFunctionTools,
  });
  const calls = parsed.filter((part) => part.type === "tool-call");
  expect(calls).toHaveLength(1);
  const [call] = calls;
  if (call === undefined) {
    throw new Error("Expected tool-call part");
  }
  expect(call.toolName).toBe(toolName);
  expect(JSON.parse(call.input)).toEqual(input);
}

describe("qwen3CoderProtocol", () => {
  it("formatToolCall emits Qwen3CoderProtocol markup that round-trips through parseGeneratedText", () => {
    const p = qwen3CoderProtocol();
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

    expectRoundTrip(formatted, "test_tool", { x: "1", y: ["2", "3"] });
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

    expectRoundTrip(formatted, "group/search tool", {
      "icon/default": "star",
      "display name": "Weather",
    });
  });
});
