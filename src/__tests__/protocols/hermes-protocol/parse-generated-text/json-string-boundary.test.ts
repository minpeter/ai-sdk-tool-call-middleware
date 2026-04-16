import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("parseGeneratedText – end tag inside JSON string values", () => {
  it("does not split on </tool_call> inside a JSON string value", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"bash","arguments":{"command":"echo \'</tool_call>\' test"}}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [] });

    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("tool-call");
    const tc = out[0] as any;
    expect(tc.toolName).toBe("bash");
    expect(JSON.parse(tc.input)).toEqual({
      command: "echo '</tool_call>' test",
    });
  });

  it("handles multiple tool calls where one contains end tag in string value", () => {
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"a","arguments":{}}</tool_call>' +
      " middle " +
      '<tool_call>{"name":"bash","arguments":{"cmd":"</tool_call>"}}</tool_call>' +
      " end";
    const out = p.parseGeneratedText({ text, tools: [] });

    const toolCalls = out.filter((e) => e.type === "tool-call") as any[];
    const textParts = out
      .filter((e) => e.type === "text")
      .map((e) => (e as any).text);

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].toolName).toBe("a");
    expect(toolCalls[1].toolName).toBe("bash");
    expect(JSON.parse(toolCalls[1].input)).toEqual({ cmd: "</tool_call>" });
    expect(textParts.join("")).toContain("middle");
    expect(textParts.join("")).toContain("end");
  });

  it("still parses normal tool calls correctly (regression check)", () => {
    const p = hermesProtocol();
    const text =
      'before <tool_call>{"name":"get_weather","arguments":{"city":"NYC"}}</tool_call> after';
    const out = p.parseGeneratedText({ text, tools: [] });

    const toolCalls = out.filter((e) => e.type === "tool-call") as any[];
    const textParts = out
      .filter((e) => e.type === "text")
      .map((e) => (e as any).text);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolName).toBe("get_weather");
    expect(JSON.parse(toolCalls[0].input)).toEqual({ city: "NYC" });
    expect(textParts.join("")).toContain("before");
    expect(textParts.join("")).toContain("after");
  });

  it("handles escaped quotes adjacent to end tag in string value", () => {
    const p = hermesProtocol();
    // The argument value is: say \"</tool_call>\" ok
    const text =
      '<tool_call>{"name":"bash","arguments":{"cmd":"say \\"</tool_call>\\" ok"}}</tool_call>';
    const out = p.parseGeneratedText({ text, tools: [] });

    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("tool-call");
    const tc = out[0] as any;
    expect(tc.toolName).toBe("bash");
    const parsed = JSON.parse(tc.input);
    expect(parsed.cmd).toBe('say "</tool_call>" ok');
  });
});
