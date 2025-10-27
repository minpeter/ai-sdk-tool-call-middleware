import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { jsonMixProtocol } from "@/protocols/json-mix-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

function collect(stream: ReadableStream<LanguageModelV2StreamPart>) {
  const out: LanguageModelV2StreamPart[] = [];
  return (async () => {
    for await (const c of stream) out.push(c);
    return out;
  })();
}

describe("jsonMixProtocol partial end-tag handling", () => {
  it("breaks loop when only partial end tag present at end of buffer", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
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
    const out = await collect(rs.pipeThrough(transformer));
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    expect(text).toContain('<tool_call>{"name":"t","arguments":{}');
    // No tool-call emitted due to incomplete end tag
    expect(out.some((c) => c.type === "tool-call")).toBe(false);
  });
});
