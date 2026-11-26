import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { parse } from "../../../rxml";
import {
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../../utils/primitives/protocol-utils";
import { shouldBufferToolInputProgress } from "../../utils/streaming/tool-call-progress-buffering";
import {
  emitBufferedToolInputProgressDelta,
  emitFailedBufferedToolInputLifecycle,
  emitFinalizedBufferedToolInputLifecycle,
  isPrototypeSensitiveToolCallInputError,
  shouldEmitRawToolCallTextOnError,
  stringifyToolInputWithSchema,
} from "../../utils/streaming/tool-input-streaming";
import type { ParserOptions } from "../protocol-interface";
import { plainTextBodyFallback } from "./progress-analysis";
import type {
  FlushTextFn,
  StreamingToolCallState,
} from "./stream-state-machine";

const XML_PROGRESS_TAG_NAME_REGEX = /^[A-Za-z_][\w.:-]*/;

/**
 * Cap between progress-candidate rebuilds while live-streaming a trailing
 * string value. Each rebuild stringifies the full args (O(total)), so bursts
 * keep total work bounded while still updating the UI every ~1KB of content.
 */
export const STREAMING_VALUE_EMIT_INTERVAL = 1024;

export function getMorphToolSchema(
  tools: LanguageModelV4FunctionTool[],
  toolName: string
) {
  return tools.find((t) => t.name === toolName)?.inputSchema;
}

function allowPlainTextBodyFallback(
  parseOptions?: Record<string, unknown>
): boolean {
  return parseOptions?.repair !== false;
}

export interface HandleStreamingToolCallEndParams {
  ctrl: TransformStreamDefaultController<LanguageModelV4StreamPart>;
  currentToolCall: StreamingToolCallState;
  flushText: FlushTextFn;
  options?: ParserOptions;
  parseOptions?: Record<string, unknown>;
  toolContent: string;
  tools: LanguageModelV4FunctionTool[];
}

export function handleStreamingToolCallEnd(
  params: HandleStreamingToolCallEndParams
): void {
  const {
    toolContent,
    currentToolCall,
    tools,
    options,
    ctrl,
    flushText,
    parseOptions,
  } = params;
  const toolSchema = getMorphToolSchema(tools, currentToolCall.name);
  const parseConfig = {
    ...(parseOptions ?? {}),
    onError:
      options?.onError ??
      (parseOptions as { onError?: ParserOptions["onError"] } | undefined)
        ?.onError,
  };

  flushText(ctrl);
  try {
    const parsedResult =
      (allowPlainTextBodyFallback(parseOptions)
        ? plainTextBodyFallback(toolContent, toolSchema)
        : null) ?? parse(toolContent, toolSchema, parseConfig);
    const finalInput = stringifyToolInputWithSchema({
      toolName: currentToolCall.name,
      args: parsedResult,
      tools,
    });
    emitFinalizedBufferedToolInputLifecycle({
      bufferedParts: currentToolCall.pendingToolInputParts,
      controller: ctrl,
      id: currentToolCall.toolCallId,
      state: currentToolCall,
      toolName: currentToolCall.name,
      finalInput,
      onMismatch: options?.onError,
    });
  } catch (error) {
    const original = `<${currentToolCall.name}>${toolContent}</${currentToolCall.name}>`;
    const emitRawFallback = shouldEmitRawToolCallTextOnError(options);
    emitFailedBufferedToolInputLifecycle({
      bufferedParts: currentToolCall.pendingToolInputParts,
      controller: ctrl,
      id: currentToolCall.toolCallId,
      emitRawToolCallTextOnError: emitRawFallback,
      endInputOnError: currentToolCall.hasEmittedStart,
      hideBufferedInputOnError: isPrototypeSensitiveToolCallInputError(error),
      rawToolCallText: original,
      emitRawText: (rawText) => {
        flushText(ctrl, rawText);
      },
    });
    options?.onError?.("Could not process streaming XML tool call", {
      toolCall: safeToolCallMetadataText(original),
      error: safeToolCallMetadataError(error, original),
      toolName: currentToolCall.name,
      toolCallId: currentToolCall.toolCallId,
      dropReason: "malformed-tool-call-body",
    });
  }
}

function parseXmlProgressTagName(innerTag: string): string | null {
  const tag = innerTag.trimStart();
  const body = tag.startsWith("/") ? tag.slice(1).trimStart() : tag;
  const match = XML_PROGRESS_TAG_NAME_REGEX.exec(body);
  return match?.[0] ?? null;
}

function updateXmlProgressTagStack(innerTag: string, stack: string[]): void {
  if (
    innerTag.length === 0 ||
    innerTag.startsWith("!") ||
    innerTag.startsWith("?")
  ) {
    return;
  }

  const tagName = parseXmlProgressTagName(innerTag);
  if (tagName === null) {
    return;
  }

  if (innerTag.startsWith("/")) {
    const openIndex = stack.lastIndexOf(tagName);
    if (openIndex >= 0) {
      stack.length = openIndex;
    }
    return;
  }

  if (!innerTag.endsWith("/")) {
    stack.push(tagName);
  }
}

function hasOpenTextElementAtProgressEnd(toolContent: string): boolean {
  const stack: string[] = [];
  const tagRegex = /<[^>]*>/g;
  let lastTagEnd = 0;
  let match = tagRegex.exec(toolContent);

  while (match !== null) {
    const [tag] = match;
    const innerTag = tag.slice(1, -1).trim();
    lastTagEnd = tagRegex.lastIndex;

    updateXmlProgressTagStack(innerTag, stack);
    match = tagRegex.exec(toolContent);
  }

  return stack.length > 0 && toolContent.slice(lastTagEnd).trim().length > 0;
}

function shouldBufferMorphToolInputProgress(
  toolContent: string,
  fullInput: string
): boolean {
  return (
    shouldBufferToolInputProgress(fullInput) ||
    !hasOpenTextElementAtProgressEnd(toolContent)
  );
}

function isMorphToolInputProgressContainer(fullInput: string): boolean {
  const trimmed = fullInput.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export function isEmptyMorphToolInputProgress(
  toolContent: string,
  fullInput: string
): boolean {
  return fullInput === "{}" && toolContent.trim().length === 0;
}

export function foldInertRegionIntoStreamingValue(options: {
  inspected: string;
  inspectedStart: number;
  prevLength: number;
  to: number;
  toolCall: StreamingToolCallState;
}): void {
  const { toolCall } = options;
  if (
    toolCall.streamingValueBodyStart === null ||
    options.to <= options.prevLength
  ) {
    return;
  }
  toolCall.streamingValue += options.inspected.slice(
    Math.max(options.prevLength, toolCall.streamingValueBodyStart) -
      options.inspectedStart,
    options.to - options.inspectedStart
  );
}

export function scanAppendedRegionForStructuralChars(options: {
  from: number;
  inspected: string;
  inspectedStart: number;
  pendingOpenAngle: boolean;
  to: number;
}): { lastBareGtIndex: number; structural: boolean } {
  let lastBareGtIndex = -1;
  for (let i = options.from; i < options.to; i += 1) {
    const code = options.inspected.charCodeAt(i - options.inspectedStart);
    if (code === 60 /* `<` */) {
      return { lastBareGtIndex, structural: true };
    }
    if (code === 62 /* `>` */) {
      if (options.pendingOpenAngle) {
        return { lastBareGtIndex, structural: true };
      }
      lastBareGtIndex = i;
    }
  }
  return { lastBareGtIndex, structural: false };
}

const shouldBufferDecisionCache = new WeakMap<
  StreamingToolCallState,
  { fullInput: string; result: boolean; toolContent: string }
>();

function shouldBufferMorphToolInputProgressCached(options: {
  fullInput: string;
  getToolContent: () => string;
  toolCall: StreamingToolCallState;
}): boolean {
  const toolContent = options.getToolContent();
  const cached = shouldBufferDecisionCache.get(options.toolCall);
  if (
    cached &&
    cached.fullInput === options.fullInput &&
    cached.toolContent === toolContent
  ) {
    return cached.result;
  }
  const result = shouldBufferMorphToolInputProgress(
    toolContent,
    options.fullInput
  );
  shouldBufferDecisionCache.set(options.toolCall, {
    fullInput: options.fullInput,
    result,
    toolContent,
  });
  return result;
}

function enqueueMorphToolInputProgressPart(options: {
  controller: TransformStreamDefaultController<LanguageModelV4StreamPart>;
  fullInput: string;
  getToolContent: () => string;
  part: LanguageModelV4StreamPart;
  toolCall: StreamingToolCallState;
}): void {
  if (
    options.toolCall.pendingToolInputParts.length > 0 ||
    shouldBufferMorphToolInputProgressCached(options)
  ) {
    options.toolCall.pendingToolInputParts.push(options.part);
    return;
  }

  options.controller.enqueue(options.part);
}

export function emitMorphToolInputProgressDelta(options: {
  controller: TransformStreamDefaultController<LanguageModelV4StreamPart>;
  fullInput: string;
  getToolContent: () => string;
  toolCall: StreamingToolCallState;
}): void {
  if (!isMorphToolInputProgressContainer(options.fullInput)) {
    return;
  }

  emitBufferedToolInputProgressDelta({
    enqueue: (part) => {
      enqueueMorphToolInputProgressPart({ ...options, part });
    },
    id: options.toolCall.toolCallId,
    state: options.toolCall,
    fullInput: options.fullInput,
  });
}
