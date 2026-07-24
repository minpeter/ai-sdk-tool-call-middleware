const HEX_WORD_RE = /^[0-9A-Fa-f]{4}$/;
const WHITESPACE_CHAR_RE = /\s/;
const WHITESPACE_JSON_REGEX = /\s/;

export function skipJsonWhitespace(text: string, fromIndex: number): number {
  let index = fromIndex;
  while (index < text.length && WHITESPACE_JSON_REGEX.test(text[index])) {
    index += 1;
  }
  return index;
}

export function isUnquotedRjsonKeyStart(char: string): boolean {
  return (
    char === "_" ||
    char === "$" ||
    (char >= "A" && char <= "Z") ||
    (char >= "a" && char <= "z")
  );
}

function isUnquotedRjsonKeyChar(char: string): boolean {
  return (
    isUnquotedRjsonKeyStart(char) ||
    (char >= "0" && char <= "9") ||
    char === "-"
  );
}

export function parseQuotedObjectKey(
  text: string,
  keyStart: number
): {
  key: string;
  end: number;
} | null {
  const quote = text.charAt(keyStart);
  let index = keyStart + 1;
  let escaped = false;
  while (index < text.length) {
    const char = text.charAt(index);
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === quote) {
      if (quote === '"') {
        try {
          return {
            key: JSON.parse(text.slice(keyStart, index + 1)),
            end: index,
          };
        } catch {
          return null;
        }
      }
      return {
        key: parseSingleQuotedObjectKey(text.slice(keyStart + 1, index)),
        end: index,
      };
    }
    index += 1;
  }
  return null;
}

function parseSingleQuotedObjectKey(body: string): string {
  let result = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body.charAt(index);
    if (char !== "\\" || index === body.length - 1) {
      result += char;
      continue;
    }

    const escaped = body.charAt(index + 1);
    if (escaped === "u") {
      const hex = body.slice(index + 2, index + 6);
      if (HEX_WORD_RE.test(hex)) {
        result += String.fromCharCode(Number.parseInt(hex, 16));
        index += 5;
        continue;
      }
    }

    const decoded = SINGLE_QUOTED_KEY_ESCAPES.get(escaped);
    result += decoded ?? escaped;
    index += 1;
  }
  return result;
}

