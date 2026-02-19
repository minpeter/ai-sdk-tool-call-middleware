import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

describe("XML Protocol Heuristic Parsing", () => {
  const protocol = morphXmlProtocol();

  describe("Internal array structure processing", () => {
    it("should extract array from single key object", () => {
      const text = `<get_numbers>
        <values>
          <number>3</number>
          <number>5</number>
          <number>7</number>
        </values>
      </get_numbers>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "get_numbers",
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
        expect(input.values).toEqual([3, 5, 7]);
      }
    });

    it("should extract string array from single key object", () => {
      const text = `<get_colors>
        <palette>
          <color>red</color>
          <color>green</color>
          <color>blue</color>
        </palette>
      </get_colors>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "get_colors",
          inputSchema: {
            type: "object",
            properties: {
              palette: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type === "tool-call").toBe(true);

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.palette).toEqual(["red", "green", "blue"]);
      }
    });
  });
});
