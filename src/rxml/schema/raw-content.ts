import {
  findMatchingCloseTag,
  parseTagName,
  skipSpecialConstruct,
  skipToTagEnd,
} from "./xml-tag-scanner";

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

/**
 * Helper to handle closing tag in extractRawInner
 */
function handleClosingTagInExtract(
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

/**
 * Helper to process opening tag in extractRawInner
 */
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
      const result = handleClosingTagInExtract(xmlContent, i, len, depth);
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

/**
 * Helper to process opening tag and add range if it's a target
 */
