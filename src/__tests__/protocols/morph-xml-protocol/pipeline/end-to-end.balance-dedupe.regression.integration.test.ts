import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

describe("morphXmlProtocol pipeline balance-dedupe regression integration", () => {
  const shellTools: LanguageModelV3FunctionTool[] = [
    {
      type: "function",
      name: "shell",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "array",
            items: { type: "string" },
          },
          description: { type: "string" },
        },
      },
    },
  ];

  it("recovers when balance fixes tags but creates duplicate string tags", () => {
    const protocol = morphXmlProtocol();

    const text = `<shell>
        <command>echo "hello"</command>
        <description>First description</description>
        <description>Second description (should be removed)</description>
      </shell>`;

    const result = protocol.parseGeneratedText({ text, tools: shellTools });

    expect(result).toHaveLength(1);
    if (result[0].type === "tool-call") {
      const input = JSON.parse(result[0].input);
      expect(input.description).toBe("Second description (should be removed)");
    }
  });

  it("handles malformed close tags with duplicate string tags", () => {
    const protocol = morphXmlProtocol();

    const text = `<shell>
        <command>ls -la</command>
        <description>List files</ description>
        <description>Show all</description>
      </shell>`;

    const result = protocol.parseGeneratedText({ text, tools: shellTools });

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("tool-call");
    if (result[0].type === "tool-call") {
      const input = JSON.parse(result[0].input);
      expect(input.description).toBe("Show all");
    }
  });
});
