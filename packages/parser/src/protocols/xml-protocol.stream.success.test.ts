import { describe, it, expect } from "vitest";
import { xmlProtocol } from "./xml-protocol";
import type {
  LanguageModelV2FunctionTool,
  LanguageModelV2StreamPart,
} from "@ai-sdk/provider";

function collect(stream: ReadableStream<LanguageModelV2StreamPart>) {
  const out: LanguageModelV2StreamPart[] = [];
  return (async () => {
    for await (const c of stream) out.push(c);
    return out;
  })();
}

describe("xmlProtocol streaming success path", () => {
  it("parses <tool>...</tool> into tool-call and flushes pending text", async () => {
    const protocol = xmlProtocol();
    const tools: LanguageModelV2FunctionTool[] = [
      {
        type: "function",
        name: "calc",
        description: "",
        inputSchema: { type: "object" },
      },
    ];
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "pre " });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<calc><a>1</a><b> 2 </b></calc>",
        });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: " post" });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });

    const out = await collect(rs.pipeThrough(transformer));
    const tool = out.find(c => c.type === "tool-call") as any;
    const text = out
      .filter(c => c.type === "text-delta")
      .map(c => (c as any).delta)
      .join("");

    expect(tool?.toolName).toBe("calc");
    const parsed = JSON.parse(tool.input);
    expect(parsed).toEqual({ a: 1, b: 2 }); // In the case of XML, type casting should automatically convert to numbers.
    expect(text).toContain("pre ");
    expect(text).toContain(" post");
    // ensure text-end is emitted eventually
    expect(out.some(c => c.type === "text-end")).toBe(true);
  });
});
