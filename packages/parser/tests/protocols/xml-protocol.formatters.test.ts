import { describe, it, expect } from "vitest";
import { xmlProtocol } from "@/protocols/xml-protocol";

describe("xmlProtocol formatters", () => {
  it("formatToolCall handles JSON string input and object input", () => {
    const p = xmlProtocol();
    const asString = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "add",
      input: JSON.stringify({ a: 1, b: 2 }),
    } as any);
    expect(asString).toMatch(/<add>/);
    expect(asString).toMatch(/<a>1<\/a>/);

    const asObject = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "add",
      input: { a: 1, b: 2 } as any,
    } as any);
    expect(asObject).toMatch(/<add>/);
  });

  it("formatToolResponse builds response envelope", () => {
    const p = xmlProtocol();
    const xml = p.formatToolResponse({
      type: "tool-result",
      toolCallId: "id",
      toolName: "add",
      output: { sum: 3 },
    } as any);
    expect(xml).toMatch(/<tool_response>/);
    expect(xml).toMatch(/<tool_name>add<\/tool_name>/);
  });
});
