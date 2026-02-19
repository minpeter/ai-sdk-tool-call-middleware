import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

describe("XML Protocol Heuristic Parsing", () => {
  const protocol = morphXmlProtocol();

  describe("Multiple tags handling", () => {
    it("should convert multiple same-named tags to array", () => {
      const text = `<math_toolkit_sum_of_multiples>
        <lower_limit>1</lower_limit>
        <upper_limit>1000</upper_limit>
        <multiples>3</multiples>
        <multiples>5</multiples>
      </math_toolkit_sum_of_multiples>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "math_toolkit_sum_of_multiples",
          inputSchema: {
            type: "object",
            properties: {
              lower_limit: { type: "number" },
              upper_limit: { type: "number" },
              multiples: {
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
        expect(input.lower_limit).toBe(1);
        expect(input.upper_limit).toBe(1000);
        expect(input.multiples).toEqual([3, 5]);
      }
    });

    it("should handle multiple tags with text content", () => {
      const text = `<get_cities>
        <country>France</country>
        <city>Paris</city>
        <city>Lyon</city>
        <city>Marseille</city>
      </get_cities>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "get_cities",
          inputSchema: {
            type: "object",
            properties: {
              country: { type: "string" },
              city: {
                type: "array",
                items: { type: "string" },
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
        expect(input.country).toBe("France");
        expect(input.city).toEqual(["Paris", "Lyon", "Marseille"]);
      }
    });
  });
});
