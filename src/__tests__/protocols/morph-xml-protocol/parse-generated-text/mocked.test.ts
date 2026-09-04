import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import type { RxmlValue } from "../../../../rxml/builders/stringify";

function isRxmlRecord(
  value: RxmlValue
): value is Readonly<Record<string, RxmlValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("morphXmlProtocol parseGeneratedText recovery via malformed XML", () => {
  it("recovers malformed XML by parsing available content", () => {
    const p = morphXmlProtocol();
    const onError = vi.fn();
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "a",
        description: "",
        inputSchema: { type: "object" },
      },
    ];
    // Use valid outer structure but malformed inner XML that will cause parsing to fail
    const text = "prefix <a><arg>1</arg><unclosed>tag</a> suffix";
    const out = p.parseGeneratedText({ text, tools, options: { onError } });
    const toolCalls = out.filter((c) => c.type === "tool-call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ type: "tool-call", toolName: "a" });
    const [toolCall] = toolCalls;
    if (toolCall?.type !== "tool-call") {
      throw new TypeError("Expected tool-call part");
    }
    const input: RxmlValue = JSON.parse(toolCall.input);
    if (!isRxmlRecord(input)) {
      throw new TypeError("Expected recovered XML input to be an object");
    }
    expect(input).toHaveProperty("arg", 1);
    expect(input).toHaveProperty("unclosed", "tag");
    expect(onError).not.toHaveBeenCalled();
  });
});
