import { describe, expect, it } from "vitest";

import type { ToolCallProtocol } from "../../src/protocols/tool-call-protocol";
import { isProtocolFactory } from "../../src/protocols/tool-call-protocol";

describe("utils/protocol - isProtocolFactory", () => {
  it("returns true for a factory function", () => {
    const factory = () =>
      ({
        formatTools: () => "",
        formatToolCall: () => "",
        formatToolResponse: () => "",
        parseGeneratedText: () => [],
        createStreamParser: () => new TransformStream(),
      }) as ToolCallProtocol;
    expect(isProtocolFactory(factory)).toBe(true);
  });

  it("returns false for a protocol object", () => {
    const obj: ToolCallProtocol = {
      formatTools: () => "",
      formatToolCall: () => "",
      formatToolResponse: () => "",
      parseGeneratedText: () => [],
      createStreamParser: () => new TransformStream(),
    };
    expect(isProtocolFactory(obj)).toBe(false);
  });
});
