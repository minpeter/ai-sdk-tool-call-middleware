import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { yamlSystemPromptTemplate } from "../../core/prompts/yaml-system-prompt";
import { yamlProtocol } from "../../core/protocols/yaml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../test-helpers";

const basicTools: LanguageModelV3FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    description: "Get the weather for a location",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"] },
      },
      required: ["location"],
    },
  },
  {
    type: "function",
    name: "get_location",
    description: "Get the current location",
    inputSchema: { type: "object" },
  },
];

const fileTools: LanguageModelV3FunctionTool[] = [
  {
    type: "function",
    name: "write_file",
    description: "Write content to a file",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        contents: { type: "string" },
      },
      required: ["file_path", "contents"],
    },
  },
  {
    type: "function",
    name: "read_file",
    description: "Read content from a file",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["file_path"],
    },
  },
];

describe("yamlProtocol parseGeneratedText", () => {
  describe("basic parsing", () => {
    it("should parse a single tool call with simple YAML parameters", () => {
      const protocol = yamlProtocol();
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
      const protocol = yamlProtocol();
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
      const protocol = yamlProtocol();
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

    it("should parse multiple tool calls", () => {
      const protocol = yamlProtocol();
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
      const protocol = yamlProtocol();
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
      const protocol = yamlProtocol();
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
      const protocol = yamlProtocol();
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
      const protocol = yamlProtocol();
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
      const protocol = yamlProtocol();
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
      const protocol = yamlProtocol();
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
      const protocol = yamlProtocol();
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
      const protocol = yamlProtocol();
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

describe("yamlProtocol streaming", () => {
  describe("basic streaming", () => {
    it("should parse a complete tool call in a single chunk", async () => {
      const protocol = yamlProtocol();
      const transformer = protocol.createStreamParser({ tools: basicTools });
      const rs = new ReadableStream<LanguageModelV3StreamPart>({
        start(ctrl) {
          ctrl.enqueue({
            type: "text-delta",
            id: "1",
            delta: `<get_weather>
location: London
unit: celsius
</get_weather>`,
          });
          ctrl.enqueue({
            type: "finish",
            finishReason: stopFinishReason,
            usage: zeroUsage,
          });
          ctrl.close();
        },
      });

      const out = await convertReadableStreamToArray(
        pipeWithTransformer(rs, transformer)
      );
      const tool = out.find((c) => c.type === "tool-call") as {
        toolName: string;
        input: string;
      };
      expect(tool.toolName).toBe("get_weather");
      const args = JSON.parse(tool.input);
      expect(args.location).toBe("London");
      expect(args.unit).toBe("celsius");
    });

    it("should parse tool call split across multiple chunks", async () => {
      const protocol = yamlProtocol();
      const transformer = protocol.createStreamParser({ tools: basicTools });
      const rs = new ReadableStream<LanguageModelV3StreamPart>({
        start(ctrl) {
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "<get_wea" });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "ther>\n" });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "location: Ber" });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "lin\n" });
          ctrl.enqueue({
            type: "text-delta",
            id: "1",
            delta: "</get_weather>",
          });
          ctrl.enqueue({
            type: "finish",
            finishReason: stopFinishReason,
            usage: zeroUsage,
          });
          ctrl.close();
        },
      });

      const out = await convertReadableStreamToArray(
        pipeWithTransformer(rs, transformer)
      );
      const tool = out.find((c) => c.type === "tool-call") as {
        toolName: string;
        input: string;
      };
      expect(tool.toolName).toBe("get_weather");
      const args = JSON.parse(tool.input);
      expect(args.location).toBe("Berlin");
    });

    it("should handle self-closing tag in stream", async () => {
      const protocol = yamlProtocol();
      const transformer = protocol.createStreamParser({ tools: basicTools });
      const rs = new ReadableStream<LanguageModelV3StreamPart>({
        start(ctrl) {
          ctrl.enqueue({
            type: "text-delta",
            id: "1",
            delta: "<get_location/>",
          });
          ctrl.enqueue({
            type: "finish",
            finishReason: stopFinishReason,
            usage: zeroUsage,
          });
          ctrl.close();
        },
      });

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

    it("should handle self-closing tag split across chunks", async () => {
      const protocol = yamlProtocol();
      const transformer = protocol.createStreamParser({ tools: basicTools });
      const rs = new ReadableStream<LanguageModelV3StreamPart>({
        start(ctrl) {
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "<get_loca" });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "tion/>" });
          ctrl.enqueue({
            type: "finish",
            finishReason: stopFinishReason,
            usage: zeroUsage,
          });
          ctrl.close();
        },
      });

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

  describe("text and tool call mixing in stream", () => {
    it("should emit text before and after tool call", async () => {
      const protocol = yamlProtocol();
      const transformer = protocol.createStreamParser({ tools: basicTools });
      const rs = new ReadableStream<LanguageModelV3StreamPart>({
        start(ctrl) {
          ctrl.enqueue({
            type: "text-delta",
            id: "1",
            delta: "Checking weather ",
          });
          ctrl.enqueue({
            type: "text-delta",
            id: "1",
            delta: "<get_weather>\nlocation: Sydney\n</get_weather>",
          });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: " Done!" });
          ctrl.enqueue({
            type: "finish",
            finishReason: stopFinishReason,
            usage: zeroUsage,
          });
          ctrl.close();
        },
      });

      const out = await convertReadableStreamToArray(
        pipeWithTransformer(rs, transformer)
      );
      const toolCalls = out.filter((c) => c.type === "tool-call");
      const textDeltas = out
        .filter((c) => c.type === "text-delta")
        .map(
          (c) =>
            (c as { delta?: string; textDelta?: string }).delta ??
            (c as { delta?: string; textDelta?: string }).textDelta
        )
        .join("");

      expect(toolCalls).toHaveLength(1);
      expect(textDeltas).toContain("Checking weather");
      expect(textDeltas).toContain("Done!");
      expect(textDeltas).not.toContain("<get_weather>");
    });

    it("should handle multiple tool calls in stream", async () => {
      const protocol = yamlProtocol();
      const transformer = protocol.createStreamParser({ tools: basicTools });
      const rs = new ReadableStream<LanguageModelV3StreamPart>({
        start(ctrl) {
          ctrl.enqueue({
            type: "text-delta",
            id: "1",
            delta: "<get_location/>",
          });
          ctrl.enqueue({
            type: "text-delta",
            id: "1",
            delta: "<get_weather>\nlocation: Tokyo\n</get_weather>",
          });
          ctrl.enqueue({
            type: "finish",
            finishReason: stopFinishReason,
            usage: zeroUsage,
          });
          ctrl.close();
        },
      });

      const out = await convertReadableStreamToArray(
        pipeWithTransformer(rs, transformer)
      );
      const toolCalls = out.filter((c) => c.type === "tool-call");
      expect(toolCalls).toHaveLength(2);
      expect((toolCalls[0] as { toolName: string }).toolName).toBe(
        "get_location"
      );
      expect((toolCalls[1] as { toolName: string }).toolName).toBe(
        "get_weather"
      );
    });
  });

  describe("streaming with multiline YAML", () => {
    it("should handle multiline YAML values split across chunks", async () => {
      const protocol = yamlProtocol();
      const transformer = protocol.createStreamParser({ tools: fileTools });
      const rs = new ReadableStream<LanguageModelV3StreamPart>({
        start(ctrl) {
          ctrl.enqueue({
            type: "text-delta",
            id: "1",
            delta: "<write_file>\n",
          });
          ctrl.enqueue({
            type: "text-delta",
            id: "1",
            delta: "file_path: /tmp/test.txt\n",
          });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "contents: |\n" });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "  Line one\n" });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "  Line two\n" });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "</write_file>" });
          ctrl.enqueue({
            type: "finish",
            finishReason: stopFinishReason,
            usage: zeroUsage,
          });
          ctrl.close();
        },
      });

      const out = await convertReadableStreamToArray(
        pipeWithTransformer(rs, transformer)
      );
      const tool = out.find((c) => c.type === "tool-call") as {
        toolName: string;
        input: string;
      };
      expect(tool.toolName).toBe("write_file");
      const args = JSON.parse(tool.input);
      expect(args.file_path).toBe("/tmp/test.txt");
      expect(args.contents).toContain("Line one");
      expect(args.contents).toContain("Line two");
    });
  });

  describe("stream error handling", () => {
    it("should emit original text on YAML parse error", async () => {
      const onError = vi.fn();
      const protocol = yamlProtocol();
      const transformer = protocol.createStreamParser({
        tools: basicTools,
        options: { onError },
      });
      const rs = new ReadableStream<LanguageModelV3StreamPart>({
        start(ctrl) {
          ctrl.enqueue({
            type: "text-delta",
            id: "1",
            delta: "<get_weather>\n[invalid: yaml:\n</get_weather>",
          });
          ctrl.enqueue({
            type: "finish",
            finishReason: stopFinishReason,
            usage: zeroUsage,
          });
          ctrl.close();
        },
      });

      const out = await convertReadableStreamToArray(
        pipeWithTransformer(rs, transformer)
      );
      const textDeltas = out
        .filter((c) => c.type === "text-delta")
        .map(
          (c) =>
            (c as { delta?: string; textDelta?: string }).delta ??
            (c as { delta?: string; textDelta?: string }).textDelta
        )
        .join("");

      expect(textDeltas).toContain("<get_weather>");
      expect(textDeltas).toContain("</get_weather>");
      expect(onError).toHaveBeenCalled();
    });

    it("should flush incomplete tool call as text on finish", async () => {
      const protocol = yamlProtocol();
      const transformer = protocol.createStreamParser({ tools: basicTools });
      const rs = new ReadableStream<LanguageModelV3StreamPart>({
        start(ctrl) {
          ctrl.enqueue({
            type: "text-delta",
            id: "1",
            delta: "<get_weather>\nlocation: Incomplete",
          });
          ctrl.enqueue({
            type: "finish",
            finishReason: stopFinishReason,
            usage: zeroUsage,
          });
          ctrl.close();
        },
      });

      const out = await convertReadableStreamToArray(
        pipeWithTransformer(rs, transformer)
      );
      const toolCalls = out.filter((c) => c.type === "tool-call");
      const textDeltas = out
        .filter((c) => c.type === "text-delta")
        .map(
          (c) =>
            (c as { delta?: string; textDelta?: string }).delta ??
            (c as { delta?: string; textDelta?: string }).textDelta
        )
        .join("");

      expect(toolCalls).toHaveLength(0);
      expect(textDeltas).toContain("<get_weather>");
      expect(textDeltas).toContain("location: Incomplete");
    });
  });

  describe("text-start/text-end events", () => {
    it("should emit proper text-start and text-end events", async () => {
      const protocol = yamlProtocol();
      const transformer = protocol.createStreamParser({ tools: basicTools });
      const rs = new ReadableStream<LanguageModelV3StreamPart>({
        start(ctrl) {
          ctrl.enqueue({ type: "text-delta", id: "1", delta: "Before " });
          ctrl.enqueue({
            type: "text-delta",
            id: "1",
            delta: "<get_location/>",
          });
          ctrl.enqueue({ type: "text-delta", id: "1", delta: " After" });
          ctrl.enqueue({
            type: "finish",
            finishReason: stopFinishReason,
            usage: zeroUsage,
          });
          ctrl.close();
        },
      });

      const out = await convertReadableStreamToArray(
        pipeWithTransformer(rs, transformer)
      );
      const eventTypes = out.map((e) => e.type);

      expect(eventTypes).toContain("text-start");
      expect(eventTypes).toContain("text-end");
      expect(eventTypes).toContain("tool-call");
    });
  });
});

