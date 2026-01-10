import type { ToolResultPart } from "@ai-sdk/provider-utils";

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
