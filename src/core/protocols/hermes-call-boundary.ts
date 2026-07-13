const WHITESPACE_JSON_REGEX = /\s/;

function skipJsonWhitespace(text: string, fromIndex: number): number {
  let index = fromIndex;
  while (index < text.length && WHITESPACE_JSON_REGEX.test(text[index])) {
    index += 1;
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
