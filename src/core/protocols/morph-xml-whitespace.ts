import { WHITESPACE_REGEX } from "../utils/regex-constants";

export function consumeWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && WHITESPACE_REGEX.test(text.charAt(cursor))) {
    cursor += 1;
  }
  return cursor;
}
