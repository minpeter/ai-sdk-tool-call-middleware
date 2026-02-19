import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

describe("XML Protocol Heuristic Parsing", () => {
  const protocol = morphXmlProtocol();

  describe("Number conversion accuracy", () => {
    it("should handle floating point precision correctly", () => {
      const text = `<test_precision>
        <values>
          <item>1.2345678900000000</item>
          <item>2.0000000000000001</item>
          <item>3.1415926535897932</item>
        </values>
      </test_precision>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "test_precision",
          inputSchema: {
            type: "object",
            properties: {
              values: {
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
        expect(input.values[0]).toBeCloseTo(1.234_567_89);
        expect(input.values[1]).toBeCloseTo(2.0);
        expect(input.values[2]).toBeCloseTo(Math.PI);
      }
    });

    it("should handle scientific notation", () => {
      const text = `<scientific_values>
        <data>
          <item>1.23e-4</item>
          <item>5.67E+2</item>
          <item>-9.87e-10</item>
        </data>
      </scientific_values>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "scientific_values",
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

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.data[0]).toBeCloseTo(0.000_123);
        expect(input.data[1]).toBeCloseTo(567);
        expect(input.data[2]).toBeCloseTo(-0.000_000_000_987);
      }
    });
  });
});
