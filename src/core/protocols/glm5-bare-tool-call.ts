import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { parse as parseRJSON } from "../../rjson";
import { parseLooseStructuredString } from "../../schema-coerce/loose-structured-string";
import {
  hasPrototypeSensitiveStructuralKey,
  isPrototypeSensitiveArgumentKey,
} from "../utils/prototype-sensitive-keys";
import { coerceToolCallInput } from "../utils/tool-call-coercion";
import { getToolInputPropertyNames } from "../utils/tool-call-object-schema";

const MAX_BARE_TOOL_CALL_LENGTH = 102_400;
const MAX_BARE_TOOL_CALL_NESTING_DEPTH = 256;
const MAX_BARE_TOOL_CALL_ARGUMENTS = 1024;
const JSON_NUMBER_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

type JsonishQuote = '"' | "'";

interface ScannedArgument {
  key: string;
  rawValue: string;
}

interface ParsedValue {
  ok: true;
  value: unknown;
}

const INVALID_VALUE = { ok: false } as const;

function appendScannedArgument(options: {
  arguments_: ScannedArgument[];
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
function scanNamedArguments(body: string): ScannedArgument[] | null {
  if (body.trim().length === 0) {
    return [];
  }

  const arguments_: ScannedArgument[] = [];
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

function parseQuotedValue(
  rawValue: string
): ParsedValue | typeof INVALID_VALUE {
  const quote = rawValue.charAt(0);
  if (!((quote === '"' || quote === "'") && rawValue.at(-1) === quote)) {
    return INVALID_VALUE;
  }
  try {
    const value = parseRJSON(rawValue, {
      duplicate: false,
      relaxed: true,
      tolerant: false,
    });
    return typeof value === "string" ? { ok: true, value } : INVALID_VALUE;
  } catch {
    return INVALID_VALUE;
  }
}

function parseStructuredValue(
  rawValue: string
): ParsedValue | typeof INVALID_VALUE {
  const open = rawValue.charAt(0);
  const expectedClose = open === "{" ? "}" : "]";
  if (rawValue.at(-1) !== expectedClose) {
    return INVALID_VALUE;
  }
  const value = parseLooseStructuredString(rawValue);
  if (
    value === undefined ||
    (open === "{" &&
      (!value || typeof value !== "object" || Array.isArray(value))) ||
    (open === "[" && !Array.isArray(value)) ||
    hasPrototypeSensitiveStructuralKey(value)
  ) {
    return INVALID_VALUE;
  }
  return { ok: true, value };
}

function parseBareValue(rawValue: string): ParsedValue | typeof INVALID_VALUE {
  const first = rawValue.charAt(0);
  if (first === '"' || first === "'") {
    return parseQuotedValue(rawValue);
  }
  if (first === "{" || first === "[") {
    return parseStructuredValue(rawValue);
  }
  if (JSON_NUMBER_RE.test(rawValue)) {
    const value = Number(rawValue);
    return Number.isFinite(value) ? { ok: true, value } : INVALID_VALUE;
  }
  switch (rawValue) {
    case "true":
    case "True":
      return { ok: true, value: true };
    case "false":
    case "False":
      return { ok: true, value: false };
    case "null":
    case "None":
      return { ok: true, value: null };
    default:
      return INVALID_VALUE;
  }
}

function resolveAnchoredCall(options: {
  text: string;
  tools: LanguageModelV4FunctionTool[];
}): { body: string; tool: LanguageModelV4FunctionTool } | null {
  const trimmed = options.text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_BARE_TOOL_CALL_LENGTH) {
    return null;
  }

  const withoutSemicolon = trimmed.endsWith(";")
    ? trimmed.slice(0, -1).trimEnd()
    : trimmed;
  if (!withoutSemicolon.endsWith(")")) {
    return null;
  }
  const open = withoutSemicolon.indexOf("(");
  if (open <= 0) {
    return null;
  }

  const toolName = withoutSemicolon.slice(0, open).trimEnd();
  const matchingTools = options.tools.filter((tool) => tool.name === toolName);
  if (matchingTools.length !== 1 || !matchingTools[0]) {
    return null;
  }
  return {
    body: withoutSemicolon.slice(open + 1, -1),
    tool: matchingTools[0],
  };
}

/**
 * Parse a conservative GLM-5.2 bare text call such as
 * `lookup(city="Seoul", days=2)`.
 *
 * The complete trimmed response must be one exact declared tool invocation.
 * This intentionally does not recover aliases, positional values, prose, or
 * truncated syntax.
 */
export function parseGlm5AnchoredBareToolCall(options: {
  text: string;
  tools: LanguageModelV4FunctionTool[];
}): { toolName: string; input: string } | null {
  const anchored = resolveAnchoredCall(options);
  if (!anchored) {
    return null;
  }
  const scanned = scanNamedArguments(anchored.body);
  if (!scanned) {
    return null;
  }

  const args = Object.create(null) as Record<string, unknown>;
  for (const argument of scanned) {
    if (
      isPrototypeSensitiveArgumentKey(argument.key) ||
      Object.hasOwn(args, argument.key)
    ) {
      return null;
    }
    const parsed = parseBareValue(argument.rawValue);
    if (!parsed.ok || hasPrototypeSensitiveStructuralKey(parsed.value)) {
      return null;
    }
    args[argument.key] = parsed.value;
  }

  const declaredArgumentNames = getToolInputPropertyNames(
    anchored.tool.inputSchema,
    Object.create(null)
  );
  if (scanned.some((argument) => !declaredArgumentNames?.has(argument.key))) {
    return null;
  }

  try {
    const input = coerceToolCallInput(anchored.tool.name, args, options.tools);
    return input === undefined ? null : { toolName: anchored.tool.name, input };
  } catch {
    return null;
  }
}
