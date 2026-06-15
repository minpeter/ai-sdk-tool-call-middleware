interface CharacterClassRange {
  end: string;
  start: string;
}

interface PatternCharacterHints {
  hasUnknownMatcher: boolean;
  literalRuns: string[];
  literals: Set<string>;
  ranges: CharacterClassRange[];
}

const COMPARABLE_KEY_CHAR_RE = /^[A-Za-z0-9_-]$/;
const HEX_BYTE_RE = /^[\da-fA-F]{2}$/;
const HEX_WORD_RE = /^[\da-fA-F]{4}$/;

function isComparableKeyChar(char: string): boolean {
  return COMPARABLE_KEY_CHAR_RE.test(char);
}

function pushCharacterClassRange(
  ranges: CharacterClassRange[],
  start: string,
  end: string
) {
  if (start.length === 1 && end.length === 1) {
    ranges.push({ start, end });
  }
}

function pushLiteralRun(hints: PatternCharacterHints, run: string): string {
  if (run.length > 0) {
    hints.literalRuns.push(run);
  }
  return "";
}

function addLiteralHint(hints: PatternCharacterHints, char: string): boolean {
  if (!isComparableKeyChar(char)) {
    return false;
  }
  hints.literals.add(char);
  return true;
}

function readCharacterClassRangeEnd(
  pattern: string,
  index: number
): { char: string; nextIndex: number; unknown: boolean } | null {
  const char = pattern.charAt(index);
  if (char !== "\\") {
    return { char, nextIndex: index, unknown: false };
  }

  const escaped = pattern.charAt(index + 1);
  const literal = readEscapedLiteral(pattern, index + 1);
  if (literal) {
    return { char: literal.char, nextIndex: literal.nextIndex, unknown: false };
  }
  if ("dDsSwWpP".includes(escaped)) {
    return { char: "", nextIndex: index + 1, unknown: true };
  }
  return { char: escaped, nextIndex: index + 1, unknown: false };
}

function readEscapedLiteral(
  pattern: string,
  index: number
): { char: string; nextIndex: number } | null {
  const escapedChar = pattern.charAt(index);
  if (
    escapedChar === "x" &&
    HEX_BYTE_RE.test(pattern.slice(index + 1, index + 3))
  ) {
    return {
      char: String.fromCharCode(
        Number.parseInt(pattern.slice(index + 1, index + 3), 16)
      ),
      nextIndex: index + 2,
    };
  }
  if (
    escapedChar === "u" &&
    HEX_WORD_RE.test(pattern.slice(index + 1, index + 5))
  ) {
    return {
      char: String.fromCharCode(
        Number.parseInt(pattern.slice(index + 1, index + 5), 16)
      ),
      nextIndex: index + 4,
    };
  }
  return null;
}

function consumeEscapedClassHint(
  pattern: string,
  index: number,
  hints: PatternCharacterHints,
  previous: string | undefined
): { nextIndex: number; previous: string | undefined } {
  const literal = readEscapedLiteral(pattern, index);
  if (literal) {
    return {
      nextIndex: literal.nextIndex,
      previous: addLiteralHint(hints, literal.char) ? literal.char : previous,
    };
  }
  const char = pattern.charAt(index);
  if ("dDsSwWpP".includes(char)) {
    hints.hasUnknownMatcher = true;
    return { nextIndex: index, previous };
  }
  return {
    nextIndex: index,
    previous: addLiteralHint(hints, char) ? char : previous,
  };
}

function consumeClassRangeHint(
  pattern: string,
  index: number,
  previous: string | undefined,
  hints: PatternCharacterHints
): { handled: boolean; nextIndex: number } {
  if (
    pattern.charAt(index) !== "-" ||
    previous === undefined ||
    index + 1 >= pattern.length ||
    pattern.charAt(index + 1) === "]"
  ) {
    return { handled: false, nextIndex: index };
  }
  const end = readCharacterClassRangeEnd(pattern, index + 1);
  if (end?.unknown) {
    hints.hasUnknownMatcher = true;
    return { handled: true, nextIndex: end.nextIndex };
  }
  if (end && isComparableKeyChar(end.char)) {
    pushCharacterClassRange(hints.ranges, previous, end.char);
    return { handled: true, nextIndex: end.nextIndex };
  }
  return { handled: false, nextIndex: index };
}

