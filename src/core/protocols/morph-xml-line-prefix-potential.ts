import { consumeWhitespace } from "./morph-xml-whitespace";

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
