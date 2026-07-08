import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

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

const metadataTools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "metadata",
    inputSchema: {
      type: "object",
      patternProperties: {
        "^x-": { type: "number" },
      },
    },
  },
];

const unsafeAdditionalPropertiesTools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "metadata_extra",
    inputSchema: {
      type: "object",
      patternProperties: {
        "^(a+)+$": false,
      },
      additionalProperties: true,
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

const reorderedArgsProtocolCases: readonly ProtocolCase[] = [
  {
    name: "Hermes",
    protocol: hermesProtocol(),
    text: `<tool_call>{"name":"get_weather","arguments":{"mood":"sunny","unit":"celsius","city":"Seoul"}}</tool_call>`,
  },
  {
    name: "Morph XML",
    protocol: morphXmlProtocol(),
    text: "<get_weather><mood>sunny</mood><unit>celsius</unit><city>Seoul</city></get_weather>",
  },
  {
    name: "YAML XML",
    protocol: yamlXmlProtocol(),
    text: `<get_weather>
mood: sunny
unit: celsius
city: Seoul
</get_weather>`,
  },
  {
    name: "Qwen3Coder",
    protocol: qwen3CoderProtocol(),
    text: `<tool_call>
  <function=get_weather>
    <parameter=mood>sunny</parameter>
    <parameter=unit>celsius</parameter>
    <parameter=city>Seoul</parameter>
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

const patternPropertiesProtocolCases: readonly ProtocolCase[] = [
  {
    name: "Hermes",
    protocol: hermesProtocol(),
    text: `<tool_call>{"name":"metadata","arguments":{"x-count":"3","other":"drop"}}</tool_call>`,
  },
  {
    name: "Morph XML",
    protocol: morphXmlProtocol(),
    text: "<metadata><x-count>3</x-count><other>drop</other></metadata>",
  },
  {
    name: "YAML XML",
    protocol: yamlXmlProtocol(),
    text: `<metadata>
x-count: 3
other: drop
</metadata>`,
  },
  {
    name: "Qwen3Coder",
    protocol: qwen3CoderProtocol(),
    text: `<tool_call>
  <function=metadata>
    <parameter=x-count>3</parameter>
    <parameter=other>drop</parameter>
  </function>
</tool_call>`,
  },
];

const unsafeAdditionalPropertiesProtocolCases: readonly ProtocolCase[] = [
  {
    name: "Hermes",
    protocol: hermesProtocol(),
    text: `<tool_call>{"name":"metadata_extra","arguments":{"safe":"ok","aaaa":"drop"}}</tool_call>`,
  },
  {
    name: "Morph XML",
    protocol: morphXmlProtocol(),
    text: "<metadata_extra><safe>ok</safe><aaaa>drop</aaaa></metadata_extra>",
  },
  {
    name: "YAML XML",
    protocol: yamlXmlProtocol(),
    text: `<metadata_extra>
safe: ok
aaaa: drop
</metadata_extra>`,
  },
  {
    name: "Qwen3Coder",
    protocol: qwen3CoderProtocol(),
    text: `<tool_call>
  <function=metadata_extra>
    <parameter=safe>ok</parameter>
    <parameter=aaaa>drop</parameter>
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
    reorderedArgsProtocolCases
  )("$name parseGeneratedText keeps declared args when optional args precede required args", ({
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
    patternPropertiesProtocolCases
  )("$name parseGeneratedText drops non-matching patternProperties-only args", ({
    protocol,
    text,
  }) => {
    const parts = protocol.parseGeneratedText({
      text,
      tools: metadataTools,
      options: {},
    });

    const toolCall = extractSingleToolCall(parts);
    const input: unknown = JSON.parse(toolCall.input);

    expect(toolCall.toolName).toBe("metadata");
    expect(input).toEqual({ "x-count": 3 });
  });

  it.each(
    unsafeAdditionalPropertiesProtocolCases
  )("$name parseGeneratedText preserves safe additionalProperties true args with unsafe false patterns", ({
    protocol,
    text,
  }) => {
    const parts = protocol.parseGeneratedText({
      text,
      tools: unsafeAdditionalPropertiesTools,
      options: {},
    });

    const toolCall = extractSingleToolCall(parts);
    const input: unknown = JSON.parse(toolCall.input);

    expect(toolCall.toolName).toBe("metadata_extra");
    expect(input).toEqual({ safe: "ok" });
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

  it.each(
    prototypeSensitiveProtocolCases
  )("$name parseGeneratedText redacts prototype-sensitive onError metadata", ({
    protocol,
    text,
  }) => {
    const onError = vi.fn();

    protocol.parseGeneratedText({
      text,
      tools: weatherTools,
      options: { emitRawToolCallTextOnError: true, onError },
    });

    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("constructor");
    expect(metadataText).not.toContain("<tool_call>");
    expect(metadataText).not.toContain("<get_weather>");
    expect(metadataText).not.toContain("<function=");
  });
});
