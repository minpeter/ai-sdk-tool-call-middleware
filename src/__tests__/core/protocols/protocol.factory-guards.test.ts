import { describe, expect, it } from "vitest";

import type { TCMCoreProtocol } from "../../../core/protocols/protocol-interface";
import {
  isProtocolFactory,
  isTCMProtocolFactory,
} from "../../../core/protocols/protocol-interface";

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
      parseGeneratedText: () => [],
      createStreamParser: () => new TransformStream(),
    };
    expect(isTCMProtocolFactory(obj)).toBe(false);
  });

  it("isProtocolFactory alias matches isTCMProtocolFactory", () => {
    const factory = () =>
      ({
        formatTools: () => "",
        formatToolCall: () => "",
        parseGeneratedText: () => [],
        createStreamParser: () => new TransformStream(),
      }) as TCMCoreProtocol;

    const protocol: TCMCoreProtocol = {
      formatTools: () => "",
      formatToolCall: () => "",
      parseGeneratedText: () => [],
      createStreamParser: () => new TransformStream(),
    };

    expect(isProtocolFactory(factory)).toBe(isTCMProtocolFactory(factory));
    expect(isProtocolFactory(protocol)).toBe(isTCMProtocolFactory(protocol));
  });
});
