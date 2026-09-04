import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, test } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import { runGeneratedJsonRepair } from "../../shared/duplicate-harness";

const tools: LanguageModelV4FunctionTool[] = [
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
      properties: { location: { type: "string" } },
    },
  },
];

type ToolCall = Extract<LanguageModelV4Content, { type: "tool-call" }>;

function parseTags(text: string): LanguageModelV4Content[] {
  return runGeneratedJsonRepair({
    protocol: morphXmlProtocol(),
    text,
    tools,
  });
}

function callsFrom(parts: LanguageModelV4Content[]): ToolCall[] {
  return parts.filter((part): part is ToolCall => part.type === "tool-call");
}

const locationCall = {
  type: "tool-call",
  toolName: "get_location",
  input: "{}",
};

describe("morphXmlProtocol parseGeneratedText self-closing tags", () => {
  test("should parse self-closing tool call without arguments (issue #84)", () => {
    const toolCalls = callsFrom(parseTags("<get_location/>"));
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject(locationCall);
  });

  test("should parse self-closing tool call with surrounding text (issue #84)", () => {
    const out = parseTags("Getting your location now... <get_location/> Done!");
    const toolCalls = callsFrom(out);
    const textParts = out.filter((part) => part.type === "text");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject(locationCall);
    expect(textParts).toHaveLength(2);
    expect(textParts[0]).toMatchObject({
      text: "Getting your location now... ",
    });
    expect(textParts[1]).toMatchObject({ text: " Done!" });
  });

  test("should parse multiple self-closing tool calls", () => {
    const toolCalls = callsFrom(parseTags("<get_location/><get_location/>"));
    expect(toolCalls).toHaveLength(2);
    for (const call of toolCalls) {
      expect(call).toMatchObject(locationCall);
    }
  });

  test("should parse mixed self-closing and regular tool calls", () => {
    const text =
      "<get_location/><get_weather><location>Seoul</location></get_weather>";
    const toolCalls = callsFrom(parseTags(text));
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject(locationCall);
    expect(toolCalls[1]).toMatchObject({
      type: "tool-call",
      toolName: "get_weather",
    });
    expect(JSON.parse(toolCalls[1]?.input ?? "{}").location).toBe("Seoul");
  });
});
