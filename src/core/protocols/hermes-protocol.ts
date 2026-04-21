import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
} from "@ai-sdk/provider";
import { parse as parseRJSON } from "../../rjson";
import { logParseFailure } from "../utils/debug";
import { getPotentialStartIndex } from "../utils/get-potential-start-index";
import { generateId, generateToolCallId } from "../utils/id";
import {
  addTextSegment,
  formatToolsWithPromptTemplate,
} from "../utils/protocol-utils";
import {
  emitToolInputProgressDelta,
  shouldEmitRawToolCallTextOnError,
  stringifyToolInputWithSchema,
} from "../utils/tool-input-streaming";
import type { ParserOptions, TCMProtocol } from "./protocol-interface";

interface HermesProtocolOptions {
  toolCallEnd?: string;
  toolCallStart?: string;
}

/**
 * Returns true if the current position in `json` is inside an unfinished
 * double-quoted string literal.  Only double quotes are tracked because
 * single-quote tracking would be confused by apostrophes in comments
 * (`parseRJSON` also supports `// ...` and block comments), and
 * models virtually never emit single-quoted JSON in tool calls.
 */
function isInsideJsonString(json: string): boolean {
  let inStr = false;
  let esc = false;
  for (const ch of json) {
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
    }
  }
  return inStr;
}

/**
 * Detect whether `segment` contains an occurrence of `startTag` outside any
 * JSON string literal. Used to identify nested `<tool_call>` start tags that
 * indicate the current tool call's `</tool_call>` actually belongs to a later
 * tool call (i.e. the current call is orphaned / malformed).
 */
function hasOuterToolCallStart(segment: string, startTag: string): boolean {
  let pos = 0;
  while (pos < segment.length) {
    const next = segment.indexOf(startTag, pos);
    if (next === -1) {
      return false;
    }
    if (!isInsideJsonString(segment.slice(0, next))) {
      return true;
    }
    pos = next + 1;
  }
  return false;
}

/**
 * Locate the next valid `<tool_call>...</tool_call>` span in `text` starting
 * at `searchFrom`. Skips `</tool_call>` sequences that occur inside JSON
 * string literals, and bails out when a nested `<tool_call>` start tag
 * appears outside a JSON string (treating the current start tag as orphaned
 * — its presumed close belongs to a later call).
 *
 * Returns:
 *   - `null`: no more start tags in the remaining text
 *   - `{ startIdx, found: true, jsonStart, endIdx }`: a valid span
 *   - `{ startIdx, found: false }`: an orphan start tag (caller should skip
 *     past it and resume scanning)
 */
function findNextToolCallSpan(
  text: string,
  searchFrom: number,
  startTag: string,
  endTag: string
):
  | { startIdx: number; found: true; jsonStart: number; endIdx: number }
  | { startIdx: number; found: false }
  | null {
  const startIdx = text.indexOf(startTag, searchFrom);
  if (startIdx === -1) {
    return null;
  }
  const jsonStart = startIdx + startTag.length;

  let endIdx = jsonStart;
  while (endIdx < text.length) {
    endIdx = text.indexOf(endTag, endIdx);
    if (endIdx === -1) {
      break;
    }
    const jsonSegment = text.slice(jsonStart, endIdx);
    if (!isInsideJsonString(jsonSegment)) {
      if (hasOuterToolCallStart(jsonSegment, startTag)) {
        // Nested <tool_call> outside JSON string — abandon this start,
        // its presumed </tool_call> belongs to a later call.
        return { startIdx, found: false };
      }
      return { startIdx, found: true, jsonStart, endIdx };
    }
    endIdx += 1;
  }
  return { startIdx, found: false };
}

function canonicalizeToolInput(argumentsValue: unknown): string {
  return JSON.stringify(argumentsValue ?? {});
}

