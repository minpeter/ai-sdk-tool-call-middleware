import { startsRjsonComment } from "./hermes-call-boundary";

const LINE_END_RE = /[\n\r]/;
const QUOTE_RE = /^["']$/;
const WHITESPACE_CHAR_RE = /\s/;

export interface JsonQuotedScanState {
  escaping: boolean;
  quoteChar: string | null;
}

export function consumeJsonQuotedScanChar(
  state: JsonQuotedScanState,
  char: string
): boolean {
  if (state.quoteChar === null) {
    return false;
  }
  if (state.escaping) {
    state.escaping = false;
  } else if (char === "\\") {
    state.escaping = true;
  } else if (char === state.quoteChar) {
    state.quoteChar = null;
  }
  return true;
}

export function findQuotedKeyEnd(
  text: string,
  keyStart: number,
  quote: string
): number | null {
  const state: JsonQuotedScanState = { escaping: false, quoteChar: quote };
  for (let index = keyStart + 1; index < text.length; index += 1) {
    consumeJsonQuotedScanChar(state, text.charAt(index));
    if (state.quoteChar === null) {
      return index;
    }
  }
  return null;
}

export function skipJsonComment(text: string, index: number): number | null {
  if (text.charAt(index) !== "/") {
    return null;
  }
  const next = text.charAt(index + 1);
  if (next === "/") {
    const relativeEnd = text.slice(index + 2).search(LINE_END_RE);
    return relativeEnd === -1 ? text.length - 1 : index + relativeEnd + 1;
  }
  if (next === "*") {
    const end = text.indexOf("*/", index + 2);
    return end === -1 ? text.length - 1 : end + 1;
  }
  return null;
}

export function collectPreviousSignificantChars(text: string): string[] {
  const previousByIndex = new Array<string>(text.length + 1);
  let previous = "";

  for (let cursor = 0; cursor < text.length; cursor += 1) {
    previousByIndex[cursor] = previous;
    const char = text.charAt(cursor);
    if (WHITESPACE_CHAR_RE.test(char)) {
      continue;
    }
    if (QUOTE_RE.test(char)) {
      const quoteEnd = findQuotedKeyEnd(text, cursor, char);
      const end = quoteEnd ?? text.length - 1;
      for (let skipped = cursor + 1; skipped <= end; skipped += 1) {
        previousByIndex[skipped] = previous;
      }
      if (quoteEnd === null) {
        break;
      }
      previous = char;
      cursor = quoteEnd;
      continue;
    }
    const commentEnd = startsRjsonComment(text, cursor)
      ? skipJsonComment(text, cursor)
      : null;
    if (commentEnd === null) {
      previous = char;
      continue;
    }
    for (let skipped = cursor + 1; skipped <= commentEnd; skipped += 1) {
      previousByIndex[skipped] = previous;
    }
    cursor = commentEnd;
  }
  previousByIndex[text.length] = previous;
  return previousByIndex;
}
