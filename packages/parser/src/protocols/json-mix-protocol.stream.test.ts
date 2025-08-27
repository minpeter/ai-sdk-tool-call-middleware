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

describe("jsonMixProtocol streaming edge cases", () => {
  it("parses tool call when content split across chunks", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "before <tool_call>",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '{"name":"a","arguments":{}',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "}</tool_call> after",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        });
        ctrl.close();
      },
    });
    const out = await collect(rs.pipeThrough(transformer));
    const tool = out.find(c => c.type === "tool-call");
    expect(tool).toMatchObject({
      type: "tool-call",
      toolName: "a",
      input: "{}",
    });
    const text = out
      .filter(c => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    expect(text).toContain("before ");
    expect(out.find(c => c.type === "finish")).toBeTruthy();
  });

  it("supports legacy <tool_code> tags mixed in chunks", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_code>{"name":"b","arguments":{}}',
        });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "</tool_code>" });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });
    const out = await collect(rs.pipeThrough(transformer));
    const tool = out.find(c => c.type === "tool-call");
    expect(tool).toMatchObject({ type: "tool-call", toolName: "b" });
  });

  it("emits original text on malformed JSON and calls onError", async () => {
    const onError = vi.fn();
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<tool_call>{invalid}</tool_call>",
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
      .map((c: any) => c.delta)
      .join("");
    expect(text).toContain("<tool_call>{invalid}</tool_call>");
    expect(onError).toHaveBeenCalled();
  });

  it("flushes buffered partial tool_call at finish as text", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{"name":"c"',
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
      .map((c: any) => c.delta)
      .join("");
    expect(text).toContain('<tool_call>{"name":"c"');
  });
});
