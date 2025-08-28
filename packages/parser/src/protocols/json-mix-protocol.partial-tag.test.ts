import { describe, it, expect, vi } from "vitest";
import { jsonMixProtocol } from "./json-mix-protocol";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";

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

describe("jsonMixProtocol partial tag handling", () => {
  it("breaks inner loop when only partial start tag suffix present and publishes buffer", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        // End chunk with a partial start tag so getPotentialStartIndex finds a suffix
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "before <tool_c" });
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
      .filter(c => c.type === "text-delta")
      .map(c => (c as any).delta)
      .join("");
    expect(text).toContain("before <tool_c");
    // No tool-call should be emitted
    expect(out.some(c => c.type === "tool-call")).toBe(false);
  });
});
