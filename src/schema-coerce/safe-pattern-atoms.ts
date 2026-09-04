interface RegexAtomRead {
  readonly atom: string | null;
  readonly end: number;
  readonly resetPrevious: boolean;
}

const REGEX_ATOM_CHAR_RE = /^[A-Za-z0-9_$-]$/;
const QUANTIFIER_PART_RE = /^[0-9,]$/;

export function findQuantifierEnd(
  pattern: string,
  index: number
): number | null {
  const char = pattern.charAt(index);
  if (char === "*" || char === "+" || char === "?") {
    return index;
  }
  if (char !== "{") {
    return null;
  }
  let cursor = index + 1;
  while (cursor < pattern.length && pattern.charAt(cursor) !== "}") {
    const part = pattern.charAt(cursor);
    if (!QUANTIFIER_PART_RE.test(part)) {
      return null;
    }
    cursor += 1;
  }
  return cursor < pattern.length ? cursor : null;
}

function escapedCharacterEnd(pattern: string, index: number): number | null {
  return pattern.charAt(index) === "\\"
    ? Math.min(index + 1, pattern.length - 1)
    : null;
}

function findCharClassEnd(pattern: string, start: number): number | null {
  for (let index = start + 1; index < pattern.length; index += 1) {
    const escapedEnd = escapedCharacterEnd(pattern, index);
    if (escapedEnd !== null) {
      index = escapedEnd;
      continue;
    }
    if (pattern.charAt(index) === "]") {
      return index;
    }
  }
  return null;
}

function findGroupEnd(pattern: string, start: number): number | null {
  let inCharClass = false;
  let depth = 0;
  for (let index = start; index < pattern.length; index += 1) {
    const escapedEnd = escapedCharacterEnd(pattern, index);
    if (escapedEnd !== null) {
      index = escapedEnd;
      continue;
    }
    const char = pattern.charAt(index);
    if (char === "[" && !inCharClass) {
      inCharClass = true;
      continue;
    }
    if (char === "]" && inCharClass) {
      inCharClass = false;
      continue;
    }
    if (inCharClass) {
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return null;
}

function readRegexAtom(pattern: string, index: number): RegexAtomRead | null {
  const char = pattern.charAt(index);
  if (char === "\\") {
    return {
      atom: pattern.slice(index, Math.min(index + 2, pattern.length)),
      end: index + 1,
      resetPrevious: false,
    };
  }
  if (char === "[") {
    const classEnd = findCharClassEnd(pattern, index);
    return classEnd == null
      ? null
      : {
          atom: pattern.slice(index, classEnd + 1),
          end: classEnd,
          resetPrevious: false,
        };
  }
  if (char === "(") {
    const groupEnd = findGroupEnd(pattern, index);
    if (groupEnd == null) {
      return null;
    }
    return {
      atom: null,
      end: findQuantifierEnd(pattern, groupEnd + 1) ?? groupEnd,
      resetPrevious: true,
    };
  }
  return char === "." || REGEX_ATOM_CHAR_RE.test(char)
    ? { atom: char, end: index, resetPrevious: false }
    : { atom: null, end: index, resetPrevious: true };
}

export function hasAdjacentRepeatedQuantifiedAtoms(pattern: string): boolean {
  let previousQuantifiedAtom: string | null = null;
  for (let index = 0; index < pattern.length; index += 1) {
    const read = readRegexAtom(pattern, index);
    if (read === null) {
      return false;
    }
    if (read.resetPrevious) {
      previousQuantifiedAtom = null;
      index = read.end;
      continue;
    }
    const end = findQuantifierEnd(pattern, read.end + 1);
    if (read.atom && end != null) {
      if (previousQuantifiedAtom === read.atom) {
        return true;
      }
      previousQuantifiedAtom = read.atom;
      index = end;
      continue;
    }
    previousQuantifiedAtom = null;
    index = read.end;
  }
  return false;
}
