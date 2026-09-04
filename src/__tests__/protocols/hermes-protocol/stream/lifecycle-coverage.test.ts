import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  closeTextBlock,
  closeToolInput,
  emitToolCallFromParsed,
  flushBuffer,
  handleFinishChunk,
  recoverCompleteCallArrayBeforePartialEnd,
  scheduleStreamingToolInputProgress,
} from "../../../../core/protocols/hermes-stream-lifecycle";
import type { StreamState } from "../../../../core/protocols/hermes-streaming-progress";
import type { ParserOptions } from "../../../../core/protocols/protocol-interface";
import {
  createChunkedStream,
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

type ToolCallPart = Extract<LanguageModelV4StreamPart, { type: "tool-call" }>;

type OnError = NonNullable<ParserOptions["onError"]>;

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "lookup",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
    },
  },
];

const rejectingTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "reject",
  inputSchema: false as never,
};

const newState = (): StreamState => ({
  activeToolInput: null,
  buffer: "",
  currentTextId: null,
  currentToolCallJson: "",
  hasDeferredToolCallScan: false,
  hasEmittedTextStart: false,
  isInsideToolCall: false,
  pendingToolInputProgressVersion: 0,
  toolCallScanCarry: "",
  toolCallScanDeferUntilLength: null,
});

async function stream(
  text: string,
  options?: ParserOptions
): Promise<LanguageModelV4StreamPart[]> {
  return await convertReadableStreamToArray(
    pipeWithTransformer(
      createChunkedStream(text),
      hermesProtocol().createStreamParser({ tools, options })
    )
  );
}

async function withController(
  action: (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
  ) => void
): Promise<LanguageModelV4StreamPart[]> {
  const transformer = new TransformStream<
    LanguageModelV4StreamPart,
    LanguageModelV4StreamPart
  >({
    transform(_chunk, controller) {
      action(controller);
    },
  });
  return await convertReadableStreamToArray(
    pipeWithTransformer(
      new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({
            type: "finish",
            finishReason: stopFinishReason,
            usage: zeroUsage,
          });
          controller.close();
        },
      }),
      transformer
    )
  );
}

