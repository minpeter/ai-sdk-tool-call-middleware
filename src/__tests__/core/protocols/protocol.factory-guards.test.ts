import { describe, expect, it } from "vitest";

import type { TCMProtocol } from "../../../core/protocols/protocol-interface";
import { isProtocolFactory } from "../../../core/protocols/protocol-interface";

describe("utils/protocol - isProtocolFactory", () => {
  it("returns true for a factory function", () => {
    const factory = () =>
      ({
        formatTools: () => "",
        formatToolCall: () => "",
        parseGeneratedText: () => [],
        createStreamParser: () => new TransformStream(),
      }) as TCMProtocol;
    expect(isProtocolFactory(factory)).toBe(true);
  });

  it("returns false for a protocol object", () => {
    const obj: TCMProtocol = {
      formatTools: () => "",
      formatToolCall: () => "",
      parseGeneratedText: () => [],
      createStreamParser: () => new TransformStream(),
    };
    expect(isProtocolFactory(obj)).toBe(false);
  });
});
