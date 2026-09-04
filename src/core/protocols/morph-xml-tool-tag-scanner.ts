import { escapeRegExp } from "../utils/regex";
import { findNextToolTag } from "../utils/xml-tool-tag-scanner";
import { findClosingTagEndFlexible } from "./morph-xml-tag-tokenizer";

interface ToolCallTagMatch {
  content: string;
  endIndex: number;
  segment: string;
  startIndex: number;
  toolName: string;
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
  toolCalls: ToolCallTagMatch[],
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
  toolCalls: ToolCallTagMatch[],
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
): ToolCallTagMatch[] {
  const toolCalls: ToolCallTagMatch[] = [];
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
): ToolCallTagMatch[] {
  const toolCalls: ToolCallTagMatch[] = [];

  for (const toolName of toolNames) {
    const calls = findToolCallsForName(text, toolName);
    toolCalls.push(...calls);
  }

  return toolCalls.sort((a, b) => a.startIndex - b.startIndex);
}
