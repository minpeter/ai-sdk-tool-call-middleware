import { NAME_CHAR_RE, WHITESPACE_REGEX } from "../utils/regex-constants";
import { findNextToolTag } from "../utils/xml-tool-tag-scanner";

interface XmlTagScan {
  depthChange: -1 | 0 | 1;
  nextPosition: number;
}

function readXmlTagName(text: string, start: number, end: number): string {
  let position = start;
  while (position < end && WHITESPACE_REGEX.test(text[position])) {
    position += 1;
  }
  const nameStart = position;
  while (position < end && NAME_CHAR_RE.test(text.charAt(position))) {
    position += 1;
  }
  return text.slice(nameStart, position);
}

function scanXmlTag(
  text: string,
  tagStart: number,
  toolName: string
): XmlTagScan | null {
  const tagEnd = text.indexOf(">", tagStart);
  if (tagEnd === -1) {
    return null;
  }
  const marker = text[tagStart + 1];
  if (marker === "!" || marker === "?") {
    return { depthChange: 0, nextPosition: tagEnd + 1 };
  }
  const isClosing = marker === "/";
  const nameStart = tagStart + (isClosing ? 2 : 1);
  const name = readXmlTagName(text, nameStart, tagEnd);
  if (name !== toolName) {
    return { depthChange: 0, nextPosition: tagEnd + 1 };
  }
  if (isClosing) {
    return { depthChange: -1, nextPosition: tagEnd + 1 };
  }
  const contentBeforeEnd = text.slice(nameStart, tagEnd).trimEnd();
  return {
    depthChange: contentBeforeEnd.endsWith("/") ? 0 : 1,
    nextPosition: tagEnd + 1,
  };
}

function findClosingTagEnd(
  text: string,
  contentStart: number,
  toolName: string
): number {
  let position = contentStart;
  let depth = 1;

  while (position < text.length) {
    const tagStart = text.indexOf("<", position);
    if (tagStart === -1) {
      return -1;
    }
    const tag = scanXmlTag(text, tagStart, toolName);
    if (tag === null) {
      return -1;
    }
    depth += tag.depthChange;
    if (depth === 0) {
      return tag.nextPosition;
    }
    position = tag.nextPosition;
  }

  return -1;
}

/**
 * Find all tool calls in the text for the given tool names.
 */
export interface ToolCallMatch {
  content: string;
  endIndex: number;
  startIndex: number;
  toolName: string;
}

function collectToolCallsForName(
  text: string,
  toolName: string
): ToolCallMatch[] {
  const toolCalls: ToolCallMatch[] = [];
  let searchIndex = 0;
  const startTag = `<${toolName}>`;

  while (searchIndex < text.length) {
    const match = findNextToolTag(text, searchIndex, toolName);
    if (match === null) {
      break;
    }

    const { tagStart } = match;
    const { isSelfClosing } = match;

    if (isSelfClosing) {
      const endIndex = tagStart + match.tagLength;
      toolCalls.push({
        toolName,
        startIndex: tagStart,
        endIndex,
        content: "",
      });
      searchIndex = endIndex;
      continue;
    }

    const contentStart = tagStart + startTag.length;
    const fullTagEnd = findClosingTagEnd(text, contentStart, toolName);
    if (fullTagEnd !== -1 && fullTagEnd > contentStart) {
      const endTag = `</${toolName}>`;
      const endTagStart = fullTagEnd - endTag.length;
      const content = text.slice(contentStart, endTagStart);
      toolCalls.push({
        toolName,
        startIndex: tagStart,
        endIndex: fullTagEnd,
        content,
      });
      searchIndex = fullTagEnd;
    } else {
      searchIndex = contentStart;
    }
  }

  return toolCalls;
}

export function findToolCalls(
  text: string,
  toolNames: string[]
): ToolCallMatch[] {
  const toolCalls = toolNames.flatMap((toolName) =>
    collectToolCallsForName(text, toolName)
  );
  return toolCalls.sort((a, b) => a.startIndex - b.startIndex);
}
