import { describe, expect, it } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import { basicTools, fileTools } from "./shared";

describe("yamlXmlProtocol self-closing tags with whitespace", () => {
  it("should parse self-closing tag with space before slash", () => {
    const protocol = yamlXmlProtocol();
    const text = "<get_location />";
    const out = protocol.parseGeneratedText({
      text,
      tools: basicTools,
      options: {},
    });

    const toolCalls = out.filter((c) => c.type === "tool-call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      type: "tool-call",
      toolName: "get_location",
      input: "{}",
    });
  });

  it("should parse self-closing tag with multiple spaces", () => {
    const protocol = yamlXmlProtocol();
    const text = "<get_location   />";
    const out = protocol.parseGeneratedText({
      text,
      tools: basicTools,
      options: {},
    });

    const toolCalls = out.filter((c) => c.type === "tool-call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      type: "tool-call",
      toolName: "get_location",
      input: "{}",
    });
  });
});

describe("yamlXmlProtocol nested tool tags", () => {
  it("should not parse tool tags inside YAML body", () => {
    const protocol = yamlXmlProtocol();
    const text = `<write_file>
file_path: /tmp/test.txt
contents: |
  The text contains <get_weather/> tag
</write_file>`;
    const out = protocol.parseGeneratedText({
      text,
      tools: [...fileTools, ...basicTools],
      options: {},
    });

    const toolCalls = out.filter((c) => c.type === "tool-call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      type: "tool-call",
      toolName: "write_file",
    });
    const args = JSON.parse((toolCalls[0] as { input: string }).input);
    expect(args.contents).toContain("<get_weather/>");
  });

  it("should handle multiple tool calls where second appears after first ends", () => {
    const protocol = yamlXmlProtocol();
    const text = `<write_file>
file_path: test.txt
contents: normal content
</write_file>
<get_weather>
location: Seoul
</get_weather>`;
    const out = protocol.parseGeneratedText({
      text,
      tools: [...fileTools, ...basicTools],
      options: {},
    });

    const toolCalls = out.filter((c) => c.type === "tool-call");
    expect(toolCalls).toHaveLength(2);
    expect((toolCalls[0] as { toolName: string }).toolName).toBe("write_file");
    expect((toolCalls[1] as { toolName: string }).toolName).toBe("get_weather");
  });
});
