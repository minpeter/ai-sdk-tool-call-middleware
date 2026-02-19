import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  mockUsage,
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

describe("hermesProtocol streaming parsing and error policy", () => {
  it("parses normal tool_call blocks into tool-call events", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool.toolName).toBe("x");
    expect(JSON.parse(tool.input)).toEqual({ a: 1 });
  });

  it("normalizes legacy <tool_call> tags and parses", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{"name":"y","arguments":{}}</tool_call>',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool.toolName).toBe("y");
  });

  it("on parse error suppresses raw fallback text by default and calls onError", async () => {
    const onError = vi.fn();
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<tool_call>{bad}</tool_call>",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta)
      .join("");
    expect(text).not.toContain("<tool_call>");
    expect(text).not.toContain("</tool_call>");
    expect(out.some((c) => c.type === "text-start")).toBe(false);
    expect(out.some((c) => c.type === "text-end")).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it("on parse error emits raw fallback text when explicitly enabled", async () => {
    const onError = vi.fn();
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { onError, emitRawToolCallTextOnError: true },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<tool_call>{bad}</tool_call>",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta)
      .join("");
    expect(text).toContain("<tool_call>{bad}</tool_call>");
    expect(out.some((c) => c.type === "text-start")).toBe(true);
    expect(out.some((c) => c.type === "text-end")).toBe(true);
    expect(onError).toHaveBeenCalled();
  });

  it("parses tool call when content split across chunks", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
          finishReason: stopFinishReason,
          usage: mockUsage(1, 2),
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
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
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{"name":"b","arguments":{}}',
        });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "</tool_call>" });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find((c) => c.type === "tool-call");
    expect(tool).toMatchObject({ type: "tool-call", toolName: "b" });
  });

  it("emits original text on malformed JSON when raw fallback is enabled", async () => {
    const onError = vi.fn();
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { onError, emitRawToolCallTextOnError: true },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<tool_call>{invalid}</tool_call>",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    expect(text).toContain("<tool_call>{invalid}</tool_call>");
    expect(onError).toHaveBeenCalled();
  });

  it("flushes buffered partial tool_call at finish as text when enabled", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { emitRawToolCallTextOnError: true },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{"name":"c"',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    expect(text).toContain('<tool_call>{"name":"c"');
  });

  it("suppresses buffered partial tool_call at finish by default", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{"name":"c"',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    expect(text).not.toContain("<tool_call>");
    expect(out.some((c) => c.type === "tool-call")).toBe(false);
  });

  it("parses a single call whose tags are split across many chunks (>=6)", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
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
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(JSON.parse(tool.input).location).toBe("NY");
    expect(tool.toolName).toBe("d");
  });
});
