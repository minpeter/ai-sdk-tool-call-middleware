import {
  NAME_CHAR_RE,
  WHITESPACE_REGEX,
} from "../../utils/primitives/regex-constants";
import { findNextToolTag } from "../../utils/xml/xml-tool-tag-scanner";

export interface ToolCallMatch {
  content: string;
  endIndex: number;
  startIndex: number;
  toolName: string;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: XML tag parsing with nested tag tracking inherently requires complex state management
function findClosingTagEnd(
  text: string,
  contentStart: number,
  toolName: string
): number {
  let pos = contentStart;
  let depth = 1;

  while (pos < text.length) {
    const ltIdx = text.indexOf("<", pos);
    if (ltIdx === -1) {
      break;
    }

    const next = text[ltIdx + 1];
    if (next === "/") {
      const gtIdx = text.indexOf(">", ltIdx);
      if (gtIdx === -1) {
        break;
      }

      let p = ltIdx + 2;
      while (p < gtIdx && WHITESPACE_REGEX.test(text[p])) {
        p += 1;
      }
      const nameStart = p;
      while (p < gtIdx && NAME_CHAR_RE.test(text.charAt(p))) {
        p += 1;
      }
      const name = text.slice(nameStart, p);

      if (name === toolName) {
        depth -= 1;
        if (depth === 0) {
          return gtIdx + 1;
        }
      }
      pos = gtIdx + 1;
    } else if (next === "!" || next === "?") {
      const gtIdx = text.indexOf(">", ltIdx);
      pos = gtIdx === -1 ? text.length : gtIdx + 1;
    } else {
      let p = ltIdx + 1;
      while (p < text.length && WHITESPACE_REGEX.test(text[p])) {
        p += 1;
      }
      const nameStart = p;
      while (p < text.length && NAME_CHAR_RE.test(text.charAt(p))) {
        p += 1;
      }
      const name = text.slice(nameStart, p);

      const gtIdx = text.indexOf(">", p);
      if (gtIdx === -1) {
        break;
      }

      let r = gtIdx - 1;
      while (r >= nameStart && WHITESPACE_REGEX.test(text[r])) {
        r -= 1;
      }
      const selfClosing = text[r] === "/";

      if (name === toolName && !selfClosing) {
        depth += 1;
      }
      pos = gtIdx + 1;
    }
  }

  return -1;
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

    const { tagStart, isSelfClosing } = match;

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

export function stripTrailingPartialCloseTag(
  content: string,
  toolName: string
): string {
  const closeTag = `</${toolName}>`;
  const lastLineBreakIndex = Math.max(
    content.lastIndexOf("\n"),
    content.lastIndexOf("\r")
  );
  const lineStartIndex = lastLineBreakIndex === -1 ? 0 : lastLineBreakIndex + 1;
  const trailingLine = content.slice(lineStartIndex);
  const trimmedTrailingLine = trailingLine.trim();

  if (
    trimmedTrailingLine.length === 0 ||
    !trimmedTrailingLine.startsWith("</") ||
    trimmedTrailingLine === closeTag ||
    !closeTag.startsWith(trimmedTrailingLine)
  ) {
    return content;
  }

  const leadingWhitespaceLength =
    trailingLine.length - trailingLine.trimStart().length;
  const preservedLeadingWhitespace = trailingLine.slice(
    0,
    leadingWhitespaceLength
  );
  const contentWithoutPartial = `${content.slice(
    0,
    lineStartIndex
  )}${preservedLeadingWhitespace}`;

  return contentWithoutPartial.trimEnd();
}
