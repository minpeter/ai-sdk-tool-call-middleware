import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import { parse, stringify } from "../../rxml";
import { recoverToolCallFromJsonCandidatesWithStatus } from "../utils/generated-text-json-recovery";
import { generateToolCallId } from "../utils/id";
import {
  createFlushTextHandler,
  extractToolNames,
  formatToolsWithPromptTemplate,
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../utils/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import { shouldBufferToolInputProgress } from "../utils/tool-call-progress-buffering";
import {
  emitBufferedToolInputProgressDelta,
  emitFailedBufferedToolInputLifecycle,
  emitFinalizedBufferedToolInputLifecycle,
  isPrototypeSensitiveToolCallInputError,
  shouldEmitRawToolCallTextOnError,
  stringifyToolInputWithSchema,
} from "../utils/tool-input-streaming";
import {
  hasNonWhitespaceTopLevelText,
  plainTextBodyFallback,
} from "./morph-xml-progress-analysis";
import { parseXmlContentForStreamProgressWithMeta } from "./morph-xml-stream-progress";
import {
  appendToolCallContent,
  createProcessBufferHandler,
  type FlushTextFn,
  getToolCallContent,
  type LazyToolContent,
  type StreamingToolCallState,
} from "./morph-xml-stream-state-machine";
import {
  findPotentialLinePrefixedToolCallStart,
  findPotentialToolTagStart,
  findStreamingLinePrefixedToolCall,
  findToolCalls,
  findToolCallsWithFallbacks,
} from "./morph-xml-tool-call-finder";
import type { ParserOptions, TCMCoreProtocol } from "./protocol-interface";

const XML_PROGRESS_TAG_NAME_REGEX = /^[A-Za-z_][\w.:-]*/;

export interface MorphXmlProtocolOptions {
  parseOptions?: {
    repair?: boolean;
    maxReparses?: number;
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
    noChildNodes?: string[];
    [key: string]: unknown;
  };
}

function getToolSchema(tools: LanguageModelV4FunctionTool[], toolName: string) {
  return tools.find((t) => t.name === toolName)?.inputSchema;
}

interface ProcessToolCallParams {
  options?: ParserOptions;
  parseOptions?: Record<string, unknown>;
  processedElements: LanguageModelV4Content[];
  text: string;
  toolCall: {
    toolName: string;
    content: string;
    startIndex: number;
    endIndex: number;
  };
  tools: LanguageModelV4FunctionTool[];
}

function allowPlainTextBodyFallback(
  parseOptions?: Record<string, unknown>
): boolean {
  return parseOptions?.repair !== false;
}

function processToolCall(params: ProcessToolCallParams): void {
  const { toolCall, tools, options, text, processedElements, parseOptions } =
    params;
  const toolSchema = getToolSchema(tools, toolCall.toolName);

  const parseConfig = {
    ...(parseOptions ?? {}),
    onError:
      options?.onError ??
      (parseOptions as { onError?: ParserOptions["onError"] } | undefined)
        ?.onError,
  };

  try {
    const parsed =
      (allowPlainTextBodyFallback(parseOptions)
        ? plainTextBodyFallback(toolCall.content, toolSchema)
        : null) ?? parse(toolCall.content, toolSchema, parseConfig);
    processedElements.push({
      type: "tool-call",
      toolCallId: generateToolCallId(),
      toolName: toolCall.toolName,
      input: stringifyToolInputWithSchema({
        toolName: toolCall.toolName,
        args: parsed,
        tools,
      }),
    });
  } catch (error) {
    const originalCallText = text.slice(toolCall.startIndex, toolCall.endIndex);
    options?.onError?.(
      `Could not process XML tool call: ${toolCall.toolName}`,
      {
        toolCall: safeToolCallMetadataText(originalCallText),
        error: safeToolCallMetadataError(error, originalCallText),
        toolName: toolCall.toolName,
        toolCallId: generateToolCallId(),
        dropReason: "malformed-tool-call-body",
      }
    );
    if (toolCallTextHasPrototypeSensitiveKey(originalCallText)) {
      return;
    }
    processedElements.push({ type: "text", text: originalCallText });
  }
}

interface HandleStreamingToolCallEndParams {
  ctrl: TransformStreamDefaultController<LanguageModelV4StreamPart>;
  currentToolCall: StreamingToolCallState;
  flushText: FlushTextFn;
  options?: ParserOptions;
  parseOptions?: Record<string, unknown>;
  toolContent: string;
  tools: LanguageModelV4FunctionTool[];
}

function handleStreamingToolCallEnd(
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
  const toolSchema = getToolSchema(tools, currentToolCall.name);
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

function isEmptyMorphToolInputProgress(
  toolContent: string,
  fullInput: string
): boolean {
  return fullInput === "{}" && toolContent.trim().length === 0;
}

/**
 * Scan the appended content region [from, to) for characters that could
 * change the structural parse: any `<`, or a `>` while an unterminated `<`
 * is pending. Returns whether such a character was found and the absolute
 * index of the last bare `>` seen before it (or before the region end).
 */
function scanAppendedRegionForStructuralChars(options: {
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

function enqueueMorphToolInputProgressPart(options: {
  controller: TransformStreamDefaultController<LanguageModelV4StreamPart>;
  fullInput: string;
  getToolContent: () => string;
  part: LanguageModelV4StreamPart;
  toolCall: StreamingToolCallState;
}): void {
  if (
    options.toolCall.pendingToolInputParts.length > 0 ||
    shouldBufferMorphToolInputProgress(
      options.getToolContent(),
      options.fullInput
    )
  ) {
    options.toolCall.pendingToolInputParts.push(options.part);
    return;
  }

  options.controller.enqueue(options.part);
}

function emitMorphToolInputProgressDelta(options: {
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

function pushGeneratedTextSegment(
  processedElements: LanguageModelV4Content[],
  text: string,
  tools: LanguageModelV4FunctionTool[]
): void {
  const recovered = recoverToolCallFromJsonCandidatesWithStatus(text, tools);
  if (
    recovered.kind === "recovered" ||
    recovered.kind === "dropped-sensitive-candidate"
  ) {
    processedElements.push(...recovered.content);
    return;
  }
  processedElements.push({ type: "text", text });
}

export const morphXmlProtocol = (
  protocolOptions?: MorphXmlProtocolOptions
): TCMCoreProtocol => {
  const parseOptions = {
    repair: true,
    noChildNodes: [],
    ...(protocolOptions?.parseOptions ?? {}),
  };

  return {
    formatTools({ tools, toolSystemPromptTemplate }) {
      return formatToolsWithPromptTemplate({ tools, toolSystemPromptTemplate });
    },

    formatToolCall(toolCall: LanguageModelV4ToolCall): string {
      let args: unknown = {};
      if (toolCall.input != null) {
        try {
          args = JSON.parse(toolCall.input);
        } catch {
          args = toolCall.input;
        }
      }
      return stringify(toolCall.toolName, args, {
        suppressEmptyNode: false,
        format: true,
        minimalEscaping: true,
      });
    },

    parseGeneratedText({ text, tools, options }) {
      const toolNames = extractToolNames(tools);
      if (toolNames.length === 0) {
        return [{ type: "text", text }];
      }

      const processedElements: LanguageModelV4Content[] = [];
      let currentIndex = 0;

      const { parseText, toolCalls } = findToolCallsWithFallbacks(text, tools);

      for (const tc of toolCalls) {
        if (tc.startIndex > currentIndex) {
          pushGeneratedTextSegment(
            processedElements,
            parseText.slice(currentIndex, tc.startIndex),
            tools
          );
        }
        processToolCall({
          toolCall: tc,
          tools,
          options,
          text: parseText,
          processedElements,
          parseOptions,
        });
        currentIndex = tc.endIndex;
      }

      if (currentIndex < parseText.length) {
        pushGeneratedTextSegment(
          processedElements,
          parseText.slice(currentIndex),
          tools
        );
      }

      return processedElements;
    },

    createStreamParser({ tools, options }) {
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
        const { lastBareGtIndex, structural } =
          scanAppendedRegionForStructuralChars({
            from: prevLength,
            inspected: useTail ? tail : toolContent.get(),
            inspectedStart: useTail ? tailStart : 0,
            pendingOpenAngle: toolCall.lastProgressPendingOpenAngle,
            to: toolContent.length,
          });
        if (structural) {
          return false;
        }

        toolCall.lastProgressContentLength = toolContent.length;
        if (lastBareGtIndex !== -1) {
          toolCall.lastProgressGtIndex = lastBareGtIndex;
        }
        return true;
      };

      const emitToolInputProgress = (
        _controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
        toolCall: StreamingToolCallState,
        lazyContent: LazyToolContent
      ) => {
        if (tryIncrementalProgressShortcut(toolCall, lazyContent)) {
          emitCachedToolInputProgress(_controller, toolCall, lazyContent);
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
        const { fullInput, trailingStringTag } =
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
        if (fullInput == null) {
          return;
        }
        if (isEmptyMorphToolInputProgress(toolContent, fullInput)) {
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
            hideBufferedInputOnError:
              isPrototypeSensitiveToolCallInputError(error),
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
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Stateful stream parsing requires branching over chunk lifecycle and parser states.
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

          // The parser re-segments text under its own synthetic ids (tool-call
          // markup is excised), so the provider's original text-start/text-end
          // envelopes are dropped instead of producing empty duplicate blocks.
          if (chunk.type === "text-start" || chunk.type === "text-end") {
            return;
          }

          if (chunk.type !== "text-delta") {
            if (currentToolCall) {
              // Keep an open XML tool call alive across non-text stream chunks
              // so mixed-mode streams (e.g. reasoning) can continue to complete it.
            } else if (
              buffer &&
              findPotentialLinePrefixedToolCallStart(buffer, toolNames) === -1
            ) {
              flushText(controller, buffer);
              buffer = "";
            }
            controller.enqueue(chunk);
            return;
          }

          const textContent =
            (chunk as unknown as { delta?: string }).delta ?? "";
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
    },

    extractToolCallSegments({ text, tools }) {
      const toolNames = tools.map((t) => t.name).filter(Boolean) as string[];
      if (toolNames.length === 0) {
        return [];
      }

      return findToolCalls(text, toolNames).map((tc) => tc.segment);
    },
  };
};
