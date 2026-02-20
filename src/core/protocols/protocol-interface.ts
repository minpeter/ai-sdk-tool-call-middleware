import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
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
  createStreamParser({
    tools,
    options,
  }: {
    tools: LanguageModelV3FunctionTool[];
    options?: ParserOptions;
  }): TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>;

  extractToolCallSegments?: ({
    text,
    tools,
  }: {
    text: string;
    tools: LanguageModelV3FunctionTool[];
  }) => string[];

  formatToolCall(toolCall: LanguageModelV3ToolCall): string;
  formatTools({
    tools,
    toolSystemPromptTemplate,
  }: {
    tools: LanguageModelV3FunctionTool[];
    toolSystemPromptTemplate: (tools: LanguageModelV3FunctionTool[]) => string;
  }): string;

  parseGeneratedText({
    text,
    tools,
    options,
  }: {
    text: string;
    tools: LanguageModelV3FunctionTool[];
    options?: ParserOptions;
  }): LanguageModelV3Content[];
}

export type TCMCoreProtocol = TCMProtocol;

export function isProtocolFactory(
  protocol: TCMProtocol | (() => TCMProtocol)
): protocol is () => TCMProtocol {
  return typeof protocol === "function";
}

export const isTCMProtocolFactory = isProtocolFactory;
