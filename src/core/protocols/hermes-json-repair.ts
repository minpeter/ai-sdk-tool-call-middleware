import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import {
  type ArgumentKeyPolicy,
  applyArgumentKeyPolicy,
  extractArgumentKeyPolicy,
  hasPrototypeSensitiveKeyInJsonLikeObject,
} from "./hermes-argument-key-policy";
import { argumentValueMatchesSchemaKeyShape } from "./hermes-argument-schema";
import {
  consumeJsonDepthClose,
  consumeJsonDepthOpen,
  consumeJsonStringScanChar,
  exceedsToolCallJsonNestingDepth,
  type JsonDepthScanState,
  skipJsonWhitespace,
} from "./hermes-json-object-key-scanner";
import {
  extractStrictTopLevelStringProperty,
  findStrictTopLevelJsonPropertyValueStart,
} from "./hermes-streaming-progress";

export function topLevelNullArgumentMatchesToolSchema(
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
  for (let i = 0; i < argsBody.length; i += 1) {
    const ch = argsBody[i];
    if (esc) {
      esc = false;
    } else if (ch === "\\" && inStr) {
      esc = true;
    } else if (ch === '"') {
      inStr = !inStr;
    } else if (!inStr) {
      if (ch === "{" || ch === "[") {
        depth += 1;
      }
      if (ch === "}" || ch === "]") {
        depth -= 1;
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

function findLikelyRepairArgumentsClose(
  raw: string,
  argsStart: number
): number {
  const state: JsonDepthScanState = {
    depth: 1,
    escaping: false,
    inString: false,
  };
  for (let index = argsStart; index < raw.length; index += 1) {
    const char = raw.charAt(index);
    if (consumeJsonStringScanChar(state, char)) {
      continue;
    }
    if (consumeJsonDepthOpen(state, char)) {
      continue;
    }
    const close = consumeJsonDepthClose(state, char);
    if (close === "none" || state.depth > 0) {
      continue;
    }
    const afterClose = skipJsonWhitespace(raw, index + 1);
    const next = raw.charAt(afterClose);
    if (next === "" || next === "," || next === "}") {
      return index;
    }
    state.depth = 1;
  }
  return -1;
}

function hasStrictTopLevelFieldAfterArgumentsClose(
  raw: string,
  argsClose: number
): boolean {
  let cursor = skipJsonWhitespace(raw, argsClose + 1);
  if (raw.charAt(cursor) !== ",") {
    return false;
  }
  cursor = skipJsonWhitespace(raw, cursor + 1);
  return raw.charAt(cursor) === '"';
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
  const likelyArgsClose = findLikelyRepairArgumentsClose(raw, argsStart);
  if (
    likelyArgsClose !== -1 &&
    hasStrictTopLevelFieldAfterArgumentsClose(raw, likelyArgsClose)
  ) {
    return null;
  }
  let outerClose = -1;
  for (let i = raw.length - 1; i >= argsStart; i -= 1) {
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
  for (let j = outerClose - 1; j >= argsStart; j -= 1) {
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
    // swallow parse failures and return undefined
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
  if (exceedsToolCallJsonNestingDepth(raw)) {
    return null;
  }
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

export function repairToolCallJsonForTools(
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
