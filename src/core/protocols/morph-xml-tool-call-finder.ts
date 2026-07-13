import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { extractToolNames } from "../utils/protocol-utils";
import { escapeRegExp } from "../utils/regex";
import { NAME_CHAR_RE, WHITESPACE_REGEX } from "../utils/regex-constants";
import { collectSchemaSelectionPropertyNames } from "../utils/tool-call-schema-property-names";
import { tryRepairXmlSelfClosingRootWithBody } from "../utils/xml-root-repair";
import { findNextToolTag } from "../utils/xml-tool-tag-scanner";
import type { LinePrefixedToolCall } from "./morph-xml-stream-state-machine";

function getToolSchema(
  tools: LanguageModelV4FunctionTool[],
  toolName: string
): unknown {
  return tools.find((tool) => tool.name === toolName)?.inputSchema;
}

function findClosingTagEndFlexible(
  text: string,
  contentStart: number,
  toolName: string
): number {
  let pos = contentStart;
  let depth = 1;

  while (pos < text.length) {
    const tok = nextTagToken(text, pos);
    if (tok.kind === "eof") {
      break;
    }
    const result = updateDepthWithToken(tok, toolName, depth);
    ({ depth } = result);
    if (result.closedAt !== undefined) {
      return result.closedAt;
    }
    pos = tok.nextPos;
  }
  return -1;
}

function skipSpecialSegment(text: string, lt: number): number | null {
  const next = text[lt + 1];
  if (next === "!" || next === "?") {
    const gt = text.indexOf(">", lt + 1);
    if (gt !== -1) {
      return gt + 1;
    }
  }
  return null;
}

function consumeClosingTag(
  text: string,
  lt: number
): { matched: boolean; endPos: number } {
  const gt = text.indexOf(">", lt + 1);
  const endPos = gt === -1 ? text.length : gt + 1;
  return { matched: false, endPos };
}

function consumeOpenTag(
  text: string,
  lt: number
): { name: string; selfClosing: boolean; nextPos: number } | null {
  let p = lt + 1;
  while (p < text.length && WHITESPACE_REGEX.test(text[p])) {
    p += 1;
  }
  const nameStart = p;
  while (p < text.length && NAME_CHAR_RE.test(text.charAt(p))) {
    p += 1;
  }
  const name = text.slice(nameStart, p);
  const q = text.indexOf(">", p);
  if (q === -1) {
    return null;
  }
  let r = q - 1;
  while (r >= nameStart && WHITESPACE_REGEX.test(text[r])) {
    r -= 1;
  }
  const selfClosing = text[r] === "/";
  return { name, selfClosing, nextPos: q + 1 };
}

function updateDepthWithToken(
  tok:
    | { kind: "special"; nextPos: number }
    | { kind: "close"; name: string; nextPos: number }
    | { kind: "open"; name: string; selfClosing: boolean; nextPos: number },
  toolName: string,
  depth: number
): { depth: number; closedAt?: number } {
  if (tok.kind === "close" && tok.name === toolName) {
    const newDepth = depth - 1;
    return newDepth === 0
      ? { depth: newDepth, closedAt: tok.nextPos }
      : { depth: newDepth };
  }
  if (tok.kind === "open" && tok.name === toolName && !tok.selfClosing) {
    return { depth: depth + 1 };
  }
  return { depth };
}

function nextTagToken(
  text: string,
  fromPos: number
):
  | { kind: "eof"; nextPos: number }
  | { kind: "special"; nextPos: number }
  | { kind: "close"; name: string; nextPos: number }
  | { kind: "open"; name: string; selfClosing: boolean; nextPos: number } {
  const lt = text.indexOf("<", fromPos);
  if (lt === -1 || lt + 1 >= text.length) {
    return { kind: "eof", nextPos: text.length };
  }
  const next = text[lt + 1];
  const specialEnd = skipSpecialSegment(text, lt);
  if (specialEnd !== null) {
    return { kind: "special", nextPos: specialEnd };
  }
  if (next === "/") {
    const closing = consumeClosingTag(text, lt);
    let p = lt + 2;
    while (p < text.length && WHITESPACE_REGEX.test(text[p])) {
      p += 1;
    }
    const nameStart = p;
    while (p < text.length && NAME_CHAR_RE.test(text.charAt(p))) {
      p += 1;
    }
    const name = text.slice(nameStart, p);
    return { kind: "close", name, nextPos: closing.endPos };
  }
  const open = consumeOpenTag(text, lt);
  if (open === null) {
    return { kind: "eof", nextPos: text.length };
  }
  return {
    kind: "open",
    name: open.name,
    selfClosing: open.selfClosing,
    nextPos: open.nextPos,
  };
}

