/**
 * Utility functions for XML parsing
 */

import { CharCodes, NAME_SPACER } from "../core/types";

/**
 * Check if a character is a valid XML name start character
 */
export function isNameStartChar(ch: string): boolean {
  return /[A-Za-z_:]/.test(ch);
}

/**
 * Check if a character is a valid XML name character
 */
export function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9_.:-]/.test(ch);
}

/**
 * Check if a character is whitespace
 */
export function isWhitespace(charCode: number): boolean {
  return (
    charCode === CharCodes.SPACE ||
    charCode === CharCodes.TAB ||
    charCode === CharCodes.NEWLINE ||
    charCode === CharCodes.CARRIAGE_RETURN
  );
}

/**
 * Skip over quoted string content in XML
 */
export function skipQuoted(s: string, i: number): number {
  const quote = s[i];
  i++;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return i;
}

/**
 * Parse a tag name from the current position
 */
export function parseName(
  s: string,
  pos: number
): { name: string; newPos: number } {
  const start = pos;
  while (NAME_SPACER.indexOf(s[pos]) === -1 && s[pos]) {
    pos++;
  }
  return { name: s.slice(start, pos), newPos: pos };
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
 * Find elements by attribute value (used for getElementById, etc.)
 */
export function findElementsByAttr(
  xmlString: string,
  attrName: string,
  attrValue: string
): number[] {
  const regex = new RegExp(`\\s${attrName}\\s*=['""]${attrValue}['""]`);
  const positions: number[] = [];
  let searchPos = 0;

  while (true) {
    const match = regex.exec(xmlString.slice(searchPos));
    if (!match) break;

    const pos = xmlString.lastIndexOf("<", searchPos + match.index);
    if (pos !== -1) {
      positions.push(pos);
    }
    searchPos += match.index + match[0].length;
  }

  return positions;
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

  for (let i = 0; i < pos && i < s.length; i++) {
    if (s[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }

  return { line, column };
}

/**
 * Escape XML special characters
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Unescape XML entities
 */
export function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
