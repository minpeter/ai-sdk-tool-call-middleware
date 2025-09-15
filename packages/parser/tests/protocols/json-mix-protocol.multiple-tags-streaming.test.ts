import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { jsonMixProtocol } from "@/protocols/json-mix-protocol";

// Mock generateId to avoid dependency issues in tests
vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "test-id"),
}));

function collect(stream: ReadableStream<LanguageModelV2StreamPart>) {
  const out: LanguageModelV2StreamPart[] = [];
  return (async () => {
    for await (const c of stream) out.push(c);
    return out;
  })();
}

// Helper function to randomly split text into 2-3 chunks
function randomSplit(text: string, minChunks = 2, maxChunks = 3): string[] {
  if (text.length <= 1) return [text];
  
  const numChunks = Math.floor(Math.random() * (maxChunks - minChunks + 1)) + minChunks;
  const chunks: string[] = [];
  let remaining = text;
  
  for (let i = 0; i < numChunks - 1; i++) {
    const splitPoint = Math.floor(Math.random() * (remaining.length - 1)) + 1;
    chunks.push(remaining.substring(0, splitPoint));
    remaining = remaining.substring(splitPoint);
  }
  chunks.push(remaining);
  
  return chunks.filter(chunk => chunk.length > 0);
}

// Helper function to create a stream from chunks
function createStreamFromChunks(chunks: string[]): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream<LanguageModelV2StreamPart>({
    start(ctrl) {
      chunks.forEach(chunk => {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: chunk });
      });
      ctrl.enqueue({
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });
      ctrl.close();
    },
  });
}

