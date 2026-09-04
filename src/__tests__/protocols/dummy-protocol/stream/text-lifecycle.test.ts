import { describe, expect, it } from "vitest";

import { dummyProtocol } from "../../../fixtures/dummy-protocol";
import { stopFinishReason, zeroUsage } from "../../../test-helpers";
import { collectProtocolStream } from "../../shared/duplicate-harness";

describe("dummyProtocol streaming behavior", () => {
  it("emits text-start only once and text-end when non-text arrives", async () => {
    const out = await collectProtocolStream({
      protocol: dummyProtocol(),
      tools: [],
      parts: [
        { type: "text-delta", id: "1", delta: "hello" },
        { type: "text-delta", id: "1", delta: " world" },
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
    const starts = out.filter((c) => c.type === "text-start");
    const deltas = out.filter((c) => c.type === "text-delta");
    const ends = out.filter((c) => c.type === "text-end");
    expect(starts.length).toBe(1);
    expect(deltas.map((delta) => delta.delta).join("")).toBe("hello world");
    expect(ends.length).toBe(1);
    const afterEndIndex = out.findIndex((c) => c.type === "text-end");
    expect(
      out.slice(afterEndIndex + 1).some((c) => c.type === "tool-call")
    ).toBe(true);
    expect(out.at(-1)).toMatchObject({ type: "finish" });
  });

  it("flush emits text-end when stream closes with pending text", async () => {
    const out = await collectProtocolStream({
      protocol: dummyProtocol(),
      tools: [],
      parts: [
        { type: "text-delta", id: "1", delta: "partial" },
        {
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        },
      ],
    });
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((delta) => delta.delta)
      .join("");
    expect(text).toBe("partial");
    expect(out.some((c) => c.type === "text-end")).toBe(true);
  });
});
