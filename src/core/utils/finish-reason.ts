import type { LanguageModelV4FinishReason } from "@ai-sdk/provider";

/**
 * Build a `tool-calls` finish reason while preserving the provider's raw
 * value. Accepts the loose shapes seen across providers (plain string,
 * `{ raw }`, `{ unified }`) so both wrap handlers can share one normalizer.
 */
export function normalizeToolCallsFinishReason(
  finishReason: unknown
): LanguageModelV4FinishReason {
  let raw = "tool-calls";
  if (typeof finishReason === "string") {
    raw = finishReason;
  } else if (
    finishReason &&
    typeof finishReason === "object" &&
    "raw" in finishReason &&
    typeof (finishReason as { raw?: unknown }).raw === "string"
  ) {
    raw = (finishReason as { raw: string }).raw;
  } else if (
    finishReason &&
    typeof finishReason === "object" &&
    "unified" in finishReason &&
    typeof (finishReason as { unified?: unknown }).unified === "string"
  ) {
    raw = (finishReason as { unified: string }).unified;
  }

  return {
    unified: "tool-calls",
    raw,
  };
}

/**
 * Whether a finish reason should be rewritten to `tool-calls` once the
 * middleware has parsed tool calls out of the model text. `stop` is the
 * common case; `other` covers providers that report an unmapped raw finish
 * reason for plain end-of-turn. Meaningful reasons (`length`,
 * `content-filter`, `error`) are preserved.
 */
export function shouldRewriteFinishReasonToToolCalls(
  finishReason: unknown
): boolean {
  if (!finishReason || typeof finishReason !== "object") {
    return false;
  }
  const unified = (finishReason as { unified?: unknown }).unified;
  return unified === "stop" || unified === "other";
}
