import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";

import { jsonMixProtocol } from "../../protocols/json-mix-protocol";

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
        // Provide partial end tag so tag.length condition triggers break
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "</tool_" });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
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
    // No tool-call emitted due to incomplete end tag
    expect(out.some((c) => c.type === "tool-call")).toBe(false);
  });
});
