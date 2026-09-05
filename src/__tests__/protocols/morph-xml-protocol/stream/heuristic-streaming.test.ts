import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  collectTextDeltas,
  parseToolCallObject,
  requireToolCall,
  selectToolCalls,
} from "../../shared/duplicate-harness";
import {
  morphArrayTool as arrayTool,
  streamMorphText as simulateStreaming,
} from "../heuristic-test-harness";

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

describe("XML Protocol Heuristic Streaming", () => {
  describe("Streaming multiple tags handling", () => {
    it("should handle streaming multiple tags conversion", async () => {
      const chunks = await simulateStreaming(
        `<math_sum>
        <numbers>3</numbers>
        <numbers>5</numbers>
        <numbers>7</numbers>
      </math_sum>`,
        [arrayTool("math_sum", "numbers", "number")]
      );
      const toolCalls = selectToolCalls(chunks);

      expect(toolCalls).toHaveLength(1);
      expect(parseToolCallObject(requireToolCall(chunks)).numbers).toEqual([
        EXPECTED_NUMBER_3,
        EXPECTED_NUMBER_5,
        EXPECTED_NUMBER_7,
      ]);
    });
  });

  describe("Streaming indexed tuple processing", () => {
    it("should handle streaming indexed tags conversion", async () => {
      const chunks = await simulateStreaming(
        `<set_point>
        <coordinates>
          <0>10.5</0>
          <1>20.3</1>
        </coordinates>
      </set_point>`,
        [arrayTool("set_point", "coordinates", "number")]
      );
      const toolCalls = selectToolCalls(chunks);

      expect(toolCalls).toHaveLength(1);
      expect(parseToolCallObject(requireToolCall(chunks)).coordinates).toEqual([
        EXPECTED_COORD_10_5,
        EXPECTED_COORD_20_3,
      ]);
    });
  });

  describe("Streaming item key pattern processing", () => {
    it("should handle streaming item array conversion", async () => {
      const chunks = await simulateStreaming(
        `<get_coordinates>
        <position>
          <item>46.603354</item>
          <item>1.8883340</item>
        </position>
      </get_coordinates>`,
        [arrayTool("get_coordinates", "position", "number")]
      );
      const toolCalls = selectToolCalls(chunks);

      expect(toolCalls).toHaveLength(1);
      expect(parseToolCallObject(requireToolCall(chunks)).position).toEqual([
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
      const tools: LanguageModelV4FunctionTool[] = [
        {
          type: "function",
          name: "complex_data",
          inputSchema: {
            type: "object",
            properties: {
              coordinates: { type: "array", items: { type: "number" } },
              dimensions: { type: "array", items: { type: "number" } },
              tags: { type: "array", items: { type: "string" } },
            },
          },
        },
      ];
      const input = parseToolCallObject(
        requireToolCall(await simulateStreaming(text, tools))
      );

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
      const chunks = await simulateStreaming(
        `Some text before
      <process_list>
        <items>
          <item>first</item>
          <item>second</item>
          <item>third</item>
        </items>
      </process_list>
      Some text after`,
        [arrayTool("process_list", "items", "string")]
      );
      const toolCalls = selectToolCalls(chunks);
      const allText = collectTextDeltas(chunks);

      expect(toolCalls).toHaveLength(1);
      expect(parseToolCallObject(requireToolCall(chunks)).items).toEqual([
        "first",
        "second",
        "third",
      ]);
      // Should also preserve text content
      expect(
        chunks.filter((chunk) => chunk.type === "text-delta").length
      ).toBeGreaterThan(0);
      expect(allText).toContain("Some text before");
      expect(allText).toContain("Some text after");
    });
  });

  describe("Streaming edge cases", () => {
    it("should handle streaming with interrupted tags", async () => {
      const chunks = await simulateStreaming(
        `<incomplete_test>
        <values>
          <item>complete</item>
          <item>partial`,
        [arrayTool("incomplete_test", "values", "string")]
      );

      // The parser may force-complete parseable content at finish,
      // or preserve incomplete input as text when parsing fails.
      expect(
        selectToolCalls(chunks).length > 0 ||
          chunks.some((chunk) => chunk.type === "text-delta")
      ).toBe(true);
    });

    it("should handle streaming with very small chunks", async () => {
      const chunks = await simulateStreaming(
        "<tiny_chunks><data><item>1</item><item>2</item></data></tiny_chunks>",
        [arrayTool("tiny_chunks", "data", "number")],
        1
      );
      const toolCalls = selectToolCalls(chunks);

      expect(toolCalls).toHaveLength(1);
      expect(parseToolCallObject(requireToolCall(chunks)).data).toEqual([
        EXPECTED_NUMBER_1,
        EXPECTED_NUMBER_2,
      ]);
    });
  });
});
