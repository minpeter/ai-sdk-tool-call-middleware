import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import type { ParserOptions } from "../../../../core/protocols/protocol-interface";
import {
  basicTools,
  fileTools,
  parseGeneratedToolInput,
  parseYamlGenerated,
  requireGeneratedToolCall,
  selectGeneratedToolCalls,
} from "./shared";

function parse(
  text: string,
  tools: LanguageModelV4FunctionTool[] = basicTools,
  options: ParserOptions = {}
) {
  return parseYamlGenerated(text, tools, options);
}

function expectWeatherCall(text: string) {
  const out = parse(text);
  const toolCalls = selectGeneratedToolCalls(out);

  expect(toolCalls).toHaveLength(1);
  expect(toolCalls[0]).toMatchObject({
    type: "tool-call",
    toolName: "get_weather",
  });
  return parseGeneratedToolInput(requireGeneratedToolCall(out));
}

describe("yamlXmlProtocol parseGeneratedText", () => {
  describe("basic parsing", () => {
    it("should parse a single tool call with simple YAML parameters", () => {
      const args = expectWeatherCall(`<get_weather>
location: New York
unit: celsius
</get_weather>`);
      expect(args.location).toBe("New York");
      expect(args.unit).toBe("celsius");
    });

    it("should parse a tool call with no parameters (empty body)", () => {
      const out = parse("<get_location>\n</get_location>");
      const toolCalls = selectGeneratedToolCalls(out);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({
        type: "tool-call",
        toolName: "get_location",
      });
      expect(parseGeneratedToolInput(requireGeneratedToolCall(out))).toEqual(
        {}
      );
    });

    it("should parse a self-closing tool call", () => {
      const toolCalls = selectGeneratedToolCalls(parse("<get_location/>"));

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({
        type: "tool-call",
        toolName: "get_location",
        input: "{}",
      });
    });

    it("should repair malformed self-closing root with body-style YAML payload", () => {
      const args = expectWeatherCall(`<get_weather
location: Seoul
unit: celsius
/>`);
      expect(args.location).toBe("Seoul");
      expect(args.unit).toBe("celsius");
    });

    it("should parse XML child lines used instead of a YAML body", () => {
      const args = expectWeatherCall(`<get_weather>
<location>Tom &amp; Jerry</location>
<unit>celsius</unit>
<unit>fahrenheit</unit>
</get_weather>`);

      expect(args).toEqual({
        location: "Tom & Jerry",
        unit: ["celsius", "fahrenheit"],
      });
    });

    it("should parse multiple tool calls", () => {
      const out = parse(`<get_location/>
<get_weather>
location: Seoul
</get_weather>`);
      const toolCalls = selectGeneratedToolCalls(out);

      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0]).toMatchObject({
        type: "tool-call",
        toolName: "get_location",
        input: "{}",
      });
      expect(toolCalls[1]).toMatchObject({
        type: "tool-call",
        toolName: "get_weather",
      });
      expect(
        toolCalls[1] && parseGeneratedToolInput(toolCalls[1]).location
      ).toBe("Seoul");
    });
  });

  describe("text and tool call mixing", () => {
    it("should handle text before and after tool call", () => {
      const out = parse(`Let me check the weather for you.
<get_weather>
location: Tokyo
</get_weather>
The weather has been retrieved!`);
      const textParts = out.filter((part) => part.type === "text");
      const toolCalls = selectGeneratedToolCalls(out);

      expect(toolCalls).toHaveLength(1);
      expect(textParts).toHaveLength(2);
      expect(textParts[0]?.text).toContain("Let me check the weather");
      expect(textParts[1]?.text).toContain("weather has been retrieved");
    });

    it("should handle only text when no tool names match", () => {
      const out = parse("Just some regular text without any tool calls.");

      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        type: "text",
        text: "Just some regular text without any tool calls.",
      });
    });
  });

  describe("YAML multiline values", () => {
    it("should parse YAML literal block scalar (|)", () => {
      const input = parseGeneratedToolInput(
        requireGeneratedToolCall(
          parse(
            `<write_file>
file_path: /tmp/test.txt
contents: |
  First line
  Second line
  Third line
</write_file>`,
            fileTools
          )
        )
      );

      expect(input.file_path).toBe("/tmp/test.txt");
      expect(input.contents).toContain("First line");
      expect(input.contents).toContain("Second line");
      expect(input.contents).toContain("Third line");
    });

    it("should parse YAML folded block scalar (>)", () => {
      const input = parseGeneratedToolInput(
        requireGeneratedToolCall(
          parse(
            `<write_file>
file_path: /tmp/test.txt
contents: >
  This is a long line
  that wraps across
  multiple lines
</write_file>`,
            fileTools
          )
        )
      );

      expect(input.file_path).toBe("/tmp/test.txt");
      expect(input.contents).toBeDefined();
    });
  });

  describe("indentation normalization", () => {
    it("should handle indented YAML content", () => {
      const input = parseGeneratedToolInput(
        requireGeneratedToolCall(
          parse(`<get_weather>
    location: Paris
    unit: celsius
</get_weather>`)
        )
      );

      expect(input.location).toBe("Paris");
      expect(input.unit).toBe("celsius");
    });
  });

  describe("error handling", () => {
    const errorCases = [
      {
        name: "should emit original text on invalid YAML and call onError",
        text: "<get_weather>\n[invalid: yaml: syntax:\n</get_weather>",
      },
      {
        name: "should emit original text when YAML is not a mapping",
        text: "<get_weather>\n- just a list\n- not an object\n</get_weather>",
      },
    ];

    for (const testCase of errorCases) {
      it(testCase.name, () => {
        const onError = vi.fn();
        const out = parse(testCase.text, basicTools, { onError });

        expect(
          out.filter((part) => part.type === "text").length
        ).toBeGreaterThan(0);
        expect(onError).toHaveBeenCalled();
      });
    }
  });

  describe("nested tag handling", () => {
    it("should handle nested XML-like content within YAML values", () => {
      const input = parseGeneratedToolInput(
        requireGeneratedToolCall(
          parse(
            `<write_file>
file_path: /tmp/test.html
contents: |
  <html>
  <body>Hello</body>
  </html>
</write_file>`,
            fileTools
          )
        )
      );

      expect(input.contents).toContain("<html>");
      expect(input.contents).toContain("<body>Hello</body>");
    });
  });
});