describe("yamlProtocol formatToolCall", () => {
  it("should format tool call with simple arguments", () => {
    const protocol = yamlProtocol();
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
    const protocol = yamlProtocol();
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
    const protocol = yamlProtocol();
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

describe("yamlProtocol formatTools", () => {
  it("should format tools using the template", () => {
    const protocol = yamlProtocol();
    const formatted = protocol.formatTools({
      tools: basicTools,
      toolSystemPromptTemplate: (tools) => `Tools: ${JSON.stringify(tools)}`,
    });

    expect(formatted).toContain("get_weather");
    expect(formatted).toContain("get_location");
  });
});

describe("yamlProtocol extractToolCallSegments", () => {
  it("should extract tool call segments from text", () => {
    const protocol = yamlProtocol();
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
    const protocol = yamlProtocol();
    const text = "No tool calls here";
    const segments = protocol.extractToolCallSegments?.({
      text,
      tools: basicTools,
    });

    expect(segments).toBeDefined();
    expect(segments).toHaveLength(0);
  });
});

describe("yamlSystemPromptTemplate", () => {
  it("should include multiline example by default", () => {
    const testTools = [
      {
        type: "function" as const,
        name: "test",
        inputSchema: { type: "object" },
      },
    ];
    const template = yamlSystemPromptTemplate(testTools);

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
    const template = yamlSystemPromptTemplate(testTools, false);

    expect(template).toContain("# Tools");
    expect(template).toContain(
      '<tools>[{"type":"function","name":"test","inputSchema":{"type":"object"}}]</tools>'
    );
    expect(template).not.toContain("YAML's literal block syntax");
    expect(template).not.toContain("contents: |");
  });

  it("should include proper format instructions", () => {
    const template = yamlSystemPromptTemplate([]);

    expect(template).toContain("# Format");
    expect(template).toContain("XML element");
    expect(template).toContain("YAML syntax");
    expect(template).toContain("# Example");
    expect(template).toContain("<get_weather>");
    expect(template).toContain("location: New York");
    expect(template).toContain("# Rules");
  });
});

describe("yamlProtocol options", () => {
  it("should respect includeMultilineExample option", () => {
    const protocolWithExample = yamlProtocol({
      includeMultilineExample: true,
    });
    const protocolWithoutExample = yamlProtocol({
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

describe("yamlProtocol self-closing tags with whitespace", () => {
  it("should parse self-closing tag with space before slash", () => {
    const protocol = yamlProtocol();
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
    const protocol = yamlProtocol();
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

  it("should handle self-closing tag with whitespace in stream", async () => {
    const protocol = yamlProtocol();
    const transformer = protocol.createStreamParser({ tools: basicTools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<get_location />",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

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

describe("yamlProtocol nested tool tags", () => {
  it("should not parse tool tags inside YAML body", () => {
    const protocol = yamlProtocol();
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
    const protocol = yamlProtocol();
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
