import type { LanguageModelV4FinishReason } from "@ai-sdk/provider";
import type { ProviderBoundaryRecord } from "./on-error";

const FINISH_REASONS = new Set([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
]);
const TERMINAL_FINISH_REASONS = new Set(["length", "content-filter", "error"]);

type TerminalFinishReason = Extract<
  LanguageModelV4FinishReason["unified"],
  "length" | "content-filter" | "error"
>;

function isProviderBoundaryRecord<Value>(
  value: Value
): value is Value & ProviderBoundaryRecord {
  return typeof value === "object" && value !== null;
}

function isTerminalFinishReason<Value>(
  value: Value
): value is Value & TerminalFinishReason {
  return typeof value === "string" && TERMINAL_FINISH_REASONS.has(value);
}

function isLanguageModelFinishReason<Value>(
  value: Value
): value is Value & LanguageModelV4FinishReason {
  if (!isProviderBoundaryRecord(value)) {
    return false;
  }
  return (
    typeof value.unified === "string" &&
    FINISH_REASONS.has(value.unified) &&
    (!("raw" in value) ||
      value.raw === undefined ||
      typeof value.raw === "string")
  );
}

/**
 * Build a `tool-calls` finish reason while preserving the provider's raw
 * value. Accepts the loose shapes seen across providers (plain string,
 * `{ raw }`, `{ unified }`) so both wrap handlers can share one normalizer.
 */
export function normalizeToolCallsFinishReason<FinishReason>(
  finishReason: FinishReason
): LanguageModelV4FinishReason {
  let raw = "tool-calls";
  if (typeof finishReason === "string") {
    raw = finishReason;
  } else if (
    isProviderBoundaryRecord(finishReason) &&
    "raw" in finishReason &&
    typeof finishReason.raw === "string"
  ) {
    ({ raw } = finishReason);
  } else if (
    isProviderBoundaryRecord(finishReason) &&
    "unified" in finishReason &&
    typeof finishReason.unified === "string"
  ) {
    raw = finishReason.unified;
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
export function shouldRewriteFinishReasonToToolCalls<FinishReason>(
  finishReason: FinishReason
): boolean {
  if (!isLanguageModelFinishReason(finishReason)) {
    return false;
  }
  return finishReason.unified === "stop" || finishReason.unified === "other";
}

/**
 * Finish reason for a forced tool choice (`required` / named tool): the
 * result is always presented as a tool call, but meaningful terminal reasons
 * (`length`, `content-filter`, `error`) are preserved so callers can detect
 * truncation or filtering instead of seeing a fabricated `tool-calls`.
 */
export function normalizeForcedToolChoiceFinishReason<FinishReason>(
  finishReason: FinishReason
): LanguageModelV4FinishReason {
  if (isTerminalFinishReason(finishReason)) {
    return {
      unified: finishReason,
      raw: finishReason,
    };
  }
  if (
    isProviderBoundaryRecord(finishReason) &&
    isTerminalFinishReason(finishReason.unified)
  ) {
    return {
      unified: finishReason.unified,
      raw: typeof finishReason.raw === "string" ? finishReason.raw : undefined,
    };
  }
  return normalizeToolCallsFinishReason(finishReason);
}
