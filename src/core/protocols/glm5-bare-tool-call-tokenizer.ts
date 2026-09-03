const MAX_BARE_TOOL_CALL_NESTING_DEPTH = 256;
const MAX_BARE_TOOL_CALL_ARGUMENTS = 1024;

type JsonishQuote = '"' | "'";
type StructuralCharacterResult = "consumed" | "rejected" | "unhandled";

interface BareArgumentScannerState {
  readonly arguments: ScannedBareArgument[];
  readonly body: string;
  equals: number;
  escaping: boolean;
  quote: JsonishQuote | null;
  segmentStart: number;
  readonly stack: ("[" | "{")[];
}

export interface ScannedBareArgument {
  readonly key: string;
  readonly rawValue: string;
}

function appendScannedArgument(options: {
  arguments_: ScannedBareArgument[];
  body: string;
  end: number;
  equals: number;
  start: number;
}): boolean {
  if (
    options.equals < options.start ||
    options.arguments_.length >= MAX_BARE_TOOL_CALL_ARGUMENTS
  ) {
    return false;
  }

  const key = options.body.slice(options.start, options.equals).trim();
  const rawValue = options.body.slice(options.equals + 1, options.end).trim();
  if (!(key && rawValue)) {
    return false;
  }
  options.arguments_.push({ key, rawValue });
  return true;
}

function consumeQuotedCharacter(
  state: BareArgumentScannerState,
  character: string
): boolean {
  if (state.quote === null) {
    return false;
  }
  if (state.escaping) {
    state.escaping = false;
  } else if (character === "\\") {
    state.escaping = true;
  } else if (character === state.quote) {
    state.quote = null;
  }
  return true;
}

function consumeStructuralCharacter(
  state: BareArgumentScannerState,
  character: string
): StructuralCharacterResult {
  if (character === '"' || character === "'") {
    state.quote = character;
    return "consumed";
  }
  if (character === "{" || character === "[") {
    state.stack.push(character);
    return state.stack.length > MAX_BARE_TOOL_CALL_NESTING_DEPTH
      ? "rejected"
      : "consumed";
  }
  if (character === "}" || character === "]") {
    const expected = character === "}" ? "{" : "[";
    return state.stack.pop() === expected ? "consumed" : "rejected";
  }
  return character === "(" || character === ")" ? "rejected" : "unhandled";
}

function consumeTopLevelDelimiter(
  state: BareArgumentScannerState,
  character: string,
  index: number
): boolean {
  if (character === "=") {
    if (state.equals !== -1) {
      return false;
    }
    state.equals = index;
    return true;
  }
  if (character !== ",") {
    return true;
  }
  if (
    !appendScannedArgument({
      arguments_: state.arguments,
      body: state.body,
      end: index,
      equals: state.equals,
      start: state.segmentStart,
    })
  ) {
    return false;
  }
  state.segmentStart = index + 1;
  state.equals = -1;
  return true;
}

/**
 * Split only top-level `key=value` pairs. Quotes and JSON-ish containers own
 * their commas and equals signs; malformed or incomplete structure is never
 * completed by this fallback.
 */
export function scanBareNamedArguments(
  body: string
): ScannedBareArgument[] | null {
  if (body.trim().length === 0) {
    return [];
  }

  const arguments_: ScannedBareArgument[] = [];
  const state: BareArgumentScannerState = {
    arguments: arguments_,
    body,
    equals: -1,
    escaping: false,
    quote: null,
    segmentStart: 0,
    stack: [],
  };

  for (let index = 0; index < body.length; index += 1) {
    const character = body.charAt(index);
    if (consumeQuotedCharacter(state, character)) {
      continue;
    }
    const structural = consumeStructuralCharacter(state, character);
    if (structural === "rejected") {
      return null;
    }
    if (
      structural === "unhandled" &&
      state.stack.length === 0 &&
      !consumeTopLevelDelimiter(state, character, index)
    ) {
      return null;
    }
  }

  if (state.quote !== null || state.escaping || state.stack.length > 0) {
    return null;
  }
  return appendScannedArgument({
    arguments_,
    body,
    end: body.length,
    equals: state.equals,
    start: state.segmentStart,
  })
    ? arguments_
    : null;
}
