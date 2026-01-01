import type {
  CoreContentPart,
  CoreFunctionTool,
  CoreStreamPart,
  CoreToolCall,
  CoreToolResult,
} from "../types";

export interface ToolCallProtocol {
  formatTools({
    tools,
    toolSystemPromptTemplate,
  }: {
    tools: CoreFunctionTool[];
    toolSystemPromptTemplate: (tools: string) => string;
  }): string;

  formatToolCall(toolCall: CoreToolCall): string;

  formatToolResponse(toolResult: CoreToolResult): string;

  parseGeneratedText({
    text,
    tools,
    options,
  }: {
    text: string;
    tools: CoreFunctionTool[];
    options?: {
      onError?: (message: string, metadata?: Record<string, unknown>) => void;
    };
  }): CoreContentPart[];

  createStreamParser({
    tools,
    options,
  }: {
    tools: CoreFunctionTool[];
    options?: {
      onError?: (message: string, metadata?: Record<string, unknown>) => void;
    };
  }): TransformStream<CoreStreamPart, CoreStreamPart>;

  extractToolCallSegments?: ({
    text,
    tools,
  }: {
    text: string;
    tools: CoreFunctionTool[];
  }) => string[];
}

export function isProtocolFactory(
  protocol: ToolCallProtocol | (() => ToolCallProtocol)
): protocol is () => ToolCallProtocol {
  return typeof protocol === "function";
}
