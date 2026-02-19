import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

describe("morphXmlProtocol pipeline default behavior integration", () => {
  const simpleTools: LanguageModelV3FunctionTool[] = [
    {
      type: "function",
      name: "get_weather",
      inputSchema: {
        type: "object",
        properties: {
          location: { type: "string" },
        },
      },
    },
  ];

  it("parses valid XML without pipeline options", () => {
    const protocol = morphXmlProtocol();
    const text = "<get_weather><location>Seoul</location></get_weather>";

    const result = protocol.parseGeneratedText({ text, tools: simpleTools });

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("tool-call");
    if (result[0].type === "tool-call") {
      expect(JSON.parse(result[0].input)).toEqual({ location: "Seoul" });
    }
  });

  it("recovers malformed close tags without pipeline options", () => {
    const protocol = morphXmlProtocol();
    const text = "<get_weather><location>Seoul</get_weather>";

    const result = protocol.parseGeneratedText({ text, tools: simpleTools });

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("tool-call");
  });
});
