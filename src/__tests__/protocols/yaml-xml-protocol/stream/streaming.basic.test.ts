import { describe, expect, it } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import { stopFinishReason, zeroUsage } from "../../../test-helpers";
import {
  collectProtocolStream,
  collectTextDeltas,
  parseToolCallObject,
  requireToolCall,
  runProtocolTextStream,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";
import { basicTools } from "../parse-generated-text/shared";

function streamBasic(chunks: readonly string[]) {
  return runProtocolTextStream({
    protocol: yamlXmlProtocol(),
    tools: basicTools,
    id: "1",
    chunks,
  });
}

async function basicCall(chunks: readonly string[]) {
  return requireToolCall(await streamBasic(chunks));
}

describe("yamlXmlProtocol streaming basic", () => {
  it("should parse a complete tool call in a single chunk", async () => {
    const toolCall = await basicCall([
      `<get_weather>
location: London
unit: celsius
</get_weather>`,
    ]);
    expect(toolCall.toolName).toBe("get_weather");
    const input = parseToolCallObject(toolCall);
    expect(input.location).toBe("London");
    expect(input.unit).toBe("celsius");
  });

  it("should parse tool call split across multiple chunks", async () => {
    const toolCall = await basicCall([
      "<get_wea",
      "ther>\n",
      "location: Ber",
      "lin\n",
      "</get_weather>",
    ]);
    expect(toolCall.toolName).toBe("get_weather");
    expect(parseToolCallObject(toolCall).location).toBe("Berlin");
  });

  it("keeps a partial tool tag buffered across interleaved raw chunks", async () => {
    const out = await collectProtocolStream({
      protocol: yamlXmlProtocol(),
      tools: basicTools,
      parts: [
        { type: "text-delta", id: "1", delta: "<get_wea" },
        {
          type: "raw",
          rawValue: { choices: [{ delta: { content: "ther>\n" } }] },
        },
        {
          type: "text-delta",
          id: "1",
          delta: "ther>\nlocation: Berlin\n</get_weather>",
        },
        { type: "finish", finishReason: stopFinishReason, usage: zeroUsage },
      ],
    });
    const toolCall = requireToolCall(out);
    const joinedInput = selectToolInputTimeline(out)
      .deltas.map((part) => part.delta)
      .join("");
    expect(collectTextDeltas(out)).toBe("");
    expect(toolCall).toMatchObject({
      type: "tool-call",
      toolName: "get_weather",
    });
    expect(joinedInput).toBe(toolCall.input);
    expect(parseToolCallObject(toolCall)).toEqual({ location: "Berlin" });
  });

  const selfClosingCases = [
    {
      name: "should handle self-closing tag in stream",
      chunks: ["<get_location/>"],
    },
    {
      name: "should handle self-closing tag split across chunks",
      chunks: ["<get_loca", "tion/>"],
    },
  ] as const;

  for (const testCase of selfClosingCases) {
    it(testCase.name, async () => {
      const toolCall = await basicCall(testCase.chunks);
      expect(toolCall.toolName).toBe("get_location");
      expect(toolCall.input).toBe("{}");
    });
  }
});
