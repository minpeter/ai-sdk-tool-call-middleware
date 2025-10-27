import { describe, expect, it } from "vitest";

import { jsonMixProtocol } from "@/protocols/json-mix-protocol";
import { morphXmlProtocol } from "@/protocols/morph-xml-protocol";

describe("protocol formatters", () => {
  it("jsonMixProtocol formatToolCall/Response and formatTools", () => {
    const p = jsonMixProtocol();
    const tools = [
      {
        type: "function",
        name: "a",
        description: "desc",
        inputSchema: { type: "object" },
      },
    ] as any;
    const sys = p.formatTools({
      tools,
      toolSystemPromptTemplate: (t) => `tools:${t}`,
    });
    expect(sys).toContain("tools:");
    const call = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "a",
      input: "{}",
    } as any);
    expect(call).toContain("<tool_call>");
    const resp = p.formatToolResponse({
      type: "tool-result",
      toolName: "a",
      toolCallId: "id",
      output: { ok: true },
    } as any);
    expect(resp).toContain("<tool_response>");
  });

  it("morphXmlProtocol formatToolCall/Response and formatTools", () => {
    const p = morphXmlProtocol();
    const tools = [
      {
        type: "function",
        name: "a",
        description: "desc",
        inputSchema: { type: "object" },
      },
    ] as any;
    const sys = p.formatTools({
      tools,
      toolSystemPromptTemplate: (t) => `tools:${t}`,
    });
    expect(sys).toContain("tools:");
    const call = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "a",
      input: "{}",
    } as any);
    expect(call).toContain("<a");
    const resp = p.formatToolResponse({
      type: "tool-result",
      toolName: "a",
      toolCallId: "id",
      output: { ok: true },
    } as any);
    expect(resp).toContain("<tool_response>");
  });
});
