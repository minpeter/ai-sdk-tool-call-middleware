import type {
  LanguageModelV3Content,
  LanguageModelV3ToolCall,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";

import { logParseFailure } from "../utils/debug";
import { getPotentialStartIndex } from "../utils/get-potential-start-index";
import { escapeRegExp } from "../utils/regex";
import { parse as parseRJSON } from "../utils/robust-json";

import type { ToolCallProtocol } from "./tool-call-protocol";

interface JsonMixOptions {
  toolCallStart?: string;
  toolCallEnd?: string;
  toolResponseStart?: string;
  toolResponseEnd?: string;
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
    if (options?.onError) {
      options.onError(
        "Could not process JSON tool call, keeping original text.",
        { toolCall: fullMatch, error }
      );
    }
    processedElements.push({ type: "text", text: fullMatch });
  }
}

function addTextSegment(
  text: string,
  processedElements: LanguageModelV3Content[]
) {
  if (text.trim()) {
    processedElements.push({ type: "text", text });
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

  // Add text before tool call if exists
  if (startIndex > currentIndex) {
    const textSegment = text.substring(currentIndex, startIndex);
    addTextSegment(textSegment, processedElements);
  }

  // Process tool call
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

type StreamController = TransformStreamDefaultController<unknown>;

interface StreamOptions {
  onError?: (message: string, metadata?: Record<string, unknown>) => void;
}

interface TagProcessingContext {
  state: StreamState;
  controller: StreamController;
  toolCallStart: string;
  toolCallEnd: string;
  options?: StreamOptions;
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
    controller.enqueue({ type: "text-start", id: state.currentTextId });
    state.hasEmittedTextStart = true;
  }

  const delta = state.isInsideToolCall
    ? `${toolCallStart}${state.buffer}`
    : state.buffer;

  controller.enqueue({
    type: "text-delta",
    id: state.currentTextId,
    delta,
  });
  state.buffer = "";
}

function closeTextBlock(state: StreamState, controller: StreamController) {
  if (state.currentTextId && state.hasEmittedTextStart) {
    controller.enqueue({ type: "text-end", id: state.currentTextId });
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
  controller.enqueue({ type: "text-start", id: errorId });
  controller.enqueue({
    type: "text-delta",
    id: errorId,
    delta: `${toolCallStart}${state.currentToolCallJson}`,
  });
  controller.enqueue({ type: "text-end", id: errorId });
  state.currentToolCallJson = "";
}

function handleFinishChunk(
  state: StreamState,
  controller: StreamController,
  toolCallStart: string,
  chunk: unknown
) {
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
      controller.enqueue({ type: "text-start", id: state.currentTextId });
      state.hasEmittedTextStart = true;
    }
    controller.enqueue({
      type: "text-delta",
      id: state.currentTextId,
      delta: text,
    });
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
    });
  } catch (error) {
    logParseFailure({
      phase: "stream",
      reason: "Failed to parse streaming tool call JSON segment",
      snippet: `${toolCallStart}${state.currentToolCallJson}${toolCallEnd}`,
      error,
    });
    const errorId = generateId();
    controller.enqueue({ type: "text-start", id: errorId });
    controller.enqueue({
      type: "text-delta",
      id: errorId,
      delta: `${toolCallStart}${state.currentToolCallJson}${toolCallEnd}`,
    });
    controller.enqueue({ type: "text-end", id: errorId });
    if (options?.onError) {
      options.onError(
        "Could not process streaming JSON tool call; emitting original text.",
        {
          toolCall: `${toolCallStart}${state.currentToolCallJson}${toolCallEnd}`,
        }
      );
    }
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

export const jsonMixProtocol = ({
  toolCallStart = "<tool_call>",
  toolCallEnd = "</tool_call>",
  toolResponseStart = "<tool_response>",
  toolResponseEnd = "</tool_response>",
}: JsonMixOptions = {}): ToolCallProtocol => ({
  formatTools({ tools, toolSystemPromptTemplate }) {
    const toolsForPrompt = (tools || [])
      .filter((tool) => tool.type === "function")
      .map((tool) => ({
        name: tool.name,
        description:
          tool.type === "function" && typeof tool.description === "string"
            ? tool.description
            : undefined,
        parameters: tool.inputSchema,
      }));
    return toolSystemPromptTemplate(JSON.stringify(toolsForPrompt));
  },

  formatToolCall(toolCall: LanguageModelV3ToolCall) {
    let args: unknown = {};
    try {
      args = JSON.parse(toolCall.input);
    } catch {
      args = toolCall.input;
    }
    return `${toolCallStart}${JSON.stringify({
      name: toolCall.toolName,
      arguments: args,
    })}${toolCallEnd}`;
  },

  formatToolResponse(toolResult: LanguageModelV3ToolResultPart) {
    return `${toolResponseStart}${JSON.stringify({
      toolName: toolResult.toolName,
      result: toolResult.output,
    })}${toolResponseEnd}`;
  },

  parseGeneratedText({ text, options }) {
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

    // Add remaining text
    if (currentIndex < text.length) {
      const remainingText = text.substring(currentIndex);
      addTextSegment(remainingText, processedElements);
    }

    return processedElements;
  },

  createStreamParser({ tools: _tools, options } = { tools: [] }) {
    const state: StreamState = {
      isInsideToolCall: false,
      buffer: "",
      currentToolCallJson: "",
      currentTextId: null,
      hasEmittedTextStart: false,
    };

    return new TransformStream({
      transform(chunk, controller) {
        if (chunk.type === "finish") {
          handleFinishChunk(state, controller, toolCallStart, chunk);
          return;
        }

        if (chunk.type !== "text-delta") {
          controller.enqueue(chunk);
          return;
        }

        state.buffer += chunk.delta;
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

  extractToolCallSegments({ text }) {
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
