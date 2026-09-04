import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { parse } from "../../rxml";
import { generateToolCallId } from "../utils/id";
import {
  extractToolNames,
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../utils/protocol-utils";
import {
  shouldEmitRawToolCallTextOnError,
  stringifyToolInputWithSchema,
} from "../utils/tool-input-streaming";
import { hasNonWhitespaceTopLevelText } from "./morph-xml-progress-analysis";
import type { MorphXmlProtocolOptions } from "./morph-xml-protocol";
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
import {
  createProtocolSemanticChunkTransform,
  createProtocolTextLifecycle,
  finalizeBufferedToolInput,
} from "./protocol-stream-shared";

export function createMorphXmlStreamParser(params: {
  readonly tools: LanguageModelV4FunctionTool[];
  readonly options?: ParserOptions;
  readonly parseOptions: NonNullable<MorphXmlProtocolOptions["parseOptions"]>;
}): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  const { tools, options, parseOptions } = params;
  const toolNames = extractToolNames(tools);
  let buffer = "";
  let currentToolCall: StreamingToolCallState | null = null;
  const textLifecycle = createProtocolTextLifecycle();
  const { flushText } = textLifecycle;

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
      onError: options?.onError ?? parseOptions.onError,
    };

    const callState = currentToolCall;
    const toolSchema = getToolSchema(tools, callState.name);
    const unfinishedContent = `<${callState.name}>${unclosedContent}`;
    finalizeBufferedToolInput({
      controller,
      emitRawToolCallTextOnError: shouldEmitRawToolCallTextOnError(options),
      flushText,
      onMismatch: options?.onError,
      parseInput: () => {
        if (hasNonWhitespaceTopLevelText(unclosedContent)) {
          throw new Error(
            "Cannot reconcile unclosed XML tool call with top-level plain text."
          );
        }
        return parse(unclosedContent, toolSchema, parseConfig);
      },
      rawToolCallText: unfinishedContent,
      state: callState,
      tools,
      onFailure(caughtError) {
        options?.onError?.(
          "Could not complete streaming XML tool call at finish.",
          {
            toolCall: safeToolCallMetadataText(unfinishedContent),
            toolCallId: callState.toolCallId,
            toolName: callState.name,
            dropReason: "unfinished-tool-call",
            error: safeToolCallMetadataError(caughtError, unfinishedContent),
          }
        );
      },
    });

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

  return createProtocolSemanticChunkTransform({
    finish(controller) {
      finishPendingInput(controller);
      flushText(controller);
    },
    flush(controller) {
      finishPendingInput(controller);
      textLifecycle.close(controller);
    },
    passthrough(controller, chunk) {
      handleNonTextChunk(chunk, controller);
    },
    textDelta(controller, delta) {
      buffer += delta;
      processBuffer(controller);
    },
  });
}
