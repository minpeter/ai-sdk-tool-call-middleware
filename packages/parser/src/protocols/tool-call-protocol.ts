import type {
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
  LanguageModelV2StreamPart,
  LanguageModelV2ToolCall,
  LanguageModelV2ToolResultPart,
} from "@ai-sdk/provider";

export interface ToolCallProtocol {
  formatTools({
    tools,
    toolSystemPromptTemplate,
  }: {
    tools: LanguageModelV2FunctionTool[];
    toolSystemPromptTemplate: (tools: string) => string;
  }): string;

  formatToolCall(toolCall: LanguageModelV2ToolCall): string;

  formatToolResponse(toolResult: LanguageModelV2ToolResultPart): string;

  parseGeneratedText({
    text,
    tools,
    options,
  }: {
    text: string;
    tools: LanguageModelV2FunctionTool[];
    options?: {
      onError?: (message: string, metadata?: Record<string, unknown>) => void;
    };
  }): LanguageModelV2Content[];

  createStreamParser({
    tools,
    options,
  }: {
    tools: LanguageModelV2FunctionTool[];
    options?: {
      onError?: (message: string, metadata?: Record<string, unknown>) => void;
    };
  }): TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>;
}
