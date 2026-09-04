import {
  consumeJsonDepthClose as consumeNormalizedJsonDepthClose,
  consumeJsonDepthOpen as consumeNormalizedJsonDepthOpen,
  consumeJsonObjectDepth as consumeNormalizedJsonObjectDepth,
  consumeExistingJsonString as consumeNormalizedJsonString,
  consumeJsonStringScanChar as consumeNormalizedJsonStringScanChar,
  type JsonDepthScanState as NormalizationJsonDepthScanState,
} from "./hermes-json-normalization";
import {
  collectPreviousSignificantChars as buildPreviousSignificantCharIndex,
  consumeJsonQuotedScanChar,
  skipJsonComment as findJsonCommentEnd,
  findQuotedKeyEnd,
  type JsonQuotedScanState,
} from "./hermes-json-significant-char-index";

const WHITESPACE_CHAR_RE = /\s/;
const QUOTE_RE = /^["']$/;
const SINGLE_QUOTED_KEY_ESCAPE_RE = /\\(?:u([0-9A-Fa-f]{4})|(.))/gs;
const RJSON_KEY_START_RE = /^[$A-Z_a-z]$/;
const RJSON_KEY_CHAR_RE = /^[-$0-9A-Z_a-z]$/;
const JSON_DEPTH_OPEN_CHARS = new Set(["{", "["]);
const JSON_DEPTH_CLOSE_CHARS = new Set(["}", "]"]);

export function skipJsonWhitespace(text: string, fromIndex: number): number {
  let index = fromIndex;
  while (index < text.length && WHITESPACE_CHAR_RE.test(text.charAt(index))) {
    index += 1;
  }
  return index;
}

export function collectPreviousSignificantChars(text: string): string[] {
  return buildPreviousSignificantCharIndex(text);
}

export function skipJsonComment(text: string, index: number): number | null {
  return findJsonCommentEnd(text, index);
}

export function isUnquotedRjsonKeyStart(char: string): boolean {
  return RJSON_KEY_START_RE.test(char);
}

function isUnquotedRjsonKeyChar(char: string): boolean {
  return RJSON_KEY_CHAR_RE.test(char);
}

export function parseQuotedObjectKey(
  text: string,
  keyStart: number
): {
  key: string;
  end: number;
} | null {
  const quote = text.charAt(keyStart);
  const end = findQuotedKeyEnd(text, keyStart, quote);
  if (end === null) {
    return null;
  }
  if (quote !== '"') {
    return {
      key: parseSingleQuotedObjectKey(text.slice(keyStart + 1, end)),
      end,
    };
  }
  try {
    return { key: JSON.parse(text.slice(keyStart, end + 1)), end };
  } catch {
    return null;
  }
}

function decodeSingleQuotedKeyEscape(
  _match: string,
  unicode: string | undefined,
  escaped: string | undefined
): string {
  if (unicode !== undefined) {
    return String.fromCharCode(Number.parseInt(unicode, 16));
  }
  return SINGLE_QUOTED_KEY_ESCAPES.get(escaped ?? "") ?? escaped ?? "";
}

function parseSingleQuotedObjectKey(body: string): string {
  return body.replace(SINGLE_QUOTED_KEY_ESCAPE_RE, decodeSingleQuotedKeyEscape);
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

export type JsonDepthScanState = NormalizationJsonDepthScanState;

export function consumeExistingJsonString(
  state: JsonDepthScanState,
  char: string
): boolean {
  return consumeNormalizedJsonString(state, char);
}

export function consumeJsonStringScanChar(
  state: JsonDepthScanState,
  char: string
): boolean {
  return consumeNormalizedJsonStringScanChar(state, char);
}

export function consumeJsonDepthOpen(
  state: JsonDepthScanState,
  char: string
): boolean {
  return consumeNormalizedJsonDepthOpen(state, char);
}

export function consumeJsonDepthClose(
  state: JsonDepthScanState,
  char: string
): "top-level-close" | "nested-close" | "none" {
  return consumeNormalizedJsonDepthClose(state, char);
}

export function consumeJsonObjectDepth(
  state: JsonDepthScanState,
  char: string
): boolean {
  return consumeNormalizedJsonObjectDepth(state, char);
}

/**
 * Maximum structural nesting (`{`/`[`) accepted for tool-call JSON.
 * Keeps recursive parsers/stringifiers from stack-overflowing on pathological
 * input; matches MAX_ARGUMENT_SHAPE_DEPTH / bare-call nesting limits.
 */
const MAX_TOOL_CALL_JSON_NESTING_DEPTH = 256;

interface NestingScanState extends JsonQuotedScanState {
  depth: number;
}

/** Apply `{`/`[`/`}`/`]` to nesting depth; true when maxDepth is exceeded. */
function applyNestingDepthChar(
  state: NestingScanState,
  char: string,
  maxDepth: number
): boolean {
  if (JSON_DEPTH_OPEN_CHARS.has(char)) {
    state.depth += 1;
    return state.depth > maxDepth;
  }
  if (JSON_DEPTH_CLOSE_CHARS.has(char) && state.depth > 0) {
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
  const state: NestingScanState = {
    depth: 0,
    escaping: false,
    quoteChar: null,
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (consumeJsonQuotedScanChar(state, char)) {
      continue;
    }
    if (QUOTE_RE.test(char)) {
      state.quoteChar = char;
      continue;
    }
    const commentEnd = skipJsonComment(text, index);
    if (commentEnd !== null) {
      index = commentEnd;
      continue;
    }
    if (applyNestingDepthChar(state, char, maxDepth)) {
      return true;
    }
  }

  return false;
}

interface ObjectKeyCandidate {
  readonly keys: readonly string[];
  readonly nextIndex: number;
}

function advanceObjectKeyDepth(
  state: { depth: number },
  char: string
): "closed" | "changed" | "unchanged" {
  if (char === "{") {
    state.depth += 1;
    return "changed";
  }
  if (char !== "}") {
    return "unchanged";
  }
  state.depth -= 1;
  return state.depth === 0 ? "closed" : "changed";
}

interface StrictJsonPropertyCandidate {
  key?: string;
  nextIndex: number;
  valueStart?: number;
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

function shouldCollectObjectKey(
  depth: number,
  includeNested: boolean
): boolean {
  return depth >= 1 && (includeNested || depth === 1);
}

function readObjectKeyCandidate(
  text: string,
  index: number,
  previousSignificant: string
): ObjectKeyCandidate | null | undefined {
  const char = text.charAt(index);
  const quoted = char === '"' || char === "'";
  if (
    !(
      quoted ||
      (isUnquotedRjsonKeyStart(char) &&
        ["{", ","].includes(previousSignificant))
    )
  ) {
    return;
  }
  const parsedKey = quoted
    ? parseQuotedObjectKey(text, index)
    : parseUnquotedObjectKey(text, index);
  if (parsedKey === null) {
    return null;
  }
  const valueCursor = skipJsonWhitespace(text, parsedKey.end + 1);
  if (text.charAt(valueCursor) === ":") {
    return { keys: [parsedKey.key], nextIndex: valueCursor };
  }
  return quoted ? { keys: [], nextIndex: parsedKey.end } : undefined;
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
  const quoteState: JsonQuotedScanState = {
    escaping: false,
    quoteChar: null,
  };
  const depthState = { depth: 0 };
  const previousByIndex = collectPreviousSignificantChars(text);

  for (let index = objectStart; index < text.length; index += 1) {
    const char = text.charAt(index);

    if (consumeJsonQuotedScanChar(quoteState, char)) {
      continue;
    }

    const commentEnd = skipJsonComment(text, index);
    if (commentEnd !== null) {
      index = commentEnd;
      continue;
    }

    const depthTransition = advanceObjectKeyDepth(depthState, char);
    if (depthTransition === "closed") {
      return keys;
    }
    if (depthTransition === "changed") {
      continue;
    }
    if (!shouldCollectObjectKey(depthState.depth, includeNested)) {
      quoteState.quoteChar = QUOTE_RE.test(char) ? char : null;
      continue;
    }

    const candidate = readObjectKeyCandidate(
      text,
      index,
      previousByIndex[index] ?? ""
    );
    if (candidate === null) {
      return null;
    }
    keys.push(...(candidate?.keys ?? []));
    index = candidate?.nextIndex ?? index;
  }

  return null;
}
