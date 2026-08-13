import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import { logParseFailure } from "../utils/debug";
import { extractSensitiveIncompleteToolCallDropSpans } from "../utils/generated-text-sensitive-candidates";
import { getPotentialStartIndex } from "../utils/get-potential-start-index";
import { generateId, generateToolCallId } from "../utils/id";
import {
  addTextSegment,
  formatToolsWithPromptTemplate,
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../utils/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import { shouldEmitRawToolCallTextOnError } from "../utils/tool-input-streaming";
import {
  closeTextBlock,
  closeToolInput,
  emitResolvedToolCall,
  handleFinishChunk,
  recoverCompleteCallArrayBeforePartialEnd,
  recoverCompleteKnownCallBeforeNestedStart,
  scheduleStreamingToolInputProgress,
} from "./hermes-stream-lifecycle";
import type {
  ParserOptions,
  ProtocolToolCallResolver,
  TCMProtocol,
} from "./protocol-interface";

interface HermesProtocolOptions {
  resolveToolCall?: ProtocolToolCallResolver;
  toolCallEnd?: string;
  toolCallStart?: string;
}

import { isArgumentKeyPolicyError } from "./hermes-argument-key-policy";
import {
  findNextToolCallSpan,
  findToolCallBoundaryOutsideRjsonSyntax,
  validateNonEmptyDelimiters,
} from "./hermes-call-boundary";
import {
  processToolCallJson,
  recoverKnownToolCallsFromText,
  resolveToolCall,
} from "./hermes-call-parsing";
import {
  extractStreamingToolCallProgress,
  type StreamController,
  type StreamState,
  type TagProcessingContext,
} from "./hermes-streaming-progress";

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

function dropSensitiveOrphanToolCall(options: {
  currentIndex: number;
  processedElements: LanguageModelV4Content[];
  spanStartIndex: number;
  text: string;
  tools: LanguageModelV4FunctionTool[];
}): number | null {
  const sensitiveDrop = extractSensitiveIncompleteToolCallDropSpans(
    options.text.slice(options.spanStartIndex),
    options.tools
  ).find((dropSpan) => dropSpan.startIndex === 0);
  if (!sensitiveDrop) {
    return null;
  }
  if (options.spanStartIndex > options.currentIndex) {
    addTextSegment(
      options.text.slice(options.currentIndex, options.spanStartIndex),
      options.processedElements
    );
  }
  return options.spanStartIndex + sensitiveDrop.endIndex;
}

function handleOrphanToolCallSpan(options: {
  currentIndex: number;
  nestedStartIndex?: number;
  processedElements: LanguageModelV4Content[];
  spanStartIndex: number;
  text: string;
  toolCallEnd: string;
  toolCallStart: string;
  tools: LanguageModelV4FunctionTool[];
  resolveToolCall: ProtocolToolCallResolver;
}): number {
  const dropEndIndex = dropSensitiveOrphanToolCall(options);
  if (dropEndIndex !== null) {
    return dropEndIndex;
  }

  const bodyStart = options.spanStartIndex + options.toolCallStart.length;
  if (options.nestedStartIndex !== undefined) {
    const recoveredCall = recoverCompleteKnownCallBeforeNestedStart(
      options.text.slice(bodyStart, options.nestedStartIndex),
      options.tools,
      options.resolveToolCall
    );
    if (recoveredCall) {
      if (options.spanStartIndex > options.currentIndex) {
        addTextSegment(
          options.text.slice(options.currentIndex, options.spanStartIndex),
          options.processedElements
        );
      }
      options.processedElements.push({
        type: "tool-call",
        toolCallId: generateToolCallId(),
        toolName: recoveredCall.toolName,
        input: recoveredCall.input,
      });
      return options.nestedStartIndex;
    }
  }
  const arrayRecovery = recoverCompleteCallArrayBeforePartialEnd(
    options.text.slice(bodyStart),
    options.toolCallEnd,
    options.tools,
    options.resolveToolCall
  );
  const { recoveredCalls } = arrayRecovery;
  if (recoveredCalls && recoveredCalls.length > 0) {
    if (options.spanStartIndex > options.currentIndex) {
      addTextSegment(
        options.text.slice(options.currentIndex, options.spanStartIndex),
        options.processedElements
      );
    }
    for (const recoveredCall of recoveredCalls) {
      options.processedElements.push({
        type: "tool-call",
        toolCallId: generateToolCallId(),
        toolName: recoveredCall.toolName,
        input: recoveredCall.input,
      });
    }
    return options.text.length;
  }

  const skipTo = options.spanStartIndex + options.toolCallStart.length;
  if (skipTo > options.currentIndex) {
    addTextSegment(
      options.text.slice(options.currentIndex, skipTo),
      options.processedElements
    );
  }
  return skipTo;
}

function findUnclosedJsonToolCallStart(
  text: string,
  searchFrom: number,
  toolCallStart: string,
  toolCallEnd: string,
  tools: LanguageModelV4FunctionTool[]
): number | null {
  const startIndex = text.indexOf(toolCallStart, searchFrom);
  if (startIndex === -1) {
    return null;
  }
  const bodyStart = startIndex + toolCallStart.length;
  if (!text.slice(bodyStart).trimStart().startsWith("{")) {
    return null;
  }
  if (
    extractSensitiveIncompleteToolCallDropSpans(
      text.slice(startIndex),
      tools
    ).some((span) => span.startIndex === 0)
  ) {
    return null;
  }
  return text.indexOf(toolCallEnd, bodyStart) === -1 ? startIndex : null;
}

export const hermesProtocol = ({
  toolCallStart = "<tool_call>",
  toolCallEnd = "</tool_call>",
  resolveToolCall: toolCallResolver = resolveToolCall,
}: HermesProtocolOptions = {}): TCMProtocol => ({
  ...validateNonEmptyDelimiters(toolCallStart, toolCallEnd),

  formatTools({
    tools,
    toolSystemPromptTemplate,
  }: {
    tools: LanguageModelV4FunctionTool[];
    toolSystemPromptTemplate: (tools: LanguageModelV4FunctionTool[]) => string;
  }) {
    return formatToolsWithPromptTemplate({ tools, toolSystemPromptTemplate });
  },

  formatToolCall(toolCall: LanguageModelV4ToolCall) {
    let args: unknown = {};
    if (toolCall.input != null) {
      try {
        args = JSON.parse(toolCall.input);
      } catch {
        args = toolCall.input;
      }
    }
    return `${toolCallStart}${JSON.stringify({
      name: toolCall.toolName,
      arguments: args,
    })}${toolCallEnd}`;
  },

  parseGeneratedText({
    text,
    tools,
    options,
  }: {
    text: string;
    tools: LanguageModelV4FunctionTool[];
    options?: ParserOptions;
  }) {
    const processedElements: LanguageModelV4Content[] = [];
    let currentIndex = 0;
    let searchFrom = 0;

    while (searchFrom < text.length) {
      const unclosedStartIndex = findUnclosedJsonToolCallStart(
        text,
        searchFrom,
        toolCallStart,
        toolCallEnd,
        tools
      );
      if (unclosedStartIndex !== null) {
        if (unclosedStartIndex > currentIndex) {
          addTextSegment(
            text.slice(currentIndex, unclosedStartIndex),
            processedElements
          );
        }
        addTextSegment(text.slice(unclosedStartIndex), processedElements);
        currentIndex = text.length;
        break;
      }
      const span = findNextToolCallSpan(
        text,
        searchFrom,
        toolCallStart,
        toolCallEnd
      );
      if (span === null) {
        break;
      }

      if (!span.found) {
        currentIndex = handleOrphanToolCallSpan({
          currentIndex,
          nestedStartIndex: span.nestedStartIndex,
          processedElements,
          spanStartIndex: span.startIdx,
          text,
          toolCallEnd,
          toolCallStart,
          tools,
          resolveToolCall: toolCallResolver,
        });
        searchFrom = currentIndex;
        continue;
      }

      const toolCallJson = text.slice(span.jsonStart, span.endIdx);
      const fullMatch = text.slice(
        span.startIdx,
        span.endIdx + toolCallEnd.length
      );

      if (span.startIdx > currentIndex) {
        addTextSegment(
          text.slice(currentIndex, span.startIdx),
          processedElements
        );
      }

      processToolCallJson(
        toolCallJson,
        fullMatch,
        processedElements,
        tools,
        options,
        toolCallResolver
      );
      currentIndex = span.endIdx + toolCallEnd.length;
      searchFrom = currentIndex;
    }

    if (currentIndex < text.length) {
      const remainingText = text.slice(currentIndex);
      addTextSegment(remainingText, processedElements);
    }

    return processedElements;
  },

  createStreamParser({
    tools,
    options,
  }: {
    tools: LanguageModelV4FunctionTool[];
    options?: ParserOptions;
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
          shouldDeferToolCallScan(
            state,
            textContent,
            toolCallStart,
            toolCallEnd
          )
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
  },

  extractToolCallSegments({ text }) {
    const segments: string[] = [];
    let searchFrom = 0;

    while (searchFrom < text.length) {
      const span = findNextToolCallSpan(
        text,
        searchFrom,
        toolCallStart,
        toolCallEnd
      );
      if (span === null) {
        break;
      }

      if (!span.found) {
        // Orphan start tag — skip past it and keep searching
        searchFrom = span.startIdx + toolCallStart.length;
        continue;
      }

      segments.push(
        text.slice(span.startIdx, span.endIdx + toolCallEnd.length)
      );
      searchFrom = span.endIdx + toolCallEnd.length;
    }

    return segments;
  },
});
