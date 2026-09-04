import { findMatchingCloseTag, walkXmlOpeningTags } from "./xml-tag-scanner";

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

  walkXmlOpeningTags(xmlContent, (tag) => {
    if (tag.name !== target) {
      return "continue";
    }
    const nextPosition = processOpeningTag({
      xmlContent,
      tagEnd: tag.tagEnd,
      isSelfClosing: tag.isSelfClosing,
      target,
      len,
      ranges,
    });
    return nextPosition === -1 ? "stop" : nextPosition;
  });

  return ranges;
}

/**
 * Helper to find range for top-level target tag
 */
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
 * Find the first top-level range for a tag
 */
export function findFirstTopLevelRange(
  xmlContent: string,
  tagName: string
): { start: number; end: number } | undefined {
  const len = xmlContent.length;
  const target = tagName;

  let range: { start: number; end: number } | undefined;
  walkXmlOpeningTags(xmlContent, (tag) => {
    if (tag.depth !== 0 || tag.name !== target) {
      return "continue";
    }
    range = findTopLevelTargetRange({
      xmlContent,
      tagEnd: tag.tagEnd,
      isSelfClosing: tag.isSelfClosing,
      target,
      len,
    });
    return "stop";
  });
  return range;
}

/**
 * Helper to check if position is in excluded ranges
 */
