import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import {
  emitFailedToolInputLifecycle,
  emitFinalizedToolInputLifecycle,
  emitToolInputProgressDelta,
  enqueueToolInputEnd,
  enqueueToolInputEndAndCall,
  shouldEmitRawToolCallTextOnError,
  stringifyToolInputWithSchema,
} from "../../../core/utils/tool-input-streaming";

function createMockController(
  out: LanguageModelV3StreamPart[]
): TransformStreamDefaultController<LanguageModelV3StreamPart> {
  return {
    enqueue(part: LanguageModelV3StreamPart) {
      out.push(part);
    },
  } as unknown as TransformStreamDefaultController<LanguageModelV3StreamPart>;
}

describe("tool-input-streaming", () => {
  it("stringifyToolInputWithSchema returns coerced JSON when schema coercion succeeds", () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "calc",
        inputSchema: {
          type: "object",
          properties: {
            count: { type: "number" },
            active: { type: "boolean" },
          },
        },
      },
    ];

    const result = stringifyToolInputWithSchema({
      toolName: "calc",
      args: '{"count":"10","active":"true"}',
      tools,
      fallback: () => "fallback-should-not-be-used",
    });

    expect(result).toBe('{"count":10,"active":true}');
  });

  it("stringifyToolInputWithSchema falls back when coercion fails", () => {
    const fallback = vi.fn(() => "fallback");

    const result = stringifyToolInputWithSchema({
      toolName: "calc",
      args: "{",
      tools: [],
      fallback,
    });

    expect(result).toBe("fallback");
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("emitToolInputProgressDelta emits incomplete-json-prefix deltas by default", () => {
    const out: LanguageModelV3StreamPart[] = [];
    const controller = createMockController(out);
    const state = { emittedInput: "" };

    emitToolInputProgressDelta({
      controller,
      id: "tool-1",
      state,
      fullInput: '{"city":"Seoul"}',
    });

    const deltas = out.filter(
      (
        part
      ): part is Extract<
        LanguageModelV3StreamPart,
        { type: "tool-input-delta" }
      > => part.type === "tool-input-delta"
    );

    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta).toBe('{"city":"Seoul');
    expect(state.emittedInput).toBe('{"city":"Seoul');
  });

  it("emitToolInputProgressDelta emits full-json deltas in full-json mode", () => {
    const out: LanguageModelV3StreamPart[] = [];
    const controller = createMockController(out);
    const state = { emittedInput: "" };

    emitToolInputProgressDelta({
      controller,
      id: "tool-2",
      state,
      fullInput: '{"city":"Seoul"}',
      mode: "full-json",
    });

    const deltas = out.filter(
      (
        part
      ): part is Extract<
        LanguageModelV3StreamPart,
        { type: "tool-input-delta" }
      > => part.type === "tool-input-delta"
    );

    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta).toBe('{"city":"Seoul"}');
    expect(state.emittedInput).toBe('{"city":"Seoul"}');
  });

  it("emitFinalizedToolInputLifecycle emits final remainder then end and call", () => {
    const out: LanguageModelV3StreamPart[] = [];
    const controller = createMockController(out);
    const state = { emittedInput: '{"city":"Seoul' };

    emitFinalizedToolInputLifecycle({
      controller,
      id: "tool-3",
      state,
      toolName: "weather",
      finalInput: '{"city":"Seoul","unit":"celsius"}',
    });

    expect(out).toEqual([
      {
        type: "tool-input-delta",
        id: "tool-3",
        delta: '","unit":"celsius"}',
      },
      {
        type: "tool-input-end",
        id: "tool-3",
      },
      {
        type: "tool-call",
        toolCallId: "tool-3",
        toolName: "weather",
        input: '{"city":"Seoul","unit":"celsius"}',
      },
    ]);
  });

  it("enqueueToolInputEndAndCall enqueues end and call in order", () => {
    const out: LanguageModelV3StreamPart[] = [];
    const controller = createMockController(out);

    enqueueToolInputEndAndCall({
      controller,
      id: "tool-4",
      toolName: "search",
      input: '{"query":"hello"}',
    });

    expect(out).toEqual([
      {
        type: "tool-input-end",
        id: "tool-4",
      },
      {
        type: "tool-call",
        toolCallId: "tool-4",
        toolName: "search",
        input: '{"query":"hello"}',
      },
    ]);
  });

  it("enqueueToolInputEnd enqueues only tool-input-end", () => {
    const out: LanguageModelV3StreamPart[] = [];
    const controller = createMockController(out);

    enqueueToolInputEnd({
      controller,
      id: "tool-5",
    });

    expect(out).toEqual([
      {
        type: "tool-input-end",
        id: "tool-5",
      },
    ]);
  });

  it("emitFailedToolInputLifecycle emits end and raw fallback when enabled", () => {
    const out: LanguageModelV3StreamPart[] = [];
    const controller = createMockController(out);
    const emitRawText = vi.fn();

    emitFailedToolInputLifecycle({
      controller,
      id: "tool-6",
      emitRawToolCallTextOnError: true,
      rawToolCallText: "<tool_call>broken",
      emitRawText,
    });

    expect(out).toEqual([
      {
        type: "tool-input-end",
        id: "tool-6",
      },
    ]);
    expect(emitRawText).toHaveBeenCalledTimes(1);
    expect(emitRawText).toHaveBeenCalledWith("<tool_call>broken");
  });

  it("emitFailedToolInputLifecycle skips end and raw fallback when configured", () => {
    const out: LanguageModelV3StreamPart[] = [];
    const controller = createMockController(out);
    const emitRawText = vi.fn();

    emitFailedToolInputLifecycle({
      controller,
      id: "tool-7",
      endInput: false,
      emitRawToolCallTextOnError: false,
      rawToolCallText: "<tool_call>broken",
      emitRawText,
    });

    expect(out).toEqual([]);
    expect(emitRawText).not.toHaveBeenCalled();
  });

  it("shouldEmitRawToolCallTextOnError returns true only when explicitly enabled", () => {
    expect(shouldEmitRawToolCallTextOnError()).toBe(false);
    expect(shouldEmitRawToolCallTextOnError({})).toBe(false);
    expect(
      shouldEmitRawToolCallTextOnError({ emitRawToolCallTextOnError: false })
    ).toBe(false);
    expect(
      shouldEmitRawToolCallTextOnError({ emitRawToolCallTextOnError: true })
    ).toBe(true);
  });
});
