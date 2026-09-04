import { describe, expect, it } from "vitest";

import { dummyProtocol } from "../../../fixtures/dummy-protocol";
import { stopFinishReason, zeroUsage } from "../../../test-helpers";
import { collectProtocolStream } from "../../shared/duplicate-harness";

describe("dummyProtocol non-text pass-through and flush", () => {
  it("handles non-text first by passing through and not emitting text-end", async () => {
    const out = await collectProtocolStream({
      protocol: dummyProtocol(),
      tools: [],
      parts: [
        {
          type: "tool-call",
          toolCallId: "x",
          toolName: "t",
          input: "{}",
        },
        {
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        },
      ],
    });
    expect(out[0]).toMatchObject({ type: "tool-call" });
    expect(out.some((c) => c.type === "text-end")).toBe(false);
  });

  it("flush without any prior text does not emit extra text-end", async () => {
    const out = await collectProtocolStream({
      protocol: dummyProtocol(),
      tools: [],
      parts: [
        {
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        },
      ],
    });
    expect(out.filter((c) => c.type === "text-end").length).toBe(0);
  });
});
