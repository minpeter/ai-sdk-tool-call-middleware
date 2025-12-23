import type {
  LanguageModelV3FinishReason,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";

export function mockUsage(
  inputTokens: number,
  outputTokens: number
): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: undefined,
      reasoning: undefined,
    },
  };
}

export function mockFinishReason(
  unified:
    | "stop"
    | "length"
    | "content-filter"
    | "tool-calls"
    | "error"
    | "other"
): LanguageModelV3FinishReason {
  return { unified, raw: undefined };
}

export const zeroUsage = mockUsage(0, 0);

export const stopFinishReason = mockFinishReason("stop");
