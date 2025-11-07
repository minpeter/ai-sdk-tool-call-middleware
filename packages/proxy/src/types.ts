import type { LanguageModel } from "ai";
import type { z } from "zod";

// OpenAI API request/response types
export type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OpenAICompleteToolCall[]; // Use complete type for internal processing
  tool_call_id?: string;
};

// OpenAI streaming tool call (for deltas - optional fields)
export type OpenAIStreamingToolCall = {
  index: number; // Required by OpenAI streaming format
  id?: string; // Optional for streaming updates
  type?: "function"; // Optional for streaming updates
  function: {
    name?: string; // Optional for streaming updates
    arguments: string;
  };
};

// OpenAI complete tool call (for messages - all required)
export type OpenAICompleteToolCall = {
  index: number; // Required by OpenAI streaming format
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

// For backward compatibility - use streaming type for responses
export type OpenAIToolCall = OpenAIStreamingToolCall;

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type OpenAIChatRequest = {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  tool_choice?:
    | "none"
    | "auto"
    | { type: "function"; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
};

export type OpenAIChoice = {
  index: number;
  message?: {
    role: "assistant";
    content?: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  delta?: {
    role?: "assistant";
    content?: string | null;
    reasoning_content?: string; // Friendli-specific reasoning content
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason?: "stop" | "length" | "tool_calls" | "content_filter";
};

export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type OpenAIChatResponse = {
  id: string;
  object: "chat.completion" | "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
};

// AI SDK tool configuration
export type AISDKTool = {
  description: string;
  parameters: z.ZodTypeAny;
  execute?: (params: unknown) => unknown | Promise<unknown>;
};

// Proxy configuration - only OpenAI-compatible and server settings
export type ProxyConfig = {
  model: LanguageModel;
  port?: number;
  host?: string;
  cors?: boolean;
};

// Streaming chunk for SSE
export type StreamChunk = {
  data: string;
};
