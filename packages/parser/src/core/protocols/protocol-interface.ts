import type {
  TCMCoreContentPart,
  TCMCoreFunctionTool,
  TCMCoreStreamPart,
  TCMCoreToolCall,
  TCMCoreToolResult,
  TCMToolDefinition,
} from "../types";

export interface TCMCoreProtocol {
  formatTools({
    tools,
    toolSystemPromptTemplate,
  }: {
    tools: TCMCoreFunctionTool[];
    toolSystemPromptTemplate: (tools: TCMToolDefinition[]) => string;
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

export function isTCMProtocolFactory(
  protocol: TCMCoreProtocol | (() => TCMCoreProtocol)
): protocol is () => TCMCoreProtocol {
  return typeof protocol === "function";
}
