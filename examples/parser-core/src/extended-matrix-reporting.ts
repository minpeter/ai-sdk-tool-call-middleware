export type ResultCategory =
  | "pass"
  | "expectation-miss"
  | "malformed-output"
  | "output-leak"
  | "provider-error"
  | "stream-invariant"
  | "harness-error"
  | "unclassified";

export interface ClassifiableResult {
  category: ResultCategory;
  detail: string;
  ok: boolean;
  parserErrors: string[];
}

export interface DimensionSummary {
  evaluable: number;
  passed: number;
  passRate: number | null;
  providerUnavailable: number;
  total: number;
}

const EXPECTATION_MISS_PATTERNS = [
  /^answer missing /,
  /^bad /,
  /^body lost /,
  /^content lost markup /,
  /^content not multi-line:/,
  /^expected >=/,
  /^no [a-z_]+ call;/,
  /^type fidelity:/,
];

const PROVIDER_ERROR_PATTERNS = [
  /AI_APICallError/i,
  /AiError:/i,
  /Backend request failed with status \d+/i,
  /budget (?:has been )?exceeded/i,
  /Credit limit exceeded/i,
  /ExceededBudget/i,
  /fetch failed/i,
  /Input validation error/i,
  /Invalid model:/i,
  /Key limit exceeded/i,
  /litellm\.APIError/i,
  /model .* does not exist/i,
  /non-serverless model/i,
  /only supports streaming responses/i,
  /operation was aborted/i,
  /rate limit/i,
  /status code [45]\d\d/i,
  /subscription plan/i,
  /System role not supported/i,
  /Conversation roles must alternate/i,
  /enum system not in user,assistant/i,
  /Expected 'function\.name'/i,
];

const RETRYABLE_PROVIDER_ERROR_PATTERNS = [
  /Backend request failed with status 5\d\d/i,
  /operation was aborted/i,
  /rate limit/i,
  /status code 429/i,
  /status code 5\d\d/i,
  /timeout/i,
];

const STREAM_INVARIANT_PATTERNS = [
  /CALL-WITHOUT-INPUT-START/,
  /DELTA-BEFORE-START/,
  /DELTA-MISMATCH/,
  /DELTA-NOT-JSON/,
  /DUP-INPUT-/,
  /END-BEFORE-START/,
  /NO-INPUT-END/,
];

const OUTPUT_LEAK_PATTERN = /TEXT-LEAK/;
const HARNESS_ERROR_PATTERN =
  /^(?:Cannot read properties|ReferenceError(?::| )|TypeError(?::| )|[^;"\n]{1,160} is not a function(?:$|\n))/;

function matches(detail: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(detail));
}

export function classifyFailure(
  detail: string,
  parserErrors: string[]
): ResultCategory {
  if (OUTPUT_LEAK_PATTERN.test(detail)) {
    return "output-leak";
  }
  if (matches(detail, STREAM_INVARIANT_PATTERNS)) {
    return "stream-invariant";
  }
  if (parserErrors.length > 0) {
    return "malformed-output";
  }
  if (matches(detail, EXPECTATION_MISS_PATTERNS)) {
    return "expectation-miss";
  }
  if (matches(detail, PROVIDER_ERROR_PATTERNS)) {
    return "provider-error";
  }
  if (HARNESS_ERROR_PATTERN.test(detail)) {
    return "harness-error";
  }
  return "unclassified";
}

export function classifySuccess(
  detail: string,
  parserErrors: string[]
): ResultCategory {
  if (OUTPUT_LEAK_PATTERN.test(detail)) {
    return "output-leak";
  }
  if (matches(detail, STREAM_INVARIANT_PATTERNS)) {
    return "stream-invariant";
  }
  if (parserErrors.length > 0) {
    return "malformed-output";
  }
  return "pass";
}

export function isRetryableProviderError(detail: string): boolean {
  return matches(detail, RETRYABLE_PROVIDER_ERROR_PATTERNS);
}

export function normalizeStoredResult<T extends ClassifiableResult>(
  result: T
): Omit<T, "category" | "ok"> & ClassifiableResult {
  const category = result.ok
    ? classifySuccess(result.detail, result.parserErrors)
    : classifyFailure(result.detail, result.parserErrors);
  return { ...result, category, ok: category === "pass" };
}

export function summarizeResults(
  results: readonly Pick<ClassifiableResult, "category">[]
): DimensionSummary {
  const passed = results.filter((result) => result.category === "pass").length;
  const providerUnavailable = results.filter(
    (result) => result.category === "provider-error"
  ).length;
  const evaluable = results.length - providerUnavailable;
  return {
    evaluable,
    passRate: evaluable === 0 ? null : (passed / evaluable) * 100,
    passed,
    providerUnavailable,
    total: results.length,
  };
}
