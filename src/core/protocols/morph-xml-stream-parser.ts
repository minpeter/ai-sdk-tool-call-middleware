import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { parse } from "../../rxml";
import { generateToolCallId } from "../utils/id";
import {
  createFlushTextHandler,
  extractToolNames,
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../utils/protocol-utils";
import {
  emitFailedBufferedToolInputLifecycle,
  emitFinalizedBufferedToolInputLifecycle,
  isPrototypeSensitiveToolCallInputError,
  shouldEmitRawToolCallTextOnError,
  stringifyToolInputWithSchema,
} from "../utils/tool-input-streaming";
import { hasNonWhitespaceTopLevelText } from "./morph-xml-progress-analysis";
import {
  emitMorphToolInputProgressDelta,
  foldInertRegionIntoStreamingValue,
  getToolSchema,
  handleStreamingToolCallEnd,
  isEmptyMorphToolInputProgress,
  STREAMING_VALUE_EMIT_INTERVAL,
  scanAppendedRegionForStructuralChars,
} from "./morph-xml-protocol";
import { parseXmlContentForStreamProgressWithMeta } from "./morph-xml-stream-progress";
import {
  appendToolCallContent,
  createProcessBufferHandler,
  getToolCallContent,
  type LazyToolContent,
  type StreamingToolCallState,
} from "./morph-xml-stream-state-machine";
import {
  findPotentialLinePrefixedToolCallStart,
  findPotentialToolTagStart,
  findStreamingLinePrefixedToolCall,
} from "./morph-xml-tool-call-finder";
import type { ParserOptions } from "./protocol-interface";

export function createMorphXmlStreamParser(params: {
  readonly tools: LanguageModelV4FunctionTool[];
  readonly options?: ParserOptions;
  readonly parseOptions: Record<string, unknown>;
}): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  const { tools, options, parseOptions } = params;
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

  /**
   * While the last full computation resolved through the
   * trailing-unclosed-string-tag branch, appended text without a tag
   * boundary lands inside that tag's body and cannot change the progress
   * result: the full-content parse still fails on the unclosed tag and
   * the repaired candidate is sliced at the (unchanged) opening tag. A
   * bare `>` is also inert unless an unterminated `<` precedes it.
   * Returns true when the cached result provably still holds, updating
   * the incremental bookkeeping — all without materializing the full
   * accumulated content.
   */
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

    // The chars to inspect are [prevLength, toolContent.length). Use the
    // appended tail when it covers that range; otherwise materialize.
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

  /**
   * Emit a live progress candidate for the streaming trailing string
   * value in capped bursts. Candidates are built by overriding the
   * trailing property on the cached args base; schema coercion keeps
   * strictly string-typed values as strings, so each candidate extends
   * the previously emitted prefix.
   */
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
      return true; // streaming active, next burst not due yet
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
    _controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
    toolCall: StreamingToolCallState,
    lazyContent: LazyToolContent
  ) => {
    if (tryIncrementalProgressShortcut(toolCall, lazyContent)) {
      if (
        !maybeEmitStreamingValueProgress(_controller, toolCall, lazyContent)
      ) {
        emitCachedToolInputProgress(_controller, toolCall, lazyContent);
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
      emitCachedToolInputProgress(_controller, toolCall, lazyContent);
      return;
    }

    const toolSchema = getToolSchema(tools, toolCall.name);
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
      // (Re)base the live value on the structural recompute: raw body so
      // far, args to build candidates from, and the next burst point.
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
      controller: _controller,
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

    // Any buffered text that processBuffer did not consume (e.g. when the
    // stream ends mid-chunk) still belongs to the unclosed call.
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

    const toolSchema = getToolSchema(tools, currentToolCall.name);
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

  const finishPendingInput = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
  ) => {
    processBuffer(controller, true);
    if (currentToolCall) {
      finalizeUnclosedToolCall(controller);
    } else if (buffer) {
      flushText(controller, buffer);
      buffer = "";
    }
  };

  const handleFinishChunk = (
    chunk: Extract<LanguageModelV4StreamPart, { type: "finish" }>,
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
  ) => {
    finishPendingInput(controller);
    flushText(controller);
    controller.enqueue(chunk);
  };

  const handleNonTextChunk = (
    chunk: Exclude<LanguageModelV4StreamPart, { type: "text-delta" }>,
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
  ) => {
    // Keep an open XML tool call alive across non-text stream chunks so
    // mixed-mode streams (e.g. reasoning) can continue to complete it.
    if (
      !currentToolCall &&
      buffer &&
      findPotentialLinePrefixedToolCallStart(buffer, toolNames) === -1
    ) {
      flushText(controller, buffer);
      buffer = "";
    }
    controller.enqueue(chunk);
  };

  const closeOpenTextSegment = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
  ) => {
    if (!(currentTextId && hasEmittedTextStart)) {
      return;
    }
    controller.enqueue({
      type: "text-end",
      id: currentTextId,
    });
    hasEmittedTextStart = false;
    currentTextId = null;
  };

  return new TransformStream({
    transform(chunk, controller) {
      if (chunk.type === "finish") {
        handleFinishChunk(chunk, controller);
        return;
      }

      // The parser re-segments text under its own synthetic ids (tool-call
      // markup is excised), so the provider's original text-start/text-end
      // envelopes are dropped instead of producing empty duplicate blocks.
      if (chunk.type === "text-start" || chunk.type === "text-end") {
        return;
      }

      if (chunk.type !== "text-delta") {
        handleNonTextChunk(chunk, controller);
        return;
      }

      buffer += chunk.delta ?? "";
      processBuffer(controller);
    },
    flush(controller) {
      finishPendingInput(controller);
      closeOpenTextSegment(controller);
    },
  });
}