function processToolCallJson(
  toolCallJson: string,
  fullMatch: string,
  processedElements: LanguageModelV3Content[],
  options?: ParserOptions
) {
  try {
    const parsedToolCall = parseRJSON(toolCallJson) as {
      name: string;
      arguments: unknown;
    };
    processedElements.push({
      type: "tool-call",
      toolCallId: generateToolCallId(),
      toolName: parsedToolCall.name,
      input: canonicalizeToolInput(parsedToolCall.arguments),
    });
  } catch (error) {
    logParseFailure({
      phase: "generated-text",
      reason: "Failed to parse tool call JSON segment",
      snippet: fullMatch,
      error,
    });
    options?.onError?.(
      "Could not process JSON tool call, keeping original text.",
      { toolCall: fullMatch, error }
    );
    processedElements.push({ type: "text", text: fullMatch });
  }
}

interface StreamState {
  activeToolInput: {
    id: string;
    toolName: string;
    emittedInput: string;
  } | null;
  buffer: string;
  currentTextId: string | null;
  currentToolCallJson: string;
  hasEmittedTextStart: boolean;
  isInsideToolCall: boolean;
}

type StreamController =
  TransformStreamDefaultController<LanguageModelV3StreamPart>;

interface TagProcessingContext {
  controller: StreamController;
  options?: ParserOptions;
  state: StreamState;
  toolCallEnd: string;
  toolCallStart: string;
  tools: LanguageModelV3FunctionTool[];
}

const WHITESPACE_JSON_REGEX = /\s/;

function skipJsonWhitespace(text: string, fromIndex: number): number {
  let index = fromIndex;
  while (index < text.length && WHITESPACE_JSON_REGEX.test(text[index])) {
    index += 1;
  }
  return index;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Streaming JSON key/value scanning requires explicit string-depth state tracking.
function findTopLevelPropertyValueStart(
  text: string,
  property: string
): number | null {
  const objectStart = skipJsonWhitespace(text, 0);
  if (objectStart >= text.length || text.charAt(objectStart) !== "{") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = objectStart; index < text.length; index += 1) {
    const char = text.charAt(index);

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (char !== '"') {
      continue;
    }

    if (depth !== 1) {
      inString = true;
      continue;
    }

    const keyStart = index + 1;
    let keyEnd = keyStart;
    let keyEscaped = false;
    while (keyEnd < text.length) {
      const keyChar = text.charAt(keyEnd);
      if (keyEscaped) {
        keyEscaped = false;
      } else if (keyChar === "\\") {
        keyEscaped = true;
      } else if (keyChar === '"') {
        break;
      }
      keyEnd += 1;
    }

    if (keyEnd >= text.length || text.charAt(keyEnd) !== '"') {
      return null;
    }

    const key = text.slice(keyStart, keyEnd);
    let valueCursor = skipJsonWhitespace(text, keyEnd + 1);
    if (valueCursor >= text.length || text.charAt(valueCursor) !== ":") {
      index = keyEnd;
      continue;
    }

    valueCursor = skipJsonWhitespace(text, valueCursor + 1);
    if (key === property) {
      return valueCursor < text.length ? valueCursor : null;
    }

    index = valueCursor - 1;
  }

  return null;
}

function extractTopLevelStringProperty(
  text: string,
  property: string
): string | undefined {
  const valueStart = findTopLevelPropertyValueStart(text, property);
  if (valueStart == null || valueStart >= text.length) {
    return undefined;
  }
  if (text.charAt(valueStart) !== '"') {
    return undefined;
  }

  let valueEnd = valueStart + 1;
  let escaped = false;
  while (valueEnd < text.length) {
    const char = text.charAt(valueEnd);
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      return text.slice(valueStart + 1, valueEnd);
    }
    valueEnd += 1;
  }

  return undefined;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Streaming JSON value slicing must handle nested arrays/objects and escaped strings.
