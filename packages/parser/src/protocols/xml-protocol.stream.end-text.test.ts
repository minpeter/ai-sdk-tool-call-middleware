import { describe, it, expect } from "vitest";
import { xmlProtocol } from "./xml-protocol";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";

function collect(stream: ReadableStream<LanguageModelV2StreamPart>) {
  const out: LanguageModelV2StreamPart[] = [];
  return (async () => {
    for await (const c of stream) out.push(c);
    return out;
  })();
}

describe("xmlProtocol streaming trailing text-end on flush", () => {
  it("emits text-end when there is open text at flush with no tags", async () => {
    const protocol = xmlProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "hello" });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });
    const out = await collect(rs.pipeThrough(transformer));
    const types = out.map(c => c.type);
    expect(types).toContain("text-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("text-end");
  });
});
