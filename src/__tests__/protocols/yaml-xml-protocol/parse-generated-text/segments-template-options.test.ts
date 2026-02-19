import { describe, expect, it } from "vitest";
import { yamlXmlSystemPromptTemplate } from "../../../../core/prompts/yaml-xml-prompt";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import { basicTools } from "./shared";

describe("yamlXmlProtocol extractToolCallSegments", () => {
  it("should extract tool call segments from text", () => {
    const protocol = yamlXmlProtocol();
    const text = `Some text <get_weather>
location: Tokyo
</get_weather> more text <get_location/> end`;
    const segments = protocol.extractToolCallSegments?.({
      text,
      tools: basicTools,
    });

    expect(segments).toBeDefined();
    expect(segments).toHaveLength(2);
    if (!segments || segments.length < 2) {
      throw new Error("Expected segments to have at least 2 elements");
    }
    expect(segments[0]).toContain("<get_weather>");
    expect(segments[0]).toContain("</get_weather>");
    expect(segments[1]).toBe("<get_location></get_location>");
  });

  it("should return empty array when no tools match", () => {
    const protocol = yamlXmlProtocol();
    const text = "No tool calls here";
    const segments = protocol.extractToolCallSegments?.({
      text,
      tools: basicTools,
    });

    expect(segments).toBeDefined();
    expect(segments).toHaveLength(0);
  });
});

describe("yamlXmlSystemPromptTemplate", () => {
  it("should include multiline example by default", () => {
    const testTools = [
      {
        type: "function" as const,
        name: "test",
        inputSchema: { type: "object" },
      },
    ];
    const template = yamlXmlSystemPromptTemplate(testTools);

    expect(template).toContain("# Tools");
    expect(template).toContain(
      '<tools>[{"type":"function","name":"test","inputSchema":{"type":"object"}}]</tools>'
    );
    expect(template).toContain("YAML's literal block syntax");
    expect(template).toContain("contents: |");
  });

  it("should exclude multiline example when disabled", () => {
    const testTools = [
      {
        type: "function" as const,
        name: "test",
        inputSchema: { type: "object" },
      },
    ];
    const template = yamlXmlSystemPromptTemplate(testTools, false);

    expect(template).toContain("# Tools");
    expect(template).toContain(
      '<tools>[{"type":"function","name":"test","inputSchema":{"type":"object"}}]</tools>'
    );
    expect(template).not.toContain("YAML's literal block syntax");
    expect(template).not.toContain("contents: |");
  });

  it("should include proper format instructions", () => {
    const template = yamlXmlSystemPromptTemplate([]);

    expect(template).toContain("# Format");
    expect(template).toContain("XML element");
    expect(template).toContain("YAML syntax");
    expect(template).toContain("# Example");
    expect(template).toContain("<get_weather>");
    expect(template).toContain("location: New York");
    expect(template).toContain("# Rules");
  });
});

describe("yamlXmlProtocol options", () => {
  it("should respect includeMultilineExample option", () => {
    const protocolWithExample = yamlXmlProtocol({
      includeMultilineExample: true,
    });
    const protocolWithoutExample = yamlXmlProtocol({
      includeMultilineExample: false,
    });

    const text = "<get_location/>";
    const out1 = protocolWithExample.parseGeneratedText({
      text,
      tools: basicTools,
      options: {},
    });
    const out2 = protocolWithoutExample.parseGeneratedText({
      text,
      tools: basicTools,
      options: {},
    });

    expect(out1).toHaveLength(1);
    expect(out2).toHaveLength(1);
  });
});