function extractJsonValueSlice(
  text: string,
  valueStart: number
): {
  text: string;
  complete: boolean;
} | null {
  if (valueStart >= text.length) {
    return null;
  }

  const first = text.charAt(valueStart);
  if (first === "{" || first === "[") {
    const stack: string[] = [first];
    let inString = false;
    let escaped = false;

    for (let index = valueStart + 1; index < text.length; index += 1) {
      const char = text.charAt(index);
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        stack.push(char);
        continue;
      }

      if (char === "}" || char === "]") {
        const open = stack.at(-1);
        if ((open === "{" && char === "}") || (open === "[" && char === "]")) {
          stack.pop();
          if (stack.length === 0) {
            return {
              text: text.slice(valueStart, index + 1),
              complete: true,
            };
          }
        }
      }
    }

    return {
      text: text.slice(valueStart),
      complete: false,
    };
  }

  if (first === '"') {
    let escaped = false;
    for (let index = valueStart + 1; index < text.length; index += 1) {
      const char = text.charAt(index);
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        return {
          text: text.slice(valueStart, index + 1),
          complete: true,
        };
      }
    }
    return {
      text: text.slice(valueStart),
      complete: false,
    };
  }

  let index = valueStart;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "," || char === "}" || WHITESPACE_JSON_REGEX.test(char)) {
      break;
    }
    index += 1;
  }

  return {
    text: text.slice(valueStart, index),
    complete: index < text.length,
  };
}

function extractStreamingToolCallProgress(toolCallJson: string): {
  toolName: string | undefined;
  argumentsText: string | undefined;
  argumentsComplete: boolean;
} {
  const toolName = extractTopLevelStringProperty(toolCallJson, "name");
  const argsValueStart = findTopLevelPropertyValueStart(
    toolCallJson,
    "arguments"
  );
  if (argsValueStart == null) {
    return {
      toolName,
      argumentsText: undefined,
      argumentsComplete: false,
    };
  }

  const argsSlice = extractJsonValueSlice(toolCallJson, argsValueStart);
  return {
    toolName,
    argumentsText: argsSlice?.text,
    argumentsComplete: argsSlice?.complete ?? false,
  };
}

function ensureToolInputStart(
  state: StreamState,
  controller: StreamController,
  toolName: string
) {
  if (!state.activeToolInput) {
    const id = generateToolCallId();
    state.activeToolInput = {
      id,
      toolName,
      emittedInput: "",
    };
    controller.enqueue({
      type: "tool-input-start",
      id,
      toolName,
    } as LanguageModelV3StreamPart);
  }
}

function emitToolInputDelta(
  state: StreamState,
  controller: StreamController,
  fullInput: string
) {
  const active = state.activeToolInput;
  if (!active) {
    return;
  }

  emitToolInputProgressDelta({
    controller,
    id: active.id,
    state: active,
    fullInput,
    mode: "full-json",
  });
}

function closeToolInput(state: StreamState, controller: StreamController) {
  if (!state.activeToolInput) {
    return;
  }
  controller.enqueue({
    type: "tool-input-end",
    id: state.activeToolInput.id,
  } as LanguageModelV3StreamPart);
  state.activeToolInput = null;
}

function emitToolCallFromParsed(
  state: StreamState,
  controller: StreamController,
  parsedToolCall: { name: string; arguments: unknown },
  tools: LanguageModelV3FunctionTool[]
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
  ensureToolInputStart(state, controller, toolName);
  emitToolInputDelta(state, controller, input);
  const toolCallId = state.activeToolInput?.id ?? generateToolCallId();
  closeToolInput(state, controller);
  controller.enqueue({
    type: "tool-call",
    toolCallId,
    toolName,
    input,
  } as LanguageModelV3StreamPart);
}

