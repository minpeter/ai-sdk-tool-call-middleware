import { describe, it, expect } from "vitest";
import { isProtocolFactory } from "@/utils";
import type { ToolCallProtocol } from "@/protocols/tool-call-protocol";

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
