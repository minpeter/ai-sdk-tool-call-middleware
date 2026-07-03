import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { parse as parseRJSON } from "../../rjson";
import { getSchemaType, unwrapJsonSchema } from "../../schema-coerce";
import { generateToolCallId } from "./id";

interface ToolCallCandidate {
  input: string;
  toolName: string;
}

interface JsonCandidate {
  endIndex: number;
  startIndex: number;
  text: string;
}

interface JsonScanState {
  depth: number;
  escaping: boolean;
  inString: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PROTOTYPE_SENSITIVE_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Textual guard for prototype-sensitive keys in a JSON-like candidate.
 * Relaxed-JSON parsers may absorb a literal `__proto__` key into the object
 * prototype instead of surfacing it as an own property, so a post-parse
 * check alone cannot see it. Declining recovery on a textual match is safe:
 * the candidate simply stays plain text.
 */
const PROTOTYPE_SENSITIVE_KEY_TEXT_REGEX =
  /["'](?:__proto__|constructor|prototype)["']\s*:|[{,]\s*(?:__proto__|constructor|prototype)\s*:/;

function containsPrototypeSensitiveKey(value: unknown): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      stack.push(...current);
      continue;
    }
    if (!isRecord(current) || seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const key of Object.keys(current)) {
      if (PROTOTYPE_SENSITIVE_KEYS.has(key)) {
        return true;
      }
      stack.push(current[key]);
    }
  }

  return false;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function parseJsonCandidate(candidateText: string): unknown {
  try {
    return parseRJSON(candidateText);
  } catch {
    return;
  }
}

function extractCodeBlockCandidates(text: string): JsonCandidate[] {
  const codeBlockRegex = /```(?:json|yaml|xml)?\s*([\s\S]*?)```/gi;
  const candidates: JsonCandidate[] = [];
  let match: RegExpExecArray | null;
  while (true) {
    match = codeBlockRegex.exec(text);
    if (!match) {
      break;
    }
    const body = match[1]?.trim();
    if (body) {
      const startIndex = match.index ?? 0;
      const endIndex = startIndex + match[0].length;
      candidates.push({
        text: body,
        startIndex,
        endIndex,
      });
    }
  }
  return candidates;
}

function scanJsonChar(state: JsonScanState, char: string): JsonScanState {
  if (state.inString) {
    if (state.escaping) {
      return { ...state, escaping: false };
    }
    if (char === "\\") {
      return { ...state, escaping: true };
    }
    if (char === '"') {
      return { ...state, inString: false };
    }
    return state;
  }

  if (char === '"') {
    return { ...state, inString: true };
  }
  if (char === "{") {
    return { ...state, depth: state.depth + 1 };
  }
  if (char === "}") {
    return { ...state, depth: Math.max(0, state.depth - 1) };
  }
  return state;
}

function extractBalancedJsonObjects(text: string): JsonCandidate[] {
  const maxCandidateLength = 10_000;
  const candidates: JsonCandidate[] = [];
  let state: JsonScanState = { depth: 0, inString: false, escaping: false };
  let currentStart: number | null = null;
  let ignoreCurrent = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (!state.inString && char === "{" && state.depth === 0) {
      currentStart = index;
      ignoreCurrent = false;
    }

    state = scanJsonChar(state, char);

    if (
      currentStart !== null &&
      !ignoreCurrent &&
      index - currentStart + 1 > maxCandidateLength
    ) {
      ignoreCurrent = true;
    }

    if (!state.inString && char === "}" && state.depth === 0) {
      if (currentStart !== null && !ignoreCurrent) {
        const endIndex = index + 1;
        const candidate = text.slice(currentStart, endIndex);
        if (candidate.length > 1) {
          candidates.push({
            text: candidate,
            startIndex: currentStart,
            endIndex,
          });
        }
      }
      currentStart = null;
      ignoreCurrent = false;
    }
  }

  return candidates;
}

function extractTaggedToolCallCandidates(rawText: string): JsonCandidate[] {
  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  const candidates: JsonCandidate[] = [];
  let match: RegExpExecArray | null;
  while (true) {
    match = toolCallRegex.exec(rawText);
    if (!match) {
      break;
    }
    const body = match[1]?.trim();
    if (!body) {
      continue;
    }
    const startIndex = match.index ?? 0;
    const endIndex = startIndex + match[0].length;
    candidates.push({
      text: body,
      startIndex,
      endIndex,
    });
  }
  return candidates;
}

function extractJsonLikeCandidates(rawText: string): JsonCandidate[] {
  return mergeJsonCandidatesByStart(
    extractTaggedToolCallCandidates(rawText),
    extractCodeBlockCandidates(rawText),
    extractBalancedJsonObjects(rawText)
  );
}

function mergeJsonCandidatesByStart(
  tagged: JsonCandidate[],
  codeBlocks: JsonCandidate[],
  balanced: JsonCandidate[]
): JsonCandidate[] {
  return [...tagged, ...codeBlocks, ...balanced].sort((a, b) =>
    a.startIndex === b.startIndex
      ? b.endIndex - a.endIndex
      : a.startIndex - b.startIndex
  );
}

function toToolCallPart(candidate: ToolCallCandidate): LanguageModelV4Content {
  return {
    type: "tool-call",
    toolCallId: generateToolCallId(),
    toolName: candidate.toolName,
    input: candidate.input,
  };
}

