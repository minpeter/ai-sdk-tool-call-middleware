import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../protocols/morph-xml-protocol";

const EXPECTED_NUMBER_1 = 1;
const EXPECTED_NUMBER_2 = 2;
const EXPECTED_NUMBER_3 = 3;
const EXPECTED_NUMBER_5 = 5;
const EXPECTED_NUMBER_7 = 7;
const EXPECTED_NUMBER_100 = 100;
const EXPECTED_NUMBER_200 = 200;
const EXPECTED_COORD_10_5 = 10.5;
const EXPECTED_COORD_20_3 = 20.3;
const EXPECTED_COORD_1_5 = 1.5;
const EXPECTED_COORD_2_5 = 2.5;
const EXPECTED_COORD_46_603354 = 46.603_354;
const EXPECTED_COORD_1_888334 = 1.888_334;
const CHUNK_SIZE = 10;

describe("XML Protocol Heuristic Streaming", () => {
  const protocol = morphXmlProtocol();

  // Helper function to simulate streaming
  async function simulateStreaming(text: string, tools: any[]) {
    const streamParser = protocol.createStreamParser({ tools });
    const chunks: any[] = [];

    const readable = new ReadableStream({
      start(controller) {
        // Split text into smaller chunks to simulate streaming
        const chunkSize = CHUNK_SIZE;
        for (let i = 0; i < text.length; i += chunkSize) {
          const chunk = text.slice(i, i + chunkSize);
          controller.enqueue({
            type: "text-delta" as const,
            delta: chunk,
          });
        }
        controller.close();
      },
    });

    const transformed = readable.pipeThrough(streamParser);
    const reader = transformed.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    return chunks;
  }

  describe("Streaming multiple tags handling", () => {
    it("should handle streaming multiple tags conversion", async () => {
      const text = `<math_sum>
        <numbers>3</numbers>
        <numbers>5</numbers>
        <numbers>7</numbers>
      </math_sum>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "math_sum",
          inputSchema: {
            type: "object",
            properties: {
              numbers: {
                type: "array",
                items: { type: "number" },
              },
            },
          },
        },
      ];

      const chunks = await simulateStreaming(text, tools);
      const toolCalls = chunks.filter((chunk) => chunk.type === "tool-call");

      expect(toolCalls).toHaveLength(1);
      const input = JSON.parse(toolCalls[0].input);
      expect(input.numbers).toEqual([
        EXPECTED_NUMBER_3,
        EXPECTED_NUMBER_5,
        EXPECTED_NUMBER_7,
      ]);
    });
  });

  describe("Streaming indexed tuple processing", () => {
    it("should handle streaming indexed tags conversion", async () => {
      const text = `<set_point>
        <coordinates>
          <0>10.5</0>
          <1>20.3</1>
        </coordinates>
      </set_point>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "set_point",
          inputSchema: {
            type: "object",
            properties: {
              coordinates: {
                type: "array",
                items: { type: "number" },
              },
            },
          },
        },
      ];

      const chunks = await simulateStreaming(text, tools);
      const toolCalls = chunks.filter((chunk) => chunk.type === "tool-call");

      expect(toolCalls).toHaveLength(1);
      const input = JSON.parse(toolCalls[0].input);
      expect(input.coordinates).toEqual([
        EXPECTED_COORD_10_5,
        EXPECTED_COORD_20_3,
      ]);
    });
  });

  describe("Streaming item key pattern processing", () => {
    it("should handle streaming item array conversion", async () => {
      const text = `<get_coordinates>
        <position>
          <item>46.603354</item>
          <item>1.8883340</item>
        </position>
      </get_coordinates>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "get_coordinates",
          inputSchema: {
            type: "object",
            properties: {
              position: {
                type: "array",
                items: { type: "number" },
              },
            },
          },
        },
      ];

      const chunks = await simulateStreaming(text, tools);
      const toolCalls = chunks.filter((chunk) => chunk.type === "tool-call");

      expect(toolCalls).toHaveLength(1);
      const input = JSON.parse(toolCalls[0].input);
      expect(input.position).toEqual([
        EXPECTED_COORD_46_603354,
        EXPECTED_COORD_1_888334,
      ]);
    });
  });

  describe("Streaming complex scenarios", () => {
    it("should handle streaming with mixed heuristics", async () => {
      const text = `<complex_data>
        <coordinates>
          <item>1.5</item>
          <item>2.5</item>
        </coordinates>
        <dimensions>
          <0>100</0>
          <1>200</1>
        </dimensions>
        <tags>
          <tag>urgent</tag>
          <tag>important</tag>
        </tags>
      </complex_data>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "complex_data",
          inputSchema: {
            type: "object",
            properties: {
              coordinates: {
                type: "array",
                items: { type: "number" },
              },
              dimensions: {
                type: "array",
                items: { type: "number" },
              },
              tags: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      ];

      const chunks = await simulateStreaming(text, tools);
      const toolCalls = chunks.filter((chunk) => chunk.type === "tool-call");

      expect(toolCalls).toHaveLength(1);
      const input = JSON.parse(toolCalls[0].input);
      expect(input.coordinates).toEqual([
        EXPECTED_COORD_1_5,
        EXPECTED_COORD_2_5,
      ]);
      expect(input.dimensions).toEqual([
        EXPECTED_NUMBER_100,
        EXPECTED_NUMBER_200,
      ]);
      expect(input.tags).toEqual(["urgent", "important"]);
    });

    it("should handle streaming with text content between tags", async () => {
      const text = `Some text before
      <process_list>
        <items>
          <item>first</item>
          <item>second</item>
          <item>third</item>
        </items>
      </process_list>
      Some text after`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "process_list",
          inputSchema: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      ];

      const chunks = await simulateStreaming(text, tools);
      const toolCalls = chunks.filter((chunk) => chunk.type === "tool-call");
      const textChunks = chunks.filter((chunk) => chunk.type === "text-delta");

      expect(toolCalls).toHaveLength(1);
      const input = JSON.parse(toolCalls[0].input);
      expect(input.items).toEqual(["first", "second", "third"]);

      // Should also preserve text content
      expect(textChunks.length).toBeGreaterThan(0);
      const allText = textChunks.map((chunk) => chunk.delta).join("");
      expect(allText).toContain("Some text before");
      expect(allText).toContain("Some text after");
    });
  });

  describe("Streaming edge cases", () => {
    it("should handle streaming with interrupted tags", async () => {
      const text = `<incomplete_test>
        <values>
          <item>complete</item>
          <item>partial`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "incomplete_test",
          inputSchema: {
            type: "object",
            properties: {
              values: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      ];

      const chunks = await simulateStreaming(text, tools);

      // Should not produce a tool call for incomplete XML
      const toolCalls = chunks.filter((chunk) => chunk.type === "tool-call");
      expect(toolCalls).toHaveLength(0);

      // Should preserve the incomplete content as text
      const textChunks = chunks.filter((chunk) => chunk.type === "text-delta");
      expect(textChunks.length).toBeGreaterThan(0);
    });

    it("should handle streaming with very small chunks", async () => {
      const text =
        "<tiny_chunks><data><item>1</item><item>2</item></data></tiny_chunks>";

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "tiny_chunks",
          inputSchema: {
            type: "object",
            properties: {
              data: {
                type: "array",
                items: { type: "number" },
              },
            },
          },
        },
      ];

      // Simulate very small chunks (1 character each)
      const streamParser = protocol.createStreamParser({ tools });
      const chunks: any[] = [];

      const readable = new ReadableStream({
        start(controller) {
          for (const char of text) {
            controller.enqueue({
              type: "text-delta" as const,
              delta: char,
            });
          }
          controller.close();
        },
      });

      const transformed = readable.pipeThrough(streamParser);
      const reader = transformed.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      const toolCalls = chunks.filter((chunk) => chunk.type === "tool-call");
      expect(toolCalls).toHaveLength(1);
      const input = JSON.parse(toolCalls[0].input);
      expect(input.data).toEqual([EXPECTED_NUMBER_1, EXPECTED_NUMBER_2]);
    });
  });
});
