import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { stringifyToolInputWithSchema } from "../utils/tool-input-streaming";

export function canonicalizeToolInput(argumentsValue: unknown): string {
  return JSON.stringify(argumentsValue ?? {});
}

export function stringifyParsedToolInput(args: unknown): string {
  return args === null ? "null" : canonicalizeToolInput(args);
}

export function stringifyResolvedToolInput(
  toolName: string,
  args: unknown,
  tools: LanguageModelV4FunctionTool[]
): string {
  return stringifyToolInputWithSchema({
    toolName,
    args,
    tools,
    fallback: stringifyParsedToolInput,
  });
}

export function isParsedToolCallRecord(
  value: unknown
): value is { name: string; arguments?: unknown } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.hasOwn(record, "name") && typeof record.name === "string";
}

const CHAR_CODE_BACKSLASH = 0x5c;
const CHAR_CODE_QUOTE = 0x22;
const CHAR_CODE_LF = 0x0a;
const CHAR_CODE_CR = 0x0d;
const CHAR_CODE_TAB = 0x09;
const CHAR_CODE_SLASH = 0x2f;
const CHAR_CODE_STAR = 0x2a;
const CHAR_CODE_CONTROL_UPPER = 0x1f;

const CHAR_CODE_SINGLE_QUOTE = 0x27;

type JsonStringQuote = typeof CHAR_CODE_QUOTE | typeof CHAR_CODE_SINGLE_QUOTE;

/**
 * Fast single-pass detector: returns true when any JSON string literal in
 * `json` contains a raw (unescaped) control character that would cause
 * JSON.parse to fail. Used as an early-exit guard so the 99% common case
 * of well-formed JSON skips all string allocation in
 * `normalizeJsonStringCtrl`.
 */

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Relaxed JSON scanning must skip comments while tracking quote and escape state.
function hasControlCharInString(json: string): boolean {
  let quote: JsonStringQuote | null = null;
  let esc = false;
  for (let i = 0; i < json.length; i += 1) {
    const code = json.charCodeAt(i);
    if (esc) {
      esc = false;
      if (code <= CHAR_CODE_CONTROL_UPPER) {
        return true;
      }
      continue;
    }
    if (quote !== null && code === CHAR_CODE_BACKSLASH) {
      esc = true;
      continue;
    }
    if (quote !== null) {
      if (code === quote) {
        quote = null;
        continue;
      }
      if (code <= CHAR_CODE_CONTROL_UPPER) {
        return true;
      }
      continue;
    }
    if (
      code === CHAR_CODE_SLASH &&
      json.charCodeAt(i + 1) === CHAR_CODE_SLASH
    ) {
      i += 2;
      while (
        i < json.length &&
        json.charCodeAt(i) !== CHAR_CODE_LF &&
        json.charCodeAt(i) !== CHAR_CODE_CR
      ) {
        i += 1;
      }
      continue;
    }
    if (code === CHAR_CODE_SLASH && json.charCodeAt(i + 1) === CHAR_CODE_STAR) {
      i += 2;
      while (
        i + 1 < json.length &&
        !(
          json.charCodeAt(i) === CHAR_CODE_STAR &&
          json.charCodeAt(i + 1) === CHAR_CODE_SLASH
        )
      ) {
        i += 1;
      }
      i += 1;
      continue;
    }
    if (code === CHAR_CODE_QUOTE || code === CHAR_CODE_SINGLE_QUOTE) {
      quote = code;
    }
  }
  return false;
}

/**
 * Escape literal control characters (U+0000–U+001F) that appear inside JSON
 * string values.  Models often emit raw newlines in long content fields, which
 * are valid plaintext but rejected by JSON.parse.  Only replaces inside
 * strings to preserve JSON structural whitespace.
 *
 * Implementation notes:
 *   - Fast-path: if no control char appears inside any string literal, we
 *     return the input unchanged without any string building.
 *   - Slow-path: chunk-based slicing with an array builder — avoids the
 *     quadratic string concatenation that a per-character `result += ch`
 *     loop produces on large arguments.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Quote-aware JSON normalization requires explicit escape/string-state transitions.
export function normalizeJsonStringCtrl(json: string): string {
  if (!hasControlCharInString(json)) {
    return json;
  }

  const parts: string[] = [];
  let chunkStart = 0;
  let quote: JsonStringQuote | null = null;
  let esc = false;

  const flushUpTo = (end: number) => {
    if (chunkStart < end) {
      parts.push(json.slice(chunkStart, end));
    }
  };

  const escapeForCode = (code: number): string => {
    switch (code) {
      case CHAR_CODE_LF:
        return "\\n";
      case CHAR_CODE_CR:
        return "\\r";
      case CHAR_CODE_TAB:
        return "\\t";
      default:
        return `\\u${code.toString(16).padStart(4, "0")}`;
    }
  };

  for (let i = 0; i < json.length; i += 1) {
    const code = json.charCodeAt(i);

    if (esc) {
      esc = false;
      if (code <= CHAR_CODE_CONTROL_UPPER) {
        // `\` + raw control char — drop the preceding `\` and emit a
        // proper JSON escape.
        flushUpTo(i - 1);
        parts.push(escapeForCode(code));
        chunkStart = i + 1;
      }
      continue;
    }

    if (quote !== null && code === CHAR_CODE_BACKSLASH) {
      esc = true;
      continue;
    }

    if (quote !== null) {
      if (code === quote) {
        quote = null;
        continue;
      }
      if (code <= CHAR_CODE_CONTROL_UPPER) {
        flushUpTo(i);
        parts.push(escapeForCode(code));
        chunkStart = i + 1;
      }
      continue;
    }

    if (
      code === CHAR_CODE_SLASH &&
      json.charCodeAt(i + 1) === CHAR_CODE_SLASH
    ) {
      i += 2;
      while (
        i < json.length &&
        json.charCodeAt(i) !== CHAR_CODE_LF &&
        json.charCodeAt(i) !== CHAR_CODE_CR
      ) {
        i += 1;
      }
      continue;
    }
    if (code === CHAR_CODE_SLASH && json.charCodeAt(i + 1) === CHAR_CODE_STAR) {
      i += 2;
      while (
        i + 1 < json.length &&
        !(
          json.charCodeAt(i) === CHAR_CODE_STAR &&
          json.charCodeAt(i + 1) === CHAR_CODE_SLASH
        )
      ) {
        i += 1;
      }
      i += 1;
      continue;
    }
    if (code === CHAR_CODE_QUOTE || code === CHAR_CODE_SINGLE_QUOTE) {
      quote = code;
    }
  }

  if (chunkStart < json.length) {
    parts.push(json.slice(chunkStart));
  }
  return parts.join("");
}