function findLastCloseTagStart(segment: string, toolName: string): number {
  const closeTagPattern = new RegExp(
    `</\\s*${escapeRegExp(toolName)}\\s*>`,
    "g"
  );
  let closeTagStart = -1;
  let match = closeTagPattern.exec(segment);
  while (match !== null) {
    closeTagStart = match.index;
    match = closeTagPattern.exec(segment);
  }
  if (closeTagStart === -1) {
    return segment.lastIndexOf("<");
  }
  return closeTagStart;
}

function pushSelfClosingToolCall(
  toolCalls: Array<{
    toolName: string;
    startIndex: number;
    endIndex: number;
    content: string;
    segment: string;
  }>,
  toolName: string,
  text: string,
  tagStart: number,
  tagLength: number
): number {
  const endIndex = tagStart + tagLength;
  toolCalls.push({
    toolName,
    startIndex: tagStart,
    endIndex,
    content: "",
    segment: text.slice(tagStart, endIndex),
  });
  return endIndex;
}

function appendOpenToolCallIfComplete(
  toolCalls: Array<{
    toolName: string;
    startIndex: number;
    endIndex: number;
    content: string;
    segment: string;
  }>,
  text: string,
  toolName: string,
  tagStart: number,
  startTag: string
): number {
  const contentStart = tagStart + startTag.length;
  const fullTagEnd = findClosingTagEndFlexible(text, contentStart, toolName);
  if (fullTagEnd === -1 || fullTagEnd <= contentStart) {
    return contentStart;
  }
  const segment = text.slice(tagStart, fullTagEnd);
  const closeTagStart = findLastCloseTagStart(segment, toolName);
  const inner =
    closeTagStart === -1
      ? segment.slice(startTag.length)
      : segment.slice(startTag.length, closeTagStart);
  toolCalls.push({
    toolName,
    startIndex: tagStart,
    endIndex: fullTagEnd,
    content: inner,
    segment,
  });
  return fullTagEnd;
}

function findToolCallsForName(
  text: string,
  toolName: string
): Array<{
  toolName: string;
  startIndex: number;
  endIndex: number;
  content: string;
  segment: string;
}> {
  const toolCalls: Array<{
    toolName: string;
    startIndex: number;
    endIndex: number;
    content: string;
    segment: string;
  }> = [];
  const startTag = `<${toolName}>`;
  let searchIndex = 0;

  while (searchIndex < text.length) {
    const match = findNextToolTag(text, searchIndex, toolName);
    if (match === null) {
      break;
    }
    if (match.isSelfClosing) {
      searchIndex = pushSelfClosingToolCall(
        toolCalls,
        toolName,
        text,
        match.tagStart,
        match.tagLength
      );
      continue;
    }
    searchIndex = appendOpenToolCallIfComplete(
      toolCalls,
      text,
      toolName,
      match.tagStart,
      startTag
    );
  }

  return toolCalls;
}

export function findToolCalls(
  text: string,
  toolNames: string[]
): Array<{
  toolName: string;
  startIndex: number;
  endIndex: number;
  content: string;
  segment: string;
}> {
  const toolCalls: Array<{
    toolName: string;
    startIndex: number;
    endIndex: number;
    content: string;
    segment: string;
  }> = [];

  for (const toolName of toolNames) {
    const calls = findToolCallsForName(text, toolName);
    toolCalls.push(...calls);
  }

  return toolCalls.sort((a, b) => a.startIndex - b.startIndex);
}

interface TokenHandlerResult {
  depth: number;
  lastCompleteEnd: number;
  shouldBreak: boolean;
}

function handleSpecialToken(depth: number): TokenHandlerResult {
  return { depth, lastCompleteEnd: -1, shouldBreak: false };
}

