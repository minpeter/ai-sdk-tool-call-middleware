import {
  isJSONObject,
  type JSONObject,
  type JSONValue,
  type LanguageModelV4FinishReason,
  type LanguageModelV4Middleware,
  type LanguageModelV4StreamPart,
  type LanguageModelV4Usage,
} from "@ai-sdk/provider";

/** Pipe test model streams through protocol transformers. */
export function pipeWithTransformer(
  stream: ReadableStream<LanguageModelV4StreamPart>,
  transformer: TransformStream<
    LanguageModelV4StreamPart,
    LanguageModelV4StreamPart
  >
): ReadableStream<LanguageModelV4StreamPart> {
  return stream.pipeThrough(transformer);
}

export function mockUsage(
  inputTokens: number,
  outputTokens: number
): LanguageModelV4Usage {
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
): LanguageModelV4FinishReason {
  return { unified, raw: undefined };
}

export const zeroUsage = mockUsage(0, 0);

export const stopFinishReason = mockFinishReason("stop");

export function isStrictJSONObject(
  value: JSONValue | undefined
): value is JSONObject {
  return isJSONObject(value) && !Array.isArray(value);
}

export function createChunkedStream(
  input: string | string[],
  id = "1"
): ReadableStream<LanguageModelV4StreamPart> {
  const chunks = typeof input === "string" ? input.split("") : input;
  return new ReadableStream<LanguageModelV4StreamPart>({
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

export function requireTransformParams(
  transformParams: LanguageModelV4Middleware["transformParams"]
): NonNullable<LanguageModelV4Middleware["transformParams"]> {
  if (!transformParams) {
    throw new Error("transformParams is undefined");
  }

  return transformParams;
}
