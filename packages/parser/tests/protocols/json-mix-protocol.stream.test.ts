import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { jsonMixProtocol } from "@/protocols/json-mix-protocol";

function collect(stream: ReadableStream<LanguageModelV2StreamPart>) {
  const out: LanguageModelV2StreamPart[] = [];
  return (async () => {
    for await (const c of stream) {
      out.push(c);
    }
    return out;
  })();
}

describe("jsonMixProtocol streaming", () => {
  it("parses normal tool_call blocks into tool-call events", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "pre " });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{"name":"x","arguments":{"a":1}}</tool_call>',
        });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: " post" });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });
    const out = await collect(rs.pipeThrough(transformer));
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool.toolName).toBe("x");
    expect(JSON.parse(tool.input)).toEqual({ a: 1 });
  });

  it("normalizes legacy <tool_call> tags and parses", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{"name":"y","arguments":{}}</tool_call>',
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
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool.toolName).toBe("y");
  });

  it("on parse error emits original text via text-start/delta/end and calls onError", async () => {
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
          delta: "<tool_call>{bad}</tool_call>",
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
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta)
      .join("");
    expect(text).toContain("<tool_call>{bad}</tool_call>");
    expect(out.some((c) => c.type === "text-start")).toBe(true);
    expect(out.some((c) => c.type === "text-end")).toBe(true);
    expect(onError).toHaveBeenCalled();
  });
});

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
    const tool = out.find((c) => c.type === "tool-call");
    expect(tool).toMatchObject({
      type: "tool-call",
      toolName: "a",
      input: "{}",
    });
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    expect(text).toContain("before ");
    expect(out.find((c) => c.type === "finish")).toBeTruthy();
  });

  it("supports legacy <tool_call> tags mixed in chunks", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{"name":"b","arguments":{}}',
        });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "</tool_call>" });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });
    const out = await collect(rs.pipeThrough(transformer));
    const tool = out.find((c) => c.type === "tool-call");
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
      .filter((c) => c.type === "text-delta")
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
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    expect(text).toContain('<tool_call>{"name":"c"');
  });

  it("parses a single call whose tags are split across many chunks (>=6)", async () => {
    const protocol = jsonMixProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "<tool" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "_ca" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "ll>" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: '{"name":"d"' });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: ',"argume',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: 'nts":{',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '"location"',
        });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: ':"NY"' });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "}}" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "</tool" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "_" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "call>" });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });
    const out = await collect(rs.pipeThrough(transformer));
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(JSON.parse(tool.input).location).toBe("NY");
    expect(tool.toolName).toBe("d");
  });
});
