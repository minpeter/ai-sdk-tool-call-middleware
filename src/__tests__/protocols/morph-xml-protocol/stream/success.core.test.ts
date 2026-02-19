import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

describe("morphXmlProtocol streaming success core path", () => {
  it("parses <tool>...</tool> into tool-call and flushes pending text", async () => {
    const protocol = morphXmlProtocol();
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
    const protocol = morphXmlProtocol();
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
    const protocol = morphXmlProtocol();
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
    const protocol = morphXmlProtocol();
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
    const protocol = morphXmlProtocol();
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
    const protocol = morphXmlProtocol();
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
});
