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

  it("passes toolName, toolCallId, and dropReason in onError when tool call is dropped at finish", async () => {
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
          delta: '<tool_call>{"name":"bash","arguments":{"command":"ls"',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    await convertReadableStreamToArray(pipeWithTransformer(rs, transformer));
    expect(onError).toHaveBeenCalledTimes(1);
    const [message, metadata] = onError.mock.calls[0];
    // Default (emitRawToolCallTextOnError=false) — no "emitting original text"
    // suffix in the error message.
    expect(message).toContain(
      "Could not complete streaming JSON tool call at finish"
    );
    expect(message).not.toContain("emitting original text");
    // Full metadata shape: toolCall + toolCallId + toolName + dropReason all populated.
    expect(metadata).toMatchObject({
      toolName: "bash",
      dropReason: "unfinished-tool-call",
    });
    expect(typeof metadata.toolCallId).toBe("string");
    expect(typeof metadata.toolCall).toBe("string");
    expect(metadata.toolCall).toContain("<tool_call>");
    expect(metadata.toolCall).toContain('"name":"bash"');
  });

  it("emits the raw tool-call text and flags message when emitRawToolCallTextOnError is true", async () => {
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
          delta: '<tool_call>{"name":"bash","arguments":{"command":"ls"',
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

    expect(onError).toHaveBeenCalledTimes(1);
    const [message, metadata] = onError.mock.calls[0];
    // emitRawToolCallTextOnError=true path — message notes the raw emission.
    expect(message).toContain("emitting original text");
    // metadata shape still includes toolCallId, toolName, and dropReason.
    expect(metadata).toMatchObject({
      toolName: "bash",
      dropReason: "unfinished-tool-call",
    });
    expect(typeof metadata.toolCallId).toBe("string");
    expect(metadata.toolCall).toContain('"name":"bash"');

    // The raw text should also appear in the output stream.
    const textOutput = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    expect(textOutput).toContain("<tool_call>");
  });

  it("passes truncated toolName in onError when name value is cut mid-string", async () => {
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
          delta: '<tool_call>{"name":"ba',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    await convertReadableStreamToArray(pipeWithTransformer(rs, transformer));
    expect(onError).toHaveBeenCalledTimes(1);
    const [, metadata] = onError.mock.calls[0];
    // extractTopLevelStringProperty requires closing quote, so truncated name returns undefined
    expect(metadata.toolName).toBeUndefined();
    expect(metadata.dropReason).toBe("unfinished-tool-call");
    expect(metadata.toolCallId).toBeUndefined();
  });

  it("passes undefined toolName in onError when only arguments are present", async () => {
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
          delta: '<tool_call>{"arguments":{"command":"ls"}',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    await convertReadableStreamToArray(pipeWithTransformer(rs, transformer));
    expect(onError).toHaveBeenCalledTimes(1);
    const [, metadata] = onError.mock.calls[0];
    expect(metadata.toolName).toBeUndefined();
    expect(metadata.dropReason).toBe("unfinished-tool-call");
    expect(metadata.toolCallId).toBeUndefined();
  });

  it("passes undefined toolName in onError when name is not parseable", async () => {
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
          delta: "<tool_call>{broken",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    await convertReadableStreamToArray(pipeWithTransformer(rs, transformer));
    expect(onError).toHaveBeenCalledTimes(1);
    const [, metadata] = onError.mock.calls[0];
    expect(metadata.toolName).toBeUndefined();
    expect(metadata.dropReason).toBe("unfinished-tool-call");
    expect(metadata.toolCallId).toBeUndefined();
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

  it("passes toolName, toolCallId, and malformed-tool-call-body dropReason in onError when a complete tool_call block has invalid JSON body", async () => {
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
          delta:
            '<tool_call>{"name":"bash","arguments": not valid json here}</tool_call>',
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    await convertReadableStreamToArray(pipeWithTransformer(rs, transformer));
    expect(onError).toHaveBeenCalledTimes(1);
    const [message, metadata] = onError.mock.calls[0];
    expect(message).toContain("Could not process streaming JSON tool call");
    expect(message).not.toContain("emitting original text");
    expect(metadata).toMatchObject({
      toolName: "bash",
      dropReason: "malformed-tool-call-body",
    });
    expect(typeof metadata.toolCall).toBe("string");
    expect(metadata.toolCall).toContain("<tool_call>");
    expect(metadata.toolCall).toContain("</tool_call>");
  });

  it("emits the raw tool-call text and keeps structured metadata when emitRawToolCallTextOnError is true and JSON body is invalid", async () => {
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
          delta:
            '<tool_call>{"name":"bash","arguments": not valid json here}</tool_call>',
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
    expect(onError).toHaveBeenCalledTimes(1);
    const [message, metadata] = onError.mock.calls[0];
    expect(message).toContain("emitting original text");
    expect(metadata).toMatchObject({
      toolName: "bash",
      dropReason: "malformed-tool-call-body",
    });
    const textOutput = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    expect(textOutput).toContain("<tool_call>");
    expect(textOutput).toContain("</tool_call>");
  });

  it("does not attempt to recover JSON with unescaped double quotes in string values (#298 proposal-2 is NOT implemented)", async () => {
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
          delta:
            '<tool_call>{"name":"edit","arguments":{"content":"He said "hello" to me"}}</tool_call>',
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
    expect(out.some((c) => c.type === "tool-call")).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    const [, metadata] = onError.mock.calls[0];
    expect(metadata.dropReason).toBe("malformed-tool-call-body");
  });
});
