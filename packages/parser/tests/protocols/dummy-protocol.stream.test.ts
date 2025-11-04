import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { dummyProtocol } from "../../src/protocols/dummy-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

function collect(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const out: LanguageModelV3StreamPart[] = [];
  return (async () => {
    for await (const c of stream) {
      out.push(c);
    }
    return out;
  })();
}

describe("dummyProtocol streaming behavior", () => {
  it("emits text-start only once and text-end when non-text arrives", async () => {
    const protocol = dummyProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "hello" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: " world" });
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
    const out = await collect(rs.pipeThrough(transformer));
    const starts = out.filter((c) => c.type === "text-start");
    const deltas = out.filter((c) => c.type === "text-delta");
    const ends = out.filter((c) => c.type === "text-end");
    expect(starts.length).toBe(1);
    expect(deltas.map((d: any) => d.delta).join("")).toBe("hello world");
    expect(ends.length).toBe(1);
    // tool-call and finish should pass through after text-end
    const afterEndIndex = out.findIndex((c) => c.type === "text-end");
    expect(
      out.slice(afterEndIndex + 1).some((c) => c.type === "tool-call")
    ).toBe(true);
    expect(out.at(-1)).toMatchObject({ type: "finish" });
  });

  it("flush emits text-end when stream closes with pending text", async () => {
    const protocol = dummyProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "partial" });
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
      .map((d: any) => d.delta)
      .join("");
    expect(text).toBe("partial");
    expect(out.some((c) => c.type === "text-end")).toBe(true);
  });
});
