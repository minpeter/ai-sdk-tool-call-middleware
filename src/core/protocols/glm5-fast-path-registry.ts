import type { TCMCoreProtocol } from "./protocol-interface";

export interface Glm5FastPaths {
  isDefinitelyPlainGeneratedText: (text: string) => boolean;
}

type Glm5Parser = TCMCoreProtocol["parseGeneratedText"];

const glm5FastPathRegistrations = new WeakMap<Glm5Parser, Glm5FastPaths>();

function isTrimEndWhitespace(character: string | undefined): boolean {
  switch (character) {
    case "\u0009":
    case "\u000a":
    case "\u000b":
    case "\u000c":
    case "\u000d":
    case "\u0020":
    case "\u00a0":
    case "\u1680":
    case "\u2000":
    case "\u2001":
    case "\u2002":
    case "\u2003":
    case "\u2004":
    case "\u2005":
    case "\u2006":
    case "\u2007":
    case "\u2008":
    case "\u2009":
    case "\u200a":
    case "\u2028":
    case "\u2029":
    case "\u202f":
    case "\u205f":
    case "\u3000":
    case "\ufeff":
      return true;
    default:
      return false;
  }
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
  parser: unknown
): Glm5FastPaths | undefined {
  return typeof parser === "function"
    ? glm5FastPathRegistrations.get(parser as Glm5Parser)
    : undefined;
}