function canonicalizeArgumentsProgressInput(
  progress: {
    argumentsText: string | undefined;
    argumentsComplete: boolean;
  },
  toolName: string,
  tools: LanguageModelV3FunctionTool[]
): string | undefined {
  if (progress.argumentsText === undefined || !progress.argumentsComplete) {
    return undefined;
  }

  try {
    const parsedArguments = parseRJSON(progress.argumentsText);
    return stringifyToolInputWithSchema({
      toolName,
      args: parsedArguments,
      tools,
      fallback: canonicalizeToolInput,
    });
  } catch {
    return undefined;
  }
}

function emitToolInputProgress(
  state: StreamState,
  controller: StreamController,
  tools: LanguageModelV3FunctionTool[]
) {
  if (!(state.isInsideToolCall && state.currentToolCallJson)) {
    return;
  }

  const progress = extractStreamingToolCallProgress(state.currentToolCallJson);
  if (!progress.toolName) {
    return;
  }

  ensureToolInputStart(state, controller, progress.toolName);
  const canonicalProgressInput = canonicalizeArgumentsProgressInput(
    progress,
    progress.toolName,
    tools
  );
  if (canonicalProgressInput !== undefined) {
    emitToolInputDelta(state, controller, canonicalProgressInput);
  }
}

function flushBuffer(
  state: StreamState,
  controller: StreamController,
  toolCallStart: string
) {
  if (state.buffer.length === 0) {
    return;
  }

  if (!state.currentTextId) {
    state.currentTextId = generateId();
    controller.enqueue({
      type: "text-start",
      id: state.currentTextId,
    } as LanguageModelV3StreamPart);
    state.hasEmittedTextStart = true;
  }

  const deltaContent = state.isInsideToolCall
    ? `${toolCallStart}${state.buffer}`
    : state.buffer;

  controller.enqueue({
    type: "text-delta",
    id: state.currentTextId,
    delta: deltaContent,
  } as LanguageModelV3StreamPart);
  state.buffer = "";
}

function closeTextBlock(state: StreamState, controller: StreamController) {
  if (state.currentTextId && state.hasEmittedTextStart) {
    controller.enqueue({
      type: "text-end",
      id: state.currentTextId,
    } as LanguageModelV3StreamPart);
    state.currentTextId = null;
    state.hasEmittedTextStart = false;
  }
}

function emitIncompleteToolCall(
  state: StreamState,
  controller: StreamController,
  toolCallStart: string,
  trailingBuffer: string,
  tools: LanguageModelV3FunctionTool[],
  options?: ParserOptions
) {
  if (!state.currentToolCallJson && trailingBuffer.length === 0) {
    state.isInsideToolCall = false;
    return;
  }

  if (state.currentToolCallJson) {
    try {
      const parsedToolCall = parseRJSON(state.currentToolCallJson) as {
        name: string;
        arguments: unknown;
      };
      emitToolCallFromParsed(state, controller, parsedToolCall, tools);
      state.currentToolCallJson = "";
      state.isInsideToolCall = false;
      return;
    } catch {
      // fall through to text fallback
    }
  }

  const rawToolCallContent = `${state.currentToolCallJson}${trailingBuffer}`;
  const errorContent = `${toolCallStart}${rawToolCallContent}`;
  const shouldEmitRawFallback = shouldEmitRawToolCallTextOnError(options);

  logParseFailure({
    phase: "stream",
    reason: shouldEmitRawFallback
      ? "Incomplete streaming tool call segment emitted as text"
      : "Incomplete streaming tool call segment suppressed without raw text fallback",
    snippet: errorContent,
  });

  if (shouldEmitRawFallback) {
    const errorId = generateId();
    controller.enqueue({
      type: "text-start",
      id: errorId,
    } as LanguageModelV3StreamPart);
    controller.enqueue({
      type: "text-delta",
      id: errorId,
      delta: errorContent,
    } as LanguageModelV3StreamPart);
    controller.enqueue({
      type: "text-end",
      id: errorId,
    } as LanguageModelV3StreamPart);
  }
  closeToolInput(state, controller);
  options?.onError?.(
    shouldEmitRawFallback
      ? "Could not complete streaming JSON tool call at finish; emitting original text."
      : "Could not complete streaming JSON tool call at finish.",
    { toolCall: errorContent }
  );
  state.currentToolCallJson = "";
  state.isInsideToolCall = false;
}

