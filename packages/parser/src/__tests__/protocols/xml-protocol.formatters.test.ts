import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../protocols/morph-xml-protocol";

const ADD_TAG_REGEX = /<add>/;
const A_TAG_REGEX = /<a>1<\/a>/;
const TOOL_RESPONSE_REGEX = /<tool_response>/;
const TOOL_NAME_ADD_REGEX = /<tool_name>add<\/tool_name>/;

describe("morphXmlProtocol formatters", () => {
  it("formatToolCall handles JSON string input and object input", () => {
    const p = morphXmlProtocol();
    const asString = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "add",
      input: JSON.stringify({ a: 1, b: 2 }),
    } as any);
    expect(asString).toMatch(ADD_TAG_REGEX);
    expect(asString).toMatch(A_TAG_REGEX);

    const asObject = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "add",
      input: { a: 1, b: 2 } as any,
    } as any);
    expect(asObject).toMatch(ADD_TAG_REGEX);
  });

  it("formatToolResponse builds response envelope", () => {
    const p = morphXmlProtocol();
    const xml = p.formatToolResponse({
      type: "tool-result",
      toolCallId: "id",
      toolName: "add",
      output: { sum: 3 },
    } as any);
    expect(xml).toMatch(TOOL_RESPONSE_REGEX);
    expect(xml).toMatch(TOOL_NAME_ADD_REGEX);
  });
});
