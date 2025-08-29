import { describe, it, expect, vi } from "vitest";
import type {
  LanguageModelV2StreamPart,
  LanguageModelV2FunctionTool,
} from "@ai-sdk/provider";

function collect(stream: ReadableStream<LanguageModelV2StreamPart>) {
  const out: LanguageModelV2StreamPart[] = [];
  return (async () => {
    for await (const c of stream) out.push(c);
    return out;
  })();
}

describe("xmlProtocol streaming parse error with isolated module mock", () => {
  it("invokes onError and emits original text on parser exception", async () => {
    vi.resetModules();
    vi.doMock("fast-xml-parser", () => ({
      XMLParser: class {
        parse() {
          throw new Error("forced parse error");
        }
      },
      XMLBuilder: class {},
    }));

    const { xmlProtocol } = await import("@/protocols/xml-protocol");
    const protocol = xmlProtocol();
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
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "<a><x>1</x></a>" });
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
    expect(text).toContain("<a><x>1</x></a>");
    expect(onError).toHaveBeenCalled();
  });
});
