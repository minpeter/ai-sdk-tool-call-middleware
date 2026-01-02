import { describe, expect, it } from "vitest";

import type { TCMCoreProtocol } from "../../core/protocols/protocol-interface";
import { isTCMProtocolFactory } from "../../core/protocols/protocol-interface";

describe("utils/protocol - isTCMProtocolFactory", () => {
  it("returns true for a factory function", () => {
    const factory = () =>
      ({
        formatTools: () => "",
        formatToolCall: () => "",
        formatToolResponse: () => "",
        parseGeneratedText: () => [],
        createStreamParser: () => new TransformStream(),
      }) as TCMCoreProtocol;
    expect(isTCMProtocolFactory(factory)).toBe(true);
  });

  it("returns false for a protocol object", () => {
    const obj: TCMCoreProtocol = {
      formatTools: () => "",
      formatToolCall: () => "",
      formatToolResponse: () => "",
      parseGeneratedText: () => [],
      createStreamParser: () => new TransformStream(),
    };
    expect(isTCMProtocolFactory(obj)).toBe(false);
  });
});
