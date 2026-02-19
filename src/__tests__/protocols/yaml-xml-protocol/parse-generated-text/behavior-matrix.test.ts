import { describe, expect, it, vi } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import { basicTools, fileTools } from "./shared";

describe("yamlXmlProtocol parseGeneratedText", () => {
  describe("basic parsing", () => {
    it("should parse a single tool call with simple YAML parameters", () => {
      const protocol = yamlXmlProtocol();
      const text = `<get_weather>
location: New York
unit: celsius
</get_weather>`;
      const out = protocol.parseGeneratedText({
        text,
        tools: basicTools,
        options: {},
      });

      const toolCalls = out.filter((c) => c.type === "tool-call");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({
        type: "tool-call",
        toolName: "get_weather",
      });
      const args = JSON.parse((toolCalls[0] as { input: string }).input);
      expect(args.location).toBe("New York");
      expect(args.unit).toBe("celsius");
    });

    it("should parse a tool call with no parameters (empty body)", () => {
      const protocol = yamlXmlProtocol();
      const text = "<get_location>\n</get_location>";
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
      });
      const args = JSON.parse((toolCalls[0] as { input: string }).input);
      expect(args).toEqual({});
    });

    it("should parse a self-closing tool call", () => {
      const protocol = yamlXmlProtocol();
      const text = "<get_location/>";
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

    it("should repair malformed self-closing root with body-style YAML payload", () => {
      const protocol = yamlXmlProtocol();
      const text = `<get_weather
location: Seoul
unit: celsius
/>`;
      const out = protocol.parseGeneratedText({
        text,
        tools: basicTools,
        options: {},
      });

      const toolCalls = out.filter((c) => c.type === "tool-call");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({
        type: "tool-call",
        toolName: "get_weather",
      });
      const args = JSON.parse((toolCalls[0] as { input: string }).input);
      expect(args.location).toBe("Seoul");
      expect(args.unit).toBe("celsius");
    });

    it("should parse multiple tool calls", () => {
      const protocol = yamlXmlProtocol();
      const text = `<get_location/>
<get_weather>
location: Seoul
</get_weather>`;
      const out = protocol.parseGeneratedText({
        text,
        tools: basicTools,
        options: {},
      });

      const toolCalls = out.filter((c) => c.type === "tool-call");
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
      const args = JSON.parse((toolCalls[1] as { input: string }).input);
      expect(args.location).toBe("Seoul");
    });
  });

  describe("text and tool call mixing", () => {
    it("should handle text before and after tool call", () => {
      const protocol = yamlXmlProtocol();
      const text = `Let me check the weather for you.
<get_weather>
location: Tokyo
</get_weather>
The weather has been retrieved!`;
      const out = protocol.parseGeneratedText({
        text,
        tools: basicTools,
        options: {},
      });

      const textParts = out.filter((c) => c.type === "text");
      const toolCalls = out.filter((c) => c.type === "tool-call");

      expect(toolCalls).toHaveLength(1);
      expect(textParts).toHaveLength(2);
      expect((textParts[0] as { text: string }).text).toContain(
        "Let me check the weather"
      );
      expect((textParts[1] as { text: string }).text).toContain(
        "weather has been retrieved"
      );
    });

    it("should handle only text when no tool names match", () => {
      const protocol = yamlXmlProtocol();
      const text = "Just some regular text without any tool calls.";
      const out = protocol.parseGeneratedText({
        text,
        tools: basicTools,
        options: {},
      });

      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        type: "text",
        text: "Just some regular text without any tool calls.",
      });
    });
  });

  describe("YAML multiline values", () => {
    it("should parse YAML literal block scalar (|)", () => {
      const protocol = yamlXmlProtocol();
      const text = `<write_file>
file_path: /tmp/test.txt
contents: |
  First line
  Second line
  Third line
</write_file>`;
      const out = protocol.parseGeneratedText({
        text,
        tools: fileTools,
        options: {},
      });

      const toolCalls = out.filter((c) => c.type === "tool-call");
      expect(toolCalls).toHaveLength(1);
      const args = JSON.parse((toolCalls[0] as { input: string }).input);
      expect(args.file_path).toBe("/tmp/test.txt");
      expect(args.contents).toContain("First line");
      expect(args.contents).toContain("Second line");
      expect(args.contents).toContain("Third line");
    });

    it("should parse YAML folded block scalar (>)", () => {
      const protocol = yamlXmlProtocol();
      const text = `<write_file>
file_path: /tmp/test.txt
contents: >
  This is a long line
  that wraps across
  multiple lines
</write_file>`;
      const out = protocol.parseGeneratedText({
        text,
        tools: fileTools,
        options: {},
      });

      const toolCalls = out.filter((c) => c.type === "tool-call");
      expect(toolCalls).toHaveLength(1);
      const args = JSON.parse((toolCalls[0] as { input: string }).input);
      expect(args.file_path).toBe("/tmp/test.txt");
      expect(args.contents).toBeDefined();
    });
  });

  describe("indentation normalization", () => {
    it("should handle indented YAML content", () => {
      const protocol = yamlXmlProtocol();
      const text = `<get_weather>
    location: Paris
    unit: celsius
</get_weather>`;
      const out = protocol.parseGeneratedText({
        text,
        tools: basicTools,
        options: {},
      });

      const toolCalls = out.filter((c) => c.type === "tool-call");
      expect(toolCalls).toHaveLength(1);
      const args = JSON.parse((toolCalls[0] as { input: string }).input);
      expect(args.location).toBe("Paris");
      expect(args.unit).toBe("celsius");
    });
  });

  describe("error handling", () => {
    it("should emit original text on invalid YAML and call onError", () => {
      const onError = vi.fn();
      const protocol = yamlXmlProtocol();
      const text = "<get_weather>\n[invalid: yaml: syntax:\n</get_weather>";
      const out = protocol.parseGeneratedText({
        text,
        tools: basicTools,
        options: { onError },
      });

      const textParts = out.filter((c) => c.type === "text");
      expect(textParts.length).toBeGreaterThan(0);
      expect(onError).toHaveBeenCalled();
    });

    it("should emit original text when YAML is not a mapping", () => {
      const onError = vi.fn();
      const protocol = yamlXmlProtocol();
      const text =
        "<get_weather>\n- just a list\n- not an object\n</get_weather>";
      const out = protocol.parseGeneratedText({
        text,
        tools: basicTools,
        options: { onError },
      });

      const textParts = out.filter((c) => c.type === "text");
      expect(textParts.length).toBeGreaterThan(0);
      expect(onError).toHaveBeenCalled();
    });
  });

  describe("nested tag handling", () => {
    it("should handle nested XML-like content within YAML values", () => {
      const protocol = yamlXmlProtocol();
      const text = `<write_file>
file_path: /tmp/test.html
contents: |
  <html>
  <body>Hello</body>
  </html>
</write_file>`;
      const out = protocol.parseGeneratedText({
        text,
        tools: fileTools,
        options: {},
      });

      const toolCalls = out.filter((c) => c.type === "tool-call");
      expect(toolCalls).toHaveLength(1);
      const args = JSON.parse((toolCalls[0] as { input: string }).input);
      expect(args.contents).toContain("<html>");
      expect(args.contents).toContain("<body>Hello</body>");
    });
  });
});
