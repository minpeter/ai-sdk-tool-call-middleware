import type {
  ModelMessage,
  ToolContent,
  ToolResultOutput,
} from "@ai-sdk/provider-utils";
import { z } from "zod";
import type {
  OpenAIChatRequest,
  OpenAICompleteToolCall,
  OpenAIMessage,
  ProxyConfig,
} from "./types.js";

// Type definitions for OpenAI tool parameters
interface OpenAIToolProperty {
  type: string;
  description?: string;
  enum?: string[];
}

interface OpenAIToolParameters {
  type: string;
  properties?: Record<string, OpenAIToolProperty>;
  required?: string[];
}

// Type for AI SDK tool definition
interface AISDKTool {
  description: string;
  inputSchema: z.ZodTypeAny;
}

// Type for tool call object
interface ToolCall {
  toolName: string;
  args: unknown;
}

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

interface AITextPart {
  type: "text";
  text: string;
}
interface AIToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
}
type TextToolOutput = Extract<ToolResultOutput, { type: "text" }>;
type JsonToolOutput = Extract<ToolResultOutput, { type: "json" }>;

/**
 * Convert OpenAI chat completion request to AI SDK format
 */
export function normalizeMessageContent(
  content: OpenAIMessage["content"]
): AITextPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "text" as const, text: content }] : [];
  }

  if (Array.isArray(content)) {
    const parts = content as Array<string | { text?: unknown }>;
    return parts
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part) {
          const textValue = part.text;
          if (typeof textValue === "string") {
            return textValue;
          }
          if (textValue !== undefined) {
            return JSON.stringify(textValue);
          }
        }
        return JSON.stringify(part);
      })
      .filter((text): text is string => Boolean(text))
      .map((text) => ({ type: "text" as const, text }));
  }

  if (content === null || content === undefined) {
    return [];
  }

  if (typeof content === "object") {
    return [{ type: "text" as const, text: JSON.stringify(content) }];
  }

  return [{ type: "text" as const, text: String(content) }];
}

function buildToolCallParts(
  toolCalls: OpenAICompleteToolCall[]
): AIToolCallPart[] {
  return toolCalls.map((toolCall) => {
    let parsedArgs: unknown = toolCall.function.arguments;
    if (typeof toolCall.function.arguments === "string") {
      try {
        parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
      } catch {
        parsedArgs = toolCall.function.arguments;
      }
    }

    return {
      type: "tool-call" as const,
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      input: parsedArgs,
    } satisfies AIToolCallPart;
  });
}

function buildAssistantContent(
  message: OpenAIMessage & { role: "assistant" }
): Array<AITextPart | AIToolCallPart> | string {
  const textParts = normalizeMessageContent(message.content);
  const toolCallParts = message.tool_calls?.length
    ? buildToolCallParts(message.tool_calls)
    : [];

  if (toolCallParts.length === 0) {
    if (textParts.length === 0) {
      return "";
    }
    if (textParts.length === 1) {
      return textParts[0].text;
    }
    return textParts;
  }

  return [...textParts, ...toolCallParts];
}

function isJsonValue(value: unknown): value is JsonToolOutput["value"] {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }

  return false;
}

function buildToolOutput(rawValue: string): ToolResultOutput {
  if (!rawValue) {
    return { type: "text", value: "" } satisfies TextToolOutput;
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (isJsonValue(parsed)) {
      return { type: "json", value: parsed } satisfies JsonToolOutput;
    }
  } catch {
    // Fall through to text output below
  }

  return { type: "text", value: rawValue } satisfies TextToolOutput;
}

function buildToolContent(
  message: OpenAIMessage & { role: "tool" },
  toolNameLookup: Map<string, string>
): ToolContent {
  const textParts = normalizeMessageContent(message.content);
  const combined = textParts.map((part) => part.text).join("\n");
  const toolCallId = message.tool_call_id ?? "";
  const toolName = toolCallId
    ? (toolNameLookup.get(toolCallId) ?? toolCallId)
    : "";

  return [
    {
      type: "tool-result",
      toolCallId,
      toolName,
      output: buildToolOutput(combined),
    },
  ];
}

function convertMessageToModelMessage(
  message: OpenAIMessage,
  toolNameLookup: Map<string, string>
): ModelMessage {
  if (message.role === "assistant") {
    if (message.tool_calls?.length) {
      for (const toolCall of message.tool_calls) {
        toolNameLookup.set(toolCall.id, toolCall.function.name);
      }
    }

    return {
      role: "assistant",
      content: buildAssistantContent(
        message as OpenAIMessage & { role: "assistant" }
      ),
    };
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      content: buildToolContent(
        message as OpenAIMessage & { role: "tool" },
        toolNameLookup
      ),
    };
  }

  if (message.role === "system") {
    const text = normalizeMessageContent(message.content)
      .map((part) => part.text)
      .join("\n");
    return {
      role: "system",
      content: text,
    };
  }

  const userParts = normalizeMessageContent(message.content);
  if (userParts.length === 0) {
    return {
      role: "user",
      content: "",
    };
  }

  if (userParts.length === 1) {
    return {
      role: "user",
      content: userParts[0].text,
    };
  }

  return {
    role: "user",
    content: userParts,
  };
}

export function convertOpenAIRequestToAISDK(
  openaiRequest: OpenAIChatRequest,
  proxyConfig?: Pick<ProxyConfig, "parserDebug">
) {
  const {
    messages,
    tools: openaiTools,
    temperature,
    max_tokens,
    stop,
    tool_choice,
  } = openaiRequest;

  const toolNameLookup = new Map<string, string>();

  const aiMessages: ModelMessage[] = messages.map((message) =>
    convertMessageToModelMessage(message, toolNameLookup)
  );

  // Convert OpenAI tools to AI SDK format dynamically
  const aisdkTools = convertOpenAITools(openaiTools);

  const providerOptions = proxyConfig?.parserDebug
    ? {
        toolCallMiddleware: {
          debugLevel: proxyConfig.parserDebug.level,
          logErrors: proxyConfig.parserDebug.logErrors,
          captureSummary: proxyConfig.parserDebug.captureSummary,
        },
      }
    : undefined;

  return {
    messages: aiMessages,
    tools: aisdkTools,
    temperature,
    maxOutputTokens: max_tokens,
    stopSequences: convertStopToSequences(stop),
    toolChoice: mapOpenAIToolChoice(tool_choice),
    ...(providerOptions ? { providerOptions } : {}),
  };
}

// Map OpenAI tool_choice to AI SDK toolChoice
export function mapOpenAIToolChoice(
  choice: OpenAIChatRequest["tool_choice"]
): "auto" | "none" | { type: "tool"; toolName: string } | undefined {
  if (!choice) {
    return;
  }
  if (choice === "auto" || choice === "none") {
    return choice;
  }
  if (typeof choice === "object" && choice.type === "function") {
    return { type: "tool", toolName: choice.function.name };
  }
  return;
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
    id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
    type: "function" as const,
    function: {
      name: call.toolName,
      arguments: JSON.stringify(call.args),
    },
  }));
}
