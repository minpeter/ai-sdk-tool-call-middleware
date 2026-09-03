import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
  handlePartialTag,
  processBufferTags,
} from "./hermes-stream-buffer-processing";
import { handleFinishChunk } from "./hermes-stream-lifecycle";
import type {
  StreamState,
  TagProcessingContext,
} from "./hermes-streaming-progress";
import type {
  ParserOptions,
  ProtocolToolCallResolver,
} from "./protocol-interface";

// While a large tool-call JSON body streams in, every chunk used to rescan
// the whole accumulated content (RJSON-aware boundary scan over
// currentToolCallJson + buffer from position 0, plus streaming-progress
// recomputation) — O(total) per chunk and quadratic overall. Once the
// combined length exceeds SCAN_DEFER_MIN_LENGTH, scans are amortized: they
// only run after ~1/8 growth, capped at SCAN_DEFER_MAX_INTERVAL so
// tool-input progress keeps a steady ~1KB cadence for the UI. Total scan
// work stays bounded (O(n^2/1024), negligible at realistic sizes). Deferral
// only delays observing a pending close tag (the carry-based tag trigger
// catches arriving tags in the same chunk); a catch-up scan runs before
// finish reconciliation, so final outputs are unchanged. Below the
// threshold, behavior is byte-identical.
const SCAN_DEFER_MIN_LENGTH = 4096;
const SCAN_DEFER_MAX_INTERVAL = 1024;

function shouldDeferToolCallScan(
  state: StreamState,
  appended: string,
  toolCallStart: string,
  toolCallEnd: string
): boolean {
  if (!state.isInsideToolCall) {
    return false;
  }
  const length = state.currentToolCallJson.length + state.buffer.length;
  if (length <= SCAN_DEFER_MIN_LENGTH) {
    return false;
  }
  if (
    state.toolCallScanDeferUntilLength === null ||
    length >= state.toolCallScanDeferUntilLength
  ) {
    return false;
  }
  // Cheap boundary-tag trigger: a close (or nested start) tag arriving in
  // the appended region forces an immediate full scan so tool-call
  // completion is observed in the same chunk, exactly like the undeferred
  // path. The carry covers tags split across chunk boundaries. A tag inside
  // a JSON string is a false positive; the full scan then simply finds no
  // boundary and deferral resumes.
  const region = state.toolCallScanCarry + appended;
  if (region.includes(toolCallEnd) || region.includes(toolCallStart)) {
    return false;
  }
  const carryLength = Math.max(toolCallStart.length, toolCallEnd.length) - 1;
  state.toolCallScanCarry = region.slice(-carryLength);
  return true;
}

function scheduleNextToolCallScan(
  state: StreamState,
  toolCallStart: string,
  toolCallEnd: string
) {
  if (!state.isInsideToolCall) {
    state.toolCallScanDeferUntilLength = null;
    state.toolCallScanCarry = "";
    return;
  }
  const length = state.currentToolCallJson.length + state.buffer.length;
  state.toolCallScanDeferUntilLength =
    length +
    Math.max(512, Math.min(SCAN_DEFER_MAX_INTERVAL, Math.floor(length / 8)));
  // After a scan pass the buffer holds at most a small partial-tag tail;
  // seed the carry from it so tags completing right after a scan are caught.
  const carryLength = Math.max(toolCallStart.length, toolCallEnd.length) - 1;
  state.toolCallScanCarry = state.buffer.slice(-carryLength);
}

function runDeferredToolCallScanCatchUp(context: TagProcessingContext) {
  const {
    state,
    controller,
    toolCallStart,
    toolCallEnd,
    tools,
    resolveToolCall: toolCallResolver,
  } = context;
  state.hasDeferredToolCallScan = false;
  processBufferTags(context);
  if (state.isInsideToolCall) {
    handlePartialTag(
      state,
      controller,
      toolCallStart,
      toolCallEnd,
      tools,
      toolCallResolver
    );
  }
}

export function createHermesStreamParser({
  tools,
  options,
  toolCallStart,
  toolCallEnd,
  toolCallResolver,
}: {
  tools: LanguageModelV4FunctionTool[];
  options?: ParserOptions;
  toolCallStart: string;
  toolCallEnd: string;
  toolCallResolver: ProtocolToolCallResolver;
}) {
  const state: StreamState = {
    isInsideToolCall: false,
    buffer: "",
    currentToolCallJson: "",
    currentTextId: null,
    hasDeferredToolCallScan: false,
    hasEmittedTextStart: false,
    activeToolInput: null,
    pendingToolInputProgressVersion: 0,
    toolCallScanCarry: "",
    toolCallScanDeferUntilLength: null,
  };

  return new TransformStream<
    LanguageModelV4StreamPart,
    LanguageModelV4StreamPart
  >({
    transform(chunk, controller) {
      if (chunk.type === "finish") {
        // A deferred boundary scan may hold a complete close tag (plus
        // trailing content) in the buffer; catch up first so finish
        // reconciliation sees exactly what the live path would have seen.
        if (state.isInsideToolCall && state.hasDeferredToolCallScan) {
          runDeferredToolCallScanCatchUp({
            state,
            controller,
            toolCallStart,
            toolCallEnd,
            options,
            tools,
            resolveToolCall: toolCallResolver,
          });
        }
        handleFinishChunk(
          state,
          controller,
          toolCallStart,
          toolCallEnd,
          tools,
          options,
          chunk,
          toolCallResolver
        );
        return;
      }

      // The parser re-segments text under its own synthetic ids (tool-call
      // markup is excised), so the provider's original text-start/text-end
      // envelopes are dropped instead of producing empty duplicate blocks.
      if (chunk.type === "text-start" || chunk.type === "text-end") {
        return;
      }

      if (chunk.type !== "text-delta") {
        controller.enqueue(chunk);
        return;
      }

      const textContent = (chunk as { delta?: string }).delta ?? "";
      state.buffer += textContent;
      if (
        shouldDeferToolCallScan(state, textContent, toolCallStart, toolCallEnd)
      ) {
        state.hasDeferredToolCallScan = true;
        return;
      }
      state.hasDeferredToolCallScan = false;
      processBufferTags({
        state,
        controller,
        toolCallStart,
        toolCallEnd,
        options,
        tools,
        resolveToolCall: toolCallResolver,
      });
      handlePartialTag(
        state,
        controller,
        toolCallStart,
        toolCallEnd,
        tools,
        toolCallResolver
      );
      scheduleNextToolCallScan(state, toolCallStart, toolCallEnd);
    },
  });
}
