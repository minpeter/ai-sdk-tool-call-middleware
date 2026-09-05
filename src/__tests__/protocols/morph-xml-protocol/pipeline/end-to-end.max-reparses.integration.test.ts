import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

describe("morphXmlProtocol pipeline maxReparses integration", () => {
  const shellInputSchema: LanguageModelV4FunctionTool["inputSchema"] = {
    properties: {
      description: { type: "string" },
      command: { items: { type: "string" }, type: "array" },
    },
    type: "object",
  };
  const shellTools: LanguageModelV4FunctionTool[] = [
    { inputSchema: shellInputSchema, name: "shell", type: "function" },
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
    const repairedPart = result.at(0);
    expect(repairedPart?.type).toBe("tool-call");
    if (repairedPart?.type === "tool-call") {
      expect(JSON.parse(repairedPart.input).description).toBe("Second");
    }
  });
});