function handleOpenToken(
  token: { selfClosing: boolean; nextPos: number },
  depth: number,
  lastCompleteEnd: number
): TokenHandlerResult {
  if (token.selfClosing) {
    return {
      depth,
      lastCompleteEnd: depth === 0 ? token.nextPos : lastCompleteEnd,
      shouldBreak: false,
    };
  }
  return { depth: depth + 1, lastCompleteEnd, shouldBreak: false };
}

function handleCloseToken(
  token: { nextPos: number },
  depth: number
): TokenHandlerResult {
  if (depth <= 0) {
    return { depth, lastCompleteEnd: -1, shouldBreak: true };
  }
  const newDepth = depth - 1;
  return {
    depth: newDepth,
    lastCompleteEnd: newDepth === 0 ? token.nextPos : -1,
    shouldBreak: false,
  };
}

function findLinePrefixedXmlBodyEnd(
  text: string,
  bodyStartIndex: number,
  toolNames: string[],
  propertyNames: Set<string>
): number {
  let cursor = bodyStartIndex;
  let depth = 0;
  let lastCompleteEnd = -1;

  while (cursor < text.length) {
    if (depth === 0) {
      cursor = consumeWhitespace(text, cursor);
      if (cursor >= text.length || text.charAt(cursor) !== "<") {
        break;
      }
    }

    const token = nextTagToken(text, cursor);
    if (token.kind === "eof") {
      break;
    }
    if (
      depth === 0 &&
      lastCompleteEnd !== -1 &&
      token.kind === "open" &&
      toolNames.includes(token.name) &&
      !propertyNames.has(token.name)
    ) {
      break;
    }

    let result: TokenHandlerResult;
    if (token.kind === "special") {
      result = handleSpecialToken(depth);
    } else if (token.kind === "open") {
      result = handleOpenToken(token, depth, lastCompleteEnd);
    } else {
      result = handleCloseToken(token, depth);
    }

    ({ depth } = result);
    if (result.lastCompleteEnd !== -1) {
      ({ lastCompleteEnd } = result);
    }
    if (result.shouldBreak) {
      break;
    }
    cursor = token.nextPos;
  }

  return lastCompleteEnd;
}

function resolveLinePrefixedCallBoundary(options: {
  contentEnd: number;
  propertyNames: Set<string>;
  text: string;
  toolName: string;
  toolNames: string[];
}): { boundaryConfirmed: boolean; endIndex: number } {
  const afterWhitespace = consumeWhitespace(options.text, options.contentEnd);
  const closeTagPattern = new RegExp(
    `^</\\s*${escapeRegExp(options.toolName)}\\s*>`
  );
  const closeMatch = closeTagPattern.exec(options.text.slice(afterWhitespace));
  if (closeMatch) {
    return {
      boundaryConfirmed: true,
      endIndex: afterWhitespace + closeMatch[0].length,
    };
  }
  const nextIsKnownToolCall = options.toolNames.some((toolName) => {
    if (options.propertyNames.has(toolName)) {
      return false;
    }
    const next = findNextToolTag(options.text, afterWhitespace, toolName);
    return next?.tagStart === afterWhitespace;
  });
  return {
    boundaryConfirmed:
      nextIsKnownToolCall ||
      (afterWhitespace < options.text.length &&
        options.text.charAt(afterWhitespace) !== "<"),
    endIndex: options.contentEnd,
  };
}

