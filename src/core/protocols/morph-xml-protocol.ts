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
import { parseXmlContentForStreamProgress } from "./morph-xml-stream-progress";
import {
  createProcessBufferHandler,
  type FlushTextFn,
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

function enqueueMorphToolInputProgressPart(options: {
  controller: TransformStreamDefaultController<LanguageModelV4StreamPart>;
  fullInput: string;
  part: LanguageModelV4StreamPart;
  toolCall: StreamingToolCallState;
  toolContent: string;
}): void {
  if (
    options.toolCall.pendingToolInputParts.length > 0 ||
    shouldBufferMorphToolInputProgress(options.toolContent, options.fullInput)
  ) {
    options.toolCall.pendingToolInputParts.push(options.part);
    return;
  }

  options.controller.enqueue(options.part);
}

function emitMorphToolInputProgressDelta(options: {
  controller: TransformStreamDefaultController<LanguageModelV4StreamPart>;
  fullInput: string;
  toolCall: StreamingToolCallState;
  toolContent: string;
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
          emittedInput: "",
          hasEmittedStart: true,
          lastProgressContentLength: null,
          lastProgressGtIndex: null,
          lastProgressFullInput: null,
          pendingToolInputParts: [],
        };
        controller.enqueue({
          type: "tool-input-start",
          id: next.toolCallId,
          toolName,
        });
        return next;
      };

      const emitToolInputProgress = (
        _controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
        toolCall: StreamingToolCallState,
        toolContent: string
      ) => {
        const progressGtIndex = toolContent.lastIndexOf(">");
        const progressContentLength = toolContent.length;
        if (
          toolCall.lastProgressGtIndex === progressGtIndex &&
          toolCall.lastProgressContentLength === progressContentLength
        ) {
          const cached = toolCall.lastProgressFullInput;
          if (cached == null) {
            return;
          }
          if (isEmptyMorphToolInputProgress(toolContent, cached)) {
            return;
          }
          emitMorphToolInputProgressDelta({
            controller: _controller,
            toolCall,
            toolContent,
            fullInput: cached,
          });
          return;
        }

        const toolSchema = getToolSchema(tools, toolCall.name);
        const fullInput = parseXmlContentForStreamProgress({
          toolContent,
          toolName: toolCall.name,
          toolSchema,
          parseOptions,
          tools,
        });
        toolCall.lastProgressGtIndex = progressGtIndex;
        toolCall.lastProgressContentLength = progressContentLength;
        toolCall.lastProgressFullInput = fullInput;
        if (fullInput == null) {
          return;
        }
        if (isEmptyMorphToolInputProgress(toolContent, fullInput)) {
          return;
        }
        emitMorphToolInputProgressDelta({
          controller: _controller,
          toolCall,
          toolContent,
          fullInput,
        });
      };

      const finalizeUnclosedToolCall = (
        controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
      ) => {
        if (!currentToolCall) {
          return;
        }

        emitToolInputProgress(controller, currentToolCall, buffer);
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
          if (hasNonWhitespaceTopLevelText(buffer)) {
            throw new Error(
              "Cannot reconcile unclosed XML tool call with top-level plain text."
            );
          }
          const parsedResult = parse(buffer, toolSchema, parseConfig);
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
          const unfinishedContent = `<${currentToolCall.name}>${buffer}`;
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
