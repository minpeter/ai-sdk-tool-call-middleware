import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  createChunkedStream,
  pipeWithTransformer,
} from "../../../test-helpers";

describe("morphXmlProtocol streaming self-closing success path", () => {
  it.each([
    { name: "self-closing", tag: "<get_location/>" },
    { name: "self-closing with space", tag: "<get_location />" },
    { name: "self-closing with lot of space", tag: "<get_location    />" },
    { name: "self-closing with newline", tag: "<get_location \n />" },
    { name: "open/close with newline", tag: "<get_location>\n</get_location>" },
    { name: "open/close", tag: "<get_location></get_location>" },
  ])("parses $name tool call in stream", async ({ tag }) => {
    const protocol = morphXmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "get_location",
        description: "Get user location",
        inputSchema: { type: "object" },
      },
    ];
    const transformer = protocol.createStreamParser({ tools });
    const rs = createChunkedStream(tag, "t");

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find((c) => c.type === "tool-call") as {
      toolName: string;
      input: string;
    };

    expect(tool.toolName).toBe("get_location");
    expect(tool.input).toBe("{}");
  });
});
