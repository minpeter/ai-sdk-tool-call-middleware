import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { parse as parseRJSON } from "../../rjson";
import { logParseFailure } from "../utils/debug";
import { generateId, generateToolCallId } from "../utils/id";
import { safeToolCallMetadataText } from "../utils/protocol-utils";
import {
  toolCallInputHasPrototypeSensitiveKey,
  toolCallTextHasPrototypeSensitiveKey,
} from "../utils/prototype-sensitive-keys";
import {
  shouldEmitRawToolCallTextOnError,
  stringifyToolInputWithSchema,
} from "../utils/tool-input-streaming";
import { hasPrototypeSensitiveKeyInJsonLikeObject } from "./hermes-argument-key-policy";
import {
  applyToolArgumentKeyPolicy,
  recoverKnownToolCallsFromText,
  resolveToolCall,
} from "./hermes-call-parsing";
import {
  canonicalizeToolInput,
  isParsedToolCallRecord,
  normalizeJsonStringCtrl,
} from "./hermes-json-normalization";
import { exceedsToolCallJsonNestingDepth } from "./hermes-json-object-key-scanner";
import { normalizeInvalidJsonEscapes } from "./hermes-json-repair";
import {
  emitToolInputDelta,
  ensureToolInputStart,
  extractStreamingToolCallProgress,
  type StreamController,
  type StreamState,
} from "./hermes-streaming-progress";
import type { ParserOptions } from "./protocol-interface";

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
  if (exceedsToolCallJsonNestingDepth(toolCallJson)) {
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

export function scheduleStreamingToolInputProgress(options: {
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

export function closeToolInput(
  state: StreamState,
  controller: StreamController
) {
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
export function emitResolvedToolCall(
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

export function emitToolCallFromParsed(
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

export function flushBuffer(state: StreamState, controller: StreamController) {
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

export function closeTextBlock(
  state: StreamState,
  controller: StreamController
) {
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
 * Nemotron 3 Super has been observed separating adjacent calls with a fresh
 * `<tool_call>` start while omitting only the previous `</tool_call>`. Treat
 * that nested start as an implicit close only when the preceding body is a
 * complete strict-JSON call for a known tool. The shared recovery path then
 * reapplies the existing schema-key and prototype-safety policies.
 */
export function recoverCompleteKnownCallBeforeNestedStart(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): { input: string; toolName: string } | null {
  const candidate = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.hasOwn(parsed, "name") ||
    typeof (parsed as Record<string, unknown>).name !== "string" ||
    !Object.hasOwn(parsed, "arguments")
  ) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.arguments !== "object" ||
    record.arguments === null ||
    Array.isArray(record.arguments) ||
    !tools.some((tool) => tool.name === record.name)
  ) {
    return null;
  }

  const resolved = resolveToolCall(candidate, tools);
  return resolved.ok
    ? { input: resolved.input, toolName: resolved.toolName }
    : null;
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

export function recoverCompleteCallArrayBeforePartialEnd(
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
      if (exceedsToolCallJsonNestingDepth(state.currentToolCallJson)) {
        throw new Error("Tool call JSON nesting depth exceeds limit");
      }
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

export function handleFinishChunk(
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
