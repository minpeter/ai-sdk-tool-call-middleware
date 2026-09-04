import {
  isJSONObject,
  type LanguageModelV4Content,
  type LanguageModelV4FunctionTool,
  type LanguageModelV4StreamPart,
  type LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import type { RxmlValue } from "../../rxml/builders/stringify";
import {
  parse,
  type ParseOptions as RxmlParseOptions,
  stringify,
} from "../../rxml/index";
import {
  isSchemaDefinition,
  type ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
import { recoverToolCallFromJsonCandidatesWithStatus } from "../utils/generated-text-json-recovery";
import { generateToolCallId } from "../utils/id";
import {
  extractToolNames,
  formatToolsWithPromptTemplate,
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../utils/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import { shouldBufferToolInputProgress } from "../utils/tool-call-progress-buffering";
import {
  emitBufferedToolInputProgressDelta,
  shouldEmitRawToolCallTextOnError,
  stringifyToolInputWithSchema,
} from "../utils/tool-input-streaming";
import { plainTextBodyFallback } from "./morph-xml-progress-analysis";
import { createMorphXmlStreamParser } from "./morph-xml-stream-parser";
import type {
  FlushTextFn,
  StreamingToolCallState,
} from "./morph-xml-stream-state-machine";
import {
  findToolCalls,
  findToolCallsWithFallbacks,
} from "./morph-xml-tool-call-finder";
import type { ParserOptions, TCMCoreProtocol } from "./protocol-interface";
import { finalizeBufferedToolInput } from "./protocol-stream-shared";

const XML_PROGRESS_TAG_NAME_REGEX = /^[A-Za-z_][\w.:-]*/;

export interface MorphXmlProtocolOptions {
  parseOptions?: RxmlParseOptions;
}

type MorphXmlParseOptions = NonNullable<
  MorphXmlProtocolOptions["parseOptions"]
>;

export function getToolSchema(
  tools: LanguageModelV4FunctionTool[],
  toolName: string
): ToolInputSchemaDefinition | undefined {
  const inputSchema = tools.find((tool) => tool.name === toolName)?.inputSchema;
  return isSchemaDefinition(inputSchema) ? inputSchema : undefined;
}

interface ProcessToolCallParams {
  options?: ParserOptions;
  parseOptions?: MorphXmlParseOptions;
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
  parseOptions?: MorphXmlParseOptions
): boolean {
  return parseOptions?.repair !== false;
}

function processToolCall(params: ProcessToolCallParams): void {
  const { toolCall, tools, options, text, processedElements, parseOptions } =
    params;
  const toolSchema = getToolSchema(tools, toolCall.toolName);

  const parseConfig = {
    ...(parseOptions ?? {}),
    onError: options?.onError ?? parseOptions?.onError,
  };

  try {
    const parsed =
      (allowPlainTextBodyFallback(parseOptions)
        ? plainTextBodyFallback(toolCall.content, toolSchema)
        : null) ?? parse(toolCall.content, toolSchema, parseConfig);
    if (!isJSONObject(parsed)) {
      throw new Error("XML tool call arguments must be an object");
    }
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
    const caughtError =
      error instanceof Error ? error : new Error(String(error));
    const originalCallText = text.slice(toolCall.startIndex, toolCall.endIndex);
    options?.onError?.(
      `Could not process XML tool call: ${toolCall.toolName}`,
      {
        toolCall: safeToolCallMetadataText(originalCallText),
        error: safeToolCallMetadataError(caughtError, originalCallText),
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
  parseOptions?: MorphXmlParseOptions;
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
  const toolSchema = getToolSchema(tools, currentToolCall.name);
  const parseConfig = {
    ...(parseOptions ?? {}),
    onError: options?.onError ?? parseOptions?.onError,
  };

  const original = `<${currentToolCall.name}>${toolContent}</${currentToolCall.name}>`;
  finalizeBufferedToolInput({
    controller: ctrl,
    emitRawToolCallTextOnError: shouldEmitRawToolCallTextOnError(options),
    flushText,
    onMismatch: options?.onError,
    parseInput: () =>
      (allowPlainTextBodyFallback(parseOptions)
        ? plainTextBodyFallback(toolContent, toolSchema)
        : null) ?? parse(toolContent, toolSchema, parseConfig),
    rawToolCallText: original,
    state: currentToolCall,
    tools,
    onFailure(caughtError) {
      options?.onError?.("Could not process streaming XML tool call", {
        toolCall: safeToolCallMetadataText(original),
        error: safeToolCallMetadataError(caughtError, original),
        toolName: currentToolCall.name,
        toolCallId: currentToolCall.toolCallId,
        dropReason: "malformed-tool-call-body",
      });
    },
  });
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

/**
 * Cap between progress-candidate rebuilds while live-streaming a trailing
 * string value. Each rebuild stringifies the full args (O(total)), so bursts
 * keep total work bounded while still updating the UI every ~1KB of content.
 */
export const STREAMING_VALUE_EMIT_INTERVAL = 1024;

/**
 * Fold an inert appended region into the live-streamed trailing string
 * value. Raw-slice extraction is the identity transform for strictly
 * string-typed properties, so the accumulated raw chars stay a prefix of the
 * final value.
 */
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

/**
 * Scan the appended content region [from, to) for characters that could
 * change the structural parse: any `<`, or a `>` while an unterminated `<`
 * is pending. Returns whether such a character was found and the absolute
 * index of the last bare `>` seen before it (or before the region end).
 */
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

// The buffering decision is O(fullInput) (JSON parse + walk); progress
// bursts enqueue several 512-char parts for the same fullInput/content pair,
// so memoize by reference identity per tool call.
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
      let args: RxmlValue = {};
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
      return createMorphXmlStreamParser({ tools, options, parseOptions });
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
