import { generateResponseId, getCurrentTimestamp } from "./converters.js";
import type {
  OpenAIChatResponse,
  OpenAIChoice,
  OpenAIStreamingToolCall,
  OpenAIUsage,
  StreamChunk,
} from "./types.js";

/**
 * Convert AI SDK result to OpenAI chat completion response
 */
export function convertAISDKResultToOpenAI(
  // biome-ignore lint/suspicious/noExplicitAny: AI sdk integration boundary
  aisdkResult: any,
  model: string,
  stream = false
): OpenAIChatResponse {
  const choices: OpenAIChoice[] = [];

  // Handle text content
  if (aisdkResult.text) {
    const choice: OpenAIChoice = {
      index: 0,
      finish_reason: aisdkResult.finishReason || "stop",
    };

    if (stream) {
      choice.delta = {
        role: "assistant",
        content: aisdkResult.text,
      };
    } else {
      choice.message = {
        role: "assistant",
        content: aisdkResult.text,
      };
    }
    choices.push(choice);
  }

  // Handle tool calls
  if (aisdkResult.toolCalls && aisdkResult.toolCalls.length > 0) {
    const choice: OpenAIChoice = {
      index: 0,
      finish_reason: "tool_calls",
    };

    const openAIToolCalls = aisdkResult.toolCalls?.map(
      (
        // biome-ignore lint/suspicious/noExplicitAny: AI SDK integration boundary
        call: any
      ) => ({
        id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: "function" as const,
        function: {
          name: call.toolName,
          arguments: JSON.stringify(call.args),
        },
      })
    );

    if (stream) {
      choice.delta = {
        role: "assistant",
        tool_calls: openAIToolCalls,
      };
    } else {
      choice.message = {
        role: "assistant",
        content: null,
        tool_calls: openAIToolCalls,
      };
    }

    choices.push(choice);
  }

  const response: OpenAIChatResponse = {
    id: generateResponseId(),
    object: stream ? "chat.completion.chunk" : "chat.completion",
    created: getCurrentTimestamp(),
    model,
    choices,
  };

  // Add usage if available
  if (aisdkResult.usage) {
    response.usage = {
      prompt_tokens: aisdkResult.usage.promptTokens || 0,
      completion_tokens: aisdkResult.usage.completionTokens || 0,
      total_tokens: aisdkResult.usage.totalTokens || 0,
    } as OpenAIUsage;
  }

  return response;
}

/**
 * Convert AI SDK stream chunk to OpenAI SSE format
 */

// Type definitions for better type safety
type ToolCallDelta = {
  index?: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
};

type AIStreamChunk = {
  type: string;
  id?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: string;
  input?: Record<string, unknown>;
  finishReason?: string;
  [key: string]: unknown;
};

type ChunkHandler = (chunk: AIStreamChunk, model: string) => StreamChunk[];

// Helper function to create finish response
function createFinishResponse(
  model: string,
  finishReason: string
): OpenAIChatResponse {
  // Ensure finish reason matches OpenAI's allowed types
  let validFinishReason: "stop" | "length" | "tool_calls" | "content_filter";

  if (finishReason === "tool_calls" || finishReason === "tool-calls") {
    validFinishReason = "tool_calls";
  } else if (finishReason === "stop") {
    validFinishReason = "stop";
  } else if (finishReason === "length") {
    validFinishReason = "length";
  } else if (finishReason === "content_filter") {
    validFinishReason = "content_filter";
  } else {
    validFinishReason = "stop"; // fallback to "stop" for unknown reasons
  }

  return {
    id: generateResponseId(),
    object: "chat.completion.chunk",
    created: getCurrentTimestamp(),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: validFinishReason,
      },
    ],
  };
}

// Helper function to create content response
function createContentResponse(
  model: string,
  content: string,
  isReasoning = false
): OpenAIChatResponse {
  const delta: Record<string, unknown> = { role: "assistant" };

  if (isReasoning) {
    delta.reasoning_content = content;
  } else {
    delta.content = content;
  }

  return {
    id: generateResponseId(),
    object: "chat.completion.chunk",
    created: getCurrentTimestamp(),
    model,
    choices: [
      {
        index: 0,
        delta,
      },
    ],
  };
}

// Helper function to create tool call response
function createToolCallResponse(
  model: string,
  toolCall: ToolCallDelta,
  includeRole = false
): OpenAIChatResponse {
  return {
    id: generateResponseId(),
    object: "chat.completion.chunk",
    created: getCurrentTimestamp(),
    model,
    choices: [
      {
        index: 0,
        delta: {
          ...(includeRole ? { role: "assistant" as const } : {}),
          tool_calls: [
            {
              index: toolCall.index || 0,
              type: "function" as const,
              function: {
                name: toolCall.function?.name || "",
                arguments: toolCall.function?.arguments || "",
              },
            },
          ],
        },
      },
    ],
  };
}

// (legacy stateless handler removed)

