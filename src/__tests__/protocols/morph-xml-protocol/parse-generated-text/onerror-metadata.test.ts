import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

const tools: LanguageModelV4FunctionTool[] = [
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
];

const weatherTools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    description: "Weather",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
      },
      required: ["city"],
      additionalProperties: false,
    },
  },
];

describe("morphXmlProtocol parseGeneratedText onError metadata", () => {
  it("populates toolName, toolCallId, and malformed-tool-call-body dropReason when XML body parse fails", () => {
    const onError = vi.fn();
    const protocol = morphXmlProtocol();
    const text =
      "<write_file><file_path>a</file_path><file_path>b</file_path></write_file>";
    protocol.parseGeneratedText({ text, tools, options: { onError } });

    const parseFail = onError.mock.calls.find(([message]) =>
      String(message).includes("Could not process XML tool call")
    );
    expect(parseFail).toBeDefined();
    const metadata = parseFail?.[1];
    expect(metadata).toMatchObject({
      toolName: "write_file",
      dropReason: "malformed-tool-call-body",
    });
    const toolCallId = metadata?.toolCallId;
    expect(typeof toolCallId).toBe("string");
    expect((toolCallId as string).length).toBeGreaterThan(0);
    expect(metadata?.toolCall).toContain("<write_file>");
    expect(metadata?.toolCall).toContain("</write_file>");
  });

  it("calls onError and drops raw text on __proto__ element args", () => {
    const onError = vi.fn();
    const protocol = morphXmlProtocol();
    const text =
      "<write_file><file_path>a</file_path><contents>x</contents><__proto__><polluted>true</polluted></__proto__></write_file>";

    const out = protocol.parseGeneratedText({
      text,
      tools,
      options: { onError },
    });

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(
      out
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe("");
    expect(onError).toHaveBeenCalled();
  });

  it.each([
    "constructor: ordinary prose",
    "prototype: ordinary prose",
    "constructor: true",
  ] as const)("preserves schema-valid string element value %s", (contents) => {
    const onError = vi.fn();
    const protocol = morphXmlProtocol();
    const text = `<write_file><file_path>a</file_path><contents>${contents}</contents></write_file>`;

    const out = protocol.parseGeneratedText({
      text,
      tools,
      options: { onError },
    });
    const tool = out.find((part) => part.type === "tool-call");

    expect(tool?.type).toBe("tool-call");
    if (tool?.type !== "tool-call") {
      throw new Error("expected tool call");
    }
    expect(tool.toolName).toBe("write_file");
    expect(JSON.parse(tool.input)).toEqual({
      file_path: "a",
      contents,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    "constructor: true\nsecret: sentinel-secret",
    'constructor: true\n"secret": sentinel-secret',
    "constructor: true\n1secret: sentinel-secret",
    "<![CDATA[constructor: true\nsecret: sentinel-secret]]>",
  ] as const)("drops XML-wrapped YAML-like sensitive fallback without leaking raw text for %s", (contents) => {
    const onError = vi.fn();
    const protocol = morphXmlProtocol();
    const sentinel = "sentinel-secret";
    const text = `<write_file><file_path>a</file_path><file_path>b</file_path><contents>${contents}</contents></write_file>`;

    const out = protocol.parseGeneratedText({
      text,
      tools,
      options: { emitRawToolCallTextOnError: true, onError },
    });
    const joinedText = out
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    const metadataText = JSON.stringify(onError.mock.calls);

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(joinedText).toBe("");
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain(sentinel);
  });

  it("drops sensitive YAML tool_call text fallback while preserving surrounding text", () => {
    const protocol = morphXmlProtocol();
    const text = `before <tool_call>
name: get_weather
arguments:
  city: Seoul
  constructor:
    polluted: true
</tool_call> after`;

    const out = protocol.parseGeneratedText({
      text,
      tools: weatherTools,
      options: { emitRawToolCallTextOnError: true },
    });

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    const joinedText = out
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(joinedText).toBe("before  after");
    expect(joinedText).not.toContain("constructor");
    expect(joinedText).not.toContain("<tool_call>");
  });
});
