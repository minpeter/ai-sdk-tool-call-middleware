import { describe, expect, it, vi } from "vitest";

import { jsonMixProtocol } from "@/protocols/json-mix-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("gemmaToolMiddleware configuration with multiple tags", () => {
  it("should handle both ` and ``` as end tags for tool calls", () => {
    // Test the protocol configuration that the Gemma middleware uses
    const protocol = jsonMixProtocol({
      toolCallStart: "```tool_call\n",
      toolCallEnd: ["\n```", "`"],
      toolResponseStart: "```tool_response\n",
      toolResponseEnd: "\n```",
    });

    // Test with ` end tag (should match first in the text)
    const text1 = 'Text before ```tool_call\n{"name": "test", "arguments": {"x": 1}}` text after';
    const result1 = protocol.parseGeneratedText({ text: text1, tools: [] });
    
    expect(result1).toHaveLength(3);
    expect(result1[0]).toEqual({ type: "text", text: "Text before " });
    expect(result1[1]).toMatchObject({ 
      type: "tool-call", 
      toolName: "test", 
      input: '{"x":1}' 
    });
    expect(result1[2]).toEqual({ type: "text", text: " text after" });

    // Test with \n``` end tag
    const text2 = 'Text before ```tool_call\n{"name": "test", "arguments": {"x": 2}}\n``` text after';
    const result2 = protocol.parseGeneratedText({ text: text2, tools: [] });
    
    expect(result2).toHaveLength(3);
    expect(result2[0]).toEqual({ type: "text", text: "Text before " });
    expect(result2[1]).toMatchObject({ 
      type: "tool-call", 
      toolName: "test", 
      input: '{"x":2}' 
    });
    expect(result2[2]).toEqual({ type: "text", text: " text after" });
  });

  it("should prioritize the first matching end tag", () => {
    const protocol = jsonMixProtocol({
      toolCallStart: "```tool_call\n",
      toolCallEnd: ["\n```", "`"],
      toolResponseStart: "```tool_response\n", 
      toolResponseEnd: "\n```",
    });

    // Text with ` first, then ```
    const text = 'Before ```tool_call\n{"name": "test", "arguments": {"x": 1}}` remaining \n```';
    const result = protocol.parseGeneratedText({ text, tools: [] });
    
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: "text", text: "Before " });
    expect(result[1]).toMatchObject({ 
      type: "tool-call", 
      toolName: "test", 
      input: '{"x":1}' 
    });
    expect(result[2]).toEqual({ type: "text", text: " remaining \n```" });
  });

  it("should format using the primary start/end tags", () => {
    const protocol = jsonMixProtocol({
      toolCallStart: "```tool_call\n",
      toolCallEnd: ["\n```", "`"],
      toolResponseStart: "```tool_response\n",
      toolResponseEnd: "\n```",
    });

    const formatted = protocol.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "test_func",
      input: '{"param": "value"}',
    } as any);

    expect(formatted).toBe('```tool_call\n{"name":"test_func","arguments":{"param":"value"}}\n```');
  });
});