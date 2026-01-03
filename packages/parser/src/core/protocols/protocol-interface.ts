import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
} from "@ai-sdk/provider";

export interface TCMProtocol {
  formatTools({
    tools,
    toolSystemPromptTemplate,
  }: {
    tools: LanguageModelV3FunctionTool[];
    toolSystemPromptTemplate: (tools: LanguageModelV3FunctionTool[]) => string;
  }): string;

  formatToolCall(toolCall: LanguageModelV3ToolCall): string;

  parseGeneratedText({
    text,
    tools,
    options,
  }: {
    text: string;
    tools: LanguageModelV3FunctionTool[];
    options?: {
      onError?: (message: string, metadata?: Record<string, unknown>) => void;
    };
  }): LanguageModelV3Content[];

  createStreamParser({
    tools,
    options,
  }: {
    tools: LanguageModelV3FunctionTool[];
    options?: {
      onError?: (message: string, metadata?: Record<string, unknown>) => void;
    };
  }): TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>;

  extractToolCallSegments?: ({
    text,
    tools,
  }: {
    text: string;
    tools: LanguageModelV3FunctionTool[];
  }) => string[];
}

export type TCMCoreProtocol = TCMProtocol;

export function isProtocolFactory(
  protocol: TCMProtocol | (() => TCMProtocol)
): protocol is () => TCMProtocol {
  return typeof protocol === "function";
}

export function isTCMProtocolFactory(
  protocol: TCMProtocol | (() => TCMProtocol)
): protocol is () => TCMProtocol {
  return typeof protocol === "function";
}
