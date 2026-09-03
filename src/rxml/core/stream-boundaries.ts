const TAG_NAME_REGEX = /^([a-zA-Z_][\w.-]*)/;
const WHITESPACE_REGEX = /\s/;
const SPECIAL_NODE_MARKERS = [
  { start: "<?", end: "?>", isComment: false },
  { start: "<!--", end: "-->", isComment: true },
  { start: "<![CDATA[", end: "]]>", isComment: false },
] as const;

interface TagInfo {
  readonly openTagEnd: number;
  readonly tagName: string;
}

interface TagInfoRead {
  readonly remainder: string;
  readonly tagInfo: TagInfo | null;
}

export function trimToNextTag(
  buffer: string,
  isFlush: boolean
): { readonly found: boolean; readonly remainder: string } {
  const openBracket = buffer.indexOf("<");
  if (openBracket === -1) {
    return { found: false, remainder: isFlush ? "" : buffer };
  }
  return {
    found: true,
    remainder: openBracket > 0 ? buffer.slice(openBracket) : buffer,
  };
}

export function readTagInfo(buffer: string, isFlush: boolean): TagInfoRead {
  const openTagEnd = buffer.indexOf(">");
  if (openTagEnd === -1) {
    return { remainder: isFlush ? "" : buffer, tagInfo: null };
  }
  const nameMatch = buffer.slice(1, openTagEnd).match(TAG_NAME_REGEX);
  if (!nameMatch) {
    return { remainder: buffer.slice(1), tagInfo: null };
  }
  return {
    remainder: buffer,
    tagInfo: { openTagEnd, tagName: nameMatch[1] },
  };
}

export function skipStrayClosingTag(
  buffer: string,
  isFlush: boolean
): string | null {
  if (!buffer.startsWith("</")) {
    return null;
  }
  const closeEnd = buffer.indexOf(">");
  if (closeEnd === -1) {
    return isFlush ? "" : buffer;
  }
  return buffer.slice(closeEnd + 1);
}

interface SpecialNodeRead {
  readonly emittedComment: string | null;
  readonly handled: boolean;
  readonly remainder: string;
}

export function readSpecialNode(
  buffer: string,
  isFlush: boolean,
  keepComments: boolean
): SpecialNodeRead | null {
  const marker = SPECIAL_NODE_MARKERS.find(({ start }) =>
    buffer.startsWith(start)
  );
  if (marker === undefined) {
    return null;
  }

  const endPosition = buffer.indexOf(marker.end);
  if (endPosition === -1) {
    return {
      emittedComment: null,
      handled: false,
      remainder: isFlush ? "" : buffer,
    };
  }
  const consumedEnd = endPosition + marker.end.length;
  return {
    emittedComment:
      marker.isComment && keepComments ? buffer.slice(0, consumedEnd) : null,
    handled: true,
    remainder: buffer.slice(consumedEnd),
  };
}

function findNextOpeningTag(
  buffer: string,
  tagName: string,
  searchStart: number
): number {
  let nextOpen = buffer.indexOf(`<${tagName}`, searchStart);
  while (nextOpen !== -1) {
    const after = buffer[nextOpen + tagName.length + 1];
    if (after === undefined || after === ">" || WHITESPACE_REGEX.test(after)) {
      return nextOpen;
    }
    nextOpen = buffer.indexOf(`<${tagName}`, nextOpen + 1);
  }
  return nextOpen;
}

function advancePastClosingTag(
  buffer: string,
  tagName: string,
  closeStart: number
): number {
  let cursor = closeStart + 2 + tagName.length;
  while (
    cursor < buffer.length &&
    WHITESPACE_REGEX.test(buffer[cursor] ?? "")
  ) {
    cursor += 1;
  }
  return buffer[cursor] === ">" ? cursor + 1 : -1;
}

export function findMatchingClosingTag(
  buffer: string,
  tagName: string,
  openTagEnd: number
): number {
  let depth = 1;
  let searchStart = openTagEnd + 1;

  while (searchStart < buffer.length) {
    const nextOpen = findNextOpeningTag(buffer, tagName, searchStart);
    const nextCloseStart = buffer.indexOf(`</${tagName}`, searchStart);
    if (nextCloseStart === -1) {
      return -1;
    }

    if (nextOpen !== -1 && nextOpen < nextCloseStart) {
      depth += 1;
      searchStart = nextOpen + 1;
      continue;
    }

    depth -= 1;
    const closeAdvance = advancePastClosingTag(buffer, tagName, nextCloseStart);
    if (closeAdvance === -1) {
      return -1;
    }
    searchStart = closeAdvance;
    if (depth === 0) {
      return searchStart;
    }
  }

  return -1;
}