const ORPHAN_TAG_BEFORE_CALL_REGEX = /(?:<\/?tool_call>\s*)+$/;
const ORPHAN_TAG_AFTER_CALL_REGEX = /^(?:\s*<\/?tool_call>)+/;

/**
 * Append a text segment between recovered calls, trimming orphan tool-call
 * wrappers on both ends. Models that half-follow a tag protocol leave
 * dangling `<tool_call>` markup around the recovered JSON (e.g.
 * `<tool_call>{...}</think>` or `<tool_call>` used as a separator between
 * consecutive payloads); stripping it keeps protocol markup out of visible
 * text.
 */
function pushRecoveredTextSegment(
  out: LanguageModelV4Content[],
  segment: string
): void {
  const trimmed = segment
    .replace(ORPHAN_TAG_AFTER_CALL_REGEX, "")
    .replace(ORPHAN_TAG_BEFORE_CALL_REGEX, "");
  if (trimmed.trim().length > 0) {
    out.push({ type: "text", text: trimmed });
  }
}

function parseAsToolPayload(
  payload: unknown,
  tools: LanguageModelV4FunctionTool[]
): ToolCallCandidate | null {
  if (!isRecord(payload)) {
    return null;
  }

  const toolName =
    typeof payload.name === "string" && payload.name.trim().length > 0
      ? payload.name.trim()
      : null;
  if (!toolName) {
    return null;
  }

  if (!tools.some((tool) => tool.name === toolName)) {
    return null;
  }

  const rawArgs = Object.hasOwn(payload, "arguments") ? payload.arguments : {};
  if (!isRecord(rawArgs) || containsPrototypeSensitiveKey(rawArgs)) {
    return null;
  }

  return {
    toolName,
    input: safeStringify(rawArgs),
  };
}

function isLikelyArgumentsShapeForTool(
  args: Record<string, unknown>,
  tool: LanguageModelV4FunctionTool
): boolean {
  const unwrapped = unwrapJsonSchema(tool.inputSchema);
  if (!isRecord(unwrapped)) {
    return false;
  }
  if (getSchemaType(unwrapped) !== "object") {
    return false;
  }

  const properties = unwrapped.properties;
  if (!isRecord(properties)) {
    return false;
  }

  const keys = Object.keys(args);
  if (keys.length === 0) {
    return false;
  }

  const knownKeys = keys.filter((key) => Object.hasOwn(properties, key));
  if (knownKeys.length === 0) {
    return false;
  }

  if (
    unwrapped.additionalProperties === false &&
    knownKeys.length !== keys.length
  ) {
    return false;
  }

  return true;
}

function parseAsArgumentsOnly(
  payload: unknown,
  tools: LanguageModelV4FunctionTool[]
): ToolCallCandidate | null {
  if (tools.length !== 1) {
    return null;
  }
  if (!isRecord(payload)) {
    return null;
  }
  const hasNameEnvelope =
    Object.hasOwn(payload, "name") &&
    typeof payload.name === "string" &&
    payload.name.length > 0;
  const hasArgumentsEnvelope =
    Object.hasOwn(payload, "arguments") &&
    (typeof payload.arguments === "string" || isRecord(payload.arguments));
  if (hasNameEnvelope || hasArgumentsEnvelope) {
    return null;
  }

  const tool = tools[0];
  if (
    !isLikelyArgumentsShapeForTool(payload, tool) ||
    containsPrototypeSensitiveKey(payload)
  ) {
    return null;
  }

  return {
    toolName: tool.name,
    input: safeStringify(payload),
  };
}

function resolveCandidatePayload(
  candidate: JsonCandidate,
  tools: LanguageModelV4FunctionTool[]
): ToolCallCandidate | null {
  if (PROTOTYPE_SENSITIVE_KEY_TEXT_REGEX.test(candidate.text)) {
    return null;
  }
  const parsed = parseJsonCandidate(candidate.text);
  if (parsed === undefined) {
    return null;
  }
  return (
    parseAsToolPayload(parsed, tools) ?? parseAsArgumentsOnly(parsed, tools)
  );
}

/**
 * Recover tool calls from JSON-like candidates embedded in plain text.
 * Every non-overlapping candidate that resolves to a known tool becomes a
 * tool-call part, so multi-call payloads (e.g. consecutive bare JSON objects
 * separated by newlines or orphan `<tool_call>` tags) are all recovered.
 * Returns null when no candidate resolves.
 */
export function recoverToolCallFromJsonCandidates(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): LanguageModelV4Content[] | null {
  if (tools.length === 0) {
    return null;
  }

  const jsonCandidates = extractJsonLikeCandidates(text);
  const out: LanguageModelV4Content[] = [];
  let cursor = 0;
  let recoveredAny = false;

  for (const jsonCandidate of jsonCandidates) {
    if (jsonCandidate.startIndex < cursor) {
      // Overlaps a candidate that was already consumed (e.g. the balanced
      // object inside an already-recovered tagged/fenced candidate).
      continue;
    }
    const payload = resolveCandidatePayload(jsonCandidate, tools);
    if (!payload) {
      continue;
    }
    pushRecoveredTextSegment(out, text.slice(cursor, jsonCandidate.startIndex));
    out.push(toToolCallPart(payload));
    cursor = jsonCandidate.endIndex;
    recoveredAny = true;
  }

  if (!recoveredAny) {
    return null;
  }

  pushRecoveredTextSegment(out, text.slice(cursor));
  return out;
}