export function createOpenAIStreamConverter(model: string) {
  let streamHasToolCalls = false;
  let streamFinishSent = false;

  const handlers: Record<string, ChunkHandler> = {
    start: () => [],
    "reasoning-delta": (chunk) => {
      if (!chunk.text) {
        return [];
      }
      return [
        {
          data: JSON.stringify(createContentResponse(model, chunk.text, true)),
        },
      ];
    },
    "text-delta": (chunk) => {
      if (!chunk.text) {
        return [];
      }
      return [
        {
          data: JSON.stringify(createContentResponse(model, chunk.text, false)),
        },
      ];
    },
    "tool-call": (chunk) => {
      const toolCallId = chunk.toolCallId || `call_${generateResponseId()}`;
      const toolName = chunk.toolName || "";
      const argsString =
        typeof chunk.input === "string"
          ? chunk.input
          : JSON.stringify(chunk.input ?? {});
      const toolCallDelta: OpenAIStreamingToolCall = {
        index: 0,
        id: toolCallId,
        type: "function",
        function: { name: toolName, arguments: argsString },
      };
      const response = createToolCallResponse(model, toolCallDelta, true);
      return [{ data: JSON.stringify(response) }];
    },
    "reasoning-end": () => [],
    "text-end": () => [],
    "finish-step": (chunk) => {
      if (streamFinishSent) {
        return [];
      }
      const hadToolCalls = streamHasToolCalls;
      let finishReason = chunk.finishReason || "stop";
      if (finishReason === "tool_calls" || finishReason === "tool-calls") {
        finishReason = "tool_calls";
      }
      const resolvedReason = hadToolCalls ? "tool_calls" : finishReason;
      streamFinishSent = true;
      streamHasToolCalls = false;
      return [
        { data: JSON.stringify(createFinishResponse(model, resolvedReason)) },
      ];
    },
    "tool-call-delta": (chunk) => {
      const toolCall = {
        index: chunk.toolCallId ? Number(chunk.toolCallId) : 0,
        type: "function" as const,
        function: {
          name: chunk.toolName || "",
          arguments: chunk.args || "",
        },
      };
      return [
        { data: JSON.stringify(createToolCallResponse(model, toolCall)) },
      ];
    },
    "tool-result": (chunk) => {
      const resultText = `\n[Tool: ${chunk.toolName} returned ${JSON.stringify(chunk.output)}]\n`;
      return [
        {
          data: JSON.stringify(createContentResponse(model, resultText, false)),
        },
      ];
    },
    finish: (chunk) => {
      if (streamFinishSent) {
        return [];
      }
      const hadToolCalls = streamHasToolCalls;
      let finishReason = chunk.finishReason || "stop";
      if (finishReason === "tool_calls" || finishReason === "tool-calls") {
        finishReason = "tool_calls";
      }
      const resolvedReason = hadToolCalls ? "tool_calls" : finishReason;
      streamFinishSent = true;
      streamHasToolCalls = false;
      return [
        { data: JSON.stringify(createFinishResponse(model, resolvedReason)) },
      ];
    },
  };

  return (
    // biome-ignore lint/suspicious/noExplicitAny: ai sdk boundary
    chunk: any
  ): StreamChunk[] => {
    const out: StreamChunk[] = [];

    const logType =
      process.env.USE_MIDDLEWARE === "true" ? "middleware" : "native";
    console.log(
      `🔍 AI SDK Chunk [${logType}]:`,
      JSON.stringify(chunk, null, 2)
    );

    if (chunk.type === "start") {
      streamHasToolCalls = false;
      streamFinishSent = false;
    }

    const handler = handlers[chunk.type];
    if (handler) {
      const result = handler(chunk as AIStreamChunk, model);
      if (chunk.type === "tool-call" || chunk.type === "tool-call-delta") {
        streamHasToolCalls = true;
      }
      out.push(...result);
    } else {
      console.warn(`⚠️ Unknown AI SDK chunk type: ${chunk.type}`, chunk);
    }

    if (chunk.type === "finish-step" || chunk.type === "finish") {
      streamHasToolCalls = false;
    }

    return out.filter((resultChunk) => {
      try {
        const parsed = JSON.parse(resultChunk.data);
        const delta = parsed.choices?.[0]?.delta;
        return (
          delta &&
          (delta.role ||
            delta.content ||
            (delta as NonNullable<OpenAIChoice["delta"]>).reasoning_content ||
            (delta.tool_calls && delta.tool_calls.length > 0) ||
            parsed.choices?.[0]?.finish_reason)
        );
      } catch {
        return true;
      }
    });
  };
}

export function convertAISDKStreamChunkToOpenAI(
  // biome-ignore lint/suspicious/noExplicitAny: o sdk integration boundary
  chunk: any,
  model: string
): StreamChunk[] {
  const convert = createOpenAIStreamConverter(model);
  return convert(chunk);
}

/**
 * Create SSE formatted response
 */
export function createSSEResponse(chunks: StreamChunk[]): string {
  return chunks.map((chunk) => `data: ${chunk.data}\n\n`).join("");
}
