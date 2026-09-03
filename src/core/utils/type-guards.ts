import type { ProviderBoundaryValue } from "./on-error";

export interface ToolResultPartShape {
  readonly output: ProviderBoundaryValue;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly type: "tool-result";
}

export function isToolResultPart<Content>(
  content: Content
): content is Content & ToolResultPartShape {
  if (!content || typeof content !== "object") {
    return false;
  }
  // Property reads must stay in this exact order: direct reads before the
  // `in` check (observable through Proxy traps; pinned by a regression test).
  const candidate = content as Record<string, ProviderBoundaryValue>;
  return (
    candidate.type === "tool-result" &&
    typeof candidate.toolName === "string" &&
    typeof candidate.toolCallId === "string" &&
    "output" in candidate
  );
}

export function hasInputProperty<Value>(
  obj: Value
): obj is Value & { readonly input?: ProviderBoundaryValue } {
  return typeof obj === "object" && obj !== null && "input" in obj;
}
