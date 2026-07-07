import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { hermesProtocol } from "../../../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../../../core/protocols/morph-xml-protocol";
import type { TCMCoreProtocol } from "../../../core/protocols/protocol-interface";
import { qwen3CoderProtocol } from "../../../core/protocols/qwen3coder-protocol";
import { yamlXmlProtocol } from "../../../core/protocols/yaml-xml-protocol";

const weatherTools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["city"],
      properties: {
        city: { type: "string" },
        unit: { type: "string" },
      },
    },
  },
];

const pingTools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "ping",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

type ToolCallContent = Extract<LanguageModelV4Content, { type: "tool-call" }>;

interface ProtocolCase {
  readonly name: string;
  readonly protocol: TCMCoreProtocol;
  readonly text: string;
}

const protocolCases: readonly ProtocolCase[] = [
  {
    name: "Hermes",
    protocol: hermesProtocol(),
    text: `<tool_call>{"name":"get_weather","arguments":{"city":"Seoul","unit":"celsius","mood":"sunny"}}</tool_call>`,
  },
  {
    name: "Morph XML",
    protocol: morphXmlProtocol(),
    text: "<get_weather><city>Seoul</city><unit>celsius</unit><mood>sunny</mood></get_weather>",
  },
  {
    name: "YAML XML",
    protocol: yamlXmlProtocol(),
    text: `<get_weather>
city: Seoul
unit: celsius
mood: sunny
</get_weather>`,
  },
  {
    name: "Qwen3Coder",
    protocol: qwen3CoderProtocol(),
    text: `<tool_call>
  <function=get_weather>
    <parameter=city>Seoul</parameter>
    <parameter=unit>celsius</parameter>
    <parameter=mood>sunny</parameter>
  </function>
</tool_call>`,
  },
];

const emptyPropertiesProtocolCases: readonly ProtocolCase[] = [
  {
    name: "Hermes",
    protocol: hermesProtocol(),
    text: `<tool_call>{"name":"ping","arguments":{"extra":"x"}}</tool_call>`,
  },
  {
    name: "Morph XML",
    protocol: morphXmlProtocol(),
    text: "<ping><extra>x</extra></ping>",
  },
  {
    name: "YAML XML",
    protocol: yamlXmlProtocol(),
    text: `<ping>
extra: x
</ping>`,
  },
  {
    name: "Qwen3Coder",
    protocol: qwen3CoderProtocol(),
    text: `<tool_call>
  <function=ping>
    <parameter=extra>x</parameter>
  </function>
</tool_call>`,
  },
];

const prototypeSensitiveProtocolCases: readonly ProtocolCase[] = [
  {
    name: "Hermes",
    protocol: hermesProtocol(),
    text: `<tool_call>{"name":"get_weather","arguments":{"city":"Seoul","constructor":{"polluted":true}}}</tool_call>`,
  },
  {
    name: "Morph XML",
    protocol: morphXmlProtocol(),
    text: "<get_weather><city>Seoul</city><constructor><polluted>true</polluted></constructor></get_weather>",
  },
  {
    name: "YAML XML",
    protocol: yamlXmlProtocol(),
    text: `<get_weather>
city: Seoul
constructor:
  polluted: true
</get_weather>`,
  },
  {
    name: "Qwen3Coder",
    protocol: qwen3CoderProtocol(),
    text: `<tool_call>
  <function=get_weather>
    <parameter=city>Seoul</parameter>
    <parameter=constructor>{"polluted":true}</parameter>
  </function>
</tool_call>`,
  },
];

function extractSingleToolCall(
  parts: LanguageModelV4Content[]
): ToolCallContent {
  const calls = parts.filter(
    (part): part is ToolCallContent => part.type === "tool-call"
  );
  expect(calls).toHaveLength(1);
  const [call] = calls;
  if (!call) {
    throw new Error("Expected one tool-call");
  }
  return call;
}

describe("cross-protocol tool arg sanitization", () => {
  it.each(
    protocolCases
  )("$name parseGeneratedText drops schema-unknown top-level args and emits the tool call", ({
    protocol,
    text,
  }) => {
    const parts = protocol.parseGeneratedText({
      text,
      tools: weatherTools,
      options: {},
    });

    const toolCall = extractSingleToolCall(parts);
    const input: unknown = JSON.parse(toolCall.input);

    expect(toolCall.toolName).toBe("get_weather");
    expect(input).toEqual({ city: "Seoul", unit: "celsius" });
  });

  it.each(
    emptyPropertiesProtocolCases
  )("$name parseGeneratedText drops args for empty properties schemas", ({
    protocol,
    text,
  }) => {
    const parts = protocol.parseGeneratedText({
      text,
      tools: pingTools,
      options: {},
    });

    const toolCall = extractSingleToolCall(parts);
    const input: unknown = JSON.parse(toolCall.input);

    expect(toolCall.toolName).toBe("ping");
    expect(input).toEqual({});
  });

  it.each(
    prototypeSensitiveProtocolCases
  )("$name parseGeneratedText does not leak prototype-sensitive raw text", ({
    protocol,
    text,
  }) => {
    const parts = protocol.parseGeneratedText({
      text,
      tools: weatherTools,
      options: {},
    });

    expect(parts.some((part) => part.type === "tool-call")).toBe(false);
    const joinedText = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(joinedText).not.toContain("constructor");
    expect(joinedText).not.toContain("<tool_call>");
    expect(joinedText).not.toContain("<get_weather>");
  });
});
