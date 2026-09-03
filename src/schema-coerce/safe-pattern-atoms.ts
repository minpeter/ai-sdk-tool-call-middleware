interface RegexAtomRead {
  readonly atom: string | null;
  readonly end: number;
  readonly resetPrevious: boolean;
}

const REGEX_ATOM_CHAR_RE = /^[A-Za-z0-9_$-]$/;

function quantifierEnd(pattern: string, index: number): number | null {
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
    if (!(part === "," || (part >= "0" && part <= "9"))) {
      return null;
    }
    cursor += 1;
  }
  return cursor < pattern.length ? cursor : null;
}

function findCharClassEnd(pattern: string, start: number): number | null {
  let escaped = false;
  for (let index = start + 1; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "]") {
      return index;
    }
  }
  return null;
}

function findGroupEnd(pattern: string, start: number): number | null {
  let escaped = false;
  let inCharClass = false;
  let depth = 0;
  for (let index = start; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
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
      end: quantifierEnd(pattern, groupEnd + 1) ?? groupEnd,
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
    const end = quantifierEnd(pattern, read.end + 1);
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
