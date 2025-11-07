import { z } from "zod";
import type { OpenAIChatRequest } from "./types.js";

// Type definitions for OpenAI tool parameters
type OpenAIToolProperty = {
  type: string;
  description?: string;
  enum?: string[];
};

type OpenAIToolParameters = {
  type: string;
  properties?: Record<string, OpenAIToolProperty>;
  required?: string[];
};

// Type for AI SDK tool definition
type AISDKTool = {
  description: string;
  inputSchema: z.ZodTypeAny;
};

// Type for message object
type Message = {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

// Type for tool call object
type ToolCall = {
  toolName: string;
  args: unknown;
};

/**
 * Create Zod schema for OpenAI tool property
 */
function createZodSchema(prop: OpenAIToolProperty): z.ZodTypeAny {
  if (prop.type === "string") {
    return prop.enum ? z.enum(prop.enum as [string, ...string[]]) : z.string();
  }
  if (prop.type === "number") {
    return z.number();
  }
  if (prop.type === "boolean") {
    return z.boolean();
  }
  if (prop.type === "array") {
    return z.array(z.any());
  }
  if (prop.type === "object") {
    return z.object({});
  }
  return z.any();
}

/**
 * Convert OpenAI tool schema to Zod schema
 */
function convertOpenAIToolToZod(
  parameters: Record<string, unknown> | undefined
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  if (!parameters) {
    return z.object({});
  }

  const params = parameters as unknown as OpenAIToolParameters;
  if (!params.properties) {
    return z.object({});
  }

  const schemaShape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(params.properties)) {
    schemaShape[key] = createZodSchema(prop);
  }

  return z.object(schemaShape);
}

/**
 * Process message and add to prompt
 */
function processMessage(message: Message, currentPrompt: string): string {
  let updatedPrompt = currentPrompt;

  if (message.role === "user") {
    updatedPrompt += `User: ${message.content || ""}\n`;
  } else if (message.role === "assistant") {
    updatedPrompt += `Assistant: ${message.content || ""}\n`;
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        updatedPrompt += `[Tool call: ${toolCall.function.name} with args ${toolCall.function.arguments}]\n`;
      }
    }
  } else if (message.role === "tool") {
    updatedPrompt += `[Tool result: ${message.content}]\n`;
  }

  return updatedPrompt;
}

/**
 * Convert OpenAI tools to AI SDK format
 */
function convertOpenAITools(
  openaiTools:
    | Array<{
        function: {
          name: string;
          description?: string;
          parameters: Record<string, unknown>;
        };
      }>
    | undefined
): Record<string, AISDKTool> {
  const aisdkTools: Record<string, AISDKTool> = {};

  if (!openaiTools) {
    return aisdkTools;
  }

  for (const openaiTool of openaiTools) {
    const toolName = openaiTool.function.name;
    aisdkTools[toolName] = {
      description: openaiTool.function.description || "",
      inputSchema: convertOpenAIToolToZod(openaiTool.function.parameters),
    };
  }

  return aisdkTools;
}

/**
 * Convert stop parameter to stop sequences
 */
function convertStopToSequences(
  stop: string | string[] | undefined
): string[] | undefined {
  if (!stop) {
    return;
  }
  return Array.isArray(stop) ? stop : [stop];
}

/**
 * Convert OpenAI chat completion request to AI SDK format
 */
export function convertOpenAIRequestToAISDK(openaiRequest: OpenAIChatRequest) {
  const {
    messages,
    tools: openaiTools,
    temperature,
    max_tokens,
    stop,
  } = openaiRequest;

  // Convert messages
  const systemMessage = messages.find((msg) => msg.role === "system");
  const conversationMessages = messages.filter((msg) => msg.role !== "system");

  // Build prompt from conversation
  let currentPrompt = "";
  for (const message of conversationMessages) {
    currentPrompt = processMessage(message, currentPrompt);
  }

  // Convert OpenAI tools to AI SDK format dynamically
  const aisdkTools = convertOpenAITools(openaiTools);

  return {
    system: systemMessage?.content || undefined,
    prompt: currentPrompt.trim(),
    tools: aisdkTools,
    temperature,
    maxTokens: max_tokens,
    stopSequences: convertStopToSequences(stop),
  };
}

/**
 * Convert AI SDK tool calls to OpenAI format
 */
export function convertAISDKToolCallsToOpenAI(toolCalls: ToolCall[]): Array<{
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}> {
  return toolCalls.map((call) => ({
    id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    type: "function" as const,
    function: {
      name: call.toolName,
      arguments: JSON.stringify(call.args),
    },
  }));
}

/**
 * Generate OpenAI-compatible response ID
 */
export function generateResponseId(): string {
  return `chatcmpl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Get current timestamp for OpenAI responses
 */
export function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}
