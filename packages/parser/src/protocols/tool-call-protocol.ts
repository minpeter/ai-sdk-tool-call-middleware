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
  }: {
    text: string;
    tools: LanguageModelV2FunctionTool[];
  }): LanguageModelV2Content[];

  createStreamParser({
    tools,
  }: {
    tools: LanguageModelV2FunctionTool[];
  }): TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>;
}
