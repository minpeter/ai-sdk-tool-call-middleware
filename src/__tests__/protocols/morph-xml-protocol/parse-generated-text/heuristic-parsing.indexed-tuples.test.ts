import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

describe("XML Protocol Heuristic Parsing", () => {
  const protocol = morphXmlProtocol();

  describe("Indexed tuple processing", () => {
    it("should convert consecutive indexed tags to array", () => {
      const text = `<set_coordinates>
        <point>
          <0>349</0>
          <1>493</1>
        </point>
      </set_coordinates>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "set_coordinates",
          inputSchema: {
            type: "object",
            properties: {
              point: {
                type: "array",
                items: { type: "number" },
              },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.point).toEqual([349, 493]);
      }
    });

    it("should convert three consecutive indexed tags to array", () => {
      const text = `<set_position>
        <coordinates>
          <0>10.5</0>
          <1>20.3</1>
          <2>15.8</2>
        </coordinates>
      </set_position>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "set_position",
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

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.coordinates).toEqual([10.5, 20.3, 15.8]);
      }
    });

    it("should NOT convert non-consecutive indexed tags", () => {
      const text = `<set_data>
        <values>
          <0>first</0>
          <2>third</2>
          <5>sixth</5>
        </values>
      </set_data>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "set_data",
          inputSchema: {
            type: "object",
            properties: {
              values: { type: "object" },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.values).toEqual({
          "0": "first",
          "2": "third",
          "5": "sixth",
        });
      }
    });

    it("should NOT convert mixed key types", () => {
      const text = `<set_mixed>
        <data>
          <0>zero</0>
          <name>test</name>
        </data>
      </set_mixed>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "set_mixed",
          inputSchema: {
            type: "object",
            properties: {
              data: { type: "object" },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.data).toEqual({
          "0": "zero",
          name: "test",
        });
      }
    });
  });
});
