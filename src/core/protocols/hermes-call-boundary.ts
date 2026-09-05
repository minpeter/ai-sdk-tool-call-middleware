const WHITESPACE_JSON_REGEX = /\s/;

// Local copy of hermes-json-object-key-scanner's skipJsonWhitespace; that
// module imports from this one, so importing it here would create a cycle.
function skipJsonWhitespace(text: string, fromIndex: number): number {
  let index = fromIndex;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    // Fast path for ASCII whitespace: /\s/ matches \t \n \v \f \r and space.
    if ((code >= 9 && code <= 13) || code === 32) {
      index += 1;
      continue;
    }
    // Non-ASCII whitespace (NBSP, unicode spaces, ...) still matches /\s/.
    if (code > 127 && WHITESPACE_JSON_REGEX.test(text[index])) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

const RJSON_IDENTIFIER_CHAR_REGEX = /[$a-zA-Z0-9_\-+.*?!|&%^/#\\]/;
const RJSON_NUMBER_TOKEN_REGEX = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

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

export function startsRjsonComment(
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

interface BoundaryScanState {
  blockCommentSawEndTag: boolean;
  escaping: boolean;
  inBlockComment: boolean;
  inLineComment: boolean;
  lineCommentSawEndTag: boolean;
  nestedStartIndex: number | null;
  quote: '"' | "'" | null;
}

interface BoundaryScanContext {
  readonly endTag: string;
  readonly startTag: string;
  readonly text: string;
}

function consumeBoundaryString(
  state: BoundaryScanState,
  char: string
): boolean {
  if (state.escaping) {
    state.escaping = false;
    return true;
  }
  if (state.quote === null) {
    return false;
  }
  if (char === "\\") {
    state.escaping = true;
  } else if (char === state.quote) {
    state.quote = null;
  }
  return true;
}

function startsNestedCallAfterCommentEnd(
  context: BoundaryScanContext,
  index: number
): boolean {
  return (
    context.text.startsWith(context.startTag, index) &&
    context.text[
      skipJsonWhitespace(context.text, index + context.startTag.length)
    ] === "{"
  );
}

function consumeLineComment(
  state: BoundaryScanState,
  context: BoundaryScanContext,
  index: number
): number {
  const char = context.text[index];
  if (char === "\n" || char === "\r") {
    state.inLineComment = false;
    state.lineCommentSawEndTag = false;
    return index;
  }
  if (context.text.startsWith(context.endTag, index)) {
    state.lineCommentSawEndTag = true;
    return index + context.endTag.length - 1;
  }
  if (
    state.lineCommentSawEndTag &&
    startsNestedCallAfterCommentEnd(context, index)
  ) {
    state.nestedStartIndex = index;
    state.inLineComment = false;
    state.lineCommentSawEndTag = false;
    return index + context.startTag.length - 1;
  }
  return index;
}

function consumeBlockComment(
  state: BoundaryScanState,
  context: BoundaryScanContext,
  index: number
): number {
  if (context.text[index] === "*" && context.text[index + 1] === "/") {
    state.inBlockComment = false;
    state.blockCommentSawEndTag = false;
    return index + 1;
  }
  if (context.text.startsWith(context.endTag, index)) {
    state.blockCommentSawEndTag = true;
    return index + context.endTag.length - 1;
  }
  if (
    state.blockCommentSawEndTag &&
    startsNestedCallAfterCommentEnd(context, index)
  ) {
    state.nestedStartIndex = index;
    state.inBlockComment = false;
    state.blockCommentSawEndTag = false;
    return index + context.startTag.length - 1;
  }
  return index;
}

function enterBoundaryComment(
  state: BoundaryScanState,
  text: string,
  index: number
): boolean {
  const next = text[index + 1];
  state.inLineComment = next === "/";
  state.inBlockComment = next === "*";
  return state.inLineComment || state.inBlockComment;
}

function createToolCallBoundary(
  state: BoundaryScanState,
  endIdx: number
): ToolCallBoundary {
  return state.nestedStartIndex == null
    ? { kind: "end", endIdx }
    : {
        kind: "nested",
        endIdx,
        nestedStartIndex: state.nestedStartIndex,
      };
}

export function findToolCallBoundaryOutsideRjsonSyntax(
  text: string,
  scanFrom: number,
  startTag: string,
  endTag: string
): ToolCallBoundary | null {
  const state: BoundaryScanState = {
    quote: null,
    escaping: false,
    inLineComment: false,
    inBlockComment: false,
    lineCommentSawEndTag: false,
    blockCommentSawEndTag: false,
    nestedStartIndex: null,
  };
  const context = { text, startTag, endTag };

  for (let index = scanFrom; index < text.length; index += 1) {
    const char = text[index];
    if (consumeBoundaryString(state, char)) {
      continue;
    }
    if (state.inLineComment) {
      index = consumeLineComment(state, context, index);
      continue;
    }
    if (state.inBlockComment) {
      index = consumeBlockComment(state, context, index);
      continue;
    }
    if (
      startsRjsonComment(text, index, scanFrom) &&
      enterBoundaryComment(state, text, index)
    ) {
      index += 1;
      continue;
    }
    if (text.startsWith(endTag, index)) {
      return createToolCallBoundary(state, index);
    }
    if (
      state.nestedStartIndex == null &&
      text.startsWith(startTag, index) &&
      isLikelyNestedToolCallStart(text, index, startTag)
    ) {
      state.nestedStartIndex = index;
      index += startTag.length - 1;
      continue;
    }
    if (char === '"' || char === "'") {
      state.quote = char;
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
 *   - `{ startIdx, found: false, nestedStartIndex? }`: an orphan start tag;
 *     when the boundary was a nested start, its index is exposed so callers
 *     may safely inspect the otherwise complete preceding body
 */
export function findNextToolCallSpan(
  text: string,
  searchFrom: number,
  startTag: string,
  endTag: string
):
  | { startIdx: number; found: true; jsonStart: number; endIdx: number }
  | { startIdx: number; found: false; nestedStartIndex?: number }
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
    return {
      startIdx,
      found: false,
      nestedStartIndex: boundary.nestedStartIndex,
    };
  }
  return { startIdx, found: true, jsonStart, endIdx: boundary.endIdx };
}
