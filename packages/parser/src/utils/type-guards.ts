import type {
  LanguageModelV2ToolCall,
  LanguageModelV2ToolResultPart,
} from "@ai-sdk/provider";

export function isToolCallContent(
  content: unknown
): content is LanguageModelV2ToolCall {
  return (
    (content as { type?: string }).type === "tool-call" &&
    typeof (content as { toolName?: unknown }).toolName === "string" &&
    typeof (content as { input?: unknown }).input === "string"
  );
}

export function isToolResultPart(
  content: unknown
): content is LanguageModelV2ToolResultPart {
  const c = content as {
    type?: string;
    toolName?: unknown;
    toolCallId?: unknown;
    output?: unknown;
  };
  return (
    !!c &&
    c.type === "tool-result" &&
    typeof c.toolName === "string" &&
    typeof c.toolCallId === "string" &&
    "output" in c
  );
}
