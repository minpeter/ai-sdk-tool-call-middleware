interface CharacterClassRange {
  end: string;
  start: string;
}

interface PatternCharacterHints {
  hasUnknownMatcher: boolean;
  literals: Set<string>;
  ranges: CharacterClassRange[];
}

function isComparableKeyChar(char: string): boolean {
  return /^[A-Za-z0-9_-]$/.test(char);
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

function readEscapedLiteral(
  pattern: string,
  index: number
): { char: string; nextIndex: number } | null {
  const escape = pattern.charAt(index);
  if (escape === "x" && /^[\da-fA-F]{2}$/.test(pattern.slice(index + 1, index + 3))) {
    return {
      char: String.fromCharCode(
        Number.parseInt(pattern.slice(index + 1, index + 3), 16)
      ),
      nextIndex: index + 2,
    };
  }
  if (escape === "u" && /^[\da-fA-F]{4}$/.test(pattern.slice(index + 1, index + 5))) {
    return {
      char: String.fromCharCode(
        Number.parseInt(pattern.slice(index + 1, index + 5), 16)
      ),
      nextIndex: index + 4,
    };
  }
  return null;
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
      const literal = readEscapedLiteral(pattern, index);
      if (literal) {
        if (isComparableKeyChar(literal.char)) {
          hints.literals.add(literal.char);
          previous = literal.char;
        }
        index = literal.nextIndex;
      } else if ("dDsSwWpP".includes(char)) {
        hints.hasUnknownMatcher = true;
      } else if (isComparableKeyChar(char)) {
        hints.literals.add(char);
        previous = char;
      }
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
    if (
      char === "-" &&
      previous !== undefined &&
      index + 1 < pattern.length &&
      pattern.charAt(index + 1) !== "]"
    ) {
      const end = pattern.charAt(index + 1);
      if (isComparableKeyChar(end)) {
        pushCharacterClassRange(hints.ranges, previous, end);
        index += 1;
        previous = undefined;
        continue;
      }
    }
    if (isComparableKeyChar(char)) {
      hints.literals.add(char);
      previous = char;
    } else {
      previous = undefined;
    }
  }
  hints.hasUnknownMatcher = true;
  return pattern.length;
}

function collectPatternCharacterHints(pattern: string): PatternCharacterHints {
  const hints: PatternCharacterHints = {
    hasUnknownMatcher: false,
    literals: new Set<string>(),
    ranges: [],
  };
  let escaped = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (escaped) {
      const literal = readEscapedLiteral(pattern, index);
      if (literal) {
        if (isComparableKeyChar(literal.char)) {
          hints.literals.add(literal.char);
        }
        index = literal.nextIndex;
      } else if ("dDsSwWpP".includes(char)) {
        hints.hasUnknownMatcher = true;
      } else if (isComparableKeyChar(char)) {
        hints.literals.add(char);
      }
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "[") {
      index = addCharacterClassHints(pattern, index, hints);
      continue;
    }
    if (char === ".") {
      hints.hasUnknownMatcher = true;
      continue;
    }
    if (isComparableKeyChar(char)) {
      hints.literals.add(char);
    }
  }
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
  for (const char of key) {
    if (!isComparableKeyChar(char)) {
      continue;
    }
    comparable += 1;
    if (characterMayBeMatched(char, hints)) {
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
  return (
    matching === comparable ||
    (key.length >= 16 && matching / comparable >= 0.75)
  );
}
