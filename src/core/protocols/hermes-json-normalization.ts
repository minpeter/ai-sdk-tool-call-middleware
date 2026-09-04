import {
  isJSONObject,
  isJSONValue,
  type JSONObject,
  type JSONValue,
  type LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { stringifyToolInputWithSchema } from "../utils/tool-input-streaming";

interface ParsedToolCallRecord extends JSONObject {
  arguments?: JSONValue;
  name: string;
}

function canonicalizeToolInput(argumentsValue: JSONValue | undefined): string {
  return JSON.stringify(argumentsValue ?? {});
}

function stringifyParsedToolInput(args: JSONValue | undefined): string {
  return args === null ? "null" : canonicalizeToolInput(args);
}

export function stringifyResolvedToolInput(
  toolName: string,
  args: JSONValue | undefined,
  tools: LanguageModelV4FunctionTool[]
): string {
  return stringifyToolInputWithSchema({
    toolName,
    args,
    tools,
    fallback: (value) =>
      isJSONValue(value)
        ? stringifyParsedToolInput(value)
        : JSON.stringify(value ?? {}),
  });
}

export function isParsedToolCallRecord(
  value: JSONValue | undefined
): value is ParsedToolCallRecord {
  return (
    isJSONObject(value) &&
    Object.hasOwn(value, "name") &&
    typeof value.name === "string"
  );
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

interface JsonStringScanState {
  escaping: boolean;
  quote: JsonStringQuote | null;
}

function consumeJsonStringCode(
  state: JsonStringScanState,
  code: number
): boolean | null {
  if (state.escaping) {
    state.escaping = false;
    return code <= CHAR_CODE_CONTROL_UPPER;
  }
  if (state.quote === null) {
    return null;
  }
  if (code === CHAR_CODE_BACKSLASH) {
    state.escaping = true;
    return false;
  }
  if (code === state.quote) {
    state.quote = null;
    return false;
  }
  return code <= CHAR_CODE_CONTROL_UPPER;
}

function skipRelaxedJsonComment(json: string, index: number): number | null {
  if (json.charCodeAt(index) !== CHAR_CODE_SLASH) {
    return null;
  }
  const next = json.charCodeAt(index + 1);
  if (next === CHAR_CODE_SLASH) {
    let cursor = index + 2;
    while (
      cursor < json.length &&
      ![CHAR_CODE_LF, CHAR_CODE_CR].includes(json.charCodeAt(cursor))
    ) {
      cursor += 1;
    }
    return cursor;
  }
  if (next === CHAR_CODE_STAR) {
    let cursor = index + 2;
    while (
      cursor + 1 < json.length &&
      !(
        json.charCodeAt(cursor) === CHAR_CODE_STAR &&
        json.charCodeAt(cursor + 1) === CHAR_CODE_SLASH
      )
    ) {
      cursor += 1;
    }
    return cursor + 1;
  }
  return null;
}

function hasControlCharInString(json: string): boolean {
  const state: JsonStringScanState = { quote: null, escaping: false };
  for (let index = 0; index < json.length; index += 1) {
    const code = json.charCodeAt(index);
    const control = consumeJsonStringCode(state, code);
    if (control === true) {
      return true;
    }
    if (control === false) {
      continue;
    }
    const commentEnd = skipRelaxedJsonComment(json, index);
    if (commentEnd !== null) {
      index = commentEnd;
    } else if (code === CHAR_CODE_QUOTE || code === CHAR_CODE_SINGLE_QUOTE) {
      state.quote = code;
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
interface JsonControlNormalizationState extends JsonStringScanState {
  chunkStart: number;
  readonly parts: string[];
}

function escapeForCode(code: number): string {
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
}

function replaceControlCode(
  state: JsonControlNormalizationState,
  json: string,
  index: number
): void {
  const escapedControl = state.escaping;
  const end = index - (escapedControl ? 1 : 0);
  if (state.chunkStart < end) {
    state.parts.push(json.slice(state.chunkStart, end));
  }
  state.parts.push(escapeForCode(json.charCodeAt(index)));
  state.chunkStart = index + 1;
}

function consumeNormalizationStringCode(
  state: JsonControlNormalizationState,
  json: string,
  index: number
): boolean {
  const code = json.charCodeAt(index);
  const wasEscaping = state.escaping;
  const consumed = consumeJsonStringCode(state, code);
  if (consumed === null) {
    return false;
  }
  if (consumed) {
    state.escaping = wasEscaping;
    replaceControlCode(state, json, index);
    state.escaping = false;
  }
  return true;
}

export function normalizeJsonStringCtrl(json: string): string {
  if (!hasControlCharInString(json)) {
    return json;
  }
  const state: JsonControlNormalizationState = {
    quote: null,
    escaping: false,
    chunkStart: 0,
    parts: [],
  };
  for (let index = 0; index < json.length; index += 1) {
    const code = json.charCodeAt(index);
    if (consumeNormalizationStringCode(state, json, index)) {
      continue;
    }
    const commentEnd = skipRelaxedJsonComment(json, index);
    if (commentEnd !== null) {
      index = commentEnd;
    } else if (code === CHAR_CODE_QUOTE || code === CHAR_CODE_SINGLE_QUOTE) {
      state.quote = code;
    }
  }
  if (state.chunkStart < json.length) {
    state.parts.push(json.slice(state.chunkStart));
  }
  return state.parts.join("");
}

export interface JsonDepthScanState {
  depth: number;
  escaping: boolean;
  inString: boolean;
}

export function consumeExistingJsonString(
  state: JsonDepthScanState,
  char: string
): boolean {
  if (!state.inString) {
    return false;
  }
  if (state.escaping) {
    state.escaping = false;
  } else if (char === "\\") {
    state.escaping = true;
  } else if (char === '"') {
    state.inString = false;
  }
  return true;
}

export function consumeJsonStringScanChar(
  state: JsonDepthScanState,
  char: string
): boolean {
  if (consumeExistingJsonString(state, char)) {
    return true;
  }
  state.inString = char === '"';
  return state.inString;
}

export function consumeJsonDepthOpen(
  state: JsonDepthScanState,
  char: string
): boolean {
  if (char !== "{" && char !== "[") {
    return false;
  }
  state.depth += 1;
  return true;
}

export function consumeJsonDepthClose(
  state: JsonDepthScanState,
  char: string
): "top-level-close" | "nested-close" | "none" {
  if (char !== "}" && char !== "]") {
    return "none";
  }
  if (state.depth > 0) {
    state.depth -= 1;
    return "nested-close";
  }
  return "top-level-close";
}

export function consumeJsonObjectDepth(
  state: JsonDepthScanState,
  char: string
): boolean {
  if (char === "{") {
    state.depth += 1;
    return true;
  }
  if (char === "}") {
    state.depth = Math.max(0, state.depth - 1);
    return true;
  }
  return false;
}
