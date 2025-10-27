/**
 * Raw content extraction utilities for string-typed properties
 * This replaces the string-based extraction with DOM-based extraction
 */

import type { RXMLNode } from "../core/types";
import {
  isNameChar,
  isNameStartChar,
  parseName,
  skipQuoted,
} from "../utils/helpers";

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
function skipProcessingInstruction(xmlContent: string, i: number, len: number): number {
  const close = xmlContent.indexOf("?>", i + 1);
  return close === -1 ? len : close + 2;
}

/**
 * Helper to skip special XML constructs (comments, CDATA, DOCTYPE, processing instructions)
 * Returns the new position after the construct, or -1 if not a special construct
 */
function skipSpecialConstruct(
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
function parseTagName(
  xmlContent: string,
  i: number,
  len: number
): { name: string; pos: number } {
  let j = i;
  if (j < len && isNameStartChar(xmlContent[j])) {
    j++;
    while (j < len && isNameChar(xmlContent[j])) {
      j++;
    }
  }
  return { name: xmlContent.slice(i, j), pos: j };
}

/**
 * Skip to the end of a tag (finding the closing > or />)
 * Returns { pos: position after >, isSelfClosing: boolean }
 */
function skipToTagEnd(
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
      k++;
      break;
    }
    k++;
  }

  return { pos: k, isSelfClosing };
}

/**
 * Find the matching closing tag for a given opening tag
 * Returns the position of the start of the closing tag, or -1 if not found
 */
function findMatchingCloseTag(
  xmlContent: string,
  startPos: number,
  tagName: string,
  len: number
): number {
  let pos = startPos;
  let depth = 1;

  while (pos < len) {
    const nextLt = xmlContent.indexOf("<", pos);
    if (nextLt === -1) {
      break;
    }
    const nx = nextLt + 1;
    if (nx >= len) {
      break;
    }

    const h = xmlContent[nx];
    const specialPos = skipSpecialConstruct(xmlContent, nx, len);
    if (specialPos !== -1) {
      pos = specialPos;
      continue;
    }

    if (h === "/") {
      // Closing tag
      const tagInfo = parseTagName(xmlContent, nx + 1, len);
      const gt = xmlContent.indexOf(">", tagInfo.pos);
      if (tagInfo.name === tagName) {
        depth--;
        if (depth === 0) {
          return nextLt;
        }
      }
      pos = gt === -1 ? len : gt + 1;
    } else {
      // Opening tag
      const tagInfo = parseTagName(xmlContent, nx, len);
      const tagEndInfo = skipToTagEnd(xmlContent, tagInfo.pos, len);

      if (tagInfo.name === tagName && !tagEndInfo.isSelfClosing) {
        depth++;
      }
      pos =
        xmlContent[tagEndInfo.pos] === ">"
          ? tagEndInfo.pos + 1
          : tagEndInfo.pos + 1;
    }
  }

  return -1;
}

/**
 * Helper to update best match if current depth is better
 */
function updateBestMatch(
  depth: number,
  bestDepth: number,
  contentStart: number,
  contentEnd: number
): { start: number; end: number; depth: number } | null {
  if (depth < bestDepth) {
    return { start: contentStart, end: contentEnd, depth };
  }
  return null;
}

/**
 * Helper to process target tag match
 */
function processTargetTag(
  xmlContent: string,
  tagEnd: number,
  isSelfClosing: boolean,
  target: string,
  len: number,
  depth: number,
  bestDepth: number
): { start: number; end: number; depth: number } | null {
  const contentStart = xmlContent[tagEnd] === ">" ? tagEnd + 1 : tagEnd + 1;

  if (isSelfClosing) {
    return updateBestMatch(depth, bestDepth, contentStart, contentStart);
  }

  const closePos = findMatchingCloseTag(xmlContent, contentStart, target, len);
  if (closePos !== -1) {
    return updateBestMatch(depth, bestDepth, contentStart, closePos);
  }
  return null;
}

/**
 * Extract raw inner content from XML string for a specific tag
 * This is used for string-typed properties to preserve exact content
 */
