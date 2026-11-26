/**
 * Utility functions for XML parsing
 */

import {
  escapeXml as sharedEscapeXml,
  escapeXmlMinimalAttr as sharedEscapeXmlMinimalAttr,
  escapeXmlMinimalText as sharedEscapeXmlMinimalText,
  unescapeXml as sharedUnescapeXml,
} from "../../shared/xml-escape";
import { NAME_SPACER } from "../core/types";

const NAME_START_CHAR_REGEX = /[A-Za-z_:]/;
const NAME_CHAR_REGEX = /[A-Za-z0-9_.:-]/;

/**
 * Check if a character is a valid XML name start character
 */
export function isNameStartChar(ch: string): boolean {
  return NAME_START_CHAR_REGEX.test(ch);
}

/**
 * Check if a character is a valid XML name character
 */
export function isNameChar(ch: string): boolean {
  return NAME_CHAR_REGEX.test(ch);
}

/**
 * Skip over quoted string content in XML
 */
export function skipQuoted(s: string, i: number): number {
  const quote = s[i];
  let pos = i + 1;
  while (pos < s.length) {
    const ch = s[pos];
    if (ch === "\\") {
      pos += 2;
      continue;
    }
    if (ch === quote) {
      return pos + 1;
    }
    pos += 1;
  }
  return pos;
}

/**
 * Parse a tag name from the current position
 */
export function parseName(
  s: string,
  pos: number
): { name: string; newPos: number } {
  const start = pos;
  let currentPos = pos;
  while (NAME_SPACER.indexOf(s[currentPos]) === -1 && s[currentPos]) {
    currentPos += 1;
  }
  return { name: s.slice(start, currentPos), newPos: currentPos };
}

/**
 * Parse a quoted string value
 */
export function parseString(
  s: string,
  pos: number
): { value: string; newPos: number } {
  const startChar = s[pos];
  const startPos = pos + 1;
  const endPos = s.indexOf(startChar, startPos);
  if (endPos === -1) {
    // Unclosed string - find the next > to continue parsing
    const tagEnd = s.indexOf(">", startPos);
    if (tagEnd !== -1) {
      return { value: s.slice(startPos, tagEnd), newPos: tagEnd };
    }
    // If no > found, return what we have
    return { value: s.slice(startPos), newPos: s.length };
  }
  return { value: s.slice(startPos, endPos), newPos: endPos + 1 };
}

/**
 * Calculate line and column from position in string
 */
export function getLineColumn(
  s: string,
  pos: number
): { line: number; column: number } {
  let line = 1;
  let column = 1;

  for (let i = 0; i < pos && i < s.length; i += 1) {
    if (s[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

export function escapeXml(text: string): string {
  return sharedEscapeXml(text);
}

export function escapeXmlMinimalText(text: string): string {
  return sharedEscapeXmlMinimalText(text);
}

export function escapeXmlMinimalAttr(
  value: string,
  wrapper: '"' | "'" = '"'
): string {
  return sharedEscapeXmlMinimalAttr(value, wrapper);
}

export function unescapeXml(text: string): string {
  return sharedUnescapeXml(text);
}
