import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import { parse as parseRJSON } from "../../rjson";
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
import {
  toolCallInputHasPrototypeSensitiveKey,
  toolCallTextHasPrototypeSensitiveKey,
} from "../utils/prototype-sensitive-keys";
import {
  shouldEmitRawToolCallTextOnError,
  stringifyToolInputWithSchema,
} from "../utils/tool-input-streaming";
import type { ParserOptions, TCMProtocol } from "./protocol-interface";

interface HermesProtocolOptions {
  toolCallEnd?: string;
  toolCallStart?: string;
}

import {
  applyToolArgumentKeyPolicy,
  canonicalizeToolInput,
  emitToolInputDelta,
  ensureToolInputStart,
  extractStreamingToolCallProgress,
  findNextToolCallSpan,
  findToolCallBoundaryOutsideRjsonSyntax,
  hasPrototypeSensitiveKeyInJsonLikeObject,
  isArgumentKeyPolicyError,
  isParsedToolCallRecord,
  normalizeInvalidJsonEscapes,
  normalizeJsonStringCtrl,
  processToolCallJson,
  recoverKnownToolCallsFromText,
  resolveToolCall,
  type StreamController,
  type StreamState,
  type TagProcessingContext,
  validateNonEmptyDelimiters,
} from "./hermes-call-parsing";

function emitStreamingToolInputProgress(options: {
  state: StreamState;
  controller: StreamController;
  toolCallJson: string;
  tools: LanguageModelV4FunctionTool[];
}): boolean {
  const { state, controller, toolCallJson, tools } = options;
  const progress = extractStreamingToolCallProgress(toolCallJson);
  if (!(progress.toolName && progress.argumentsComplete)) {
    return false;
  }
  try {
    const parsedToolCall = parseRJSON(
      normalizeInvalidJsonEscapes(normalizeJsonStringCtrl(toolCallJson))
    );
    if (!isParsedToolCallRecord(parsedToolCall)) {
      return false;
    }
    if (hasPrototypeSensitiveKeyInJsonLikeObject(toolCallJson)) {
      return false;
    }
    const policyArguments = applyToolArgumentKeyPolicy(
      parsedToolCall.name,
      parsedToolCall.arguments,
      tools
    );
    if (policyArguments === null) {
      return false;
    }
    const input = stringifyToolInputWithSchema({
      toolName: parsedToolCall.name,
      args: policyArguments.args,
      tools,
      fallback: canonicalizeToolInput,
    });
    ensureToolInputStart(state, controller, parsedToolCall.name);
    emitToolInputDelta(state, controller, input);
    return true;
  } catch {
    return false;
  }
}

function scheduleStreamingToolInputProgress(options: {
  state: StreamState;
  controller: StreamController;
  toolCallJson: string;
  tools: LanguageModelV4FunctionTool[];
}) {
  const { state, controller, toolCallJson, tools } = options;
  state.pendingToolInputProgressVersion += 1;
  const version = state.pendingToolInputProgressVersion;
  setTimeout(() => {
    if (
      !state.isInsideToolCall ||
      state.pendingToolInputProgressVersion !== version ||
      state.currentToolCallJson !== toolCallJson
    ) {
      return;
    }
    emitStreamingToolInputProgress({
      state,
      controller,
      toolCallJson,
      tools,
    });
  });
}

function closeToolInput(state: StreamState, controller: StreamController) {
  if (!state.activeToolInput) {
    return;
  }
  controller.enqueue({
    type: "tool-input-end",
    id: state.activeToolInput.id,
  } as LanguageModelV4StreamPart);
  state.activeToolInput = null;
}

/**
 * Emit a fully-resolved streaming tool call (`toolName` plus an
 * already-stringified `input`) onto the stream, reconciling any tool-input
 * deltas already streamed for the in-progress call. Callers are responsible for
 * closing any open text block first. Shared by `emitToolCallFromParsed` and the
 * `resolveToolCall`-driven success path in `emitToolCall`.
 */