export function extractRawInner(
  xmlContent: string,
  tagName: string
): string | undefined {
  const len = xmlContent.length;
  const target = tagName;
  let bestStart = -1;
  let bestEnd = -1;
  let bestDepth = Number.POSITIVE_INFINITY;

  let i = 0;
  let depth = 0;

  while (i < len) {
    const lt = xmlContent.indexOf("<", i);
    if (lt === -1) {
      return;
    }
    i = lt + 1;
    if (i >= len) {
      return;
    }

    const ch = xmlContent[i];
    const specialPos = skipSpecialConstruct(xmlContent, i, len);
    if (specialPos !== -1) {
      i = specialPos;
      continue;
    }

    if (ch === "/") {
      const gt = xmlContent.indexOf(">", i + 1);
      i = gt === -1 ? len : gt + 1;
      depth = Math.max(0, depth - 1);
      continue;
    }

    const tagInfo = parseTagName(xmlContent, i, len);
    const tagEndInfo = skipToTagEnd(xmlContent, tagInfo.pos, len);
    const tagEnd = tagEndInfo.pos;
    const isSelfClosing = tagEndInfo.isSelfClosing;

    if (tagInfo.name === target) {
      const match = processTargetTag(
        xmlContent,
        tagEnd,
        isSelfClosing,
        target,
        len,
        depth,
        bestDepth
      );
      if (match) {
        bestStart = match.start;
        bestEnd = match.end;
        bestDepth = match.depth;
      }
    }
    i = xmlContent[tagEnd] === ">" ? tagEnd + 1 : tagEnd + 1;
    depth += isSelfClosing ? 0 : 1;
  }

  if (bestStart !== -1) {
    return xmlContent.slice(bestStart, bestEnd);
  }
  return;
}

/**
 * Helper to process opening tag and add range if it's a target
 */
function processOpeningTag(
  xmlContent: string,
  tagInfo: { name: string; pos: number },
  tagEnd: number,
  isSelfClosing: boolean,
  target: string,
  len: number,
  ranges: Array<{ start: number; end: number }>
): number {
  const contentStart = xmlContent[tagEnd] === ">" ? tagEnd + 1 : tagEnd + 1;

  if (isSelfClosing) {
    ranges.push({ start: contentStart, end: contentStart });
    return contentStart;
  }

  const closePos = findMatchingCloseTag(xmlContent, contentStart, target, len);
  if (closePos !== -1) {
    ranges.push({ start: contentStart, end: closePos });
    const gt = xmlContent.indexOf(">", closePos);
    return gt === -1 ? len : gt + 1;
  }

  // Unmatched tag
  return -1;
}

/**
 * Find all inner content ranges for a given tag name at any depth.
 * Returns ranges for the inner content between <tagName ...> and </tagName>.
 */
export function findAllInnerRanges(
  xmlContent: string,
  tagName: string
): Array<{ start: number; end: number }> {
  const len = xmlContent.length;
  const target = tagName;
  const ranges: Array<{ start: number; end: number }> = [];

  let i = 0;

  while (i < len) {
    const lt = xmlContent.indexOf("<", i);
    if (lt === -1) {
      break;
    }
    i = lt + 1;
    if (i >= len) {
      break;
    }

    const ch = xmlContent[i];
    const specialPos = skipSpecialConstruct(xmlContent, i, len);
    if (specialPos !== -1) {
      i = specialPos;
      continue;
    }

    if (ch === "/") {
      const gt = xmlContent.indexOf(">", i + 1);
      i = gt === -1 ? len : gt + 1;
      continue;
    }

    // Opening tag
    const tagInfo = parseTagName(xmlContent, i, len);
    const tagEndInfo = skipToTagEnd(xmlContent, tagInfo.pos, len);
    const tagEnd = tagEndInfo.pos;
    const isSelfClosing = tagEndInfo.isSelfClosing;

    if (tagInfo.name !== target) {
      // Advance over this tag
      i = xmlContent[tagEnd] === ">" ? tagEnd + 1 : tagEnd + 1;
      continue;
    }

    // Found a target start tag
    const nextPos = processOpeningTag(
      xmlContent,
      tagInfo,
      tagEnd,
      isSelfClosing,
      target,
      len,
      ranges
    );
    if (nextPos === -1) {
      // Unmatched tag, stop to avoid infinite loops
      break;
    }
    i = nextPos;
  }

  return ranges;
}

/**
 * Helper to find range for top-level target tag
 */
function findTopLevelTargetRange(
  xmlContent: string,
  tagEnd: number,
  isSelfClosing: boolean,
  target: string,
  len: number
): { start: number; end: number } | undefined {
  const contentStart = xmlContent[tagEnd] === ">" ? tagEnd + 1 : tagEnd + 1;
  
  if (isSelfClosing) {
    return { start: contentStart, end: contentStart };
  }

  const closePos = findMatchingCloseTag(xmlContent, contentStart, target, len);
  if (closePos !== -1) {
    return { start: contentStart, end: closePos };
  }
  return;
}

/**
 * Find the first top-level range for a tag
 */
