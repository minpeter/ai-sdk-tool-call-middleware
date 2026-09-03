/**
 * Raw content extraction utilities for string-typed properties
 * This replaces the string-based extraction with DOM-based extraction
 */

import { isNameChar, isNameStartChar, skipQuoted } from "../utils/helpers";

/**
 * Helper to skip DOCTYPE declarations
 */
function skipDoctype(xmlContent: string, i: number, len: number): number {
  const gt = xmlContent.indexOf(">", i + 1);
  return gt === -1 ? len : gt + 1;
}

/**
 * Helper to skip comments
 */
function skipComment(xmlContent: string, i: number, len: number): number {
  const close = xmlContent.indexOf("-->", i + 4);
  return close === -1 ? len : close + 3;
}

/**
 * Helper to skip CDATA sections
 */
function skipCdata(xmlContent: string, i: number, len: number): number {
  const close = xmlContent.indexOf("]]>", i + 9);
  return close === -1 ? len : close + 3;
}

/**
 * Helper to skip processing instructions
 */
function skipProcessingInstruction(
  xmlContent: string,
  i: number,
  len: number
): number {
  const close = xmlContent.indexOf("?>", i + 1);
  return close === -1 ? len : close + 2;
}

/**
 * Helper to skip special XML constructs (comments, CDATA, DOCTYPE, processing instructions)
 * Returns the new position after the construct, or -1 if not a special construct
 */
export function skipSpecialConstruct(
  xmlContent: string,
  i: number,
  len: number
): number {
  const ch = xmlContent[i];

  if (ch === "!") {
    if (xmlContent.startsWith("!DOCTYPE", i + 1)) {
      return skipDoctype(xmlContent, i, len);
    }
    if (xmlContent.startsWith("!--", i + 1)) {
      return skipComment(xmlContent, i, len);
    }
    if (xmlContent.startsWith("![CDATA[", i + 1)) {
      return skipCdata(xmlContent, i, len);
    }
    // Other declarations
    const gt = xmlContent.indexOf(">", i + 1);
    return gt === -1 ? len : gt + 1;
  }

  if (ch === "?") {
    return skipProcessingInstruction(xmlContent, i, len);
  }

  return -1;
}

/**
 * Parse tag name starting at position i
 * Returns the tag name and position after the name
 */
export function parseTagName(
  xmlContent: string,
  i: number,
  len: number
): { name: string; pos: number } {
  let j = i;
  if (j < len && isNameStartChar(xmlContent[j])) {
    j += 1;
    while (j < len && isNameChar(xmlContent[j])) {
      j += 1;
    }
  }
  return { name: xmlContent.slice(i, j), pos: j };
}

/**
 * Skip to the end of a tag (finding the closing > or />)
 * Returns { pos: position after >, isSelfClosing: boolean }
 */
export function skipToTagEnd(
  xmlContent: string,
  start: number,
  len: number
): { pos: number; isSelfClosing: boolean } {
  let k = start;
  let isSelfClosing = false;

  while (k < len) {
    const c = xmlContent[k];
    if (c === '"' || c === "'") {
      k = skipQuoted(xmlContent, k);
      continue;
    }
    if (c === ">") {
      break;
    }
    if (c === "/" && xmlContent[k + 1] === ">") {
      isSelfClosing = true;
      k += 1;
      break;
    }
    k += 1;
  }

  return { pos: k, isSelfClosing };
}

/**
 * Helper to process closing tag in findMatchingCloseTag
 */
function processClosingTagMatch(options: {
  xmlContent: string;
  nx: number;
  len: number;
  tagName: string;
  depth: number;
  nextLt: number;
}): { newPos: number; newDepth: number; found: boolean } {
  const { xmlContent, nx, len, tagName, depth, nextLt } = options;
  const tagInfo = parseTagName(xmlContent, nx + 1, len);
  const gt = xmlContent.indexOf(">", tagInfo.pos);

  if (tagInfo.name === tagName) {
    const newDepth = depth - 1;
    if (newDepth === 0) {
      return { newPos: nextLt, newDepth, found: true };
    }
    return { newPos: gt === -1 ? len : gt + 1, newDepth, found: false };
  }

  return { newPos: gt === -1 ? len : gt + 1, newDepth: depth, found: false };
}

/**
 * Helper to process opening tag in findMatchingCloseTag
 */
function processOpeningTagMatch(options: {
  xmlContent: string;
  nx: number;
  len: number;
  tagName: string;
  depth: number;
}): { newPos: number; newDepth: number } {
  const { xmlContent, nx, len, tagName, depth } = options;
  const tagInfo = parseTagName(xmlContent, nx, len);
  const tagEndInfo = skipToTagEnd(xmlContent, tagInfo.pos, len);

  const newDepth =
    tagInfo.name === tagName && !tagEndInfo.isSelfClosing ? depth + 1 : depth;

  const newPos =
    xmlContent[tagEndInfo.pos] === ">"
      ? tagEndInfo.pos + 1
      : tagEndInfo.pos + 1;

  return { newPos, newDepth };
}

/**
 * Find the matching closing tag for a given opening tag
 * Returns the position of the start of the closing tag, or -1 if not found
 */
export function findMatchingCloseTag(
  xmlContent: string,
  startPos: number,
  tagName: string,
  len: number
): number {
  let pos = startPos;
  let depth = 1;

  while (pos < len) {
    const nextLt = xmlContent.indexOf("<", pos);
    if (nextLt === -1 || nextLt + 1 >= len) {
      break;
    }

    const nx = nextLt + 1;
    const h = xmlContent[nx];
    const specialPos = skipSpecialConstruct(xmlContent, nx, len);

    if (specialPos !== -1) {
      pos = specialPos;
      continue;
    }

    if (h === "/") {
      const result = processClosingTagMatch({
        xmlContent,
        nx,
        len,
        tagName,
        depth,
        nextLt,
      });
      if (result.found) {
        return result.newPos;
      }
      pos = result.newPos;
      depth = result.newDepth;
    } else {
      const result = processOpeningTagMatch({
        xmlContent,
        nx,
        len,
        tagName,
        depth,
      });
      pos = result.newPos;
      depth = result.newDepth;
    }
  }

  return -1;
}

/**
 * Helper to update best match if current depth is better
 */
