import type {
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type { CoreStreamPart } from "../core/types";

/**
 * Helper to pipe a ReadableStream through a transformer with relaxed types.
 * Needed because protocol transformers use CoreStreamPart internally
 * but tests create LanguageModelV3StreamPart streams.
 */
export function pipeWithTransformer(
  stream: ReadableStream<LanguageModelV3StreamPart>,
  transformer: TransformStream<CoreStreamPart, CoreStreamPart>
): ReadableStream<LanguageModelV3StreamPart> {
  return stream.pipeThrough(transformer as unknown as TransformStream);
}

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
