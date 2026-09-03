import { isNameChar, isNameStartChar, skipQuoted } from "../utils/helpers";

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
 * Helper to skip comment in counting
 */
function skipCommentInCounting(
  xmlContent: string,
  i: number,
  len: number
): number {
  const close = xmlContent.indexOf("-->", i + 4);
  return close === -1 ? len : close + 3;
}

/**
 * Helper to skip CDATA in counting
 */
function skipCdataInCounting(
  xmlContent: string,
  i: number,
  len: number
): number {
  const close = xmlContent.indexOf("]]>", i + 9);
  return close === -1 ? len : close + 3;
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
      return skipCommentInCounting(xmlContent, i, len);
    }
    if (xmlContent.startsWith("![CDATA[", i + 1)) {
      return skipCdataInCounting(xmlContent, i, len);
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
function parseAndCountTag(options: {
  xmlContent: string;
  i: number;
  len: number;
  target: string;
  lt: number;
  excludeRanges?: Array<{ start: number; end: number }>;
}): { nextPos: number; shouldCount: boolean } {
  const { xmlContent, i, len, target, lt, excludeRanges } = options;
  let j = i;
  if (j < len && isNameStartChar(xmlContent[j])) {
    j += 1;
    while (j < len && isNameChar(xmlContent[j])) {
      j += 1;
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
      k += 1;
      break;
    }
    k += 1;
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

    const result = parseAndCountTag({
      xmlContent,
      i,
      len,
      target,
      lt,
      excludeRanges,
    });
    if (result.shouldCount) {
      if (skipFirstLocal) {
        skipFirstLocal = false;
      } else {
        count += 1;
      }
    }
    i = result.nextPos;
  }

  return count;
}
