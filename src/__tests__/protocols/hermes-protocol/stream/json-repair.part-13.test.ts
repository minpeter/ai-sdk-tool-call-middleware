import type {
  JSONValue,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

// Intentionally accepts malformed schemas so tests can exercise runtime rejection.
function makeSchemaTool(
  name: string,
  inputSchema: JSONValue
): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    inputSchema: inputSchema as LanguageModelV4FunctionTool["inputSchema"],
  };
}

function hasStringToolCallId(
  value: JSONValue
): value is { readonly toolCallId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "toolCallId" in value &&
    typeof value.toolCallId === "string"
  );
}

describe("json-repair.test split 13", () => {
  it("drops unsafe false patternProperties that may match key substrings", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "(secret+)+": false,
        },
        additionalProperties: true,
      }),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"content":"ok","x-secret":"blocked"}}</tool_call>',
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
    const tool = out.find((c) => c.type === "tool-call");
    expect(tool).toBeTruthy();
    expect(tool?.type === "tool-call" ? JSON.parse(tool.input) : null).toEqual({
      content: "ok",
    });
    expect(out.some((c) => c.type === "tool-input-start")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops unsafe false patternProperties that may match unanchored suffixes", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "(a+)+$": false,
        },
        additionalProperties: true,
      }),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"content":"ok","ba":"blocked"}}</tool_call>',
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
    const tool = out.find((c) => c.type === "tool-call");
    expect(tool).toBeTruthy();
    expect(tool?.type === "tool-call" ? JSON.parse(tool.input) : null).toEqual({
      content: "ok",
    });
    expect(out.some((c) => c.type === "tool-input-start")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not emit stale speculative tool-calls after later invalid chunks", async () => {
    const onError = vi.fn();
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { onError },
    });
    const input = new TransformStream<
      LanguageModelV4StreamPart,
      LanguageModelV4StreamPart
    >();
    const out: LanguageModelV4StreamPart[] = [];
    let resolveInputStart!: () => void;
    const inputStartObserved = new Promise<void>((resolve) => {
      resolveInputStart = resolve;
    });
    const done = input.readable.pipeThrough(transformer).pipeTo(
      new WritableStream<LanguageModelV4StreamPart>({
        write(part) {
          out.push(part);
          if (part.type === "tool-input-start") {
            resolveInputStart();
          }
        },
      })
    );
    const writer = input.writable.getWriter();

    await writer.write({
      type: "text-delta",
      id: "1",
      delta: '<tool_call>{"name":"edit","arguments":{"content":"ok"}}',
    });
    await inputStartObserved;
    await writer.write({
      type: "text-delta",
      id: "1",
      delta: ',"dangling":</tool_call>',
    });
    await writer.write({
      type: "finish",
      finishReason: stopFinishReason,
      usage: zeroUsage,
    });
    await writer.close();
    await done;

    const start = out.find((c) => c.type === "tool-input-start");
    expect(out.find((c) => c.type === "tool-call")).toBeUndefined();
    expect(start).toBeTruthy();
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(true);
    expect(onError).toHaveBeenCalled();
    const metadata = onError.mock.calls[0]?.[1];
    expect(hasStringToolCallId(metadata)).toBe(true);
    if (!hasStringToolCallId(metadata)) {
      throw new Error("Expected onError metadata with a toolCallId");
    }
    expect(metadata.toolCallId).toBe(
      start?.type === "tool-input-start" ? start.id : undefined
    );
  });

  it("drops keys that may match unsafe false patterns with escaped range endpoints", async () => {
    const onError = vi.fn();
    const tools = [
      makeSchemaTool("write", {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        patternProperties: {
          "^([a-\\x7a]+)+$": false,
        },
        additionalProperties: true,
      }),
    ];
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"write","arguments":{"content":"ok","m":"blocked"}}</tool_call>',
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
    const tool = out.find((c) => c.type === "tool-call");
    expect(tool).toBeTruthy();
    expect(tool?.type === "tool-call" ? JSON.parse(tool.input) : null).toEqual({
      content: "ok",
    });
    expect(out.some((c) => c.type === "tool-input-start")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-delta")).toBe(true);
    expect(out.some((c) => c.type === "tool-input-end")).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });
});
