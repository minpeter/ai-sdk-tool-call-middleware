import { describe, it, expect } from "vitest";
import { jsonMixProtocol } from "@/protocols/json-mix-protocol";
import { xmlProtocol } from "@/protocols/xml-protocol";

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
      toolSystemPromptTemplate: t => `tools:${t}`,
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

  it("xmlProtocol formatToolCall/Response and formatTools", () => {
    const p = xmlProtocol();
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
      toolSystemPromptTemplate: t => `tools:${t}`,
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
