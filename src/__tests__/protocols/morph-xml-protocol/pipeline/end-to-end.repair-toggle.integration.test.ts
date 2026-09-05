import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

describe("morphXmlProtocol pipeline repair toggle integration", () => {
  const weatherSchema: LanguageModelV4FunctionTool["inputSchema"] = {
    properties: { location: { type: "string" } },
    type: "object",
  };
  const simpleTools: LanguageModelV4FunctionTool[] = [
    { name: "get_weather", inputSchema: weatherSchema, type: "function" },
  ];

  function parseWithoutRepair(text: string) {
    return morphXmlProtocol({
      parseOptions: { repair: false },
    }).parseGeneratedText({ text, tools: simpleTools });
  }

  it("does not repair malformed XML when repair=false", () => {
    const result = parseWithoutRepair(
      "<get_weather><location>Seoul</get_weather>"
    );

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("text");
  });

  it("still parses valid XML when repair=false", () => {
    const result = parseWithoutRepair(
      "<get_weather><location>Seoul</location></get_weather>"
    );

    expect(result).toHaveLength(1);
    const [validPart] = result;
    expect(validPart.type).toBe("tool-call");
    if (validPart.type === "tool-call") {
      expect(JSON.parse(validPart.input)).toEqual({ location: "Seoul" });
    }
  });
});
