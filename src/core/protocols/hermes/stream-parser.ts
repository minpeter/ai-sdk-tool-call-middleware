import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { logParseFailure } from "../../utils/diagnostics/debug";
import { getPotentialStartIndex } from "../../utils/primitives/get-potential-start-index";
import { generateId, generateToolCallId } from "../../utils/primitives/id";
import {
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../../utils/primitives/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../../utils/security/prototype-sensitive-keys";
import { shouldEmitRawToolCallTextOnError } from "../../utils/streaming/tool-input-streaming";
import type {
  ParserOptions,
  ProtocolToolCallResolver,
} from "../protocol-interface";
import { isArgumentKeyPolicyError } from "./argument-key-policy";
import { findToolCallBoundaryOutsideRjsonSyntax } from "./call-boundary";
import { recoverKnownToolCallsFromText } from "./call-parsing";
import {
  closeTextBlock,
  closeToolInput,
  emitResolvedToolCall,
  handleFinishChunk,
  recoverCompleteKnownCallBeforeNestedStart,
  scheduleStreamingToolInputProgress,
} from "./stream-lifecycle";
import {
  extractStreamingToolCallProgress,
  type StreamController,
  type StreamState,
  type TagProcessingContext,
} from "./streaming-progress";

function publishText(
  text: string,
  state: StreamState,
  controller: StreamController
) {
  if (state.isInsideToolCall) {
    closeTextBlock(state, controller);
    state.currentToolCallJson += text;
  } else if (text.length > 0) {
    if (!state.currentTextId) {
      state.currentTextId = generateId();
      controller.enqueue({
        type: "text-start",
        id: state.currentTextId,
      } as LanguageModelV4StreamPart);
      state.hasEmittedTextStart = true;
    }
    controller.enqueue({
      type: "text-delta",
      id: state.currentTextId,
      delta: text,
    } as LanguageModelV4StreamPart);
  }
}

function emitToolCall(context: TagProcessingContext) {
  const { state, controller, toolCallStart, toolCallEnd, options, tools } =
    context;
  const resolved = context.resolveToolCall(state.currentToolCallJson, tools);
  if (resolved.ok) {
    // Mirror the original emit order: close any open text block before
    // streaming the tool-input lifecycle (was inside emitToolCallFromParsed).
    closeTextBlock(state, controller);
    emitResolvedToolCall(state, controller, resolved.toolName, resolved.input);
    return;
  }

  if (!isArgumentKeyPolicyError(resolved.error)) {
    const salvagedCalls = recoverKnownToolCallsFromText(
      state.currentToolCallJson,
      tools
    );
    if (salvagedCalls && salvagedCalls.length > 0) {
      closeTextBlock(state, controller);
      for (const salvagedCall of salvagedCalls) {
        emitResolvedToolCall(
          state,
          controller,
          salvagedCall.toolName,
          salvagedCall.input
        );
      }
      return;
    }
  }

  const finalError = resolved.error;
  const activeToolCallId = state.activeToolInput?.id;
  const activeToolName = state.activeToolInput?.toolName;

  const errorContent = `${toolCallStart}${state.currentToolCallJson}${toolCallEnd}`;
  const shouldEmitRawFallback = shouldEmitRawToolCallTextOnError(options);
  const streamingToolCallId = activeToolCallId ?? generateToolCallId();
  const streamingToolName =
    activeToolName ??
    extractStreamingToolCallProgress(state.currentToolCallJson).toolName;

  logParseFailure({
    phase: "stream",
    reason: "Failed to parse streaming tool call JSON segment",
    snippet: errorContent,
    error: finalError,
  });
  if (
    shouldEmitRawFallback &&
    !toolCallTextHasPrototypeSensitiveKey(errorContent)
  ) {
    const errorId = generateId();
    controller.enqueue({
      type: "text-start",
      id: errorId,
    } as LanguageModelV4StreamPart);
    controller.enqueue({
      type: "text-delta",
      id: errorId,
      delta: errorContent,
    } as LanguageModelV4StreamPart);
    controller.enqueue({
      type: "text-end",
      id: errorId,
    } as LanguageModelV4StreamPart);
  }
  closeToolInput(state, controller);
  options?.onError?.(
    shouldEmitRawFallback
      ? "Could not process streaming JSON tool call; emitting original text."
      : "Could not process streaming JSON tool call.",
    {
      toolCall: safeToolCallMetadataText(errorContent),
      error: safeToolCallMetadataError(finalError, errorContent),
      toolCallId: streamingToolCallId,
      toolName: streamingToolName,
      dropReason: "malformed-tool-call-body",
    }
  );
}

function processTagMatch(context: TagProcessingContext) {
  const { state } = context;
  if (state.isInsideToolCall) {
    emitToolCall(context);
    state.currentToolCallJson = "";
    state.isInsideToolCall = false;
  } else {
    state.currentToolCallJson = "";
    state.isInsideToolCall = true;
    state.activeToolInput = null;
  }
}

function recoverNestedStreamingToolCall(options: {
  context: TagProcessingContext;
  jsonSoFar: string;
  nestedStartIndex: number;
  startIndex: number;
  tag: string;
}): number | null {
  const { context, jsonSoFar, nestedStartIndex, startIndex, tag } = options;
  const {
    state,
    controller,
    toolCallStart,
    toolCallEnd,
    options: parserOptions,
  } = context;
  const droppedToolCall = `${toolCallStart}${jsonSoFar.slice(
    0,
    nestedStartIndex
  )}`;
  const shouldEmitRawFallback = shouldEmitRawToolCallTextOnError(parserOptions);
  const streamingToolCallId = state.activeToolInput?.id;
  const streamingToolName =
    state.activeToolInput?.toolName ??
    extractStreamingToolCallProgress(jsonSoFar.slice(0, nestedStartIndex))
      .toolName;

  const recoveredCall = recoverCompleteKnownCallBeforeNestedStart(
    jsonSoFar.slice(0, nestedStartIndex),
    context.tools,
    context.resolveToolCall
  );
  if (recoveredCall) {
    closeTextBlock(state, controller);
    emitResolvedToolCall(
      state,
      controller,
      recoveredCall.toolName,
      recoveredCall.input
    );
    state.currentToolCallJson = "";
    state.isInsideToolCall = false;
    state.buffer =
      jsonSoFar.slice(nestedStartIndex) +
      toolCallEnd +
      state.buffer.slice(startIndex + tag.length);
    return getPotentialStartIndex(state.buffer, toolCallStart);
  }

  logParseFailure({
    phase: "stream",
    reason: "Abandoning malformed streaming tool call before nested start tag",
    snippet: droppedToolCall,
  });
  if (
    shouldEmitRawFallback &&
    !toolCallTextHasPrototypeSensitiveKey(droppedToolCall)
  ) {
    const errorId = generateId();
    controller.enqueue({
      type: "text-start",
      id: errorId,
    } as LanguageModelV4StreamPart);
    controller.enqueue({
      type: "text-delta",
      id: errorId,
      delta: droppedToolCall,
    } as LanguageModelV4StreamPart);
    controller.enqueue({
      type: "text-end",
      id: errorId,
    } as LanguageModelV4StreamPart);
  }
  closeToolInput(state, controller);
  parserOptions?.onError?.(
    shouldEmitRawFallback
      ? "Could not process malformed streaming JSON tool call before nested start; emitting original text."
      : "Could not process malformed streaming JSON tool call before nested start.",
    {
      toolCall: safeToolCallMetadataText(droppedToolCall),
      toolCallId: streamingToolCallId,
      toolName: streamingToolName,
      dropReason: "malformed-nested-tool-call",
    }
  );
  state.currentToolCallJson = "";
  state.isInsideToolCall = false;
  state.buffer =
    jsonSoFar.slice(nestedStartIndex) +
    toolCallEnd +
    state.buffer.slice(startIndex + tag.length);
  return getPotentialStartIndex(state.buffer, toolCallStart);
}

function processInsideToolCallBoundary(context: TagProcessingContext): boolean {
  const { state, controller, toolCallStart, toolCallEnd } = context;
  const currentLength = state.currentToolCallJson.length;
  const combined = state.currentToolCallJson + state.buffer;
  const boundary = findToolCallBoundaryOutsideRjsonSyntax(
    combined,
    0,
    toolCallStart,
    toolCallEnd
  );
  if (boundary == null) {
    return false;
  }

  const relativeEndIndex = boundary.endIdx - currentLength;
  if (relativeEndIndex < 0) {
    return false;
  }

  if (boundary.kind === "nested") {
    recoverNestedStreamingToolCall({
      context,
      jsonSoFar: combined.slice(0, boundary.endIdx),
      nestedStartIndex: boundary.nestedStartIndex,
      startIndex: relativeEndIndex,
      tag: toolCallEnd,
    });
    return true;
  }

  publishText(state.buffer.slice(0, relativeEndIndex), state, controller);
  state.buffer = state.buffer.slice(relativeEndIndex + toolCallEnd.length);
  processTagMatch(context);
  return true;
}

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

function processBufferTags(context: TagProcessingContext) {
  const { state, controller, toolCallStart } = context;

  while (state.isInsideToolCall) {
    if (!processInsideToolCallBoundary(context)) {
      return;
    }
  }

  let startIndex = getPotentialStartIndex(state.buffer, toolCallStart);

  while (startIndex != null) {
    if (startIndex + toolCallStart.length > state.buffer.length) {
      break;
    }

    publishText(state.buffer.slice(0, startIndex), state, controller);
    state.buffer = state.buffer.slice(startIndex + toolCallStart.length);
    processTagMatch(context);

    while (state.isInsideToolCall) {
      if (!processInsideToolCallBoundary(context)) {
        return;
      }
    }

    startIndex = getPotentialStartIndex(state.buffer, toolCallStart);
  }
}

function handlePartialTag(
  state: StreamState,
  controller: StreamController,
  toolCallStart: string,
  toolCallEnd: string,
  tools: LanguageModelV4FunctionTool[],
  toolCallResolver: ProtocolToolCallResolver
) {
  if (state.isInsideToolCall) {
    const potentialEndIndex = getPotentialStartIndex(state.buffer, toolCallEnd);
    if (
      potentialEndIndex != null &&
      potentialEndIndex + toolCallEnd.length > state.buffer.length
    ) {
      publishText(state.buffer.slice(0, potentialEndIndex), state, controller);
      scheduleStreamingToolInputProgress({
        state,
        controller,
        toolCallJson: state.currentToolCallJson,
        tools,
        resolveToolCall: toolCallResolver,
      });
      state.buffer = state.buffer.slice(potentialEndIndex);
    } else {
      publishText(state.buffer, state, controller);
      scheduleStreamingToolInputProgress({
        state,
        controller,
        toolCallJson: state.currentToolCallJson,
        tools,
        resolveToolCall: toolCallResolver,
      });
      state.buffer = "";
    }
    return;
  }

  const potentialIndex = getPotentialStartIndex(state.buffer, toolCallStart);
  if (
    potentialIndex != null &&
    potentialIndex + toolCallStart.length > state.buffer.length
  ) {
    publishText(state.buffer.slice(0, potentialIndex), state, controller);
    state.buffer = state.buffer.slice(potentialIndex);
  } else {
    publishText(state.buffer, state, controller);
    state.buffer = "";
  }
}

export function createHermesStreamParser({
  tools,
  options,
  toolCallStart,
  toolCallEnd,
  resolveToolCall: toolCallResolver,
}: {
  tools: LanguageModelV4FunctionTool[];
  options?: ParserOptions;
  toolCallStart: string;
  toolCallEnd: string;
  resolveToolCall: ProtocolToolCallResolver;
}): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
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