function findLinePrefixedToolCall(
  text: string,
  tools: LanguageModelV4FunctionTool[],
  searchFrom = 0
):
  | (LinePrefixedToolCall & { boundaryConfirmed: boolean; segment: string })
  | null {
  let best:
    | (LinePrefixedToolCall & {
        boundaryConfirmed: boolean;
        segment: string;
      })
    | null = null;
  const toolNames = extractToolNames(tools);

  for (const toolName of toolNames) {
    const linePattern = new RegExp(
      `(^|\\n)[\\t ]*${escapeRegExp(toolName)}[\\t ]*:?[\\t ]*(?:\\r?\\n|$)`,
      "g"
    );
    linePattern.lastIndex = searchFrom;

    let match = linePattern.exec(text);
    while (match !== null) {
      const prefix = match[1] ?? "";
      const startIndex = match.index + prefix.length;
      const contentStart = consumeWhitespace(text, linePattern.lastIndex);
      if (contentStart >= text.length || text.charAt(contentStart) !== "<") {
        match = linePattern.exec(text);
        continue;
      }
      const propertyNames = collectSchemaSelectionPropertyNames(
        getToolSchema(tools, toolName)
      );
      const contentEnd = findLinePrefixedXmlBodyEnd(
        text,
        contentStart,
        toolNames,
        propertyNames
      );
      if (contentEnd === -1 || contentEnd <= contentStart) {
        match = linePattern.exec(text);
        continue;
      }
      const content = text.slice(contentStart, contentEnd);
      const { boundaryConfirmed, endIndex } = resolveLinePrefixedCallBoundary({
        contentEnd,
        propertyNames,
        text,
        toolName,
        toolNames,
      });

      const candidate = {
        toolName,
        startIndex,
        endIndex,
        content,
        boundaryConfirmed,
        segment: text.slice(startIndex, endIndex),
      };
      if (best === null || candidate.startIndex < best.startIndex) {
        best = candidate;
      }
      break;
    }
  }

  return best;
}

function findLinePrefixedToolCalls(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): Array<LinePrefixedToolCall & { segment: string }> {
  const calls: Array<LinePrefixedToolCall & { segment: string }> = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const call = findLinePrefixedToolCall(text, tools, searchFrom);
    if (!call) {
      break;
    }
    calls.push(call);
    searchFrom = call.endIndex;
  }

  return calls;
}

function consumeHorizontalWhitespace(text: string, index: number): number {
  let cursor = index;
  while (
    cursor < text.length &&
    (text.charAt(cursor) === " " || text.charAt(cursor) === "\t")
  ) {
    cursor += 1;
  }
  return cursor;
}

function consumePotentialLineBreak(
  text: string,
  index: number
): { nextIndex: number; valid: boolean } {
  if (text.charAt(index) === "\n") {
    return { nextIndex: index + 1, valid: true };
  }
  if (text.charAt(index) !== "\r") {
    return { nextIndex: index, valid: false };
  }
  if (index + 1 === text.length) {
    return { nextIndex: text.length, valid: true };
  }
  return text.charAt(index + 1) === "\n"
    ? { nextIndex: index + 2, valid: true }
    : { nextIndex: index, valid: false };
}

function isPotentialLinePrefixedToolNameAt(
  text: string,
  lineStart: number,
  toolName: string
): boolean {
  let cursor = consumeHorizontalWhitespace(text, lineStart);

  const availableNameLength = Math.min(toolName.length, text.length - cursor);
  if (
    text.slice(cursor, cursor + availableNameLength) !==
    toolName.slice(0, availableNameLength)
  ) {
    return false;
  }
  cursor += availableNameLength;
  if (availableNameLength < toolName.length) {
    return cursor === text.length;
  }

  cursor = consumeHorizontalWhitespace(text, cursor);
  if (cursor === text.length) {
    return true;
  }
  if (text.charAt(cursor) === ":") {
    cursor = consumeHorizontalWhitespace(text, cursor + 1);
    if (cursor === text.length) {
      return true;
    }
  }

  const lineBreak = consumePotentialLineBreak(text, cursor);
  if (!lineBreak.valid) {
    return false;
  }

  cursor = consumeWhitespace(text, lineBreak.nextIndex);
  return cursor === text.length || text.charAt(cursor) === "<";
}

export function findPotentialLinePrefixedToolCallStart(
  text: string,
  toolNames: string[]
): number {
  let lineStart = 0;
  while (lineStart <= text.length) {
    if (
      toolNames.some((toolName) =>
        isPotentialLinePrefixedToolNameAt(text, lineStart, toolName)
      )
    ) {
      return lineStart;
    }
    const newlineIndex = text.indexOf("\n", lineStart);
    if (newlineIndex === -1) {
      break;
    }
    lineStart = newlineIndex + 1;
  }
  return -1;
}

export function findStreamingLinePrefixedToolCall(
  text: string,
  tools: LanguageModelV4FunctionTool[],
  allowAtBufferEnd: boolean
): LinePrefixedToolCall | null {
  const candidate = findLinePrefixedToolCall(text, tools);
  if (!candidate) {
    return null;
  }
  return candidate.boundaryConfirmed || allowAtBufferEnd ? candidate : null;
}

