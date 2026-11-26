import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { escapeRegExp } from "../../../shared/regex";
import { extractToolNames } from "../../utils/primitives/protocol-utils";
import { tryRepairXmlSelfClosingRootWithBody } from "../../utils/xml/xml-root-repair";
import { findNextToolTag } from "../../utils/xml/xml-tool-tag-scanner";
import { findLinePrefixedToolCalls } from "./line-prefixed-tool-call";
import { consumeWhitespace, nextTagToken } from "./xml-tag-token-scanner";

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

function isOpenTagPrefix(suffix: string, toolName: string): boolean {
  return `${toolName}>`.startsWith(suffix);
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