function addCharacterClassHints(
  pattern: string,
  classStart: number,
  hints: PatternCharacterHints
): number {
  let previous: string | undefined;
  let escaped = false;
  for (let index = classStart + 1; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (escaped) {
      const result = consumeEscapedClassHint(pattern, index, hints, previous);
      previous = result.previous;
      index = result.nextIndex;
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
    if (char === "^" && index === classStart + 1) {
      hints.hasUnknownMatcher = true;
      previous = undefined;
      continue;
    }
    const range = consumeClassRangeHint(pattern, index, previous, hints);
    if (range.handled) {
      index = range.nextIndex;
      previous = undefined;
      continue;
    }
    if (addLiteralHint(hints, char)) {
      previous = char;
    } else {
      previous = undefined;
    }
  }
  hints.hasUnknownMatcher = true;
  return pattern.length;
}

function consumeEscapedPatternHint(
  pattern: string,
  index: number,
  hints: PatternCharacterHints,
  literalRun: string
): { literalRun: string; nextIndex: number } {
  const literal = readEscapedLiteral(pattern, index);
  if (literal) {
    return addLiteralHint(hints, literal.char)
      ? {
          literalRun: literalRun + literal.char,
          nextIndex: literal.nextIndex,
        }
      : {
          literalRun: pushLiteralRun(hints, literalRun),
          nextIndex: literal.nextIndex,
        };
  }
  const char = pattern.charAt(index);
  if ("dDsSwWpP".includes(char)) {
    hints.hasUnknownMatcher = true;
    return { literalRun: pushLiteralRun(hints, literalRun), nextIndex: index };
  }
  return addLiteralHint(hints, char)
    ? { literalRun: literalRun + char, nextIndex: index }
    : { literalRun: pushLiteralRun(hints, literalRun), nextIndex: index };
}

function collectPatternCharacterHints(pattern: string): PatternCharacterHints {
  const hints: PatternCharacterHints = {
    hasUnknownMatcher: false,
    literalRuns: [],
    literals: new Set<string>(),
    ranges: [],
  };
  let escaped = false;
  let literalRun = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (escaped) {
      const result = consumeEscapedPatternHint(
        pattern,
        index,
        hints,
        literalRun
      );
      literalRun = result.literalRun;
      index = result.nextIndex;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "[") {
      literalRun = pushLiteralRun(hints, literalRun);
      index = addCharacterClassHints(pattern, index, hints);
      continue;
    }
    if (char === ".") {
      literalRun = pushLiteralRun(hints, literalRun);
      hints.hasUnknownMatcher = true;
      continue;
    }
    if (addLiteralHint(hints, char)) {
      literalRun += char;
    } else {
      literalRun = pushLiteralRun(hints, literalRun);
    }
  }
  pushLiteralRun(hints, literalRun);
  return hints;
}

function charInRange(char: string, range: CharacterClassRange): boolean {
  return char >= range.start && char <= range.end;
}

function characterMayBeMatched(
  char: string,
  hints: PatternCharacterHints
): boolean {
  return (
    hints.literals.has(char) ||
    hints.ranges.some((range) => charInRange(char, range))
  );
}

export function unsafeDeniedPatternMayMatchKey(
  pattern: string,
  key: string
): boolean {
  const hints = collectPatternCharacterHints(pattern);
  if (hints.literals.size === 0 && hints.ranges.length === 0) {
    return true;
  }

  let comparable = 0;
  let matching = 0;
  let firstComparableMatches = false;
  let lastComparableMatches = false;
  for (const char of key) {
    if (!isComparableKeyChar(char)) {
      continue;
    }
    comparable += 1;
    const matches = characterMayBeMatched(char, hints);
    if (comparable === 1) {
      firstComparableMatches = matches;
    }
    lastComparableMatches = matches;
    if (matches) {
      matching += 1;
    }
  }

  if (comparable === 0) {
    return true;
  }
  if (hints.hasUnknownMatcher) {
    return true;
  }
  if (matching === 0) {
    return false;
  }
  if (hints.literalRuns.some((run) => run.length >= 2 && key.includes(run))) {
    return true;
  }
  const startsAtBoundary = pattern.trimStart().startsWith("^");
  const endsAtBoundary = pattern.trimEnd().endsWith("$");
  if (!(startsAtBoundary || endsAtBoundary)) {
    return true;
  }
  if (!startsAtBoundary) {
    return lastComparableMatches;
  }
  if (!endsAtBoundary) {
    return firstComparableMatches;
  }
  return (
    matching === comparable ||
    (key.length >= 16 && matching / comparable >= 0.75)
  );
}
