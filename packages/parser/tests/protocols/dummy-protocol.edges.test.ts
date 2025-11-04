import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";

import { dummyProtocol } from "../../src/protocols/dummy-protocol";

describe("dummyProtocol edge cases", () => {
  it("handles non-text first by passing through and not emitting text-end", async () => {
    const transformer = dummyProtocol().createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "tool-call",
          toolCallId: "x",
          toolName: "t",
          input: "{}",
        } as any);
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(rs.pipeThrough(transformer));
    expect(out[0]).toMatchObject({ type: "tool-call" });
    expect(out.some((c) => c.type === "text-end")).toBe(false);
  });

  it("flush without any prior text does not emit extra text-end", async () => {
    const transformer = dummyProtocol().createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(rs.pipeThrough(transformer));
    expect(out.filter((c) => c.type === "text-end").length).toBe(0);
  });
});
