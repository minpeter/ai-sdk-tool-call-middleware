import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { parse as parseRJSON } from "../../rjson";
import {
  coerceBySchema,
  compileSafePatternPropertyRegex,
  getSchemaType,
  schemaIsUnconstrained,
  unwrapJsonSchema,
} from "../../schema-coerce";
import { logParseFailure } from "../utils/debug";
import { recoverToolCallFromJsonCandidates } from "../utils/generated-text-json-recovery";
import { generateToolCallId } from "../utils/id";
import {
  emitToolInputProgressDelta,
  stringifyToolInputWithSchema,
} from "../utils/tool-input-streaming";
import { argumentValueMatchesSchemaKeyShape } from "./hermes-argument-schema";
import { unsafeDeniedPatternMayMatchKey } from "./hermes-unsafe-pattern";
import type { ParserOptions } from "./protocol-interface";

interface HermesProtocolOptions {
  toolCallEnd?: string;
  toolCallStart?: string;
}

/**
 * Hermes call-parsing primitives shared by the generate-path parser and the
 * streaming state machine in hermes-protocol.ts: relaxed JSON scanning and
 * repair, argument-body recovery, key-policy coercion, and boundary-safe
 * string handling for `<tool_call>` JSON payloads.
 */
const RJSON_IDENTIFIER_CHAR_REGEX = /[$a-zA-Z0-9_\-+.*?!|&%^/#\\]/;
const RJSON_NUMBER_TOKEN_REGEX = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const HEX_WORD_RE = /^[0-9A-Fa-f]{4}$/;
const WHITESPACE_CHAR_RE = /\s/;

export function validateNonEmptyDelimiters(
  toolCallStart: string,
  toolCallEnd: string
): Record<never, never> {
  if (toolCallStart.length === 0) {
    throw new TypeError("hermesProtocol toolCallStart must not be empty");
  }
  if (toolCallEnd.length === 0) {
    throw new TypeError("hermesProtocol toolCallEnd must not be empty");
  }
  return {};
}

function isRjsonIdentifierChar(ch: string | undefined): boolean {
  return ch != null && RJSON_IDENTIFIER_CHAR_REGEX.test(ch);
}

function isRjsonPropertyLikeDelimiter(startTag: string): boolean {
  const key = startTag.endsWith(":") ? startTag.slice(0, -1) : "";
  return key.length > 0 && [...key].every((ch) => isRjsonIdentifierChar(ch));
}

function previousRjsonToken(json: string, index: number, minIndex = 0): string {
  let start = index - 1;
  while (start >= minIndex && isRjsonIdentifierChar(json[start])) {
    start -= 1;
  }
  return json.slice(start + 1, index);
}

function previousTokenAllowsComment(
  json: string,
  index: number,
  minIndex = 0
): boolean {
  const previous = previousRjsonToken(json, index, minIndex);
  if (previous.length === 0) {
    return true;
  }
  return (
    RJSON_NUMBER_TOKEN_REGEX.test(previous) ||
    previous === "true" ||
    previous === "false" ||
    previous === "null"
  );
}

function startsRjsonComment(
  json: string,
  index: number,
  minIndex = 0
): boolean {
  if (
    !(
      (json[index] === "/" && json[index + 1] === "/") ||
      (json[index] === "/" && json[index + 1] === "*")
    )
  ) {
    return false;
  }
  if (index > minIndex && isRjsonIdentifierChar(json[index - 1])) {
    return previousTokenAllowsComment(json, index, minIndex);
  }
  return true;
}

/**
 * Detect whether `segment` contains an occurrence of `startTag` outside any
 * relaxed-JSON string or comment. Used to identify nested `<tool_call>` start
 * tags that indicate the current tool call's `</tool_call>` actually belongs
 * to a later tool call (i.e. the current call is orphaned / malformed).
 */
function hasNestedStartBoundary(segment: string, startIndex: number): boolean {
  const previous = segment[startIndex - 1];
  return (
    previous == null || WHITESPACE_JSON_REGEX.test(previous) || previous === "}"
  );
}

function isLikelyNestedToolCallStart(
  segment: string,
  startIndex: number,
  startTag: string
): boolean {
  if (isRjsonPropertyLikeDelimiter(startTag)) {
    return false;
  }
  const jsonStart = skipJsonWhitespace(segment, startIndex + startTag.length);
  return (
    segment[jsonStart] === "{" && hasNestedStartBoundary(segment, startIndex)
  );
}

type ToolCallBoundary =
  | { kind: "end"; endIdx: number }
  | { kind: "nested"; endIdx: number; nestedStartIndex: number };

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Boundary scanning tracks relaxed JSON string/comment state and two delimiter types in one pass.
export function findToolCallBoundaryOutsideRjsonSyntax(
  text: string,
  scanFrom: number,
  startTag: string,
  endTag: string
): ToolCallBoundary | null {
  let quote: '"' | "'" | null = null;
  let esc = false;
  let inLineComment = false;
  let inBlockComment = false;
  let lineCommentSawEndTag = false;
  let blockCommentSawEndTag = false;
  let nestedStartIndex: number | null = null;

  for (let index = scanFrom; index < text.length; index += 1) {
    const ch = text[index];

    if (esc) {
      esc = false;
      continue;
    }

    if (quote !== null) {
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (inLineComment) {
      if (ch === "\n" || ch === "\r") {
        inLineComment = false;
        lineCommentSawEndTag = false;
        continue;
      }
      if (text.startsWith(endTag, index)) {
        lineCommentSawEndTag = true;
        index += endTag.length - 1;
        continue;
      }
      if (
        lineCommentSawEndTag &&
        text.startsWith(startTag, index) &&
        text[skipJsonWhitespace(text, index + startTag.length)] === "{"
      ) {
        nestedStartIndex = index;
        inLineComment = false;
        lineCommentSawEndTag = false;
        index += startTag.length - 1;
        continue;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && text[index + 1] === "/") {
        inBlockComment = false;
        blockCommentSawEndTag = false;
        index += 1;
        continue;
      }
      if (text.startsWith(endTag, index)) {
        blockCommentSawEndTag = true;
        index += endTag.length - 1;
        continue;
      }
      if (
        blockCommentSawEndTag &&
        text.startsWith(startTag, index) &&
        text[skipJsonWhitespace(text, index + startTag.length)] === "{"
      ) {
        nestedStartIndex = index;
        inBlockComment = false;
        blockCommentSawEndTag = false;
        index += startTag.length - 1;
        continue;
      }
      continue;
    }

    if (startsRjsonComment(text, index, scanFrom)) {
      if (text[index + 1] === "/") {
        inLineComment = true;
        lineCommentSawEndTag = false;
        index += 1;
        continue;
      }
      if (text[index + 1] === "*") {
        inBlockComment = true;
        blockCommentSawEndTag = false;
        index += 1;
        continue;
      }
    }

    if (text.startsWith(endTag, index)) {
      return nestedStartIndex == null
        ? { kind: "end", endIdx: index }
        : { kind: "nested", endIdx: index, nestedStartIndex };
    }

    if (
      nestedStartIndex == null &&
      text.startsWith(startTag, index) &&
      isLikelyNestedToolCallStart(text, index, startTag)
    ) {
      nestedStartIndex = index;
      index += startTag.length - 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
    }
  }

  return null;
}

/**
 * Locate the next valid `<tool_call>...</tool_call>` span in `text` starting
 * at `searchFrom`. Skips `</tool_call>` sequences that occur inside
 * relaxed-JSON strings or comments, and bails out when a nested `<tool_call>`
 * start tag appears outside a string/comment (treating the current start tag
 * as orphaned — its presumed close belongs to a later call).
 *
 * Returns:
 *   - `null`: no more start tags in the remaining text
 *   - `{ startIdx, found: true, jsonStart, endIdx }`: a valid span
 *   - `{ startIdx, found: false }`: an orphan start tag (caller should skip
 *     past it and resume scanning)
 */
export function findNextToolCallSpan(
  text: string,
  searchFrom: number,
  startTag: string,
  endTag: string
):
  | { startIdx: number; found: true; jsonStart: number; endIdx: number }
  | { startIdx: number; found: false }
  | null {
  const startIdx = text.indexOf(startTag, searchFrom);
  if (startIdx === -1) {
    return null;
  }
  const jsonStart = startIdx + startTag.length;

  const boundary = findToolCallBoundaryOutsideRjsonSyntax(
    text,
    jsonStart,
    startTag,
    endTag
  );
  if (boundary == null) {
    return { startIdx, found: false };
  }
  if (boundary.kind === "nested") {
    // Nested <tool_call> outside a string/comment — abandon this
    // start; its presumed </tool_call> belongs to a later call.
    return { startIdx, found: false };
  }
  return { startIdx, found: true, jsonStart, endIdx: boundary.endIdx };
}

export function canonicalizeToolInput(argumentsValue: unknown): string {
  return JSON.stringify(argumentsValue ?? {});
}

function stringifyParsedToolInput(
  toolName: string,
  args: unknown,
  tools: LanguageModelV4FunctionTool[]
): string {
  return stringifyToolInputWithSchema({
    toolName,
    args,
    tools,
    fallback: canonicalizeToolInput,
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

interface ArgumentKeyPolicy {
  allowUnknownKeys: boolean;
  deniedKeys: Set<string>;
  deniedPatterns: RegExp[];
  keyPatterns: RegExp[];
  knownKeys: Set<string>;
  rejectAll: boolean;
  rejectNonRecordArguments: boolean;
  schema: unknown;
  unsafeDeniedPatterns: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaRejectsNonRecordArguments(
  schema: unknown,
  seen = new Set<object>()
): boolean {
  const unwrapped = unwrapJsonSchema(schema);
  if (unwrapped === false) {
    return true;
  }
  if (!isRecord(unwrapped)) {
    return false;
  }
  if (seen.has(unwrapped)) {
    return false;
  }
  seen.add(unwrapped);
  if (
    getSchemaType(unwrapped) === "object" ||
    isRecord(unwrapped.properties) ||
    isRecord(unwrapped.patternProperties) ||
    Array.isArray(unwrapped.required) ||
    Object.hasOwn(unwrapped, "additionalProperties")
  ) {
    return true;
  }

  const allOf = Array.isArray(unwrapped.allOf) ? unwrapped.allOf : undefined;
  if (
    allOf?.some((subSchema) =>
      schemaRejectsNonRecordArguments(subSchema, new Set(seen))
    )
  ) {
    return true;
  }

  const anyOf = Array.isArray(unwrapped.anyOf) ? unwrapped.anyOf : undefined;
  if (
    anyOf &&
    anyOf.length > 0 &&
    anyOf.every((subSchema) =>
      schemaRejectsNonRecordArguments(subSchema, new Set(seen))
    )
  ) {
    return true;
  }

  const oneOf = Array.isArray(unwrapped.oneOf) ? unwrapped.oneOf : undefined;
  return (
    oneOf !== undefined &&
    oneOf.length > 0 &&
    oneOf.every((subSchema) =>
      schemaRejectsNonRecordArguments(subSchema, new Set(seen))
    )
  );
}

function extractArgumentKeyPolicy(
  tools: LanguageModelV4FunctionTool[],
  toolName: string
): ArgumentKeyPolicy | undefined {
  const tool = tools.find((t) => t.name === toolName);
  const schema = unwrapJsonSchema(tool?.inputSchema);
  if (schema === false) {
    return {
      allowUnknownKeys: false,
      deniedKeys: new Set(),
      deniedPatterns: [],
      keyPatterns: [],
      knownKeys: new Set(),
      rejectAll: true,
      rejectNonRecordArguments: true,
      schema,
      unsafeDeniedPatterns: [],
    };
  }
  if (!isRecord(schema)) {
    return;
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const patternProperties = isRecord(schema.patternProperties)
    ? schema.patternProperties
    : {};
  const deniedPatterns: RegExp[] = [];
  const keyPatterns: RegExp[] = [];
  const unsafeDeniedPatterns: string[] = [];
  for (const [pattern, patternSchema] of Object.entries(patternProperties)) {
    const regex = compileSafePatternPropertyRegex(pattern);
    if (patternSchema === false) {
      if (regex) {
        deniedPatterns.push(regex);
      } else {
        unsafeDeniedPatterns.push(pattern);
      }
      continue;
    }
    if (regex) {
      keyPatterns.push(regex);
    } else if (
      patternSchema === false ||
      !schemaIsUnconstrained(patternSchema)
    ) {
      unsafeDeniedPatterns.push(pattern);
    }
  }
  const propertyEntries = Object.entries(properties);
  return {
    allowUnknownKeys: schema.additionalProperties !== false,
    deniedKeys: new Set(
      propertyEntries
        .filter(([, propertySchema]) => propertySchema === false)
        .map(([key]) => key)
    ),
    deniedPatterns,
    keyPatterns,
    knownKeys: new Set(
      propertyEntries
        .filter(([, propertySchema]) => propertySchema !== false)
        .map(([key]) => key)
    ),
    rejectAll: false,
    rejectNonRecordArguments: schemaRejectsNonRecordArguments(schema),
    schema,
    unsafeDeniedPatterns,
  };
}

function applyArgumentKeyPolicy(
  args: Record<string, unknown>,
  keyPolicy?: ArgumentKeyPolicy
): Record<string, unknown> | null {
  if (keyPolicy?.rejectAll) {
    return null;
  }
  if (containsPrototypeSensitiveArgumentKey(args)) {
    return null;
  }
  if (
    keyPolicy &&
    Object.keys(args).some((key) => argumentKeyDeniedByPolicy(key, keyPolicy))
  ) {
    return null;
  }
  const policyArgs = coerceArgsForKeyPolicy(args, keyPolicy);
  if (!isRecord(policyArgs)) {
    return null;
  }
  if (containsPrototypeSensitiveArgumentKey(policyArgs)) {
    return null;
  }
  if (
    keyPolicy &&
    Object.keys(policyArgs).some((key) =>
      argumentKeyDeniedByPolicy(key, keyPolicy)
    )
  ) {
    return null;
  }
  if (keyPolicy && !keyPolicy.allowUnknownKeys) {
    const rawUnknownKeys = Object.keys(args).filter(
      (key) => !argumentKeyMatchesPolicy(key, keyPolicy)
    );
    const rawKnownKeys = new Set(
      Object.keys(args).filter((key) =>
        argumentKeyMatchesPolicy(key, keyPolicy)
      )
    );
    const coercedKnownKeys = Object.keys(policyArgs).filter((key) =>
      argumentKeyMatchesPolicy(key, keyPolicy)
    );
    const newCoercedKnownKeys = coercedKnownKeys.filter(
      (key) => !rawKnownKeys.has(key)
    );
    if (newCoercedKnownKeys.length < rawUnknownKeys.length) {
      return null;
    }
  }
  if (
    keyPolicy &&
    !argumentValueMatchesSchemaKeyShape(
      policyArgs,
      keyPolicy.schema,
      new Set(),
      true
    )
  ) {
    return null;
  }
  return policyArgs;
}

function coerceArgsForKeyPolicy(
  args: Record<string, unknown>,
  keyPolicy?: ArgumentKeyPolicy
): unknown {
  return keyPolicy ? coerceBySchema(args, keyPolicy.schema) : args;
}

function argumentKeyDeniedByPolicy(
  key: string,
  keyPolicy: ArgumentKeyPolicy
): boolean {
  return (
    PROTOTYPE_SENSITIVE_ARGUMENT_KEYS.has(key) ||
    keyPolicy.deniedKeys.has(key) ||
    keyPolicy.deniedPatterns.some((pattern) => pattern.test(key)) ||
    keyPolicy.unsafeDeniedPatterns.some((pattern) =>
      unsafeDeniedPatternMayMatchKey(pattern, key)
    )
  );
}

function argumentKeyMatchesPolicy(
  key: string,
  keyPolicy: ArgumentKeyPolicy
): boolean {
  return (
    keyPolicy.knownKeys.has(key) ||
    keyPolicy.keyPatterns.some((pattern) => pattern.test(key))
  );
}

const PROTOTYPE_SENSITIVE_ARGUMENT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function containsPrototypeSensitiveArgumentKey(value: unknown): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      for (const item of current) {
        stack.push(item);
      }
      continue;
    }
    if (!isRecord(current)) {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const key of Object.keys(current)) {
      if (PROTOTYPE_SENSITIVE_ARGUMENT_KEYS.has(key)) {
        return true;
      }
      stack.push(current[key]);
    }
  }

  return false;
}

export function hasPrototypeSensitiveKeyInJsonLikeObject(
  text: string
): boolean {
  let firstBrace = skipJsonWhitespace(text, 0);
  while (true) {
    const commentEnd = skipJsonComment(text, firstBrace);
    if (commentEnd === null) {
      break;
    }
    firstBrace = skipJsonWhitespace(text, commentEnd + 1);
  }
  if (text.charAt(firstBrace) !== "{") {
    firstBrace = text.indexOf("{", firstBrace);
  }
  if (firstBrace === -1) {
    return false;
  }
  return (collectObjectKeys(text, firstBrace, true) ?? []).some((key) =>
    PROTOTYPE_SENSITIVE_ARGUMENT_KEYS.has(key)
  );
}

function isUnquotedRjsonKeyStart(char: string): boolean {
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

function parseQuotedObjectKey(
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

function parseUnquotedObjectKey(
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

function previousSignificantChar(text: string, index: number): string {
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
    const lineCommentStart = text.lastIndexOf("//", cursor);
    if (lineCommentStart >= lineStart) {
      cursor = lineCommentStart - 1;
      continue;
    }
    return text.charAt(cursor);
  }
  return "";
}

function skipJsonComment(text: string, index: number): number | null {
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

interface JsonDepthScanState {
  depth: number;
  escaping: boolean;
  inString: boolean;
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

function readStrictJsonPropertyCandidate(
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

function consumeJsonStringScanChar(
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

function consumeJsonDepthOpen(
  state: JsonDepthScanState,
  char: string
): boolean {
  if (!(char === "{" || char === "[")) {
    return false;
  }
  state.depth += 1;
  return true;
}

function consumeJsonDepthClose(
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

function consumeExistingJsonString(
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

function consumeJsonObjectDepth(
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

function collectObjectKeys(
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
function tryParseDoubleEncodedArguments(
  args: string
): Record<string, unknown> | null {
  if (!args.trimStart().startsWith("{")) {
    return null;
  }
  if (hasPrototypeSensitiveKeyInJsonLikeObject(args)) {
    return null;
  }
  try {
    const parsed = parseRJSON(
      normalizeInvalidJsonEscapes(normalizeJsonStringCtrl(args))
    );
    return isRecord(parsed) && !containsPrototypeSensitiveArgumentKey(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function applyNonRecordArgumentPolicy(
  toolName: string,
  args: Exclude<unknown, Record<string, unknown>>,
  tools: LanguageModelV4FunctionTool[],
  keyPolicy: ArgumentKeyPolicy | undefined
): { args: unknown } | null {
  if (args === null) {
    return topLevelNullArgumentMatchesToolSchema(toolName, tools)
      ? { args }
      : null;
  }
  if (
    keyPolicy &&
    argumentValueMatchesSchemaKeyShape(args, keyPolicy.schema, new Set(), true)
  ) {
    return { args };
  }
  if (typeof args === "string") {
    const unwrapped = tryParseDoubleEncodedArguments(args);
    if (unwrapped) {
      const unwrappedPolicyArgs = applyArgumentKeyPolicy(unwrapped, keyPolicy);
      if (unwrappedPolicyArgs !== null) {
        return { args: unwrappedPolicyArgs };
      }
    }
  }
  if (keyPolicy?.rejectNonRecordArguments) {
    return null;
  }
  return { args };
}

export function applyToolArgumentKeyPolicy(
  toolName: string,
  args: unknown,
  tools: LanguageModelV4FunctionTool[]
): { args: unknown } | null {
  const keyPolicy = extractArgumentKeyPolicy(tools, toolName);
  if (keyPolicy?.rejectAll) {
    return null;
  }
  const normalizedArgs = args === undefined ? {} : args;
  if (!isRecord(normalizedArgs)) {
    return applyNonRecordArgumentPolicy(
      toolName,
      normalizedArgs,
      tools,
      keyPolicy
    );
  }
  const policyArgs = applyArgumentKeyPolicy(normalizedArgs, keyPolicy);
  return policyArgs === null ? null : { args: policyArgs };
}

function topLevelNullArgumentMatchesToolSchema(
  toolName: string,
  tools: LanguageModelV4FunctionTool[]
): boolean {
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool || tool.inputSchema === undefined) {
    return false;
  }
  return argumentValueMatchesSchemaKeyShape(
    null,
    tool.inputSchema,
    new Set(),
    true
  );
}

/** Maximum size (in UTF-16 code units) for the arguments body before bailing out of repair. */
const REPAIR_MAX_ARGS_BODY_SIZE = 102_400;

const WHITESPACE_RE = /\s/;
const FIRST_KEY_RE = /^\s*"([^"]+)"\s*:\s*/;
const KV_PATTERN_RE = /,\s*"([^"]+)"\s*:\s*/g;
const TRAILING_COMMA_RE = /,\s*$/;

interface JsonRepairKeyPosition {
  key: string;
  matchStart: number;
  valueStart: number;
}

function getTopLevelPositionMap(argsBody: string): Uint8Array {
  const topLevelAtPosition = new Uint8Array(argsBody.length + 1);
  let depth = 0;
  let inStr = false;
  let esc = false;
  topLevelAtPosition[0] = 1;
  for (let i = 0; i < argsBody.length; i++) {
    const ch = argsBody[i];
    if (esc) {
      esc = false;
    } else if (ch === "\\" && inStr) {
      esc = true;
    } else if (ch === '"') {
      inStr = !inStr;
    } else if (!inStr) {
      if (ch === "{" || ch === "[") {
        depth++;
      }
      if (ch === "}" || ch === "]") {
        depth--;
      }
    }
    topLevelAtPosition[i + 1] = depth === 0 ? 1 : 0;
  }
  return topLevelAtPosition;
}

function hasCommaAfterWhitespace(text: string, fromIndex: number): boolean {
  let cursor = fromIndex;
  while (cursor < text.length && WHITESPACE_RE.test(text[cursor])) {
    cursor += 1;
  }
  return text.charAt(cursor) === ",";
}

function hasTrailingTopLevelFieldAfterArgumentsObject(
  argsBody: string
): boolean {
  const state: JsonDepthScanState = {
    depth: 0,
    escaping: false,
    inString: false,
  };
  for (let index = 0; index < argsBody.length; index += 1) {
    const char = argsBody.charAt(index);
    if (consumeJsonStringScanChar(state, char)) {
      continue;
    }
    if (consumeJsonDepthOpen(state, char)) {
      continue;
    }
    const close = consumeJsonDepthClose(state, char);
    if (close === "none" || close === "nested-close") {
      continue;
    }
    if (hasCommaAfterWhitespace(argsBody, index + 1)) {
      return true;
    }
  }
  return false;
}

function findRepairArgumentsBody(raw: string): string | null {
  const argsValueStart = findStrictTopLevelJsonPropertyValueStart(
    raw,
    "arguments"
  );
  if (argsValueStart == null || raw.charAt(argsValueStart) !== "{") {
    return null;
  }
  const argsStart = argsValueStart + 1;
  let outerClose = -1;
  for (let i = raw.length - 1; i >= argsStart; i--) {
    if (raw.charAt(i) === "}") {
      outerClose = i;
      break;
    }
    if (!WHITESPACE_RE.test(raw.charAt(i))) {
      break;
    }
  }
  if (outerClose === -1) {
    return null;
  }

  let argsClose = -1;
  for (let j = outerClose - 1; j >= argsStart; j--) {
    if (raw.charAt(j) === "}") {
      argsClose = j;
      break;
    }
    if (!WHITESPACE_RE.test(raw.charAt(j))) {
      break;
    }
  }
  return argsClose === -1 ? null : raw.slice(argsStart, argsClose);
}

function parseArgsBodyWithoutRepair(
  argsBody: string,
  keyPolicy?: ArgumentKeyPolicy
): Record<string, unknown> | null {
  try {
    const parsedArgs = JSON.parse(`{${argsBody}}`) as Record<string, unknown>;
    return applyArgumentKeyPolicy(parsedArgs, keyPolicy);
  } catch {
    return null;
  }
}

function collectRepairKeyPositions(
  argsBody: string
): JsonRepairKeyPosition[] | null {
  const firstKeyMatch = argsBody.match(FIRST_KEY_RE);
  if (!firstKeyMatch) {
    return null;
  }
  const positions: JsonRepairKeyPosition[] = [
    {
      key: firstKeyMatch[1],
      matchStart: 0,
      valueStart: firstKeyMatch[0].length,
    },
  ];
  for (const match of argsBody.matchAll(KV_PATTERN_RE)) {
    positions.push({
      key: match[1],
      matchStart: match.index,
      valueStart: match.index + match[0].length,
    });
  }

  const topLevelAtPosition = getTopLevelPositionMap(argsBody);
  return positions.filter(
    (entry) =>
      entry.matchStart === 0 || topLevelAtPosition[entry.matchStart] === 1
  );
}

function uniqueRepairKeyPositions(
  positions: JsonRepairKeyPosition[],
  keepLast: boolean
): JsonRepairKeyPosition[] {
  const selectedByKey = new Map<string, number>();
  for (let index = 0; index < positions.length; index += 1) {
    if (keepLast || !selectedByKey.has(positions[index].key)) {
      selectedByKey.set(positions[index].key, index);
    }
  }
  return positions.filter(
    (_, index) => selectedByKey.get(positions[index].key) === index
  );
}

function sameRepairPositions(
  left: JsonRepairKeyPosition[],
  right: JsonRepairKeyPosition[]
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry.matchStart === right[index].matchStart)
  );
}

function escapeMalformedStringInner(inner: string): string {
  let escaped = "";
  let backslashes = 0;
  for (const char of inner) {
    if (char === "\\") {
      backslashes += 1;
      escaped += char;
    } else if (char === '"' && backslashes % 2 === 0) {
      backslashes = 0;
      escaped += '\\"';
    } else {
      backslashes = 0;
      escaped += char;
    }
  }
  return escaped
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function lastQuoteIndex(value: string): number {
  let cursor = value.length - 1;
  while (cursor > 0 && value.charAt(cursor) !== '"') {
    cursor -= 1;
  }
  return cursor;
}

function parsePossiblyMalformedJsonString(value: string): unknown | undefined {
  if (value.charAt(0) !== '"') {
    return;
  }
  const quoteEnd = lastQuoteIndex(value);
  if (quoteEnd <= 0) {
    return;
  }
  const escaped = escapeMalformedStringInner(value.slice(1, quoteEnd));
  try {
    return JSON.parse(`"${escaped}"`);
  } catch {
    return;
  }
}

function scoreRepairValue(value: string): [number, number] {
  try {
    JSON.parse(value);
    return [1, 0];
  } catch {
    return parsePossiblyMalformedJsonString(value) === undefined
      ? [0, 0]
      : [0, 1];
  }
}

function scoreRepairKeyPositions(
  argsBody: string,
  positions: JsonRepairKeyPosition[]
): [number, number] {
  let rawOk = 0;
  let repaired = 0;
  for (let index = 0; index < positions.length; index += 1) {
    const valueEnd =
      index + 1 < positions.length
        ? positions[index + 1].matchStart
        : argsBody.length;
    const value = argsBody
      .slice(positions[index].valueStart, valueEnd)
      .replace(TRAILING_COMMA_RE, "");
    const [rawScore, repairScore] = scoreRepairValue(value);
    rawOk += rawScore;
    repaired += repairScore;
  }
  return [rawOk, repaired];
}

function chooseRepairKeyPositions(
  argsBody: string,
  positions: JsonRepairKeyPosition[]
): JsonRepairKeyPosition[] {
  const firstPositions = uniqueRepairKeyPositions(positions, false);
  const lastPositions = uniqueRepairKeyPositions(positions, true);
  if (sameRepairPositions(firstPositions, lastPositions)) {
    return firstPositions;
  }
  const firstScore = scoreRepairKeyPositions(argsBody, firstPositions);
  const lastScore = scoreRepairKeyPositions(argsBody, lastPositions);
  return lastScore[0] > firstScore[0] ||
    (lastScore[0] === firstScore[0] && lastScore[1] > firstScore[1])
    ? lastPositions
    : firstPositions;
}

function parseRepairValue(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return parsePossiblyMalformedJsonString(value);
  }
}

function parseRepairArguments(
  argsBody: string,
  positions: JsonRepairKeyPosition[],
  keyPolicy?: ArgumentKeyPolicy
): Record<string, unknown> | null {
  const args = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < positions.length; index += 1) {
    const valueEnd =
      index + 1 < positions.length
        ? positions[index + 1].matchStart
        : argsBody.length;
    const rawValue = argsBody
      .slice(positions[index].valueStart, valueEnd)
      .replace(TRAILING_COMMA_RE, "");
    const parsedValue = parseRepairValue(rawValue);
    if (parsedValue === undefined) {
      return null;
    }
    args[positions[index].key] = parsedValue;
  }
  if (Object.keys(args).length === 0) {
    return null;
  }
  return applyArgumentKeyPolicy(args, keyPolicy);
}

/**
 * Attempt to repair a malformed tool-call JSON string where the model
 * failed to escape double-quotes inside string values.  Returns the
 * parsed result or null when repair is not possible.
 *
 * Scope: this path assumes strict JSON structure (double-quoted keys and
 * string values, per-value `JSON.parse`). Relaxed-JSON malformation
 * (unquoted keys, single-quoted strings, comments) is out of scope — such
 * input returns null and the caller falls through to the text segment path,
 * matching pre-repair behavior.
 */
function repairToolCallJson(
  raw: string,
  toolName: string,
  keyPolicy?: ArgumentKeyPolicy
): { name: string; arguments: Record<string, unknown> } | null {
  if (hasPrototypeSensitiveKeyInJsonLikeObject(raw)) {
    return null;
  }

  const argsBody = findRepairArgumentsBody(raw);
  if (argsBody === null) {
    return null;
  }
  if (argsBody.length > REPAIR_MAX_ARGS_BODY_SIZE) {
    return null;
  }
  if (hasTrailingTopLevelFieldAfterArgumentsObject(argsBody)) {
    return null;
  }

  const parsedArgs = parseArgsBodyWithoutRepair(argsBody, keyPolicy);
  if (parsedArgs) {
    return { name: toolName, arguments: parsedArgs };
  }

  const collectedKeys = collectRepairKeyPositions(argsBody);
  if (!collectedKeys || collectedKeys.length === 0) {
    return null;
  }

  const args = parseRepairArguments(
    argsBody,
    chooseRepairKeyPositions(argsBody, collectedKeys),
    keyPolicy
  );
  return args === null ? null : { name: toolName, arguments: args };
}

function repairToolCallJsonForTools(
  raw: string,
  tools: LanguageModelV4FunctionTool[]
): { name: string; arguments: Record<string, unknown> } | null {
  try {
    const toolName = extractStrictTopLevelStringProperty(raw, "name");
    if (!toolName) {
      return null;
    }
    return repairToolCallJson(
      raw,
      toolName,
      extractArgumentKeyPolicy(tools, toolName)
    );
  } catch {
    // Repair is best-effort: any failure — including a RangeError from a
    // pathologically deep value validated against a recursive/cyclic tool
    // schema — means repair is not possible. Return null so the caller falls
    // through to its onError / original-text fallback instead of letting the
    // error escape parseGeneratedText or the streaming transform. This is the
    // catch-all backstop; the primary guard is MAX_ARGUMENT_SHAPE_DEPTH in
    // hermes-argument-schema.ts.
    return null;
  }
}

const VALID_JSON_ESCAPE_CHARS = new Set([
  "\\",
  "/",
  "b",
  "f",
  "n",
  "r",
  "t",
  "u",
]);

function isValidJsonEscape(
  next: string | undefined,
  quote: '"' | "'"
): boolean {
  if (next === undefined) {
    return true;
  }
  return next === quote || VALID_JSON_ESCAPE_CHARS.has(next);
}

/**
 * Drop the backslash from invalid JSON escape sequences inside string values
 * (e.g. `\$` from a template literal in generated code — observed live on
 * Cohere Command R+). Valid escapes and structural characters are untouched.
 */
export function normalizeInvalidJsonEscapes(json: string): string {
  let quote: '"' | "'" | null = null;
  let parts: string[] | null = null;
  let chunkStart = 0;

  for (let i = 0; i < json.length; i += 1) {
    const ch = json[i];
    if (quote === null) {
      if (ch === '"' || ch === "'") {
        quote = ch;
      }
      continue;
    }
    if (ch === quote) {
      quote = null;
      continue;
    }
    if (ch !== "\\") {
      continue;
    }
    const next = json[i + 1];
    if (!isValidJsonEscape(next, quote)) {
      parts ??= [];
      parts.push(json.slice(chunkStart, i));
      chunkStart = i + 1;
    }
    i += 1;
  }

  if (parts === null) {
    return json;
  }
  parts.push(json.slice(chunkStart));
  return parts.join("");
}

/**
 * Discriminated result of resolving a raw `<tool_call>` JSON body into a final,
 * emittable tool call. Shared by the non-streaming (`parseGeneratedText` ->
 * `processToolCallJson`) and streaming (`createStreamParser` -> `emitToolCall`)
 * paths so both apply identical parse -> validate -> repair semantics. Only the
 * emission of the success / failure result differs between the two paths.
 */
type ResolvedToolCall =
  | { ok: true; toolName: string; input: string }
  | { ok: false; error: unknown };

/**
 * Single source of truth for turning a raw `<tool_call>` JSON body into a
 * canonical `{ toolName, input }` pair (or a failure). Performs, in order:
 *
 *   1. relaxed-JSON parse (with raw control-character normalization)
 *   2. shape validation (must be an object with a string `name`)
 *   3. prototype-pollution guard
 *   4. argument key-policy enforcement
 *   5. final input stringification (schema-aware)
 *
 * On any failure it makes one best-effort repair attempt (e.g. unescaped quotes)
 * and, if that also fails, reports the originating error. The stringification is
 * performed inside the same `try` as parsing so that a stringify failure falls
 * through to the repair path exactly as it did when this logic was inlined in
 * each caller — the two paths must stay byte-for-byte equivalent here.
 */
export function resolveToolCall(
  toolCallJson: string,
  tools: LanguageModelV4FunctionTool[]
): ResolvedToolCall {
  try {
    const parsedToolCall = parseRJSON(
      normalizeInvalidJsonEscapes(normalizeJsonStringCtrl(toolCallJson))
    );
    if (!isParsedToolCallRecord(parsedToolCall)) {
      throw new Error("Tool call object is missing own name or arguments");
    }
    if (hasPrototypeSensitiveKeyInJsonLikeObject(toolCallJson)) {
      throw new Error("Tool call arguments contain prototype-sensitive keys");
    }
    const policyArguments = applyToolArgumentKeyPolicy(
      parsedToolCall.name,
      parsedToolCall.arguments,
      tools
    );
    if (policyArguments === null) {
      throw new Error("Tool call arguments contain schema-unknown keys");
    }
    return {
      ok: true,
      toolName: parsedToolCall.name,
      input: stringifyParsedToolInput(
        parsedToolCall.name,
        policyArguments.args,
        tools
      ),
    };
  } catch (error) {
    // Attempt repair for unescaped quotes (best-effort).
    const repaired = repairToolCallJsonForTools(toolCallJson, tools);
    if (repaired) {
      try {
        return {
          ok: true,
          toolName: repaired.name,
          input: stringifyParsedToolInput(
            repaired.name,
            repaired.arguments,
            tools
          ),
        };
      } catch (repairError) {
        return { ok: false, error: repairError };
      }
    }
    return { ok: false, error };
  }
}

/** Whitespace and complete tag-like tokens only (e.g. a stray `</think>`). */
const MARKUP_ONLY_TEXT_REGEX = /^\s*(?:<[^<>\n]*>\s*)*$/;

/**
 * Run the shared JSON-candidate recovery over `text` and return every
 * recovered call for known tools, in `ResolvedToolCall` success shape.
 *
 * The salvage is deliberately narrow so it cannot override the primary
 * parser's intentional fallbacks:
 *   - the body must consist solely of tool payloads plus markup remnants
 *     (whitespace or complete tag-like tokens such as a mismatched
 *     `</think>` close tag or `<tool_call>` separators). Bodies whose parse
 *     failed mid-object (e.g. unescaped quotes, trailing top-level fields)
 *     keep falling back to text.
 *   - prototype-sensitive keys are re-checked on the raw text, and recovered
 *     arguments go through the same argument key policy as the primary path.
 */
export function recoverKnownToolCallsFromText(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): Extract<ResolvedToolCall, { ok: true }>[] | null {
  if (hasPrototypeSensitiveKeyInJsonLikeObject(text)) {
    return null;
  }

  const recoveredParts = recoverToolCallFromJsonCandidates(text, tools);
  if (!recoveredParts) {
    return null;
  }

  const calls: Extract<ResolvedToolCall, { ok: true }>[] = [];
  for (const part of recoveredParts) {
    if (part.type === "text") {
      if (!MARKUP_ONLY_TEXT_REGEX.test(part.text)) {
        return null;
      }
      continue;
    }
    if (part.type !== "tool-call") {
      return null;
    }

    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(part.input);
    } catch {
      return null;
    }
    const policyArguments = applyToolArgumentKeyPolicy(
      part.toolName,
      parsedArgs,
      tools
    );
    if (policyArguments === null) {
      return null;
    }

    try {
      calls.push({
        ok: true,
        toolName: part.toolName,
        input: stringifyParsedToolInput(
          part.toolName,
          policyArguments.args,
          tools
        ),
      });
    } catch {
      return null;
    }
  }

  return calls.length > 0 ? calls : null;
}

export function processToolCallJson(
  toolCallJson: string,
  fullMatch: string,
  processedElements: LanguageModelV4Content[],
  tools: LanguageModelV4FunctionTool[],
  options?: ParserOptions
) {
  const resolved = resolveToolCall(toolCallJson, tools);
  if (resolved.ok) {
    processedElements.push({
      type: "tool-call",
      toolCallId: generateToolCallId(),
      toolName: resolved.toolName,
      input: resolved.input,
    });
    return;
  }

  const salvagedCalls = recoverKnownToolCallsFromText(toolCallJson, tools);
  if (salvagedCalls && salvagedCalls.length > 0) {
    for (const salvagedCall of salvagedCalls) {
      processedElements.push({
        type: "tool-call",
        toolCallId: generateToolCallId(),
        toolName: salvagedCall.toolName,
        input: salvagedCall.input,
      });
    }
    return;
  }

  const salvagedToolName =
    extractStreamingToolCallProgress(toolCallJson).toolName;
  const salvagedToolCallId = generateToolCallId();
  logParseFailure({
    phase: "generated-text",
    reason: "Failed to parse tool call JSON segment",
    snippet: fullMatch,
    error: resolved.error,
  });
  options?.onError?.(
    "Could not process JSON tool call, keeping original text.",
    {
      toolCall: fullMatch,
      error: resolved.error,
      toolName: salvagedToolName,
      toolCallId: salvagedToolCallId,
      dropReason: "malformed-tool-call-body",
    }
  );
  processedElements.push({ type: "text", text: fullMatch });
}

export interface StreamState {
  activeToolInput: {
    id: string;
    toolName: string;
    emittedInput: string;
  } | null;
  buffer: string;
  currentTextId: string | null;
  currentToolCallJson: string;
  hasEmittedTextStart: boolean;
  isInsideToolCall: boolean;
  pendingToolInputProgressVersion: number;
}

export type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;

export interface TagProcessingContext {
  controller: StreamController;
  options?: ParserOptions;
  state: StreamState;
  toolCallEnd: string;
  toolCallStart: string;
  tools: LanguageModelV4FunctionTool[];
}

const WHITESPACE_JSON_REGEX = /\s/;

function skipJsonWhitespace(text: string, fromIndex: number): number {
  let index = fromIndex;
  while (index < text.length && WHITESPACE_JSON_REGEX.test(text[index])) {
    index += 1;
  }
  return index;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Streaming JSON key/value scanning requires explicit string-depth state tracking.
function findTopLevelPropertyValueStart(
  text: string,
  property: string
): number | null {
  const objectStart = skipJsonWhitespace(text, 0);
  if (objectStart >= text.length || text.charAt(objectStart) !== "{") {
    return null;
  }

  let depth = 0;
  let quoteChar: string | null = null;
  let escaping = false;

  for (let index = objectStart; index < text.length; index += 1) {
    const char = text.charAt(index);

    if (quoteChar) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === quoteChar) {
        quoteChar = null;
      }
      continue;
    }

    const commentEnd = skipJsonComment(text, index);
    if (commentEnd !== null) {
      index = commentEnd;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth !== 1) {
      if (char === '"' || char === "'") {
        quoteChar = char;
      }
      continue;
    }

    let parsedKey: { key: string; end: number } | null = null;
    if (char === '"' || char === "'") {
      parsedKey = parseQuotedObjectKey(text, index);
    } else {
      if (!isUnquotedRjsonKeyStart(char)) {
        continue;
      }
      const previous = previousSignificantChar(text, index);
      if (previous !== "{" && previous !== ",") {
        continue;
      }
      parsedKey = parseUnquotedObjectKey(text, index);
    }

    if (!parsedKey) {
      return null;
    }

    let valueCursor = skipJsonWhitespace(text, parsedKey.end + 1);
    if (valueCursor >= text.length || text.charAt(valueCursor) !== ":") {
      index = parsedKey.end;
      continue;
    }

    valueCursor = skipJsonWhitespace(text, valueCursor + 1);
    if (parsedKey.key === property) {
      return valueCursor < text.length ? valueCursor : null;
    }

    index = valueCursor - 1;
  }

  return null;
}

function findStrictTopLevelJsonPropertyValueStart(
  text: string,
  property: string
): number | null {
  const objectStart = skipJsonWhitespace(text, 0);
  if (objectStart >= text.length || text.charAt(objectStart) !== "{") {
    return null;
  }

  const state: JsonDepthScanState = {
    depth: 0,
    escaping: false,
    inString: false,
  };

  for (let index = objectStart; index < text.length; index += 1) {
    const char = text.charAt(index);

    if (consumeExistingJsonString(state, char)) {
      continue;
    }
    if (consumeJsonObjectDepth(state, char)) {
      continue;
    }
    if (char !== '"') {
      continue;
    }
    if (state.depth !== 1) {
      state.inString = true;
      continue;
    }

    const candidate = readStrictJsonPropertyCandidate(text, index);
    if (candidate === null) {
      return null;
    }
    if (candidate.key === property) {
      return candidate.valueStart !== undefined &&
        candidate.valueStart < text.length
        ? candidate.valueStart
        : null;
    }
    index = candidate.nextIndex;
  }

  return null;
}

function extractTopLevelStringProperty(
  text: string,
  property: string
): string | undefined {
  const valueStart = findTopLevelPropertyValueStart(text, property);
  if (valueStart == null || valueStart >= text.length) {
    return;
  }
  if (text.charAt(valueStart) !== '"') {
    return;
  }

  let valueEnd = valueStart + 1;
  let escaped = false;
  while (valueEnd < text.length) {
    const char = text.charAt(valueEnd);
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      return text.slice(valueStart + 1, valueEnd);
    }
    valueEnd += 1;
  }

  return;
}

function extractStrictTopLevelStringProperty(
  text: string,
  property: string
): string | undefined {
  const valueStart = findStrictTopLevelJsonPropertyValueStart(text, property);
  if (valueStart == null || valueStart >= text.length) {
    return;
  }
  if (text.charAt(valueStart) !== '"') {
    return;
  }

  let valueEnd = valueStart + 1;
  let escaped = false;
  while (valueEnd < text.length) {
    const char = text.charAt(valueEnd);
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      return text.slice(valueStart + 1, valueEnd);
    }
    valueEnd += 1;
  }

  return;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Streaming JSON value slicing must handle nested arrays/objects and escaped strings.
function extractJsonValueSlice(
  text: string,
  valueStart: number
): {
  text: string;
  complete: boolean;
} | null {
  if (valueStart >= text.length) {
    return null;
  }

  const first = text.charAt(valueStart);
  if (first === "{" || first === "[") {
    const stack: string[] = [first];
    let inString = false;
    let escaped = false;

    for (let index = valueStart + 1; index < text.length; index += 1) {
      const char = text.charAt(index);
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        stack.push(char);
        continue;
      }

      if (char === "}" || char === "]") {
        const open = stack.at(-1);
        if ((open === "{" && char === "}") || (open === "[" && char === "]")) {
          stack.pop();
          if (stack.length === 0) {
            return {
              text: text.slice(valueStart, index + 1),
              complete: true,
            };
          }
        }
      }
    }

    return {
      text: text.slice(valueStart),
      complete: false,
    };
  }

  if (first === '"') {
    let escaped = false;
    for (let index = valueStart + 1; index < text.length; index += 1) {
      const char = text.charAt(index);
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        return {
          text: text.slice(valueStart, index + 1),
          complete: true,
        };
      }
    }
    return {
      text: text.slice(valueStart),
      complete: false,
    };
  }

  let index = valueStart;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "," || char === "}" || WHITESPACE_JSON_REGEX.test(char)) {
      break;
    }
    index += 1;
  }

  return {
    text: text.slice(valueStart, index),
    complete: index < text.length,
  };
}

export function extractStreamingToolCallProgress(toolCallJson: string): {
  toolName: string | undefined;
  argumentsText: string | undefined;
  argumentsComplete: boolean;
} {
  const toolName = extractTopLevelStringProperty(toolCallJson, "name");
  const argsValueStart = findTopLevelPropertyValueStart(
    toolCallJson,
    "arguments"
  );
  if (argsValueStart == null) {
    return {
      toolName,
      argumentsText: undefined,
      argumentsComplete: false,
    };
  }

  const argsSlice = extractJsonValueSlice(toolCallJson, argsValueStart);
  return {
    toolName,
    argumentsText: argsSlice?.text,
    argumentsComplete: argsSlice?.complete ?? false,
  };
}

export function ensureToolInputStart(
  state: StreamState,
  controller: StreamController,
  toolName: string
) {
  if (!state.activeToolInput) {
    const id = generateToolCallId();
    state.activeToolInput = {
      id,
      toolName,
      emittedInput: "",
    };
    controller.enqueue({
      type: "tool-input-start",
      id,
      toolName,
    } as LanguageModelV4StreamPart);
  }
}

export function emitToolInputDelta(
  state: StreamState,
  controller: StreamController,
  fullInput: string
) {
  const active = state.activeToolInput;
  if (!active) {
    return;
  }

  emitToolInputProgressDelta({
    controller,
    id: active.id,
    state: active,
    fullInput,
    mode: "full-json",
  });
}
