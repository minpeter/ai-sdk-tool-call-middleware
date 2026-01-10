import type { LanguageModelV3ToolCall } from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";

export function isToolCallContent(
  content: unknown
): content is LanguageModelV3ToolCall {
  const inputValue = (content as { input?: unknown }).input;
  const inputType = typeof inputValue;
  return (
    (content as { type?: string }).type === "tool-call" &&
    typeof (content as { toolName?: unknown }).toolName === "string" &&
    // input may be a JSON string, an already-parsed object, undefined, or null
    // depending on provider/runtime or for tools without arguments
    (inputType === "string" ||
      inputType === "object" ||
      inputType === "undefined")
  );
}

export function isToolResultPart(content: unknown): content is ToolResultPart {
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

export function hasInputProperty(obj: unknown): obj is { input?: unknown } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "input" in (obj as Record<string, unknown>)
  );
}