function emitResolvedToolCall(
  state: StreamState,
  controller: StreamController,
  toolName: string,
  input: string
) {
  ensureToolInputStart(state, controller, toolName);
  emitToolInputDelta(state, controller, input);
  const toolCallId = state.activeToolInput?.id ?? generateToolCallId();
  closeToolInput(state, controller);
  controller.enqueue({
    type: "tool-call",
    toolCallId,
    toolName,
    input,
  } as LanguageModelV4StreamPart);
}

function emitToolCallFromParsed(
  state: StreamState,
  controller: StreamController,
  parsedToolCall: { name: string; arguments: unknown },
  tools: LanguageModelV4FunctionTool[]
) {
  closeTextBlock(state, controller);
  const toolName =
    typeof parsedToolCall.name === "string"
      ? parsedToolCall.name
      : (state.activeToolInput?.toolName ?? "unknown");
  const input = stringifyToolInputWithSchema({
    toolName,
    args: parsedToolCall.arguments,
    tools,
    fallback: canonicalizeToolInput,
  });
  emitResolvedToolCall(state, controller, toolName, input);
}

function flushBuffer(state: StreamState, controller: StreamController) {
  if (state.buffer.length === 0) {
    return;
  }

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
    delta: state.buffer,
  } as LanguageModelV4StreamPart);
  state.buffer = "";
}

function closeTextBlock(state: StreamState, controller: StreamController) {
  if (state.currentTextId && state.hasEmittedTextStart) {
    controller.enqueue({
      type: "text-end",
      id: state.currentTextId,
    } as LanguageModelV4StreamPart);
    state.currentTextId = null;
    state.hasEmittedTextStart = false;
  }
}

function isStrictToolCallArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    !toolCallInputHasPrototypeSensitiveKey(value) &&
    value.every((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return false;
      }
      const record = item as Record<string, unknown>;
      const args = record.arguments;
      return (
        Object.hasOwn(record, "name") &&
        typeof record.name === "string" &&
        record.name.trim().length > 0 &&
        Object.hasOwn(record, "arguments") &&
        typeof args === "object" &&
        args !== null &&
        !Array.isArray(args)
      );
    })
  );
}

/**
 * Seed 2.0 Lite has been observed completing a JSON array of calls and then
 * truncating only the wrapper close (`</tool`). Accept that shape only when a
 * proper prefix of the configured end delimiter is the final non-whitespace
 * text and the preceding body is a strict, complete JSON array of at least two
 * object-argument calls. The recovered calls still pass through the shared
 * known-tool, schema-key, and prototype-safety gates before emission.
 */
function stripPartialEndFromPossibleCallArray(
  text: string,
  toolCallEnd: string
): string | null {
  const trimmed = text.trimEnd();
  const maxPrefixLength = Math.min(toolCallEnd.length - 1, trimmed.length);
  for (let length = maxPrefixLength; length >= 2; length -= 1) {
    const partialEnd = toolCallEnd.slice(0, length);
    if (!trimmed.endsWith(partialEnd)) {
      continue;
    }
    return trimmed.slice(0, -length).trimEnd();
  }
  return null;
}

function recoverCompleteCallArrayBeforePartialEnd(
  text: string,
  toolCallEnd: string,
  tools: LanguageModelV4FunctionTool[]
): {
  matchedArrayShape: boolean;
  recoveredCalls: ReturnType<typeof recoverKnownToolCallsFromText>;
} {
  const candidate = stripPartialEndFromPossibleCallArray(text, toolCallEnd);
  if (candidate === null || !candidate.trimStart().startsWith("[")) {
    return { matchedArrayShape: false, recoveredCalls: null };
  }
  try {
    if (!isStrictToolCallArray(JSON.parse(candidate))) {
      return { matchedArrayShape: true, recoveredCalls: null };
    }
  } catch {
    return { matchedArrayShape: true, recoveredCalls: null };
  }
  return {
    matchedArrayShape: true,
    recoveredCalls: recoverKnownToolCallsFromText(candidate, tools),
  };
}

