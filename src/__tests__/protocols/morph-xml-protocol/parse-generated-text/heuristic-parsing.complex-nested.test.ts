import {
  isJSONObject,
  type LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

const complexTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "complex_structure",
  inputSchema: {
    type: "object",
    properties: {
      coordinates: { type: "array", items: { type: "number" } },
      dimensions: { type: "array", items: { type: "number" } },
      colors: { type: "array", items: { type: "string" } },
      name: { type: "string" },
    },
  },
};

describe("XML Protocol Heuristic Parsing", () => {
  describe("Complex nested structures", () => {
    it("should handle complex nested heuristics", () => {
      const text = `<complex_structure>
        <coordinates>
          <item>46.603354</item>
          <item>1.8883340</item>
        </coordinates>
        <dimensions>
          <0>100</0>
          <1>200</1>
          <2>300</2>
        </dimensions>
        <colors>
          <color>red</color>
          <color>green</color>
          <color>blue</color>
        </colors>
        <name>test</name>
      </complex_structure>`;
      const result = morphXmlProtocol().parseGeneratedText({
        text,
        tools: [complexTool],
      });

      expect(result).toHaveLength(1);
      const toolCall = result.find((part) => part.type === "tool-call");
      expect(toolCall).toBeTruthy();
      if (toolCall?.type !== "tool-call") {
        throw new TypeError("Expected complex tool-call part");
      }
      const input = JSON.parse(toolCall.input);
      if (!isJSONObject(input)) {
        throw new TypeError("Expected complex object input");
      }
      expect(input.coordinates).toEqual([46.603_354, 1.888_334]);
      expect(input.dimensions).toEqual([100, 200, 300]);
      expect(input.colors).toEqual(["red", "green", "blue"]);
      expect(input.name).toBe("test");
    });
  });
});
