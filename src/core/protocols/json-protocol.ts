import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
} from "@ai-sdk/provider";
import { parse as parseRJSON } from "../../rjson";
import { logParseFailure } from "../utils/debug";
import { getPotentialStartIndex } from "../utils/get-potential-start-index";
import { generateId } from "../utils/id";
import { addTextSegment } from "../utils/protocol-utils";
import { escapeRegExp } from "../utils/regex";
import type { TCMProtocol } from "./protocol-interface";

interface JsonProtocolOptions {
  toolCallStart?: string;
  toolCallEnd?: string;
}

interface ToolCallEnvelope {
  name: string;
  arguments: Record<string, unknown>;
}

interface ParsedToolCallPayload {
  toolName: string;
  input: string;
}

const WHITESPACE_CHAR_REGEX = /\s/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidToolCallEnvelope(
  payload: unknown
): payload is ToolCallEnvelope {
  if (!isRecord(payload)) {
    return false;
  }
  if (typeof payload.name !== "string" || payload.name.trim().length === 0) {
    return false;
  }
  if (!isRecord(payload.arguments)) {
    return false;
  }
  return true;
}

function isAllowedTrailingAfterJson(
  trailing: string,
  toolCallEnd: string
): boolean {
  const normalized = trailing.trim();
  if (normalized.length === 0) {
    return true;
  }
  return toolCallEnd.startsWith(normalized);
}

function splitUnclosedToolCallCandidate(
  text: string,
  toolCallStart: string,
  toolCallEnd: string
): { prefix: string; body: string } | null {
  const startIndex = text.indexOf(toolCallStart);
  if (startIndex < 0) {
    return null;
  }
  const contentStartIndex = startIndex + toolCallStart.length;
  if (text.indexOf(toolCallStart, contentStartIndex) >= 0) {
    return null;
  }
  if (text.indexOf(toolCallEnd, contentStartIndex) >= 0) {
    return null;
  }
  return {
    prefix: text.slice(0, startIndex),
    body: text.slice(contentStartIndex),
  };
}

function findLeadingJsonObjectStartIndex(text: string): number {
  let index = 0;
  while (index < text.length && WHITESPACE_CHAR_REGEX.test(text[index])) {
    index += 1;
  }
  if (index >= text.length || text[index] !== "{") {
    return -1;
  }
  return index;
}

function scanQuotedJsonChar(
  char: string,
  state: { inString: boolean; escaping: boolean }
) {
  if (state.escaping) {
    state.escaping = false;
    return;
  }
  if (char === "\\") {
    state.escaping = true;
    return;
  }
  if (char === '"') {
    state.inString = false;
  }
}

function scanJsonStructureChar(
  char: string,
  state: { depth: number; inString: boolean }
): boolean {
  if (char === '"') {
    state.inString = true;
    return false;
  }
  if (char === "{") {
    state.depth += 1;
    return false;
  }
  if (char === "}") {
    state.depth -= 1;
    return state.depth === 0;
  }
  return false;
}

function extractLeadingBalancedJsonObject(
  text: string
): { jsonText: string; trailing: string } | null {
  const startIndex = findLeadingJsonObjectStartIndex(text);
  if (startIndex < 0) {
    return null;
  }

  const scanState = {
    depth: 0,
    inString: false,
    escaping: false,
  };

  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];
    if (scanState.inString) {
      scanQuotedJsonChar(char, scanState);
      continue;
    }

    if (scanJsonStructureChar(char, scanState)) {
      return {
        jsonText: text.slice(startIndex, i + 1),
        trailing: text.slice(i + 1),
      };
    }
  }

  return null;
}

function parseStrictToolCallPayload(
  jsonText: string
): ParsedToolCallPayload | null {
  try {
    const parsedPayload = parseRJSON(jsonText);
    if (!isValidToolCallEnvelope(parsedPayload)) {
      return null;
    }
    return {
      toolName: parsedPayload.name.trim(),
      input: JSON.stringify(parsedPayload.arguments),
    };
  } catch {
    return null;
  }
}

function recoverUnclosedToolCallFromBody(
  body: string,
  toolCallEnd: string
): ParsedToolCallPayload | null {
  const leadingJson = extractLeadingBalancedJsonObject(body);
  if (!leadingJson) {
    return null;
  }
  if (!isAllowedTrailingAfterJson(leadingJson.trailing, toolCallEnd)) {
    return null;
  }
  return parseStrictToolCallPayload(leadingJson.jsonText);
}

