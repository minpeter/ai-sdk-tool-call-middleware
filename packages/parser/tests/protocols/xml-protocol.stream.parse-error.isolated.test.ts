import type {
  LanguageModelV2FunctionTool,
  LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { morphXmlProtocol } from "@/protocols/morph-xml-protocol";

function collect(stream: ReadableStream<LanguageModelV2StreamPart>) {
  const out: LanguageModelV2StreamPart[] = [];
  return (async () => {
    for await (const c of stream) out.push(c);
    return out;
  })();
}

describe("morphXmlProtocol streaming parse error with malformed XML", () => {
  it("invokes onError and emits original text on parser exception", async () => {
    const protocol = morphXmlProtocol();
    const tools: LanguageModelV2FunctionTool[] = [
      {
        type: "function",
        name: "a",
        description: "",
        inputSchema: { type: "object" },
      },
    ];
    const onError = vi.fn();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        // Use malformed XML that will cause parsing to fail
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<a><x>1</x><unclosed>tag</a>",
        });
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
    expect(text).toContain("<a><x>1</x><unclosed>tag</a>");
    expect(onError).toHaveBeenCalled();
  });
});
