import type {
  LanguageModelV4Content,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";

describe("hermesProtocol formatters and parseGeneratedText edges", () => {
  it("formatToolCall stringifies input JSON and non-JSON inputs", () => {
    const p = hermesProtocol();
    const jsonCall: LanguageModelV4ToolCall = {
      type: "tool-call",
      toolCallId: "id",
      toolName: "run",
      input: '{"a":1}',
    };
    const xml = p.formatToolCall(jsonCall);
    expect(xml).toContain("<tool_call>");
    const textCall: LanguageModelV4ToolCall = {
      type: "tool-call",
      toolCallId: "id",
      toolName: "run",
      input: "not-json",
    };
    const xml2 = p.formatToolCall(textCall);
    expect(xml2).toContain("run");
  });

  it("parseGeneratedText falls back to text on malformed tool call", () => {
    const p = hermesProtocol();
    const out = p.parseGeneratedText({
      text: "prefix <tool_call>{bad}</tool_call> suffix",
      tools: [],
    });
    const combined = out
      .map((c: LanguageModelV4Content) => (c.type === "text" ? c.text : ""))
      .join("");
    expect(combined).toContain("<tool_call>{bad}</tool_call>");
  });
});
