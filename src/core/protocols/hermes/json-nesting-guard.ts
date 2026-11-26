export interface JsonDepthScanState {
  depth: number;
  escaping: boolean;
  inString: boolean;
}

/**
 * Maximum structural nesting (`{`/`[`) accepted for tool-call JSON.
 * Keeps recursive parsers/stringifiers from stack-overflowing on pathological
 * input; matches MAX_ARGUMENT_SHAPE_DEPTH / bare-call nesting limits.
 */
export const MAX_TOOL_CALL_JSON_NESTING_DEPTH = 256;

interface NestingScanState {
  depth: number;
  escaping: boolean;
  quote: '"' | "'" | null;
}

function consumeNestingStringChar(
  state: NestingScanState,
  char: string
): boolean {
  if (state.quote === null) {
    return false;
  }
  if (state.escaping) {
    state.escaping = false;
  } else if (char === "\\") {
    state.escaping = true;
  } else if (char === state.quote) {
    state.quote = null;
  }
  return true;
}

function skipNestingComment(text: string, index: number): number | null {
  if (text.charAt(index) !== "/") {
    return null;
  }
  const next = text.charAt(index + 1);
  if (next === "/") {
    const lineEnd = text.indexOf("\n", index + 2);
    return lineEnd === -1 ? -1 : lineEnd;
  }
  if (next === "*") {
    const blockEnd = text.indexOf("*/", index + 2);
    return blockEnd === -1 ? -1 : blockEnd + 1;
  }
  return null;
}

function applyNestingDepthChar(
  state: NestingScanState,
  char: string,
  maxDepth: number
): boolean {
  if (char === "{" || char === "[") {
    state.depth += 1;
    return state.depth > maxDepth;
  }
  if ((char === "}" || char === "]") && state.depth > 0) {
    state.depth -= 1;
  }
  return false;
}

/**
 * O(n) scan: true when `{`/`[` nesting (outside strings/comments) exceeds
 * `maxDepth`. Used as a fail-closed preflight before recursive RJSON/JSON
 * parse or stringify.
 */
export function exceedsToolCallJsonNestingDepth(
  text: string,
  maxDepth: number = MAX_TOOL_CALL_JSON_NESTING_DEPTH
): boolean {
  const state: NestingScanState = { depth: 0, escaping: false, quote: null };

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);

    if (consumeNestingStringChar(state, char)) {
      continue;
    }

    if (char === '"' || char === "'") {
      state.quote = char;
      continue;
    }

    const commentIndex = skipNestingComment(text, index);
    if (commentIndex !== null) {
      if (commentIndex === -1) {
        return false;
      }
      index = commentIndex;
      continue;
    }

    if (applyNestingDepthChar(state, char, maxDepth)) {
      return true;
    }
  }

  return false;
}

export function consumeJsonStringScanChar(
  state: JsonDepthScanState,
  char: string
): boolean {
  if (state.escaping) {
    state.escaping = false;
    return true;
  }
  if (state.inString) {
    if (char === "\\") {
      state.escaping = true;
    } else if (char === '"') {
      state.inString = false;
    }
    return true;
  }
  if (char === '"') {
    state.inString = true;
    return true;
  }
  return false;
}

export function consumeJsonDepthOpen(
  state: JsonDepthScanState,
  char: string
): boolean {
  if (!(char === "{" || char === "[")) {
    return false;
  }
  state.depth += 1;
  return true;
}

export function consumeJsonDepthClose(
  state: JsonDepthScanState,
  char: string
): "top-level-close" | "nested-close" | "none" {
  if (!(char === "}" || char === "]")) {
    return "none";
  }
  if (state.depth > 0) {
    state.depth -= 1;
    return "nested-close";
  }
  return "top-level-close";
}

export function consumeExistingJsonString(
  state: JsonDepthScanState,
  char: string
): boolean {
  if (!state.inString) {
    return false;
  }
  if (state.escaping) {
    state.escaping = false;
  } else if (char === "\\") {
    state.escaping = true;
  } else if (char === '"') {
    state.inString = false;
  }
  return true;
}

export function consumeJsonObjectDepth(
  state: JsonDepthScanState,
  char: string
): boolean {
  if (char === "{") {
    state.depth += 1;
    return true;
  }
  if (char === "}") {
    state.depth = Math.max(0, state.depth - 1);
    return true;
  }
  return false;
}
