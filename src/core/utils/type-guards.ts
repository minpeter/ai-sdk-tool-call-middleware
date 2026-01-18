import type { ToolResultPart } from "@ai-sdk/provider-utils";

export function isToolResultPart(content: unknown): content is ToolResultPart {
  if (!content || typeof content !== "object") {
    return false;
  }
  const c = content as Record<string, unknown>;
  return (
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
