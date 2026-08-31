const MAX_BARE_TOOL_CALL_NESTING_DEPTH = 256;
const MAX_BARE_TOOL_CALL_ARGUMENTS = 1024;

type JsonishQuote = '"' | "'";

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

/**
 * Split only top-level `key=value` pairs. Quotes and JSON-ish containers own
 * their commas and equals signs; malformed or incomplete structure is never
 * completed by this fallback.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keeping scanner state transitions together makes its fail-closed grammar auditable.
export function scanBareNamedArguments(
  body: string
): ScannedBareArgument[] | null {
  if (body.trim().length === 0) {
    return [];
  }

  const arguments_: ScannedBareArgument[] = [];
  const stack: ("[" | "{")[] = [];
  let quote: JsonishQuote | null = null;
  let escaping = false;
  let segmentStart = 0;
  let equals = -1;

  for (let index = 0; index < body.length; index += 1) {
    const char = body.charAt(index);
    if (quote !== null) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      if (stack.length > MAX_BARE_TOOL_CALL_NESTING_DEPTH) {
        return null;
      }
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.pop() !== expected) {
        return null;
      }
      continue;
    }
    if (char === "(" || char === ")") {
      return null;
    }
    if (stack.length > 0) {
      continue;
    }
    if (char === "=") {
      if (equals !== -1) {
        return null;
      }
      equals = index;
      continue;
    }
    if (char === ",") {
      if (
        !appendScannedArgument({
          arguments_,
          body,
          end: index,
          equals,
          start: segmentStart,
        })
      ) {
        return null;
      }
      segmentStart = index + 1;
      equals = -1;
    }
  }

  if (quote !== null || escaping || stack.length > 0) {
    return null;
  }
  return appendScannedArgument({
    arguments_,
    body,
    end: body.length,
    equals,
    start: segmentStart,
  })
    ? arguments_
    : null;
}
