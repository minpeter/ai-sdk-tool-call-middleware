import type {
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";

/**
 * Helper to pipe a ReadableStream through a transformer with relaxed types.
 * Needed because tests create LanguageModelV3StreamPart streams.
 */
export function pipeWithTransformer(
  stream: ReadableStream<LanguageModelV3StreamPart>,
  transformer: TransformStream<
    LanguageModelV3StreamPart,
    LanguageModelV3StreamPart
  >
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

export function createChunkedStream(
  input: string | string[],
  id = "1"
): ReadableStream<LanguageModelV3StreamPart> {
  const chunks = typeof input === "string" ? input.split("") : input;
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(ctrl) {
      for (const chunk of chunks) {
        ctrl.enqueue({ type: "text-delta", id, delta: chunk });
      }
      ctrl.enqueue({
        type: "finish",
        finishReason: stopFinishReason,
        usage: zeroUsage,
      });
      ctrl.close();
    },
  });
}
