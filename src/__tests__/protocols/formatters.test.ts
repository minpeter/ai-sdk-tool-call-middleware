import { describe, expect, it } from "vitest";

import { jsonProtocol } from "../../core/protocols/json-protocol";
import { xmlProtocol } from "../../core/protocols/xml-protocol";

describe("protocol formatters", () => {
  it("jsonProtocol formatToolCall and formatTools", () => {
    const p = jsonProtocol();
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
  });

  it("xmlProtocol formatToolCall and formatTools", () => {
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
  });
});