describe("Hermes stream lifecycle coverage", () => {
  it("emits a parsed call with an empty argument body", async () => {
    const state = newState();
    const parts = await withController((controller) => {
      emitToolCallFromParsed(
        state,
        controller,
        { name: "lookup", arguments: undefined },
        tools
      );
    });

    expect(parts.filter((part) => part.type === "tool-call")).toMatchObject([
      { type: "tool-call", toolName: "lookup", input: "{}" },
    ]);
    expect(state.activeToolInput).toBeNull();
  });

  it("flushes markdown text and closes its text block at finish", async () => {
    const output = await stream("**ready**");
    const text = output
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("");

    expect(text).toBe("**ready**");
    expect(output.filter((part) => part.type === "text-end")).toHaveLength(1);
  });

  it("handles an empty tool-call body without emitting a call", async () => {
    const onError = vi.fn<OnError>();
    const output = await stream("<tool_call></tool_call>", { onError });

    expect(output.some((part) => part.type === "tool-call")).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it("reports malformed JSON and preserves raw text only when requested", async () => {
    const onError = vi.fn<OnError>();
    const output = await stream("<tool_call>{oops}</tool_call>", {
      onError,
      emitRawToolCallTextOnError: true,
    });

    expect(
      output
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("")
    ).toBe("<tool_call>{oops}</tool_call>");
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("Could not process streaming JSON tool call"),
      expect.objectContaining({ dropReason: "malformed-tool-call-body" })
    );
  });

  it("covers progress rejection, parsing, policy, and resolver outcomes", async () => {
    vi.useFakeTimers();
    try {
      const cases = [
        '{"name":"lookup"}',
        '{"name":"lookup","arguments":{"query":"x"}}',
        '{"name":"lookup","arguments":{"__proto__":{"x":1}}}',
        '{"name":"lookup","arguments":{"query":"\\q"}}',
        '{"name":"lookup","arguments":undefined}',
        '{"name":"lookup","arguments":{"query":}}',
        '{"name":"reject","arguments":{}}',
        `{"name":"lookup","arguments":${"[".repeat(257)}1${"]".repeat(257)}}`,
      ];
      for (const toolCallJson of cases) {
        const state = newState();
        state.isInsideToolCall = true;
        state.currentToolCallJson = toolCallJson;
        const progressTools = toolCallJson.includes("__proto__") ? tools : [];
        if (toolCallJson.includes('"name":"reject"')) {
          progressTools.push(rejectingTool);
        }
        await withController((controller) => {
          scheduleStreamingToolInputProgress({
            state,
            controller,
            toolCallJson,
            tools: progressTools,
          });
          vi.runAllTimers();
        });
      }

      const state = newState();
      state.isInsideToolCall = true;
      state.currentToolCallJson = '{"name":"lookup","arguments":{"query":"x"}}';
      const parts = await withController((controller) => {
        scheduleStreamingToolInputProgress({
          state,
          controller,
          toolCallJson: state.currentToolCallJson,
          tools,
          resolveToolCall: () => ({
            ok: false,
            error: new Error("rejected"),
          }),
        });
        vi.runAllTimers();
      });
      expect(parts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles trailing unfinished text without a current JSON body", async () => {
    const state = newState();
    state.isInsideToolCall = true;
    state.buffer = "unfinished";
    const parts = await withController((controller) => {
      handleFinishChunk(
        state,
        controller,
        "<tool_call>",
        "</tool_call>",
        tools,
        undefined,
        { type: "finish", finishReason: stopFinishReason, usage: zeroUsage }
      );
    });

    expect(parts.at(-1)?.type).toBe("finish");
    expect(state.isInsideToolCall).toBe(false);
  });

  it("handles an empty unfinished body and still emits the final event", async () => {
    const state = newState();
    state.isInsideToolCall = true;
    const parts = await withController((controller) => {
      handleFinishChunk(
        state,
        controller,
        "<tool_call>",
        "</tool_call>",
        tools,
        undefined,
        { type: "finish", finishReason: stopFinishReason, usage: zeroUsage }
      );
    });

    expect(parts).toEqual([
      { type: "finish", finishReason: stopFinishReason, usage: zeroUsage },
    ]);
    expect(state.isInsideToolCall).toBe(false);
  });

  it("ignores stale scheduled progress after the call advances", async () => {
    vi.useFakeTimers();
    try {
      const state = newState();
      state.isInsideToolCall = true;
      state.currentToolCallJson =
        '{"name":"lookup","arguments":{"query":"old"}}';
      const parts = await withController((controller) => {
        scheduleStreamingToolInputProgress({
          state,
          controller,
          toolCallJson: '{"name":"lookup","arguments":{"query":"old"}}',
          tools,
        });
        state.currentToolCallJson =
          '{"name":"lookup","arguments":{"query":"new"}}';
        vi.runAllTimers();
      });

      expect(parts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not close absent input or text blocks", async () => {
    const state = newState();
    const parts = await withController((controller) => {
      closeToolInput(state, controller);
      closeTextBlock(state, controller);
    });

    expect(parts).toHaveLength(0);
  });

  it("closes an active input and an already-started text block", async () => {
    const state = newState();
    state.activeToolInput = {
      id: "tool-id",
      toolName: "lookup",
      emittedInput: "{}",
    };
    state.currentTextId = "text-id";
    state.hasEmittedTextStart = true;
    const parts = await withController((controller) => {
      closeToolInput(state, controller);
      closeTextBlock(state, controller);
    });

    expect(parts).toEqual([
      { type: "tool-input-end", id: "tool-id" },
      { type: "text-end", id: "text-id" },
    ]);
    expect(state.activeToolInput).toBeNull();
    expect(state.currentTextId).toBeNull();
  });

  it("rejects arrays containing a non-call item", () => {
    const result = recoverCompleteCallArrayBeforePartialEnd(
      '[1, {"name":"lookup","arguments":{}}]</tool',
      "</tool_call>",
      tools
    );

    expect(result).toEqual({ matchedArrayShape: true, recoveredCalls: null });
  });

  it("flushes an existing text block without creating a second start", async () => {
    const state = newState();
    state.buffer = "tail";
    state.currentTextId = "text-id";
    state.hasEmittedTextStart = true;
    const parts = await withController((controller) => {
      flushBuffer(state, controller);
      flushBuffer(state, controller);
    });

    expect(parts).toEqual([
      { type: "text-delta", id: "text-id", delta: "tail" },
    ]);
    expect(state.buffer).toBe("");
  });

  it("starts a text block when flushing without an existing id", async () => {
    const state = newState();
    state.buffer = "head";
    const parts = await withController((controller) => {
      flushBuffer(state, controller);
    });

    expect(parts).toHaveLength(2);
    expect(parts[0]?.type).toBe("text-start");
    expect(parts[1]).toMatchObject({ type: "text-delta", delta: "head" });
  });

  it("uses the active name when a parsed name is not a string", async () => {
    const parsed = { name: 7, arguments: {} };
    const state = newState();
    state.activeToolInput = {
      id: "existing-id",
      toolName: "lookup",
      emittedInput: "{}",
    };
    const parts = await withController((controller) => {
      Reflect.apply(emitToolCallFromParsed, undefined, [
        state,
        controller,
        parsed,
        tools,
      ]);
      Reflect.apply(emitToolCallFromParsed, undefined, [
        newState(),
        controller,
        parsed,
        tools,
      ]);
    });

    const calls = parts.filter((part) => part.type === "tool-call");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ type: "tool-call", toolName: "lookup" });
    expect(calls[1]).toMatchObject({ type: "tool-call", toolName: "unknown" });
  });

  it("uses fallback ids when input initialization cannot persist", async () => {
    const state = new Proxy(newState(), {
      set(target, property, value) {
        if (property === "activeToolInput") {
          return true;
        }
        return Reflect.set(target, property, value);
      },
    }) as StreamState;
    const parts = await withController((controller) => {
      emitToolCallFromParsed(
        state,
        controller,
        { name: "lookup", arguments: {} },
        tools
      );
    });

    expect(parts.at(-1)?.type).toBe("tool-call");
  });

  it("emits the final event after recovering a complete unterminated call", async () => {
    const output = await stream(
      '<tool_call>{"name":"lookup","arguments":{"query":"x"}}'
    );
    const calls = output.filter(
      (part) => part.type === "tool-call"
    ) as ToolCallPart[];

    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("lookup");
    expect(output.at(-1)?.type).toBe("finish");
  });
});
