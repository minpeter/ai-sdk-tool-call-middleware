import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import { runProtocolTextDeltaStream } from "./streaming-events.shared";

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
});
