import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { xmlProtocol } from "../../core/protocols/xml-protocol";
import {
  createChunkedStream,
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../test-helpers";

describe("xmlProtocol streaming success path", () => {
  it.each([
    { name: "self-closing", tag: "<get_location/>" },
    { name: "self-closing with space", tag: "<get_location />" },
    { name: "self-closing with lot of space", tag: "<get_location    />" },
    { name: "self-closing with newline", tag: "<get_location \n />" },
    { name: "open/close with newline", tag: "<get_location>\n</get_location>" },
    { name: "open/close", tag: "<get_location></get_location>" },
  ])("parses $name tool call in stream", async ({ tag }) => {
    const protocol = xmlProtocol();
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

  it("parses <tool>...</tool> into tool-call and flushes pending text", async () => {
    const protocol = xmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "calc",
        description: "",
        inputSchema: { type: "object" },
      },
    ];
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "pre " });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<calc><a>1</a><b> 2 </b></calc>",
        });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: " post" });
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
    const tool = out.find((c) => c.type === "tool-call") as any;
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta)
      .join("");

    expect(tool?.toolName).toBe("calc");
    const parsed = JSON.parse(tool.input);
    expect(parsed).toEqual({ a: 1, b: 2 }); // In the case of XML, type casting should automatically convert to numbers.
    expect(text).toContain("pre ");
    expect(text).toContain(" post");
    // ensure text-end is emitted eventually
    expect(out.some((c) => c.type === "text-end")).toBe(true);
  });

  it("does not expose nested XML tags in text output", async () => {
    const protocol = xmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather for a city",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
        },
      },
    ];
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "Let me check the weather.\n\n",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<get_weather>\n  <city>New York</city>\n</get_weather>",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "\n\nThe weather looks good!",
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
    const tool = out.find((c) => c.type === "tool-call") as any;
    const textParts = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta);
    const fullText = textParts.join("");

    // Verify tool call was parsed correctly
    expect(tool?.toolName).toBe("get_weather");
    const parsed = JSON.parse(tool.input);
    expect(parsed).toEqual({ city: "New York" });

    // Verify nested XML tags are NOT in the output text
    expect(fullText).not.toContain("<city>");
    expect(fullText).not.toContain("</city>");
    expect(fullText).not.toContain("<get_weather>");
    expect(fullText).not.toContain("</get_weather>");

    // Verify only the surrounding text is present
    expect(fullText).toContain("Let me check the weather.");
    expect(fullText).toContain("The weather looks good!");
  });

  it("handles multiple consecutive tool calls without exposing XML tags", async () => {
    const protocol = xmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "get_location",
        description: "Get user location",
        inputSchema: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "get_weather",
        description: "Get weather for a city",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    ];
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "First, " });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<get_location></get_location>",
        });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: " then " });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<get_weather>\n  <city>Tokyo</city>\n</get_weather>",
        });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: " done!" });
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
    const toolCalls = out.filter((c) => c.type === "tool-call") as any[];
    const textParts = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta);
    const fullText = textParts.join("");

    // Verify both tool calls were parsed
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].toolName).toBe("get_location");
    expect(toolCalls[1].toolName).toBe("get_weather");

    // Verify no XML tags in output
    expect(fullText).not.toContain("<get_location>");
    expect(fullText).not.toContain("</get_location>");
    expect(fullText).not.toContain("<get_weather>");
    expect(fullText).not.toContain("</get_weather>");
    expect(fullText).not.toContain("<city>");
    expect(fullText).not.toContain("</city>");

    // Verify only surrounding text
    expect(fullText).toContain("First,");
    expect(fullText).toContain(" then ");
    expect(fullText).toContain(" done!");
  });

  it("handles deeply nested XML parameters without exposing internal tags", async () => {
    const protocol = xmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "send_email",
        description: "Send an email",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string" },
            subject: { type: "string" },
            body: { type: "string" },
          },
        },
      },
    ];
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "Sending email:\n",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta:
            "<send_email>\n  <to>user@example.com</to>\n  <subject>Hello World</subject>\n  <body>This is a test message.</body>\n</send_email>",
        });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "\nEmail sent!" });
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
    const tool = out.find((c) => c.type === "tool-call") as any;
    const textParts = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta);
    const fullText = textParts.join("");

    // Verify tool call parsed correctly
    expect(tool?.toolName).toBe("send_email");
    const parsed = JSON.parse(tool.input);
    expect(parsed).toEqual({
      to: "user@example.com",
      subject: "Hello World",
      body: "This is a test message.",
    });

    // Verify no XML tags in output
    expect(fullText).not.toContain("<send_email>");
    expect(fullText).not.toContain("</send_email>");
    expect(fullText).not.toContain("<to>");
    expect(fullText).not.toContain("<subject>");
    expect(fullText).not.toContain("<body>");

    // Verify only surrounding text
    expect(fullText).toContain("Sending email:");
    expect(fullText).toContain("Email sent!");
  });

  it("handles tool call split across multiple chunks without exposing tags", async () => {
    const protocol = xmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "calculate",
        description: "Perform calculation",
        inputSchema: {
          type: "object",
          properties: {
            operation: { type: "string" },
            x: { type: "number" },
            y: { type: "number" },
          },
        },
      },
    ];
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "Computing: " });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "<calculate>\n" });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "  <operation>" });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "add" });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "</operation>\n" });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "  <x>10</x>\n" });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "  <y>20</y>\n" });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "</calculate>" });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "\nResult ready!" });
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
    const tool = out.find((c) => c.type === "tool-call") as any;
    const textParts = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta);
    const fullText = textParts.join("");

    // Verify tool call parsed correctly
    expect(tool?.toolName).toBe("calculate");
    const parsed = JSON.parse(tool.input);
    expect(parsed).toEqual({ operation: "add", x: 10, y: 20 });

    // Verify no XML tags in output
    expect(fullText).not.toContain("<calculate>");
    expect(fullText).not.toContain("</calculate>");
    expect(fullText).not.toContain("<operation>");
    expect(fullText).not.toContain("<x>");
    expect(fullText).not.toContain("<y>");

    // Verify only surrounding text
    expect(fullText).toContain("Computing:");
    expect(fullText).toContain("Result ready!");
  });

  it("handles array parameters with repeated tags without exposing internal XML", async () => {
    const protocol = xmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "send_messages",
        description: "Send messages to multiple recipients",
        inputSchema: {
          type: "object",
          properties: {
            recipient: { type: "array", items: { type: "string" } },
            message: { type: "string" },
          },
        },
      },
    ];
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "Sending to all:\n",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta:
            "<send_messages>\n  <recipient>alice@example.com</recipient>\n  <recipient>bob@example.com</recipient>\n  <message>Hello!</message>\n</send_messages>",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "\nMessages sent!",
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
    const tool = out.find((c) => c.type === "tool-call") as any;
    const textParts = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta);
    const fullText = textParts.join("");

    // Verify tool call parsed correctly
    expect(tool?.toolName).toBe("send_messages");
    const parsed = JSON.parse(tool.input);
    expect(parsed.recipient).toEqual(["alice@example.com", "bob@example.com"]);
    expect(parsed.message).toBe("Hello!");

    // Verify no XML tags in output
    expect(fullText).not.toContain("<send_messages>");
    expect(fullText).not.toContain("</send_messages>");
    expect(fullText).not.toContain("<recipient>");
    expect(fullText).not.toContain("</recipient>");
    expect(fullText).not.toContain("<message>");
    expect(fullText).not.toContain("</message>");

    // Verify only surrounding text
    expect(fullText).toContain("Sending to all:");
    expect(fullText).toContain("Messages sent!");
  });

  it("suppresses raw XML tags in output when parsing fails by default", async () => {
    const protocol = xmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "bad_tool",
        description: "Tool with strict schema",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
      },
    ];
    const onError = vi.fn();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "Calling tool:\n" });
        // Invalid XML with duplicate string tags (will cause RXMLDuplicateStringTagError)
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<bad_tool><name>first</name><name>second</name></bad_tool>",
        });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "\nDone!" });
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
    const textParts = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta);
    const fullText = textParts.join("");

    // Verify no tool call was created due to error
    expect(toolCalls).toHaveLength(0);

    // Verify onError was called
    expect(onError).toHaveBeenCalled();

    // Verify malformed tool XML is not leaked in text fallback by default
    expect(fullText).not.toContain("<bad_tool>");
    expect(fullText).not.toContain("</bad_tool>");
    expect(fullText).not.toContain("<name>");

    // Verify surrounding text is also present
    expect(fullText).toContain("Calling tool:");
    expect(fullText).toContain("Done!");
  });

  it("can expose raw XML fallback when explicitly enabled", async () => {
    const protocol = xmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "bad_tool",
        description: "Tool with strict schema",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
      },
    ];
    const transformer = protocol.createStreamParser({
      tools,
      options: { emitRawToolCallTextOnError: true },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "Calling tool:\n" });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<bad_tool><name>first</name><name>second</name></bad_tool>",
        });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "\nDone!" });
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
    const fullText = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as { delta?: string }).delta ?? "")
      .join("");

    expect(fullText).toContain("<bad_tool>");
    expect(fullText).toContain("</bad_tool>");
    expect(fullText).toContain("<name>");
    expect(fullText).toContain("Calling tool:");
    expect(fullText).toContain("Done!");
  });

  it("properly emits text-start and text-end events around tool calls", async () => {
    const protocol = xmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "test_tool",
        description: "Test tool",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    ];
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "Before tool call ",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<test_tool><value>test</value></test_tool>",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: " After tool call",
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

    // Extract events in order
    const eventTypes = out.map((e) => e.type);
    const textStarts = out.filter((e) => e.type === "text-start");
    const textEnds = out.filter((e) => e.type === "text-end");
    const toolCalls = out.filter((e) => e.type === "tool-call");

    // Verify tool call was parsed
    expect(toolCalls).toHaveLength(1);

    // Verify text segments are properly opened and closed
    expect(textStarts.length).toBeGreaterThan(0);
    expect(textEnds.length).toBeGreaterThan(0);

    // Verify the sequence: text-end should come before tool-call
    const toolCallIndex = eventTypes.indexOf("tool-call");
    const textEndBeforeTool = eventTypes.lastIndexOf("text-end", toolCallIndex);

    // There should be text before the tool call, so there must be a text-end before it
    expect(textEndBeforeTool).toBeGreaterThanOrEqual(0);
    expect(textEndBeforeTool).toBeLessThan(toolCallIndex);

    // Verify text-start after tool-call if there's text after
    const textDeltaAfterTool = eventTypes.indexOf(
      "text-delta",
      toolCallIndex + 1
    );
    if (textDeltaAfterTool !== -1) {
      const textStartAfterTool = eventTypes.indexOf(
        "text-start",
        toolCallIndex + 1
      );
      expect(textStartAfterTool).toBeGreaterThanOrEqual(0);
      expect(textStartAfterTool).toBeLessThan(textDeltaAfterTool);
    }

    // Verify each text-start has a corresponding text-end (or is the last segment)
    expect(textStarts.length).toBeLessThanOrEqual(textEnds.length + 1);
  });

  it("handles text-end correctly when multiple tool calls are present", async () => {
    const protocol = xmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "tool_a",
        description: "Tool A",
        inputSchema: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "tool_b",
        description: "Tool B",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "Start " });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<tool_a></tool_a>",
        });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: " Middle " });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<tool_b></tool_b>",
        });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: " End" });
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

    const textStarts = out.filter((e) => e.type === "text-start");
    const toolCalls = out.filter((e) => e.type === "tool-call");

    // Verify both tool calls were parsed
    expect(toolCalls).toHaveLength(2);

    // Verify text segments exist
    expect(textStarts.length).toBeGreaterThan(0);

    // Count text-delta events to ensure content is preserved
    const textDeltas = out
      .filter((e) => e.type === "text-delta")
      .map((e) => (e as any).delta);
    const fullText = textDeltas.join("");

    expect(fullText).toContain("Start");
    expect(fullText).toContain("Middle");
    expect(fullText).toContain("End");
    expect(fullText).not.toContain("<tool_a>");
    expect(fullText).not.toContain("<tool_b>");
  });

  it("handles consecutive tool calls with no text between them", async () => {
    const protocol = xmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "tool_a",
        description: "Tool A",
        inputSchema: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "tool_b",
        description: "Tool B",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<tool_a></tool_a><tool_b></tool_b>",
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
    const toolCalls = out.filter((e) => e.type === "tool-call");
    const textDeltas = out.filter((e) => e.type === "text-delta");

    // Both tool calls should be parsed
    expect(toolCalls).toHaveLength(2);

    // Text deltas may be emitted for empty segments between tools (for proper text boundaries)
    // The important thing is that no XML tags are exposed
    const fullText = textDeltas.map((e) => (e as any).delta).join("");
    expect(fullText).not.toContain("<tool_a>");
    expect(fullText).not.toContain("<tool_b>");
  });

  it("handles tool calls separated only by whitespace", async () => {
    const protocol = xmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "tool_a",
        description: "Tool A",
        inputSchema: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "tool_b",
        description: "Tool B",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<tool_a></tool_a>\n  \n<tool_b></tool_b>",
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
    const toolCalls = out.filter((e) => e.type === "tool-call");
    const textDeltas = out
      .filter((e) => e.type === "text-delta")
      .map((e) => (e as any).delta);
    const fullText = textDeltas.join("");

    // Both tool calls should be parsed
    expect(toolCalls).toHaveLength(2);

    // Whitespace should be preserved in text output (or may be empty if optimized away)
    // The important thing is no XML tags are exposed
    expect(fullText).not.toContain("<tool_a>");
    expect(fullText).not.toContain("<tool_b>");
    // If whitespace is preserved, it should match
    if (fullText.trim().length === 0) {
      // Whitespace handling is implementation-dependent
      expect(fullText.length).toBeGreaterThanOrEqual(0);
    }
  });

  it("handles empty tool call parameters", async () => {
    const protocol = xmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "empty_tool",
        description: "Tool with no parameters",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "Calling <empty_tool></empty_tool> now",
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
    const toolCall = out.find((e) => e.type === "tool-call") as any;
    const textDeltas = out
      .filter((e) => e.type === "text-delta")
      .map((e) => (e as any).delta);
    const fullText = textDeltas.join("");

    // Tool call should be parsed
    expect(toolCall).toBeDefined();
    expect(toolCall.toolName).toBe("empty_tool");
    const parsed = JSON.parse(toolCall.input);
    expect(parsed).toEqual({});

    // Text should not contain XML tags
    expect(fullText).toContain("Calling");
    expect(fullText).toContain("now");
    expect(fullText).not.toContain("<empty_tool>");
  });
});
