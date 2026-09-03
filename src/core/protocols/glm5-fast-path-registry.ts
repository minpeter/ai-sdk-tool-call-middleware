import type { TCMCoreProtocol } from "./protocol-interface";

export interface Glm5FastPaths {
  isDefinitelyPlainGeneratedText: (text: string) => boolean;
}

type Glm5Parser = TCMCoreProtocol["parseGeneratedText"];

const glm5FastPathRegistrations = new WeakMap<Glm5Parser, Glm5FastPaths>();
const TRIM_END_WHITESPACE = new Set([
  "\u0009",
  "\u000a",
  "\u000b",
  "\u000c",
  "\u000d",
  "\u0020",
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u2001",
  "\u2002",
  "\u2003",
  "\u2004",
  "\u2005",
  "\u2006",
  "\u2007",
  "\u2008",
  "\u2009",
  "\u200a",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
]);

function isTrimEndWhitespace(character: string | undefined): boolean {
  return character !== undefined && TRIM_END_WHITESPACE.has(character);
}

export function isDefinitelyPlainGlm5Text(text: string): boolean {
  // biome-ignore lint/style/useForOf: Indexed primitive-string reads avoid a mutable String.prototype iterator.
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "<" || character === "{" || character === "[") {
      return false;
    }
  }

  let tail = text.length - 1;
  while (tail >= 0 && isTrimEndWhitespace(text[tail])) {
    tail -= 1;
  }
  if (tail < 0) {
    return false;
  }
  if (text[tail] === ";") {
    tail -= 1;
    while (tail >= 0 && isTrimEndWhitespace(text[tail])) {
      tail -= 1;
    }
  }
  return text[tail] !== ")";
}

/**
 * Register the closed-over built-in parser without retaining its protocol
 * object. The function owns its GLM options and does not depend on `this`, so
 * an unchanged borrowed method has the same parsing semantics.
 */
export function registerGlm5FastPaths(
  parser: Glm5Parser,
  fastPaths: Glm5FastPaths
): void {
  if (!glm5FastPathRegistrations.has(parser)) {
    glm5FastPathRegistrations.set(parser, Object.freeze({ ...fastPaths }));
  }
}

/** Look up only an already-evaluated parser value; getters stay caller-owned. */
export function glm5FastPathsForParser(
  parser: Glm5Parser
): Glm5FastPaths | undefined {
  return glm5FastPathRegistrations.get(parser);
}
