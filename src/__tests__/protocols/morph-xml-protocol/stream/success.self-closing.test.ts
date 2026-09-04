import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  requireToolCall,
  runProtocolTextStream,
} from "../../shared/duplicate-harness";

const locationTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "get_location",
  description: "Get user location",
  inputSchema: { type: "object" },
};

const selfClosingCases = [
  { name: "self-closing", tag: "<get_location/>" },
  { name: "self-closing with space", tag: "<get_location />" },
  { name: "self-closing with lot of space", tag: "<get_location    />" },
  { name: "self-closing with newline", tag: "<get_location \n />" },
  { name: "open/close with newline", tag: "<get_location>\n</get_location>" },
  { name: "open/close", tag: "<get_location></get_location>" },
];

describe("morphXmlProtocol streaming self-closing success path", () => {
  for (const scenario of selfClosingCases) {
    it(`parses '${scenario.name}' tool call in stream`, async () => {
      const out = await runProtocolTextStream({
        chunks: [scenario.tag],
        id: "morph-self-closing",
        protocol: morphXmlProtocol(),
        tools: [locationTool],
      });
      const tool = requireToolCall(out);
      expect(tool.toolName).toBe("get_location");
      expect(tool.input).toBe("{}");
    });
  }
});