function recoverUnclosedToolCallInGeneratedText(options: {
  text: string;
  toolCallStart: string;
  toolCallEnd: string;
}): LanguageModelV3Content[] | null {
  const { text, toolCallStart, toolCallEnd } = options;
  const candidate = splitUnclosedToolCallCandidate(
    text,
    toolCallStart,
    toolCallEnd
  );
  if (!candidate) {
    return null;
  }

  const recovered = recoverUnclosedToolCallFromBody(
    candidate.body,
    toolCallEnd
  );
  if (!recovered) {
    return null;
  }

  const output: LanguageModelV3Content[] = [];
  addTextSegment(candidate.prefix, output);
  output.push({
    type: "tool-call",
    toolCallId: generateId(),
    toolName: recovered.toolName,
    input: recovered.input,
  });
  return output;
}

function tryRecoverIncompleteToolCallAtFinish(options: {
  state: StreamState;
  controller: StreamController;
  toolCallEnd: string;
}): boolean {
  const { state, controller, toolCallEnd } = options;
  if (!state.isInsideToolCall) {
    return false;
  }

  const body = `${state.currentToolCallJson}${state.buffer}`;
  const recovered = recoverUnclosedToolCallFromBody(body, toolCallEnd);
  if (!recovered) {
    return false;
  }

  closeTextBlock(state, controller);
  controller.enqueue({
    type: "tool-call",
    toolCallId: generateId(),
    toolName: recovered.toolName,
    input: recovered.input,
  } as LanguageModelV3StreamPart);

  state.currentToolCallJson = "";
  state.buffer = "";
  state.isInsideToolCall = false;
  return true;
}

