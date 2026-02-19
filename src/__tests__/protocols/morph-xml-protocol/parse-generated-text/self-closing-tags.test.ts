import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, test } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

describe("morphXmlProtocol parseGeneratedText self-closing tags", () => {
  const tools: LanguageModelV3FunctionTool[] = [
    {
      type: "function",
      name: "get_location",
      description: "Get the location",
      inputSchema: { type: "object" },
    },
    {
      type: "function",
      name: "get_weather",
      description: "Get the weather",
      inputSchema: {
        type: "object",
        properties: {
          location: { type: "string" },
        },
      },
    },
  ];

  test("should parse self-closing tool call without arguments (issue #84)", () => {
    const protocol = morphXmlProtocol();
    const text = "<get_location/>";
    const out = protocol.parseGeneratedText({ text, tools, options: {} });

    const toolCalls = out.filter((c) => c.type === "tool-call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      type: "tool-call",
      toolName: "get_location",
      input: "{}",
    });
  });

  test("should parse self-closing tool call with surrounding text (issue #84)", () => {
    const protocol = morphXmlProtocol();
    const text = "Getting your location now... <get_location/> Done!";
    const out = protocol.parseGeneratedText({ text, tools, options: {} });

    const toolCalls = out.filter((c) => c.type === "tool-call");
    const textParts = out.filter((c) => c.type === "text");

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      type: "tool-call",
      toolName: "get_location",
      input: "{}",
    });

    expect(textParts).toHaveLength(2);
    expect(textParts[0]).toMatchObject({
      text: "Getting your location now... ",
    });
    expect(textParts[1]).toMatchObject({ text: " Done!" });
  });

  test("should parse multiple self-closing tool calls", () => {
    const protocol = morphXmlProtocol();
    const text = "<get_location/><get_location/>";
    const out = protocol.parseGeneratedText({ text, tools, options: {} });

    const toolCalls = out.filter((c) => c.type === "tool-call");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      type: "tool-call",
      toolName: "get_location",
      input: "{}",
    });
    expect(toolCalls[1]).toMatchObject({
      type: "tool-call",
      toolName: "get_location",
      input: "{}",
    });
  });

  test("should parse mixed self-closing and regular tool calls", () => {
    const protocol = morphXmlProtocol();
    const text =
      "<get_location/><get_weather><location>Seoul</location></get_weather>";
    const out = protocol.parseGeneratedText({ text, tools, options: {} });

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
    const weatherArgs = JSON.parse((toolCalls[1] as { input: string }).input);
    expect(weatherArgs.location).toBe("Seoul");
  });
});
