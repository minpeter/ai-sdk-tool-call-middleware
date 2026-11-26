import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { parse } from "../../../rxml";
import { generateToolCallId } from "../../utils/primitives/id";
import {
  createFlushTextHandler,
  extractToolNames,
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../../utils/primitives/protocol-utils";
import { isSideChannelStreamPart } from "../../utils/streaming/side-channel-stream-part";
import {
  emitFailedBufferedToolInputLifecycle,
  emitFinalizedBufferedToolInputLifecycle,
  isPrototypeSensitiveToolCallInputError,
  shouldEmitRawToolCallTextOnError,
  stringifyToolInputWithSchema,
} from "../../utils/streaming/tool-input-streaming";
import type { ParserOptions } from "../protocol-interface";
import {
  findPotentialLinePrefixedToolCallStart,
  findStreamingLinePrefixedToolCall,
} from "./line-prefixed-tool-call";
import { hasNonWhitespaceTopLevelText } from "./progress-analysis";
import { parseXmlContentForStreamProgressWithMeta } from "./stream-progress";
import {
  emitMorphToolInputProgressDelta,
  foldInertRegionIntoStreamingValue,
  getMorphToolSchema,
  handleStreamingToolCallEnd,
  isEmptyMorphToolInputProgress,
  STREAMING_VALUE_EMIT_INTERVAL,
  scanAppendedRegionForStructuralChars,
} from "./stream-progress-buffering";
import {
  appendToolCallContent,
  createProcessBufferHandler,
  getToolCallContent,
  type LazyToolContent,
  type StreamingToolCallState,
} from "./stream-state-machine";
import { findPotentialToolTagStart } from "./tool-call-finder";

export function createMorphXmlStreamParser({
  tools,
  options,
  parseOptions,
}: {
  tools: LanguageModelV4FunctionTool[];
  options?: ParserOptions;
  parseOptions: Record<string, unknown>;
}): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  const toolNames = extractToolNames(tools);
  let buffer = "";
  let currentToolCall: StreamingToolCallState | null = null;
  let currentTextId: string | null = null;
  let hasEmittedTextStart = false;

  const flushText = createFlushTextHandler(
    () => currentTextId,
    (newId: string | null) => {
      currentTextId = newId;
    },
    () => hasEmittedTextStart,
    (value: boolean) => {
      hasEmittedTextStart = value;
    }
  );

  const emitToolInputStart = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
    toolName: string
  ): StreamingToolCallState => {
    flushText(controller);
    const next: StreamingToolCallState = {
      name: toolName,
      toolCallId: generateToolCallId(),
      contentFlat: "",
      contentLength: 0,
      contentParts: [],
      emittedInput: "",
      hasEmittedStart: true,
      lastProgressContentLength: null,
      lastProgressGtIndex: null,
      lastProgressFullInput: null,
      lastProgressPendingOpenAngle: false,
      lastProgressTrailingStringTag: null,
      pendingToolInputParts: [],
      scanCarry: "",
      streamingValue: "",
      streamingValueArgsBase: null,
      streamingValueBodyStart: null,
      streamingValueNextEmitLength: 0,
    };
    controller.enqueue({
      type: "tool-input-start",
      id: next.toolCallId,
      toolName,
    });
    return next;
  };

  const emitCachedToolInputProgress = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
    toolCall: StreamingToolCallState,
    toolContent: LazyToolContent
  ) => {
    const cached = toolCall.lastProgressFullInput;
    if (cached == null) {
      return;
    }
    if (cached === "{}" && toolContent.get().trim().length === 0) {
      return;
    }
    emitMorphToolInputProgressDelta({
      controller,
      toolCall,
      fullInput: cached,
      getToolContent: toolContent.get,
    });
  };

  const tryIncrementalProgressShortcut = (
    toolCall: StreamingToolCallState,
    toolContent: LazyToolContent
  ): boolean => {
    const prevLength = toolCall.lastProgressContentLength;
    if (
      toolCall.lastProgressTrailingStringTag == null ||
      prevLength == null ||
      toolContent.length < prevLength
    ) {
      return false;
    }

    const tail = toolContent.appendedTail;
    const tailStart = toolContent.length - (tail?.length ?? 0);
    const useTail = tail !== undefined && tailStart <= prevLength;
    const inspected = useTail ? tail : toolContent.get();
    const inspectedStart = useTail ? tailStart : 0;
    const { lastBareGtIndex, structural } =
      scanAppendedRegionForStructuralChars({
        from: prevLength,
        inspected,
        inspectedStart,
        pendingOpenAngle: toolCall.lastProgressPendingOpenAngle,
        to: toolContent.length,
      });
    if (structural) {
      return false;
    }

    foldInertRegionIntoStreamingValue({
      inspected,
      inspectedStart,
      prevLength,
      to: toolContent.length,
      toolCall,
    });

    toolCall.lastProgressContentLength = toolContent.length;
    if (lastBareGtIndex !== -1) {
      toolCall.lastProgressGtIndex = lastBareGtIndex;
    }
    return true;
  };

  const maybeEmitStreamingValueProgress = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
    toolCall: StreamingToolCallState,
    lazyContent: LazyToolContent
  ): boolean => {
    if (
      toolCall.streamingValueBodyStart === null ||
      toolCall.streamingValueArgsBase === null ||
      toolCall.lastProgressTrailingStringTag === null
    ) {
      return false;
    }
    if (lazyContent.length < toolCall.streamingValueNextEmitLength) {
      return true;
    }
    toolCall.streamingValueNextEmitLength =
      lazyContent.length + STREAMING_VALUE_EMIT_INTERVAL;

    let candidate: string;
    try {
      candidate = stringifyToolInputWithSchema({
        toolName: toolCall.name,
        args: {
          ...toolCall.streamingValueArgsBase,
          [toolCall.lastProgressTrailingStringTag]: toolCall.streamingValue,
        },
        tools,
      });
    } catch {
      return true;
    }
    emitMorphToolInputProgressDelta({
      controller,
      toolCall,
      fullInput: candidate,
      getToolContent: lazyContent.get,
    });
    return true;
  };

  const emitToolInputProgress = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
    toolCall: StreamingToolCallState,
    lazyContent: LazyToolContent
  ) => {
    if (tryIncrementalProgressShortcut(toolCall, lazyContent)) {
      if (!maybeEmitStreamingValueProgress(controller, toolCall, lazyContent)) {
        emitCachedToolInputProgress(controller, toolCall, lazyContent);
      }
      return;
    }

    const toolContent = lazyContent.get();
    const progressGtIndex = toolContent.lastIndexOf(">");
    const progressContentLength = toolContent.length;
    if (
      toolCall.lastProgressGtIndex === progressGtIndex &&
      toolCall.lastProgressContentLength === progressContentLength
    ) {
      emitCachedToolInputProgress(controller, toolCall, lazyContent);
      return;
    }

    const toolSchema = getMorphToolSchema(tools, toolCall.name);
    const { fullInput, trailingStringTag, trailingValueStreaming } =
      parseXmlContentForStreamProgressWithMeta({
        toolContent,
        toolName: toolCall.name,
        toolSchema,
        parseOptions,
        tools,
      });
    toolCall.lastProgressGtIndex = progressGtIndex;
    toolCall.lastProgressContentLength = progressContentLength;
    toolCall.lastProgressFullInput = fullInput;
    toolCall.lastProgressTrailingStringTag = trailingStringTag;
    toolCall.lastProgressPendingOpenAngle =
      toolContent.lastIndexOf("<") > progressGtIndex;
    if (trailingValueStreaming) {
      toolCall.streamingValueArgsBase = trailingValueStreaming.argsBase;
      toolCall.streamingValueBodyStart = trailingValueStreaming.bodyStart;
      toolCall.streamingValue = toolContent.slice(
        trailingValueStreaming.bodyStart
      );
      toolCall.streamingValueNextEmitLength =
        toolContent.length + STREAMING_VALUE_EMIT_INTERVAL;
    } else {
      toolCall.streamingValueArgsBase = null;
      toolCall.streamingValueBodyStart = null;
      toolCall.streamingValue = "";
      toolCall.streamingValueNextEmitLength = 0;
    }
    if (
      fullInput == null ||
      isEmptyMorphToolInputProgress(toolContent, fullInput)
    ) {
      return;
    }
    emitMorphToolInputProgressDelta({
      controller,
      toolCall,
      fullInput,
      getToolContent: () => toolContent,
    });
  };

  const finalizeUnclosedToolCall = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
  ) => {
    if (!currentToolCall) {
      return;
    }

    if (buffer.length > 0) {
      appendToolCallContent(currentToolCall, buffer);
      buffer = "";
    }
    const unclosedContent = getToolCallContent(currentToolCall);
    emitToolInputProgress(controller, currentToolCall, {
      length: unclosedContent.length,
      get: () => unclosedContent,
    });
    const parseConfig = {
      ...parseOptions,
      onError:
        options?.onError ??
        (parseOptions as { onError?: ParserOptions["onError"] } | undefined)
          ?.onError,
    };

    const toolSchema = getMorphToolSchema(tools, currentToolCall.name);
    flushText(controller);
    try {
      if (hasNonWhitespaceTopLevelText(unclosedContent)) {
        throw new Error(
          "Cannot reconcile unclosed XML tool call with top-level plain text."
        );
      }
      const parsedResult = parse(unclosedContent, toolSchema, parseConfig);
      const finalInput = stringifyToolInputWithSchema({
        toolName: currentToolCall.name,
        args: parsedResult,
        tools,
      });
      emitFinalizedBufferedToolInputLifecycle({
        bufferedParts: currentToolCall.pendingToolInputParts,
        controller,
        id: currentToolCall.toolCallId,
        state: currentToolCall,
        toolName: currentToolCall.name,
        finalInput,
        onMismatch: options?.onError,
      });
    } catch (error) {
      const unfinishedContent = `<${currentToolCall.name}>${unclosedContent}`;
      const emitRawFallback = shouldEmitRawToolCallTextOnError(options);
      emitFailedBufferedToolInputLifecycle({
        bufferedParts: currentToolCall.pendingToolInputParts,
        controller,
        id: currentToolCall.toolCallId,
        emitRawToolCallTextOnError: emitRawFallback,
        endInputOnError: currentToolCall.hasEmittedStart,
        hideBufferedInputOnError: isPrototypeSensitiveToolCallInputError(error),
        rawToolCallText: unfinishedContent,
        emitRawText: (rawText) => {
          flushText(controller, rawText);
        },
      });
      options?.onError?.(
        "Could not complete streaming XML tool call at finish.",
        {
          toolCall: safeToolCallMetadataText(unfinishedContent),
          toolCallId: currentToolCall.toolCallId,
          toolName: currentToolCall.name,
          dropReason: "unfinished-tool-call",
          error: safeToolCallMetadataError(error, unfinishedContent),
        }
      );
    }

    buffer = "";
    currentToolCall = null;
  };

  const processBuffer = createProcessBufferHandler({
    getBuffer: () => buffer,
    setBuffer: (newBuffer: string) => {
      buffer = newBuffer;
    },
    getCurrentToolCall: () => currentToolCall,
    setCurrentToolCall: (newToolCall: StreamingToolCallState | null) => {
      currentToolCall = newToolCall;
    },
    tools,
    parserOptions: options,
    toolNames,
    flushText,
    parseOptions,
    emitToolInputProgress,
    emitToolInputStart,
    findPotentialToolTagStart,
    findLinePrefixedToolCall: (text, _toolNames, allowAtBufferEnd) =>
      findStreamingLinePrefixedToolCall(text, tools, allowAtBufferEnd),
    findPotentialLinePrefixedToolCallStart,
    handleStreamingToolCallEnd,
  });

  return new TransformStream({
    transform(chunk, controller) {
      if (chunk.type === "finish") {
        processBuffer(controller, true);
        if (currentToolCall) {
          finalizeUnclosedToolCall(controller);
        } else if (buffer) {
          flushText(controller, buffer);
          buffer = "";
        }
        flushText(controller);
        controller.enqueue(chunk);
        return;
      }

      if (chunk.type === "text-start" || chunk.type === "text-end") {
        return;
      }

      if (isSideChannelStreamPart(chunk)) {
        controller.enqueue(chunk);
        return;
      }

      if (chunk.type !== "text-delta") {
        if (
          !currentToolCall &&
          buffer &&
          findPotentialLinePrefixedToolCallStart(buffer, toolNames) === -1
        ) {
          flushText(controller, buffer);
          buffer = "";
        }
        controller.enqueue(chunk);
        return;
      }

      const textContent = (chunk as unknown as { delta?: string }).delta ?? "";
      buffer += textContent;
      processBuffer(controller);
    },
    flush(controller) {
      processBuffer(controller, true);
      if (currentToolCall) {
        finalizeUnclosedToolCall(controller);
      } else if (buffer) {
        flushText(controller, buffer);
        buffer = "";
      }
      if (currentTextId && hasEmittedTextStart) {
        controller.enqueue({
          type: "text-end",
          id: currentTextId,
        });
        hasEmittedTextStart = false;
        currentTextId = null;
      }
    },
  });
}
