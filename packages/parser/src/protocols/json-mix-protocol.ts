import type {
  LanguageModelV2Content,
  LanguageModelV2ToolCall,
  LanguageModelV2ToolResultPart,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";

import {
  escapeRegExp,
  getPotentialStartIndex,
  parseRJSON,
  RJSON,
} from "@/utils";

import type { ToolCallProtocol } from "./tool-call-protocol";

type JsonMixOptions = {
  toolCallStart?: string;
  toolCallEnd?: string;
  toolResponseStart?: string;
  toolResponseEnd?: string;
};

function processToolCallJson(
  toolCallJson: string,
  fullMatch: string,
  processedElements: LanguageModelV2Content[],
  options?: { onError?: (message: string, details: unknown) => void }
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
    if (options?.onError) {
      options.onError(
        "Could not process JSON tool call, keeping original text.",
        { toolCall: fullMatch, error }
      );
    }
    processedElements.push({ type: "text", text: fullMatch });
  }
}

type StreamState = {
  isInsideToolCall: boolean;
  buffer: string;
  currentToolCallJson: string;
  currentTextId: string | null;
  hasEmittedTextStart: boolean;
};

function flushBuffer(
  state: StreamState,
  controller: TransformStreamDefaultController<any>,
  toolCallStart: string
) {
  if (state.buffer.length === 0) return;

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

function closeTextBlock(
  state: StreamState,
  controller: TransformStreamDefaultController<any>
) {
  if (state.currentTextId && state.hasEmittedTextStart) {
    controller.enqueue({ type: "text-end", id: state.currentTextId });
    state.currentTextId = null;
    state.hasEmittedTextStart = false;
  }
}

function emitIncompleteToolCall(
  state: StreamState,
  controller: TransformStreamDefaultController<any>,
  toolCallStart: string
) {
  if (!state.currentToolCallJson) return;

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
  controller: TransformStreamDefaultController<any>,
  toolCallStart: string,
  chunk: any
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
  controller: TransformStreamDefaultController<any>
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

function emitToolCall(
  state: StreamState,
  controller: TransformStreamDefaultController<any>,
  toolCallStart: string,
  toolCallEnd: string,
  options?: { onError?: (message: string, details: unknown) => void }
) {
  try {
    const parsedToolCall = RJSON.parse(state.currentToolCallJson) as {
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
  } catch {
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

function processTagMatch(
  state: StreamState,
  controller: TransformStreamDefaultController<any>,
  toolCallStart: string,
  toolCallEnd: string,
  options?: { onError?: (message: string, details: unknown) => void }
) {
  if (state.isInsideToolCall) {
    emitToolCall(state, controller, toolCallStart, toolCallEnd, options);
    state.currentToolCallJson = "";
    state.isInsideToolCall = false;
  } else {
    state.currentToolCallJson = "";
    state.isInsideToolCall = true;
  }
}

function processBufferTags(
  state: StreamState,
  controller: TransformStreamDefaultController<any>,
  toolCallStart: string,
  toolCallEnd: string,
  options?: { onError?: (message: string, details: unknown) => void }
) {
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
    processTagMatch(state, controller, toolCallStart, toolCallEnd, options);

    startIndex = getPotentialStartIndex(
      state.buffer,
      state.isInsideToolCall ? toolCallEnd : toolCallStart
    );
  }
}

function handlePartialTag(
  state: StreamState,
  controller: TransformStreamDefaultController<any>,
  toolCallStart: string
) {
  if (state.isInsideToolCall) return;

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

  formatToolCall(toolCall: LanguageModelV2ToolCall) {
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

  formatToolResponse(toolResult: LanguageModelV2ToolResultPart) {
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

    const processedElements: LanguageModelV2Content[] = [];
    let currentIndex = 0;
    let match = toolCallRegex.exec(text);

    while (match !== null) {
      const startIndex = match.index;
      const toolCallJson = match[1];

      // Add text before tool call if exists
      if (startIndex > currentIndex) {
        const textSegment = text.substring(currentIndex, startIndex);
        if (textSegment.trim()) {
          processedElements.push({ type: "text", text: textSegment });
        }
      }

      // Process tool call
      if (toolCallJson) {
        processToolCallJson(
          toolCallJson,
          match[0],
          processedElements,
          options
        );
      }

      currentIndex = startIndex + match[0].length;
      match = toolCallRegex.exec(text);
    }

    // Add remaining text
    if (currentIndex < text.length) {
      const remainingText = text.substring(currentIndex);
      if (remainingText.trim()) {
        processedElements.push({ type: "text", text: remainingText });
      }
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
        processBufferTags(
          state,
          controller,
          toolCallStart,
          toolCallEnd,
          options
        );
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
