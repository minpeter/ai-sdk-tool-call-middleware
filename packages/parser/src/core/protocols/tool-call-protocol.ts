import type {
  TCMCoreContentPart,
  TCMCoreFunctionTool,
  TCMCoreStreamPart,
  TCMCoreToolCall,
  TCMCoreToolResult,
} from "../types";

export interface ToolCallProtocol {
  formatTools({
    tools,
    toolSystemPromptTemplate,
  }: {
    tools: TCMCoreFunctionTool[];
    toolSystemPromptTemplate: (tools: string) => string;
  }): string;

  formatToolCall(toolCall: TCMCoreToolCall): string;

  formatToolResponse(toolResult: TCMCoreToolResult): string;

  parseGeneratedText({
    text,
    tools,
    options,
  }: {
    text: string;
    tools: TCMCoreFunctionTool[];
    options?: {
      onError?: (message: string, metadata?: Record<string, unknown>) => void;
    };
  }): TCMCoreContentPart[];

  createStreamParser({
    tools,
    options,
  }: {
    tools: TCMCoreFunctionTool[];
    options?: {
      onError?: (message: string, metadata?: Record<string, unknown>) => void;
    };
  }): TransformStream<TCMCoreStreamPart, TCMCoreStreamPart>;

  extractToolCallSegments?: ({
    text,
    tools,
  }: {
    text: string;
    tools: TCMCoreFunctionTool[];
  }) => string[];
}

export function isProtocolFactory(
  protocol: ToolCallProtocol | (() => ToolCallProtocol)
): protocol is () => ToolCallProtocol {
  return typeof protocol === "function";
}
