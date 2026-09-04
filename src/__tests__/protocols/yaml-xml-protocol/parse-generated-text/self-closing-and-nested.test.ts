import { describe, expect, it } from "vitest";
import {
  basicTools,
  fileTools,
  parseGeneratedToolInput,
  parseYamlGenerated,
  requireGeneratedToolCall,
  selectGeneratedToolCalls,
} from "./shared";

const selfClosingCases = [
  {
    name: "should parse self-closing tag with space before slash",
    text: "<get_location />",
  },
  {
    name: "should parse self-closing tag with multiple spaces",
    text: "<get_location   />",
  },
];

describe("yamlXmlProtocol self-closing tags with whitespace", () => {
  for (const testCase of selfClosingCases) {
    it(testCase.name, () => {
      const toolCalls = selectGeneratedToolCalls(
        parseYamlGenerated(testCase.text, basicTools, {})
      );

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({
        type: "tool-call",
        toolName: "get_location",
        input: "{}",
      });
    });
  }
});

describe("yamlXmlProtocol nested tool tags", () => {
  it("should not parse tool tags inside YAML body", () => {
    const out = parseYamlGenerated(
      `<write_file>
file_path: /tmp/test.txt
contents: |
  The text contains <get_weather/> tag
</write_file>`,
      [...fileTools, ...basicTools],
      {}
    );
    const toolCalls = selectGeneratedToolCalls(out);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      type: "tool-call",
      toolName: "write_file",
    });
    expect(
      parseGeneratedToolInput(requireGeneratedToolCall(out)).contents
    ).toContain("<get_weather/>");
  });

  it("should handle multiple tool calls where second appears after first ends", () => {
    const toolCalls = selectGeneratedToolCalls(
      parseYamlGenerated(
        `<write_file>
file_path: test.txt
contents: normal content
</write_file>
<get_weather>
location: Seoul
</get_weather>`,
        [...fileTools, ...basicTools],
        {}
      )
    );

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]?.toolName).toBe("write_file");
    expect(toolCalls[1]?.toolName).toBe("get_weather");
  });
});