export function findFirstTopLevelRange(
  xmlContent: string,
  tagName: string
): { start: number; end: number } | undefined {
  const len = xmlContent.length;
  const target = tagName;

  let i = 0;
  let depth = 0;

  while (i < len) {
    const lt = xmlContent.indexOf("<", i);
    if (lt === -1) {
      return;
    }
    i = lt + 1;
    if (i >= len) {
      return;
    }

    const ch = xmlContent[i];
    const specialPos = skipSpecialConstruct(xmlContent, i, len);
    if (specialPos !== -1) {
      i = specialPos;
      continue;
    }

    if (ch === "/") {
      const gt = xmlContent.indexOf(">", i + 1);
      i = gt === -1 ? len : gt + 1;
      depth = Math.max(0, depth - 1);
      continue;
    }

    const tagInfo = parseTagName(xmlContent, i, len);
    const tagEndInfo = skipToTagEnd(xmlContent, tagInfo.pos, len);
    const tagEnd = tagEndInfo.pos;
    const isSelfClosing = tagEndInfo.isSelfClosing;

    if (depth === 0 && tagInfo.name === target) {
      return findTopLevelTargetRange(
        xmlContent,
        tagEnd,
        isSelfClosing,
        target,
        len
      );
    }
    i = xmlContent[tagEnd] === ">" ? tagEnd + 1 : tagEnd + 1;
    depth += isSelfClosing ? 0 : 1;
  }
  return;
}

/**
 * Helper to check if position is in excluded ranges
 */
function isPositionExcluded(
  pos: number,
  excludeRanges?: Array<{ start: number; end: number }>
): boolean {
  if (!excludeRanges || excludeRanges.length === 0) {
    return false;
  }
  for (const r of excludeRanges) {
    if (pos >= r.start && pos < r.end) {
      return true;
    }
  }
  return false;
}

/**
 * Helper to handle special constructs in counting
 */
function skipSpecialInCounting(
  xmlContent: string,
  ch: string,
  i: number,
  len: number
): number {
  if (ch === "!") {
    if (xmlContent.startsWith("!--", i + 1)) {
      const close = xmlContent.indexOf("-->", i + 4);
      return close === -1 ? len : close + 3;
    }
    if (xmlContent.startsWith("![CDATA[", i + 1)) {
      const close = xmlContent.indexOf("]]>", i + 9);
      return close === -1 ? len : close + 3;
    }
    const gt = xmlContent.indexOf(">", i + 1);
    return gt === -1 ? len : gt + 1;
  }
  if (ch === "?") {
    const close = xmlContent.indexOf("?>", i + 1);
    return close === -1 ? len : close + 2;
  }
  if (ch === "/") {
    const gt = xmlContent.indexOf(">", i + 1);
    return gt === -1 ? len : gt + 1;
  }
  return -1;
}

/**
 * Helper to parse and count opening tag
 */
function parseAndCountTag(
  xmlContent: string,
  i: number,
  len: number,
  target: string,
  lt: number,
  excludeRanges?: Array<{ start: number; end: number }>
): { nextPos: number; shouldCount: boolean } {
  let j = i;
  if (j < len && isNameStartChar(xmlContent[j])) {
    j++;
    while (j < len && isNameChar(xmlContent[j])) {
      j++;
    }
  }
  const name = xmlContent.slice(i, j);
  let k = j;
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
      k++;
      break;
    }
    k++;
  }
  const shouldCount = name === target && !isPositionExcluded(lt, excludeRanges);
  return { nextPos: k + 1, shouldCount };
}

/**
 * Count tag occurrences, excluding specified ranges
 */
export function countTagOccurrences(
  xmlContent: string,
  tagName: string,
  excludeRanges?: Array<{ start: number; end: number }>,
  shouldSkipFirst = true
): number {
  const len = xmlContent.length;
  const target = tagName;

  let i = 0;
  let count = 0;
  let skipFirstLocal = shouldSkipFirst;

  while (i < len) {
    const lt = xmlContent.indexOf("<", i);
    if (lt === -1) {
      break;
    }
    i = lt + 1;
    if (i >= len) {
      break;
    }

    const ch = xmlContent[i];
    const skipPos = skipSpecialInCounting(xmlContent, ch, i, len);
    if (skipPos !== -1) {
      i = skipPos;
      continue;
    }

    const result = parseAndCountTag(xmlContent, i, len, target, lt, excludeRanges);
    if (result.shouldCount) {
      if (skipFirstLocal) {
        skipFirstLocal = false;
      } else {
        count++;
      }
    }
    i = result.nextPos;
  }

  return count;
}

/**
 * Helper to skip attributes and find tag end position
 */
function skipAttributes(xmlContent: string, i: number, len: number): number {
  let k = i;
  while (k < len && xmlContent[k] !== ">") {
    const c = xmlContent[k];
    if (c === '"' || c === "'") {
      k = skipQuoted(xmlContent, k);
      continue;
    }
    if (c === "/" && xmlContent[k + 1] === ">") {
      k++;
      break;
    }
    k++;
  }
  return k;
}

