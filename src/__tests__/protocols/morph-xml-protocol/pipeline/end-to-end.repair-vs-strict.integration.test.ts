import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

describe("morphXmlProtocol pipeline repair-vs-strict integration", () => {
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

  it("produces same result for valid XML with or without repair", () => {
    const strict = morphXmlProtocol({ parseOptions: { repair: false } });
    const repaired = morphXmlProtocol();

    const text = "<get_weather><location>Seoul</location></get_weather>";

    const resultStrict = strict.parseGeneratedText({
      text,
      tools: simpleTools,
    });
    const resultRepaired = repaired.parseGeneratedText({
      text,
      tools: simpleTools,
    });

    expect(resultStrict).toHaveLength(1);
    expect(resultRepaired).toHaveLength(1);

    if (
      resultStrict[0].type === "tool-call" &&
      resultRepaired[0].type === "tool-call"
    ) {
      expect(JSON.parse(resultStrict[0].input)).toEqual(
        JSON.parse(resultRepaired[0].input)
      );
    }
  });

  it("recovers malformed close tags only when repair is enabled", () => {
    const strict = morphXmlProtocol({ parseOptions: { repair: false } });
    const repaired = morphXmlProtocol();

    const text = "<get_weather><location>Seoul</get_weather>";

    const resultStrict = strict.parseGeneratedText({
      text,
      tools: simpleTools,
    });
    const resultRepaired = repaired.parseGeneratedText({
      text,
      tools: simpleTools,
    });

    expect(resultStrict[0].type).toBe("text");
    expect(resultRepaired[0].type).toBe("tool-call");
  });
});
