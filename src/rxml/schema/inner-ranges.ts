import {
  findMatchingCloseTag,
  parseTagName,
  skipSpecialConstruct,
  skipToTagEnd,
} from "./xml-tag-scanner";

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
 * Helper to handle closing tag in findAllInnerRanges
 */
function handleClosingTagInFindAll(
  xmlContent: string,
  i: number,
  len: number
): number {
  const gt = xmlContent.indexOf(">", i + 1);
  return gt === -1 ? len : gt + 1;
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
      i = handleClosingTagInFindAll(xmlContent, i, len);
      continue;
    }

    // Opening tag
    const tagInfo = parseTagName(xmlContent, i, len);
    const tagEndInfo = skipToTagEnd(xmlContent, tagInfo.pos, len);
    const tagEnd = tagEndInfo.pos;
    const { isSelfClosing } = tagEndInfo;

    if (tagInfo.name !== target) {
      // Advance over this tag
      i = tagEnd + 1;
      continue;
    }

    // Found a target start tag
    const nextPos = processOpeningTag({
      xmlContent,
      tagEnd,
      isSelfClosing,
      target,
      len,
      ranges,
    });
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
 * Helper to handle closing tag in findFirstTopLevelRange
 */
function handleClosingTagInFindFirst(
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
      const result = handleClosingTagInFindFirst(xmlContent, i, len, depth);
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

/**
 * Helper to check if position is in excluded ranges
 */
