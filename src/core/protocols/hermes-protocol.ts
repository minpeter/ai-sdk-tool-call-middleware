import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
} from "@ai-sdk/provider";
import { parse as parseRJSON } from "../../rjson";
import { unwrapJsonSchema } from "../../schema-coerce";
import { logParseFailure } from "../utils/debug";
import { getPotentialStartIndex } from "../utils/get-potential-start-index";
import { generateId, generateToolCallId } from "../utils/id";
import {
  addTextSegment,
  formatToolsWithPromptTemplate,
} from "../utils/protocol-utils";
import {
  emitToolInputProgressDelta,
  shouldEmitRawToolCallTextOnError,
  stringifyToolInputWithSchema,
} from "../utils/tool-input-streaming";
import type { ParserOptions, TCMProtocol } from "./protocol-interface";

interface HermesProtocolOptions {
  toolCallEnd?: string;
  toolCallStart?: string;
}

const RJSON_IDENTIFIER_CHAR_REGEX = /[$a-zA-Z0-9_\-+.*?!|&%^/#\\]/;
const RJSON_NUMBER_TOKEN_REGEX = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function validateNonEmptyDelimiters(
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
function findToolCallBoundaryOutsideRjsonSyntax(
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
function findNextToolCallSpan(
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

function canonicalizeToolInput(argumentsValue: unknown): string {
  return JSON.stringify(argumentsValue ?? {});
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
function normalizeJsonStringCtrl(json: string): string {
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
  keyPatterns: RegExp[];
  knownKeys: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractArgumentKeyPolicy(
  tools: LanguageModelV3FunctionTool[],
  toolName: string
): ArgumentKeyPolicy | undefined {
  const tool = tools.find((t) => t.name === toolName);
  const schema = unwrapJsonSchema(tool?.inputSchema);
  if (!isRecord(schema)) {
    return undefined;
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const patternProperties = isRecord(schema.patternProperties)
    ? schema.patternProperties
    : {};
  const keyPatterns: RegExp[] = [];
  for (const pattern of Object.keys(patternProperties)) {
    try {
      keyPatterns.push(new RegExp(pattern));
    } catch {
    }
  }
  return {
    allowUnknownKeys: schema.additionalProperties !== false,
    keyPatterns,
    knownKeys: new Set(Object.keys(properties)),
  };
}

function applyArgumentKeyPolicy(
  args: Record<string, unknown>,
  keyPolicy?: ArgumentKeyPolicy
): Record<string, unknown> | null {
  if (keyPolicy && !keyPolicy.allowUnknownKeys) {
    for (const key of Object.keys(args)) {
      if (
        !keyPolicy.knownKeys.has(key) &&
        !keyPolicy.keyPatterns.some((pattern) => pattern.test(key))
      ) {
        return null;
      }
    }
  }
  return args;
}

/** Maximum size (in UTF-16 code units) for the arguments body before bailing out of repair. */
const REPAIR_MAX_ARGS_BODY_SIZE = 102_400;

const WHITESPACE_RE = /\s/;
const FIRST_KEY_RE = /^\s*"([^"]+)"\s*:\s*/;
const KV_PATTERN_RE = /,\s*"([^"]+)"\s*:\s*/g;
const TRAILING_COMMA_RE = /,\s*$/;

function getTopLevelPositionMap(argsBody: string): boolean[] {
  const topLevelAtPosition = Array<boolean>(argsBody.length + 1);
  let depth = 0;
  let inStr = false;
  let esc = false;
  topLevelAtPosition[0] = true;
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
    topLevelAtPosition[i + 1] = depth === 0;
  }
  return topLevelAtPosition;
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
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: JSON repair requires manual character-level scanning with multiple heuristic passes.
function repairToolCallJson(
  raw: string,
  toolName: string,
  keyPolicy?: ArgumentKeyPolicy
): { name: string; arguments: Record<string, unknown> } | null {
  // 2. Find arguments object boundaries (top-level aware, like name extraction)
  const argsValueStart = findTopLevelPropertyValueStart(raw, "arguments");
  if (argsValueStart == null || raw.charAt(argsValueStart) !== "{") {
    return null;
  }
  const argsStart = argsValueStart + 1;

  // 3. Find closing braces from end (arguments + outer object).
  //    Uses backwards scan because forward brace-balance is unreliable
  //    when quotes are broken (which is the premise of this repair path).
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
  if (argsClose === -1) {
    return null;
  }

  const argsBody = raw.slice(argsStart, argsClose);

  // Size guard: bail out on unreasonably large argument bodies
  if (argsBody.length > REPAIR_MAX_ARGS_BODY_SIZE) {
    return null;
  }

  // 4. Try standard parse first
  try {
    const parsedArgs = JSON.parse(`{${argsBody}}`) as Record<string, unknown>;
    const policyArgs = applyArgumentKeyPolicy(parsedArgs, keyPolicy);
    if (!policyArgs) {
      return null;
    }
    return {
      name: toolName,
      arguments: policyArgs,
    };
  } catch {
    /* fall through to repair */
  }

  // 5. Collect key positions
  const firstKeyMatch = argsBody.match(FIRST_KEY_RE);
  if (!firstKeyMatch) {
    return null;
  }
  let allKeys: Array<{
    key: string;
    matchStart: number;
    valueStart: number;
  }> = [
    {
      key: firstKeyMatch[1],
      matchStart: 0,
      valueStart: firstKeyMatch[0].length,
    },
  ];
  for (const m of argsBody.matchAll(KV_PATTERN_RE)) {
    allKeys.push({
      key: m[1],
      matchStart: m.index,
      valueStart: m.index + m[0].length,
    });
  }

  // 5b. Filter candidates to prevent false boundary splits.
  //     Boundary detection always uses top-level position — dropping
  //     schema-unknown keys from the candidate list corrupts neighbouring
  //     value slices, because their ,"extra":... text gets merged into
  //     the previous value. Schema filtering is applied later when
  //     assigning parsed values into args (step 8 below).
  const topLevelAtPosition = getTopLevelPositionMap(argsBody);
  allKeys = allKeys.filter(
    (entry) =>
      entry.matchStart === 0 || topLevelAtPosition[entry.matchStart]
  );

  // 7. Handle duplicate key names with scoring heuristic
  const firstByKey: Record<string, number> = {};
  const lastByKey: Record<string, number> = {};
  for (let idx = 0; idx < allKeys.length; idx++) {
    if (!(allKeys[idx].key in firstByKey)) {
      firstByKey[allKeys[idx].key] = idx;
    }
    lastByKey[allKeys[idx].key] = idx;
  }
  const firstPositions = allKeys.filter(
    (_, i) => firstByKey[allKeys[i].key] === i
  );
  const lastPositions = allKeys.filter(
    (_, i) => lastByKey[allKeys[i].key] === i
  );

  let keyPositions: typeof allKeys;
  if (
    firstPositions.length === lastPositions.length &&
    firstPositions.every(
      (fp, i) => fp.matchStart === lastPositions[i].matchStart
    )
  ) {
    keyPositions = firstPositions;
  } else {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Scoring heuristic requires multi-stage fallback parsing.
    function scorePositions(positions: typeof allKeys): [number, number] {
      let rawOk = 0;
      let repaired = 0;
      for (let si = 0; si < positions.length; si++) {
        const svs = positions[si].valueStart;
        const sve =
          si + 1 < positions.length
            ? positions[si + 1].matchStart
            : argsBody.length;
        const srv = argsBody.slice(svs, sve).replace(TRAILING_COMMA_RE, "");
        try {
          JSON.parse(srv);
          rawOk++;
          continue;
        } catch {
          /* skip */
        }
        if (srv.charAt(0) === '"') {
          let seq = srv.length - 1;
          while (seq > 0 && srv.charAt(seq) !== '"') {
            seq--;
          }
          if (seq > 0) {
            const sinner = srv.slice(1, seq);
            let sesc = "";
            let sbs = 0;
            for (const sch of sinner) {
              if (sch === "\\") {
                sbs++;
                sesc += sch;
              } else if (sch === '"' && sbs % 2 === 0) {
                sbs = 0;
                sesc += '\\"';
              } else {
                sbs = 0;
                sesc += sch;
              }
            }
            sesc = sesc
              .replace(/\n/g, "\\n")
              .replace(/\r/g, "\\r")
              .replace(/\t/g, "\\t");
            try {
              JSON.parse(`"${sesc}"`);
              repaired++;
            } catch {
              /* skip */
            }
          }
        }
      }
      return [rawOk, repaired];
    }
    const fs = scorePositions(firstPositions);
    const ls = scorePositions(lastPositions);
    keyPositions =
      ls[0] > fs[0] || (ls[0] === fs[0] && ls[1] > fs[1])
        ? lastPositions
        : firstPositions;
  }
  allKeys = keyPositions;
  if (allKeys.length === 0) {
    return null;
  }

  const args = Object.create(null) as Record<string, unknown>;
  for (let i = 0; i < allKeys.length; i++) {
    const kp = allKeys[i];
    const rejectsUnknownArgument =
      keyPolicy &&
      !keyPolicy.allowUnknownKeys &&
      !keyPolicy.knownKeys.has(kp.key) &&
      !keyPolicy.keyPatterns.some((pattern) => pattern.test(kp.key));
    if (rejectsUnknownArgument) {
      return null;
    }
    const vs = kp.valueStart;
    const ve =
      i + 1 < allKeys.length ? allKeys[i + 1].matchStart : argsBody.length;
    const rv = argsBody.slice(vs, ve).replace(TRAILING_COMMA_RE, "");
    try {
      args[kp.key] = JSON.parse(rv);
      continue;
    } catch {
      /* needs repair */
    }
    if (rv.charAt(0) === '"') {
      let eq = rv.length - 1;
      while (eq > 0 && rv.charAt(eq) !== '"') {
        eq--;
      }
      if (eq <= 0) {
        // String literal with no closing quote — repair cannot handle this
        return null;
      }
      const inner = rv.slice(1, eq);
      let esc = "";
      let bs = 0;
      for (const ch of inner) {
        if (ch === "\\") {
          bs++;
          esc += ch;
        } else if (ch === '"' && bs % 2 === 0) {
          bs = 0;
          esc += '\\"';
        } else {
          bs = 0;
          esc += ch;
        }
      }
      esc = esc
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");
      try {
        args[kp.key] = JSON.parse(`"${esc}"`);
      } catch {
        // Repaired string still invalid — bail out
        return null;
      }
    } else {
      // Non-string value that failed JSON.parse — repair cannot handle this
      return null;
    }
  }
  if (Object.keys(args).length === 0) {
    return null;
  }
  return { name: toolName, arguments: args };
}

function repairToolCallJsonForTools(
  raw: string,
  tools: LanguageModelV3FunctionTool[]
): { name: string; arguments: Record<string, unknown> } | null {
  const toolName = extractTopLevelStringProperty(raw, "name");
  if (!toolName) {
    return null;
  }
  return repairToolCallJson(
    raw,
    toolName,
    extractArgumentKeyPolicy(tools, toolName)
  );
}

function processToolCallJson(
  toolCallJson: string,
  fullMatch: string,
  processedElements: LanguageModelV3Content[],
  tools: LanguageModelV3FunctionTool[],
  options?: ParserOptions
) {
  try {
    const parsedToolCall = parseRJSON(
      normalizeJsonStringCtrl(toolCallJson)
    ) as {
      name: string;
      arguments: unknown;
    };
    processedElements.push({
      type: "tool-call",
      toolCallId: generateToolCallId(),
      toolName: parsedToolCall.name,
      input: canonicalizeToolInput(parsedToolCall.arguments),
    });
  } catch (error) {
    // Attempt repair for unescaped quotes
    const repaired = repairToolCallJsonForTools(toolCallJson, tools);
    if (repaired) {
      processedElements.push({
        type: "tool-call",
        toolCallId: generateToolCallId(),
        toolName: repaired.name,
        input: canonicalizeToolInput(repaired.arguments),
      });
      return;
    }
    const salvagedToolName =
      extractStreamingToolCallProgress(toolCallJson).toolName;
    const salvagedToolCallId = generateToolCallId();
    logParseFailure({
      phase: "generated-text",
      reason: "Failed to parse tool call JSON segment",
      snippet: fullMatch,
      error,
    });
    options?.onError?.(
      "Could not process JSON tool call, keeping original text.",
      {
        toolCall: fullMatch,
        error,
        toolName: salvagedToolName,
        toolCallId: salvagedToolCallId,
        dropReason: "malformed-tool-call-body",
      }
    );
    processedElements.push({ type: "text", text: fullMatch });
  }
}

interface StreamState {
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
}

type StreamController =
  TransformStreamDefaultController<LanguageModelV3StreamPart>;

interface TagProcessingContext {
  controller: StreamController;
  options?: ParserOptions;
  state: StreamState;
  toolCallEnd: string;
  toolCallStart: string;
  tools: LanguageModelV3FunctionTool[];
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
  let inString = false;
  let escaping = false;

  for (let index = objectStart; index < text.length; index += 1) {
    const char = text.charAt(index);

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
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

    if (char !== '"') {
      continue;
    }

    if (depth !== 1) {
      inString = true;
      continue;
    }

    const keyStart = index + 1;
    let keyEnd = keyStart;
    let keyEscaped = false;
    while (keyEnd < text.length) {
      const keyChar = text.charAt(keyEnd);
      if (keyEscaped) {
        keyEscaped = false;
      } else if (keyChar === "\\") {
        keyEscaped = true;
      } else if (keyChar === '"') {
        break;
      }
      keyEnd += 1;
    }

    if (keyEnd >= text.length || text.charAt(keyEnd) !== '"') {
      return null;
    }

    const key = text.slice(keyStart, keyEnd);
    let valueCursor = skipJsonWhitespace(text, keyEnd + 1);
    if (valueCursor >= text.length || text.charAt(valueCursor) !== ":") {
      index = keyEnd;
      continue;
    }

    valueCursor = skipJsonWhitespace(text, valueCursor + 1);
    if (key === property) {
      return valueCursor < text.length ? valueCursor : null;
    }

    index = valueCursor - 1;
  }

  return null;
}

function extractTopLevelStringProperty(
  text: string,
  property: string
): string | undefined {
  const valueStart = findTopLevelPropertyValueStart(text, property);
  if (valueStart == null || valueStart >= text.length) {
    return undefined;
  }
  if (text.charAt(valueStart) !== '"') {
    return undefined;
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

  return undefined;
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

function extractStreamingToolCallProgress(toolCallJson: string): {
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

function ensureToolInputStart(
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
    } as LanguageModelV3StreamPart);
  }
}

function emitToolInputDelta(
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

function closeToolInput(state: StreamState, controller: StreamController) {
  if (!state.activeToolInput) {
    return;
  }
  controller.enqueue({
    type: "tool-input-end",
    id: state.activeToolInput.id,
  } as LanguageModelV3StreamPart);
  state.activeToolInput = null;
}

function emitToolCallFromParsed(
  state: StreamState,
  controller: StreamController,
  parsedToolCall: { name: string; arguments: unknown },
  tools: LanguageModelV3FunctionTool[]
) {
  closeTextBlock(state, controller);
  const toolName =
    typeof parsedToolCall.name === "string"
      ? parsedToolCall.name
      : (state.activeToolInput?.toolName ?? "unknown");
  const input = stringifyToolInputWithSchema({
    toolName,
    args: parsedToolCall.arguments,
    tools,
    fallback: canonicalizeToolInput,
  });
  ensureToolInputStart(state, controller, toolName);
  emitToolInputDelta(state, controller, input);
  const toolCallId = state.activeToolInput?.id ?? generateToolCallId();
  closeToolInput(state, controller);
  controller.enqueue({
    type: "tool-call",
    toolCallId,
    toolName,
    input,
  } as LanguageModelV3StreamPart);
}

function canonicalizeArgumentsProgressInput(
  progress: {
    argumentsText: string | undefined;
    argumentsComplete: boolean;
  },
  toolName: string,
  tools: LanguageModelV3FunctionTool[]
): string | undefined {
  if (progress.argumentsText === undefined || !progress.argumentsComplete) {
    return undefined;
  }

  try {
    const parsedArguments = parseRJSON(
      normalizeJsonStringCtrl(progress.argumentsText)
    );
    return stringifyToolInputWithSchema({
      toolName,
      args: parsedArguments,
      tools,
      fallback: canonicalizeToolInput,
    });
  } catch {
    return undefined;
  }
}

function emitToolInputProgress(
  state: StreamState,
  controller: StreamController,
  tools: LanguageModelV3FunctionTool[]
) {
  if (!(state.isInsideToolCall && state.currentToolCallJson)) {
    return;
  }

  const progress = extractStreamingToolCallProgress(state.currentToolCallJson);
  if (!progress.toolName) {
    return;
  }

  ensureToolInputStart(state, controller, progress.toolName);
  const canonicalProgressInput = canonicalizeArgumentsProgressInput(
    progress,
    progress.toolName,
    tools
  );
  if (canonicalProgressInput !== undefined) {
    emitToolInputDelta(state, controller, canonicalProgressInput);
  }
}

function flushBuffer(
  state: StreamState,
  controller: StreamController,
  toolCallStart: string
) {
  if (state.buffer.length === 0) {
    return;
  }

  if (!state.currentTextId) {
    state.currentTextId = generateId();
    controller.enqueue({
      type: "text-start",
      id: state.currentTextId,
    } as LanguageModelV3StreamPart);
    state.hasEmittedTextStart = true;
  }

  const deltaContent = state.isInsideToolCall
    ? `${toolCallStart}${state.buffer}`
    : state.buffer;

  controller.enqueue({
    type: "text-delta",
    id: state.currentTextId,
    delta: deltaContent,
  } as LanguageModelV3StreamPart);
  state.buffer = "";
}

function closeTextBlock(state: StreamState, controller: StreamController) {
  if (state.currentTextId && state.hasEmittedTextStart) {
    controller.enqueue({
      type: "text-end",
      id: state.currentTextId,
    } as LanguageModelV3StreamPart);
    state.currentTextId = null;
    state.hasEmittedTextStart = false;
  }
}

function emitIncompleteToolCall(
  state: StreamState,
  controller: StreamController,
  toolCallStart: string,
  trailingBuffer: string,
  tools: LanguageModelV3FunctionTool[],
  options?: ParserOptions
) {
  if (!state.currentToolCallJson && trailingBuffer.length === 0) {
    state.isInsideToolCall = false;
    return;
  }

  if (state.currentToolCallJson) {
    try {
      const parsedToolCall = parseRJSON(
        normalizeJsonStringCtrl(state.currentToolCallJson)
      ) as {
        name: string;
        arguments: unknown;
      };
      emitToolCallFromParsed(state, controller, parsedToolCall, tools);
      state.currentToolCallJson = "";
      state.isInsideToolCall = false;
      return;
    } catch {
      // Incomplete tool calls (no closing </tool_call>) are not candidates
      // for repair — the JSON may be genuinely truncated.
      // Fall through to text/error fallback.
    }
  }

  const rawToolCallContent = `${state.currentToolCallJson}${trailingBuffer}`;
  const errorContent = `${toolCallStart}${rawToolCallContent}`;
  const shouldEmitRawFallback = shouldEmitRawToolCallTextOnError(options);

  logParseFailure({
    phase: "stream",
    reason: shouldEmitRawFallback
      ? "Incomplete streaming tool call segment emitted as text"
      : "Incomplete streaming tool call segment suppressed without raw text fallback",
    snippet: errorContent,
  });

  if (shouldEmitRawFallback) {
    const errorId = generateId();
    controller.enqueue({
      type: "text-start",
      id: errorId,
    } as LanguageModelV3StreamPart);
    controller.enqueue({
      type: "text-delta",
      id: errorId,
      delta: errorContent,
    } as LanguageModelV3StreamPart);
    controller.enqueue({
      type: "text-end",
      id: errorId,
    } as LanguageModelV3StreamPart);
  }
  // Capture structured tool-call context before closeToolInput clears
  // state.activeToolInput. If streaming already identified the name/id we use
  // them directly; otherwise fall back to re-scanning the raw JSON for the name
  // and generating a fresh correlation id so consumers always receive the
  // uniform { toolCall, toolCallId, toolName, dropReason } recovery shape.
  const streamingToolCallId =
    state.activeToolInput?.id ?? generateToolCallId();
  const streamingToolName = state.activeToolInput?.toolName;
  closeToolInput(state, controller);
  const toolName =
    streamingToolName ??
    (state.currentToolCallJson
      ? extractStreamingToolCallProgress(state.currentToolCallJson).toolName
      : undefined);
  options?.onError?.(
    shouldEmitRawFallback
      ? "Could not complete streaming JSON tool call at finish; emitting original text."
      : "Could not complete streaming JSON tool call at finish.",
    {
      toolCall: errorContent,
      toolCallId: streamingToolCallId,
      toolName,
      dropReason: "unfinished-tool-call",
    }
  );
  state.currentToolCallJson = "";
  state.isInsideToolCall = false;
}

function handleFinishChunk(
  state: StreamState,
  controller: StreamController,
  toolCallStart: string,
  tools: LanguageModelV3FunctionTool[],
  options: ParserOptions | undefined,
  chunk: LanguageModelV3StreamPart
) {
  if (state.isInsideToolCall) {
    const trailingBuffer = state.buffer;
    state.buffer = "";
    emitIncompleteToolCall(
      state,
      controller,
      toolCallStart,
      trailingBuffer,
      tools,
      options
    );
  } else if (state.buffer.length > 0) {
    flushBuffer(state, controller, toolCallStart);
  }
  closeTextBlock(state, controller);
  controller.enqueue(chunk);
}

function publishText(
  text: string,
  state: StreamState,
  controller: StreamController,
  tools: LanguageModelV3FunctionTool[]
) {
  if (state.isInsideToolCall) {
    closeTextBlock(state, controller);
    state.currentToolCallJson += text;
    emitToolInputProgress(state, controller, tools);
  } else if (text.length > 0) {
    if (!state.currentTextId) {
      state.currentTextId = generateId();
      controller.enqueue({
        type: "text-start",
        id: state.currentTextId,
      } as LanguageModelV3StreamPart);
      state.hasEmittedTextStart = true;
    }
    controller.enqueue({
      type: "text-delta",
      id: state.currentTextId,
      delta: text,
    } as LanguageModelV3StreamPart);
  }
}

function emitToolCall(context: TagProcessingContext) {
  const { state, controller, toolCallStart, toolCallEnd, options, tools } =
    context;
  try {
    const parsedToolCall = parseRJSON(
      normalizeJsonStringCtrl(state.currentToolCallJson)
    ) as {
      name: string;
      arguments: unknown;
    };
    emitToolCallFromParsed(state, controller, parsedToolCall, tools);
  } catch (error) {
    // Attempt repair for unescaped quotes
    const repaired = repairToolCallJsonForTools(state.currentToolCallJson, tools);
    if (repaired) {
      emitToolCallFromParsed(state, controller, repaired, tools);
      return;
    }

    const errorContent = `${toolCallStart}${state.currentToolCallJson}${toolCallEnd}`;
    const shouldEmitRawFallback = shouldEmitRawToolCallTextOnError(options);
    const streamingToolCallId =
      state.activeToolInput?.id ?? generateToolCallId();
    const streamingToolName =
      state.activeToolInput?.toolName ??
      extractStreamingToolCallProgress(state.currentToolCallJson).toolName;

    logParseFailure({
      phase: "stream",
      reason: "Failed to parse streaming tool call JSON segment",
      snippet: errorContent,
      error,
    });
    if (shouldEmitRawFallback) {
      const errorId = generateId();
      controller.enqueue({
        type: "text-start",
        id: errorId,
      } as LanguageModelV3StreamPart);
      controller.enqueue({
        type: "text-delta",
        id: errorId,
        delta: errorContent,
      } as LanguageModelV3StreamPart);
      controller.enqueue({
        type: "text-end",
        id: errorId,
      } as LanguageModelV3StreamPart);
    }
    closeToolInput(state, controller);
    options?.onError?.(
      shouldEmitRawFallback
        ? "Could not process streaming JSON tool call; emitting original text."
        : "Could not process streaming JSON tool call.",
      {
        toolCall: errorContent,
        error,
        toolCallId: streamingToolCallId,
        toolName: streamingToolName,
        dropReason: "malformed-tool-call-body",
      }
    );
  }
}

function processTagMatch(context: TagProcessingContext) {
  const { state } = context;
  if (state.isInsideToolCall) {
    emitToolCall(context);
    state.currentToolCallJson = "";
    state.isInsideToolCall = false;
  } else {
    state.currentToolCallJson = "";
    state.isInsideToolCall = true;
    state.activeToolInput = null;
  }
}

function recoverNestedStreamingToolCall(options: {
  context: TagProcessingContext;
  jsonSoFar: string;
  nestedStartIndex: number;
  startIndex: number;
  tag: string;
}): number | null {
  const { context, jsonSoFar, nestedStartIndex, startIndex, tag } = options;
  const {
    state,
    controller,
    toolCallStart,
    toolCallEnd,
    options: parserOptions,
  } = context;
  const droppedToolCall = `${toolCallStart}${jsonSoFar.slice(
    0,
    nestedStartIndex
  )}`;
  const shouldEmitRawFallback = shouldEmitRawToolCallTextOnError(parserOptions);
  const streamingToolCallId = state.activeToolInput?.id;
  const streamingToolName =
    state.activeToolInput?.toolName ??
    extractStreamingToolCallProgress(jsonSoFar.slice(0, nestedStartIndex))
      .toolName;

  logParseFailure({
    phase: "stream",
    reason: "Abandoning malformed streaming tool call before nested start tag",
    snippet: droppedToolCall,
  });
  if (shouldEmitRawFallback) {
    const errorId = generateId();
    controller.enqueue({
      type: "text-start",
      id: errorId,
    } as LanguageModelV3StreamPart);
    controller.enqueue({
      type: "text-delta",
      id: errorId,
      delta: droppedToolCall,
    } as LanguageModelV3StreamPart);
    controller.enqueue({
      type: "text-end",
      id: errorId,
    } as LanguageModelV3StreamPart);
  }
  closeToolInput(state, controller);
  parserOptions?.onError?.(
    shouldEmitRawFallback
      ? "Could not process malformed streaming JSON tool call before nested start; emitting original text."
      : "Could not process malformed streaming JSON tool call before nested start.",
    {
      toolCall: droppedToolCall,
      toolCallId: streamingToolCallId,
      toolName: streamingToolName,
      dropReason: "malformed-nested-tool-call",
    }
  );
  state.currentToolCallJson = "";
  state.isInsideToolCall = false;
  state.buffer =
    jsonSoFar.slice(nestedStartIndex) +
    toolCallEnd +
    state.buffer.slice(startIndex + tag.length);
  return getPotentialStartIndex(state.buffer, toolCallStart);
}

function processInsideToolCallBoundary(context: TagProcessingContext): boolean {
  const { state, controller, toolCallStart, toolCallEnd, tools } = context;
  const currentLength = state.currentToolCallJson.length;
  const combined = state.currentToolCallJson + state.buffer;
  const boundary = findToolCallBoundaryOutsideRjsonSyntax(
    combined,
    0,
    toolCallStart,
    toolCallEnd
  );
  if (boundary == null) {
    return false;
  }

  const relativeEndIndex = boundary.endIdx - currentLength;
  if (relativeEndIndex < 0) {
    return false;
  }

  if (boundary.kind === "nested") {
    recoverNestedStreamingToolCall({
      context,
      jsonSoFar: combined.slice(0, boundary.endIdx),
      nestedStartIndex: boundary.nestedStartIndex,
      startIndex: relativeEndIndex,
      tag: toolCallEnd,
    });
    return true;
  }

  publishText(
    state.buffer.slice(0, relativeEndIndex),
    state,
    controller,
    tools
  );
  state.buffer = state.buffer.slice(relativeEndIndex + toolCallEnd.length);
  processTagMatch(context);
  return true;
}

function processBufferTags(context: TagProcessingContext) {
  const { state, controller, toolCallStart, tools } = context;

  while (state.isInsideToolCall) {
    if (!processInsideToolCallBoundary(context)) {
      return;
    }
  }

  let startIndex = getPotentialStartIndex(state.buffer, toolCallStart);

  while (startIndex != null) {
    if (startIndex + toolCallStart.length > state.buffer.length) {
      break;
    }

    publishText(state.buffer.slice(0, startIndex), state, controller, tools);
    state.buffer = state.buffer.slice(startIndex + toolCallStart.length);
    processTagMatch(context);

    while (state.isInsideToolCall) {
      if (!processInsideToolCallBoundary(context)) {
        return;
      }
    }

    startIndex = getPotentialStartIndex(state.buffer, toolCallStart);
  }
}

function handlePartialTag(
  state: StreamState,
  controller: StreamController,
  toolCallStart: string,
  toolCallEnd: string,
  tools: LanguageModelV3FunctionTool[]
) {
  if (state.isInsideToolCall) {
    const potentialEndIndex = getPotentialStartIndex(state.buffer, toolCallEnd);
    if (
      potentialEndIndex != null &&
      potentialEndIndex + toolCallEnd.length > state.buffer.length
    ) {
      publishText(
        state.buffer.slice(0, potentialEndIndex),
        state,
        controller,
        tools
      );
      state.buffer = state.buffer.slice(potentialEndIndex);
    } else {
      publishText(state.buffer, state, controller, tools);
      state.buffer = "";
    }
    return;
  }

  const potentialIndex = getPotentialStartIndex(state.buffer, toolCallStart);
  if (
    potentialIndex != null &&
    potentialIndex + toolCallStart.length > state.buffer.length
  ) {
    publishText(
      state.buffer.slice(0, potentialIndex),
      state,
      controller,
      tools
    );
    state.buffer = state.buffer.slice(potentialIndex);
  } else {
    publishText(state.buffer, state, controller, tools);
    state.buffer = "";
  }
}

export const hermesProtocol = ({
  toolCallStart = "<tool_call>",
  toolCallEnd = "</tool_call>",
}: HermesProtocolOptions = {}): TCMProtocol => ({
  ...validateNonEmptyDelimiters(toolCallStart, toolCallEnd),

  formatTools({
    tools,
    toolSystemPromptTemplate,
  }: {
    tools: LanguageModelV3FunctionTool[];
    toolSystemPromptTemplate: (tools: LanguageModelV3FunctionTool[]) => string;
  }) {
    return formatToolsWithPromptTemplate({ tools, toolSystemPromptTemplate });
  },

  formatToolCall(toolCall: LanguageModelV3ToolCall) {
    let args: unknown = {};
    if (toolCall.input != null) {
      try {
        args = JSON.parse(toolCall.input);
      } catch {
        args = toolCall.input;
      }
    }
    return `${toolCallStart}${JSON.stringify({
      name: toolCall.toolName,
      arguments: args,
    })}${toolCallEnd}`;
  },

  parseGeneratedText({
    text,
    tools,
    options,
  }: {
    text: string;
    tools: LanguageModelV3FunctionTool[];
    options?: ParserOptions;
  }) {
    const processedElements: LanguageModelV3Content[] = [];
    let currentIndex = 0;
    let searchFrom = 0;

    while (searchFrom < text.length) {
      const span = findNextToolCallSpan(
        text,
        searchFrom,
        toolCallStart,
        toolCallEnd
      );
      if (span === null) {
        break;
      }

      if (!span.found) {
        // Orphan start tag — emit everything up to and including it as text,
        // then continue searching for subsequent tool calls.
        const skipTo = span.startIdx + toolCallStart.length;
        if (skipTo > currentIndex) {
          addTextSegment(text.slice(currentIndex, skipTo), processedElements);
          currentIndex = skipTo;
        }
        searchFrom = skipTo;
        continue;
      }

      const toolCallJson = text.slice(span.jsonStart, span.endIdx);
      const fullMatch = text.slice(
        span.startIdx,
        span.endIdx + toolCallEnd.length
      );

      if (span.startIdx > currentIndex) {
        addTextSegment(
          text.slice(currentIndex, span.startIdx),
          processedElements
        );
      }

      processToolCallJson(
        toolCallJson,
        fullMatch,
        processedElements,
        tools,
        options
      );
      currentIndex = span.endIdx + toolCallEnd.length;
      searchFrom = currentIndex;
    }

    if (currentIndex < text.length) {
      const remainingText = text.slice(currentIndex);
      addTextSegment(remainingText, processedElements);
    }

    return processedElements;
  },

  createStreamParser({
    tools,
    options,
  }: {
    tools: LanguageModelV3FunctionTool[];
    options?: ParserOptions;
  }) {
    const state: StreamState = {
      isInsideToolCall: false,
      buffer: "",
      currentToolCallJson: "",
      currentTextId: null,
      hasEmittedTextStart: false,
      activeToolInput: null,
    };

    return new TransformStream<
      LanguageModelV3StreamPart,
      LanguageModelV3StreamPart
    >({
      transform(chunk, controller) {
        if (chunk.type === "finish") {
          handleFinishChunk(
            state,
            controller,
            toolCallStart,
            tools,
            options,
            chunk
          );
          return;
        }

        if (chunk.type !== "text-delta") {
          controller.enqueue(chunk);
          return;
        }

        const textContent = (chunk as { delta?: string }).delta ?? "";
        state.buffer += textContent;
        processBufferTags({
          state,
          controller,
          toolCallStart,
          toolCallEnd,
          options,
          tools,
        });
        handlePartialTag(state, controller, toolCallStart, toolCallEnd, tools);
      },
    });
  },

  extractToolCallSegments({ text }) {
    const segments: string[] = [];
    let searchFrom = 0;

    while (searchFrom < text.length) {
      const span = findNextToolCallSpan(
        text,
        searchFrom,
        toolCallStart,
        toolCallEnd
      );
      if (span === null) {
        break;
      }

      if (!span.found) {
        // Orphan start tag — skip past it and keep searching
        searchFrom = span.startIdx + toolCallStart.length;
        continue;
      }

      segments.push(
        text.slice(span.startIdx, span.endIdx + toolCallEnd.length)
      );
      searchFrom = span.endIdx + toolCallEnd.length;
    }

    return segments;
  },
});