/**
 * Salvage tool calls from an unterminated streaming tool-call body. A call
 * closed with the wrong tag (e.g. `<tool_call>{...}</think>`) or a run of
 * calls separated by bare `<tool_call>` tags never sees an end tag, but the
 * JSON bodies themselves are complete. Genuinely truncated JSON stays
 * unbalanced, fails recovery, and the caller falls through to the error
 * fallback. Returns true when at least one call was emitted.
 */
function salvageIncompleteToolCalls(
  state: StreamState,
  controller: StreamController,
  rawToolCallContent: string,
  tools: LanguageModelV4FunctionTool[],
  toolCallEnd: string
): boolean {
  const arrayRecovery = recoverCompleteCallArrayBeforePartialEnd(
    rawToolCallContent,
    toolCallEnd,
    tools
  );
  const recoveredCalls = arrayRecovery.matchedArrayShape
    ? arrayRecovery.recoveredCalls
    : recoverKnownToolCallsFromText(rawToolCallContent, tools);
  if (!recoveredCalls || recoveredCalls.length === 0) {
    return false;
  }
  closeTextBlock(state, controller);
  for (const recoveredCall of recoveredCalls) {
    emitResolvedToolCall(
      state,
      controller,
      recoveredCall.toolName,
      recoveredCall.input
    );
  }
  state.currentToolCallJson = "";
  state.isInsideToolCall = false;
  return true;
}

