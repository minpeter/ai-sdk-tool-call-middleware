import { describe, expect, it } from "vitest";

import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  requireToolCall,
  runProtocolTextStream,
} from "../../shared/duplicate-harness";
import { basicTools } from "../parse-generated-text/shared";

describe("yamlXmlProtocol streaming self-closing whitespace", () => {
  it("parses self-closing tag with whitespace in stream", async () => {
    const parts = await runProtocolTextStream({
      protocol: yamlXmlProtocol(),
      tools: basicTools,
      id: "1",
      chunks: ["<get_location />"],
    });
    const toolCall = requireToolCall(parts);
    expect(toolCall.toolName).toBe("get_location");
    expect(toolCall.input).toBe("{}");
  });
});
