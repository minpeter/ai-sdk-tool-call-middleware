import { NAME_CHAR_RE, WHITESPACE_REGEX } from "../utils/regex-constants";

export function findClosingTagEndFlexible(
  text: string,
  contentStart: number,
  toolName: string
): number {
  let pos = contentStart;
  let depth = 1;

  while (pos < text.length) {
    const tok = nextTagToken(text, pos);
    if (tok.kind === "eof") {
      break;
    }
    const result = updateDepthWithToken(tok, toolName, depth);
    ({ depth } = result);
    if (result.closedAt !== undefined) {
      return result.closedAt;
    }
    pos = tok.nextPos;
  }
  return -1;
}

function skipSpecialSegment(text: string, lt: number): number | null {
  const next = text[lt + 1];
  if (next === "!" || next === "?") {
    const gt = text.indexOf(">", lt + 1);
    if (gt !== -1) {
      return gt + 1;
    }
  }
  return null;
}

function consumeClosingTag(
  text: string,
  lt: number
): { matched: boolean; endPos: number } {
  const gt = text.indexOf(">", lt + 1);
  const endPos = gt === -1 ? text.length : gt + 1;
  return { matched: false, endPos };
}

interface TagNameCursor {
  readonly name: string;
  readonly nextPos: number;
  readonly start: number;
}

function readTagName(text: string, start: number): TagNameCursor {
  let nextPos = start;
  while (nextPos < text.length && WHITESPACE_REGEX.test(text[nextPos])) {
    nextPos += 1;
  }
  const nameStart = nextPos;
  while (nextPos < text.length && NAME_CHAR_RE.test(text.charAt(nextPos))) {
    nextPos += 1;
  }
  return {
    name: text.slice(nameStart, nextPos),
    nextPos,
    start: nameStart,
  };
}

function consumeOpenTag(
  text: string,
  lt: number
): { name: string; selfClosing: boolean; nextPos: number } | null {
  const tagName = readTagName(text, lt + 1);
  const q = text.indexOf(">", tagName.nextPos);
  if (q === -1) {
    return null;
  }
  let r = q - 1;
  while (r >= tagName.start && WHITESPACE_REGEX.test(text[r])) {
    r -= 1;
  }
  const selfClosing = text[r] === "/";
  return { name: tagName.name, selfClosing, nextPos: q + 1 };
}

function updateDepthWithToken(
  tok:
    | { kind: "special"; nextPos: number }
    | { kind: "close"; name: string; nextPos: number }
    | { kind: "open"; name: string; selfClosing: boolean; nextPos: number },
  toolName: string,
  depth: number
): { depth: number; closedAt?: number } {
  if (tok.kind === "close" && tok.name === toolName) {
    const newDepth = depth - 1;
    return newDepth === 0
      ? { depth: newDepth, closedAt: tok.nextPos }
      : { depth: newDepth };
  }
  if (tok.kind === "open" && tok.name === toolName && !tok.selfClosing) {
    return { depth: depth + 1 };
  }
  return { depth };
}

export function nextTagToken(
  text: string,
  fromPos: number
):
  | { kind: "eof"; nextPos: number }
  | { kind: "special"; nextPos: number }
  | { kind: "close"; name: string; nextPos: number }
  | { kind: "open"; name: string; selfClosing: boolean; nextPos: number } {
  const lt = text.indexOf("<", fromPos);
  if (lt === -1 || lt + 1 >= text.length) {
    return { kind: "eof", nextPos: text.length };
  }
  const next = text[lt + 1];
  const specialEnd = skipSpecialSegment(text, lt);
  if (specialEnd !== null) {
    return { kind: "special", nextPos: specialEnd };
  }
  if (next === "/") {
    const closing = consumeClosingTag(text, lt);
    const tagName = readTagName(text, lt + 2);
    return { kind: "close", name: tagName.name, nextPos: closing.endPos };
  }
  const open = consumeOpenTag(text, lt);
  if (open === null) {
    return { kind: "eof", nextPos: text.length };
  }
  return {
    kind: "open",
    name: open.name,
    selfClosing: open.selfClosing,
    nextPos: open.nextPos,
  };
}