function isOpenTagPrefix(suffix: string, toolName: string): boolean {
  return `${toolName}>`.startsWith(suffix);
}

function consumeWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && WHITESPACE_REGEX.test(text.charAt(i))) {
    i += 1;
  }
  return i;
}

function consumeToolNamePrefix(
  text: string,
  index: number,
  toolName: string
): { index: number; done: boolean; valid: boolean } {
  let i = index;
  let nameIndex = 0;

  while (i < text.length && nameIndex < toolName.length) {
    if (text.charAt(i) !== toolName.charAt(nameIndex)) {
      return { index: i, done: false, valid: false };
    }
    i += 1;
    nameIndex += 1;
  }

  return { index: i, done: nameIndex === toolName.length, valid: true };
}

/**
 * Checks if the remainder of text at index is a valid self-closing tag suffix.
 * Returns true if:
 * - text[index] is "/" and we're at the end (incomplete "/")
 * - text[index..] is "/>" at the end of the string
 */
function isSelfClosingSuffixRemainder(text: string, index: number): boolean {
  if (text.charAt(index) !== "/") {
    return false;
  }
  if (index + 1 >= text.length) {
    return true;
  }
  return index + 1 === text.length - 1 && text.charAt(index + 1) === ">";
}

function isSelfClosingTagPrefix(suffix: string, toolName: string): boolean {
  let i = consumeWhitespace(suffix, 0);
  if (i >= suffix.length) {
    return true;
  }

  const nameRemainder = suffix.slice(i);
  if (toolName.startsWith(nameRemainder)) {
    return true;
  }

  const nameResult = consumeToolNamePrefix(suffix, i, toolName);
  if (!nameResult.valid) {
    return false;
  }

  i = nameResult.index;
  if (i >= suffix.length) {
    return true;
  }
  if (!nameResult.done) {
    return false;
  }

  i = consumeWhitespace(suffix, i);
  if (i >= suffix.length) {
    return true;
  }

  return isSelfClosingSuffixRemainder(suffix, i);
}

export function findPotentialToolTagStart(
  buffer: string,
  toolNames: string[]
): number {
  if (toolNames.length === 0 || buffer.length === 0) {
    return -1;
  }

  const lastGt = buffer.lastIndexOf(">");
  const offset = lastGt === -1 ? 0 : lastGt + 1;
  const trailing = buffer.slice(offset);

  for (let i = trailing.length - 1; i >= 0; i -= 1) {
    if (trailing.charAt(i) !== "<") {
      continue;
    }
    const suffix = trailing.slice(i + 1);
    for (const name of toolNames) {
      if (
        isOpenTagPrefix(suffix, name) ||
        isSelfClosingTagPrefix(suffix, name)
      ) {
        return offset + i;
      }
    }
  }

  return -1;
}

export function findToolCallsWithFallbacks(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): { parseText: string; toolCalls: ReturnType<typeof findToolCalls> } {
  let parseText = text;
  const toolNames = extractToolNames(tools);
  let toolCalls = findToolCalls(parseText, toolNames);
  const linePrefixedCalls = findLinePrefixedToolCalls(parseText, tools);

  if (linePrefixedCalls.length > 0) {
    const candidates = [...toolCalls, ...linePrefixedCalls].sort(
      (left, right) =>
        left.startIndex - right.startIndex || right.endIndex - left.endIndex
    );
    toolCalls = [];
    for (const candidate of candidates) {
      if (
        toolCalls.every(
          (selected) =>
            candidate.endIndex <= selected.startIndex ||
            candidate.startIndex >= selected.endIndex
        )
      ) {
        toolCalls.push(candidate);
      }
    }
  }

  if (toolCalls.length === 0) {
    const repaired = tryRepairXmlSelfClosingRootWithBody(parseText, toolNames);
    if (repaired) {
      const repairedCalls = findToolCalls(repaired, toolNames);
      if (repairedCalls.length > 0) {
        parseText = repaired;
        toolCalls = repairedCalls;
      }
    }
  }

  return { parseText, toolCalls };
}
