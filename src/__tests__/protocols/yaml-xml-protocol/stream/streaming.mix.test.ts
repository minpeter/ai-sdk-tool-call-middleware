import { describe, expect, it } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  collectTextDeltas,
  parseToolCallObject,
  runProtocolTextStream,
  selectToolCalls,
} from "../../shared/duplicate-harness";
import { basicTools } from "../parse-generated-text/shared";

function mixedStream(chunks: readonly string[]) {
  return runProtocolTextStream({
    protocol: yamlXmlProtocol(),
    tools: basicTools,
    id: "1",
    chunks,
  });
}

describe("yamlXmlProtocol streaming text and tool mixing", () => {
  it("should emit text before and after tool call", async () => {
    const out = await mixedStream([
      "Checking weather ",
      "<get_weather>\nlocation: Sydney\n</get_weather>",
      " Done!",
    ]);
    expect(selectToolCalls(out)).toHaveLength(1);
    const text = collectTextDeltas(out);
    expect(text).toContain("Checking weather");
    expect(text).toContain("Done!");
    expect(text).not.toContain("<get_weather>");
  });

  it("should handle multiple tool calls in stream", async () => {
    const calls = selectToolCalls(
      await mixedStream([
        "<get_location/>",
        "<get_weather>\nlocation: Tokyo\n</get_weather>",
      ])
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.toolName).toBe("get_location");
    expect(calls[1]?.toolName).toBe("get_weather");
  });

  it("should parse trailing self-closing tags after another tool call in the same chunk", async () => {
    const calls = selectToolCalls(
      await mixedStream([
        `<get_weather>
location: Madrid
</get_weather><get_location/>`,
      ])
    );
    expect(calls).toHaveLength(2);
    const [weather, location] = calls;
    if (weather === undefined || location === undefined) {
      throw new TypeError("Expected weather and location calls");
    }
    expect(weather.toolName).toBe("get_weather");
    expect(parseToolCallObject(weather)).toMatchObject({ location: "Madrid" });
    expect(location).toMatchObject({ toolName: "get_location", input: "{}" });
  });
});
