/**
 * Raw content extraction utilities for string-typed properties.
 */

import {
  findMatchingCloseTag,
  parseTagName,
  skipSpecialConstruct,
  skipToTagEnd,
} from "./tag-navigation";

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

function processTargetTag(options: {
  xmlContent: string;
  tagEnd: number;
  isSelfClosing: boolean;
  target: string;
  len: number;
  depth: number;
  bestDepth: number;
}): { start: number; end: number; depth: number } | null {
  const { xmlContent, tagEnd, isSelfClosing, target, len, depth, bestDepth } =
    options;
  const contentStart = tagEnd + 1;

  if (isSelfClosing) {
    return updateBestMatch(depth, bestDepth, contentStart, contentStart);
  }

  const closePos = findMatchingCloseTag(xmlContent, contentStart, target, len);
  if (closePos !== -1) {
    return updateBestMatch(depth, bestDepth, contentStart, closePos);
  }
  return null;
}

function handleClosingTagWithDepth(
  xmlContent: string,
  i: number,
  len: number,
  depth: number
): { newPos: number; newDepth: number } {
  const gt = xmlContent.indexOf(">", i + 1);
  return {
    newPos: gt === -1 ? len : gt + 1,
    newDepth: Math.max(0, depth - 1),
  };
}

function processOpeningTagInExtract(options: {
  xmlContent: string;
  i: number;
  len: number;
  target: string;
  depth: number;
  bestDepth: number;
}): {
  newPos: number;
  newDepth: number;
  bestMatch: { start: number; end: number; depth: number } | null;
} {
  const { xmlContent, i, len, target, depth, bestDepth } = options;
  const tagInfo = parseTagName(xmlContent, i, len);
  const tagEndInfo = skipToTagEnd(xmlContent, tagInfo.pos, len);
  const tagEnd = tagEndInfo.pos;
  const { isSelfClosing } = tagEndInfo;

  let bestMatch: { start: number; end: number; depth: number } | null = null;
  if (tagInfo.name === target) {
    bestMatch = processTargetTag({
      xmlContent,
      tagEnd,
      isSelfClosing,
      target,
      len,
      depth,
      bestDepth,
    });
  }

  return {
    newPos: tagEnd + 1,
    newDepth: depth + (isSelfClosing ? 0 : 1),
    bestMatch,
  };
}

/**
 * Extract raw inner content from XML string for a specific tag.
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
    if (lt === -1 || lt + 1 >= len) {
      return;
    }
    i = lt + 1;

    const ch = xmlContent[i];
    const specialPos = skipSpecialConstruct(xmlContent, i, len);
    if (specialPos !== -1) {
      i = specialPos;
      continue;
    }

    if (ch === "/") {
      const result = handleClosingTagWithDepth(xmlContent, i, len, depth);
      i = result.newPos;
      depth = result.newDepth;
      continue;
    }

    const result = processOpeningTagInExtract({
      xmlContent,
      i,
      len,
      target,
      depth,
      bestDepth,
    });
    if (result.bestMatch) {
      bestStart = result.bestMatch.start;
      bestEnd = result.bestMatch.end;
      bestDepth = result.bestMatch.depth;
    }
    i = result.newPos;
    depth = result.newDepth;
  }

  if (bestStart !== -1) {
    return xmlContent.slice(bestStart, bestEnd);
  }
}

function processOpeningTag(options: {
  xmlContent: string;
  tagEnd: number;
  isSelfClosing: boolean;
  target: string;
  len: number;
  ranges: Array<{ start: number; end: number }>;
}): number {
  const { xmlContent, tagEnd, isSelfClosing, target, len, ranges } = options;
  const contentStart = tagEnd + 1;

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

  return -1;
}

/**
 * Find all inner content ranges for a given tag name at any depth.
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
    if (lt === -1 || lt + 1 >= len) {
      break;
    }
    i = lt + 1;

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

    const tagInfo = parseTagName(xmlContent, i, len);
    const tagEndInfo = skipToTagEnd(xmlContent, tagInfo.pos, len);
    const tagEnd = tagEndInfo.pos;
    const { isSelfClosing } = tagEndInfo;

    if (tagInfo.name !== target) {
      i = tagEnd + 1;
      continue;
    }

    const nextPos = processOpeningTag({
      xmlContent,
      tagEnd,
      isSelfClosing,
      target,
      len,
      ranges,
    });
    if (nextPos === -1) {
      break;
    }
    i = nextPos;
  }

  return ranges;
}

function findTopLevelTargetRange(options: {
  xmlContent: string;
  tagEnd: number;
  isSelfClosing: boolean;
  target: string;
  len: number;
}): { start: number; end: number } | undefined {
  const { xmlContent, tagEnd, isSelfClosing, target, len } = options;
  const contentStart = tagEnd + 1;

  if (isSelfClosing) {
    return { start: contentStart, end: contentStart };
  }

  const closePos = findMatchingCloseTag(xmlContent, contentStart, target, len);
  if (closePos !== -1) {
    return { start: contentStart, end: closePos };
  }
}

/**
 * Find the first top-level range for a tag.
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
    if (lt === -1 || lt + 1 >= len) {
      return;
    }
    i = lt + 1;

    const ch = xmlContent[i];
    const specialPos = skipSpecialConstruct(xmlContent, i, len);
    if (specialPos !== -1) {
      i = specialPos;
      continue;
    }

    if (ch === "/") {
      const result = handleClosingTagWithDepth(xmlContent, i, len, depth);
      i = result.newPos;
      depth = result.newDepth;
      continue;
    }

    const tagInfo = parseTagName(xmlContent, i, len);
    const tagEndInfo = skipToTagEnd(xmlContent, tagInfo.pos, len);
    const tagEnd = tagEndInfo.pos;
    const { isSelfClosing } = tagEndInfo;

    if (depth === 0 && tagInfo.name === target) {
      return findTopLevelTargetRange({
        xmlContent,
        tagEnd,
        isSelfClosing,
        target,
        len,
      });
    }
    i = tagEnd + 1;
    depth += isSelfClosing ? 0 : 1;
  }
}

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
 * Count tag occurrences, excluding specified ranges.
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

    const tagInfo = parseTagName(xmlContent, i, len);
    const tagEndInfo = skipToTagEnd(xmlContent, tagInfo.pos, len);
    if (tagInfo.name === target && !isPositionExcluded(lt, excludeRanges)) {
      if (skipFirstLocal) {
        skipFirstLocal = false;
      } else {
        count += 1;
      }
    }
    i = tagEndInfo.pos + 1;
  }

  return count;
}