const SINGLE_QUOTED_KEY_ESCAPES = new Map<string, string>([
  ["'", "'"],
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

export function parseUnquotedObjectKey(
  text: string,
  keyStart: number
): {
  key: string;
  end: number;
} | null {
  if (!isUnquotedRjsonKeyStart(text.charAt(keyStart))) {
    return null;
  }
  let index = keyStart + 1;
  while (index < text.length && isUnquotedRjsonKeyChar(text.charAt(index))) {
    index += 1;
  }
  return { key: text.slice(keyStart, index), end: index - 1 };
}

export function previousSignificantChar(text: string, index: number): string {
  let cursor = index - 1;
  while (cursor >= 0) {
    while (cursor >= 0 && WHITESPACE_CHAR_RE.test(text.charAt(cursor))) {
      cursor -= 1;
    }
    if (cursor < 0) {
      return "";
    }
    if (text.charAt(cursor) === "/" && text.charAt(cursor - 1) === "*") {
      const commentStart = text.lastIndexOf("/*", cursor - 2);
      if (commentStart === -1) {
        return "/";
      }
      cursor = commentStart - 1;
      continue;
    }
    const lineStart = text.lastIndexOf("\n", cursor) + 1;
    const lineCommentStart = findLineCommentStartBefore(
      text,
      lineStart,
      cursor
    );
    if (lineCommentStart >= lineStart) {
      cursor = lineCommentStart - 1;
      continue;
    }
    return text.charAt(cursor);
  }
  return "";
}

function findLineCommentStartBefore(
  text: string,
  lineStart: number,
  cursor: number
): number {
  const state: QuotedScanState = { escaping: false, quoteChar: null };
  let lastCommentStart = -1;
  let index = lineStart;
  while (index < cursor) {
    const char = text.charAt(index);
    if (consumeQuotedScanChar(state, char)) {
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      state.quoteChar = char;
      index += 1;
      continue;
    }
    if (char === "/" && text.charAt(index + 1) === "*") {
      const blockEnd = text.indexOf("*/", index + 2);
      if (blockEnd === -1 || blockEnd > cursor) {
        return lastCommentStart;
      }
      index = blockEnd + 2;
      continue;
    }
    if (
      char === "/" &&
      text.charAt(index + 1) === "/" &&
      startsRjsonComment(text, index, lineStart)
    ) {
      lastCommentStart = index;
      index += 2;
      continue;
    }
    index += 1;
  }
  return lastCommentStart;
}

export function skipJsonComment(text: string, index: number): number | null {
  if (text.charAt(index) !== "/") {
    return null;
  }
  const next = text.charAt(index + 1);
  if (next === "/") {
    const lf = text.indexOf("\n", index + 2);
    const cr = text.indexOf("\r", index + 2);
    let end = Math.min(lf, cr);
    if (lf === -1) {
      end = cr;
    } else if (cr === -1) {
      end = lf;
    }
    return end === -1 ? text.length - 1 : end - 1;
  }
  if (next === "*") {
    const end = text.indexOf("*/", index + 2);
    return end === -1 ? text.length - 1 : end + 1;
  }
  return null;
}

interface QuotedScanState {
  escaping: boolean;
  quoteChar: string | null;
}

export interface JsonDepthScanState {
  depth: number;
  escaping: boolean;
  inString: boolean;
}

/**
 * Maximum structural nesting (`{`/`[`) accepted for tool-call JSON.
 * Keeps recursive parsers/stringifiers from stack-overflowing on pathological
 * input; matches MAX_ARGUMENT_SHAPE_DEPTH / bare-call nesting limits.
 */
export const MAX_TOOL_CALL_JSON_NESTING_DEPTH = 256;

interface NestingScanState {
  depth: number;
  escaping: boolean;
  quote: '"' | "'" | null;
}

/** Advance past a string literal character; returns true while still inside. */
function consumeNestingStringChar(
  state: NestingScanState,
  char: string
): boolean {
  if (state.quote === null) {
    return false;
  }
  if (state.escaping) {
    state.escaping = false;
  } else if (char === "\\") {
    state.escaping = true;
  } else if (char === state.quote) {
    state.quote = null;
  }
  return true;
}

/**
 * Skip line (`//`) or block comments. Returns next index to scan, or -1 when
 * the comment runs to EOF (caller should treat nesting as within limit).
 */
function skipNestingComment(text: string, index: number): number | null {
  if (text.charAt(index) !== "/") {
    return null;
  }
  const next = text.charAt(index + 1);
  if (next === "/") {
    const lineEnd = text.indexOf("\n", index + 2);
    return lineEnd === -1 ? -1 : lineEnd;
  }
  if (next === "*") {
    const blockEnd = text.indexOf("*/", index + 2);
    return blockEnd === -1 ? -1 : blockEnd + 1;
  }
  return null;
}

/** Apply `{`/`[`/`}`/`]` to nesting depth; true when maxDepth is exceeded. */
function applyNestingDepthChar(
  state: NestingScanState,
  char: string,
  maxDepth: number
): boolean {
  if (char === "{" || char === "[") {
    state.depth += 1;
    return state.depth > maxDepth;
  }
  if ((char === "}" || char === "]") && state.depth > 0) {
    state.depth -= 1;
  }
  return false;
}

/**
 * O(n) scan: true when `{`/`[` nesting (outside strings/comments) exceeds
 * `maxDepth`. Used as a fail-closed preflight before recursive RJSON/JSON
 * parse or stringify.
 */
export function exceedsToolCallJsonNestingDepth(
  text: string,
  maxDepth: number = MAX_TOOL_CALL_JSON_NESTING_DEPTH
): boolean {
  const state: NestingScanState = { depth: 0, escaping: false, quote: null };

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);

    if (consumeNestingStringChar(state, char)) {
      continue;
    }

    if (char === '"' || char === "'") {
      state.quote = char;
      continue;
    }

    const commentIndex = skipNestingComment(text, index);
    if (commentIndex !== null) {
      if (commentIndex === -1) {
        return false;
      }
      index = commentIndex;
      continue;
    }

    if (applyNestingDepthChar(state, char, maxDepth)) {
      return true;
    }
  }

  return false;
}

interface ObjectKeyCandidate {
  key?: string;
  nextIndex: number;
}

interface StrictJsonPropertyCandidate {
  key?: string;
  nextIndex: number;
  valueStart?: number;
}

function consumeQuotedScanChar(state: QuotedScanState, char: string): boolean {
  if (!state.quoteChar) {
    return false;
  }
  if (state.escaping) {
    state.escaping = false;
  } else if (char === "\\") {
    state.escaping = true;
  } else if (char === state.quoteChar) {
    state.quoteChar = null;
  }
  return true;
}

function objectKeyDepthTransition(
  state: { depth: number },
  char: string
): "closed" | "changed" | "none" {
  if (char === "{") {
    state.depth += 1;
    return "changed";
  }
  if (char === "}") {
    state.depth -= 1;
    return state.depth === 0 ? "closed" : "changed";
  }
  return "none";
}

function shouldCollectObjectKey(
  depth: number,
  includeNested: boolean
): boolean {
  return depth >= 1 && (includeNested || depth === 1);
}

