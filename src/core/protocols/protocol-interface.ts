import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";

/**
 * Options for parsing tool calls and handling errors
 */
export interface ParserOptions {
  /**
   * When true, stream parsers may emit malformed raw tool-call text as
   * `text-delta` fallback on parse failure. Defaults to false to avoid leaking
   * protocol/internal markup to end users.
   */
  emitRawToolCallTextOnError?: boolean;
  onError?: (message: string, metadata?: Record<string, unknown>) => void;
}

export interface TCMProtocol {
  createStreamParser: ({
    tools,
    options,
  }: {
    tools: LanguageModelV4FunctionTool[];
    options?: ParserOptions;
  }) => TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>;

  extractToolCallSegments?: ({
    text,
    tools,
  }: {
    text: string;
    tools: LanguageModelV4FunctionTool[];
  }) => string[];

  formatToolCall: (toolCall: LanguageModelV4ToolCall) => string;
  formatTools: ({
    tools,
    toolSystemPromptTemplate,
  }: {
    tools: LanguageModelV4FunctionTool[];
    toolSystemPromptTemplate: (tools: LanguageModelV4FunctionTool[]) => string;
  }) => string;

  parseGeneratedText: ({
    text,
    tools,
    options,
  }: {
    text: string;
    tools: LanguageModelV4FunctionTool[];
    options?: ParserOptions;
  }) => LanguageModelV4Content[];
}

export type TCMCoreProtocol = TCMProtocol;

export function isProtocolFactory(
  protocol: TCMProtocol | (() => TCMProtocol)
): protocol is () => TCMProtocol {
  return typeof protocol === "function";
}

export const isTCMProtocolFactory = isProtocolFactory;
