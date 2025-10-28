/**
 * Utility functions for XML parsing
 */

import { CharCodes, NAME_SPACER } from "../core/types";

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
    pos++;
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
    currentPos++;
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
    if (!match) {
      break;
    }

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
 * Escape XML special characters used in element content and attribute values.
 *
 * References (W3C XML 1.0, Fifth Edition):
 * - 2.4 Character Data and Markup: '<' and '&' MUST NOT appear literally in content;
 *   they MUST be escaped. '>' MUST be escaped in the sequence ']]>' and MAY be
 *   escaped otherwise. Spec: https://www.w3.org/TR/2008/REC-xml-20081126/
 * - 3.1 Start-Tags, End-Tags, and Empty-Element Tags (AttValue [10]): attribute
 *   values are quoted with ' or ", and the matching quote MUST be escaped inside.
 * - 4.6 Predefined Entities: amp, lt, gt, apos, quot MUST be recognized by all
 *   XML processors. Spec: https://www.w3.org/TR/2008/REC-xml-20081126/#sec-predefined-ent
 *
 * We conservatively escape &, <, >, ", ' using the predefined entities.
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
 * Minimal escaping for character data per XML 1.0 §2.4.
 * - Escape '&' and '<' always
 * - Escape only the ']]>' sequence by turning '>' into '&gt;' in that context
 */
export function escapeXmlMinimalText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/]]>/g, "]]&gt;");
}

/**
 * Minimal escaping for attribute values per XML 1.0 §3.1 (AttValue [10]).
 * - Escape '&' and '<' always
 * - Escape only the wrapper quote among ' or "
 */
export function escapeXmlMinimalAttr(
  value: string,
  wrapper: '"' | "'" = '"'
): string {
  let escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  if (wrapper === '"') {
    escaped = escaped.replace(/"/g, "&quot;");
  } else {
    escaped = escaped.replace(/'/g, "&apos;");
  }
  return escaped;
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
