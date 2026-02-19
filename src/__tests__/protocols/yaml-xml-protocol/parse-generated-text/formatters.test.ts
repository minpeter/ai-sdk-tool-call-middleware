import { describe, expect, it } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import { basicTools } from "./shared";

describe("yamlXmlProtocol formatToolCall", () => {
  it("should format tool call with simple arguments", () => {
    const protocol = yamlXmlProtocol();
    const formatted = protocol.formatToolCall({
      type: "tool-call",
      toolCallId: "test-id",
      toolName: "get_weather",
      input: JSON.stringify({ location: "NYC", unit: "celsius" }),
    });

    expect(formatted).toContain("<get_weather>");
    expect(formatted).toContain("</get_weather>");
    expect(formatted).toContain("location: NYC");
    expect(formatted).toContain("unit: celsius");
  });

  it("should format tool call with empty arguments", () => {
    const protocol = yamlXmlProtocol();
    const formatted = protocol.formatToolCall({
      type: "tool-call",
      toolCallId: "test-id",
      toolName: "get_location",
      input: "{}",
    });

    expect(formatted).toContain("<get_location>");
    expect(formatted).toContain("</get_location>");
  });

  it("should format multiline values with literal block syntax", () => {
    const protocol = yamlXmlProtocol();
    const formatted = protocol.formatToolCall({
      type: "tool-call",
      toolCallId: "test-id",
      toolName: "write_file",
      input: JSON.stringify({
        file_path: "/tmp/test.txt",
        contents: "Line 1\nLine 2\nLine 3",
      }),
    });

    expect(formatted).toContain("<write_file>");
    expect(formatted).toContain("</write_file>");
    expect(formatted).toContain("file_path: /tmp/test.txt");
    expect(formatted).toContain("|");
  });
});

describe("yamlXmlProtocol formatTools", () => {
  it("should format tools using the template", () => {
    const protocol = yamlXmlProtocol();
    const formatted = protocol.formatTools({
      tools: basicTools,
      toolSystemPromptTemplate: (tools) => `Tools: ${JSON.stringify(tools)}`,
    });

    expect(formatted).toContain("get_weather");
    expect(formatted).toContain("get_location");
  });
});