function processToolCallJson(
  toolCallJson: string,
  fullMatch: string,
  processedElements: LanguageModelV3Content[],
  options?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  }
) {
  try {
    const parsedToolCall = parseRJSON(toolCallJson) as {
      name: string;
      arguments: unknown;
    };
    processedElements.push({
      type: "tool-call",
      toolCallId: generateId(),
      toolName: parsedToolCall.name,
      input: JSON.stringify(parsedToolCall.arguments ?? {}),
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

interface ParseContext {
  match: RegExpExecArray;
  text: string;
  currentIndex: number;
  processedElements: LanguageModelV3Content[];
  options?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  };
}

function processMatchedToolCall(context: ParseContext): number {
  const { match, text, currentIndex, processedElements, options } = context;
  const startIndex = match.index;
  const toolCallJson = match[1];

  if (startIndex > currentIndex) {
    const textSegment = text.substring(currentIndex, startIndex);
    addTextSegment(textSegment, processedElements);
  }

  if (toolCallJson) {
    processToolCallJson(toolCallJson, match[0], processedElements, options);
  }

  return startIndex + match[0].length;
}

interface StreamState {
  isInsideToolCall: boolean;
  buffer: string;
  currentToolCallJson: string;
  currentTextId: string | null;
  hasEmittedTextStart: boolean;
}

type StreamController =
  TransformStreamDefaultController<LanguageModelV3StreamPart>;

interface TagProcessingContext {
  state: StreamState;
  controller: StreamController;
  toolCallStart: string;
  toolCallEnd: string;
  options?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  };
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
  toolCallStart: string
) {
  if (!state.currentToolCallJson) {
    return;
  }

  logParseFailure({
    phase: "stream",
    reason: "Incomplete streaming tool call segment emitted as text",
    snippet: `${toolCallStart}${state.currentToolCallJson}`,
  });

  const errorId = generateId();
  const errorContent = `${toolCallStart}${state.currentToolCallJson}`;
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
  state.currentToolCallJson = "";
}

function handleFinishChunk(
  state: StreamState,
  controller: StreamController,
  toolCallStart: string,
  toolCallEnd: string,
  chunk: LanguageModelV3StreamPart
) {
  if (
    tryRecoverIncompleteToolCallAtFinish({
      state,
      controller,
      toolCallEnd,
    })
  ) {
    controller.enqueue(chunk);
    return;
  }
  if (state.buffer.length > 0) {
    flushBuffer(state, controller, toolCallStart);
  }
  closeTextBlock(state, controller);
  emitIncompleteToolCall(state, controller, toolCallStart);
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
  const { state, controller, toolCallStart, toolCallEnd, options } = context;
  try {
    const parsedToolCall = parseRJSON(state.currentToolCallJson) as {
      name: string;
      arguments: unknown;
    };
    closeTextBlock(state, controller);
    controller.enqueue({
      type: "tool-call",
      toolCallId: generateId(),
      toolName: parsedToolCall.name,
      input: JSON.stringify(parsedToolCall.arguments ?? {}),
    } as LanguageModelV3StreamPart);
  } catch (error) {
    logParseFailure({
      phase: "stream",
      reason: "Failed to parse streaming tool call JSON segment",
      snippet: `${toolCallStart}${state.currentToolCallJson}${toolCallEnd}`,
      error,
    });
    const errorId = generateId();
    const errorContent = `${toolCallStart}${state.currentToolCallJson}${toolCallEnd}`;
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
    options?.onError?.(
      "Could not process streaming JSON tool call; emitting original text.",
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
  }
}

function processBufferTags(context: TagProcessingContext) {
  const { state, controller, toolCallStart, toolCallEnd } = context;
  let startIndex = getPotentialStartIndex(
    state.buffer,
    state.isInsideToolCall ? toolCallEnd : toolCallStart
  );

  while (startIndex != null) {
    const tag = state.isInsideToolCall ? toolCallEnd : toolCallStart;
    if (startIndex + tag.length > state.buffer.length) {
      break;
    }

    publishText(state.buffer.slice(0, startIndex), state, controller);
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
  toolCallStart: string
) {
  if (state.isInsideToolCall) {
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

export const jsonProtocol = ({
  toolCallStart = "<tool_call>",
  toolCallEnd = "</tool_call>",
}: JsonProtocolOptions = {}): TCMProtocol => ({
  formatTools({
    tools,
    toolSystemPromptTemplate,
  }: {
    tools: LanguageModelV3FunctionTool[];
    toolSystemPromptTemplate: (tools: LanguageModelV3FunctionTool[]) => string;
  }) {
    return toolSystemPromptTemplate(tools || []);
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
    options?: {
      onError?: (message: string, metadata?: Record<string, unknown>) => void;
    };
  }) {
    const startEsc = escapeRegExp(toolCallStart);
    const endEsc = escapeRegExp(toolCallEnd);
    const toolCallRegex = new RegExp(
      `${startEsc}([\u0000-\uFFFF]*?)${endEsc}`,
      "gs"
    );

    const processedElements: LanguageModelV3Content[] = [];
    let currentIndex = 0;
    let match = toolCallRegex.exec(text);

    while (match !== null) {
      currentIndex = processMatchedToolCall({
        match,
        text,
        currentIndex,
        processedElements,
        options,
      });
      match = toolCallRegex.exec(text);
    }

    if (currentIndex < text.length) {
      const remainingText = text.substring(currentIndex);
      addTextSegment(remainingText, processedElements);
    }

    const hasToolCall = processedElements.some(
      (part) => part.type === "tool-call"
    );
    if (!hasToolCall) {
      const recovered = recoverUnclosedToolCallInGeneratedText({
        text,
        toolCallStart,
        toolCallEnd,
      });
      if (recovered) {
        return recovered;
      }
    }

    return processedElements;
  },

  createStreamParser({
    options,
  }: {
    tools: LanguageModelV3FunctionTool[];
    options?: {
      onError?: (message: string, metadata?: Record<string, unknown>) => void;
    };
  }) {
    const state: StreamState = {
      isInsideToolCall: false,
      buffer: "",
      currentToolCallJson: "",
      currentTextId: null,
      hasEmittedTextStart: false,
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
            toolCallEnd,
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
        });
        handlePartialTag(state, controller, toolCallStart);
      },
    });
  },

  extractToolCallSegments({ text }: { text: string }) {
    const startEsc = escapeRegExp(toolCallStart);
    const endEsc = escapeRegExp(toolCallEnd);
    const regex = new RegExp(`${startEsc}([\u0000-\uFFFF]*?)${endEsc}`, "gs");
    const segments: string[] = [];
    let m = regex.exec(text);
    while (m != null) {
      segments.push(m[0]);
      m = regex.exec(text);
    }
    return segments;
  },
});
