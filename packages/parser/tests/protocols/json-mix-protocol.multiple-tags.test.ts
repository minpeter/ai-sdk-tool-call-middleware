import { describe, expect, it, vi } from "vitest";

import { jsonMixProtocol } from "@/protocols/json-mix-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("jsonMixProtocol multiple tags support", () => {
  describe("parseGeneratedText with multiple end tags", () => {
    it("should parse tool calls with different end tags", () => {
      const protocol = jsonMixProtocol({
        toolCallStart: "<tool_call>",
        toolCallEnd: ["</tool_call>", "`", "```"],
      });

      const text1 = 'Before <tool_call>{"name": "test", "arguments": {"x": 1}}</tool_call> after';
      const result1 = protocol.parseGeneratedText({ text: text1, tools: [] });
      
      expect(result1).toEqual([
        { type: "text", text: "Before " },
        { 
          type: "tool-call", 
          toolCallId: "mock-id", 
          toolName: "test", 
          input: '{"x":1}' 
        },
        { type: "text", text: " after" }
      ]);

      const text2 = 'Before <tool_call>{"name": "test", "arguments": {"x": 2}}` after';
      const result2 = protocol.parseGeneratedText({ text: text2, tools: [] });
      
      expect(result2).toEqual([
        { type: "text", text: "Before " },
        { 
          type: "tool-call", 
          toolCallId: "mock-id", 
          toolName: "test", 
          input: '{"x":2}' 
        },
        { type: "text", text: " after" }
      ]);

      const text3 = 'Before <tool_call>{"name": "test", "arguments": {"x": 3}}``` after';
      const result3 = protocol.parseGeneratedText({ text: text3, tools: [] });
      
      expect(result3).toEqual([
        { type: "text", text: "Before " },
        { 
          type: "tool-call", 
          toolCallId: "mock-id", 
          toolName: "test", 
          input: '{"x":3}' 
        },
        { type: "text", text: "`` after" }
      ]);
    });

    it("should prioritize earlier matches when multiple end tags are present", () => {
      const protocol = jsonMixProtocol({
        toolCallStart: "<tool_call>",
        toolCallEnd: ["</tool_call>", "`"],
      });

      const text = 'Before <tool_call>{"name": "test", "arguments": {"x": 1}}` and more </tool_call> after';
      const result = protocol.parseGeneratedText({ text, tools: [] });
      
      expect(result).toEqual([
        { type: "text", text: "Before " },
        { 
          type: "tool-call", 
          toolCallId: "mock-id", 
          toolName: "test", 
          input: '{"x":1}' 
        },
        { type: "text", text: " and more </tool_call> after" }
      ]);
    });

    it("should work with multiple start tags", () => {
      const protocol = jsonMixProtocol({
        toolCallStart: ["<tool_call>", "```tool_call\n"],
        toolCallEnd: ["</tool_call>", "\n```"],
      });

      const text1 = 'Before <tool_call>{"name": "test", "arguments": {"x": 1}}</tool_call> after';
      const result1 = protocol.parseGeneratedText({ text: text1, tools: [] });
      
      expect(result1).toEqual([
        { type: "text", text: "Before " },
        { 
          type: "tool-call", 
          toolCallId: "mock-id", 
          toolName: "test", 
          input: '{"x":1}' 
        },
        { type: "text", text: " after" }
      ]);

      const text2 = 'Before ```tool_call\n{"name": "test", "arguments": {"x": 2}}\n``` after';
      const result2 = protocol.parseGeneratedText({ text: text2, tools: [] });
      
      expect(result2).toEqual([
        { type: "text", text: "Before " },
        { 
          type: "tool-call", 
          toolCallId: "mock-id", 
          toolName: "test", 
          input: '{"x":2}' 
        },
        { type: "text", text: " after" }
      ]);
    });
  });

  describe("formatToolCall maintains backward compatibility", () => {
    it("should use first tag for formatting when multiple tags are provided", () => {
      const protocol = jsonMixProtocol({
        toolCallStart: ["<tool_call>", "```tool_call\n"],
        toolCallEnd: ["</tool_call>", "\n```"],
      });

      const result = protocol.formatToolCall({
        type: "tool-call",
        toolCallId: "id",
        toolName: "test_func",
        input: '{"param": "value"}',
      } as any);

      expect(result).toBe('<tool_call>{"name":"test_func","arguments":{"param":"value"}}</tool_call>');
    });
  });

  describe("extractToolCallSegments with multiple tags", () => {
    it("should extract all tool call segments regardless of which tags are used", () => {
      const protocol = jsonMixProtocol({
        toolCallStart: "<tool_call>",
        toolCallEnd: ["</tool_call>", "`", "```"],
      });

      const text = `
        <tool_call>{"name": "test1", "arguments": {}}</tool_call>
        Some text
        <tool_call>{"name": "test2", "arguments": {}}\`
        More text
        <tool_call>{"name": "test3", "arguments": {}}\`\`\`
      `;

      const segments = protocol.extractToolCallSegments!({ text, tools: [] });
      
      expect(segments).toHaveLength(3);
      expect(segments[0]).toContain("test1");
      expect(segments[1]).toContain("test2");
      expect(segments[2]).toContain("test3");
    });
  });

  describe("backward compatibility", () => {
    it("should work exactly like before when single strings are provided", () => {
      const protocol = jsonMixProtocol({
        toolCallStart: "<tool_call>",
        toolCallEnd: "</tool_call>",
      });

      const text = 'Before <tool_call>{"name": "test", "arguments": {"x": 1}}</tool_call> after';
      const result = protocol.parseGeneratedText({ text, tools: [] });
      
      expect(result).toEqual([
        { type: "text", text: "Before " },
        { 
          type: "tool-call", 
          toolCallId: "mock-id", 
          toolName: "test", 
          input: '{"x":1}' 
        },
        { type: "text", text: " after" }
      ]);
    });

    it("should work with default values", () => {
      const protocol = jsonMixProtocol();

      const text = 'Before <tool_call>{"name": "test", "arguments": {"x": 1}}</tool_call> after';
      const result = protocol.parseGeneratedText({ text, tools: [] });
      
      expect(result).toEqual([
        { type: "text", text: "Before " },
        { 
          type: "tool-call", 
          toolCallId: "mock-id", 
          toolName: "test", 
          input: '{"x":1}' 
        },
        { type: "text", text: " after" }
      ]);
    });
  });
});