/**
 * Helper to find closing tag for top-level range
 */
function findClosingTagForRange(
  xmlContent: string,
  k: number,
  len: number,
  target: string
): number {
  let closeDepth = 1;
  let j = k + 1;

  while (j < len && closeDepth > 0) {
    const nextLt = xmlContent.indexOf("<", j);
    if (nextLt === -1) {
      break;
    }

    if (xmlContent[nextLt + 1] === "/") {
      const { name: closeName } = parseName(xmlContent, nextLt + 2);
      if (closeName === target) {
        closeDepth--;
      }
    } else if (
      xmlContent[nextLt + 1] !== "!" &&
      xmlContent[nextLt + 1] !== "?"
    ) {
      const { name: openName } = parseName(xmlContent, nextLt + 1);
      if (openName === target) {
        closeDepth++;
      }
    }

    j = xmlContent.indexOf(">", nextLt + 1);
    if (j === -1) {
      break;
    }
    j++;
  }

  return closeDepth === 0 ? j : -1;
}

/**
 * Helper to process top-level target tag
 */
function processTopLevelTarget(
  xmlContent: string,
  tagStart: number,
  k: number,
  len: number,
  target: string,
  ranges: Array<{ start: number; end: number }>
): { newDepth: number } {
  const isSelfClosing =
    xmlContent[k] === "/" || xmlContent.startsWith("/>", k);

  if (isSelfClosing) {
    ranges.push({
      start: tagStart,
      end: k + (xmlContent[k] === "/" ? 2 : 1),
    });
    return { newDepth: 0 };
  }

  const endPos = findClosingTagForRange(xmlContent, k, len, target);
  if (endPos !== -1) {
    ranges.push({ start: tagStart, end: endPos });
  }
  return { newDepth: 0 };
}

/**
 * Helper to handle special constructs for top-level ranges
 */
function handleSpecialConstructs(
  xmlContent: string,
  ch: string,
  i: number,
  len: number
): number {
  if (ch === "!") {
    if (xmlContent.startsWith("!DOCTYPE", i + 1)) {
      const gt = xmlContent.indexOf(">", i + 1);
      return gt === -1 ? len : gt + 1;
    }
    if (xmlContent.startsWith("!--", i + 1)) {
      const close = xmlContent.indexOf("-->", i + 4);
      return close === -1 ? len : close + 3;
    }
    if (xmlContent.startsWith("![CDATA[", i + 1)) {
      const close = xmlContent.indexOf("]]>", i + 9);
      return close === -1 ? len : close + 3;
    }
    const gt = xmlContent.indexOf(">", i + 1);
    return gt === -1 ? len : gt + 1;
  }
  if (ch === "?") {
    const close = xmlContent.indexOf("?>", i + 1);
    return close === -1 ? len : close + 2;
  }
  return -1;
}

/**
 * Find all top-level ranges for a tag (for handling duplicates)
 */
export function findAllTopLevelRanges(
  xmlContent: string,
  tagName: string
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const len = xmlContent.length;
  const target = tagName;
  let i = 0;
  let depth = 0;

  while (i < len) {
    const lt = xmlContent.indexOf("<", i);
    if (lt === -1) {
      break;
    }
    i = lt + 1;
    if (i >= len) {
      break;
    }

    const ch = xmlContent[i];
    const specialPos = handleSpecialConstructs(xmlContent, ch, i, len);
    if (specialPos !== -1) {
      i = specialPos;
      continue;
    }

    if (ch === "/") {
      // Closing tag
      i++;
      const { name: closingName, newPos: closingPos } = parseName(xmlContent, i);
      if (closingName === target) {
        depth--;
      }
      i = xmlContent.indexOf(">", closingPos);
      if (i === -1) {
        break;
      }
      i++;
      continue;
    }

    // Opening tag
    const { name, newPos } = parseName(xmlContent, i);
    i = newPos;

    const k = skipAttributes(xmlContent, i, len);

    if (name === target && depth === 0) {
      depth++;
      const result = processTopLevelTarget(
        xmlContent,
        lt,
        k,
        len,
        target,
        ranges
      );
      depth += result.newDepth;
    }

    i = k + 1;
  }

  return ranges;
}

/**
 * Extract raw content from DOM node
 */
export function extractRawFromNode(node: RXMLNode): string {
  if (node.children.length === 0) {
    return "";
  }
  if (node.children.length === 1 && typeof node.children[0] === "string") {
    return node.children[0];
  }

  // For complex content, concatenate all text nodes
  let result = "";
  for (const child of node.children) {
    if (typeof child === "string") {
      result += child;
    } else {
      result += extractRawFromNode(child);
    }
  }
  return result;
}
