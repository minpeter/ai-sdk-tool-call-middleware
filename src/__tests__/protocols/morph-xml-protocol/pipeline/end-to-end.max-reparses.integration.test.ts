import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

describe("morphXmlProtocol pipeline maxReparses integration", () => {
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

  const duplicateDescription = `<shell>
      <command>echo "hello"</command>
      <description>First</description>
      <description>Second</description>
    </shell>`;

  it("fails to repair when maxReparses is 0", () => {
    const protocol = morphXmlProtocol({
      parseOptions: { maxReparses: 0 },
    });

    const result = protocol.parseGeneratedText({
      text: duplicateDescription,
      tools: shellTools,
    });

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("text");
  });

  it("repairs duplicates when maxReparses allows reparsing", () => {
    const protocol = morphXmlProtocol({
      parseOptions: { maxReparses: 2 },
    });

    const result = protocol.parseGeneratedText({
      text: duplicateDescription,
      tools: shellTools,
    });

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("tool-call");
    if (result[0].type === "tool-call") {
      const input = JSON.parse(result[0].input);
      expect(input.description).toBe("Second");
    }
  });
});
