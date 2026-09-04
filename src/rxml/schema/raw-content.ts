import { findMatchingCloseTag, walkXmlOpeningTags } from "./xml-tag-scanner";

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

  walkXmlOpeningTags(xmlContent, (tag) => {
    if (tag.name !== target) {
      return "continue";
    }
    const bestMatch = processTargetTag({
      xmlContent,
      tagEnd: tag.tagEnd,
      isSelfClosing: tag.isSelfClosing,
      target,
      len,
      depth: tag.depth,
      bestDepth,
    });
    if (bestMatch) {
      bestStart = bestMatch.start;
      bestEnd = bestMatch.end;
      bestDepth = bestMatch.depth;
    }
    return "continue";
  });

  if (bestStart !== -1) {
    return xmlContent.slice(bestStart, bestEnd);
  }
}

/**
 * Helper to process opening tag and add range if it's a target
 */
