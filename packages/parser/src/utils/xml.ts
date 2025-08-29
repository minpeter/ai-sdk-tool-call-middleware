import type { LanguageModelV2ToolCall } from "@ai-sdk/provider";

import { hasInputProperty } from "./type-guards";

export const XML_TEXT_NODE = "#text";

export function extractToolCallInput(
  toolCall: LanguageModelV2ToolCall
): unknown {
  const potential = hasInputProperty(toolCall) ? toolCall.input : undefined;

  if (typeof potential === "string") {
    try {
      return JSON.parse(potential);
    } catch {
      return potential;
    }
  }
  return potential;
}