function readUnquotedObjectKeyCandidate(
  text: string,
  index: number,
  char: string
): ObjectKeyCandidate | null | undefined {
  if (!isUnquotedRjsonKeyStart(char)) {
    return;
  }
  const previous = previousSignificantChar(text, index);
  if (!(previous === "{" || previous === ",")) {
    return;
  }
  const parsedKey = parseUnquotedObjectKey(text, index);
  if (!parsedKey) {
    return null;
  }
  const valueCursor = skipJsonWhitespace(text, parsedKey.end + 1);
  return text.charAt(valueCursor) === ":"
    ? { key: parsedKey.key, nextIndex: valueCursor }
    : undefined;
}

function readQuotedObjectKeyCandidate(
  text: string,
  index: number
): ObjectKeyCandidate | null {
  const parsedKey = parseQuotedObjectKey(text, index);
  if (!parsedKey) {
    return null;
  }
  const valueCursor = skipJsonWhitespace(text, parsedKey.end + 1);
  return text.charAt(valueCursor) === ":"
    ? { key: parsedKey.key, nextIndex: valueCursor }
    : { nextIndex: parsedKey.end };
}

export function readStrictJsonPropertyCandidate(
  text: string,
  index: number
): StrictJsonPropertyCandidate | null {
  const parsedKey = parseQuotedObjectKey(text, index);
  if (!parsedKey) {
    return null;
  }
  let valueCursor = skipJsonWhitespace(text, parsedKey.end + 1);
  if (valueCursor >= text.length || text.charAt(valueCursor) !== ":") {
    return { nextIndex: parsedKey.end };
  }
  valueCursor = skipJsonWhitespace(text, valueCursor + 1);
  return {
    key: parsedKey.key,
    nextIndex: valueCursor - 1,
    valueStart: valueCursor,
  };
}

function readObjectKeyCandidate(
  text: string,
  index: number,
  char: string
): ObjectKeyCandidate | null | undefined {
  return char === '"' || char === "'"
    ? readQuotedObjectKeyCandidate(text, index)
    : readUnquotedObjectKeyCandidate(text, index, char);
}

function appendObjectKeyCandidate(
  keys: string[],
  text: string,
  index: number,
  char: string
): { invalid: boolean; nextIndex: number } {
  const candidate = readObjectKeyCandidate(text, index, char);
  if (candidate === null) {
    return { invalid: true, nextIndex: index };
  }
  if (candidate?.key) {
    keys.push(candidate.key);
  }
  return {
    invalid: false,
    nextIndex: candidate?.nextIndex ?? index,
  };
}

export function consumeJsonStringScanChar(
  state: JsonDepthScanState,
  char: string
): boolean {
  if (state.escaping) {
    state.escaping = false;
    return true;
  }
  if (state.inString) {
    if (char === "\\") {
      state.escaping = true;
    } else if (char === '"') {
      state.inString = false;
    }
    return true;
  }
  if (char === '"') {
    state.inString = true;
    return true;
  }
  return false;
}

export function consumeJsonDepthOpen(
  state: JsonDepthScanState,
  char: string
): boolean {
  if (!(char === "{" || char === "[")) {
    return false;
  }
  state.depth += 1;
  return true;
}

export function consumeJsonDepthClose(
  state: JsonDepthScanState,
  char: string
): "top-level-close" | "nested-close" | "none" {
  if (!(char === "}" || char === "]")) {
    return "none";
  }
  if (state.depth > 0) {
    state.depth -= 1;
    return "nested-close";
  }
  return "top-level-close";
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

export function collectObjectKeys(
  text: string,
  objectStart: number,
  includeNested: boolean
): string[] | null {
  if (text.charAt(objectStart) !== "{") {
    return null;
  }

  const keys: string[] = [];
  const quoteState: QuotedScanState = { escaping: false, quoteChar: null };
  const depthState = { depth: 0 };

  for (let index = objectStart; index < text.length; index += 1) {
    const char = text.charAt(index);

    if (consumeQuotedScanChar(quoteState, char)) {
      continue;
    }

    const commentEnd = skipJsonComment(text, index);
    if (commentEnd !== null) {
      index = commentEnd;
      continue;
    }

    const depthTransition = objectKeyDepthTransition(depthState, char);
    if (depthTransition === "closed") {
      return keys;
    }
    if (depthTransition === "changed") {
      continue;
    }
    if (!shouldCollectObjectKey(depthState.depth, includeNested)) {
      if (char === '"' || char === "'") {
        quoteState.quoteChar = char;
      }
      continue;
    }

    const candidate = appendObjectKeyCandidate(keys, text, index, char);
    if (candidate.invalid) {
      return null;
    }
    index = candidate.nextIndex;
  }

  return null;
}

/**
 * Unwrap the double-encoded arguments variant some models emit
 * (`"arguments": "{\"city\": \"Seoul\"}"` — the OpenAI native wire shape,
 * observed live on IBM Granite 4.0). Returns the parsed record, or null when
 * the string is not a safe JSON object.
 */
import { startsRjsonComment } from "./hermes-call-boundary";