function handleFinishChunk(
  state: StreamState,
  controller: StreamController,
  toolCallStart: string,
  tools: LanguageModelV3FunctionTool[],
  options: ParserOptions | undefined,
  chunk: LanguageModelV3StreamPart
) {
  if (state.isInsideToolCall) {
    const trailingBuffer = state.buffer;
    state.buffer = "";
    emitIncompleteToolCall(
      state,
      controller,
      toolCallStart,
      trailingBuffer,
      tools,
      options
    );
  } else if (state.buffer.length > 0) {
    flushBuffer(state, controller, toolCallStart);
  }
  closeTextBlock(state, controller);
  controller.enqueue(chunk);
}

function publishText(
  text: string,
  state: StreamState,
  controller: StreamController,
  tools: LanguageModelV3FunctionTool[]
) {
  if (state.isInsideToolCall) {
    closeTextBlock(state, controller);
    state.currentToolCallJson += text;
    emitToolInputProgress(state, controller, tools);
  } else if (text.length > 0) {
    if (!state.currentTextId) {
      state.currentTextId = generateId();
      controller.enqueue({
        type: "text-start",
        id: state.currentTextId,
      } as LanguageModelV3StreamPart);
      state.hasEmittedTextStart = true;
    }
    controller.enqueue({
      type: "text-delta",
      id: state.currentTextId,
      delta: text,
    } as LanguageModelV3StreamPart);
  }
}

