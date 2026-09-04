import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ai-sdk/provider", async (importOriginal) => {
  const provider = await importOriginal<typeof import("@ai-sdk/provider")>();
  return { ...provider, isJSONValue: () => false };
});

import { scheduleStreamingToolInputProgress } from "../../../../core/protocols/hermes-stream-lifecycle";
import type { StreamState } from "../../../../core/protocols/hermes-streaming-progress";
import { stopFinishReason, zeroUsage } from "../../../test-helpers";

const tool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "lookup",
  inputSchema: { type: "object" },
};

const state: StreamState = {
  activeToolInput: null,
  buffer: "",
  currentTextId: null,
  currentToolCallJson: '{"name":"lookup","arguments":{"query":"x"}}',
  hasDeferredToolCallScan: false,
  hasEmittedTextStart: false,
  isInsideToolCall: true,
  pendingToolInputProgressVersion: 0,
  toolCallScanCarry: "",
  toolCallScanDeferUntilLength: null,
};

describe("Hermes streaming parsed-shape guard", () => {
  it("rejects a parsed value that is not a provider JSON value", async () => {
    vi.useFakeTimers();
    try {
      const output = new TransformStream<
        LanguageModelV4StreamPart,
        LanguageModelV4StreamPart
      >({
        transform(_chunk, controller) {
          scheduleStreamingToolInputProgress({
            state,
            controller,
            toolCallJson: state.currentToolCallJson,
            tools: [tool],
          });
          vi.runAllTimers();
        },
      });
      const parts = await convertReadableStreamToArray(
        new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({
              type: "finish",
              finishReason: stopFinishReason,
              usage: zeroUsage,
            });
            controller.close();
          },
        }).pipeThrough(output)
      );

      expect(parts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