describe("jsonMixProtocol multiple tags streaming", () => {
  describe("random chunk splitting", () => {
    it("should handle tool calls when randomly split into 2-3 chunks", async () => {
      const protocol = jsonMixProtocol({
        toolCallStart: "<tool_call>",
        toolCallEnd: ["</tool_call>", "`", "```"],
      });

      const testCases = [
        'Before <tool_call>{"name": "test1", "arguments": {"x": 1}}</tool_call> after',
        'Before <tool_call>{"name": "test2", "arguments": {"x": 2}}` after',
        'Before <tool_call>{"name": "test3", "arguments": {"x": 3}}``` after',
      ];

      for (const testCase of testCases) {
        // Test multiple random splits for each case
        for (let i = 0; i < 5; i++) {
          const chunks = randomSplit(testCase);
          const transformer = protocol.createStreamParser({ tools: [] });
          const rs = createStreamFromChunks(chunks);
          const out = await collect(rs.pipeThrough(transformer));
          
          const toolCall = out.find(c => c.type === "tool-call") as any;
          expect(toolCall).toBeTruthy();
          expect(toolCall.toolName).toBe(`test${testCase.includes("test1") ? "1" : testCase.includes("test2") ? "2" : "3"}`);
          
          const textDeltas = out
            .filter(c => c.type === "text-delta")
            .map((c: any) => c.delta)
            .join("");
          expect(textDeltas).toContain("Before ");
          expect(textDeltas).toContain(" after");
        }
      }
    });

    it("should handle multiple tool calls in random chunks", async () => {
      const protocol = jsonMixProtocol({
        toolCallStart: "<tool_call>",
        toolCallEnd: ["</tool_call>", "`"],
      });

      const text = 'First <tool_call>{"name": "tool1", "arguments": {}}` middle <tool_call>{"name": "tool2", "arguments": {}}</tool_call> end';
      
      // Test multiple random splits
      for (let i = 0; i < 10; i++) {
        const chunks = randomSplit(text);
        const transformer = protocol.createStreamParser({ tools: [] });
        const rs = createStreamFromChunks(chunks);
        const out = await collect(rs.pipeThrough(transformer));
        
        const toolCalls = out.filter(c => c.type === "tool-call") as any[];
        expect(toolCalls).toHaveLength(2);
        expect(toolCalls[0].toolName).toBe("tool1");
        expect(toolCalls[1].toolName).toBe("tool2");
      }
    });
  });

  describe("backtick vs triple backtick edge cases", () => {
    it("should correctly handle when ` is detected first but stream continues to ```", async () => {
      const protocol = jsonMixProtocol({
        toolCallStart: "<tool_call>",
        toolCallEnd: ["`", "```"],
      });

      const transformer = protocol.createStreamParser({ tools: [] });
      const rs = new ReadableStream<LanguageModelV2StreamPart>({
        start(ctrl) {
          // Send tool call start and JSON
          ctrl.enqueue({ type: "text-delta", id: "1", delta: '<tool_call>{"name": "test", "arguments": {}}' });
          // Send first backtick - this should complete the tool call
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "`" });
          // Send two more backticks - these should be treated as regular text
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "``" });
          // Send some trailing text
          ctrl.enqueue({ type: "text-delta", id: "1", delta: " more text" });
          ctrl.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          });
          ctrl.close();
        },
      });

      const out = await collect(rs.pipeThrough(transformer));
      
      const toolCall = out.find(c => c.type === "tool-call") as any;
      expect(toolCall).toBeTruthy();
      expect(toolCall.toolName).toBe("test");
      
      const textDeltas = out
        .filter(c => c.type === "text-delta")
        .map((c: any) => c.delta)
        .join("");
      expect(textDeltas).toBe("`` more text");
    });

    it("should handle case where ``` and ` are both options (earliest complete match wins)", async () => {
      const protocol = jsonMixProtocol({
        toolCallStart: "<tool_call>",
        toolCallEnd: ["```", "`"], // Both are valid, earliest complete match wins
      });

      const transformer = protocol.createStreamParser({ tools: [] });
      const rs = new ReadableStream<LanguageModelV2StreamPart>({
        start(ctrl) {
          ctrl.enqueue({ type: "text-delta", id: "1", delta: '<tool_call>{"name": "test", "arguments": {}}' });
          // Send a single backtick first - this completes as ` since it's a valid complete match
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "`" });
          // Then two more backticks - these should be treated as regular text
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "``" });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: " after" });
          ctrl.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          });
          ctrl.close();
        },
      });

      const out = await collect(rs.pipeThrough(transformer));
      
      const toolCall = out.find(c => c.type === "tool-call") as any;
      expect(toolCall).toBeTruthy();
      expect(toolCall.toolName).toBe("test");
      
      const textDeltas = out
        .filter(c => c.type === "text-delta")
        .map((c: any) => c.delta)
        .join("");
      expect(textDeltas).toBe("`` after");
    });

    it("should handle partial matches correctly when streaming backticks", async () => {
      const protocol = jsonMixProtocol({
        toolCallStart: "<tool_call>",
        toolCallEnd: ["`", "```"],
      });

      const transformer = protocol.createStreamParser({ tools: [] });
      const rs = new ReadableStream<LanguageModelV2StreamPart>({
        start(ctrl) {
          ctrl.enqueue({ type: "text-delta", id: "1", delta: '<tool_call>{"name": "test", "arguments": {}}' });
          // Send backticks one by one to test partial matching
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "`" });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "`" });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "`" });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: " text" });
          ctrl.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          });
          ctrl.close();
        },
      });

      const out = await collect(rs.pipeThrough(transformer));
      
      const toolCall = out.find(c => c.type === "tool-call") as any;
      expect(toolCall).toBeTruthy();
      expect(toolCall.toolName).toBe("test");
      
      // The first ` should close the tool call, remaining `` should be text
      const textDeltas = out
        .filter(c => c.type === "text-delta")
        .map((c: any) => c.delta)
        .join("");
      expect(textDeltas).toBe("`` text");
    });

    it("should handle partial matches vs complete matches correctly", async () => {
      const protocol = jsonMixProtocol({
        toolCallStart: "<tool_call>",
        toolCallEnd: ["```", "`"],
      });

      const transformer = protocol.createStreamParser({ tools: [] });
      const rs = new ReadableStream<LanguageModelV2StreamPart>({
        start(ctrl) {
          ctrl.enqueue({ type: "text-delta", id: "1", delta: '<tool_call>{"name": "test", "arguments": {}}' });
          // Send partial triple backtick - should wait for more since it's not a complete match yet
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "`" });
          // Send another backtick - still have a complete ` match, but also partial ``` match
          // The complete ` match should win and close the tool call
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "`" });
          // This should be treated as regular text
          ctrl.enqueue({ type: "text-delta", id: "1", delta: " more" });
          ctrl.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          });
          ctrl.close();
        },
      });

      const out = await collect(rs.pipeThrough(transformer));
      
      // Should have a tool call since the first ` completed it
      const toolCall = out.find(c => c.type === "tool-call");
      expect(toolCall).toBeTruthy();
      
      // Should have the remaining ` and text as normal text
      const textDeltas = out
        .filter(c => c.type === "text-delta")
        .map((c: any) => c.delta)
        .join("");
      expect(textDeltas).toContain("` more");
    });

    it("should demonstrate ` vs ``` behavior when streaming incrementally (user's specific case)", async () => {
      // This test specifically addresses the user's comment about how ` vs ``` behaves
      const protocol = jsonMixProtocol({
        toolCallStart: "<tool_call>",
        toolCallEnd: ["`", "```"], // ` comes first in array, ``` second
      });

      const transformer = protocol.createStreamParser({ tools: [] });
      const rs = new ReadableStream<LanguageModelV2StreamPart>({
        start(ctrl) {
          ctrl.enqueue({ type: "text-delta", id: "1", delta: '<tool_call>{"name": "weather", "arguments": {}}' });
          // Send one backtick - this immediately completes the tool call with ` end tag
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "`" });
          // Later we get more backticks - but tool call is already complete
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "``" });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: " done" });
          ctrl.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          });
          ctrl.close();
        },
      });

      const out = await collect(rs.pipeThrough(transformer));
      
      const toolCall = out.find(c => c.type === "tool-call") as any;
      expect(toolCall).toBeTruthy();
      expect(toolCall.toolName).toBe("weather");
      
      // The remaining `` should be emitted as text, not treated as part of ```
      const textDeltas = out
        .filter(c => c.type === "text-delta")
        .map((c: any) => c.delta)
        .join("");
      expect(textDeltas).toBe("`` done");
    });
  });

  describe("complex streaming scenarios", () => {
    it("should handle tool call split across many chunks with different end tags", async () => {
      const protocol = jsonMixProtocol({
        toolCallStart: "<tool_call>",
        toolCallEnd: ["</tool_call>", "`", "```"],
      });

      const transformer = protocol.createStreamParser({ tools: [] });
      const rs = new ReadableStream<LanguageModelV2StreamPart>({
        start(ctrl) {
          // Split a tool call across many small chunks
          const chunks = [
            "Before ",
            "<tool",
            "_call>",
            '{"name":',
            '"weather"',
            ',"arguments":',
            '{"location"',
            ':"NYC"',
            "}}",
            "`",
            " after"
          ];
          
          chunks.forEach(chunk => {
            ctrl.enqueue({ type: "text-delta", id: "1", delta: chunk });
          });
          
          ctrl.enqueue({
            type: "finish",
            finishReason: "stop", 
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          });
          ctrl.close();
        },
      });

      const out = await collect(rs.pipeThrough(transformer));
      
      const toolCall = out.find(c => c.type === "tool-call") as any;
      expect(toolCall).toBeTruthy();
      expect(toolCall.toolName).toBe("weather");
      expect(JSON.parse(toolCall.input)).toEqual({ location: "NYC" });
      
      const textDeltas = out
        .filter(c => c.type === "text-delta")
        .map((c: any) => c.delta)
        .join("");
      expect(textDeltas).toBe("Before  after");
    });

    it("should handle mixed end tags in same stream", async () => {
      const protocol = jsonMixProtocol({
        toolCallStart: "<tool_call>",
        toolCallEnd: ["</tool_call>", "`", "```"],
      });

      const transformer = protocol.createStreamParser({ tools: [] });
      const rs = new ReadableStream<LanguageModelV2StreamPart>({
        start(ctrl) {
          const content = 'First <tool_call>{"name": "tool1", "arguments": {}}` middle <tool_call>{"name": "tool2", "arguments": {}}</tool_call> then <tool_call>{"name": "tool3", "arguments": {}}``` end';
          
          // Split randomly
          const chunks = randomSplit(content);
          chunks.forEach(chunk => {
            ctrl.enqueue({ type: "text-delta", id: "1", delta: chunk });
          });
          
          ctrl.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          });
          ctrl.close();
        },
      });

      const out = await collect(rs.pipeThrough(transformer));
      
      const toolCalls = out.filter(c => c.type === "tool-call") as any[];
      expect(toolCalls).toHaveLength(3);
      expect(toolCalls[0].toolName).toBe("tool1");
      expect(toolCalls[1].toolName).toBe("tool2"); 
      expect(toolCalls[2].toolName).toBe("tool3");
    });

    it("should handle error recovery with multiple end tags", async () => {
      const onError = vi.fn();
      const protocol = jsonMixProtocol({
        toolCallStart: "<tool_call>",
        toolCallEnd: ["`", "```"],
      });

      const transformer = protocol.createStreamParser({
        tools: [],
        options: { onError },
      });

      const rs = new ReadableStream<LanguageModelV2StreamPart>({
        start(ctrl) {
          ctrl.enqueue({ type: "text-delta", id: "1", delta: '<tool_call>{invalid json}` normal <tool_call>{"name": "valid", "arguments": {}}```' });
          ctrl.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          });
          ctrl.close();
        },
      });

      const out = await collect(rs.pipeThrough(transformer));
      
      // Should have one valid tool call and one error
      const toolCall = out.find(c => c.type === "tool-call") as any;
      expect(toolCall).toBeTruthy();
      expect(toolCall.toolName).toBe("valid");
      
      expect(onError).toHaveBeenCalled();
      
      const textDeltas = out
        .filter(c => c.type === "text-delta") 
        .map((c: any) => c.delta)
        .join("");
      expect(textDeltas).toContain("{invalid json}");
    });
  });

  describe("edge cases with streaming", () => {
    it("should handle empty chunks correctly", async () => {
      const protocol = jsonMixProtocol({
        toolCallStart: "<tool_call>",
        toolCallEnd: ["`", "```"],
      });

      const transformer = protocol.createStreamParser({ tools: [] });
      const rs = new ReadableStream<LanguageModelV2StreamPart>({
        start(ctrl) {
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "" });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: '<tool_call>{"name": "test", "arguments": {}}' });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "" });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "`" });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "" });
          ctrl.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          });
          ctrl.close();
        },
      });

      const out = await collect(rs.pipeThrough(transformer));
      
      const toolCall = out.find(c => c.type === "tool-call") as any;
      expect(toolCall).toBeTruthy();
      expect(toolCall.toolName).toBe("test");
    });

    it('should handle when buffer ends with partial match at finish', async () => {
      const protocol = jsonMixProtocol({
        toolCallStart: "<tool_call>",
        toolCallEnd: ["```"],
      });

      const transformer = protocol.createStreamParser({ tools: [] });
      const rs = new ReadableStream<LanguageModelV2StreamPart>({
        start(ctrl) {
          ctrl.enqueue({ type: "text-delta", id: "1", delta: '<tool_call>{"name": "test", "arguments": {}}``' });
          ctrl.enqueue({
            type: "finish", 
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          });
          ctrl.close();
        },
      });

      const out = await collect(rs.pipeThrough(transformer));
      
      // Should not create a tool call since ``` was never completed
      const toolCall = out.find(c => c.type === "tool-call");
      expect(toolCall).toBeFalsy();
      
      // Should flush the incomplete content as text
      const textDeltas = out
        .filter(c => c.type === "text-delta")
        .map((c: any) => c.delta)
        .join("");
      expect(textDeltas).toContain('<tool_call>{"name": "test", "arguments": {}}``');
    });
  });
});