function emitIncompleteToolCall(
  state: StreamState,
  controller: StreamController,
  toolCallStart: string,
  toolCallEnd: string,
  trailingBuffer: string,
  tools: LanguageModelV4FunctionTool[],
  options?: ParserOptions
) {
  if (!state.currentToolCallJson && trailingBuffer.length === 0) {
    state.isInsideToolCall = false;
    return;
  }

  if (state.currentToolCallJson) {
    try {
      const parsedToolCall = parseRJSON(
        normalizeInvalidJsonEscapes(
          normalizeJsonStringCtrl(state.currentToolCallJson)
        )
      );
      if (!isParsedToolCallRecord(parsedToolCall)) {
        throw new Error("Tool call object is missing own name or arguments");
      }
      if (hasPrototypeSensitiveKeyInJsonLikeObject(state.currentToolCallJson)) {
        throw new Error("Tool call arguments contain prototype-sensitive keys");
      }
      const policyArguments = applyToolArgumentKeyPolicy(
        parsedToolCall.name,
        parsedToolCall.arguments,
        tools
      );
      if (policyArguments === null) {
        throw new Error("Tool call arguments contain schema-unknown keys");
      }
      emitToolCallFromParsed(
        state,
        controller,
        { ...parsedToolCall, arguments: policyArguments.args },
        tools
      );
      state.currentToolCallJson = "";
      state.isInsideToolCall = false;
      return;
    } catch {
      // Incomplete tool calls (no closing </tool_call>) are not candidates
      // for quote repair — the JSON may be genuinely truncated.
      // Fall through to balanced-JSON salvage, then text/error fallback.
    }
  }

  const rawToolCallContent = `${state.currentToolCallJson}${trailingBuffer}`;

  if (
    salvageIncompleteToolCalls(
      state,
      controller,
      rawToolCallContent,
      tools,
      toolCallEnd
    )
  ) {
    return;
  }

  const errorContent = `${toolCallStart}${rawToolCallContent}`;
  const shouldEmitRawFallback = shouldEmitRawToolCallTextOnError(options);

  logParseFailure({
    phase: "stream",
    reason: shouldEmitRawFallback
      ? "Incomplete streaming tool call segment emitted as text"
      : "Incomplete streaming tool call segment suppressed without raw text fallback",
    snippet: errorContent,
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
  // Capture structured tool-call context before closeToolInput clears
  // state.activeToolInput. If streaming already identified the name/id we use
  // them directly; otherwise fall back to re-scanning the raw JSON for the name
  // and generating a fresh correlation id so consumers always receive the
  // uniform { toolCall, toolCallId, toolName, dropReason } recovery shape.
  const streamingToolCallId = state.activeToolInput?.id ?? generateToolCallId();
  const streamingToolName = state.activeToolInput?.toolName;
  closeToolInput(state, controller);
  const toolName =
    streamingToolName ??
    (state.currentToolCallJson
      ? extractStreamingToolCallProgress(state.currentToolCallJson).toolName
      : undefined);
  options?.onError?.(
    shouldEmitRawFallback
      ? "Could not complete streaming JSON tool call at finish; emitting original text."
      : "Could not complete streaming JSON tool call at finish.",
    {
      toolCall: safeToolCallMetadataText(errorContent),
      toolCallId: streamingToolCallId,
      toolName,
      dropReason: "unfinished-tool-call",
    }
  );
  state.currentToolCallJson = "";
  state.isInsideToolCall = false;
}

function handleFinishChunk(
  state: StreamState,
  controller: StreamController,
  toolCallStart: string,
  toolCallEnd: string,
  tools: LanguageModelV4FunctionTool[],
  options: ParserOptions | undefined,
  chunk: LanguageModelV4StreamPart
) {
  if (state.isInsideToolCall) {
    const trailingBuffer = state.buffer;
    state.buffer = "";
    emitIncompleteToolCall(
      state,
      controller,
      toolCallStart,
      toolCallEnd,
      trailingBuffer,
      tools,
      options
    );
  } else if (state.buffer.length > 0) {
    flushBuffer(state, controller);
  }
  closeTextBlock(state, controller);
  controller.enqueue(chunk);
}

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
  const resolved = resolveToolCall(state.currentToolCallJson, tools);
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
  tools: LanguageModelV4FunctionTool[]
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
      });
      state.buffer = state.buffer.slice(potentialEndIndex);
    } else {
      publishText(state.buffer, state, controller);
      scheduleStreamingToolInputProgress({
        state,
        controller,
        toolCallJson: state.currentToolCallJson,
        tools,
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
  processedElements: LanguageModelV4Content[];
  spanStartIndex: number;
  text: string;
  toolCallEnd: string;
  toolCallStart: string;
  tools: LanguageModelV4FunctionTool[];
}): number {
  const dropEndIndex = dropSensitiveOrphanToolCall(options);
  if (dropEndIndex !== null) {
    return dropEndIndex;
  }

  const bodyStart = options.spanStartIndex + options.toolCallStart.length;
  const arrayRecovery = recoverCompleteCallArrayBeforePartialEnd(
    options.text.slice(bodyStart),
    options.toolCallEnd,
    options.tools
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

export const hermesProtocol = ({
  toolCallStart = "<tool_call>",
  toolCallEnd = "</tool_call>",
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
          processedElements,
          spanStartIndex: span.startIdx,
          text,
          toolCallEnd,
          toolCallStart,
          tools,
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
        options
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
      hasEmittedTextStart: false,
      activeToolInput: null,
      pendingToolInputProgressVersion: 0,
    };

    return new TransformStream<
      LanguageModelV4StreamPart,
      LanguageModelV4StreamPart
    >({
      transform(chunk, controller) {
        if (chunk.type === "finish") {
          handleFinishChunk(
            state,
            controller,
            toolCallStart,
            toolCallEnd,
            tools,
            options,
            chunk
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
        processBufferTags({
          state,
          controller,
          toolCallStart,
          toolCallEnd,
          options,
          tools,
        });
        handlePartialTag(state, controller, toolCallStart, toolCallEnd, tools);
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
