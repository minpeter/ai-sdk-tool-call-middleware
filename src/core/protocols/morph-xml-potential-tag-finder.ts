import { consumeWhitespace } from "./morph-xml-whitespace";

function isOpenTagPrefix(suffix: string, toolName: string): boolean {
  return `${toolName}>`.startsWith(suffix);
}

function consumeToolNamePrefix(
  text: string,
  index: number,
  toolName: string
): { index: number; done: boolean; valid: boolean } {
  let i = index;
  let nameIndex = 0;

  while (i < text.length && nameIndex < toolName.length) {
    if (text.charAt(i) !== toolName.charAt(nameIndex)) {
      return { index: i, done: false, valid: false };
    }
    i += 1;
    nameIndex += 1;
  }

  return { index: i, done: nameIndex === toolName.length, valid: true };
}

/**
 * Checks if the remainder of text at index is a valid self-closing tag suffix.
 * Returns true if:
 * - text[index] is "/" and we're at the end (incomplete "/")
 * - text[index..] is "/>" at the end of the string
 */
function isSelfClosingSuffixRemainder(text: string, index: number): boolean {
  if (text.charAt(index) !== "/") {
    return false;
  }
  if (index + 1 >= text.length) {
    return true;
  }
  return index + 1 === text.length - 1 && text.charAt(index + 1) === ">";
}

function isSelfClosingTagPrefix(suffix: string, toolName: string): boolean {
  let i = consumeWhitespace(suffix, 0);
  if (i >= suffix.length) {
    return true;
  }

  const nameRemainder = suffix.slice(i);
  if (toolName.startsWith(nameRemainder)) {
    return true;
  }

  const nameResult = consumeToolNamePrefix(suffix, i, toolName);
  if (!nameResult.valid) {
    return false;
  }

  i = nameResult.index;
  if (i >= suffix.length) {
    return true;
  }
  if (!nameResult.done) {
    return false;
  }

  i = consumeWhitespace(suffix, i);
  if (i >= suffix.length) {
    return true;
  }

  return isSelfClosingSuffixRemainder(suffix, i);
}

export function findPotentialToolTagStart(
  buffer: string,
  toolNames: string[]
): number {
  if (toolNames.length === 0 || buffer.length === 0) {
    return -1;
  }

  const lastGt = buffer.lastIndexOf(">");
  const offset = lastGt === -1 ? 0 : lastGt + 1;
  const trailing = buffer.slice(offset);

  for (let i = trailing.length - 1; i >= 0; i -= 1) {
    if (trailing.charAt(i) !== "<") {
      continue;
    }
    const suffix = trailing.slice(i + 1);
    for (const name of toolNames) {
      if (
        isOpenTagPrefix(suffix, name) ||
        isSelfClosingTagPrefix(suffix, name)
      ) {
        return offset + i;
      }
    }
  }

  return -1;
}
