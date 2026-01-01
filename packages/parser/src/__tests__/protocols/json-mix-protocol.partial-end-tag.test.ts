import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";

import { jsonMixProtocol } from "../../core/protocols/json-mix-protocol";
import { stopFinishReason, zeroUsage } from "../test-helpers";

describe("jsonMixProtocol partial end-tag handling", () => {
  it("breaks loop when only partial end tag present at end of buffer", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{"name":"t","arguments":{}',
        });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "</tool_" });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(rs.pipeThrough(transformer));
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    expect(text).toContain('<tool_call>{"name":"t","arguments":{}');
    expect(out.some((c) => c.type === "tool-call")).toBe(false);
  });
});
