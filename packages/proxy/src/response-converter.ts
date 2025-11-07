import { generateResponseId, getCurrentTimestamp } from "./converters.js";
import type {
  OpenAIChatResponse,
  OpenAIChoice,
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
export function convertAISDKStreamChunkToOpenAI(
  // biome-ignore lint/suspicious/noExplicitAny: o sdk integration boundary
  chunk: any,
  model: string
): StreamChunk[] {
  const chunks: StreamChunk[] = [];

  // Debug: Log chunk structure to understand Friendli response format
  console.log("🔍 AI SDK Chunk:", JSON.stringify(chunk, null, 2));

  // Handle reasoning content (Friendli-specific)
  if (chunk.type === "reasoning-delta" && chunk.text) {
    const response: OpenAIChatResponse = {
      id: generateResponseId(),
      object: "chat.completion.chunk",
      created: getCurrentTimestamp(),
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            reasoning_content: chunk.text,
          },
        },
      ],
    };

    chunks.push({ data: JSON.stringify(response) });
  }

  // Handle tool input start (OpenAI streaming format)
  if (chunk.type === "tool-input-start") {
    const response: OpenAIChatResponse = {
      id: generateResponseId(),
      object: "chat.completion.chunk",
      created: getCurrentTimestamp(),
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: chunk.id,
                type: "function" as const,
                function: {
                  name: chunk.toolName,
                  arguments: "", // Start with empty arguments for streaming
                },
              },
            ],
          },
        },
      ],
    };

    chunks.push({ data: JSON.stringify(response) });
  }

  // Handle tool input delta (streaming arguments)
  if (chunk.type === "tool-input-delta") {
    const response: OpenAIChatResponse = {
      id: generateResponseId(),
      object: "chat.completion.chunk",
      created: getCurrentTimestamp(),
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: chunk.delta, // Incremental argument content
                },
              },
            ],
          },
        },
      ],
    };

    chunks.push({ data: JSON.stringify(response) });
  }

  // Handle text delta
  if (chunk.type === "text-delta" && chunk.text) {
    const response: OpenAIChatResponse = {
      id: generateResponseId(),
      object: "chat.completion.chunk",
      created: getCurrentTimestamp(),
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: chunk.text,
          },
        },
      ],
    };

    chunks.push({ data: JSON.stringify(response) });
  }

  // Handle tool call delta (OpenAI compatible format)
  if (chunk.type === "tool-call-delta") {
    const response: OpenAIChatResponse = {
      id: generateResponseId(),
      object: "chat.completion.chunk",
      created: getCurrentTimestamp(),
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0, // Required by OpenAI format
                id: chunk.toolCallId,
                type: "function" as const,
                function: {
                  name: chunk.toolName,
                  arguments: chunk.argsText || "",
                },
              },
            ],
          },
        },
      ],
    };

    chunks.push({ data: JSON.stringify(response) });
  }

  // Handle tool result
  if (chunk.type === "tool-result") {
    // Tool results are typically not sent in OpenAI streaming format
    // But we can include them as content for debugging
    const resultText = `\n[Tool: ${chunk.toolName} returned ${JSON.stringify(chunk.output)}]\n`;
    const response: OpenAIChatResponse = {
      id: generateResponseId(),
      object: "chat.completion.chunk",
      created: getCurrentTimestamp(),
      model,
      choices: [
        {
          index: 0,
          delta: {
            content: resultText,
          },
        },
      ],
    };

    chunks.push({ data: JSON.stringify(response) });
  }

  // Handle finish
  if (chunk.type === "finish") {
    // Convert Friendli finish reason to OpenAI format
    let finishReason = chunk.finishReason || "stop";
    if (finishReason === "tool-calls") {
      finishReason = "tool_calls"; // OpenAI uses underscore, not hyphen
    }

    const response: OpenAIChatResponse = {
      id: generateResponseId(),
      object: "chat.completion.chunk",
      created: getCurrentTimestamp(),
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: finishReason,
        },
      ],
    };

    chunks.push({ data: JSON.stringify(response) });
    chunks.push({ data: "[DONE]" });
  }

  return chunks;
}

/**
 * Create SSE formatted response
 */
export function createSSEResponse(chunks: StreamChunk[]): string {
  return chunks.map((chunk) => `data: ${chunk.data}\n\n`).join("");
}