function emitToolCall(context: TagProcessingContext) {
  const { state, controller, toolCallStart, toolCallEnd, options, tools } =
    context;
  try {
    const parsedToolCall = parseRJSON(state.currentToolCallJson) as {
      name: string;
      arguments: unknown;
    };
    emitToolCallFromParsed(state, controller, parsedToolCall, tools);
  } catch (error) {
    const errorContent = `${toolCallStart}${state.currentToolCallJson}${toolCallEnd}`;
    const shouldEmitRawFallback = shouldEmitRawToolCallTextOnError(options);

    logParseFailure({
      phase: "stream",
      reason: "Failed to parse streaming tool call JSON segment",
      snippet: errorContent,
      error,
    });
    if (shouldEmitRawFallback) {
      const errorId = generateId();
      controller.enqueue({
        type: "text-start",
        id: errorId,
      } as LanguageModelV3StreamPart);
      controller.enqueue({
        type: "text-delta",
        id: errorId,
        delta: errorContent,
      } as LanguageModelV3StreamPart);
      controller.enqueue({
        type: "text-end",
        id: errorId,
      } as LanguageModelV3StreamPart);
    }
    closeToolInput(state, controller);
    options?.onError?.(
      shouldEmitRawFallback
        ? "Could not process streaming JSON tool call; emitting original text."
        : "Could not process streaming JSON tool call.",
      {
        toolCall: errorContent,
      }
    );
  }
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

function processBufferTags(context: TagProcessingContext) {
  const { state, controller, toolCallStart, toolCallEnd, tools } = context;
  let startIndex = getPotentialStartIndex(
    state.buffer,
    state.isInsideToolCall ? toolCallEnd : toolCallStart
  );

  while (startIndex != null) {
    const tag = state.isInsideToolCall ? toolCallEnd : toolCallStart;
    if (startIndex + tag.length > state.buffer.length) {
      break;
    }

    // When inside a tool call and we found an end tag, check whether
    // it falls inside a JSON string literal. If so, consume it as
    // content rather than treating it as a real closing tag.
    if (state.isInsideToolCall) {
      const jsonSoFar =
        state.currentToolCallJson + state.buffer.slice(0, startIndex);
      if (isInsideJsonString(jsonSoFar)) {
        // Consume through the false end tag as tool-call JSON content
        const consumeEnd = startIndex + tag.length;
        publishText(
          state.buffer.slice(0, consumeEnd),
          state,
          controller,
          tools
        );
        state.buffer = state.buffer.slice(consumeEnd);
        startIndex = getPotentialStartIndex(
          state.buffer,
          state.isInsideToolCall ? toolCallEnd : toolCallStart
        );
        continue;
      }
    }

    publishText(state.buffer.slice(0, startIndex), state, controller, tools);
    state.buffer = state.buffer.slice(startIndex + tag.length);
    processTagMatch(context);

    startIndex = getPotentialStartIndex(
      state.buffer,
      state.isInsideToolCall ? toolCallEnd : toolCallStart
    );
  }
}

function handlePartialTag(
  state: StreamState,
  controller: StreamController,
  toolCallStart: string,
  toolCallEnd: string,
  tools: LanguageModelV3FunctionTool[]
) {
  if (state.isInsideToolCall) {
    const potentialEndIndex = getPotentialStartIndex(state.buffer, toolCallEnd);
    if (
      potentialEndIndex != null &&
      potentialEndIndex + toolCallEnd.length > state.buffer.length
    ) {
      publishText(
        state.buffer.slice(0, potentialEndIndex),
        state,
        controller,
        tools
      );
      state.buffer = state.buffer.slice(potentialEndIndex);
    } else {
      publishText(state.buffer, state, controller, tools);
      state.buffer = "";
    }
    return;
  }

  const potentialIndex = getPotentialStartIndex(state.buffer, toolCallStart);
  if (
    potentialIndex != null &&
    potentialIndex + toolCallStart.length > state.buffer.length
  ) {
    publishText(
      state.buffer.slice(0, potentialIndex),
      state,
      controller,
      tools
    );
    state.buffer = state.buffer.slice(potentialIndex);
  } else {
    publishText(state.buffer, state, controller, tools);
    state.buffer = "";
  }
}

export const hermesProtocol = ({
  toolCallStart = "<tool_call>",
  toolCallEnd = "</tool_call>",
}: HermesProtocolOptions = {}): TCMProtocol => ({
  formatTools({
    tools,
    toolSystemPromptTemplate,
  }: {
    tools: LanguageModelV3FunctionTool[];
    toolSystemPromptTemplate: (tools: LanguageModelV3FunctionTool[]) => string;
  }) {
    return formatToolsWithPromptTemplate({ tools, toolSystemPromptTemplate });
  },

  formatToolCall(toolCall: LanguageModelV3ToolCall) {
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
    options,
  }: {
    text: string;
    tools: LanguageModelV3FunctionTool[];
    options?: ParserOptions;
  }) {
    const processedElements: LanguageModelV3Content[] = [];
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
        // Orphan start tag — emit everything up to and including it as text,
        // then continue searching for subsequent tool calls.
        const skipTo = span.startIdx + toolCallStart.length;
        if (skipTo > currentIndex) {
          addTextSegment(text.slice(currentIndex, skipTo), processedElements);
          currentIndex = skipTo;
        }
        searchFrom = skipTo;
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

      processToolCallJson(toolCallJson, fullMatch, processedElements, options);
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
    tools: LanguageModelV3FunctionTool[];
    options?: ParserOptions;
  }) {
    const state: StreamState = {
      isInsideToolCall: false,
      buffer: "",
      currentToolCallJson: "",
      currentTextId: null,
      hasEmittedTextStart: false,
      activeToolInput: null,
    };

    return new TransformStream<
      LanguageModelV3StreamPart,
      LanguageModelV3StreamPart
    >({
      transform(chunk, controller) {
        if (chunk.type === "finish") {
          handleFinishChunk(
            state,
            controller,
            toolCallStart,
            tools,
            options,
            chunk
          );
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
