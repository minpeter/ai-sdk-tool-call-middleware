import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

describe("morphXmlProtocol pipeline index-tags preservation integration", () => {
  const coordTools: LanguageModelV3FunctionTool[] = [
    {
      type: "function",
      name: "set_coordinates",
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

  it("preserves <0>, <1> index tags", () => {
    const protocol = morphXmlProtocol();
    const text = `<set_coordinates>
        <coordinates>
          <0>10.5</0>
          <1>20.3</1>
        </coordinates>
      </set_coordinates>`;

    const result = protocol.parseGeneratedText({ text, tools: coordTools });

    expect(result).toHaveLength(1);
    if (result[0].type === "tool-call") {
      const input = JSON.parse(result[0].input);
      expect(input.coordinates).toEqual([10.5, 20.3]);
    }
  });
});
