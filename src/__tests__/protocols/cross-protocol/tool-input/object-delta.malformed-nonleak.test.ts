import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import type { TCMCoreProtocol } from "../../../../core/protocols/protocol-interface";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  extractTextDeltas,
  runProtocolTextDeltaStream,
} from "./streaming-events.shared";

const weatherTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "get_weather",
  description: "Get weather",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string" },
      unit: { type: "string" },
    },
    required: ["location"],
  },
};

interface PrototypeSensitiveStreamCase {
  readonly name: string;
  readonly protocol: TCMCoreProtocol;
  readonly text: string;
}

const prototypeSensitiveStreamCases: readonly PrototypeSensitiveStreamCase[] = [
  {
    name: "Hermes",
    protocol: hermesProtocol(),
    text: '<tool_call>{"name":"get_weather","arguments":{"location":"Seoul","constructor":{"polluted":true}}}</tool_call>',
  },
  {
    name: "Morph XML",
    protocol: morphXmlProtocol(),
    text: "<get_weather><location>Seoul</location><constructor><polluted>true</polluted></constructor></get_weather>",
  },
  {
    name: "YAML XML",
    protocol: yamlXmlProtocol(),
    text: "<get_weather>\nlocation: Seoul\nconstructor:\n  polluted: true\n</get_weather>",
  },
  {
    name: "Qwen3Coder",
    protocol: qwen3CoderProtocol(),
    text: '<tool_call>\n  <function=get_weather>\n    <parameter=location>Seoul</parameter>\n    <parameter=constructor>{"polluted":true}</parameter>\n  </function>\n</tool_call>',
  },
];

describe("XML/YAML malformed non-leak guarantees", () => {
  it("malformed xml/yaml do not leave dangling tool-input streams", async () => {
    const [xmlOut, yamlOut] = await Promise.all([
      runProtocolTextDeltaStream({
        protocol: morphXmlProtocol(),
        tools: [weatherTool],
        chunks: ["<get_weather><location>Seoul<location></get_weather>"],
      }),
      runProtocolTextDeltaStream({
        protocol: yamlXmlProtocol(),
        tools: [weatherTool],
        chunks: ["<get_weather>\n- invalid\n- yaml\n</get_weather>"],
      }),
    ]);

    const xmlStarts = xmlOut.filter((part) => part.type === "tool-input-start");
    const xmlEnds = xmlOut.filter((part) => part.type === "tool-input-end");
    const yamlStarts = yamlOut.filter(
      (part) => part.type === "tool-input-start"
    );
    const yamlEnds = yamlOut.filter((part) => part.type === "tool-input-end");

    expect(xmlStarts.length).toBe(xmlEnds.length);
    expect(yamlStarts.length).toBe(yamlEnds.length);
    expect(xmlOut.some((part) => part.type === "finish")).toBe(true);
    expect(yamlOut.some((part) => part.type === "finish")).toBe(true);
  });

  it("prototype-sensitive stream args fail closed without throwing", async () => {
    const xmlErrors: string[] = [];
    const yamlErrors: string[] = [];

    const [xmlOut, yamlOut] = await Promise.all([
      runProtocolTextDeltaStream({
        protocol: morphXmlProtocol(),
        tools: [weatherTool],
        chunks: [
          "<get_weather><location>Seoul</location><constructor><polluted>true</polluted></constructor></get_weather>",
        ],
        options: { onError: (message) => xmlErrors.push(message) },
      }),
      runProtocolTextDeltaStream({
        protocol: yamlXmlProtocol(),
        tools: [weatherTool],
        chunks: [
          "<get_weather>\nlocation: Seoul\nconstructor:\n  polluted: true\n</get_weather>",
        ],
        options: { onError: (message) => yamlErrors.push(message) },
      }),
    ]);

    expect(xmlOut.some((part) => part.type === "tool-call")).toBe(false);
    expect(yamlOut.some((part) => part.type === "tool-call")).toBe(false);
    expect(
      xmlOut.filter((part) => part.type === "tool-input-start")
    ).toHaveLength(
      xmlOut.filter((part) => part.type === "tool-input-end").length
    );
    expect(
      yamlOut.filter((part) => part.type === "tool-input-start")
    ).toHaveLength(
      yamlOut.filter((part) => part.type === "tool-input-end").length
    );
    expect(xmlErrors.length).toBeGreaterThan(0);
    expect(yamlErrors.length).toBeGreaterThan(0);
  });

  it("__proto__ stream args fail closed without throwing", async () => {
    const xmlErrors: string[] = [];
    const yamlErrors: string[] = [];

    const [xmlOut, yamlOut] = await Promise.all([
      runProtocolTextDeltaStream({
        protocol: morphXmlProtocol(),
        tools: [weatherTool],
        chunks: [
          "<get_weather><location>Seoul</location><__proto__><polluted>true</polluted></__proto__></get_weather>",
        ],
        options: { onError: (message) => xmlErrors.push(message) },
      }),
      runProtocolTextDeltaStream({
        protocol: yamlXmlProtocol(),
        tools: [weatherTool],
        chunks: [
          "<get_weather>\nlocation: Seoul\n__proto__:\n  polluted: true\n</get_weather>",
        ],
        options: { onError: (message) => yamlErrors.push(message) },
      }),
    ]);

    expect(xmlOut.some((part) => part.type === "tool-call")).toBe(false);
    expect(yamlOut.some((part) => part.type === "tool-call")).toBe(false);
    expect(
      xmlOut.filter((part) => part.type === "tool-input-start")
    ).toHaveLength(
      xmlOut.filter((part) => part.type === "tool-input-end").length
    );
    expect(
      yamlOut.filter((part) => part.type === "tool-input-start")
    ).toHaveLength(
      yamlOut.filter((part) => part.type === "tool-input-end").length
    );
    expect(xmlErrors.length).toBeGreaterThan(0);
    expect(yamlErrors.length).toBeGreaterThan(0);
  });

  it.each(
    prototypeSensitiveStreamCases
  )("$name does not emit prototype-sensitive raw fallback when raw-on-error is enabled", async ({
    protocol,
    text,
  }) => {
    const out = await runProtocolTextDeltaStream({
      protocol,
      tools: [weatherTool],
      chunks: [text],
      options: { emitRawToolCallTextOnError: true },
    });

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    const textOut = extractTextDeltas(out);
    expect(textOut).not.toContain("constructor");
    expect(textOut).not.toContain("<tool_call>");
    expect(textOut).not.toContain("<get_weather>");
  });
});
