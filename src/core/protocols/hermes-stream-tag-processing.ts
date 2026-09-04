import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { logParseFailure } from "../utils/debug";
import { getPotentialStartIndex } from "../utils/get-potential-start-index";
import { generateId, generateToolCallId } from "../utils/id";
import {
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../utils/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import { shouldEmitRawToolCallTextOnError } from "../utils/tool-input-streaming";
import { isArgumentKeyPolicyError } from "./hermes-argument-key-policy";
import { findToolCallBoundaryOutsideRjsonSyntax } from "./hermes-call-boundary";
import { recoverKnownToolCallsFromText } from "./hermes-call-parsing";
import {
  closeTextBlock,
  closeToolInput,
  emitResolvedToolCall,
  recoverCompleteKnownCallBeforeNestedStart,
} from "./hermes-stream-lifecycle";
import {
  extractStreamingToolCallProgress,
  type StreamController,
  type StreamState,
  type TagProcessingContext,
} from "./hermes-streaming-progress";

export function publishText(
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

  const finalError =
    resolved.error instanceof Error
      ? resolved.error
      : new Error(String(resolved.error));
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

export function processTagMatch(context: TagProcessingContext) {
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

export function processInsideToolCallBoundary(
  context: TagProcessingContext
): boolean {
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
