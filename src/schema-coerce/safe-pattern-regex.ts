const REGEX_BACKREFERENCE_REGEX = /\\(?:[1-9]|k<)/;
const MAX_PATTERN_PROPERTY_REGEX_LENGTH = 128;

interface RegexGroupState {
  hasAlternation: boolean;
  hasQuantifier: boolean;
}

interface RegexRiskScanState {
  escaped: boolean;
  groups: RegexGroupState[];
  inCharClass: boolean;
}

interface RegexAtomRead {
  atom: string | null;
  end: number;
  resetPrevious: boolean;
}

const REGEX_ATOM_CHAR_RE = /^[A-Za-z0-9_$-]$/;

function regexQuantifierEnd(pattern: string, index: number): number | null {
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

function regexGroupPrefixEnd(
  pattern: string,
  groupStart: number
): number | null {
  if (pattern.charAt(groupStart + 1) !== "?") {
    return null;
  }
  const prefix = pattern.charAt(groupStart + 2);
  if (prefix === ":" || prefix === "=" || prefix === "!") {
    return groupStart + 2;
  }
  if (prefix !== "<") {
    return null;
  }
  const lookbehindPrefix = pattern.charAt(groupStart + 3);
  if (lookbehindPrefix === "=" || lookbehindPrefix === "!") {
    return groupStart + 3;
  }
  const nameEnd = pattern.indexOf(">", groupStart + 3);
  return nameEnd === -1 ? null : nameEnd;
}

function consumeRegexEscapeOrClassState(
  state: RegexRiskScanState,
  char: string
): boolean {
  if (state.escaped) {
    state.escaped = false;
    return true;
  }
  if (char === "\\") {
    state.escaped = true;
    return true;
  }
  if (char === "[" && !state.inCharClass) {
    state.inCharClass = true;
    return true;
  }
  if (char === "]" && state.inCharClass) {
    state.inCharClass = false;
    return true;
  }
  return state.inCharClass;
}

function openRegexGroup(
  pattern: string,
  index: number,
  groups: RegexGroupState[]
): number {
  groups.push({ hasAlternation: false, hasQuantifier: false });
  return regexGroupPrefixEnd(pattern, index) ?? index;
}

function markParentGroupQuantified(groups: RegexGroupState[]) {
  const parentGroup = groups.at(-1);
  if (parentGroup) {
    parentGroup.hasQuantifier = true;
  }
}

function closeRegexGroup(
  pattern: string,
  index: number,
  groups: RegexGroupState[]
): { nextIndex: number; risk: boolean } {
  const group = groups.pop();
  const quantifierEnd = regexQuantifierEnd(pattern, index + 1);
  if (!(group && quantifierEnd != null)) {
    return { nextIndex: index, risk: false };
  }
  if (group.hasAlternation || group.hasQuantifier) {
    return { nextIndex: index, risk: true };
  }
  markParentGroupQuantified(groups);
  return { nextIndex: quantifierEnd, risk: false };
}

function markRegexQuantifier(
  pattern: string,
  index: number,
  groups: RegexGroupState[]
): number | null {
  const quantifierEnd = regexQuantifierEnd(pattern, index);
  if (quantifierEnd == null) {
    return null;
  }
  markParentGroupQuantified(groups);
  return quantifierEnd;
}

function hasNestedQuantifierRisk(pattern: string): boolean {
  const state: RegexRiskScanState = {
    escaped: false,
    groups: [],
    inCharClass: false,
  };

  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern.charAt(index);
    if (consumeRegexEscapeOrClassState(state, ch)) {
      continue;
    }
    if (ch === "(") {
      index = openRegexGroup(pattern, index, state.groups);
      continue;
    }
    if (ch === ")" && state.groups.length > 0) {
      const closed = closeRegexGroup(pattern, index, state.groups);
      if (closed.risk) {
        return true;
      }
      index = closed.nextIndex;
      continue;
    }
    const currentGroup = state.groups.at(-1);
    if (ch === "|" && currentGroup) {
      currentGroup.hasAlternation = true;
      continue;
    }
    const quantifierEnd = markRegexQuantifier(pattern, index, state.groups);
    if (quantifierEnd != null) {
      index = quantifierEnd;
    }
  }
  return false;
}

function findCharClassEnd(pattern: string, start: number): number | null {
  let escaped = false;
  for (let index = start + 1; index < pattern.length; index += 1) {
    const ch = pattern.charAt(index);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "]") {
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
    const ch = pattern.charAt(index);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "[" && !inCharClass) {
      inCharClass = true;
      continue;
    }
    if (ch === "]" && inCharClass) {
      inCharClass = false;
      continue;
    }
    if (inCharClass) {
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
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
      end: regexQuantifierEnd(pattern, groupEnd + 1) ?? groupEnd,
      resetPrevious: true,
    };
  }
  return char === "." || REGEX_ATOM_CHAR_RE.test(char)
    ? { atom: char, end: index, resetPrevious: false }
    : { atom: null, end: index, resetPrevious: true };
}

function hasAdjacentRepeatedQuantifiedAtoms(pattern: string): boolean {
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

    const quantifierEnd = regexQuantifierEnd(pattern, read.end + 1);
    if (read.atom && quantifierEnd != null) {
      if (previousQuantifiedAtom === read.atom) {
        return true;
      }
      previousQuantifiedAtom = read.atom;
      index = quantifierEnd;
      continue;
    }

    previousQuantifiedAtom = null;
    index = read.end;
  }

  return false;
}

export function compileSafePatternPropertyRegex(
  pattern: string
): RegExp | null {
  if (
    pattern.length > MAX_PATTERN_PROPERTY_REGEX_LENGTH ||
    REGEX_BACKREFERENCE_REGEX.test(pattern) ||
    hasNestedQuantifierRisk(pattern) ||
    hasAdjacentRepeatedQuantifiedAtoms(pattern)
  ) {
    return null;
  }
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * Gets all schemas from patternProperties that match the given key.
 *
 * @param patternProperties - The patternProperties object from a JSON Schema
 * @param key - The property key to match against patterns
 * @returns Array of schemas whose patterns match the key
 *
 * @remarks
 * **Security consideration**: This function executes regex patterns from the schema.
 * In typical usage (AI SDK tool parsing), schemas come from trusted application code.
 * However, if schemas can originate from untrusted sources, be aware of potential
 * ReDoS (Regular Expression Denial of Service) with malicious patterns like `(a+)+$`.
 * Consider adding regex timeout or safe-regex validation if processing untrusted schemas.
 */

export function getPatternSchemasForKey(
  patternProperties: unknown,
  key: string
): unknown[] {
  if (
    !patternProperties ||
    typeof patternProperties !== "object" ||
    Array.isArray(patternProperties)
  ) {
    return [];
  }
  const schemas: unknown[] = [];
  for (const [pattern, schema] of Object.entries(
    patternProperties as Record<string, unknown>
  )) {
    const regex = compileSafePatternPropertyRegex(pattern);
    if (regex?.test(key)) {
      schemas.push(schema);
    }
  }
  return schemas;
}
