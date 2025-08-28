import type { LanguageModelV2ToolCall } from "@ai-sdk/provider";

export const XML_TEXT_NODE = "#text";

export function extractToolCallInput(
  toolCall: LanguageModelV2ToolCall
): unknown {
  const potential =
    typeof toolCall === "object" &&
    toolCall !== null &&
    "input" in (toolCall as Record<string, unknown>)
      ? (toolCall as { input?: unknown }).input
      : undefined;

  if (typeof potential === "string") {
    try {
      return JSON.parse(potential);
    } catch {
      return potential;
    }
  }
  return potential;
}
